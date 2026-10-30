// OpenCode inside the app: shared by the main process, which runs `opencode acp`
// and speaks the Agent Client Protocol (ACP) to it, and the renderer, which shows
// the chat. The main process forwards the agent's `session/update` notifications
// as they come; `applyEvent` folds them into the chat transcript. Plain
// TypeScript only: no Node or DOM APIs.

/** OpenCode's state, as the chat panel shows it. */
export interface OpenCodeStatus {
  /**
   * `missing`: no OpenCode found (offer to install). `installing`: installing it.
   * `stopped`: found, not started. `starting`: starting it and opening a chat.
   * `ready`: a chat is open. `error`: it failed to start (see `error`).
   */
  state: 'missing' | 'installing' | 'stopped' | 'starting' | 'ready' | 'error'
  /** Why it is not running, or the last failure. */
  error: string | null
  /** The opencode executable in use. */
  path: string | null
  version: string | null
  /** A request is running (Stop cancels it). */
  busy: boolean
  sessionId: string | null
  /** The model in use (`provider/model`), and every model the logged-in providers offer. */
  model: string | null
  models: OpenCodeChoice[]
  /** How hard the model thinks, when the model allows a choice. */
  effort: string | null
  efforts: OpenCodeChoice[]
  /** A provider key saved in the app (kept encrypted), which wins over OpenCode's own login. */
  hasKey: boolean
  /** The key's last characters, to tell keys apart. */
  keyHint: string | null
  /** Context use and money spent in this chat, from OpenCode. */
  usage: { used: number; size: number; cost: number; currency: string } | null
}

export interface OpenCodeChoice {
  value: string
  name: string
}

/** The default model (OpenCode Zen's free GLM), set by the owner. */
export const DEFAULT_OPENCODE_MODEL = 'opencode/glm-5.3-flash-free'

/** The same GLM served by Sarvam (OpenAI-compatible, in India): the default when a Sarvam key is set. */
export const SARVAM_OPENCODE_MODEL = 'sarvam/glm5.3-flash'
export const SARVAM_CHAT_BASE_URL = 'https://api.sarvam.ai/v2'

/** The OpenCode version the app installs when none is found (MIT, npm `opencode-ai`). */
export const OPENCODE_VERSION = '1.18.32'

export const initialOpenCodeStatus = (): OpenCodeStatus => ({
  state: 'stopped',
  error: null,
  path: null,
  version: null,
  busy: false,
  sessionId: null,
  model: null,
  models: [],
  effort: null,
  efforts: [],
  hasKey: false,
  keyHint: null,
  usage: null,
})

// ---- ACP messages (the parts we read) ----

export interface AcpContentBlock {
  type: string
  text?: string
  [key: string]: unknown
}

/** One entry of a tool call's `content`. */
export type AcpToolContent =
  | { type: 'content'; content: AcpContentBlock }
  | { type: 'diff'; path: string; oldText?: string | null; newText: string }
  | { type: 'terminal'; terminalId: string }

export interface AcpToolCall {
  toolCallId: string
  title?: string
  kind?: string
  status?: 'pending' | 'in_progress' | 'completed' | 'failed'
  content?: AcpToolContent[] | null
  rawInput?: unknown
  rawOutput?: unknown
}

export interface AcpPermissionOption {
  optionId: string
  name: string
  /** `allow_once`, `allow_always`, `reject_once` or `reject_always`. */
  kind: string
}

/** The `update` of a `session/update` notification. */
export type AcpSessionUpdate =
  | { sessionUpdate: 'user_message_chunk' | 'agent_message_chunk' | 'agent_thought_chunk'; content: AcpContentBlock; messageId?: string }
  | ({ sessionUpdate: 'tool_call' | 'tool_call_update' } & AcpToolCall)
  | { sessionUpdate: 'plan'; entries: { content: string; status: string; priority?: string }[] }
  | { sessionUpdate: string; [key: string]: unknown }

/** What the main process sends the chat panel. */
export type OpenCodeEvent =
  /** The person's own request, as sent. */
  | { type: 'prompt'; text: string; at: number }
  | { type: 'update'; update: AcpSessionUpdate }
  /** The agent asks before running a tool; answer with `opencode.answer(id, optionId)`. */
  | { type: 'permission'; id: string; toolCall: AcpToolCall; options: AcpPermissionOption[] }
  /** The question was answered (or cancelled by Stop or a new chat). */
  | { type: 'permission-done'; id: string; optionId: string | null }
  /** The request finished: `end_turn`, `cancelled`, `max_tokens` and so on. */
  | { type: 'turn-end'; stopReason: string; at: number }
  | { type: 'error'; message: string; at: number }
  /** A new chat started: clear the transcript. */
  | { type: 'reset' }

// ---- The transcript ----

export type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

export type ChatItem =
  | { kind: 'user'; id: string; text: string; at: number }
  | { kind: 'agent'; id: string; text: string }
  | { kind: 'thought'; id: string; text: string }
  | {
      kind: 'tool'
      id: string
      title: string
      /** ACP's tool kind: read, edit, execute, fetch, other… */
      toolKind: string
      status: ToolStatus
      input: unknown
      /** The result as text (diffs and long results shortened). */
      output: string
    }
  | { kind: 'plan'; id: string; entries: { content: string; status: string; priority?: string }[] }
  | { kind: 'permission'; id: string; title: string; toolKind: string; input: unknown; options: AcpPermissionOption[]; answer: string | null; done: boolean }
  | { kind: 'error'; id: string; text: string }
  | { kind: 'end'; id: string; stopReason: string; at: number }

/** Results longer than this are cut, so a long render log cannot slow the panel. */
const MAX_OUTPUT = 4000

function clip(text: string): string {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n… (${text.length - MAX_OUTPUT} more characters)` : text
}

function blockText(block: AcpContentBlock | undefined): string {
  if (!block) return ''
  if (block.type === 'text') return block.text ?? ''
  if (block.type === 'image') return '[image]'
  if (block.type === 'resource_link') return `[${String(block.name ?? block.uri ?? 'link')}]`
  if (block.type === 'resource') return '[resource]'
  return ''
}

/** A tool call's result as text: its content, else its raw output. */
export function toolOutput(call: Pick<AcpToolCall, 'content' | 'rawOutput'>): string {
  const parts: string[] = []
  for (const entry of call.content ?? []) {
    if (entry.type === 'content') parts.push(blockText(entry.content))
    else if (entry.type === 'diff') parts.push(`Changed ${entry.path}`)
    else if (entry.type === 'terminal') parts.push('[terminal]')
  }
  let text = parts.filter(Boolean).join('\n')
  if (!text && call.rawOutput !== undefined && call.rawOutput !== null) {
    const raw = call.rawOutput as { output?: unknown; error?: unknown }
    if (typeof raw === 'string') text = raw
    else if (typeof raw.output === 'string') text = raw.output
    else if (typeof raw.error === 'string') text = raw.error
    else text = JSON.stringify(raw)
  }
  return clip(text)
}

/** A tool's name as people read it: OpenCode names our tools `uve_<tool>`. */
export function toolLabel(title: string): string {
  return title.replace(/^uve_/, '')
}

let seq = 0
const nextId = (prefix: string) => `${prefix}${++seq}`

function appendText(items: ChatItem[], kind: 'user' | 'agent' | 'thought', text: string, now: number): ChatItem[] {
  if (text === '') return items
  const last = items[items.length - 1]
  if (last && last.kind === kind) return [...items.slice(0, -1), { ...last, text: last.text + text }]
  if (kind === 'user') return [...items, { kind, id: nextId('u'), text, at: now }]
  return [...items, { kind, id: nextId(kind[0] ?? 'x'), text }]
}

function applyUpdate(items: ChatItem[], update: AcpSessionUpdate, now: number): ChatItem[] {
  switch (update.sessionUpdate) {
    case 'user_message_chunk':
    case 'agent_message_chunk':
    case 'agent_thought_chunk': {
      const kind = update.sessionUpdate === 'user_message_chunk' ? 'user' : update.sessionUpdate === 'agent_message_chunk' ? 'agent' : 'thought'
      return appendText(items, kind, blockText((update as { content: AcpContentBlock }).content), now)
    }
    case 'tool_call':
    case 'tool_call_update': {
      const call = update as AcpToolCall & { sessionUpdate: string }
      const index = items.findIndex((item) => item.kind === 'tool' && item.id === call.toolCallId)
      const before = index >= 0 ? (items[index] as Extract<ChatItem, { kind: 'tool' }>) : null
      const output = call.content || call.rawOutput !== undefined ? toolOutput(call) : null
      const next: ChatItem = {
        kind: 'tool',
        id: call.toolCallId,
        title: call.title ?? before?.title ?? 'tool',
        toolKind: call.kind ?? before?.toolKind ?? 'other',
        status: call.status ?? before?.status ?? 'pending',
        input: call.rawInput !== undefined ? call.rawInput : before?.input,
        output: output || before?.output || '',
      }
      if (index < 0) return [...items, next]
      return items.map((item, i) => (i === index ? next : item))
    }
    case 'plan': {
      const entries = (update as { entries: Extract<ChatItem, { kind: 'plan' }>['entries'] }).entries ?? []
      // One plan per chat, kept where it first appeared and updated in place.
      const index = items.findIndex((item) => item.kind === 'plan')
      if (index < 0) return [...items, { kind: 'plan', id: nextId('p'), entries }]
      return items.map((item, i) => (i === index ? { ...item, entries } : item)) as ChatItem[]
    }
    default:
      return items
  }
}

/** Folds one event from the main process into the transcript. Pure: returns a new array when anything changed. */
export function applyEvent(items: ChatItem[], event: OpenCodeEvent): ChatItem[] {
  switch (event.type) {
    case 'reset':
      return []
    case 'prompt':
      return [...items, { kind: 'user', id: nextId('u'), text: event.text, at: event.at }]
    case 'update':
      // Our own request is already shown; OpenCode echoes it only when a chat is reloaded.
      if (event.update.sessionUpdate === 'user_message_chunk' && items.some((item) => item.kind === 'user')) return items
      return applyUpdate(items, event.update, Date.now())
    case 'permission':
      return [
        ...items,
        {
          kind: 'permission',
          id: event.id,
          title: event.toolCall.title ?? 'a tool',
          toolKind: event.toolCall.kind ?? 'other',
          input: event.toolCall.rawInput,
          options: event.options,
          answer: null,
          done: false,
        },
      ]
    case 'permission-done':
      return items.map((item) => (item.kind === 'permission' && item.id === event.id ? { ...item, answer: event.optionId, done: true } : item))
    case 'turn-end':
      return [...items, { kind: 'end', id: nextId('e'), stopReason: event.stopReason, at: event.at }]
    case 'error':
      return [...items, { kind: 'error', id: nextId('x'), text: event.message }]
  }
}
