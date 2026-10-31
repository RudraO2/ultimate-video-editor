import { Eraser, FilePlus2, Play, Square, Trash2 } from 'lucide-react'
import { type KeyboardEvent, useEffect, useReducer, useRef, useState } from 'react'
import { activeComp, session, useEditor } from '../store'

// The Scripts tab: saved JavaScript files that build the comp through the same commands an agent calls.

interface OutLine {
  level: 'log' | 'info' | 'debug' | 'warn' | 'error'
  text: string
}

/** What the output pane shows after a run ends. */
interface Finished {
  path: string
  lines: OutLine[]
  ok: boolean
  value?: unknown
  made?: number
  error?: string
  hint?: string
}

const STARTER = "// Build in here: ${here.name}\nconst { id } = await ac.layer.create({ kind: 'text', text: 'Hello' })\nreturn id\n"

const TINT: Record<OutLine['level'], string> = {
  log: 'text-ink',
  info: 'text-muted',
  debug: 'text-muted',
  warn: 'text-warn',
  error: 'text-danger',
}

function shown(value: unknown): string {
  let text: string
  try {
    text = JSON.stringify(value, null, 2) ?? 'undefined'
  } catch {
    text = String(value)
  }
  return text.length > 2000 ? `${text.slice(0, 2000)}\n… (cut)` : text
}

function linesOf(logs: readonly { level: OutLine['level']; line?: number; text: string }[]): OutLine[] {
  return logs.map((l) => ({ level: l.level, text: `${l.line ? `${l.line}: ` : ''}${l.text}` }))
}

const iconButton =
  'flex size-7 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent'

export function ScriptsPanel() {
  const scripts = useEditor((s) => s.project.scripts)
  const compName = useEditor((s) => activeComp(s).name)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // null = the editor shows the saved source; a string = unsaved edits.
  const [draft, setDraft] = useState<string | null>(null)
  const [finished, setFinished] = useState<Finished | null>(null)
  const [, tick] = useReducer((n: number) => n + 1, 0)
  const area = useRef<HTMLTextAreaElement>(null)
  const outEnd = useRef<HTMLDivElement>(null)

  // Live runs mutate their records in place, so repaint on every change.
  useEffect(() => session.scripts.subscribe(tick), [])

  const selected = scripts.find((s) => s.id === selectedId) ?? scripts[0]
  const active = session.scripts.active
  const text = draft ?? selected?.source ?? ''

  useEffect(() => {
    outEnd.current?.scrollIntoView({ block: 'end' })
  })

  const select = (id: string | null) => {
    setSelectedId(id)
    setDraft(null)
    setFinished(null)
  }

  /** Writes unsaved edits to the project; false when the save failed. */
  const save = async (): Promise<boolean> => {
    if (!selected || draft === null || draft === selected.source) return true
    const result = await session.call('script.save', { path: selected.path, source: draft }, { label: `Save ${selected.path}` })
    if (!result.ok) {
      setFinished({ path: selected.path, lines: [], ok: false, error: result.error, ...(result.hint ? { hint: result.hint } : {}) })
      return false
    }
    setDraft(null)
    return true
  }

  const create = async () => {
    const taken = new Set(scripts.map((s) => s.path))
    let path = 'untitled.js'
    for (let n = 2; taken.has(path); n++) path = `untitled-${n}.js`
    const result = await session.call('script.save', { path, source: STARTER }, { label: 'New script' })
    if (result.ok) select((result.value as { id: string }).id)
  }

  const remove = async () => {
    if (!selected) return
    const result = await session.call('script.remove', { script: selected.id }, { label: `Delete ${selected.path}` })
    if (result.ok) select(null)
  }

  const setOnRun = async (onRun: 'replace' | 'append') => {
    if (!selected) return
    await session.call('script.save', { path: selected.path, source: text, onRun }, { label: `Set ${selected.path} re-run mode` })
    setDraft(null)
  }

  const run = async () => {
    if (!selected || session.scripts.active) return
    if (!(await save())) return
    const path = selected.path
    const startedAt = Date.now()
    setFinished(null)
    const result = await session.call(
      'script.run',
      { script: path, compId: activeComp(useEditor.getState()).id },
      { label: `Run ${path}` },
    )
    const record = session.scripts.list().findLast((r) => r.file === path && r.startedAt >= startedAt)
    const lines = record ? linesOf(record.logs) : []
    if (result.ok) {
      const v = result.value as { value?: unknown; created?: { layers?: number }; logs?: string[] }
      setFinished({
        path,
        lines: record ? lines : (v.logs ?? []).map((t) => ({ level: 'log' as const, text: t })),
        ok: true,
        value: v.value,
        made: v.created?.layers ?? 0,
      })
    } else {
      setFinished({ path, lines, ok: false, error: result.error, ...(result.hint ? { hint: result.hint } : {}) })
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      void run()
    } else if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault()
      const el = e.currentTarget
      const { selectionStart: a, selectionEnd: b } = el
      setDraft(`${text.slice(0, a)}  ${text.slice(b)}`)
      requestAnimationFrame(() => area.current?.setSelectionRange(a + 2, a + 2))
    }
  }

  if (scripts.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <Header onNew={create} />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-[12px] font-semibold">No scripts yet</p>
          <p className="text-[11px] text-muted">A script builds layers with code: loops, grids, whole scenes in one run.</p>
          <button type="button" onClick={() => void create()} className="rounded-lg bg-accent/35 px-3 py-1.5 text-[11px] font-semibold text-accent hover:bg-accent/50">
            New script
          </button>
        </div>
      </div>
    )
  }

  const liveLines = active ? linesOf(active.logs) : null
  const lines = liveLines ?? finished?.lines ?? []

  return (
    <div className="flex h-full flex-col">
      <Header onNew={create} />
      <div className="max-h-28 shrink-0 space-y-0.5 overflow-y-auto px-3 pb-2">
        {scripts.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => select(s.id)}
            aria-pressed={s.id === selected?.id}
            className={`flex w-full items-center rounded-lg px-2 py-1 text-left text-[11px] ${s.id === selected?.id ? 'active-tint' : 'hover:bg-hover'}`}
          >
            <span className="min-w-0 flex-1 truncate">{s.path}</span>
          </button>
        ))}
      </div>

      {selected && (
        <>
          <div className="flex shrink-0 items-center gap-1 px-3 pb-1.5">
            <button
              type="button"
              onClick={() => void run()}
              disabled={!!active}
              title="Run (Ctrl+Enter)"
              className="flex h-7 items-center gap-1 rounded-lg bg-accent/35 px-2.5 text-[11px] font-semibold text-accent hover:bg-accent/50 disabled:opacity-40"
            >
              <Play size={12} aria-hidden /> Run
            </button>
            <button
              type="button"
              onClick={() => active && session.scripts.stop(active.id)}
              disabled={!active}
              aria-label="Stop"
              title="Stop the run; nothing it did is kept"
              className={iconButton}
            >
              <Square size={13} aria-hidden />
            </button>
            <span className="min-w-0 flex-1 truncate text-right text-[11px] text-muted" title={selected.path}>
              {selected.path}
            </span>
            <button type="button" onClick={() => void remove()} aria-label="Delete script" title={`Delete ${selected.path}`} className={iconButton}>
              <Trash2 size={13} aria-hidden />
            </button>
          </div>
          <div className="flex shrink-0 items-center gap-2 px-3 pb-1.5">
            <label className="shrink-0 text-[11px] text-muted" htmlFor="script-on-run">
              When run again
            </label>
            <select
              id="script-on-run"
              value={selected.onRun}
              onChange={(e) => void setOnRun(e.target.value as 'replace' | 'append')}
              className="h-7 min-w-0 flex-1 rounded-lg bg-field px-1.5 text-[11px] text-ink outline-none focus:ring-1 focus:ring-accent"
            >
              <option value="replace">Replace what it made</option>
              <option value="append">Add to it</option>
            </select>
          </div>
          <textarea
            ref={area}
            value={text}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void save()}
            onKeyDown={onKeyDown}
            spellCheck={false}
            aria-label={`Source of ${selected.path}`}
            className="mx-3 min-h-24 flex-[3] resize-none rounded-lg bg-field p-2 font-mono text-[11px] leading-snug whitespace-pre text-ink outline-none focus:ring-1 focus:ring-accent"
          />
          <p className="shrink-0 px-3 pt-1 text-[11px] text-muted">Runs in “{compName}”</p>
        </>
      )}

      <div className="mt-1 flex shrink-0 items-center px-3">
        <p className="flex-1 text-[10px] font-semibold tracking-wide text-muted uppercase">Output</p>
        <button
          type="button"
          onClick={() => setFinished(null)}
          disabled={!!active || !finished}
          aria-label="Clear output"
          title="Clear output"
          className={iconButton}
        >
          <Eraser size={13} aria-hidden />
        </button>
      </div>
      <div className="mx-3 mb-3 min-h-16 flex-[2] overflow-y-auto rounded-lg bg-field p-2 font-mono text-[11px] leading-snug" aria-live="polite">
        {active && (
          <p className="text-muted">
            Running{active.awaiting ? ` ${active.awaiting}` : ''}… {active.calls} calls
          </p>
        )}
        {lines.map((l, i) => (
          <p key={i} className={`break-words whitespace-pre-wrap ${TINT[l.level]}`}>
            {l.text}
          </p>
        ))}
        {!active && finished?.ok && (
          <>
            {finished.value !== undefined && <pre className="mt-1 break-words whitespace-pre-wrap text-ink">{shown(finished.value)}</pre>}
            <p className="mt-1 text-muted">
              Made {finished.made} layer{finished.made === 1 ? '' : 's'}
            </p>
          </>
        )}
        {!active && finished && !finished.ok && (
          <div className="mt-1 text-danger">
            <p className="break-words whitespace-pre-wrap">{finished.error}</p>
            {finished.hint && <p className="mt-1 break-words whitespace-pre-wrap text-muted">{finished.hint}</p>}
          </div>
        )}
        {!active && !finished && lines.length === 0 && <p className="text-muted">Run a script to see its logs and result here.</p>}
        <div ref={outEnd} />
      </div>
    </div>
  )
}

function Header({ onNew }: { onNew: () => Promise<void> }) {
  return (
    <div className="flex shrink-0 items-center px-3 pt-3 pb-2">
      <h2 className="flex-1 text-[12px] font-semibold">Scripts</h2>
      <button type="button" onClick={() => void onNew()} aria-label="New script" title="New script" className={iconButton}>
        <FilePlus2 size={15} aria-hidden />
      </button>
    </div>
  )
}
