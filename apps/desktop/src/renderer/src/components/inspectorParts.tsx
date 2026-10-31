import type { Layer } from '@uve/core'
import { ChevronDown, ChevronRight } from '../icons'
import { type ReactNode, useState } from 'react'
import { findLayer, propertyEdit, run, useEditor } from '../store'
import { type Bind, ColorField, KeyButton, NumberField, type NumberSpec, Row, ScrubLabel } from './fields'

// The small pieces every inspector section is built from: a collapsible
// section, bindings of animatable and plain fields to commands, and rows of
// numbers or colours with their key diamonds.

/** A collapsible inspector section; `action` sits at the right of its title, such as a key-all diamond. */
export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(true)
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <section className="border-b border-line px-4 py-1 last:border-b-0">
      <div className="flex h-10 items-center gap-1.5">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex flex-1 items-center gap-1.5 text-[11px] font-semibold tracking-wider text-muted uppercase hover:text-ink"
        >
          <Chevron size={13} aria-hidden />
          {title}
        </button>
        {action}
      </div>
      {open && <div className="space-y-1.5 pb-3">{children}</div>}
    </section>
  )
}

/** The command for an animatable property, looked up when the edit happens (see propertyEdit). */
export function setter<T extends number | string>(layerId: string, alias: string, path: string): Bind<T> {
  return (value) => {
    const layer = findLayer(useEditor.getState().project, layerId)
    return layer ? propertyEdit(layer, alias, path, value) : ['layer.set', { id: layerId, values: { [alias]: value } }]
  }
}

/** Sets a field that is not animatable, such as the name or the font. */
export function patch(id: string, path: string, value: unknown) {
  return run('layer.patch', { id, ops: [{ op: 'set', path, value }] })
}

export type PropProps = { layer: Layer; alias: string; path: string; label: string }

/** An animatable number: key diamond, draggable label and input. */
export function NumberProp({ layer, alias, path, label, value, ...spec }: PropProps & Omit<NumberSpec, 'bind'>) {
  const full: NumberSpec = { value, bind: setter<number>(layer.id, alias, path), ...spec }
  return (
    <Row
      label={<ScrubLabel text={label} spec={full} />}
      keyButton={<KeyButton layer={layer} targets={[{ alias, path, value }]} label={label.toLowerCase()} />}
    >
      <NumberField spec={full} label={label} />
    </Row>
  )
}

/** An animatable colour. */
export function ColorProp({ layer, alias, path, label, value }: PropProps & { value: string }) {
  return (
    <Row label={label} keyButton={<KeyButton layer={layer} targets={[{ alias, path, value }]} label={label.toLowerCase()} />}>
      <ColorField value={value} bind={setter<string>(layer.id, alias, path)} label={label} />
    </Row>
  )
}

export interface Axis {
  axis: string
  alias: string
  path: string
  value: number
}

/** A row of one to three numbers (X, Y and in a world Z), keyed together by the diamond at its end. */
export function AxisRow({ layer, label, axes, spec, hint }: { layer: Layer; label: string; axes: Axis[]; spec: Omit<NumberSpec, 'value' | 'bind'>; hint?: string }) {
  return (
    <Row label={hint ? <span title={hint}>{label}</span> : label} keyButton={<KeyButton layer={layer} targets={axes} label={label.toLowerCase()} />}>
      {axes.map(({ axis, alias, path, value }) => (
        <NumberField
          key={alias}
          axis={axis}
          label={axes.length > 1 ? `${label} ${axis}` : label}
          // Three fields to a row (a world's X, Y, Z) leave no room for a unit after the number.
          spec={{ ...spec, ...(axes.length > 2 ? { suffix: undefined } : {}), value, bind: setter<number>(layer.id, alias, path) }}
        />
      ))}
    </Row>
  )
}

/** A switch for a section header. */
export function Switch({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={label}
      onClick={() => onChange(!on)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${on ? 'bg-accent' : 'bg-field'}`}
    >
      <span className={`absolute top-0.5 size-4 rounded-full bg-ink transition-[left] ${on ? 'left-[18px]' : 'left-0.5'}`} />
    </button>
  )
}
