import { useEffect, useState } from 'react'
import type { RecordingSource } from '../../../shared/recording'
import { CircleDot, LoaderCircle, X } from '../icons'
import { closeRecordDialog, startRecording, useRecorder } from '../recording/recorder'

// The record dialog: pick a screen or window, choose sound and webcam, press
// Record. The main process does the capturing; the finished clip is imported by
// `recording/recorder.ts`.

const TOGGLES_KEY = 'uve.recordToggles'
interface Toggles {
  systemAudio: boolean
  microphone: boolean
  webcam: boolean
  autoZoom: boolean
}
const DEFAULT_TOGGLES: Toggles = { systemAudio: true, microphone: false, webcam: false, autoZoom: true }

function loadToggles(): Toggles {
  try {
    const raw = JSON.parse(localStorage.getItem(TOGGLES_KEY) ?? 'null') as Partial<Toggles> | null
    return { ...DEFAULT_TOGGLES, ...(raw ?? {}) }
  } catch {
    return DEFAULT_TOGGLES
  }
}

function Switch({ label, on, onToggle }: { label: string; on: boolean; onToggle: () => void }) {
  return (
    <div className="flex items-center gap-3">
      <span className="min-w-0 flex-1 text-xs">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={onToggle}
        className={`flex h-5 w-9 items-center rounded-full px-0.5 ${on ? 'active-tint justify-end' : 'bg-field justify-start text-muted'}`}
      >
        <span className="size-4 rounded-full bg-current" />
      </button>
    </div>
  )
}

function RecordForm() {
  const [sources, setSources] = useState<RecordingSource[] | null>(null)
  const [pickedId, setPickedId] = useState<string | null>(null)
  const [toggles, setToggles] = useState<Toggles>(loadToggles)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<{ error: string; hint?: string } | null>(null)

  useEffect(() => {
    let live = true
    window.uve.recorder
      .sources()
      .then((list) => {
        if (!live) return
        const ordered = [...list.filter((s) => s.kind === 'display').sort((a, b) => Number(b.primary) - Number(a.primary)), ...list.filter((s) => s.kind === 'window')]
        setSources(ordered)
        setPickedId(ordered[0]?.id ?? null)
      })
      .catch((e: unknown) => {
        if (!live) return
        setSources([])
        setProblem({ error: `Could not list the screens: ${e instanceof Error ? e.message : String(e)}` })
      })
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRecordDialog()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const toggle = (key: keyof Toggles) => {
    const next = { ...toggles, [key]: !toggles[key] }
    setToggles(next)
    try {
      localStorage.setItem(TOGGLES_KEY, JSON.stringify(next))
    } catch {
      // Remembering the choice is a convenience only.
    }
  }

  const submit = async (e: { preventDefault: () => void }) => {
    e.preventDefault()
    if (!pickedId || busy) return
    setBusy(true)
    setProblem(null)
    const { autoZoom, ...capture } = toggles
    const result = await startRecording({ sourceId: pickedId, ...capture }, undefined, { autoZoom })
    setBusy(false)
    if (result.ok) closeRecordDialog()
    else setProblem({ error: result.error, hint: result.hint })
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50">
      <div role="dialog" aria-modal="true" aria-labelledby="record-title" className="flex max-h-[90vh] w-[34rem] flex-col rounded-lg border border-line bg-panel shadow-2xl">
        <div className="flex items-start gap-2 p-4 pb-3">
          <CircleDot size={16} className="mt-0.5 text-danger" aria-hidden />
          <div className="min-w-0 flex-1">
            <h2 id="record-title" className="font-semibold">
              Record screen
            </h2>
            <p className="mt-0.5 text-xs text-muted">The editor minimises while a whole screen records and comes back when you stop.</p>
          </div>
          <button type="button" onClick={closeRecordDialog} aria-label="Close" title="Close (Esc)" className="rounded p-1 text-muted hover:bg-hover hover:text-ink">
            <X size={15} aria-hidden />
          </button>
        </div>

        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-2">
            <div>
              <span className="text-[11px] text-muted">What to record</span>
              {sources === null ? (
                <p className="mt-2 flex items-center gap-2 text-xs text-muted">
                  <LoaderCircle size={14} className="animate-spin" aria-hidden /> Looking for screens and windows
                </p>
              ) : sources.length === 0 ? (
                <p className="mt-2 text-xs text-muted">No screen or window was found.</p>
              ) : (
                <div role="radiogroup" aria-label="Source" className="mt-1.5 grid grid-cols-3 gap-2">
                  {sources.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      role="radio"
                      aria-checked={pickedId === s.id}
                      onClick={() => setPickedId(s.id)}
                      title={s.name}
                      className={`flex min-w-0 flex-col gap-1 rounded-lg p-1.5 text-left text-[11px] ${pickedId === s.id ? 'active-tint' : 'bg-field text-muted hover:bg-hover hover:text-ink'}`}
                    >
                      <span className="flex aspect-video w-full items-center justify-center overflow-hidden rounded bg-hover">
                        {s.thumbnail && <img src={s.thumbnail} alt="" className="size-full object-contain" />}
                      </span>
                      <span className="truncate">{s.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Switch label="Computer sound" on={toggles.systemAudio} onToggle={() => toggle('systemAudio')} />
              <Switch label="Microphone" on={toggles.microphone} onToggle={() => toggle('microphone')} />
              <Switch label="Webcam" on={toggles.webcam} onToggle={() => toggle('webcam')} />
              <Switch label="Zoom on clicks" on={toggles.autoZoom} onToggle={() => toggle('autoZoom')} />
            </div>
          </div>

          <div className="space-y-2 p-4 pt-3">
            {problem && (
              <div role="alert" className="rounded-lg bg-danger/10 px-2.5 py-2 text-xs text-danger">
                <p>{problem.error}</p>
                {problem.hint && <p className="mt-1">{problem.hint}</p>}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={closeRecordDialog} className="rounded bg-field px-3 py-2 text-xs hover:bg-hover">
                Cancel
              </button>
              <button
                type="submit"
                disabled={!pickedId || busy}
                className="rounded bg-accent px-3 py-2 text-xs font-medium text-accent-ink hover:bg-accent/85 disabled:opacity-50"
              >
                {busy ? 'Starting…' : 'Record'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}

/** The record dialog; its form starts afresh each time it opens. */
export function RecordDialog() {
  const open = useRecorder((s) => s.dialogOpen)
  return open ? <RecordForm /> : null
}
