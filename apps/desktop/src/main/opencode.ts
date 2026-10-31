import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { app, BrowserWindow, ipcMain, safeStorage } from 'electron'
import {
  type AcpPermissionOption,
  type AcpSessionUpdate,
  type AcpToolCall,
  DEFAULT_OPENCODE_MODEL,
  initialOpenCodeStatus,
  SARVAM_CHAT_BASE_URL,
  SARVAM_OPENCODE_MODEL,
  OPENCODE_VERSION,
  type OpenCodeChoice,
  type OpenCodeEvent,
  type OpenCodeStatus,
} from '../shared/opencode'
import { mcpEndpoint, skillFiles } from './agent'
import { sarvamKey } from './sarvam'

/** The env var OpenCode reads the Sarvam key from (its Sarvam provider). */
const SARVAM_KEY_ENV = 'UVE_SARVAM_CHAT_KEY'

// OpenCode inside the app. The main process starts `opencode acp` and speaks
// the Agent Client Protocol to it: newline-delimited JSON-RPC on stdio. Each
// chat is an ACP session given our own MCP server (with its token), so the
// agent edits the project through the same tools as any outside agent app.
// OpenCode runs with a config folder of ours, so the owner's own skills,
// plugins and MCP servers stay out; its logins (its data folder) are reused.
// A provider key pasted in the panel is kept encrypted with safeStorage and
// reaches OpenCode only as an environment variable.

const EXE = process.platform === 'win32' ? 'opencode.exe' : 'opencode'
/** How long starting OpenCode and opening a chat may take. */
const START_TIMEOUT_MS = 60_000
/** Requests other than prompts that take longer than this fail. */
const REQUEST_TIMEOUT_MS = 30_000
const KEY_ENV = 'UVE_OPENCODE_API_KEY'

const root = () => join(app.getPath('userData'), 'opencode')
/** Our config folder (XDG_CONFIG_HOME): OpenCode reads `opencode/opencode.json` in it. */
const configHome = () => join(root(), 'config')
/** The agent's working folder: its instructions and the skill; the project itself lives in the editor. */
const workDir = () => join(root(), 'work')
const installDir = () => join(root(), 'npm')
const settingsFile = () => join(root(), 'settings.json')
const keyFile = () => join(root(), 'key.bin')

interface Settings {
  model?: string
  effort?: string
  /** The provider the saved key is for. */
  keyProvider?: string
}

let status: OpenCodeStatus = initialOpenCodeStatus()
let child: ChildProcess | null = null
let starting: Promise<void> | null = null
let stderrTail = ''
let rpcSeq = 0
const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
/** Permission questions waiting for the person, by our question id. */
const questions = new Map<string, (optionId: string | null) => void>()
let questionSeq = 0

function editorWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows()[0]
}

function setStatus(patch: Partial<OpenCodeStatus>): OpenCodeStatus {
  status = { ...status, ...patch }
  editorWindow()?.webContents.send('opencode:status', status)
  return status
}

function emit(event: OpenCodeEvent): void {
  editorWindow()?.webContents.send('opencode:event', event)
}

// ---- Files ----

async function readSettings(): Promise<Settings> {
  try {
    return JSON.parse(await fs.readFile(settingsFile(), 'utf8')) as Settings
  } catch {
    return {}
  }
}

async function writeSettings(patch: Settings): Promise<void> {
  const next = { ...(await readSettings()), ...patch }
  await fs.mkdir(root(), { recursive: true })
  await fs.writeFile(settingsFile(), JSON.stringify(next, null, 2), 'utf8')
}

async function readKey(): Promise<string | null> {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    return safeStorage.decryptString(await fs.readFile(keyFile()))
  } catch {
    return null
  }
}

const keyHint = (key: string) => `…${key.slice(-4)}`
const providerOf = (model: string) => model.split('/')[0] ?? 'opencode'

const AGENTS_MD = `# Ultimate Video Editor

You are the agent built into Ultimate Video Editor, a motion design and video editor. The person talking to you sees the editor beside this chat, and every change you make shows there live.

- Make and change videos only through the editor's tools (the \`uve_*\` MCP tools). Load the \`uve\` skill before your first tool call; if it comes back cut short, read \`.opencode/skills/uve/SKILL.md\` with the read tool, in parts. Read its references (\`.opencode/skills/uve/references/\`) when a task touches them.
- You cannot edit files, and the shell runs only media commands (ffprobe, ffmpeg, listing, copying and moving files, making folders) without asking. Save the project with \`project_save\` and render with \`export_video\`.
- This folder is only your scratch space: the project lives in the editor, not in files. Do not write code or files to make a video.
- Media the person names is on this computer: pass absolute paths to \`media_import\`.
- When a tool result is saved to a file because it is long, read that file with the read tool (in parts), not the shell.
- Look at your work (\`view_render\`, \`view_frames\`) before you say it is done, then answer in a few plain sentences.
- Each message may start with an "Editor context" block. The editor wrote it, not the person: it says which comp is open, where the playhead is and what is selected. "This", "that", "here" and "it" mean the selected layer and the playhead in it. Act on the selection unless the person names something else. Keep answers short and in the person's language.
`

/** Shell commands that only look at, convert or arrange media (and read text, such as a long tool result OpenCode saved); the last matching rule wins. */
const MEDIA_COMMANDS = [
  'ffprobe *',
  'ffmpeg *',
  'ls*',
  'dir*',
  'Get-ChildItem*',
  'Get-Item *',
  'Test-Path *',
  'rg *',
  'Select-String *',
  'grep *',
  'findstr *',
  'head*',
  'tail*',
  'cat *',
  'type *',
  'Get-Content *',
  'Select-Object*',
  'sort*',
  'wc *',
  'mkdir *',
  'New-Item -ItemType Directory *',
  'Copy-Item *',
  'Move-Item *',
  'cp *',
  'mv *',
]

/**
 * The agent makes videos and nothing else, without asking at every step. Editor tools are undoable,
 * and reading, searching and the web change nothing, so they run freely; editing files is refused
 * (the project lives in the editor); the shell runs media commands and asks before anything else.
 */
const VIDEO_ONLY = {
  'uve_*': 'allow',
  read: 'allow',
  glob: 'allow',
  grep: 'allow',
  list: 'allow',
  skill: 'allow',
  webfetch: 'allow',
  websearch: 'allow',
  external_directory: 'allow',
  edit: 'deny',
  bash: { '*': 'ask', ...Object.fromEntries(MEDIA_COMMANDS.map((pattern) => [pattern, 'allow'])) },
}

/** Writes our config, the agent's instructions and the skill (fresh on every start, so they match this build). */
async function writeWorkspace(settings: Settings, hasKey: boolean, hasSarvam: boolean): Promise<void> {
  // With a Sarvam key the agent thinks on Sarvam (the same GLM, served in India); OpenCode Zen stays in the picker.
  const model = settings.model ?? (hasSarvam ? SARVAM_OPENCODE_MODEL : DEFAULT_OPENCODE_MODEL)
  const config: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    model,
    autoupdate: false,
    share: 'disabled',
    permission: VIDEO_ONLY,
  }
  const providers: Record<string, unknown> = {}
  if (hasKey) providers[settings.keyProvider ?? providerOf(model)] = { options: { apiKey: `{env:${KEY_ENV}}` } }
  if (hasSarvam) {
    providers.sarvam = {
      npm: '@ai-sdk/openai-compatible',
      name: 'Sarvam (India)',
      options: { baseURL: SARVAM_CHAT_BASE_URL, apiKey: `{env:${SARVAM_KEY_ENV}}` },
      models: { 'glm5.3-flash': { name: 'GLM 5.3 Flash on Sarvam', tool_call: true, limit: { context: 200000, output: 32000 } } },
    }
  }
  if (Object.keys(providers).length > 0) config.provider = providers
  const configDir = join(configHome(), 'opencode')
  await fs.mkdir(configDir, { recursive: true })
  await fs.writeFile(join(configDir, 'opencode.json'), JSON.stringify(config, null, 2), 'utf8')

  const skillDir = join(workDir(), '.opencode', 'skills', 'uve')
  await fs.rm(skillDir, { recursive: true, force: true })
  for (const [path, body] of Object.entries(skillFiles())) {
    const file = join(skillDir, path)
    await fs.mkdir(dirname(file), { recursive: true })
    await fs.writeFile(file, body, 'utf8')
  }
  await fs.writeFile(join(workDir(), 'AGENTS.md'), AGENTS_MD, 'utf8')
}

// ---- Finding and installing OpenCode ----

function candidates(): string[] {
  const list: string[] = []
  if (process.env.UVE_OPENCODE_PATH) list.push(process.env.UVE_OPENCODE_PATH)
  if (app.isPackaged) list.push(join(process.resourcesPath, 'opencode', EXE))
  list.push(join(installDir(), 'node_modules', 'opencode-ai', 'bin', EXE))
  if (process.platform === 'win32' && process.env.APPDATA) list.push(join(process.env.APPDATA, 'npm', 'node_modules', 'opencode-ai', 'bin', EXE))
  list.push(join(homedir(), '.opencode', 'bin', EXE))
  for (const dir of (process.env.PATH ?? '').split(delimiter)) if (dir) list.push(join(dir, EXE))
  return list
}

function versionOf(path: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(path, ['--version'], { timeout: 20_000, windowsHide: true }, (error, stdout) => {
      const version = String(stdout).trim().split(/\s+/).pop()
      resolve(error || !version ? null : version)
    })
  })
}

async function findOpenCode(): Promise<{ path: string; version: string } | null> {
  for (const path of candidates()) {
    if (!existsSync(path)) continue
    const version = await versionOf(path)
    if (version) return { path, version }
  }
  return null
}

async function install(): Promise<OpenCodeStatus> {
  if (status.state === 'installing') return status
  setStatus({ state: 'installing', error: null })
  try {
    await fs.mkdir(installDir(), { recursive: true })
    await new Promise<void>((resolve, reject) => {
      // npm is a .cmd on Windows, so it runs through the shell; the arguments are fixed.
      execFile(
        'npm',
        ['install', `opencode-ai@${OPENCODE_VERSION}`, '--prefix', `"${installDir()}"`, '--no-audit', '--no-fund'],
        { shell: true, timeout: 10 * 60_000, windowsHide: true },
        (error, _stdout, stderr) => (error ? reject(new Error(String(stderr).trim().split('\n').pop() || error.message)) : resolve()),
      )
    })
    setStatus({ state: 'stopped' })
    return start()
  } catch (error) {
    return setStatus({ state: 'missing', error: `Installing OpenCode failed: ${error instanceof Error ? error.message : String(error)}` })
  }
}

// ---- JSON-RPC over stdio ----

function write(message: object): void {
  child?.stdin?.write(`${JSON.stringify(message)}\n`)
}

function request<T>(method: string, params: object, timeoutMs: number | null = REQUEST_TIMEOUT_MS): Promise<T> {
  if (!child) return Promise.reject(new Error('OpenCode is not running.'))
  const id = ++rpcSeq
  return new Promise<T>((resolve, reject) => {
    const timer = timeoutMs === null ? null : setTimeout(() => fail(new Error(`OpenCode did not answer ${method} in ${timeoutMs / 1000} s.`)), timeoutMs)
    const fail = (error: Error) => {
      if (timer) clearTimeout(timer)
      waiting.delete(id)
      reject(error)
    }
    waiting.set(id, {
      resolve: (value) => {
        if (timer) clearTimeout(timer)
        waiting.delete(id)
        resolve(value as T)
      },
      reject: fail,
    })
    write({ jsonrpc: '2.0', id, method, params })
  })
}

function notify(method: string, params: object): void {
  write({ jsonrpc: '2.0', method, params })
}

interface RpcMessage {
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code: number; message: string }
}

function onMessage(message: RpcMessage): void {
  if (message.method === undefined) {
    const waiter = typeof message.id === 'number' ? waiting.get(message.id) : undefined
    if (!waiter) return
    if (message.error) waiter.reject(new Error(friendlyError(message.error.message)))
    else waiter.resolve(message.result)
    return
  }
  if (message.id !== undefined) {
    if (message.method === 'session/request_permission') void askPermission(message.id, message.params ?? {})
    else write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `${message.method} is not supported by this client.` } })
    return
  }
  if (message.method === 'session/update') {
    const params = message.params as { sessionId?: string; update?: AcpSessionUpdate } | undefined
    if (!params?.update || params.sessionId !== status.sessionId) return
    onUpdate(params.update)
  }
}

function onUpdate(update: AcpSessionUpdate): void {
  switch (update.sessionUpdate) {
    case 'config_option_update':
      setStatus(readOptions((update as { configOptions?: unknown }).configOptions))
      return
    case 'usage_update': {
      const usage = update as { used?: number; size?: number; cost?: { amount?: number; currency?: string } }
      setStatus({ usage: { used: usage.used ?? 0, size: usage.size ?? 0, cost: usage.cost?.amount ?? 0, currency: usage.cost?.currency ?? 'USD' } })
      return
    }
    case 'available_commands_update':
    case 'current_mode_update':
      return
    default:
      emit({ type: 'update', update })
  }
}

interface ConfigOption {
  id: string
  currentValue?: string
  options?: ({ value: string; name: string } | { group: string; name: string; options: { value: string; name: string }[] })[]
}

function readOptions(raw: unknown): Partial<OpenCodeStatus> {
  if (!Array.isArray(raw)) return {}
  const patch: Partial<OpenCodeStatus> = {}
  const flat = (option: ConfigOption): OpenCodeChoice[] =>
    (option.options ?? []).flatMap((entry) => ('options' in entry ? entry.options : [entry])).map(({ value, name }) => ({ value, name }))
  for (const option of raw as ConfigOption[]) {
    if (option.id === 'model') {
      patch.model = option.currentValue ?? null
      patch.models = flat(option)
    } else if (option.id === 'effort') {
      patch.effort = option.currentValue ?? null
      patch.efforts = flat(option)
    }
  }
  return patch
}

function friendlyError(message: string): string {
  const text = message.replace(/^Internal error:\s*/, '')
  if (/api key|unauthori[sz]ed|401|expired/i.test(text)) return `${text} Paste a new key under the chat's options, or run \`opencode auth login\`.`
  return text
}

async function askPermission(rpcId: number | string, params: Record<string, unknown>): Promise<void> {
  const id = `q${++questionSeq}`
  const toolCall = (params.toolCall ?? { toolCallId: id }) as AcpToolCall
  const options = (Array.isArray(params.options) ? params.options : []) as AcpPermissionOption[]
  const optionId = await new Promise<string | null>((resolve) => {
    questions.set(id, resolve)
    emit({ type: 'permission', id, toolCall, options })
  })
  questions.delete(id)
  emit({ type: 'permission-done', id, optionId })
  write({ jsonrpc: '2.0', id: rpcId, result: { outcome: optionId === null ? { outcome: 'cancelled' } : { outcome: 'selected', optionId } } })
}

/** Refuses every open question (on Stop, a new chat or when OpenCode stops). */
function cancelQuestions(): void {
  for (const answer of [...questions.values()]) answer(null)
}

// ---- The process and its chat ----

function startProcess(path: string, key: string | null, sarvam: string | null): ChildProcess {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: configHome(),
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
  }
  // The agent reaches Sarvam through the editor's tools; it needs no key of its own.
  delete env.SARVAM_API_KEY
  if (key) env[KEY_ENV] = key
  if (sarvam) env[SARVAM_KEY_ENV] = sarvam
  const proc = spawn(path, ['acp'], { cwd: workDir(), env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let buffer = ''
  proc.stdout?.setEncoding('utf8')
  proc.stdout?.on('data', (chunk: string) => {
    buffer += chunk
    let end = buffer.indexOf('\n')
    while (end >= 0) {
      const line = buffer.slice(0, end).trim()
      buffer = buffer.slice(end + 1)
      if (line) {
        try {
          onMessage(JSON.parse(line) as RpcMessage)
        } catch {
          // Not a protocol line (OpenCode can print a notice); ignore it.
        }
      }
      end = buffer.indexOf('\n')
    }
  })
  proc.stderr?.setEncoding('utf8')
  proc.stderr?.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-4000)
  })
  const gone = (reason: string) => {
    if (child !== proc) return
    child = null
    for (const waiter of [...waiting.values()]) waiter.reject(new Error(reason))
    waiting.clear()
    cancelQuestions()
    setStatus({ state: 'error', error: reason, busy: false, sessionId: null })
  }
  proc.on('error', (error) => gone(`OpenCode could not start: ${error.message}`))
  proc.on('exit', (code) => {
    const last = stderrTail.trim().split('\n').filter(Boolean).pop()
    gone(`OpenCode stopped (exit code ${code ?? '?'})${last ? `: ${last}` : '.'}`)
  })
  return proc
}

async function openSession(): Promise<void> {
  const endpoint = mcpEndpoint()
  if (!endpoint) throw new Error("The editor's agent server is not running, so OpenCode would have no tools. Restart the editor.")
  const result = await request<{ sessionId: string; configOptions?: unknown }>('session/new', {
    cwd: workDir(),
    mcpServers: [{ type: 'http', name: 'uve', url: endpoint.url, headers: [{ name: 'Authorization', value: `Bearer ${endpoint.token}` }] }],
  }, START_TIMEOUT_MS)
  setStatus({ sessionId: result.sessionId, usage: null, ...readOptions(result.configOptions) })
  const { effort, model } = await readSettings()
  // A new session starts on the config's model; the one picked since (Sarvam's, say) is put back.
  if (model && model !== status.model && status.models.some((m) => m.value === model)) await setOption('model', model).catch(() => undefined)
  if (effort && status.efforts.some((e) => e.value === effort) && effort !== status.effort) await setOption('effort', effort).catch(() => undefined)
}

async function launch(): Promise<void> {
  const found = await findOpenCode()
  if (!found) {
    setStatus({ state: 'missing', error: null, path: null, version: null })
    return
  }
  setStatus({ state: 'starting', error: null, path: found.path, version: found.version })
  const settings = await readSettings()
  const key = await readKey()
  setStatus({ hasKey: key !== null, keyHint: key ? keyHint(key) : null })
  const sarvam = await sarvamKey()
  await writeWorkspace(settings, key !== null, sarvam !== null)
  stderrTail = ''
  child = startProcess(found.path, key, sarvam)
  try {
    await request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, START_TIMEOUT_MS)
    await openSession()
    setStatus({ state: 'ready', error: null })
  } catch (error) {
    stop()
    setStatus({ state: 'error', error: error instanceof Error ? error.message : String(error), sessionId: null })
  }
}

async function start(): Promise<OpenCodeStatus> {
  if (status.state === 'ready' && child) return status
  starting ??= launch().finally(() => {
    starting = null
  })
  await starting
  return status
}

function stop(): void {
  const proc = child
  child = null
  cancelQuestions()
  proc?.kill()
}

/** Longest editor context sent ahead of a message. */
const CONTEXT_MAX = 4000

async function prompt(text: string, context?: string): Promise<void> {
  if (typeof text !== 'string' || text.trim() === '') return
  // The context is the editor's, not the person's: it goes to the agent but not into the transcript.
  const lead = typeof context === 'string' && context.trim() !== '' ? [{ type: 'text', text: context.slice(0, CONTEXT_MAX) }] : []
  if (status.busy) throw new Error('OpenCode is still working on the last request. Stop it first.')
  await start()
  if (status.state !== 'ready' || !status.sessionId) {
    emit({ type: 'error', message: status.error ?? 'OpenCode is not running.', at: Date.now() })
    return
  }
  setStatus({ busy: true })
  emit({ type: 'prompt', text, at: Date.now() })
  try {
    const result = await request<{ stopReason?: string }>('session/prompt', { sessionId: status.sessionId, prompt: [...lead, { type: 'text', text }] }, null)
    emit({ type: 'turn-end', stopReason: result?.stopReason ?? 'end_turn', at: Date.now() })
  } catch (error) {
    emit({ type: 'error', message: error instanceof Error ? error.message : String(error), at: Date.now() })
  } finally {
    setStatus({ busy: false })
  }
}

function cancel(): void {
  cancelQuestions()
  if (status.sessionId) notify('session/cancel', { sessionId: status.sessionId })
}

async function newChat(): Promise<OpenCodeStatus> {
  if (status.state !== 'ready' || !child) {
    emit({ type: 'reset' })
    return start()
  }
  cancel()
  emit({ type: 'reset' })
  try {
    await openSession()
  } catch (error) {
    setStatus({ error: error instanceof Error ? error.message : String(error) })
  }
  return status
}

async function setOption(configId: unknown, value: unknown): Promise<OpenCodeStatus> {
  if ((configId !== 'model' && configId !== 'effort') || typeof value !== 'string') throw new Error('Unknown option.')
  if (configId === 'model') await writeSettings({ model: value })
  else await writeSettings({ effort: value })
  if (!status.sessionId || !child) return status
  const result = await request<{ configOptions?: unknown }>('session/set_config_option', { sessionId: status.sessionId, configId, value })
  return setStatus(readOptions(result?.configOptions))
}

async function setKey(value: unknown): Promise<OpenCodeStatus> {
  if (value !== null && typeof value !== 'string') throw new Error('The key must be text.')
  const key = (value ?? '').trim()
  if (key === '') {
    await fs.rm(keyFile(), { force: true })
  } else {
    if (key.length > 300 || !/^[\x21-\x7e]+$/.test(key)) throw new Error('That does not look like an API key.')
    if (!safeStorage.isEncryptionAvailable()) throw new Error('This computer cannot encrypt the key, so it is not saved.')
    await fs.mkdir(root(), { recursive: true })
    await fs.writeFile(keyFile(), safeStorage.encryptString(key))
    await writeSettings({ keyProvider: providerOf(status.model ?? (await readSettings()).model ?? DEFAULT_OPENCODE_MODEL) })
  }
  // OpenCode reads its config and the key when it starts.
  stop()
  setStatus({ state: 'stopped', sessionId: null, busy: false })
  emit({ type: 'reset' })
  return start()
}

/** Sets up OpenCode's IPC. OpenCode itself starts when the chat panel first asks. */
export function handleOpenCode(): void {
  ipcMain.handle('opencode:status', () => status)
  ipcMain.handle('opencode:start', () => start())
  ipcMain.handle('opencode:new-chat', () => newChat())
  ipcMain.handle('opencode:prompt', (_event, text: unknown, context?: unknown) => prompt(text as string, typeof context === 'string' ? context : undefined))
  ipcMain.handle('opencode:cancel', () => cancel())
  ipcMain.on('opencode:answer', (_event, id: unknown, optionId: unknown) => {
    if (typeof id === 'string') questions.get(id)?.(typeof optionId === 'string' ? optionId : null)
  })
  ipcMain.handle('opencode:set-option', (_event, configId: unknown, value: unknown) => setOption(configId, value))
  ipcMain.handle('opencode:set-key', (_event, key: unknown) => setKey(key))
  ipcMain.handle('opencode:install', () => install())
}

export function stopOpenCode(): void {
  stop()
}
