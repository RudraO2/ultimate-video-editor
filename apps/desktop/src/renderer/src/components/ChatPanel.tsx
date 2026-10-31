import {
  ArrowUp,
  Brain,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDot,
  LoaderCircle,
  Mic,
  MicOff,
  SlidersHorizontal,
  Square,
  SquarePen,
} from '../icons'
import { Fragment, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { editorContext } from '../agent/chatContext'
import { type MicRecording, startRecording } from '../agent/micRecorder'
import { encodeWav } from '../agent/voiceCommands'
import { type ChatItem, type OpenCodeStatus, toolLabel } from '../../../shared/opencode'
import { useEditor } from '../store'

// The OpenCode chat of the Agents tab: OpenCode runs inside the app and drives
// the editor with its own tools. Transcript on top, options folded under the
// header, composer at the bottom.

const EXAMPLES = [
  'Cut the pauses and ums from my clip, then add the screen recording as B-roll',
  "Make a 6-second title card for 'Ship Happens' with a whoosh",
  'Add captions to the selected clip',
  'Turn this comp into a 3D shot',
]

/** Longest the composer grows, about eight lines. */
const COMPOSER_MAX_PX = 8 * 18

/** `**bold**` and `code` in a line of agent text; everything else stays as written. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g).map((part, i) => {
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={i} className="rounded bg-field px-1 font-mono text-[11px]">
          {part.slice(1, -1)}
        </code>
      )
    }
    return <Fragment key={i}>{part}</Fragment>
  })
}

const pretty = (value: unknown): string => {
  if (value === undefined) return ''
  try {
    return JSON.stringify(value, null, 2) ?? ''
  } catch {
    return String(value)
  }
}

function ThoughtRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-6 items-center gap-1.5 rounded-lg px-1.5 text-[11px] text-muted italic hover:bg-hover hover:text-ink"
      >
        <Brain size={12} aria-hidden />
        Thinking
        <ChevronRight size={11} aria-hidden className={open ? 'rotate-90' : ''} />
      </button>
      {open && <p className="px-1.5 pb-1 text-[11px] leading-relaxed whitespace-pre-wrap text-muted italic select-text">{text}</p>}
    </div>
  )
}

function ToolRow({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false)
  const input = pretty(item.input)
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-7 w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-hover"
      >
        {item.status === 'completed' ? (
          <CircleCheck size={12} className="shrink-0 text-ok" aria-label="Done" />
        ) : item.status === 'failed' ? (
          <CircleAlert size={12} className="shrink-0 text-accent" aria-label="Failed" />
        ) : (
          <LoaderCircle size={12} className="shrink-0 animate-spin text-muted" aria-label="Running" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink">{toolLabel(item.title)}</span>
        <ChevronRight size={11} aria-hidden className={`shrink-0 text-muted ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="space-y-1 px-2 pb-1.5">
          {input && <pre className="max-h-48 overflow-auto rounded-lg bg-field px-2 py-1.5 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap break-words text-ink select-text">{input}</pre>}
          {item.output && <pre className="max-h-48 overflow-auto rounded-lg bg-field px-2 py-1.5 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap break-words text-muted select-text">{item.output}</pre>}
          {!input && !item.output && <p className="text-[10px] text-muted">No details.</p>}
        </div>
      )}
    </div>
  )
}

function PlanCard({ item }: { item: Extract<ChatItem, { kind: 'plan' }> }) {
  return (
    <ul className="space-y-1 rounded-lg border border-line px-2.5 py-2">
      {item.entries.map((entry, i) => (
        <li key={i} className="flex items-start gap-2 text-[11px] leading-snug">
          {entry.status === 'completed' ? (
            <CircleCheck size={12} className="mt-px shrink-0 text-ok" aria-label="Done" />
          ) : entry.status === 'in_progress' ? (
            <CircleDot size={12} className="mt-px shrink-0 text-accent" aria-label="In progress" />
          ) : (
            <Circle size={12} className="mt-px shrink-0 text-muted" aria-label="Pending" />
          )}
          <span className={entry.status === 'completed' ? 'text-muted' : 'text-ink'}>{entry.content}</span>
        </li>
      ))}
    </ul>
  )
}

function PermissionCard({ item }: { item: Extract<ChatItem, { kind: 'permission' }> }) {
  const input = pretty(item.input)
  const chosen = item.options.find((option) => option.optionId === item.answer)
  return (
    <div className="space-y-2 rounded-lg border border-accent/40 px-2.5 py-2">
      <p className="text-[11px] text-ink">
        OpenCode asks to run <span className="font-mono">{toolLabel(item.title)}</span>
      </p>
      {input && <pre className="max-h-32 overflow-auto rounded-lg bg-field px-2 py-1.5 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap break-words text-muted select-text">{input}</pre>}
      {item.done ? (
        <p className="text-[10px] text-muted">{chosen ? chosen.name : 'Refused'}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {item.options.map((option) => (
            <button
              key={option.optionId}
              type="button"
              onClick={() => window.uve.opencode.answer(item.id, option.optionId)}
              className={`h-7 rounded-lg border px-2.5 text-[11px] ${
                option.kind.startsWith('allow') ? 'active-tint border-accent/40' : 'border-line text-muted hover:bg-hover hover:text-ink'
              }`}
            >
              {option.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function Item({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="flex justify-end pt-1">
          <div className="max-w-[85%] rounded-lg bg-field px-2.5 py-1.5 text-[12px] leading-relaxed whitespace-pre-wrap break-words text-ink select-text">{item.text}</div>
        </div>
      )
    case 'agent':
      return <p className="px-1 py-0.5 text-[12px] leading-relaxed whitespace-pre-wrap break-words text-ink select-text">{inline(item.text)}</p>
    case 'thought':
      return <ThoughtRow text={item.text} />
    case 'tool':
      return <ToolRow item={item} />
    case 'plan':
      return <PlanCard item={item} />
    case 'permission':
      return <PermissionCard item={item} />
    case 'error':
      return (
        <p className="flex items-start gap-1.5 px-1 text-[11px] leading-relaxed text-accent select-text">
          <CircleAlert size={13} className="mt-px shrink-0" aria-hidden />
          {item.text}
        </p>
      )
    case 'end':
      return (
        <div className="flex items-center gap-2 px-1 py-1">
          <div className="h-px flex-1 bg-line" />
          {item.stopReason !== 'end_turn' && <span className="text-[10px] text-muted">{item.stopReason === 'cancelled' ? 'Stopped' : item.stopReason}</span>}
          {item.stopReason !== 'end_turn' && <div className="h-px flex-1 bg-line" />}
        </div>
      )
  }
}

/** Tool rows sit tight together; everything else gets some air. */
const gapBefore = (items: ChatItem[], i: number) => (i > 0 && items[i]?.kind === 'tool' && items[i - 1]?.kind === 'tool' ? '' : 'mt-2')

function Options({ status }: { status: OpenCodeStatus }) {
  const [key, setKey] = useState('')
  const bridge = window.uve.opencode
  const select = 'h-8 w-full rounded-lg border border-line bg-field px-2 text-[11px] text-ink outline-none focus:border-accent/60'
  return (
    <div className="space-y-2.5 border-b border-line px-4 pb-3">
      <label className="block space-y-1">
        <span className="text-[10px] text-muted">Model</span>
        <select
          value={status.model ?? ''}
          disabled={status.models.length === 0}
          onChange={(e) => void bridge.setOption('model', e.target.value).catch(() => {})}
          className={select}
        >
          {status.model && !status.models.some((m) => m.value === status.model) && <option value={status.model}>{status.model}</option>}
          {status.models.map((m) => (
            <option key={m.value} value={m.value}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      {status.efforts.length > 0 && (
        <label className="block space-y-1">
          <span className="text-[10px] text-muted">Effort</span>
          <select value={status.effort ?? ''} onChange={(e) => void bridge.setOption('effort', e.target.value).catch(() => {})} className={select}>
            {status.efforts.map((m) => (
              <option key={m.value} value={m.value}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="space-y-1">
        <span className="text-[10px] text-muted">Provider key</span>
        {status.hasKey ? (
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[11px] text-ink">Key saved ··· {status.keyHint}</span>
            <button type="button" onClick={() => void bridge.setKey(null).catch(() => {})} className="h-7 rounded-lg border border-line px-2.5 text-[11px] text-muted hover:bg-hover hover:text-ink">
              Forget
            </button>
          </div>
        ) : (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault()
              if (!key.trim()) return
              void bridge.setKey(key.trim()).catch(() => {})
              setKey('')
            }}
          >
            <input
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="Paste a key"
              aria-label="Provider key"
              className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-field px-2 text-[11px] text-ink outline-none placeholder:text-muted focus:border-accent/60"
            />
            <button type="submit" disabled={!key.trim()} className="active-tint h-8 rounded-lg border border-accent/40 px-3 text-[11px] disabled:opacity-40">
              Save
            </button>
          </form>
        )}
        <p className="text-[10px] leading-relaxed text-muted">The key is kept encrypted on this computer. Without one, OpenCode uses its own login.</p>
      </div>
      {(status.version || status.path) && (
        <p className="font-mono text-[10px] leading-relaxed break-all text-muted">
          {status.version && <span>{status.version}</span>}
          {status.version && status.path && <br />}
          {status.path}
        </p>
      )}
      {status.usage && (
        <p className="text-[10px] text-muted">
          {status.usage.used}/{status.usage.size} tokens · ${status.usage.cost.toFixed(4)}
        </p>
      )}
    </div>
  )
}

function Banner({ status }: { status: OpenCodeStatus }) {
  const bridge = window.uve.opencode
  const button = 'h-7 shrink-0 rounded-lg border border-accent/40 px-2.5 text-[11px] active-tint'
  if (status.state === 'missing') {
    return (
      <div className="mx-4 mb-2 flex items-center gap-2 rounded-lg bg-field px-3 py-2">
        <p className="min-w-0 flex-1 text-[11px] text-muted">OpenCode is not installed.</p>
        <button type="button" onClick={() => void bridge.install().catch(() => {})} className={button}>
          Install
        </button>
      </div>
    )
  }
  if (status.state === 'installing' || status.state === 'starting') {
    return (
      <p className="mx-4 mb-2 flex items-center gap-2 rounded-lg bg-field px-3 py-2 text-[11px] text-muted">
        <LoaderCircle size={13} className="animate-spin" aria-hidden />
        {status.state === 'installing' ? 'Installing OpenCode…' : 'Starting OpenCode…'}
      </p>
    )
  }
  if (status.state === 'stopped' || status.state === 'error') {
    return (
      <div className="mx-4 mb-2 flex items-center gap-2 rounded-lg bg-field px-3 py-2">
        <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-accent select-text">{status.error ?? <span className="text-muted">OpenCode is stopped.</span>}</p>
        <button type="button" onClick={() => void bridge.start().catch(() => {})} className={button}>
          Start
        </button>
      </div>
    )
  }
  return null
}

function Transcript({ items, onPick }: { items: ChatItem[]; onPick: (text: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  // Follow new text unless the person scrolled up to read.
  const stuck = useRef(true)
  useLayoutEffect(() => {
    const el = ref.current
    if (el && stuck.current) el.scrollTop = el.scrollHeight
  }, [items])
  return (
    <div
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget
        stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      }}
      className="min-h-0 flex-1 overflow-y-auto px-3 pb-2"
    >
      {items.length === 0 ? (
        <div className="px-3 pt-8 text-center">
          <p className="text-[11px] leading-relaxed text-muted">Ask for a video. OpenCode works in this project with the editor's tools and skill.</p>
          <div className="mt-3 flex flex-col items-stretch gap-1.5">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => onPick(example)}
                className="rounded-lg border border-line px-2.5 py-1.5 text-left text-[11px] leading-snug text-muted hover:bg-hover hover:text-ink"
              >
                {example}
              </button>
            ))}
          </div>
        </div>
      ) : (
        items.map((item, i) => (
          <div key={item.id} className={gapBefore(items, i)}>
            <Item item={item} />
          </div>
        ))
      )}
    </div>
  )
}

/** Sarvam's and the microphone's errors, without Electron's "Error invoking remote method" wrapper. */
const plainError = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

type MicState = 'idle' | 'recording' | 'transcribing'

/**
 * Speaking to the chat: record from the microphone, write it down with Sarvam
 * (any language), then hand the words to `onText`. Problems show as a notice.
 */
function useMic(onText: (text: string) => void) {
  const [state, setState] = useState<MicState>('idle')
  const [seconds, setSeconds] = useState(0)
  const recording = useRef<MicRecording | null>(null)
  const latest = useRef(onText)
  latest.current = onText

  // A tab closed mid-recording must not leave the microphone on.
  useEffect(() => () => recording.current?.cancel(), [])

  // The clock the button shows.
  useEffect(() => {
    if (state !== 'recording') return
    setSeconds(0)
    const from = Date.now()
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - from) / 1000)), 250)
    return () => clearInterval(timer)
  }, [state])

  const finish = useCallback(async () => {
    const current = recording.current
    if (!current) return
    recording.current = null
    setState('transcribing')
    const { notify } = useEditor.getState()
    try {
      const samples = await current.stop()
      // Under a third of a second is a mis-click, not speech.
      if (samples.length < 5000) {
        notify('Nothing was heard. Click the microphone, speak, then click it again.')
        return
      }
      const answer = await window.uve.sarvam.stt({ wav: encodeWav(samples, 16000), mode: 'codemix' })
      const text = answer.transcript.trim()
      if (text) latest.current(text)
      else notify('Nothing was heard. Click the microphone, speak, then click it again.')
    } catch (error) {
      notify(`Could not write down what you said: ${plainError(error)}`, 'error')
    } finally {
      setState('idle')
    }
  }, [])

  const toggle = useCallback(async () => {
    if (state === 'recording') {
      void finish()
      return
    }
    if (state !== 'idle') return
    const { notify } = useEditor.getState()
    try {
      const sarvam = await window.uve.sarvam.status()
      if (!sarvam.hasKey) {
        notify('Speaking to the chat needs a Sarvam key: add it in the Voice tab.', 'error')
        return
      }
      recording.current = await startRecording(() => void finish())
      setState('recording')
    } catch (error) {
      const denied = error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'NotFoundError')
      notify(denied ? 'The microphone is not available. Plug one in or allow it in Windows settings, then try again.' : `Could not start the microphone: ${plainError(error)}`, 'error')
    }
  }, [state, finish])

  return { state, seconds, toggle }
}

/** The OpenCode chat. */
export function ChatPanel() {
  const status = useEditor((s) => s.opencodeStatus)
  const chat = useEditor((s) => s.chat)
  const [options, setOptions] = useState(false)
  const [draft, setDraft] = useState('')
  const area = useRef<HTMLTextAreaElement>(null)
  const bridge = window.uve.opencode as typeof window.uve.opencode | undefined

  // Start OpenCode once when the tab opens, if it is only stopped.
  const autoStarted = useRef(false)
  useEffect(() => {
    if (autoStarted.current || !bridge || status.state !== 'stopped') return
    autoStarted.current = true
    void bridge.start().catch(() => {})
  }, [bridge, status.state])

  // The composer grows with its text, up to about eight lines.
  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_PX)}px`
  }, [draft])

  const usable = status.state === 'ready' || status.state === 'stopped'
  const send = async (words = draft) => {
    const text = words.trim()
    if (!text || !bridge || !usable) return
    setDraft('')
    try {
      if (status.state === 'stopped') await bridge.start()
      // The editor's context rides along with every message: where the playhead is and what is selected.
      await bridge.prompt(text, editorContext(useEditor.getState()))
    } catch {
      // The error event shows the failure in the transcript.
    }
  }
  // Spoken words are sent at once when OpenCode can take them; otherwise they wait in the composer.
  const mic = useMic((text) => {
    if (usable && !status.busy) void send(text)
    else {
      setDraft((d) => (d.trim() ? `${d.trimEnd()} ${text}` : text))
      area.current?.focus()
    }
  })

  if (!bridge) {
    return <p className="px-6 pt-8 text-center text-[11px] leading-relaxed text-muted">The OpenCode chat needs a newer app build. Restart the editor.</p>
  }

  const canSend = usable && draft.trim() !== ''
  const modelName = status.models.find((m) => m.value === status.model)?.name ?? status.model

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between pr-2 pl-4">
        <h2 className="text-[11px] font-semibold tracking-wider text-muted uppercase">OpenCode</h2>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label="New chat"
            title="New chat"
            onClick={() => void bridge.newChat().catch(() => {})}
            className="flex size-7 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-ink"
          >
            <SquarePen size={14} />
          </button>
          <button
            type="button"
            aria-label="Options"
            title="Options"
            aria-pressed={options}
            onClick={() => setOptions(!options)}
            className={`flex size-7 items-center justify-center rounded-lg ${options ? 'active-tint' : 'text-muted hover:bg-hover hover:text-ink'}`}
          >
            <SlidersHorizontal size={14} />
          </button>
        </div>
      </div>
      {options && <Options status={status} />}
      <Banner status={status} />
      <Transcript items={chat} onPick={(text) => {
        setDraft(text)
        area.current?.focus()
      }} />
      <div className="shrink-0 px-3 pb-2">
        <div className="flex items-end gap-1.5 rounded-lg border border-line bg-field py-1.5 pr-1.5 pl-2.5 focus-within:border-accent/60">
          <textarea
            ref={area}
            rows={1}
            value={draft}
            placeholder="Ask OpenCode…"
            aria-label="Ask OpenCode"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                if (!status.busy) void send()
              }
            }}
            className="min-w-0 flex-1 resize-none bg-transparent py-1 text-[12px] leading-[18px] text-ink outline-none placeholder:text-muted"
          />
          <button
            type="button"
            aria-label={mic.state === 'recording' ? 'Stop and send' : mic.state === 'transcribing' ? 'Transcribing' : 'Speak'}
            title={mic.state === 'recording' ? 'Stop and send' : mic.state === 'transcribing' ? 'Transcribing…' : 'Speak in any language'}
            aria-pressed={mic.state === 'recording'}
            disabled={status.busy || mic.state === 'transcribing'}
            onClick={() => void mic.toggle()}
            className={`flex h-7 shrink-0 items-center justify-center gap-1 rounded-full disabled:opacity-40 ${
              mic.state === 'recording' ? 'active-tint min-w-7 px-2' : mic.state === 'transcribing' ? 'size-7 text-muted' : 'size-7 text-muted hover:bg-hover hover:text-ink'
            }`}
          >
            {mic.state === 'recording' ? (
              <>
                <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" aria-hidden />
                <span className="text-[11px] tabular-nums">{mic.seconds}s</span>
              </>
            ) : mic.state === 'transcribing' ? (
              <LoaderCircle size={14} className="animate-spin" aria-hidden />
            ) : status.busy ? (
              <MicOff size={14} aria-hidden />
            ) : (
              <Mic size={14} aria-hidden />
            )}
          </button>
          {status.busy ? (
            <button
              type="button"
              aria-label="Stop"
              title="Stop"
              onClick={() => void bridge.cancel().catch(() => {})}
              className="active-tint flex size-7 shrink-0 items-center justify-center rounded-full"
            >
              <Square size={11} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              aria-label="Send"
              title="Send"
              disabled={!canSend}
              onClick={() => void send()}
              className="active-tint flex size-7 shrink-0 items-center justify-center rounded-full disabled:opacity-40"
            >
              <ArrowUp size={14} />
            </button>
          )}
        </div>
        {modelName && <p className="mt-1 truncate px-1 text-[10px] text-muted">{modelName}</p>}
      </div>
    </div>
  )
}
