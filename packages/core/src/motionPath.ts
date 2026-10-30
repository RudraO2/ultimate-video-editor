import { ease } from './easing'
import { KEY_EPSILON_MS } from './keys'
import type { Easing, Keyframe, Layer } from './schema'

export type Vec2 = [number, number]

/** One stop of a motion path: the x key's time and easing, both axis values and the handles on the x key. */
export interface MotionKey {
  t: number
  x: number
  y: number
  ease: Easing
  /** Handle toward the previous key, px relative to this key; null when absent. */
  in: Vec2 | null
  /** Handle toward the next key, px relative to this key; null when absent. */
  out: Vec2 | null
}

/** A cubic Bézier in absolute comp space. */
export interface MotionSegment {
  p0: Vec2
  p1: Vec2
  p2: Vec2
  p3: Vec2
}

/** The `y` key that pairs with an x key (within the key epsilon), if it is numeric. */
function partnerOf(xKey: Keyframe, ys: readonly Keyframe[]): Keyframe | undefined {
  let best: Keyframe | undefined
  for (const k of ys) {
    const gap = Math.abs(k.t - xKey.t)
    if (gap < KEY_EPSILON_MS && (!best || gap < Math.abs(best.t - xKey.t))) best = k
  }
  return best && typeof best.v === 'number' ? best : undefined
}

/**
 * The motion path of a layer: one row per numeric `transform.x` key that has a
 * numeric `transform.y` partner, sorted by time. Handles come from the x key.
 */
export function motionKeysOf(layer: Layer): MotionKey[] {
  const xs = layer.animations['transform.x'] ?? []
  const ys = layer.animations['transform.y'] ?? []
  const rows: MotionKey[] = []
  for (const k of xs) {
    if (typeof k.v !== 'number') continue
    const partner = partnerOf(k, ys)
    if (!partner || typeof partner.v !== 'number') continue
    rows.push({
      t: k.t,
      x: k.v,
      y: partner.v,
      ease: k.ease,
      in: k.spatial?.in ?? null,
      out: k.spatial?.out ?? null,
    })
  }
  return rows.sort((a, b) => a.t - b.t)
}

/** True when the layer has two or more motion keys. */
export function hasMotionPath(layer: Layer): boolean {
  return motionKeysOf(layer).length >= 2
}

/** True when some `transform.x` key carries a handle; cheap, builds no rows. */
export function hasCurves(layer: Layer): boolean {
  const xs = layer.animations['transform.x']
  if (!xs) return false
  return xs.some((k) => k.spatial !== undefined && (k.spatial.in !== null || k.spatial.out !== null))
}

/**
 * The cubic between two motion keys. A missing handle defaults to a third of
 * the chord toward the other key.
 */
export function segmentOf(a: MotionKey, b: MotionKey): MotionSegment {
  const p0: Vec2 = [a.x, a.y]
  const p3: Vec2 = [b.x, b.y]
  const p1: Vec2 = a.out ? [a.x + a.out[0], a.y + a.out[1]] : [a.x + (b.x - a.x) / 3, a.y + (b.y - a.y) / 3]
  const p2: Vec2 = b.in ? [b.x + b.in[0], b.y + b.in[1]] : [b.x + (a.x - b.x) / 3, b.y + (a.y - b.y) / 3]
  return { p0, p1, p2, p3 }
}

/** True when the segment between two keys has a handle of its own (a.out or b.in). */
export function isCurved(a: MotionKey, b: MotionKey): boolean {
  return a.out !== null || b.in !== null
}

/** The point of a cubic at parameter `u` (0 to 1). */
export function bezierPoint(seg: MotionSegment, u: number): Vec2 {
  const v = 1 - u
  const w0 = v * v * v
  const w1 = 3 * v * v * u
  const w2 = 3 * v * u * u
  const w3 = u * u * u
  return [
    w0 * seg.p0[0] + w1 * seg.p1[0] + w2 * seg.p2[0] + w3 * seg.p3[0],
    w0 * seg.p0[1] + w1 * seg.p1[1] + w2 * seg.p2[1] + w3 * seg.p3[1],
  ]
}

/**
 * The position along a curved motion path at layer time `t`, or undefined when
 * per-axis sampling should apply: no handles, `t` outside the keys, a straight
 * segment, or a key of either track inside the segment that is not paired.
 * The eased time is the curve parameter; the curve is not reparametrised.
 */
export function motionPointAt(layer: Layer, t: number): Vec2 | undefined {
  if (!hasCurves(layer)) return undefined
  const rows = motionKeysOf(layer)
  for (let i = 0; i + 1 < rows.length; i++) {
    const a = rows[i] as MotionKey
    const b = rows[i + 1] as MotionKey
    if (t < a.t) return undefined
    if (t >= b.t) continue
    if (!isCurved(a, b)) return undefined
    const inside = (k: Keyframe) => k.t > a.t + KEY_EPSILON_MS && k.t < b.t - KEY_EPSILON_MS
    if ((layer.animations['transform.x'] ?? []).some(inside) || (layer.animations['transform.y'] ?? []).some(inside)) {
      return undefined
    }
    const u = ease(a.ease, (t - a.t) / (b.t - a.t))
    return bezierPoint(segmentOf(a, b), u)
  }
  return undefined
}

/**
 * Handles for a parabolic hop from `a` to `b`: the cubic form of a quadratic
 * Bézier whose control point sits halfway across, so x moves at constant speed.
 * A positive `arc` peaks that many px above the higher end (y is down), a
 * negative one sags that far below the lower end, and 0 is a straight line.
 */
export function arcHandles(a: Vec2, b: Vec2, arc: number): { out: Vec2; in: Vec2 } {
  const cx = (a[0] + b[0]) / 2
  let cy = (a[1] + b[1]) / 2
  if (arc > 0) {
    const p = Math.min(a[1], b[1]) - arc
    cy = p - Math.sqrt((a[1] - p) * (b[1] - p))
  } else if (arc < 0) {
    const p = Math.max(a[1], b[1]) - arc
    cy = p + Math.sqrt((a[1] - p) * (b[1] - p))
  }
  const k = 2 / 3
  return { out: [k * (cx - a[0]), k * (cy - a[1])], in: [k * (cx - b[0]), k * (cy - b[1])] }
}

/** Splits a cubic at `u` with de Casteljau; the halves together trace the original. */
export function splitSegment(seg: MotionSegment, u: number): [MotionSegment, MotionSegment] {
  const lerp = (a: Vec2, b: Vec2): Vec2 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]
  const ab = lerp(seg.p0, seg.p1)
  const bc = lerp(seg.p1, seg.p2)
  const cd = lerp(seg.p2, seg.p3)
  const abc = lerp(ab, bc)
  const bcd = lerp(bc, cd)
  const mid = lerp(abc, bcd)
  return [
    { p0: seg.p0, p1: ab, p2: abc, p3: mid },
    { p0: mid, p1: bcd, p2: cd, p3: seg.p3 },
  ]
}

/**
 * Catmull-Rom handles for a key between `prev` and `next`: out is a sixth of
 * the chord across it, in is its mirror. The side that faces a missing
 * neighbour is null.
 */
export function smoothTangents(prev: Vec2 | null, cur: Vec2, next: Vec2 | null): { in: Vec2 | null; out: Vec2 | null } {
  const before = prev ?? cur
  const after = next ?? cur
  const out: Vec2 = [(after[0] - before[0]) / 6, (after[1] - before[1]) / 6]
  return {
    in: prev ? [-out[0], -out[1]] : null,
    out: next ? out : null,
  }
}

/**
 * New handles (out relative to p0, in relative to p3) that make the curve pass
 * through `point` at parameter `u` (clamped to 0.1 to 0.9). Both inner control
 * points move by the same offset, which keeps the rest of the shape's character.
 */
export function bendHandles(seg: MotionSegment, u: number, point: Vec2): { out: Vec2; in: Vec2 } {
  const s = Math.min(0.9, Math.max(0.1, u))
  const now = bezierPoint(seg, s)
  const k = 3 * s * (1 - s)
  const dx = (point[0] - now[0]) / k
  const dy = (point[1] - now[1]) / k
  return {
    out: [seg.p1[0] + dx - seg.p0[0], seg.p1[1] + dy - seg.p0[1]],
    in: [seg.p2[0] + dx - seg.p3[0], seg.p2[1] + dy - seg.p3[1]],
  }
}
