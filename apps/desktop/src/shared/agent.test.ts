import { describe, expect, it } from 'vitest'
import { agentSetups, toolName } from './agent'

describe('agent setup', () => {
  const status = { url: 'http://127.0.0.1:7428/mcp', token: 'secret', shimPath: String.raw`C:\Users\me\AppData\uve-mcp.mjs` }

  it('names tools after commands', () => {
    expect(toolName('layer.set')).toBe('layer_set')
    expect(toolName('layers.makeUnique')).toBe('layers_makeUnique')
  })

  it('gives each app its own way in, with the URL and token or the shim', () => {
    const setups = Object.fromEntries(agentSetups(status).map((s) => [s.id, s.code]))
    expect(setups['claude-code']).toBe(
      'claude mcp add -s user --transport http uve http://127.0.0.1:7428/mcp --header "Authorization: Bearer secret"',
    )
    expect(setups.codex).toBe(`codex mcp add uve -- node "${status.shimPath}"`)
    expect(JSON.parse(setups.cursor ?? '')).toEqual({
      mcpServers: { uve: { url: status.url, headers: { Authorization: 'Bearer secret' } } },
    })
    // Windows paths stay valid JSON.
    expect(JSON.parse(setups['claude-desktop'] ?? '').mcpServers.uve.args).toEqual([status.shimPath])
  })
})
