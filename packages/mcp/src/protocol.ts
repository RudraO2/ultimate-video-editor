/** A tool as MCP lists it. Names use `_` (`layer_set`); the editor maps them to its commands. */
export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export type McpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export interface McpToolResult {
  content: McpContent[]
  isError?: boolean
}

/** A text document served as an MCP resource, such as a skill doc. */
export interface McpResource {
  uri: string
  name: string
  description?: string
  mimeType: string
  text: string
}

/** The agent app on the other end of an MCP session, from its `initialize`. */
export interface McpClient {
  /** The MCP session id (one per connected agent session). */
  session: string
  /** `clientInfo.name`, such as "claude-code". */
  name: string
  version: string
  /** Date.now() of its last request. */
  lastSeenAt: number
}

/** What the server serves. The editor implements it. */
export interface McpHost {
  serverInfo: { name: string; version: string }
  /** Sent to the client at `initialize`: how to start. */
  instructions: string
  tools(): Promise<McpTool[]>
  callTool(name: string, args: Record<string, unknown>, client: McpClient): Promise<McpToolResult>
  resources(): McpResource[]
  /** Called when a client connects or leaves. */
  onClientsChanged?(clients: McpClient[]): void
}

/** Protocol versions this server speaks, newest first. */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const

/** Where the editor writes how to reach its server, for the stdio shim and the setup panel. */
export interface ConnectionInfo {
  url: string
  token: string
  /** The app process serving it, so a stale file can be told apart. */
  pid: number
}
