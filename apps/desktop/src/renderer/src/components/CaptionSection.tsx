import { type CaptionStateName, graphemes, type Layer } from '@uve/core'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { run } from '../store'
import { ColorField, NumberField, type NumberSpec, Row, ScrubLabel, Toggle } from './fields'

// The Caption section of a text layer's Design tab: make the layer a
// word-synced caption, time its words, and set how unread, focus and read
// words look. Every change is caption.set or layer.patch, one undo step.

type TextLayer = Extract<Layer, { kind: 'text' }>

const STATES: { name: CaptionStateName; label: string }[] = [
  { name: 'unread', label: 'Unread' },
  { name: 'focus', label: 'Focus' },
  { name: 'read', label: 'Read' },
]

const patch = (layer: TextLayer, path: string, value: unknown) => run('layer.patch', { id: layer.id, ops: [{ op: 'set', path, value }] })

function StateRow({ layer, name, label }: { layer: TextLayer; name: CaptionStateName; label: string }) {
  const state = layer.caption?.states[name]
  if (!state) return null
  const base = `caption.states.${name}`
  const opacity: NumberSpec = {
    value: state.style.opacity ?? 1,
    bind: (v) => ['layer.patch', { id: layer.id, ops: [{ op: 'set', path: `${base}.style.opacity`, value: v }] }],
    min: 0,
    max: 1,
    step: 0.01,
    precision: 2,
    factor: 100,
    suffix: '%',
  }
  const scale: NumberSpec = {
    value: state.scale,
    bind: (v) => ['layer.patch', { id: layer.id, ops: [{ op: 'set', path: `${base}.scale`, value: v }] }],
    min: 0.1,
    max: 4,
    step: 0.01,
    precision: 2,
    factor: 100,
    suffix: '%',
  }
  return (
    <div className="space-y-1.5 rounded-panel bg-field/40 p-2">
      <p className="text-[11px] font-semibold text-muted">{label}</p>
      <Row label="Colour">
        <ColorField value={state.style.color ?? layer.style.color} bind={(v) => ['layer.patch', { id: layer.id, ops: [{ op: 'set', path: `${base}.style.color`, value: v }] }]} label={`${label} colour`} />
      </Row>
      <Row label={<ScrubLabel text="Opacity" spec={opacity} />}>
        <NumberField spec={opacity} label={`${label} opacity`} />
      </Row>
      <Row label={<ScrubLabel text="Scale" spec={scale} />}>
        <NumberField spec={scale} label={`${label} scale`} />
      </Row>
      <Row label="Pill">
        {state.style.highlight ? (
          <>
            <ColorField
              value={state.style.highlight.color}
              bind={(v) => ['layer.patch', { id: layer.id, ops: [{ op: 'set', path: `${base}.style.highlight.color`, value: v }] }]}
              label={`${label} pill`}
            />
            <button type="button" onClick={() => void patch(layer, `${base}.style.highlight`, null)} className="rounded-lg px-1.5 text-[11px] text-muted hover:bg-hover hover:text-ink">
              None
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => void patch(layer, `${base}.style.highlight`, { color: '#F5B843', radius: 10, paddingX: 10, paddingY: 4 })}
            className="rounded-lg px-2 py-1 text-[11px] text-muted hover:bg-hover hover:text-ink"
          >
            Add a pill
          </button>
        )}
      </Row>
    </div>
  )
}

export function CaptionSection({ layer }: { layer: TextLayer }) {
  const [open, setOpen] = useState(true)
  const Chevron = open ? ChevronDown : ChevronRight
  const caption = layer.caption
  const chars = graphemes(layer.text)
  const ms = (field: 'startMs' | 'endMs', index: number, value: number): NumberSpec => ({
    value,
    bind: (v) => ['layer.patch', { id: layer.id, ops: [{ op: 'set', path: `caption.cues[${index}].${field}`, value: Math.max(0, v) }] }],
    min: 0,
    step: 0.01,
    precision: 2,
    factor: 0.001,
    suffix: 's',
  })
  return (
    <section className="border-b border-line px-4 py-1 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex h-10 w-full items-center gap-1.5 text-[11px] font-semibold tracking-wider text-muted uppercase hover:text-ink"
      >
        <Chevron size={13} aria-hidden />
        Caption
        {caption && <span className="font-normal normal-case">{caption.cues.length} words</span>}
      </button>
      {open && (
        <div className="space-y-1.5 pb-3">
          {!caption ? (
            <button
              type="button"
              onClick={() => void run('caption.set', { id: layer.id, even: { unit: 'word' } })}
              className="flex h-8 w-full items-center justify-center rounded-lg border border-dashed border-line text-[12px] text-muted hover:bg-hover hover:text-ink"
              title="Each word gets its turn, spread evenly over the layer; then time them below"
            >
              Make it a caption
            </button>
          ) : (
            <>
              <div className="max-h-48 space-y-1 overflow-auto">
                {caption.cues.map((cue, i) => (
                  <div key={cue.id} className="grid grid-cols-[1fr_72px_72px] items-center gap-1">
                    <span className="truncate text-[12px]" title={`Characters ${cue.start}–${cue.end}`}>
                      {chars.slice(cue.start, cue.end).join('')}
                    </span>
                    <NumberField spec={ms('startMs', i, cue.startMs)} label={`Word ${i + 1} start`} />
                    <NumberField spec={ms('endMs', i, cue.endMs)} label={`Word ${i + 1} end`} />
                  </div>
                ))}
              </div>
              <div className="flex gap-1">
                <button type="button" onClick={() => void run('caption.set', { id: layer.id, even: { unit: 'word' } })} className="flex-1 rounded-lg py-1 text-[11px] text-muted hover:bg-hover hover:text-ink">
                  Spread evenly
                </button>
                <button type="button" onClick={() => void run('caption.set', { id: layer.id, remove: true })} className="flex-1 rounded-lg py-1 text-[11px] text-muted hover:bg-hover hover:text-ink">
                  Plain text
                </button>
              </div>
              {STATES.map((s) => (
                <StateRow key={s.name} layer={layer} name={s.name} label={s.label} />
              ))}
              <Row label="Glide">
                <Toggle checked={caption.motion.travel} onChange={(v) => void patch(layer, 'caption.motion.travel', v)} label="One pill glides between words" />
              </Row>
            </>
          )}
        </div>
      )}
    </section>
  )
}
