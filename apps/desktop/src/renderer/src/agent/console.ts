// The editor's own recent warnings and errors, kept for app_console so an
// agent can diagnose a render or a command that misbehaved.

export interface ConsoleEntry {
  at: number
  level: 'error' | 'warn'
  text: string
}

const LIMIT = 200
const entries: ConsoleEntry[] = []
let installed = false

function add(level: ConsoleEntry['level'], parts: unknown[]): void {
  const text = parts
    .map((part) => (part instanceof Error ? (part.stack ?? part.message) : typeof part === 'string' ? part : safeJson(part)))
    .join(' ')
  entries.push({ at: Date.now(), level, text: text.length > 2000 ? `${text.slice(0, 2000)}…` : text })
  if (entries.length > LIMIT) entries.shift()
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Starts keeping console warnings and errors, and uncaught errors. Safe to call twice. */
export function captureConsole(): void {
  if (installed) return
  installed = true
  for (const level of ['warn', 'error'] as const) {
    const original = console[level].bind(console)
    console[level] = (...parts: unknown[]) => {
      add(level, parts)
      original(...parts)
    }
  }
  window.addEventListener('error', (event) => add('error', [event.error ?? event.message]))
  window.addEventListener('unhandledrejection', (event) => add('error', ['Unhandled rejection:', event.reason]))
}

/** The newest entries at `level` or worse, oldest first. */
export function consoleEntries(level: 'error' | 'warn' | 'all', limit: number): ConsoleEntry[] {
  const wanted = level === 'error' ? entries.filter((e) => e.level === 'error') : entries
  return wanted.slice(-limit)
}
