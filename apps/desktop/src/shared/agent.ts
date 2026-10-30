// The agent link: shared by the main process, which runs the MCP server, and
// the renderer, which owns the project and answers tool calls. Plain
// TypeScript only: no Node or DOM APIs.
import type { McpClient, McpTool, McpToolResult } from '@uve/mcp'
import type { InspectedFont } from './fonts'
import type { GrantedFile } from './media'

export type { McpClient, McpTool, McpToolResult }

/** A tool call relayed from the MCP server to the renderer. */
export interface AgentCall {
  id: string
  name: string
  args: Record<string, unknown>
  client: Pick<McpClient, 'session' | 'name'>
  /** media_import and world_import_model: the file named by `localPath` (world_import_model: or fetched from `url`), granted by the main process. */
  file?: GrantedFile
  /** font_install only: the font file named by `localPath` or fetched from `url`, granted and read by the main process. */
  font?: InspectedFont
}

/** What the Agents panel shows. */
export interface AgentStatus {
  running: boolean
  /** Why the server is not running. */
  error: string | null
  url: string
  token: string
  /** The stdio shim, for agent apps that only start stdio servers. */
  shimPath: string
  /** Where the URL and token are written for the shim. */
  connectionFile: string
  /** Agent sessions that connected since the app started, newest activity first. */
  clients: McpClient[]
}

/** The default port of the agent server; UVE_MCP_PORT overrides it. A busy port falls back to a free one. */
export const DEFAULT_MCP_PORT = 7428

/** Tool names are command names with `_` for `.`: `layer.set` → `layer_set`. */
export function toolName(command: string): string {
  return command.replaceAll('.', '_')
}

/** An agent app the setup panel has instructions for. */
export interface AgentSetup {
  id: string
  label: string
  /** What to do with `code`. */
  hint: string
  code: string
}

/**
 * How to add the editor to each agent app. Apps that take an HTTP server with
 * headers get the URL and token; the others start the stdio shim, which finds
 * the server by itself (it needs Node.js 22 or newer).
 */
export function agentSetups(status: Pick<AgentStatus, 'url' | 'token' | 'shimPath'>): AgentSetup[] {
  const { url, token, shimPath } = status
  const auth = `Authorization: Bearer ${token}`
  const headers = { Authorization: `Bearer ${token}` }
  const json = (value: unknown) => JSON.stringify(value, null, 2)
  const shim = { command: 'node', args: [shimPath] }
  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      hint: 'Run this in a terminal, then start a new Claude Code session.',
      code: `claude mcp add -s user --transport http uve ${url} --header "${auth}"`,
    },
    {
      id: 'codex',
      label: 'Codex',
      hint: 'Run this in a terminal, then start a new Codex session.',
      code: `codex mcp add uve -- node "${shimPath}"`,
    },
    {
      id: 'gemini',
      label: 'Gemini CLI',
      hint: 'Run this in a terminal, then start a new Gemini CLI session.',
      code: `gemini mcp add -s user --transport http uve ${url} --header "${auth}"`,
    },
    {
      id: 'opencode',
      label: 'OpenCode',
      hint: 'Add this to ~/.config/opencode/opencode.json, then restart OpenCode.',
      code: json({ $schema: 'https://opencode.ai/config.json', mcp: { uve: { type: 'remote', url, enabled: true, headers } } }),
    },
    {
      id: 'cursor',
      label: 'Cursor',
      hint: 'Add this to ~/.cursor/mcp.json.',
      code: json({ mcpServers: { uve: { url, headers } } }),
    },
    {
      id: 'vscode',
      label: 'VS Code',
      hint: 'Run this in a terminal.',
      code: `code --add-mcp '${JSON.stringify({ name: 'uve', type: 'http', url, headers })}'`,
    },
    {
      id: 'claude-desktop',
      label: 'Claude Desktop',
      hint: 'Add this in Settings ▸ Developer ▸ Edit Config, then restart Claude Desktop. It needs Node.js 22 or newer.',
      code: json({ mcpServers: { uve: shim } }),
    },
    {
      id: 'other',
      label: 'Any other',
      hint: 'An app that takes an HTTP server: the URL with the Authorization header. An app that only starts programs: the stdio server below.',
      code: `URL     ${url}\nHeader  ${auth}\n\n${json({ mcpServers: { uve: shim } })}`,
    },
  ]
}
