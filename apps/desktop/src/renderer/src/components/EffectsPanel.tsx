import {
  type Effect,
  EFFECT_FAMILIES,
  EFFECT_PREFIX,
  type EffectDef,
  type EffectDomain,
  type EffectField,
  effectDefs,
  effectStack,
  evaluateProperty,
  findEffectDef,
  type Layer,
  propertiesOf,
} from '@uve/core'
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Eye, EyeOff, Plus, Search, SlidersHorizontal, Sparkles, Trash2 } from '../icons'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { findLayer, propertyEdit, run, useEditor } from '../store'
import { type Bind, ColorField, KeyButton, type KeyTarget, NumberField, Row, ScrubLabel, SelectField, Toggle } from './fields'

// The Effects tab, modelled on AtomCut's: the layer's effect stack (whole-layer
// pixels) and, on text, the per-glyph text effects. Each card has its key
// diamond, settings, an eye and a bin; adding one picks from a searchable list
// grouped by family. Every change is one command, so one undo step.

const DOMAIN_TITLE: Record<EffectDomain, string> = { layer: 'Layer effects', text: 'Text effects' }

/** Labels of choices that read better spelled out. */
const CHOICE_LABELS: Record<string, string> = {
  text: 'Text colour',
  custom: 'Custom',
  auto: "Layer's colours",
  solid: 'One colour',
  'source-over': 'Normal',
  lighter: 'Add',
}

const label = (key: string) => key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  const [open, setOpen] = useState(true)
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <section className="border-b border-line px-4 py-1 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex h-10 w-full items-center gap-1.5 text-[11px] font-semibold tracking-wider text-muted uppercase hover:text-ink"
      >
        <Chevron size={13} aria-hidden />
        {title}
        {count > 0 && <span className="font-normal normal-case">{count}</span>}
      </button>
      {open && <div className="space-y-1.5 pb-3">{children}</div>}
    </section>
  )
}

/** A field's command, looked up when the edit happens: keyed fields get a key at the playhead. */
function setter<T extends number | string>(layerId: string, path: string): Bind<T> {
  return (value) => {
    const layer = findLayer(useEditor.getState().project, layerId)
    return layer ? propertyEdit(layer, path, path, value) : ['layer.set', { id: layerId, values: { [path]: value } }]
  }
}

function update(layer: Layer, effect: Effect, change: Record<string, unknown>) {
  return run('effects.update', { id: layer.id, effectId: effect.id, ...change })
}

/** One field of a card, as the inspector shows it. */
function FieldRow({ layer, effect, domain, name, field }: { layer: Layer; effect: Effect; domain: EffectDomain; name: string; field: EffectField }) {
  const timeMs = useEditor((s) => s.timeMs)
  const path = `${EFFECT_PREFIX[domain]}.${effect.id}.${name}`
  const text = label(name)
  if (field.kind === 'enum') {
    return (
      <Row label={text}>
        <SelectField
          label={text}
          value={String(effect[name])}
          options={field.options.map((o) => ({ value: o, label: CHOICE_LABELS[o] ?? label(o) }))}
          onCommit={(v) => void update(layer, effect, { values: { [name]: v } })}
        />
      </Row>
    )
  }
  if (field.kind === 'boolean') {
    return (
      <Row label="">
        <Toggle checked={effect[name] === true} onChange={(v) => void update(layer, effect, { values: { [name]: v } })} label={text} />
      </Row>
    )
  }
  // Number and colour fields animate: show the value at the playhead.
  const spec = propertiesOf(layer).find((p) => p.path === path)
  const value = spec ? evaluateProperty(layer, spec, timeMs - layer.startMs) : effect[name]
  const key = <KeyButton layer={layer} targets={[{ alias: path, path, value: value as number | string }]} label={text.toLowerCase()} />
  if (field.kind === 'color') {
    return (
      <Row label={text} keyButton={key}>
        <ColorField value={String(value)} bind={setter<string>(layer.id, path)} label={text} />
      </Row>
    )
  }
  const span = field.max !== undefined && field.min !== undefined ? field.max - field.min : 100
  const numberSpec = {
    value: Number(value),
    bind: setter<number>(layer.id, path),
    min: field.min,
    max: field.max,
    step: field.int ? 1 : span <= 4 ? 0.01 : span <= 50 ? 0.1 : 1,
    precision: field.int ? 0 : 2,
  }
  return (
    <Row label={<ScrubLabel text={text} spec={numberSpec} />} keyButton={key}>
      <NumberField spec={numberSpec} label={text} />
    </Row>
  )
}

function EffectCard({ layer, effect, domain, index, count, open, onToggle }: {
  layer: Layer
  effect: Effect
  domain: EffectDomain
  index: number
  count: number
  open: boolean
  onToggle: () => void
}) {
  const timeMs = useEditor((s) => s.timeMs)
  const def = findEffectDef(domain, effect.type)
  if (!def) return null
  const keyable: KeyTarget[] = Object.entries(def.fields)
    .filter(([, f]) => f.kind === 'number' || f.kind === 'color')
    .map(([name]) => {
      const path = `${EFFECT_PREFIX[domain]}.${effect.id}.${name}`
      const spec = propertiesOf(layer).find((p) => p.path === path)
      return { alias: path, path, value: (spec ? evaluateProperty(layer, spec, timeMs - layer.startMs) : effect[name]) as number | string }
    })
  const iconButton = 'rounded-md p-1 text-muted hover:bg-hover hover:text-ink'
  return (
    <div>
      <div className={`flex h-10 items-center gap-2 rounded-panel px-2.5 ${open ? 'active-tint' : 'bg-field hover:bg-hover'}`}>
        <button type="button" onClick={onToggle} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 text-left text-[13px] font-semibold">
          <Sparkles size={14} className={effect.enabled ? 'text-accent' : 'text-muted'} aria-hidden />
          <span className={`truncate ${effect.enabled ? '' : 'text-muted line-through'}`}>{def.label}</span>
        </button>
        <KeyButton layer={layer} targets={keyable} label={def.label.toLowerCase()} />
        <button type="button" onClick={onToggle} aria-label="Effect settings" title="Effect settings" className={iconButton}>
          <SlidersHorizontal size={13} />
        </button>
        <button
          type="button"
          onClick={() => void update(layer, effect, { enabled: !effect.enabled })}
          aria-label={effect.enabled ? 'Disable' : 'Enable'}
          title={effect.enabled ? 'Switch the effect off' : 'Switch the effect on'}
          className={iconButton}
        >
          {effect.enabled ? <Eye size={13} /> : <EyeOff size={13} />}
        </button>
        <button type="button" onClick={() => void update(layer, effect, { remove: true })} aria-label="Remove effect" title="Remove the effect" className={iconButton}>
          <Trash2 size={13} />
        </button>
      </div>
      {open && (
        <div className="mt-1.5 space-y-1.5 px-1 pb-1">
          <div className="flex items-center gap-1">
            <p className="flex-1 truncate text-[11px] text-muted" title={def.tagline}>
              {def.tagline}
            </p>
            <button type="button" disabled={index === 0} onClick={() => void update(layer, effect, { index: index - 1 })} aria-label="Move up" title="Apply earlier" className={`${iconButton} disabled:opacity-30`}>
              <ArrowUp size={12} />
            </button>
            <button
              type="button"
              disabled={index === count - 1}
              onClick={() => void update(layer, effect, { index: index + 1 })}
              aria-label="Move down"
              title="Apply later"
              className={`${iconButton} disabled:opacity-30`}
            >
              <ArrowDown size={12} />
            </button>
          </div>
          {Object.entries(def.fields)
            .filter(([name]) => !(name === 'color' && effect.source === 'text'))
            .map(([name, field]) => (
              <FieldRow key={name} layer={layer} effect={effect} domain={domain} name={name} field={field} />
            ))}
        </div>
      )}
    </div>
  )
}

/** The searchable list of a domain's effects, grouped by family. */
function EffectPicker({ domain, onPick, onClose }: { domain: EffectDomain; onPick: (def: EffectDef) => void; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('pointerdown', away)
    return () => window.removeEventListener('pointerdown', away)
  }, [onClose])
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const found = effectDefs(domain).filter((d) => words.every((w) => `${d.label} ${d.type} ${d.family} ${d.tagline}`.toLowerCase().includes(w)))
  return (
    <div ref={box} className="glass absolute top-full right-0 left-0 z-20 mt-1 max-h-[420px] overflow-auto rounded-panel p-1.5 shadow-xl">
      <label className="mb-1 flex h-9 items-center gap-2 rounded-lg bg-field px-2.5">
        <Search size={13} className="text-muted" aria-hidden />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
            if (e.key === 'Enter' && found[0]) onPick(found[0])
          }}
          placeholder="Search effects…"
          aria-label="Search effects"
          className="min-w-0 flex-1 bg-transparent text-[12px] outline-none"
        />
      </label>
      {EFFECT_FAMILIES.map((family) => {
        const list = found.filter((d) => d.family === family)
        return list.length === 0 ? null : (
          <div key={family}>
            <p className="px-2 pt-2 pb-1 text-[11px] text-muted">{family}</p>
            {list.map((d) => (
              <button key={d.type} type="button" onClick={() => onPick(d)} className="flex w-full flex-col items-start rounded-lg px-2 py-1.5 text-left hover:bg-hover">
                <span className="text-[12px] font-semibold">{d.label}</span>
                <span className="w-full truncate text-[11px] text-muted">{d.tagline}</span>
              </button>
            ))}
          </div>
        )
      })}
      {found.length === 0 && <p className="px-2 py-3 text-[12px] text-muted">No effect matches “{query}”.</p>}
    </div>
  )
}

function Stack({ layer, domain }: { layer: Layer; domain: EffectDomain }) {
  const stack = effectStack(layer, domain) ?? []
  const [open, setOpen] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const add = async (def: EffectDef) => {
    setPicking(false)
    const result = await run('effects.add', { id: layer.id, domain, type: def.type })
    if (result.ok) setOpen((result.value as { effectId: string }).effectId)
  }
  return (
    <Section title={DOMAIN_TITLE[domain]} count={stack.length}>
      {stack.map((effect, i) => (
        <EffectCard
          key={effect.id}
          layer={layer}
          effect={effect}
          domain={domain}
          index={i}
          count={stack.length}
          open={open === effect.id}
          onToggle={() => setOpen(open === effect.id ? null : effect.id)}
        />
      ))}
      <div className="relative">
        <button
          type="button"
          onClick={() => setPicking(!picking)}
          className="flex h-10 w-full items-center justify-center gap-1.5 rounded-panel border border-dashed border-line text-[12px] text-muted hover:bg-hover hover:text-ink"
        >
          <Plus size={13} aria-hidden />
          {domain === 'layer' ? 'Add layer effect' : 'Add text effect'}
        </button>
        {picking && <EffectPicker domain={domain} onPick={(d) => void add(d)} onClose={() => setPicking(false)} />}
      </div>
    </Section>
  )
}

export function EffectsPanel({ layer }: { layer: Layer }) {
  if (layer.kind === 'audio') return <p className="p-4 text-[12px] text-muted">Audio layers have no pixels for effects; the audio chain comes later.</p>
  return (
    <div>
      <Stack key={`${layer.id}-layer`} layer={layer} domain="layer" />
      {layer.kind === 'text' && <Stack key={`${layer.id}-text`} layer={layer} domain="text" />}
    </div>
  )
}
