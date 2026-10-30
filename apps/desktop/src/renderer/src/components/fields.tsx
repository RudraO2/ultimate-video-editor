import { ColorSchema, KEY_EPSILON_MS, type Layer } from '@uve/core'
import { Diamond } from 'lucide-react'
import { type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { beginGesture, type Gesture, run, useEditor } from '../store'

// Inspector fields. Every change goes through a command: typing commits once,
// dragging a label or a colour picker is one gesture, and so one undo step.

/** The command that sets a value, as [name, input]. */
export type Bind<T> = (value: T) => [name: string, input: unknown]

export interface NumberSpec {
  value: number
  bind: Bind<number>
  /** Change per pixel when dragging the label, and per arrow key press, in shown units. */
  step?: number
  min?: number
  max?: number
  /** Decimals shown. */
  precision?: number
  /** Shown value = value × factor, e.g. 100 for percentages or 0.001 for ms shown as seconds. */
  factor?: number
  suffix?: string
}

const inputClass =
  'h-7 w-full min-w-0 rounded-lg bg-field px-2 text-[12px] tabular-nums outline-none hover:bg-hover focus:ring-1 focus:ring-accent'

function format(n: number, precision: number): string {
  return String(Number(n.toFixed(precision)))
}

function clamp(n: number, { min, max }: Pick<NumberSpec, 'min' | 'max'>): number {
  return Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, n))
}

/**
 * A number input: Enter or leaving the field commits, Escape cancels, arrow
 * keys step. With `axis`, a small letter inside the field can be dragged
 * sideways to scrub the value.
 */
export function NumberField({ spec, label, axis }: { spec: NumberSpec; label: string; axis?: string }) {
  const { value, bind, step = 1, precision = 2, factor = 1, suffix } = spec
  const [draft, setDraft] = useState<string | null>(null)
  const shown = value * factor

  const commit = (text: string) => {
    setDraft(null)
    const n = Number(text.trim())
    if (text.trim() === '' || !Number.isFinite(n)) return
    const next = clamp(n, spec)
    if (Math.abs(next - shown) > 1e-9) void run(...bind(next / factor))
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') e.currentTarget.blur()
    else if (e.key === 'Escape') {
      setDraft(null)
      e.currentTarget.blur()
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const next = clamp(shown + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1), spec)
      setDraft(format(next, precision))
      void run(...bind(next / factor))
    }
  }

  return (
    <div className="relative min-w-0 flex-1">
      <input
        aria-label={label}
        className={`${inputClass} ${suffix ? 'pr-6' : ''} ${axis ? 'pl-5 font-mono text-[11px]' : ''}`}
        value={draft ?? format(shown, precision)}
        onFocus={(e) => {
          setDraft(format(shown, precision))
          e.currentTarget.select()
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => {
          if (draft !== null) commit(e.currentTarget.value)
        }}
        onKeyDown={onKeyDown}
      />
      {axis && (
        <span
          onPointerDown={(e) => startScrub(e, label, spec)}
          className="absolute top-1.5 left-2 cursor-ew-resize text-[10px] text-muted select-none hover:text-ink"
          title="Drag to change"
        >
          {axis}
        </span>
      )}
      {suffix && <span className="pointer-events-none absolute top-1.5 right-2 text-[10px] text-muted">{suffix}</span>}
    </div>
  )
}

/** Starts dragging a number sideways (Shift: ×10, Alt: ×0.1), as one gesture. */
function startScrub(e: ReactPointerEvent<HTMLSpanElement>, text: string, spec: NumberSpec) {
  if (e.button !== 0) return
  e.preventDefault()
  const el = e.currentTarget
  const { value, bind, step = 1, factor = 1 } = spec
  const from = e.clientX
  let gesture: Gesture | null = null
  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - from
    if (!gesture && Math.abs(dx) < 2) return
    gesture ??= beginGesture(`Change ${text.toLowerCase()}`)
    const speed = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1
    gesture.request(...bind(clamp(value * factor + dx * step * speed, spec) / factor))
  }
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

/** A row label that changes its number when dragged sideways (Shift: ×10, Alt: ×0.1). */
export function ScrubLabel({ text, spec }: { text: string; spec: NumberSpec }) {
  return (
    <span onPointerDown={(e) => startScrub(e, text, spec)} className="cursor-ew-resize truncate text-muted select-none hover:text-ink" title="Drag to change">
      {text}
    </span>
  )
}

/** One animatable value that a key button keys. */
export interface KeyTarget {
  alias: string
  path: string
  value: number | string
}

/**
 * The diamond at the end of an animatable row; it keys every value in the row
 * together. Filled: a key sits at the playhead (click removes it). Outlined
 * in the brand colour: the row is animated (click adds a key here). Dim: not
 * animated (click starts animating it).
 */
export function KeyButton({ layer, targets, label }: { layer: Layer; targets: KeyTarget[]; label?: string }) {
  const timeMs = useEditor((s) => s.timeMs)
  const t = timeMs - layer.startMs
  const animated = targets.some(({ path }) => (layer.animations[path]?.length ?? 0) > 0)
  const here = targets.some(({ path }) => (layer.animations[path] ?? []).some((k) => Math.abs(k.t - t) < KEY_EPSILON_MS))
  const toggle = () => {
    const calls = targets.map(({ alias, path, value }) =>
      here
        ? (layer.animations[path] ?? []).some((k) => Math.abs(k.t - t) < KEY_EPSILON_MS)
          ? { command: 'keyframes.remove', input: { id: layer.id, path: alias, times: [t] } }
          : null
        : { command: 'keyframes.set', input: { id: layer.id, path: alias, keys: [{ t, v: value }], mode: 'merge' } },
    )
    void run('api.batch', { calls: calls.filter((c) => c !== null) })
  }
  const what = label ? ` ${label}` : ''
  const title = here ? `Remove the${what} key at the playhead` : animated ? `Add ${/^[aeiou]/i.test(label ?? '') ? 'an' : 'a'}${what} key at the playhead` : `Animate${what}: add the first key at the playhead`
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={title}
      title={title}
      className={`flex size-[18px] shrink-0 items-center justify-center rounded ${
        here || animated ? 'text-accent' : 'text-muted/40 hover:text-muted'
      }`}
    >
      <Diamond size={11} fill={here ? 'currentColor' : 'none'} />
    </button>
  )
}

/** A labelled inspector row. `keyButton` goes at the end of the row. */
export function Row({ label, keyButton, children }: { label: ReactNode; keyButton?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[62px_1fr_18px] items-center gap-x-1.5">
      <div className="min-w-0 truncate text-[11px] text-muted">{label}</div>
      <div className="flex min-w-0 items-center gap-1.5">{children}</div>
      <div className="flex justify-center">{keyButton}</div>
    </div>
  )
}

/** Free text: Enter (Ctrl+Enter when multiline) or leaving the field commits; Escape cancels. */
export function TextField({
  value,
  onCommit,
  label,
  multiline,
  onSelectText,
}: {
  value: string
  onCommit: (text: string) => void
  label: string
  multiline?: boolean
  /** Reports the selected part (string offsets) as the user selects. */
  onSelectText?: (start: number, end: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft !== null && draft !== value) onCommit(draft)
    setDraft(null)
  }
  const props = {
    'aria-label': label,
    value: draft ?? value,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: commit,
    onSelect: (e: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) =>
      onSelectText?.(e.currentTarget.selectionStart ?? 0, e.currentTarget.selectionEnd ?? 0),
    onKeyDown: (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key === 'Escape') {
        setDraft(null)
        e.currentTarget.blur()
      } else if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        e.currentTarget.blur()
      }
    },
  }
  return multiline ? (
    <textarea {...props} rows={3} className={`${inputClass} h-auto resize-y py-1 font-sans`} />
  ) : (
    <input {...props} className={inputClass} />
  )
}

export function SelectField<T extends string | number>({
  value,
  options,
  onCommit,
  label,
}: {
  value: T
  options: readonly { value: T; label: string }[]
  onCommit: (value: T) => void
  label: string
}) {
  return (
    <select
      aria-label={label}
      value={String(value)}
      onChange={(e) => {
        const picked = options.find((o) => String(o.value) === e.target.value)
        if (picked) onCommit(picked.value)
      }}
      className={inputClass}
    >
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5 text-xs">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-accent" />
      {label}
    </label>
  )
}

/**
 * A colour swatch with the system picker and a hex field. Picking is one
 * gesture (live, one undo step); the hex field also takes #rrggbbaa.
 */
export function ColorField({ value, bind, label }: { value: string; bind: Bind<string>; label: string }) {
  const [draft, setDraft] = useState<string | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const alpha = value.length === 9 ? value.slice(7) : ''

  // React's onChange fires on every input; the native change event marks the end of picking.
  useEffect(() => {
    const el = picker.current
    if (!el) return
    const end = () => {
      void gesture.current?.end()
      gesture.current = null
    }
    el.addEventListener('change', end)
    el.addEventListener('blur', end)
    return () => {
      el.removeEventListener('change', end)
      el.removeEventListener('blur', end)
      end()
    }
  }, [])

  const commitText = () => {
    if (draft !== null && ColorSchema.safeParse(draft).success && draft !== value) void run(...bind(draft))
    setDraft(null)
  }

  return (
    <>
      <label className="relative size-7 shrink-0 cursor-pointer overflow-hidden rounded-lg ring-1 ring-line" style={{ background: value }}>
        <input
          ref={picker}
          type="color"
          aria-label={`${label} picker`}
          value={value.slice(0, 7)}
          onChange={(e) => {
            gesture.current ??= beginGesture(`Change ${label.toLowerCase()}`)
            gesture.current.request(...bind(e.target.value + alpha))
          }}
          className="absolute inset-0 cursor-pointer opacity-0"
        />
      </label>
      <input
        aria-label={label}
        value={draft ?? value}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitText}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            setDraft(null)
            e.currentTarget.blur()
          }
        }}
        className={`${inputClass} font-mono`}
      />
    </>
  )
}
