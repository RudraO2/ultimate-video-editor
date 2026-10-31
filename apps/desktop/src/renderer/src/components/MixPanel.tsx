import { type Comp, type DuckRule, type Layer, type SoundCategory, categoryTarget, CHARACTER_TARGET_LUFS, type SoundCharacter } from '@uve/core'
import { ArrowLeft, Headphones, Plus, Trash2, Volume2, VolumeX, X } from '../icons'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { beginGesture, type Gesture, run, useActiveComp, useEditor } from '../store'
import { ColorField, NumberField, type NumberSpec, Row, ScrubLabel, SelectField, TextField } from './fields'
import { Section, Switch } from './inspectorParts'

// The Mix, modelled on AtomCut's Sound tab with no layer selected: the frame's
// leveler, master fader and limiter, and one page per sound category (fader,
// kind, loudness target, ducking, the layers routed to it). Every change is a
// command (frame.update, sound.category); sliders are gestures.

const KIND_OPTIONS: { value: SoundCharacter; label: string }[] = [
  { value: 'voice', label: 'Speech' },
  { value: 'music', label: 'Music' },
  { value: 'sfx', label: 'Effects' },
  { value: 'ambience', label: 'Ambience' },
]

const MINUS = '−'

/** A number with its sign shown as a typographic minus, "−1 dB". */
function signed(n: number, precision: number, unit: string): string {
  const text = Math.abs(n).toFixed(precision)
  return `${n < 0 && Number(text) !== 0 ? MINUS : ''}${text} ${unit}`
}

/** A range input that edits live as one gesture (one undo step per drag); the arrow keys edit one step at a time. */
function Slider({ value, min, max, step, label, bind, text }: { value: number; min: number; max: number; step: number; label: string; bind: (v: number) => [name: string, input: unknown]; text: string }) {
  const gesture = useRef<Gesture | null>(null)
  const down = useRef(false)
  const end = () => {
    down.current = false
    void gesture.current?.end()
    gesture.current = null
  }
  useEffect(() => () => end(), [])
  const at = Math.min(1, Math.max(0, (value - min) / (max - min)))
  // AtomCut's bar: a field with the value inside and a marker where it sits; the range input lies on top, invisible, for input.
  return (
    <div className="relative h-8 min-w-0 flex-1 rounded-lg bg-field">
      <span className="pointer-events-none absolute top-2 bottom-2 w-0.5 rounded-full bg-accent" style={{ left: `calc(${at * 100}% - 1px)` }} />
      <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center font-mono text-[12px] text-ink tabular-nums">{text}</span>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onPointerDown={() => {
          down.current = true
          window.addEventListener('pointerup', end, { once: true })
          window.addEventListener('pointercancel', end, { once: true })
        }}
        onChange={(e) => {
          const next = Number(e.target.value)
          if (!down.current) {
            void run(...bind(next))
            return
          }
          gesture.current ??= beginGesture(`Change ${label.toLowerCase()}`)
          gesture.current.request(...bind(next))
        }}
        onBlur={end}
        className="absolute inset-0 h-full w-full cursor-ew-resize opacity-0"
      />
    </div>
  )
}

/** A label with its switch right after it, as AtomCut lays them out. */
function SwitchLine({ label, on, onChange, dim }: { label: string; on: boolean; onChange: (on: boolean) => void; dim?: boolean }) {
  return (
    <div className={`flex min-h-7 items-center gap-6 ${dim ? 'opacity-50' : ''}`}>
      <span className="text-[12px]">{label}</span>
      <Switch on={on} onChange={onChange} label={label} />
    </div>
  )
}

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex min-w-0 flex-1 gap-0.5 rounded-lg bg-field p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => value !== o.value && onChange(o.value)}
          className={`h-6 flex-1 rounded-md text-[11px] ${value === o.value ? 'bg-panel text-ink' : 'text-muted hover:bg-hover hover:text-ink'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Dot({ color }: { color: string }) {
  return <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: color }} />
}

const iconButton = 'flex size-7 shrink-0 items-center justify-center rounded-lg'

function SoloMute({ category }: { category: SoundCategory }) {
  const set = (fields: { solo?: boolean; muted?: boolean }) => void run('sound.category', { action: 'update', id: category.id, ...fields })
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          set({ solo: !category.solo })
        }}
        aria-pressed={category.solo}
        aria-label={`Solo ${category.name}`}
        title={category.solo ? 'Stop soloing' : 'Solo: hear only this'}
        className={`${iconButton} ${category.solo ? 'active-tint' : 'text-muted hover:bg-hover hover:text-ink'}`}
      >
        <Headphones size={14} aria-hidden />
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          set({ muted: !category.muted })
        }}
        aria-pressed={category.muted}
        aria-label={`Mute ${category.name}`}
        title={category.muted ? 'Unmute' : 'Mute'}
        className={`${iconButton} ${category.muted ? 'active-tint' : 'text-muted hover:bg-hover hover:text-ink'}`}
      >
        {category.muted ? <VolumeX size={14} aria-hidden /> : <Volume2 size={14} aria-hidden />}
      </button>
    </>
  )
}

/** Layers of the whole project routed to each category, by category id. */
function useRouting(): Map<string, { layer: Layer; comp: Comp }[]> {
  const project = useEditor((s) => s.project)
  return useMemo(() => {
    const map = new Map<string, { layer: Layer; comp: Comp }[]>()
    for (const comp of project.comps) {
      for (const track of comp.tracks) {
        for (const layer of track.layers) {
          if (layer.soundBus === undefined) continue
          const list = map.get(layer.soundBus) ?? []
          list.push({ layer, comp })
          map.set(layer.soundBus, list)
        }
      }
    }
    return map
  }, [project])
}

function mixUpdate(comp: Comp, soundMix: unknown): [string, unknown] {
  return ['frame.update', { id: comp.id, soundMix }]
}

function FrameMix({ comp, onOpen }: { comp: Comp; onOpen: (id: string) => void }) {
  const categories = useEditor((s) => s.project.soundCategories)
  const routing = useRouting()
  const { leveler, limiter, loudness } = comp.soundMix
  const setLeveler = (fields: Record<string, unknown>) => void run(...mixUpdate(comp, { leveler: fields }))
  const setLoudness = (fields: Record<string, unknown>) => void run(...mixUpdate(comp, { loudness: fields }))
  const target: NumberSpec = { value: loudness.targetLufs, bind: (v) => mixUpdate(comp, { loudness: { targetLufs: v } }), min: -30, max: -6, step: 0.5, precision: 1, suffix: 'LUFS' }
  const setLimiter = (fields: Record<string, unknown>) => void run(...mixUpdate(comp, { limiter: fields }))
  const ceiling: NumberSpec = { value: limiter.ceilingDb, bind: (v) => mixUpdate(comp, { limiter: { ceilingDb: v } }), min: -12, max: 0, step: 0.1, precision: 1, suffix: 'dB' }
  return (
    <div className="pb-2">
      <Section title="Leveler" action={<Switch on={leveler.enabled} onChange={(enabled) => setLeveler({ enabled })} label="Leveler" />}>
        <div className={`space-y-1.5 ${leveler.enabled ? '' : 'opacity-50'}`}>
          <Row label="Level">
            <Segmented
              label="Leveling by"
              value={leveler.mode}
              options={[
                { value: 'category', label: 'By category' },
                { value: 'all', label: 'All' },
              ]}
              onChange={(mode) => setLeveler({ mode })}
            />
          </Row>
          <Row label="Strength">
            <Slider value={leveler.strength} min={0} max={1} step={0.01} label="Strength" bind={(v) => mixUpdate(comp, { leveler: { strength: v } })} text={`${Math.round(leveler.strength * 100)} %`} />
          </Row>
          <SwitchLine label="Tame loud sounds" on={leveler.tameLoud} onChange={(tameLoud) => setLeveler({ tameLoud })} />
          <SwitchLine label="Lift quiet sounds" on={leveler.liftQuiet} onChange={(liftQuiet) => setLeveler({ liftQuiet })} />
          <SwitchLine label="Even out speech" on={leveler.evenSpeech} onChange={(evenSpeech) => setLeveler({ evenSpeech })} />
        </div>
      </Section>
      <Section title="Master">
        <Row label="Level">
          <Slider value={comp.soundMix.volume} min={0} max={4} step={0.01} label="Master level" bind={(v) => mixUpdate(comp, { volume: v })} text={`${Math.round(comp.soundMix.volume * 100)} %`} />
        </Row>
        <SwitchLine label="Match loudness" on={loudness.enabled} onChange={(enabled) => setLoudness({ enabled })} />
        <div className={loudness.enabled ? '' : 'opacity-50'}>
          <Row label={<ScrubLabel text="Target" spec={target} />}>
            <NumberField spec={target} label="Target loudness" />
          </Row>
        </div>
        <SwitchLine label="Limiter" on={limiter.enabled} onChange={(enabled) => setLimiter({ enabled })} />
        <div className={limiter.enabled ? '' : 'opacity-50'}>
          <Row label={<ScrubLabel text="Ceiling" spec={ceiling} />}>
            <NumberField spec={ceiling} label="Ceiling" />
          </Row>
        </div>
      </Section>
      <Section title={`Categories ${categories.length}`}>
        <div className="space-y-0.5">
          {categories.map((c) => (
            <div key={c.id} className="flex items-center gap-1">
              <button type="button" onClick={() => onOpen(c.id)} className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left hover:bg-hover">
                <Dot color={c.color} />
                <span className="min-w-0 flex-1 truncate text-[12px]">{c.name}</span>
                <span className="text-[11px] text-muted tabular-nums" title="Layers routed here">
                  {routing.get(c.id)?.length ?? 0}
                </span>
              </button>
              <SoloMute category={c} />
            </div>
          ))}
        </div>
        <button type="button" onClick={() => void run('sound.category', { action: 'create' })} className="flex h-8 w-full items-center gap-1.5 rounded-lg px-2 text-[12px] text-muted hover:bg-hover hover:text-ink">
          <Plus size={13} aria-hidden />
          New category
        </button>
      </Section>
    </div>
  )
}

/** The leveler's target in LUFS; empty means the kind's own (shown greyed as the placeholder). */
function TargetField({ category }: { category: SoundCategory }) {
  const [draft, setDraft] = useState<string | null>(null)
  const fallback = CHARACTER_TARGET_LUFS[category.character]
  const commit = (text: string) => {
    setDraft(null)
    const trimmed = text.trim().replace(MINUS, '-')
    if (trimmed === '') {
      if (category.targetLufs !== null) void run('sound.category', { action: 'update', id: category.id, targetLufs: null })
      return
    }
    const n = Number(trimmed)
    if (!Number.isFinite(n)) return
    const next = Math.min(-6, Math.max(-40, n))
    if (next !== category.targetLufs) void run('sound.category', { action: 'update', id: category.id, targetLufs: next })
  }
  return (
    <div className="relative min-w-0 flex-1">
      <input
        aria-label="Target loudness"
        inputMode="decimal"
        placeholder={String(fallback)}
        value={draft ?? (category.targetLufs === null ? '' : String(category.targetLufs))}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => draft !== null && commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            setDraft(null)
            e.currentTarget.blur()
          }
        }}
        className="h-7 w-full min-w-0 rounded-lg bg-field px-2 pr-10 text-[12px] tabular-nums outline-none hover:bg-hover focus:ring-1 focus:ring-accent"
      />
      <span className="pointer-events-none absolute top-1.5 right-2 text-[10px] text-muted">LUFS</span>
    </div>
  )
}

function DuckRuleRow({ category, rule, index, others }: { category: SoundCategory; rule: DuckRule; index: number; others: SoundCategory[] }) {
  // Rules are edited by sending the category's whole new list.
  const send = (rules: DuckRule[]) => run('sound.category', { action: 'update', id: category.id, ducking: rules })
  const change = (fields: Partial<DuckRule>) => void send(category.ducking.map((r, i) => (i === index ? { ...r, ...fields } : r)))
  const underId = rule.under.kind === 'bus' ? rule.under.id : ''
  const options = others.map((o) => ({ value: o.id, label: o.name }))
  const timing = (field: 'attackMs' | 'releaseMs', tag: string): ReactNode => (
    <>
      <span className="text-[10px] text-muted">{tag}</span>
      <NumberField
        label={tag === 'IN' ? 'Duck in time' : 'Duck out time'}
        spec={{ value: rule[field], bind: (v) => ['sound.category', { action: 'update', id: category.id, ducking: category.ducking.map((r, i) => (i === index ? { ...r, [field]: v } : r)) }], min: 0, max: field === 'attackMs' ? 5000 : 10000, step: 10, precision: 0, suffix: 'ms' }}
      />
    </>
  )
  return (
    <div className="space-y-1.5 rounded-panel bg-field/50 p-2">
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1">
          <Row label="Under">
            <SelectField
              label="Duck under"
              value={underId}
              options={options.some((o) => o.value === underId) ? options : [{ value: underId, label: rule.under.id }, ...options]}
              onCommit={(id) => change({ under: { kind: 'bus', id } })}
            />
          </Row>
        </div>
        <button type="button" onClick={() => void send(category.ducking.filter((_, i) => i !== index))} aria-label="Remove rule" title="Remove this rule" className={`${iconButton} text-muted hover:bg-hover hover:text-ink`}>
          <X size={13} aria-hidden />
        </button>
      </div>
      <Row label="Depth">
        <Slider value={rule.depthDb} min={0} max={60} step={0.5} label="Duck depth" bind={(v) => ['sound.category', { action: 'update', id: category.id, ducking: category.ducking.map((r, i) => (i === index ? { ...r, depthDb: v } : r)) }]} text={`${MINUS}${rule.depthDb.toFixed(1)} dB`} />
      </Row>
      <Row label="Timing">
        {timing('attackMs', 'IN')}
        {timing('releaseMs', 'OUT')}
      </Row>
    </div>
  )
}

function CategoryPage({ category, comp, onBack }: { category: SoundCategory; comp: Comp; onBack: () => void }) {
  const all = useEditor((s) => s.project.soundCategories)
  const routing = useRouting()
  const layers = routing.get(category.id) ?? []
  const others = useMemo(() => all.filter((c) => c.id !== category.id), [all, category.id])
  const update = (fields: Record<string, unknown>) => void run('sound.category', { action: 'update', id: category.id, ...fields })
  const addRule = () => {
    const first = others[0]
    if (!first) return
    void run('sound.category', {
      action: 'update',
      id: category.id,
      ducking: [...category.ducking, { under: { kind: 'bus', id: first.id }, depthDb: 10, attackMs: 150, releaseMs: 500 }],
    })
  }
  return (
    <div className="pb-2">
      <div className="flex h-12 items-center gap-1.5 border-b border-line pr-2 pl-2">
        <button type="button" onClick={onBack} aria-label="Back to the mix" title="Back" className={`${iconButton} text-muted hover:bg-hover hover:text-ink`}>
          <ArrowLeft size={15} aria-hidden />
        </button>
        <div className="min-w-0 flex-1 [&_input]:bg-transparent [&_input]:text-[14px] [&_input]:font-semibold">
          <TextField key={category.name} label="Category name" value={category.name} onCommit={(name) => name.trim() && update({ name: name.trim() })} />
        </div>
        <div className="flex w-24 shrink-0 items-center gap-1 [&_input:not([type=color])]:hidden">
          <ColorField label="Category colour" value={category.color} bind={(color) => ['sound.category', { action: 'update', id: category.id, color }]} />
        </div>
      </div>
      <Section title="Category">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[12px] text-muted">Solo / mute</span>
          <div className="flex gap-1">
            <SoloMute category={category} />
          </div>
        </div>
        <Row label="Level">
          <Slider value={category.volume} min={0} max={4} step={0.01} label="Category level" bind={(v) => ['sound.category', { action: 'update', id: category.id, volume: v }]} text={`${Math.round(category.volume * 100)} %`} />
        </Row>
        <Row label="Kind">
          <SelectField label="Kind" value={category.character} options={KIND_OPTIONS} onCommit={(character) => update({ character })} />
        </Row>
        <Row label="Target">
          <TargetField category={category} />
        </Row>
        <p className="text-[11px] text-muted">{`Leveled to ${signed(categoryTarget(category), 0, 'LUFS')}${category.targetLufs === null ? ' (the kind’s own)' : ''}.`}</p>
      </Section>
      <Section title={`Ducking ${category.ducking.length}`}>
        {category.ducking.map((rule, index) => (
          <DuckRuleRow key={rule.id} category={category} rule={rule} index={index} others={others} />
        ))}
        <button type="button" onClick={addRule} disabled={others.length === 0} className="flex h-8 w-full items-center gap-1.5 rounded-lg px-2 text-[12px] text-muted hover:bg-hover hover:text-ink disabled:opacity-50">
          <Plus size={13} aria-hidden />
          {category.ducking.length === 0 ? 'Add a rule' : 'Another rule'}
        </button>
      </Section>
      <Section title={`Layers ${layers.length}`}>
        {layers.length === 0 && <p className="text-[11px] text-muted">No layer is routed here. Pick this category in a layer&rsquo;s Sound tab.</p>}
        <div className="space-y-0.5">
          {layers.map(({ layer, comp: owner }) => (
            <button
              key={layer.id}
              type="button"
              disabled={owner.id !== comp.id}
              onClick={() => useEditor.getState().select(layer.id)}
              title={owner.id === comp.id ? 'Select this layer' : `In frame ${owner.name}`}
              className="flex h-7 w-full items-center gap-2 rounded-lg px-2 text-left text-[12px] hover:bg-hover disabled:opacity-60 disabled:hover:bg-transparent"
            >
              <span className="min-w-0 flex-1 truncate">{layer.name}</span>
              {owner.id !== comp.id && <span className="truncate text-[11px] text-muted">{owner.name}</span>}
            </button>
          ))}
        </div>
      </Section>
      {!category.builtIn && (
        <div className="px-4 pt-1">
          <button
            type="button"
            onClick={() => {
              void run('sound.category', { action: 'delete', id: category.id }).then((r) => r.ok && onBack())
            }}
            className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-field text-[12px] text-ink hover:bg-hover"
          >
            <Trash2 size={13} aria-hidden />
            Delete category
          </button>
        </div>
      )}
    </div>
  )
}

/** The frame's mix: leveler, master and categories, and a page per category. */
export function MixPanel() {
  const comp = useActiveComp()
  const categories = useEditor((s) => s.project.soundCategories)
  const [openId, setOpenId] = useState<string | null>(null)
  const category = openId === null ? undefined : categories.find((c) => c.id === openId)
  return (
    <div className="py-1.5">
      {category ? <CategoryPage category={category} comp={comp} onBack={() => setOpenId(null)} /> : <FrameMix comp={comp} onOpen={setOpenId} />}
    </div>
  )
}
