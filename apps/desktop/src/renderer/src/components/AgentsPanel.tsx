import { Bot, Check, CircleAlert, CircleCheck, Copy, Eye, EyeOff, Plug, X } from '../icons'
import { useEffect, useMemo, useState } from 'react'
import { type AgentStatus, agentSetups } from '../../../shared/agent'
import { useEditor } from '../store'
import { ChatPanel } from './ChatPanel'

// The Agents tab: whether the agent server is listening, which agent apps are
// connected, and each tool call they make, as AtomCut's Agents tab shows
// them. "Connect your agent" explains how to add the editor to each app.

const EXAMPLE_PROMPT = 'In Ultimate Video Editor, make a 5-second title card'
/** Sessions that called in this long count as connected. */
const ACTIVE_MS = 10 * 60_000

function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 10) return 'just now'
  if (seconds < 60) return `${seconds} s ago`
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/** Re-renders every few seconds, for "2 min ago" labels. */
function useNow(intervalMs = 5000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-ink"
    >
      {copied ? <Check size={14} className="text-ok" /> : <Copy size={14} />}
    </button>
  )
}

function ServerLine({ status }: { status: AgentStatus | null }) {
  if (!status) return <p className="text-[11px] text-muted">Starting…</p>
  if (!status.running) {
    return (
      <p className="flex items-start gap-1.5 text-[11px] text-accent">
        <CircleAlert size={13} className="mt-px shrink-0" aria-hidden />
        The agent server is off: {status.error ?? 'unknown error'}
      </p>
    )
  }
  return (
    <p className="flex items-center gap-1.5 text-[11px] text-muted">
      <span className="size-1.5 rounded-full bg-ok" aria-hidden />
      Listening on <span className="font-mono text-ink">{status.url.replace(/^http:\/\//, '')}</span>
    </p>
  )
}

/** The left panel's Agents tab: OpenCode's own chat, or the outside agent apps connected over MCP. */
export function AgentsPanel() {
  const status = useEditor((s) => s.agentStatus)
  const [view, setView] = useState<'opencode' | 'others'>('opencode')
  const [connectOpen, setConnectOpen] = useState(false)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between pr-2 pl-4">
        <h2 className="text-[11px] font-semibold tracking-wider text-muted uppercase">Agents</h2>
        <button
          type="button"
          onClick={() => setConnectOpen(true)}
          className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11px] text-muted hover:bg-hover hover:text-ink"
        >
          <Plug size={13} aria-hidden />
          Connect your agent
        </button>
      </div>
      <div role="tablist" className="mx-4 mb-2 flex shrink-0 gap-0.5 rounded-lg bg-field p-0.5">
        {(
          [
            ['opencode', 'OpenCode'],
            ['others', 'Other apps'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={view === id}
            onClick={() => setView(id)}
            className={`h-6 flex-1 rounded-md text-[11px] ${view === id ? 'active-tint' : 'text-muted hover:text-ink'}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">{view === 'opencode' ? <ChatPanel /> : <OtherApps />}</div>
      {connectOpen && <ConnectDialog status={status} onClose={() => setConnectOpen(false)} />}
    </div>
  )
}

/** Agent apps connected over MCP: the server line, the apps, an example request and each tool call. */
function OtherApps() {
  const status = useEditor((s) => s.agentStatus)
  const log = useEditor((s) => s.agentLog)
  const [connectOpen, setConnectOpen] = useState(false)
  const now = useNow()
  // One row per agent app, as several sessions of one app often run at once.
  const apps = useMemo(() => {
    const byName = new Map<string, { name: string; sessions: number; lastSeenAt: number }>()
    for (const client of status?.clients ?? []) {
      if (now - client.lastSeenAt >= ACTIVE_MS) continue
      const app = byName.get(client.name) ?? { name: client.name, sessions: 0, lastSeenAt: 0 }
      app.sessions++
      app.lastSeenAt = Math.max(app.lastSeenAt, client.lastSeenAt)
      byName.set(client.name, app)
    }
    return [...byName.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  }, [status, now])
  const calls = useMemo(() => {
    const counts = new Map<string, number>()
    for (const entry of log) counts.set(entry.client, (counts.get(entry.client) ?? 0) + 1)
    return counts
  }, [log])

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-line px-4 pb-3">
        <ServerLine status={status} />
        {apps.length === 0 ? (
          <div className="rounded-lg bg-field px-3 py-2.5 text-[11px] leading-relaxed text-muted">
            No agent connected yet.{' '}
            <button type="button" onClick={() => setConnectOpen(true)} className="text-accent hover:underline">
              Connect Claude Code, Codex, Gemini CLI or any MCP app
            </button>
            , then ask it:
          </div>
        ) : (
          <ul className="space-y-1">
            {apps.map((app) => (
              <li key={app.name} className="flex items-center gap-2 rounded-lg bg-field px-2.5 py-2">
                <Bot size={15} className="shrink-0 text-accent" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[11px] font-medium text-ink">{app.name}</div>
                  <div className="flex items-center gap-1 text-[10px] text-muted">
                    <span className="size-1.5 rounded-full bg-ok" aria-hidden />
                    {app.sessions} session{app.sessions === 1 ? '' : 's'} · {plural(calls.get(app.name) ?? 0, 'call')} · {ago(app.lastSeenAt, now)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-1 rounded-lg border border-line py-0.5 pr-0.5 pl-2.5">
          <span className="min-w-0 flex-1 truncate text-[11px] text-ink">“{EXAMPLE_PROMPT}”</span>
          <CopyButton text={EXAMPLE_PROMPT} label="Copy the example request" />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {log.length === 0 ? (
          <p className="px-6 pt-8 text-center text-[11px] leading-relaxed text-muted">
            Nothing yet. Your agent's steps will appear here.
          </p>
        ) : (
          <ul>
            {log.map((entry) => (
              <li key={`${entry.at}-${entry.tool}-${entry.ms}`} className="flex h-7 items-center gap-2 rounded-lg px-2 hover:bg-hover">
                {entry.ok ? (
                  <CircleCheck size={12} className="shrink-0 text-ok" aria-label="Done" />
                ) : (
                  <CircleAlert size={12} className="shrink-0 text-accent" aria-label="Failed" />
                )}
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink">{entry.tool}</span>
                <span className="shrink-0 font-mono text-[10px] text-muted">{entry.ms < 1000 ? `${entry.ms} ms` : `${(entry.ms / 1000).toFixed(1)} s`}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {connectOpen && <ConnectDialog status={status} onClose={() => setConnectOpen(false)} />}
    </div>
  )
}

/** "Connect your agent": how to add the editor to each agent app, and the server's address and token. */
function ConnectDialog({ status, onClose }: { status: AgentStatus | null; onClose: () => void }) {
  const setups = status ? agentSetups(status) : []
  const [picked, setPicked] = useState('claude-code')
  const [showToken, setShowToken] = useState(false)
  const setup = setups.find((s) => s.id === picked) ?? setups[0]

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const hide = (text: string) => (status && !showToken ? text.replaceAll(status.token, '•'.repeat(12)) : text)

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="connect-title" className="max-h-[calc(100vh-2rem)] w-[32rem] overflow-y-auto rounded-panel border border-line bg-card p-6 shadow-float">
        <div className="flex items-start justify-between">
          <div>
            <h2 id="connect-title" className="flex items-center gap-2 text-[15px] font-semibold text-ink">
              <Plug size={17} className="text-accent" aria-hidden />
              Connect your agent
            </h2>
            <p className="mt-1 text-[12px] text-muted">Claude Code, Codex, Gemini CLI, OpenCode, Cursor, VS Code: any app that speaks MCP.</p>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="flex size-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-ink">
            <X size={16} />
          </button>
        </div>
        <p className="mt-4 text-[12px] leading-relaxed text-ink/80">
          Let the agent app you already use drive this project: every editor command as a tool, real renders to check its work, and its
          edits in one go as one undo step. Free, local, and with any model your app runs.
        </p>

        {!status?.running ? (
          <p className="mt-4 flex items-start gap-1.5 text-[12px] text-accent">
            <CircleAlert size={14} className="mt-px shrink-0" aria-hidden />
            The agent server is off{status?.error ? `: ${status.error}` : '.'} Restart the editor to try again.
          </p>
        ) : (
          <>
            <h3 className="mt-5 text-[12px] font-semibold text-ink">1. Add the editor to your agent app</h3>
            <div className="mt-2 flex flex-wrap gap-1.5" role="tablist">
              {setups.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="tab"
                  aria-selected={s.id === setup?.id}
                  onClick={() => setPicked(s.id)}
                  className={`h-8 rounded-lg border px-3 text-[12px] ${
                    s.id === setup?.id ? 'active-tint border-accent/40' : 'border-line text-muted hover:bg-hover hover:text-ink'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
            {setup && (
              <>
                <p className="mt-3 text-[11px] text-muted">{setup.hint}</p>
                <div className="mt-1.5 flex items-start gap-1 rounded-lg border border-line bg-field py-1.5 pr-1.5 pl-3">
                  <pre className="max-h-48 min-w-0 flex-1 overflow-auto py-1 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-ink">
                    {hide(setup.code)}
                  </pre>
                  <CopyButton text={setup.code} label="Copy" />
                </div>
              </>
            )}

            <h3 className="mt-5 text-[12px] font-semibold text-ink">2. Start a new session and ask</h3>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
              Agent apps read their tools when a session starts, so open a new one after adding the editor. Keep the editor open while the agent
              works. Then just ask: “{EXAMPLE_PROMPT}”.
            </p>

            <h3 className="mt-5 text-[12px] font-semibold text-ink">Server</h3>
            <dl className="mt-1.5 grid grid-cols-[4.5rem_1fr_auto] items-center gap-x-2 gap-y-1 text-[11px]">
              <dt className="text-muted">URL</dt>
              <dd className="truncate font-mono text-ink">{status.url}</dd>
              <CopyButton text={status.url} label="Copy the URL" />
              <dt className="text-muted">Token</dt>
              <dd className="flex min-w-0 items-center gap-1 font-mono text-ink">
                <span className="truncate">{showToken ? status.token : '•'.repeat(12)}</span>
                <button
                  type="button"
                  aria-label={showToken ? 'Hide the token' : 'Show the token'}
                  onClick={() => setShowToken(!showToken)}
                  className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-ink"
                >
                  {showToken ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </dd>
              <CopyButton text={status.token} label="Copy the token" />
              <dt className="text-muted">stdio</dt>
              <dd className="truncate font-mono text-ink" title={status.shimPath}>
                node {status.shimPath}
              </dd>
              <CopyButton text={`node "${status.shimPath}"`} label="Copy the stdio command" />
            </dl>
            <p className="mt-2 text-[11px] leading-relaxed text-muted">
              Only this computer can reach the server, and only with the token. The stdio server reads both from {status.connectionFile} each time it starts, so it keeps working when the editor
              takes another port (7428 busy).
            </p>
          </>
        )}
      </div>
    </div>
  )
}
