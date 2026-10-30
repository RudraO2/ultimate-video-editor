import { bezierPoint, isCurved, type MotionKey, segmentOf, smoothTangents, type Vec2 } from './motionPath'
import type { Easing } from './schema'

/** Largest easing slope smoothing writes (a key may start or end up to 3 times the average speed). */
export const MAX_EASE_SLOPE = 3

const round6 = (n: number) => Math.round(n * 1e6) / 1e6

/** The SciPy pchip rule for the slope at an end of the data. */
function endSlope(h0: number, h1: number, d0: number, d1: number): number {
  const m = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1)
  if (Math.sign(m) !== Math.sign(d0)) return 0
  if (Math.sign(d0) !== Math.sign(d1) && Math.abs(m) > 3 * Math.abs(d0)) return 3 * d0
  return m
}

/**
 * Monotone cubic (PCHIP, Fritsch-Carlson/Butland) slopes of values `vs` over
 * times `ts`: one per point, zero at an extremum, and never so steep that the
 * Hermite curve overshoots the data. Two points both get the chord slope.
 */
export function monotoneSlopes(ts: readonly number[], vs: readonly number[]): number[] {
  const n = ts.length
  if (n < 2) return ts.map(() => 0)
  const h: number[] = []
  const d: number[] = []
  for (let k = 0; k + 1 < n; k++) {
    const dt = (ts[k + 1] as number) - (ts[k] as number)
    h.push(dt)
    d.push(((vs[k + 1] as number) - (vs[k] as number)) / dt)
  }
  if (n === 2) return [d[0] as number, d[0] as number]
  const m: number[] = new Array(n).fill(0)
  for (let k = 1; k + 1 < n; k++) {
    const dPrev = d[k - 1] as number
    const dNext = d[k] as number
    if (dPrev * dNext <= 0) continue
    const w1 = 2 * (h[k] as number) + (h[k - 1] as number)
    const w2 = (h[k] as number) + 2 * (h[k - 1] as number)
    m[k] = (w1 + w2) / (w1 / dPrev + w2 / dNext)
  }
  m[0] = endSlope(h[0] as number, h[1] as number, d[0] as number, d[1] as number)
  m[n - 1] = endSlope(h[n - 2] as number, h[n - 3] as number, d[n - 2] as number, d[n - 3] as number)
  return m
}

/**
 * The easing of one segment whose progress runs with slope `e0` at its start
 * and `e1` at its end (1 is the average speed). Both near 1 is linear;
 * otherwise a Bézier with its x handles on the thirds (to 6 places), so x(s) = s and the
 * curve is the cubic Hermite with those end slopes.
 */
export function smoothEasing(e0: number, e1: number): Easing {
  if (Math.abs(e0 - 1) < 1e-6 && Math.abs(e1 - 1) < 1e-6) return 'linear'
  return { type: 'bezier', x1: round6(1 / 3), y1: round6(e0 / 3), x2: round6(2 / 3), y2: round6(1 - e1 / 3) }
}

const clampSlope = (e: number) => Math.min(MAX_EASE_SLOPE, Math.max(0, e))

/**
 * Easings (one per segment) that make a numeric track flow through its keys:
 * the value's speed is the same either side of each inner key.
 */
export function scalarEasings(ts: readonly number[], vs: readonly number[]): Easing[] {
  const m = monotoneSlopes(ts, vs)
  const out: Easing[] = []
  for (let i = 0; i + 1 < ts.length; i++) {
    const dv = (vs[i + 1] as number) - (vs[i] as number)
    if (Math.abs(dv) < 1e-9) {
      out.push('linear')
      continue
    }
    const dt = (ts[i + 1] as number) - (ts[i] as number)
    out.push(smoothEasing(clampSlope(((m[i] as number) * dt) / dv), clampSlope(((m[i + 1] as number) * dt) / dv)))
  }
  return out
}

/**
 * Catmull-Rom handles for a run of motion keys (3 or more): each key flows
 * through its neighbours. The first key's `in` and the last key's `out` belong
 * to segments outside the run and are kept. Fewer than 3 keys: unchanged.
 */
export function pathHandles(rows: readonly MotionKey[]): MotionKey[] {
  if (rows.length < 3) return rows.map((r) => ({ ...r }))
  const last = rows.length - 1
  return rows.map((row, i) => {
    const prev = rows[i - 1]
    const next = rows[i + 1]
    const tangents = smoothTangents(prev ? [prev.x, prev.y] : null, [row.x, row.y], next ? [next.x, next.y] : null)
    return { ...row, in: i === 0 ? row.in : tangents.in, out: i === last ? row.out : tangents.out }
  })
}

/** The length of the segment between two motion keys. */
function segmentLength(a: MotionKey, b: MotionKey): number {
  const seg = segmentOf(a, b)
  if (!isCurved(a, b)) return Math.hypot(seg.p3[0] - seg.p0[0], seg.p3[1] - seg.p0[1])
  let length = 0
  let prev: Vec2 = seg.p0
  for (let k = 1; k <= 64; k++) {
    const point = bezierPoint(seg, k / 64)
    length += Math.hypot(point[0] - prev[0], point[1] - prev[1])
    prev = point
  }
  return length
}

/**
 * Easings (one per segment) that make a motion path flow: the speed along the
 * path is the same either side of each inner key. The easing of a segment is
 * the progress along its Bézier, so its slope is the wanted path speed over
 * the speed of the curve at that end (three times the handle's length).
 */
export function pathEasings(rows: readonly MotionKey[]): Easing[] {
  const lengths: number[] = []
  for (let i = 0; i + 1 < rows.length; i++) lengths.push(segmentLength(rows[i] as MotionKey, rows[i + 1] as MotionKey))
  const arc: number[] = [0]
  for (const length of lengths) arc.push((arc.at(-1) as number) + length)
  const m = monotoneSlopes(
    rows.map((r) => r.t),
    arc,
  )
  const out: Easing[] = []
  for (let i = 0; i + 1 < rows.length; i++) {
    const a = rows[i] as MotionKey
    const b = rows[i + 1] as MotionKey
    const seg = segmentOf(a, b)
    const dt = b.t - a.t
    const length = lengths[i] as number
    const speed = (d: number) => (d > 1e-9 ? d : length > 1e-9 ? length : 1)
    const d0 = speed(3 * Math.hypot(seg.p1[0] - seg.p0[0], seg.p1[1] - seg.p0[1]))
    const d1 = speed(3 * Math.hypot(seg.p3[0] - seg.p2[0], seg.p3[1] - seg.p2[1]))
    out.push(smoothEasing(clampSlope(((m[i] as number) * dt) / d0), clampSlope(((m[i + 1] as number) * dt) / d1)))
  }
  return out
}
