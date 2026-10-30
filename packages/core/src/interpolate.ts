import { ease } from './easing'
import type { Keyframe, KeyValue } from './schema'
import { isSvgPath, mixSvgPaths } from './svgPath'

export type Rgba = [r: number, g: number, b: number, a: number]

/** Parses `#rrggbb` or `#rrggbbaa` into 0–255 channels; returns null for anything else. */
export function parseColor(value: string): Rgba | null {
  const match = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(value)
  if (!match) return null
  const rgb = Number.parseInt(match[1] ?? '', 16)
  const alpha = match[2] ? Number.parseInt(match[2], 16) : 255
  return [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255, alpha]
}

/** Formats channels as `#rrggbb`, adding the alpha byte only when it is not opaque. */
export function formatColor(color: Rgba): string {
  const bytes = color.map((c) => Math.round(Math.min(255, Math.max(0, c))))
  const hex = (n: number | undefined) => (n ?? 0).toString(16).padStart(2, '0')
  const alpha = bytes[3] === 255 ? '' : hex(bytes[3])
  return `#${hex(bytes[0])}${hex(bytes[1])}${hex(bytes[2])}${alpha}`
}

/**
 * Mixes two key values at eased progress `p`: numbers and equal-length vectors
 * blend linearly, hex colours blend per channel, paths with the same commands
 * morph point by point, and anything else switches at the end.
 */
export function mix(a: KeyValue, b: KeyValue, p: number): KeyValue {
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * p
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    return a.map((x, i) => x + ((b[i] ?? x) - x) * p)
  }
  if (typeof a === 'string' && typeof b === 'string') {
    const ca = parseColor(a)
    const cb = parseColor(b)
    if (ca && cb) return formatColor(ca.map((x, i) => x + ((cb[i] ?? x) - x) * p) as Rgba)
    if (isSvgPath(a) && isSvgPath(b)) {
      const morph = mixSvgPaths(a, b, p)
      if (morph !== null) return morph
    }
  }
  return p < 1 ? a : b
}

/**
 * The value of a keyframe track at time `t` (ms from the layer start).
 * Keys must be sorted by time. Before the first key the first value holds,
 * after the last key the last value holds.
 */
export function sampleKeys(keys: readonly Keyframe[], t: number): KeyValue | undefined {
  const first = keys[0]
  const last = keys[keys.length - 1]
  if (!first || !last) return undefined
  if (t <= first.t) return first.v
  if (t >= last.t) return last.v

  // Binary search for the segment keys[lo] .. keys[hi] that contains t.
  let lo = 0
  let hi = keys.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if ((keys[mid]?.t ?? 0) <= t) lo = mid
    else hi = mid
  }
  const a = keys[lo] as Keyframe
  const b = keys[hi] as Keyframe
  const span = b.t - a.t
  const p = span > 0 ? (t - a.t) / span : 1
  return mix(a.v, b.v, ease(a.ease, p))
}
