#!/usr/bin/env node
/**
 * uve-mcp: a stdio MCP server for agent apps that only speak stdio. It relays
 * every message to the MCP server inside the running Ultimate Video Editor
 * (Streamable HTTP on 127.0.0.1), which it finds through the connection file
 * the editor writes: ~/.uve/mcp.json, or the path in UVE_MCP_CONNECTION.
 *
 * When the editor is not running, it still answers: one tool, uve_status, says
 * how to start it. Once the editor answers, the shim tells the agent app that
 * the tool list changed.
 *
 * Plain Node 22 with no dependencies, so it runs from any folder.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

const CONNECTION_FILE = process.env.UVE_MCP_CONNECTION ?? join(homedir(), '.uve', 'mcp.json')
const OFFLINE =
  'Ultimate Video Editor is not running, or its agent server is off. Ask the user to open the editor (Agents tab ▸ Connect your agent shows the server), then call uve_status again.'

const STATUS_TOOL = {
  name: 'uve_status',
  description: 'Check whether Ultimate Video Editor is running and connected. When it is not, tell the user to open it.',
  inputSchema: { type: 'object', properties: {} },
}

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const log = (text) => process.stderr.write(`[uve-mcp] ${text}\n`)

/** The client's initialize params, replayed when the editor (re)starts. */
let clientInit = null
/** The editor's session for this shim, or null before it answered. */
let upstream = null
let connecting = null
/** The client saw the offline tool list, so it must hear when the real one arrives. */
let staleLists = false

function connection() {
  const info = JSON.parse(readFileSync(CONNECTION_FILE, 'utf8'))
  if (typeof info.url !== 'string' || typeof info.token !== 'string') throw new Error('Bad connection file')
  return info
}

async function post(message, session) {
  const { url, token } = connection()
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${token}`,
  }
  if (session) headers['Mcp-Session-Id'] = session
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(message) })
  return response
}

/** Opens a session with the editor. Returns its initialize result, or throws when it cannot be reached. */
function connect() {
  connecting ??= (async () => {
    const params = clientInit ?? { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'uve-mcp' } }
    const response = await post({ jsonrpc: '2.0', id: 'shim-init', method: 'initialize', params })
    if (!response.ok) throw new Error(`The editor answered ${response.status}`)
    const session = response.headers.get('mcp-session-id')
    const reply = await response.json()
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, session)
    upstream = session
    if (staleLists) {
      staleLists = false
      write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
      write({ jsonrpc: '2.0', method: 'notifications/resources/list_changed' })
    }
    log('connected to the editor')
    return reply.result
  })().finally(() => {
    connecting = null
  })
  return connecting
}

/** Relays one message to the editor and returns its reply (null for a notification). */
async function relay(message) {
  if (!upstream) await connect()
  let response = await post(message, upstream)
  if (response.status === 404) {
    // The editor restarted and forgot this session: open a new one and try again.
    upstream = null
    await connect()
    response = await post(message, upstream)
  }
  if (response.status === 202) return null
  if (!response.ok && response.status !== 400) throw new Error(`The editor answered ${response.status}`)
  return response.json()
}

/** The answer when the editor cannot be reached. */
function offline(message) {
  const { id, method } = message
  if (id === undefined) return null
  switch (method) {
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} }
    case 'tools/list':
      staleLists = true
      return { jsonrpc: '2.0', id, result: { tools: [STATUS_TOOL] } }
    case 'resources/list':
      staleLists = true
      return { jsonrpc: '2.0', id, result: { resources: [] } }
    case 'tools/call':
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: OFFLINE }], isError: message.params?.name !== STATUS_TOOL.name },
      }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32603, message: OFFLINE } }
  }
}

async function onMessage(message) {
  if (message.method === 'initialize') {
    clientInit = message.params ?? null
    let result
    try {
      upstream = null
      result = await connect()
    } catch {
      staleLists = true
      result = {
        protocolVersion: clientInit?.protocolVersion ?? '2025-06-18',
        serverInfo: { name: 'uve', version: '0.1.0' },
        instructions: OFFLINE,
      }
    }
    // The shim can announce list changes even though the editor's server cannot.
    result = { ...result, capabilities: { tools: { listChanged: true }, resources: { listChanged: true } } }
    return write({ jsonrpc: '2.0', id: message.id, result })
  }
  if (message.method === 'notifications/initialized') return
  // A file path the agent gives is relative to its own folder, which only this shim knows.
  const args = message.method === 'tools/call' ? message.params?.arguments : undefined
  if (typeof args?.localPath === 'string' && !isAbsolute(args.localPath)) {
    args.localPath = resolve(process.cwd(), args.localPath.replace(/^~(?=[\\/]|$)/, homedir()))
  }
  let reply
  try {
    reply = await relay(message)
  } catch {
    upstream = null
    reply = offline(message)
  }
  if (reply) write(reply)
}

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
  }
  void onMessage(message)
})
lines.on('close', () => process.exit(0))
