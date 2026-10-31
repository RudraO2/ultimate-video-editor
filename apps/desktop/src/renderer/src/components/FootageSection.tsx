import type { Layer } from '@uve/core'
import { ScanSearch, Scissors } from '../icons'
import { useState } from 'react'
import { run, useEditor } from '../store'
import { Section } from './inspectorParts'

// The by-hand controls of footage: read it once (words, speech, shots), mark
// where a tighter cut would go, and cut. Each is a command (media.analyze,
// media.remove_pauses), so each is one undo step. run() already toasts failures.

type Tightness = 'generous' | 'balanced' | 'tight'

const TIGHTNESS: { value: Tightness; label: string; hint: string }[] = [
  { value: 'generous', label: 'Generous', hint: 'Long pauses, ums and false starts only' },
  { value: 'balanced', label: 'Balanced', hint: 'Also fillers like "basically" next to a pause' },
  { value: 'tight', label: 'Tight', hint: 'Every filler and short pauses' },
]

const addButton = 'flex h-10 w-full items-center justify-center gap-1.5 rounded-panel border border-dashed border-line text-[12px] text-muted hover:bg-hover hover:text-ink'
const pickButton = 'h-7 min-w-0 truncate rounded-lg px-2.5 text-[11px]'
const MAX_REASONS = 5

type Cut = { reason: string }
type Plan = { cuts: Cut[]; removedMs: number }

const seconds = (ms: number) => (ms / 1000).toFixed(1)

/** Raw footage: analyse it, mark the cuts a tighter edit would make, and cut. */
export function FootageSection({ layer }: { layer: Extract<Layer, { kind: 'video' | 'audio' }> }) {
  const media = useEditor((s) => s.project.media.find((m) => m.id === layer.mediaId))
  const [tightness, setTightness] = useState<Tightness>('generous')
  const [variant, setVariant] = useState(false)
  const [notes, setNotes] = useState<string[]>([])
  const [busy, setBusy] = useState<'analyse' | 'mark' | 'cut' | null>(null)
  if (!media) return null
  const footage = media.footage
  const words = media.speech?.words.length ?? 0
  const analysed = footage !== undefined || media.speech !== undefined

  let status = 'Not analysed yet'
  if (analysed) {
    const parts: string[] = []
    if (words > 0) parts.push(`${words} words`)
    if (footage) parts.push(`${footage.shots.length} ${footage.shots.length === 1 ? 'shot' : 'shots'}`)
    if (footage?.gate && media.durationMs) {
      const speechMs = footage.speech.reduce((sum, s) => sum + s.endMs - s.startMs, 0)
      parts.push(`${Math.round((speechMs / media.durationMs) * 100)}% speech`)
    }
    status = parts.join(' · ') || 'Analysed'
  }
  const ungated = analysed && footage !== undefined && !footage.gate

  const go = async (kind: 'analyse' | 'mark' | 'cut') => {
    setBusy(kind)
    setNotes([])
    try {
      if (kind === 'analyse') {
        const result = await run('media.analyze', { id: layer.id, ...(analysed ? { force: true } : {}) })
        if (result.ok) setNotes((result.value as { notes?: string[] }).notes ?? [])
      } else if (kind === 'mark') {
        const result = await run('media.remove_pauses', { id: layer.id, tightness, dryRun: true, markers: true })
        if (!result.ok) return
        const plan = result.value as Plan
        const shown = plan.cuts.slice(0, MAX_REASONS).map((c) => c.reason)
        if (plan.cuts.length > MAX_REASONS) shown.push(`…and ${plan.cuts.length - MAX_REASONS} more`)
        setNotes([`${plan.cuts.length} ${plan.cuts.length === 1 ? 'cut' : 'cuts'} · ${seconds(plan.removedMs)} s shorter`, ...shown])
      } else {
        const result = await run('media.remove_pauses', { id: layer.id, tightness, variant })
        if (!result.ok) return
        const done = result.value as { removedMs: number; note?: string }
        setNotes([done.note ?? `Cut ${seconds(done.removedMs)} s`])
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <Section title="Footage">
      <p className="text-[11px] text-muted">{status}</p>
      {ungated && <p className="text-[11px] text-muted">Silence can't be told from speech here</p>}
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => void go('analyse')}
        className={`${addButton} disabled:opacity-40`}
        title="Finds the words, where the voice is and where the shots change"
      >
        <ScanSearch size={13} aria-hidden />
        {busy === 'analyse' ? 'Hearing the words…' : analysed ? 'Analyse again' : 'Analyse'}
      </button>
      <div className="flex flex-wrap gap-1.5">
        {TIGHTNESS.map((t) => (
          <button
            key={t.value}
            type="button"
            aria-pressed={tightness === t.value}
            title={t.hint}
            onClick={() => setTightness(t.value)}
            className={`${pickButton} ${tightness === t.value ? 'active-tint' : 'bg-field text-ink hover:bg-hover'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          aria-pressed={variant}
          title={variant ? 'Cut a copy of the frame and leave this one as it was' : 'Cut this frame in place'}
          onClick={() => setVariant(!variant)}
          className={`${pickButton} ${variant ? 'active-tint' : 'bg-field text-ink hover:bg-hover'}`}
        >
          As new frame
        </button>
      </div>
      <div className="flex gap-1.5">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void go('mark')}
          title="Show the cuts on the ruler without cutting"
          className="h-8 min-w-0 flex-1 truncate rounded-lg bg-field px-2.5 text-[11px] text-ink hover:bg-hover disabled:opacity-40"
        >
          Mark cuts
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void go('cut')}
          title="Cut the pauses, fillers and false starts"
          className="flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg bg-field px-2.5 text-[11px] text-ink hover:bg-hover disabled:opacity-40"
        >
          <Scissors size={13} aria-hidden />
          Cut
        </button>
      </div>
      {notes.map((note, index) => (
        <p key={`${index}:${note}`} className="text-[11px] text-muted">
          {note}
        </p>
      ))}
    </Section>
  )
}
