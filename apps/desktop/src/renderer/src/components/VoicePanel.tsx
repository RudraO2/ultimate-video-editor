import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { BULBUL_V3_SPEAKERS, DEFAULT_SPEAKER, SARVAM_LANGUAGES, TTS_MAX_CHARS, type SarvamStatus } from '../../../shared/sarvam'
import { activeComp, findLayer, openFrame, session, useEditor } from '../store'
import { Section } from './inspectorParts'

// The Voice tab: Sarvam voiceovers, word timing, translation and whole-comp localizing by hand.
// Every edit is one command (generate.speech, media.transcribe, text.translate, comp.localize).

type Fit = 'room' | 'pace' | 'none'

interface Take {
  text: string
  oldMs: number
  newMs: number
  pace: number
  roomMs: number
}

/** What a finished action shows under its button. */
type Outcome = { ok: true; lines: string[] } | { ok: false; error: string; hint?: string }

const field = 'h-7 min-w-0 rounded-lg bg-field px-1.5 text-[11px] text-ink outline-none focus:ring-1 focus:ring-accent'
const area = 'w-full resize-none rounded-lg bg-field p-2 text-[11px] leading-snug text-ink outline-none focus:ring-1 focus:ring-accent'
const primary =
  'flex h-7 items-center justify-center gap-1 rounded-lg bg-accent/35 px-2.5 text-[11px] font-semibold text-accent hover:bg-accent/50 disabled:opacity-40'
const plain = 'flex h-7 items-center justify-center rounded-lg bg-field px-2.5 text-[11px] text-ink hover:bg-hover disabled:opacity-40'

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`
const rupees = (n: number) => `₹${n.toFixed(2)}`
const langName = (code: string) => SARVAM_LANGUAGES.find((l) => l.code === code)?.name ?? code

function Labelled({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <label className="w-16 shrink-0 text-[11px] text-muted" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  )
}

function LanguageSelect({ id, value, onChange }: { id: string; value: string; onChange: (code: string) => void }) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={`${field} flex-1`}>
      {SARVAM_LANGUAGES.map((l) => (
        <option key={l.code} value={l.code}>
          {l.native} ({l.name})
        </option>
      ))}
    </select>
  )
}

function VoiceSelect({ id, value, onChange, sameOption }: { id: string; value: string; onChange: (v: string) => void; sameOption?: boolean }) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={`${field} flex-1`}>
      {sameOption && <option value="">Same voice</option>}
      {BULBUL_V3_SPEAKERS.map((v) => (
        <option key={v.id} value={v.id}>
          {v.id}
          {v.gender ? ` (${v.gender})` : ''}
        </option>
      ))}
    </select>
  )
}

function Result({ outcome }: { outcome: Outcome | null }) {
  if (!outcome) return null
  if (!outcome.ok) {
    return (
      <div className="text-[11px] text-danger" role="alert">
        <p className="break-words whitespace-pre-wrap">{outcome.error}</p>
        {outcome.hint && <p className="mt-1 break-words whitespace-pre-wrap text-muted">{outcome.hint}</p>}
      </div>
    )
  }
  return (
    <div className="text-[11px] text-muted" aria-live="polite">
      {outcome.lines.map((l, i) => (
        <p key={i} className="break-words whitespace-pre-wrap">
          {l}
        </p>
      ))}
    </div>
  )
}

export function VoicePanel() {
  const comp = useEditor((s) => activeComp(s))
  const selected = useEditor((s) => (s.selectedLayerId ? findLayer(s.project, s.selectedLayerId) : undefined))
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<SarvamStatus | null>(null)
  const [spent, setSpent] = useState<number | null>(null)
  const [keyDraft, setKeyDraft] = useState('')

  // Speak a line
  const [text, setText] = useState('')
  const [language, setLanguage] = useState('hi-IN')
  const [voice, setVoice] = useState(DEFAULT_SPEAKER)
  const [pace, setPace] = useState(1)
  const [speakOut, setSpeakOut] = useState<Outcome | null>(null)

  // Selection
  const [script, setScript] = useState('')
  const [translateTo, setTranslateTo] = useState('hi-IN')
  const [selectionOut, setSelectionOut] = useState<Outcome | null>(null)

  // Localize
  const [locLanguage, setLocLanguage] = useState('hi-IN')
  const [locVoice, setLocVoice] = useState('')
  const [fit, setFit] = useState<Fit>('room')
  const [keep, setKeep] = useState('')
  const [localizeOut, setLocalizeOut] = useState<Outcome | null>(null)
  const [takes, setTakes] = useState<Take[]>([])

  const refresh = useCallback(async () => {
    try {
      setStatus(await window.uve.sarvam.status())
    } catch {
      setStatus(null)
    }
    const usage = await session.call('sarvam.usage', {})
    if (usage.ok) setSpent((usage.value as { totalInr: number }).totalInr)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** Runs one action with the shared busy flag, shows its outcome, and refreshes the spend line. */
  const work = async (
    show: (o: Outcome) => void,
    name: string,
    input: unknown,
    label: string,
    describe: (value: any) => string[], // eslint-disable-line @typescript-eslint/no-explicit-any
    after?: (value: any) => void, // eslint-disable-line @typescript-eslint/no-explicit-any
  ) => {
    if (busy) return
    setBusy(true)
    show({ ok: true, lines: [] })
    try {
      const result = await session.call(name, input, { label })
      if (result.ok) {
        show({ ok: true, lines: describe(result.value) })
        after?.(result.value)
      } else {
        show({ ok: false, error: result.error, ...(result.hint ? { hint: result.hint } : {}) })
      }
    } catch (e) {
      show({ ok: false, error: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
      void refresh()
    }
  }

  const saveKey = async (key: string | null) => {
    setBusy(true)
    try {
      setStatus(await window.uve.sarvam.setKey(key))
      setKeyDraft('')
    } finally {
      setBusy(false)
      void refresh()
    }
  }

  const speak = () =>
    work(
      setSpeakOut,
      'generate.speech',
      { text: text.trim(), language, voice, pace, place: { compId: comp.id, startMs: Math.round(useEditor.getState().timeMs) } },
      'Speak a line',
      (v: { durationMs: number; words: unknown; cached: boolean; costInr: number }) => {
        const words = Array.isArray(v.words) ? v.words.length : Number(v.words ?? 0)
        return [`${secs(v.durationMs)}, ${words} words${v.cached ? ' (cached)' : ` · ${rupees(v.costInr)}`}`]
      },
    )

  const transcribe = () =>
    selected &&
    work(
      setSelectionOut,
      'media.transcribe',
      { id: selected.id, captions: true, ...(script.trim() ? { text: script.trim() } : {}) },
      'Time words and add caption',
      (v: { words: unknown; costInr: number }) => {
        const words = Array.isArray(v.words) ? v.words.length : Number(v.words ?? 0)
        return [`Caption added: ${words} words timed · ${rupees(v.costInr)}`]
      },
    )

  const translate = () =>
    selected &&
    work(
      setSelectionOut,
      'text.translate',
      { ids: [selected.id], to: translateTo },
      `Translate to ${langName(translateTo)}`,
      (v: { costInr: number }) => [`Translated to ${langName(translateTo)} · ${rupees(v.costInr)}`],
    )

  const localize = () =>
    work(
      setLocalizeOut,
      'comp.localize',
      {
        compId: comp.id,
        language: locLanguage,
        ...(locVoice ? { voice: locVoice } : {}),
        fit,
        ...(keep.trim() ? { keep: keep.split(',').map((k) => k.trim()).filter(Boolean) } : {}),
      },
      `Make ${langName(locLanguage)} version`,
      (v: { takes: Take[]; addedMs: number; costInr: number }) => {
        setTakes(v.takes ?? [])
        return [`${(v.takes ?? []).length} takes · ${v.addedMs >= 0 ? '+' : ''}${secs(v.addedMs)} · ${rupees(v.costInr)}`]
      },
      (v: { compId: string }) => openFrame(v.compId),
    )

  const keyLine = status?.hasKey
    ? `Key set (${status.source ?? 'unknown'})${status.hint ? ` …${status.hint}` : ''}`
    : 'No key'
  const tooLong = text.length > TTS_MAX_CHARS

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <h2 className="shrink-0 px-3 pt-3 pb-1 text-[12px] font-semibold">Voice</h2>

      <Section title="Sarvam">
        <p className="text-[11px] text-ink">{keyLine}</p>
        <div className="flex items-center gap-1">
          <input
            type="password"
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            placeholder="Sarvam API key"
            aria-label="Sarvam API key"
            autoComplete="off"
            className={`${field} flex-1`}
          />
          <button type="button" disabled={busy || keyDraft.trim() === ''} onClick={() => void saveKey(keyDraft.trim())} className={primary}>
            Save
          </button>
          {status?.source === 'settings' && (
            <button type="button" disabled={busy} onClick={() => void saveKey(null)} className={plain}>
              Clear
            </button>
          )}
        </div>
        <p className="text-[11px] text-muted">
          {spent === null ? 'Spent: not counted yet' : `Spent ≈ ${rupees(spent)} this install`} · Balance: dashboard.sarvam.ai
        </p>
      </Section>

      <Section title="Speak a line">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          aria-label="Line to speak"
          placeholder="What should the voice say?"
          className={area}
        />
        <p className={`text-right text-[10px] ${tooLong ? 'text-danger' : 'text-muted'}`}>
          {text.length} / {TTS_MAX_CHARS}
        </p>
        <Labelled label="Language" htmlFor="voice-lang">
          <LanguageSelect id="voice-lang" value={language} onChange={setLanguage} />
        </Labelled>
        <Labelled label="Voice" htmlFor="voice-speaker">
          <VoiceSelect id="voice-speaker" value={voice} onChange={setVoice} />
        </Labelled>
        <Labelled label="Pace" htmlFor="voice-pace">
          <input
            id="voice-pace"
            type="range"
            min={0.5}
            max={2}
            step={0.05}
            value={pace}
            onChange={(e) => setPace(Number(e.target.value))}
            className="min-w-0 flex-1 accent-accent"
          />
          <span className="w-9 shrink-0 text-right font-mono text-[11px] text-ink tabular-nums">{pace.toFixed(2)}×</span>
        </Labelled>
        <button type="button" disabled={busy || text.trim() === '' || tooLong} onClick={() => void speak()} className={`${primary} w-full`}>
          {busy ? 'Working…' : 'Speak at playhead'}
        </button>
        <Result outcome={speakOut} />
      </Section>

      <Section title="Selection">
        {selected?.kind === 'audio' ? (
          <>
            <textarea
              value={script}
              onChange={(e) => setScript(e.target.value)}
              rows={3}
              aria-label="Script (optional)"
              placeholder="Script (optional): the exact words, for better timing"
              className={area}
            />
            <button type="button" disabled={busy} onClick={() => void transcribe()} className={`${primary} w-full`}>
              {busy ? 'Working…' : 'Time words & add caption'}
            </button>
          </>
        ) : selected?.kind === 'text' ? (
          <>
            <Labelled label="Translate to" htmlFor="voice-translate">
              <LanguageSelect id="voice-translate" value={translateTo} onChange={setTranslateTo} />
            </Labelled>
            <button type="button" disabled={busy} onClick={() => void translate()} className={`${primary} w-full`}>
              {busy ? 'Working…' : `Translate to ${langName(translateTo)}`}
            </button>
          </>
        ) : (
          <p className="text-[11px] text-muted">Select a voice clip or a text layer.</p>
        )}
        <Result outcome={selectionOut} />
      </Section>

      <Section title="Localize this comp">
        <Labelled label="Language" htmlFor="voice-loc-lang">
          <LanguageSelect id="voice-loc-lang" value={locLanguage} onChange={setLocLanguage} />
        </Labelled>
        <Labelled label="Voice" htmlFor="voice-loc-voice">
          <VoiceSelect id="voice-loc-voice" value={locVoice} onChange={setLocVoice} sameOption />
        </Labelled>
        <Labelled label="Fit" htmlFor="voice-loc-fit">
          <select id="voice-loc-fit" value={fit} onChange={(e) => setFit(e.target.value as Fit)} className={`${field} flex-1`}>
            <option value="room">Make room</option>
            <option value="pace">Speed up only</option>
            <option value="none">Keep pace</option>
          </select>
        </Labelled>
        <Labelled label="Keep as is" htmlFor="voice-loc-keep">
          <input
            id="voice-loc-keep"
            type="text"
            value={keep}
            onChange={(e) => setKeep(e.target.value)}
            placeholder="Untranslated words, comma-separated"
            className={`${field} flex-1`}
          />
        </Labelled>
        <button type="button" disabled={busy} onClick={() => void localize()} className={`${primary} w-full`}>
          {busy ? 'Working…' : `Make ${langName(locLanguage)} version`}
        </button>
        <Result outcome={localizeOut} />
        {localizeOut?.ok && takes.length > 0 && (
          <ul className="space-y-0.5 text-[11px] text-muted">
            {takes.map((t, i) => (
              <li key={i} className="break-words">
                {secs(t.oldMs)} → {secs(t.newMs)} · pace {t.pace.toFixed(2)}× · room {secs(t.roomMs)}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}
