import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import {
  type ConnectionInfo,
  type McpClient,
  type McpHost,
  type McpResource,
  type McpTool,
  type McpToolResult,
  type RunningMcpServer,
  startMcpServer,
} from '@uve/mcp'
import { app, BrowserWindow, ipcMain } from 'electron'
import shimSource from '../../../../packages/mcp/bin/uve-mcp.mjs?raw'
import { type AgentCall, type AgentStatus, DEFAULT_MCP_PORT } from '../shared/agent'
import { downloadFont, inspectFontFile } from './fontFiles'
import { mediaTypeOf } from '../shared/media'
import { grant } from './media'
import { downloadModel } from './modelFiles'
import { isHelperContents } from './windows'

// The MCP server that lets agent apps drive the editor. It runs here, in the
// main process, on 127.0.0.1 with a bearer token. The project lives in the
// renderer, so tool calls are relayed to it over IPC: the renderer lists its
// tools when it starts (`agent:ready`) and answers each `agent:call`. Status,
// issue reports and file grants are handled here.

const CONNECTION_FILE = process.env.UVE_MCP_CONNECTION ?? join(homedir(), '.uve', 'mcp.json')
/** How long a call waits for the editor window to list its tools. */
const READY_WAIT_MS = 20_000
/** A call the editor has not answered in this long fails. */
const CALL_TIMEOUT_MS = 10 * 60_000

// The skill docs, bundled from /skill at build time, served as uve://skill/… resources.
const SKILL_FILES = import.meta.glob('../../../../skill/**/*.md', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>

const INSTRUCTIONS =
  'Ultimate Video Editor is a motion design and video editor. Read uve://skill/SKILL.md first: it is how to work in the app. Every change you make shows live to the user, and your edits in one go are one undo step.'

const STATUS_TOOL: McpTool = {
  name: 'uve_status',
  description:
    'Whether the editor is running and its window is ready, which agent sessions are connected, and how many tools there are. Call it when tool calls fail to reach the editor.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}

const REPORT_TOOL: McpTool = {
  name: 'report_issue',
  description:
    'File a report so the editor, its API and its skill docs improve. Use it when you could not do what was asked, a command did something other than its description, the docs were wrong or missing something, you made a mistake worth learning from, or the app misbehaved. Be specific and honest about fault, including your own. One report per problem. Reports are saved on this computer only.',
  inputSchema: {
    type: 'object',
    properties: {
      category: { type: 'string', enum: ['api-gap', 'api-bug', 'docs-mismatch', 'agent-mistake', 'app-bug', 'feature-request'] },
      fault: { type: 'string', enum: ['ours-api', 'ours-docs', 'ours-app', 'model', 'user', 'provider', 'unknown'] },
      severity: { type: 'integer', minimum: 1, maximum: 5, description: '1 cosmetic · 3 had to work around it · 5 the task could not be done.' },
      title: { type: 'string', description: 'Under 80 characters, specific.' },
      tried: { type: 'string', description: 'What you were trying to do.' },
      happened: { type: 'string', description: 'What actually happened: the mistake or the gap.' },
      expected: { type: 'string', description: 'What should have happened.' },
      suggestion: { type: 'string', description: 'The fix in API or docs terms.' },
      command: { type: 'string', description: 'The command involved, if any.' },
      error: { type: 'string', description: 'The exact error text, if any.' },
    },
    required: ['category', 'fault', 'severity', 'title', 'tried', 'happened', 'expected'],
    additionalProperties: false,
  },
}

const text = (body: string, isError = false): McpToolResult => ({ content: [{ type: 'text', text: body }], isError })

let server: RunningMcpServer | null = null
let serverError: string | null = null
let token = ''
let clients: McpClient[] = []
let shimPath = ''

/** The renderer's tools, once its window has listed them. */
let rendererTools: McpTool[] | null = null
let toolWaiters: (() => void)[] = []
const pending = new Map<string, (result: McpToolResult) => void>()
let callSeq = 0

function editorWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find((w) => !isHelperContents(w.webContents))
}

function waitForTools(): Promise<McpTool[] | null> {
  if (rendererTools) return Promise.resolve(rendererTools)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(rendererTools), READY_WAIT_MS)
    toolWaiters.push(() => {
      clearTimeout(timer)
      resolve(rendererTools)
    })
  })
}

/** The window reloaded or closed: its tools and the calls it was answering are gone. */
function forgetRenderer(reason: string): void {
  rendererTools = null
  for (const done of pending.values()) done(text(`${reason} Check the project before retrying.`, true))
  pending.clear()
}

async function callRenderer(name: string, args: Record<string, unknown>, client: McpClient): Promise<McpToolResult> {
  const tools = await waitForTools()
  const win = editorWindow()
  if (!tools || !win) return text('The editor window is not ready. Ask the user to open Ultimate Video Editor, then try again.', true)
  if (!tools.some((t) => t.name === name)) {
    return text(`Unknown tool "${name}". tools/list shows every tool; api_describe {} lists the commands.`, true)
  }
  const call: AgentCall = { id: `c${++callSeq}`, name, args, client: { session: client.session, name: client.name } }
  if (name === 'media_import') {
    const path = args.localPath
    if (typeof path !== 'string' || !isAbsolute(path)) {
      return text('media_import needs localPath: the absolute path of a video, image or audio file on this computer.', true)
    }
    const [file] = await grant([path])
    if (!file) return text(`No video, image or audio file at ${path}.`, true)
    call.file = file
  }
  if (name === 'world_import_model') {
    try {
      if (typeof args.attachmentId === 'string') return text('Attachments are not supported here; pass localPath or an https url.', true)
      if (typeof args.localPath === 'string') {
        if (!isAbsolute(args.localPath)) return text('localPath must be an absolute path.', true)
        if (mediaTypeOf(args.localPath)?.kind !== 'model') return text(`${basename(args.localPath)} is not a model file (glb, gltf, obj, stl or ply).`, true)
        const [file] = await grant([args.localPath])
        if (!file) return text(`No model file at ${args.localPath}.`, true)
        call.file = file
      } else if (typeof args.url === 'string') call.file = await downloadModel(args.url)
      else return text('world_import_model needs localPath (a model file on this computer, absolute) or url (an https address).', true)
    } catch (error) {
      return text(error instanceof Error ? error.message : String(error), true)
    }
  }
  if (name === 'font_install') {
    try {
      if (typeof args.localPath === 'string') call.font = await inspectFontFile(args.localPath)
      else if (typeof args.url === 'string') call.font = await downloadFont(args.url)
      else return text('font_install needs localPath (a font file on this computer, absolute) or url (an https address).', true)
    } catch (error) {
      return text(error instanceof Error ? error.message : String(error), true)
    }
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => done(text('The editor did not answer in 10 minutes.', true)), CALL_TIMEOUT_MS)
    const done = (result: McpToolResult) => {
      clearTimeout(timer)
      if (pending.delete(call.id)) resolve(result)
    }
    pending.set(call.id, done)
    win.webContents.send('agent:call', call)
  })
}

async function report(args: Record<string, unknown>, client: McpClient): Promise<McpToolResult> {
  const missing = (REPORT_TOOL.inputSchema.required as string[]).filter((key) => args[key] === undefined || args[key] === '')
  if (missing.length > 0) return text(`report_issue needs ${missing.join(', ')}.`, true)
  const file = join(app.getPath('userData'), 'agent-reports.jsonl')
  const entry = { at: new Date().toISOString(), client: client.name, app: app.getVersion(), ...args }
  await fs.appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8')
  return text(`Reported, and saved on this computer in ${file}. Tell the user in one line, then carry on.`)
}

/** Agent sessions that called in this long are counted as connected. */
const ACTIVE_MS = 10 * 60_000

function statusText(): string {
  const others = clients.filter((c) => Date.now() - c.lastSeenAt < ACTIVE_MS).length
  const window = rendererTools ? `the editor window is ready with ${rendererTools.length + 2} tools` : 'the editor window is still starting'
  return `Ultimate Video Editor ${app.getVersion()} is running; ${window}. ${others} agent session${others === 1 ? '' : 's'} active in the last 10 minutes.`
}

const host: McpHost = {
  serverInfo: { name: 'uve', version: app.getVersion() },
  instructions: INSTRUCTIONS,
  async tools() {
    return [STATUS_TOOL, ...((await waitForTools()) ?? []), REPORT_TOOL]
  },
  async callTool(name, args, client) {
    if (name === STATUS_TOOL.name) return text(statusText())
    if (name === REPORT_TOOL.name) return report(args, client)
    return callRenderer(name, args, client)
  },
  resources: () => skillResources(),
  onClientsChanged(next) {
    clients = next
    editorWindow()?.webContents.send('agent:status', status())
  },
}

function skillResources(): McpResource[] {
  return Object.entries(SKILL_FILES)
    .map(([path, body]) => {
      const name = `skill/${path.split('/skill/')[1] ?? basename(path)}`
      return {
        uri: `uve://${name}`,
        name,
        description: name === 'skill/SKILL.md' ? 'How to work in Ultimate Video Editor: read first' : undefined,
        mimeType: 'text/markdown',
        text: body,
      }
    })
    .sort((a, b) => (a.name === 'skill/SKILL.md' ? -1 : b.name === 'skill/SKILL.md' ? 1 : a.name.localeCompare(b.name)))
}

/** The skill docs by path inside the skill folder (`SKILL.md`, `references/api.md`…), for OpenCode's copy of the skill. */
export function skillFiles(): Record<string, string> {
  return Object.fromEntries(Object.entries(SKILL_FILES).map(([path, body]) => [path.split('/skill/')[1] ?? basename(path), body]))
}

/** The running server's address and token, for the agent hosted in the app; null while it is off. */
export function mcpEndpoint(): { url: string; token: string } | null {
  return server ? { url: server.url, token } : null
}

function status(): AgentStatus {
  return {
    running: server !== null,
    error: serverError,
    url: server?.url ?? '',
    token,
    shimPath,
    connectionFile: CONNECTION_FILE,
    clients: [...clients].sort((a, b) => b.lastSeenAt - a.lastSeenAt),
  }
}

/** Keeps the token across launches, so agent apps set up once keep working. */
async function loadToken(): Promise<string> {
  try {
    const saved = JSON.parse(await fs.readFile(CONNECTION_FILE, 'utf8')) as Partial<ConnectionInfo>
    if (typeof saved.token === 'string' && saved.token.length >= 32) return saved.token
  } catch {
    // No file yet, or a torn one: make a new token.
  }
  return randomBytes(24).toString('base64url')
}

async function listen(): Promise<RunningMcpServer> {
  const wanted = Number(process.env.UVE_MCP_PORT ?? DEFAULT_MCP_PORT)
  try {
    return await startMcpServer({ host, token, port: wanted })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    // Another copy of the editor, or another program, holds the port.
    return startMcpServer({ host, token, port: 0 })
  }
}

/** Starts the agent server and the IPC it relays through. Never throws: a failure shows in the Agents panel. */
export async function startAgentServer(): Promise<void> {
  ipcMain.handle('agent:ready', (_event, tools: McpTool[]) => {
    rendererTools = tools
    for (const wake of toolWaiters) wake()
    toolWaiters = []
  })
  ipcMain.on('agent:result', (_event, id: string, result: McpToolResult) => pending.get(id)?.(result))
  ipcMain.handle('agent:status', () => status())
  app.on('web-contents-created', (_event, contents) => {
    contents.on('did-start-loading', () => {
      if (!isHelperContents(contents)) forgetRenderer('The editor window reloaded during this call.')
    })
    contents.on('render-process-gone', () => {
      if (!isHelperContents(contents)) forgetRenderer('The editor window stopped during this call.')
    })
  })

  try {
    token = await loadToken()
    server = await listen()
    shimPath = join(app.getPath('userData'), 'uve-mcp.mjs')
    await fs.writeFile(shimPath, shimSource, 'utf8')
    const info: ConnectionInfo = { url: server.url, token, pid: process.pid }
    await fs.mkdir(dirname(CONNECTION_FILE), { recursive: true })
    await fs.writeFile(CONNECTION_FILE, `${JSON.stringify(info, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    serverError = error instanceof Error ? error.message : String(error)
    console.error(`The agent server did not start: ${serverError}`)
  }
}

export async function stopAgentServer(): Promise<void> {
  await server?.close()
  server = null
}
