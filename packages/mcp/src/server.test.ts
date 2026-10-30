import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'
import type { McpClient, McpHost } from './protocol'
import { type RunningMcpServer, startMcpServer } from './server'

const TOKEN = 'test-token'

function fakeHost(seen: McpClient[][] = []): McpHost {
  return {
    serverInfo: { name: 'uve', version: '0.0.0' },
    instructions: 'Read uve://skill/SKILL.md first.',
    tools: async () => [{ name: 'echo', description: 'Echoes', inputSchema: { type: 'object' } }],
    callTool: async (name, args, client) =>
      name === 'echo'
        ? { content: [{ type: 'text', text: JSON.stringify({ args, client: client.name }) }] }
        : { content: [{ type: 'text', text: `Unknown tool ${name}` }], isError: true },
    resources: () => [{ uri: 'uve://skill/SKILL.md', name: 'skill/SKILL.md', mimeType: 'text/markdown', text: '# Skill' }],
    onClientsChanged: (clients) => seen.push(clients),
  }
}

let server: RunningMcpServer | null = null
afterEach(async () => {
  await server?.close()
  server = null
})

async function rpc(body: unknown, headers: Record<string, string> = {}) {
  if (!server) throw new Error('no server')
  const response = await fetch(server.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...headers },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, session: response.headers.get('mcp-session-id'), body: text ? JSON.parse(text) : null }
}

const initialize = (id = 1) =>
  rpc({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code', version: '9' } } })

describe('MCP server', () => {
  it('initializes a session and serves tools and resources', async () => {
    const seen: McpClient[][] = []
    server = await startMcpServer({ host: fakeHost(seen), token: TOKEN, port: 0 })
    const init = await initialize()
    expect(init.status).toBe(200)
    expect(init.body.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'uve' } })
    const session = init.session as string
    expect(session).toBeTruthy()
    expect(seen.at(-1)?.[0]).toMatchObject({ name: 'claude-code', version: '9' })

    const note = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'Mcp-Session-Id': session })
    expect(note.status).toBe(202)

    const tools = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'Mcp-Session-Id': session })
    expect(tools.body.result.tools.map((t: { name: string }) => t.name)).toEqual(['echo'])

    const call = await rpc(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } } },
      { 'Mcp-Session-Id': session },
    )
    expect(JSON.parse(call.body.result.content[0].text)).toEqual({ args: { a: 1 }, client: 'claude-code' })

    const read = await rpc(
      { jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'uve://skill/SKILL.md' } },
      { 'Mcp-Session-Id': session },
    )
    expect(read.body.result.contents[0].text).toBe('# Skill')

    const unknown = await rpc({ jsonrpc: '2.0', id: 5, method: 'nope' }, { 'Mcp-Session-Id': session })
    expect(unknown.body.error.code).toBe(-32601)
  })

  it('answers a batch in order', async () => {
    server = await startMcpServer({ host: fakeHost(), token: TOKEN, port: 0 })
    const batch = await rpc([
      { jsonrpc: '2.0', id: 'a', method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 'b', method: 'tools/list' },
    ])
    expect(batch.body.map((r: { id: string }) => r.id)).toEqual(['a', 'b'])
  })

  it('wants the token, a loopback host and origin, and a known session', async () => {
    server = await startMcpServer({ host: fakeHost(), token: TOKEN, port: 0 })
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Authorization: 'Bearer wrong' })).status).toBe(401)
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'https://evil.example' })).status).toBe(403)
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'http://localhost:5173' })).status).toBe(200)
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'Mcp-Session-Id': 'gone' })).status).toBe(404)
    const get = await fetch(server.url, { headers: { Authorization: `Bearer ${TOKEN}` } })
    expect(get.status).toBe(405)
    const parse = await fetch(server.url, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: '{' })
    expect(parse.status).toBe(400)
  })

  it('ends a session on DELETE', async () => {
    const seen: McpClient[][] = []
    server = await startMcpServer({ host: fakeHost(seen), token: TOKEN, port: 0 })
    const { session } = await initialize()
    const url = server.url
    await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}`, 'Mcp-Session-Id': session as string } })
    expect(server.clients()).toEqual([])
    expect(seen.at(-1)).toEqual([])
  })
})

describe('uve-mcp stdio shim', () => {
  const shim = join(__dirname, '..', 'bin', 'uve-mcp.mjs')

  function startShim(connectionFile: string) {
    const child = spawn(process.execPath, [shim], { env: { ...process.env, UVE_MCP_CONNECTION: connectionFile } })
    const lines = createInterface({ input: child.stdout })
    const waiting: ((message: Record<string, unknown>) => void)[] = []
    const queued: Record<string, unknown>[] = []
    lines.on('line', (line) => {
      const message = JSON.parse(line)
      const next = waiting.shift()
      if (next) next(message)
      else queued.push(message)
    })
    const read = () =>
      new Promise<Record<string, unknown>>((resolve) => {
        const message = queued.shift()
        if (message) resolve(message)
        else waiting.push(resolve)
      })
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`)
    return { child, read, send }
  }

  it('relays to the editor, and answers on its own while the editor is closed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uve-mcp-'))
    const file = join(dir, 'mcp.json')
    const { child, read, send } = startShim(file)
    try {
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'gemini' } } })
      expect(((await read()).result as { capabilities: unknown }).capabilities).toMatchObject({ tools: { listChanged: true } })
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
      expect(await read()).toMatchObject({ id: 2, result: { tools: [{ name: 'uve_status' }] } })

      server = await startMcpServer({ host: fakeHost(), token: TOKEN, port: 0 })
      writeFileSync(file, JSON.stringify({ url: server.url, token: TOKEN, pid: process.pid }))
      send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { b: 2 } } })
      expect(await read()).toMatchObject({ method: 'notifications/tools/list_changed' })
      expect(await read()).toMatchObject({ method: 'notifications/resources/list_changed' })
      const call = await read()
      expect(call.id).toBe(3)
      const text = (call.result as { content: { text: string }[] }).content[0]?.text ?? ''
      expect(JSON.parse(text)).toEqual({ args: { b: 2 }, client: 'gemini' })
    } finally {
      child.kill()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
