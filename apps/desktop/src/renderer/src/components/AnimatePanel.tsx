import {
  ANIMATION_CATEGORIES,
  ANIMATION_PRESETS,
  type AnimationCategory,
  type AnimationParam,
  type AnimationSlot,
  type AnimationTarget,
  animationSpanMs,
  EASING_PRESETS,
  type Easing,
  ease,
  findAnimationPreset,
  type Layer,
  type LayerAnimation,
  slotAnimation,
  textUnits,
  unitCount,
  unitStartMs,
} from '@uve/core'
import { ArrowRightFromLine, ArrowRightToLine, ChevronDown, ChevronRight, Play, Plus, X } from 'lucide-react'
import { type PointerEvent as ReactPointerEvent, useState } from 'react'
import { beginGesture, type Gesture, run, useEditor } from '../store'
import { NumberField, type NumberSpec, Row, ScrubLabel, SelectField } from './fields'

// The Animate tab, modelled on AtomCut's: the whole layer's entrance and exit,
// and on text the per-letter, word or line entrance and exit. Every change is
// one animation.set call (a drag is one gesture), so it is one undo step.

const CATEGORY_LABELS: Record<AnimationCategory, string> = {
  fade: 'Fades',
  slide: 'Slides',
  scale: 'Scale',
  spin: 'Spins',
  bounce: 'Bounce',
  type: 'Typing',
  draw: 'Draw',
  stylize: 'Stylised',
}

const UNITS = [
  { value: 'letter', label: 'Letter' },
  { value: 'word', label: 'Word' },
  { value: 'line', label: 'Line' },
] as const

const EASING_LABELS: Record<(typeof EASING_PRESETS)[number], string> = {
  linear: 'Linear',
  hold: 'Hold',
  'ease-in': 'Ease in',
  'ease-out': 'Ease out',
  'ease-in-out': 'Ease in-out',
  'ease-in-back': 'Back in',
  'ease-out-back': 'Back out',
  'ease-out-quart': 'Quart out',
  'ease-out-expo': 'Expo out',
  'ease-in-out-back': 'Back in-out',
  'ease-out-elastic': 'Elastic out',
}

/** The presets a slot can take: whole-layer ones (and draw on outlines), or text ones. */
function presetsFor(layer: Layer, target: AnimationTarget) {
  return ANIMATION_PRESETS.filter((p) =>
    target === 'text' ? p.scope !== 'layer' : p.scope !== 'text' && (!p.drawOn || layer.kind === 'shape' || layer.kind === 'path'),
  )
}

function PresetSelect({ layer, target, value, onPick }: { layer: Layer; target: AnimationTarget; value: string; onPick: (id: string) => void }) {
  const presets = presetsFor(layer, target)
  return (
    <select
      aria-label="Preset"
      value={value}
      onChange={(e) => e.target.value && onPick(e.target.value)}
      className="h-8 w-full min-w-0 rounded-lg bg-field px-2 text-[12px] font-semibold outline-none hover:bg-hover focus:ring-1 focus:ring-accent"
    >
      {!value && <option value="">Choose a preset…</option>}
      {ANIMATION_CATEGORIES.map((category) => {
        const list = presets.filter((p) => p.category === category)
        return list.length === 0 ? null : (
          <optgroup key={category} label={CATEGORY_LABELS[category]}>
            {list.map((p) => (
              <option key={p.id} value={p.id} title={p.tagline}>
                {p.label}
              </option>
            ))}
          </optgroup>
        )
      })}
    </select>
  )
}

/** A knob as a bar to drag: its label on the left, the value on the right. One drag is one undo step. */
function ParamSlider({ param, value, bind }: { param: AnimationParam; value: number; bind: (v: number) => [string, unknown] }) {
  const fraction = (value - param.min) / (param.max - param.min || 1)
  const start = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const el = e.currentTarget
    const box = el.getBoundingClientRect()
    let gesture: Gesture | null = beginGesture(`Change ${param.label.toLowerCase()}`)
    const at = (x: number) => {
      const raw = param.min + Math.min(1, Math.max(0, (x - box.left) / box.width)) * (param.max - param.min)
      return Math.round(raw / param.step) * param.step
    }
    gesture.request(...bind(at(e.clientX)))
    const move = (ev: PointerEvent) => gesture?.request(...bind(at(ev.clientX)))
    const end = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', end)
      el.removeEventListener('lostpointercapture', end)
      void gesture?.end()
      gesture = null
    }
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      // Synthetic or finished pointers cannot be captured.
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', end)
    el.addEventListener('lostpointercapture', end)
  }
  if (param.options) {
    return (
      <Row label={param.label}>
        <SelectField label={param.label} value={value} options={param.options} onCommit={(v) => void run(...bind(v))} />
      </Row>
    )
  }
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={param.label}
      aria-valuemin={param.min}
      aria-valuemax={param.max}
      aria-valuenow={value}
      title={param.hint}
      onPointerDown={start}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
        e.preventDefault()
        const next = Math.min(param.max, Math.max(param.min, value + (e.key === 'ArrowRight' ? 1 : -1) * param.step * (e.shiftKey ? 10 : 1)))
        void run(...bind(next))
      }}
      className="relative flex h-8 cursor-ew-resize items-center justify-between overflow-hidden rounded-lg bg-field px-3 text-[12px] select-none hover:bg-hover focus:ring-1 focus:ring-accent focus:outline-none"
    >
      <span className="absolute inset-y-0 left-0 bg-hover" style={{ width: `${fraction * 100}%` }} aria-hidden />
      <span className="absolute inset-y-1.5 w-0.5 rounded bg-accent" style={{ left: `calc(${fraction * 100}% - 1px)` }} aria-hidden />
      <span className="relative font-medium">{param.label}</span>
      <span className="relative font-mono tabular-nums">
        {Number(value.toFixed(2))}
        {param.unit ? ` ${param.unit}` : ''}
      </span>
    </div>
  )
}

/** A small drawing of an easing curve. */
function CurveGlyph({ easing, size = 22 }: { easing: Easing; size?: number }) {
  const points = Array.from({ length: 25 }, (_, i) => {
    const x = i / 24
    // Hold jumps at the end; show it as a step.
    const y = easing === 'hold' ? (x < 1 ? 0 : 1) : ease(easing, x)
    return `${(x * size).toFixed(1)},${(size - 3 - y * (size - 6)).toFixed(1)}`
  })
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="overflow-visible">
      <polyline points={points.join(' ')} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" />
    </svg>
  )
}

function EasingPicker({ value, onPick }: { value: Easing; onPick: (e: Easing) => void }) {
  const name = typeof value === 'string' ? EASING_LABELS[value] : `Custom ${[value.x1, value.y1, value.x2, value.y2].map((n) => Number(n.toFixed(2))).join(' ')}`
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[11px] text-muted">
        <span className="font-semibold tracking-wider uppercase">Easing</span>
        <span className="flex items-center gap-1 text-ink">
          <CurveGlyph easing={value} size={16} />
          {name}
        </span>
      </div>
      <div className="grid grid-cols-6 gap-1">
        {EASING_PRESETS.map((e) => (
          <button
            key={e}
            type="button"
            title={EASING_LABELS[e]}
            aria-label={EASING_LABELS[e]}
            aria-pressed={value === e}
            onClick={() => onPick(e)}
            className={`flex h-8 items-center justify-center rounded-lg ${value === e ? 'active-tint' : 'bg-field text-muted hover:bg-hover hover:text-ink'}`}
          >
            <CurveGlyph easing={e} />
          </button>
        ))}
      </div>
    </div>
  )
}

/** When each unit runs, as ticks along the whole span, with a summary. */
function UnitTimeline({ layer, spec, slot }: { layer: Layer; spec: LayerAnimation; slot: AnimationSlot }) {
  const text = layer.kind === 'text' ? layer.text : ''
  const count = unitCount(textUnits(text), spec.unit)
  const starts = Array.from({ length: count }, (_, i) => unitStartMs(spec, slot, i, count, layer))
  const first = Math.min(0, ...starts)
  const total = Math.max(1, Math.max(...starts.map((s) => s + spec.durationMs), 1) - first)
  const span = animationSpanMs(spec, count) + spec.delayMs
  const at = (ms: number) => `${((ms - first) / total) * 100}%`
  return (
    <div className="space-y-1">
      <div className="relative h-5 rounded-lg bg-field" aria-hidden>
        {starts.map((s, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: units are positional
            key={i}
            className="absolute top-1.5 h-2 rounded-sm bg-accent/35"
            style={{ left: at(s), width: `max(2px, ${(spec.durationMs / total) * 100}%)` }}
          />
        ))}
        {starts.map((s, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: units are positional
          <span key={`t${i}`} className="absolute top-1 h-3 w-0.5 rounded bg-accent" style={{ left: at(s) }} />
        ))}
      </div>
      <div className="flex justify-between text-[11px] text-muted">
        <span>
          {count} {spec.unit}
          {count === 1 ? '' : 's'} · {Math.round(span)} ms total
        </span>
        {span > layer.durationMs && <span className="text-accent">longer than the layer</span>}
      </div>
    </div>
  )
}

const ms = (value: number, max = 10000): Omit<NumberSpec, 'bind'> => ({ value, min: 0, max, precision: 0, step: 10, suffix: 'ms' })

function SlotCard({ layer, target, slot }: { layer: Layer; target: AnimationTarget; slot: AnimationSlot }) {
  const spec = slotAnimation(layer, target, slot)
  const preset = spec ? findAnimationPreset(spec.preset) : undefined
  const [open, setOpen] = useState(spec !== null)
  const title = `${target === 'layer' ? 'Layer' : 'Text'} animate ${slot}`
  const Icon = slot === 'in' ? ArrowRightToLine : ArrowRightFromLine
  const set = (fields: Record<string, unknown>): [string, unknown] => ['animation.set', { id: layer.id, slot, target, preset: spec?.preset, ...fields }]
  const pick = (id: string) => void run('animation.set', { id: layer.id, slot, target, preset: id })
  const isText = target === 'text'
  const preview = () => {
    const { seek, playing, togglePlay } = useEditor.getState()
    seek(slot === 'in' ? layer.startMs : Math.max(layer.startMs, layer.startMs + layer.durationMs - 1500))
    if (!playing) togglePlay()
  }
  return (
    <section className="px-3 py-1.5">
      <div className={`flex h-11 items-center gap-2 rounded-panel px-3 ${spec ? 'active-tint' : 'hover:bg-hover'}`}>
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 text-left text-[13px] font-semibold">
          <Icon size={15} aria-hidden />
          <span className="flex-1 truncate">{title}</span>
          <span className="truncate text-[11px] font-normal text-muted">{preset ? preset.label : 'None'}</span>
          {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
        </button>
        {spec && (
          <>
            <button type="button" onClick={preview} aria-label={`Preview ${title.toLowerCase()}`} title="Play it from here" className="rounded-md p-1 text-muted hover:bg-hover hover:text-ink">
              <Play size={13} />
            </button>
            <button
              type="button"
              onClick={() => void run('animation.set', { id: layer.id, slot, target, preset: null })}
              aria-label={`Remove ${title.toLowerCase()}`}
              title="Remove"
              className="rounded-md p-1 text-muted hover:bg-hover hover:text-ink"
            >
              <X size={13} />
            </button>
          </>
        )}
      </div>
      {open && !spec && (
        <div className="mt-2 rounded-panel border border-dashed border-line p-3">
          <div className="mb-2 flex items-center justify-center gap-1.5 text-[12px] text-muted">
            <Plus size={13} aria-hidden /> {slot === 'in' ? 'Add an entrance' : 'Add an exit'}
          </div>
          <PresetSelect layer={layer} target={target} value="" onPick={pick} />
        </div>
      )}
      {open && spec && preset && (
        <div className="mt-2 space-y-1.5 px-1">
          <PresetSelect layer={layer} target={target} value={spec.preset} onPick={pick} />
          <p className="pb-1 text-[11px] text-muted">{preset.tagline}</p>
          {isText && (
            <Row label="Per">
              <SelectField label="Per" value={spec.unit} options={UNITS} onCommit={(unit) => void run(...set({ unit }))} />
            </Row>
          )}
          <Row label={<ScrubLabel text="Timing" spec={{ ...ms(spec.durationMs), bind: (v) => set({ durationMs: v }) }} />}>
            <NumberField label="Duration" axis="↧" spec={{ ...ms(spec.durationMs), bind: (v) => set({ durationMs: v }) }} />
            {isText && <NumberField label="Stagger" axis="↦" spec={{ ...ms(spec.staggerMs), bind: (v) => set({ staggerMs: v }) }} />}
          </Row>
          {isText && (
            <>
              <Row label="Delay">
                <NumberField label="Delay" axis="◷" spec={{ ...ms(spec.delayMs, 60000), bind: (v) => set({ delayMs: v }) }} />
              </Row>
              <Row label="Humanize">
                <NumberField label="Jitter" axis="⤨" spec={{ ...ms(spec.jitterMs, 5000), bind: (v) => set({ jitterMs: v }) }} />
                <NumberField label="Scatter" axis="↔" spec={{ value: spec.scatterPx, min: 0, max: 2000, precision: 0, suffix: 'px', bind: (v) => set({ scatterPx: v }) }} />
              </Row>
              <UnitTimeline layer={layer} spec={spec} slot={slot} />
            </>
          )}
          {preset.params.length > 0 && (
            <div className="space-y-1.5 pt-1">
              {preset.params.map((p) => (
                <ParamSlider key={p.key} param={p} value={spec.params[p.key] ?? p.defaultValue} bind={(v) => set({ params: { [p.key]: v } })} />
              ))}
            </div>
          )}
          <div className="pt-2">
            <EasingPicker value={spec.easing} onPick={(easing) => void run(...set({ easing }))} />
          </div>
        </div>
      )}
    </section>
  )
}

/** Entrances and exits of the selected layer. */
export function AnimatePanel({ layer }: { layer: Layer }) {
  if (layer.kind === 'audio') return <p className="p-4 text-[12px] text-muted">Audio layers have nothing to animate.</p>
  return (
    <div className="py-1.5">
      <SlotCard key={`${layer.id}-layer-in`} layer={layer} target="layer" slot="in" />
      <SlotCard key={`${layer.id}-layer-out`} layer={layer} target="layer" slot="out" />
      {layer.kind === 'text' && (
        <>
          <div className="mx-4 my-1.5 h-px bg-line" />
          <SlotCard key={`${layer.id}-text-in`} layer={layer} target="text" slot="in" />
          <SlotCard key={`${layer.id}-text-out`} layer={layer} target="text" slot="out" />
        </>
      )}
    </div>
  )
}
