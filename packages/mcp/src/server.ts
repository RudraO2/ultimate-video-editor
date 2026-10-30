import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type McpClient, type McpHost, PROTOCOL_VERSIONS } from './protocol'

// MCP over Streamable HTTP (spec 2025-06-18), the small part an editor needs:
// clients POST JSON-RPC to /mcp and get JSON back. There is no server-to-client
// stream, so GET answers 405, which the spec allows. The server listens on the
// loopback interface only, wants the bearer token on every request, and turns
// away other hosts and web origins (DNS rebinding).

export const MCP_PATH = '/mcp'
/** Largest request body. Tool inputs are small; files travel by path. */
const MAX_BODY_BYTES = 8 * 1024 * 1024
/** Sessions kept; the oldest go first when a client never says goodbye. */
const MAX_SESSIONS = 64
const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/

export interface McpServerOptions {
  host: McpHost
  token: string
  /** 0 picks a free port. */
  port: number
}

export interface RunningMcpServer {
  readonly port: number
  readonly url: string
  clients(): McpClient[]
  close(): Promise<void>
}

type JsonRpcId = string | number | null
interface JsonRpcMessage {
  jsonrpc?: string
  id?: JsonRpcId
  method?: string
  params?: Record<string, unknown>
}
type JsonRpcReply = { jsonrpc: '2.0'; id: JsonRpcId } & (
  | { result: unknown }
  | { error: { code: number; message: string } }
)

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

export function startMcpServer(options: McpServerOptions): Promise<RunningMcpServer> {
  const { host, token } = options
  const sessions = new Map<string, McpClient>()
  const expected = Buffer.from(`Bearer ${token}`)
  let port = 0

  const changed = () => host.onClientsChanged?.([...sessions.values()])

  const authorized = (req: IncomingMessage) => {
    const given = Buffer.from(req.headers.authorization ?? '')
    return given.length === expected.length && timingSafeEqual(given, expected)
  }

  const hostAllowed = (req: IncomingMessage) => {
    const name = req.headers.host ?? ''
    return name === `127.0.0.1:${port}` || name === `localhost:${port}`
  }

  async function handle(message: JsonRpcMessage, client: McpClient | null, reply: (r: JsonRpcReply) => void, res: ServerResponse) {
    const { id, method, params = {} } = message
    if (method === undefined) return // a response to us; we never ask
    const isRequest = id !== undefined
    try {
      const result = await dispatch(method, params, client, res)
      if (isRequest) reply({ jsonrpc: '2.0', id, result })
    } catch (error) {
      if (!isRequest) return
      const code = error instanceof RpcError ? error.code : -32603
      reply({ jsonrpc: '2.0', id, error: { code, message: error instanceof Error ? error.message : String(error) } })
    }
  }

  async function dispatch(method: string, params: Record<string, unknown>, client: McpClient | null, res: ServerResponse) {
    switch (method) {
      case 'initialize': {
        const asked = String(params.protocolVersion ?? '')
        const info = (params.clientInfo ?? {}) as { name?: unknown; version?: unknown }
        const session = randomUUID()
        sessions.set(session, {
          session,
          name: typeof info.name === 'string' ? info.name : 'an MCP client',
          version: typeof info.version === 'string' ? info.version : '',
          lastSeenAt: Date.now(),
        })
        while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value as string)
        res.setHeader('Mcp-Session-Id', session)
        changed()
        return {
          protocolVersion: (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
          serverInfo: host.serverInfo,
          instructions: host.instructions,
        }
      }
      case 'ping':
        return {}
      case 'tools/list':
        return { tools: await host.tools() }
      case 'tools/call': {
        const name = params.name
        if (typeof name !== 'string') throw new RpcError(-32602, 'tools/call needs a tool name.')
        const args = params.arguments ?? {}
        if (typeof args !== 'object' || args === null || Array.isArray(args)) {
          throw new RpcError(-32602, 'Tool arguments must be an object.')
        }
        const who = client ?? { session: 'none', name: 'an MCP client', version: '', lastSeenAt: Date.now() }
        return await host.callTool(name, args as Record<string, unknown>, who)
      }
      case 'resources/list':
        return {
          resources: host.resources().map(({ uri, name, description, mimeType }) => ({ uri, name, description, mimeType })),
        }
      case 'resources/templates/list':
        return { resourceTemplates: [] }
      case 'resources/read': {
        const resource = host.resources().find((r) => r.uri === params.uri)
        if (!resource) throw new RpcError(-32002, `Unknown resource: ${String(params.uri)}`)
        return { contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: resource.text }] }
      }
      default:
        if (method.startsWith('notifications/')) return null
        throw new RpcError(-32601, `Method not found: ${method}`)
    }
  }

  async function onRequest(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const origin = req.headers.origin
    if (!hostAllowed(req) || (origin !== undefined && !LOOPBACK_ORIGIN.test(origin))) {
      return send(res, 403, { error: 'Forbidden' })
    }
    if (url.pathname !== MCP_PATH) return send(res, 404, { error: 'Not found' })
    if (!authorized(req)) return send(res, 401, { error: 'A valid bearer token is required.' })

    const sessionId = req.headers['mcp-session-id']
    const client = typeof sessionId === 'string' ? (sessions.get(sessionId) ?? null) : null
    if (typeof sessionId === 'string' && !client) return send(res, 404, rpcError(null, -32001, 'Session not found.'))

    if (req.method === 'DELETE') {
      if (client) {
        sessions.delete(client.session)
        changed()
      }
      return send(res, 200, {})
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, DELETE')
      return send(res, 405, { error: 'This server does not open event streams.' })
    }

    let body: unknown
    try {
      body = JSON.parse(await readBody(req))
    } catch (error) {
      if (error instanceof RpcError) return send(res, 413, rpcError(null, error.code, error.message))
      return send(res, 400, rpcError(null, -32700, 'Parse error'))
    }
    if (client) {
      client.lastSeenAt = Date.now()
      changed()
    }

    const messages = (Array.isArray(body) ? body : [body]) as JsonRpcMessage[]
    if (messages.length === 0 || messages.some((m) => m === null || typeof m !== 'object')) {
      return send(res, 400, rpcError(null, -32600, 'Invalid request'))
    }
    const replies: JsonRpcReply[] = []
    for (const message of messages) await handle(message, client, (r) => replies.push(r), res)
    if (replies.length === 0) {
      res.writeHead(202).end()
      return
    }
    send(res, 200, Array.isArray(body) ? replies : replies[0])
  }

  const server: Server = createServer((req, res) => {
    onRequest(req, res).catch((error: unknown) => {
      if (!res.headersSent) send(res, 500, rpcError(null, -32603, error instanceof Error ? error.message : String(error)))
      else res.end()
    })
  })
  // Tool calls such as renders can take a while.
  server.requestTimeout = 0

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', reject)
      port = (server.address() as AddressInfo).port
      resolve({
        port,
        url: `http://127.0.0.1:${port}${MCP_PATH}`,
        clients: () => [...sessions.values()],
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections()
            server.close(() => done())
          }),
      })
    })
  })
}

function rpcError(id: JsonRpcId, code: number, message: string): JsonRpcReply {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    // A body that is too large is drained, so the client still gets its answer.
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size <= MAX_BODY_BYTES) chunks.push(chunk)
    })
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) reject(new RpcError(-32600, 'Request too large.'))
      else resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}
