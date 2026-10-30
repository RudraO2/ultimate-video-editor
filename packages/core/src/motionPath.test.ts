import { describe, expect, it } from 'vitest'
import { ease } from './easing'
import {
  arcHandles,
  bendHandles,
  bezierPoint,
  hasCurves,
  hasMotionPath,
  isCurved,
  type MotionKey,
  motionKeysOf,
  motionPointAt,
  segmentOf,
  smoothTangents,
  splitSegment,
  type Vec2,
} from './motionPath'
import type { Easing, Keyframe, Layer } from './schema'

type Handles = { in?: Vec2 | null; out?: Vec2 | null }

const key = (t: number, v: number, easing: Easing = 'linear', handles?: Handles): Keyframe => ({
  t,
  v,
  ease: easing,
  ...(handles ? { spatial: { in: handles.in ?? null, out: handles.out ?? null } } : {}),
})

/** A layer with only `animations` filled in. */
const layerOf = (animations: Record<string, Keyframe[]>) => ({ animations }) as unknown as Layer

/** A two-key motion path from `a` at t = 0 to `b` at t = 1000. */
function hop(a: Vec2, b: Vec2, handles: Handles, easing: Easing = 'linear') {
  return layerOf({
    'transform.x': [key(0, a[0], easing, { out: handles.out }), key(1000, b[0], easing, { in: handles.in })],
    'transform.y': [key(0, a[1], easing), key(1000, b[1], easing)],
  })
}

const row = (t: number, x: number, y: number, h: Handles = {}): MotionKey => ({
  t,
  x,
  y,
  ease: 'linear',
  in: h.in ?? null,
  out: h.out ?? null,
})

/** The lowest y of the curve, found by dense sampling. */
function lowestY(layer: Layer): number {
  let min = Number.POSITIVE_INFINITY
  for (let t = 0; t <= 1000; t += 0.05) min = Math.min(min, motionPointAt(layer, t)?.[1] ?? Number.NaN)
  return min
}

describe('arcHandles', () => {
  it('matches the worked example', () => {
    const h = arcHandles([0, 0], [300, 0], 100)
    expect(h.out[0]).toBeCloseTo(100, 6)
    expect(h.out[1]).toBeCloseTo(-400 / 3, 6)
    expect(h.in[0]).toBeCloseTo(-100, 6)
    expect(h.in[1]).toBeCloseTo(-400 / 3, 6)
    const layer = hop([0, 0], [300, 0], h)
    expect(motionPointAt(layer, 500)?.[1]).toBeCloseTo(-100, 6)
    expect(lowestY(layer)).toBeCloseTo(-100, 3)
  })

  it('moves x at constant speed under linear easing', () => {
    const layer = hop([0, 0], [300, 0], arcHandles([0, 0], [300, 0], 100))
    for (const t of [0, 100, 250, 400, 777, 999]) {
      expect(motionPointAt(layer, t)?.[0]).toBeCloseTo(0.3 * t, 6)
    }
  })

  it('peaks exactly arc above the higher end with unequal ends', () => {
    const layer = hop([0, 50], [200, -30], arcHandles([0, 50], [200, -30], 80))
    expect(lowestY(layer)).toBeCloseTo(-110, 3)
  })

  it('sags to arc below the lower end for a negative arc', () => {
    const a: Vec2 = [0, 50]
    const b: Vec2 = [200, -30]
    const layer = hop(a, b, arcHandles(a, b, -60))
    let max = Number.NEGATIVE_INFINITY
    for (let t = 0; t <= 1000; t += 0.05) max = Math.max(max, motionPointAt(layer, t)?.[1] ?? Number.NaN)
    expect(max).toBeCloseTo(110, 3)
  })

  it('is a straight line for arc 0', () => {
    const h = arcHandles([0, 0], [300, 60], 0)
    expect(h.out[0]).toBeCloseTo(100, 9)
    expect(h.out[1]).toBeCloseTo(20, 9)
    expect(h.in[0]).toBeCloseTo(-100, 9)
    expect(h.in[1]).toBeCloseTo(-20, 9)
  })
})

describe('segments', () => {
  it('defaults a missing handle to a third of the chord', () => {
    const a = row(0, 0, 0, { out: [10, -40] })
    const b = row(1000, 90, 30)
    const seg = segmentOf(a, b)
    expect(seg.p1).toEqual([10, -40])
    expect(seg.p2[0]).toBeCloseTo(60, 9)
    expect(seg.p2[1]).toBeCloseTo(20, 9)
    const seg2 = segmentOf(row(0, 0, 0), row(1000, 90, 30, { in: [-5, 5] }))
    expect(seg2.p1[0]).toBeCloseTo(30, 9)
    expect(seg2.p1[1]).toBeCloseTo(10, 9)
    expect(seg2.p2).toEqual([85, 35])
  })

  it('isCurved needs a.out or b.in', () => {
    expect(isCurved(row(0, 0, 0), row(1, 1, 1))).toBe(false)
    expect(isCurved(row(0, 0, 0, { out: [1, 1] }), row(1, 1, 1))).toBe(true)
    expect(isCurved(row(0, 0, 0, { in: [1, 1] }), row(1, 1, 1))).toBe(false)
    expect(isCurved(row(0, 0, 0), row(1, 1, 1, { in: [1, 1] }))).toBe(true)
  })

  it('uses the eased time as the curve parameter', () => {
    const layer = hop([0, 0], [200, 100], { out: [0, 120], in: [-80, 0] }, 'ease-in-out')
    const [a, b] = motionKeysOf(layer) as [MotionKey, MotionKey]
    const seg = segmentOf(a, b)
    for (const t of [100, 300, 500, 800]) {
      const expected = bezierPoint(seg, ease('ease-in-out', t / 1000))
      const got = motionPointAt(layer, t) as Vec2
      expect(got[0]).toBeCloseTo(expected[0], 9)
      expect(got[1]).toBeCloseTo(expected[1], 9)
    }
  })

  it('leaves straight segments to per-axis sampling', () => {
    const plain = layerOf({
      'transform.x': [key(0, 0), key(1000, 100)],
      'transform.y': [key(0, 0), key(1000, 50)],
    })
    expect(motionPointAt(plain, 500)).toBeUndefined()
    const curvedFirst = layerOf({
      'transform.x': [key(0, 0, 'linear', { out: [10, 10] }), key(1000, 100), key(2000, 200)],
      'transform.y': [key(0, 0), key(1000, 50), key(2000, 0)],
    })
    expect(motionPointAt(curvedFirst, 500)).toBeDefined()
    expect(motionPointAt(curvedFirst, 1500)).toBeUndefined()
  })

  it('is undefined outside the keys', () => {
    const layer = hop([0, 0], [100, 0], { out: [0, -50] })
    expect(motionPointAt(layer, -10)).toBeUndefined()
    expect(motionPointAt(layer, 1000)).toBeUndefined()
    expect(motionPointAt(layer, 0)).toEqual([0, 0])
  })

  it('is undefined when an unpaired key sits inside the segment', () => {
    const layer = layerOf({
      'transform.x': [key(0, 0, 'linear', { out: [0, -50] }), key(1000, 100, 'linear', { in: [-10, 0] })],
      'transform.y': [key(0, 0), key(500, 20), key(1000, 0)],
    })
    expect(motionPointAt(layer, 250)).toBeUndefined()
    const xSide = layerOf({
      'transform.x': [key(0, 0, 'linear', { out: [0, -50] }), key(400, 30), key(1000, 100)],
      'transform.y': [key(0, 0), key(1000, 0)],
    })
    expect(motionPointAt(xSide, 700)).toBeUndefined()
  })

  it('moves a curved loop back to its start at mid-time', () => {
    const layer = hop([0, 0], [0, 0], { out: [100, -100], in: [100, -100] })
    const mid = motionPointAt(layer, 500) as Vec2
    expect(mid[0]).toBeCloseTo(75, 9)
    expect(mid[1]).toBeCloseTo(-75, 9)
  })
})

describe('splitSegment', () => {
  const seg = segmentOf(row(0, 0, 0, { out: [40, -90] }), row(1000, 200, 60, { in: [-70, -20] }))

  it('keeps the shape', () => {
    const u = 0.3
    const [left, right] = splitSegment(seg, u)
    const at = bezierPoint(seg, u)
    expect(left.p3[0]).toBeCloseTo(at[0], 9)
    expect(left.p3[1]).toBeCloseTo(at[1], 9)
    expect(right.p0).toEqual(left.p3)
    for (const s of [0, 0.25, 0.5, 0.9, 1]) {
      const l = bezierPoint(left, s)
      const lo = bezierPoint(seg, s * u)
      expect(l[0]).toBeCloseTo(lo[0], 9)
      expect(l[1]).toBeCloseTo(lo[1], 9)
      const r = bezierPoint(right, s)
      const ro = bezierPoint(seg, u + s * (1 - u))
      expect(r[0]).toBeCloseTo(ro[0], 9)
      expect(r[1]).toBeCloseTo(ro[1], 9)
    }
  })
})

describe('smoothTangents', () => {
  it('uses a sixth of the neighbours chord in the middle', () => {
    const t = smoothTangents([0, 0], [50, 10], [120, 30])
    expect(t.out).toEqual([20, 5])
    expect(t.in).toEqual([-20, -5])
  })

  it('leaves the side facing a missing neighbour null', () => {
    const first = smoothTangents(null, [0, 0], [60, 30])
    expect(first.in).toBeNull()
    expect(first.out).toEqual([10, 5])
    const last = smoothTangents([0, 0], [60, 30], null)
    expect(last.out).toBeNull()
    expect(last.in).toEqual([-10, -5])
    expect(smoothTangents(null, [1, 2], null)).toEqual({ in: null, out: null })
  })
})

describe('bendHandles', () => {
  const seg = segmentOf(row(0, 0, 0, { out: [30, 0] }), row(1000, 200, 0, { in: [-30, 0] }))
  const through = (h: { out: Vec2; in: Vec2 }, u: number): Vec2 =>
    bezierPoint(
      {
        p0: seg.p0,
        p1: [seg.p0[0] + h.out[0], seg.p0[1] + h.out[1]],
        p2: [seg.p3[0] + h.in[0], seg.p3[1] + h.in[1]],
        p3: seg.p3,
      },
      u,
    )

  it('passes through the point at u', () => {
    const p = through(bendHandles(seg, 0.4, [90, -60]), 0.4)
    expect(p[0]).toBeCloseTo(90, 9)
    expect(p[1]).toBeCloseTo(-60, 9)
  })

  it('clamps u to 0.1 to 0.9', () => {
    const low = through(bendHandles(seg, 0, [20, 40]), 0.1)
    expect(low[0]).toBeCloseTo(20, 9)
    expect(low[1]).toBeCloseTo(40, 9)
    const high = through(bendHandles(seg, 1, [180, 40]), 0.9)
    expect(high[0]).toBeCloseTo(180, 9)
    expect(high[1]).toBeCloseTo(40, 9)
  })
})

describe('reading a layer', () => {
  const layer = layerOf({
    'transform.x': [key(1000, 100, 'ease-out', { out: [5, 6] }), key(0, 0), key(2000, 'a' as unknown as number), key(3000, 300)],
    'transform.y': [key(0.2, 10), key(1000, 40), key(2000, 5)],
  })

  it('builds one row per paired numeric x key, sorted', () => {
    const rows = motionKeysOf(layer)
    expect(rows).toEqual([
      { t: 0, x: 0, y: 10, ease: 'linear', in: null, out: null },
      { t: 1000, x: 100, y: 40, ease: 'ease-out', in: null, out: [5, 6] },
    ])
  })

  it('reports motion paths and curves', () => {
    expect(hasMotionPath(layer)).toBe(true)
    expect(hasCurves(layer)).toBe(true)
    const single = layerOf({ 'transform.x': [key(0, 0)], 'transform.y': [key(0, 0)] })
    expect(hasMotionPath(single)).toBe(false)
    expect(hasCurves(single)).toBe(false)
    expect(hasMotionPath(layerOf({}))).toBe(false)
    expect(hasCurves(layerOf({ 'transform.x': [key(0, 0, 'linear', {})] }))).toBe(false)
  })
})
