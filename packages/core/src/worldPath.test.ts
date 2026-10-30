import { describe, expect, it } from 'vitest'
import { type Comp, CompSchema, type Layer, LayerSchema, TrackSchema } from './schema'
import { defaultCamera } from './world'
import { hasWorldPath, worldMotionPath, worldPathTimes, worldPivotAt } from './worldPath'

const key = (t: number, v: number) => ({ t, v, ease: 'linear' })

const layer = (id: string, kind: string, startMs: number, durationMs: number, extra: Record<string, unknown> = {}) =>
  LayerSchema.parse({ id, name: id, kind, startMs, durationMs, ...(kind === 'text' ? { text: 'Hi' } : {}), ...extra })

const lane = (id: string, layers: Layer[], extra: Record<string, unknown> = {}) => TrackSchema.parse({ id, layers, ...extra })

const world = (tracks: ReturnType<typeof lane>[]): Comp =>
  CompSchema.parse({ id: 'w', name: 'World', width: 1920, height: 1080, fps: 30, durationMs: 10_000, world: {}, tracks })

const camera = defaultCamera(1920, 1080)

describe('worldPathTimes', () => {
  it('takes 48 samples per second, from 2 to 160', () => {
    expect(worldPathTimes(layer('a', 'text', 0, 20))).toHaveLength(2)
    expect(worldPathTimes(layer('a', 'text', 0, 1000))).toHaveLength(48)
    expect(worldPathTimes(layer('a', 'text', 0, 10_000))).toHaveLength(160)
  })

  it('spreads the samples over the span, both ends included', () => {
    const times = worldPathTimes(layer('a', 'text', 500, 1000))
    expect(times[0]).toBe(500)
    expect(times[times.length - 1]).toBeCloseTo(1500)
  })

  it('adds the key times of x, y and z inside the span and merges neighbours', () => {
    const keyed = layer('a', 'text', 1000, 1000, {
      animations: { 'transform.x': [key(0, 0), key(250, 1)], 'transform.y': [key(250, 0), key(600, 1)], 'transform.z': [key(5000, 0), key(1000, 3)] },
    })
    const times = worldPathTimes(keyed)
    // 48 samples, minus the ends the keys at 0 and 1000 replace, plus 250 and 600; 5000 is outside the span.
    expect(times).toHaveLength(50)
    expect(times).toContain(1250)
    expect(times).toContain(1600)
    expect(times).not.toContain(6000)
    expect([...times].sort((a, b) => a - b)).toEqual(times)
    // A key within half a ms of a sample takes its place.
    const near = worldPathTimes(layer('a', 'text', 0, 1000, { animations: { 'transform.x': [key(21.3, 0), key(500, 1)] } }))
    expect(near).toContain(21.3)
    expect(near).toHaveLength(49)
  })
})

describe('hasWorldPath', () => {
  it('wants two distinct key times on x, y and z together', () => {
    expect(hasWorldPath(layer('a', 'text', 0, 1000))).toBe(false)
    expect(hasWorldPath(layer('a', 'text', 0, 1000, { animations: { 'transform.x': [key(0, 1)] } }))).toBe(false)
    expect(hasWorldPath(layer('a', 'text', 0, 1000, { animations: { 'transform.x': [key(0, 1), key(500, 2)] } }))).toBe(true)
    expect(hasWorldPath(layer('a', 'text', 0, 1000, { animations: { 'transform.x': [key(0, 1)], 'transform.z': [key(500, 2)] } }))).toBe(true)
    expect(hasWorldPath(layer('a', 'text', 0, 1000, { animations: { 'transform.x': [key(0, 1)], 'transform.y': [key(0, 2)] } }))).toBe(false)
    expect(hasWorldPath(layer('a', 'text', 0, 1000, { animations: { 'transform.opacity': [key(0, 1), key(500, 0)] } }))).toBe(false)
  })
})

describe('worldMotionPath', () => {
  const picture = layer('p', 'text', 1000, 1000, {
    animations: { 'transform.x': [key(0, 0), key(1000, 200)], 'transform.z': [key(0, 0), key(1000, -100)] },
  })

  it('maps a picture one to one with the default camera', () => {
    const path = worldMotionPath(world([lane('a', [picture])]), 'p', camera, { playheadMs: 1500 })
    expect(path).not.toBeNull()
    expect(path?.runs).toHaveLength(1)
    for (const p of path?.runs[0] ?? []) {
      const f = (p.timeMs - 1000) / 1000
      expect(p.x).toBeCloseTo(960 + 200 * f, 2) // the last sample reads 1 us before the end
      expect(p.y).toBeCloseTo(540 + 100 * f, 2)
    }
    expect(path?.keys.map((k) => [k.index, k.timeMs])).toEqual([
      [0, 1000],
      [1, 2000],
    ])
    expect(path?.keys[0]?.x).toBeCloseTo(960, 6)
    expect(path?.keys[1]?.x).toBeCloseTo(1160, 2)
    expect(path?.keys[1]?.y).toBeCloseTo(640, 2)
    expect(path?.playhead?.x).toBeCloseTo(1060, 6)
    expect(path?.playhead?.y).toBeCloseTo(590, 6)
  })

  it('leaves out the playhead outside the span', () => {
    const c = world([lane('a', [picture])])
    expect(worldMotionPath(c, 'p', camera, { playheadMs: 500 })?.playhead).toBeUndefined()
    expect(worldMotionPath(c, 'p', camera, { playheadMs: 2500 })?.playhead).toBeUndefined()
    expect(worldMotionPath(c, 'p', camera)?.playhead).toBeUndefined()
  })

  it('returns null for a missing layer, no path, or a move along the view axis', () => {
    const c = world([lane('a', [picture]), lane('b', [layer('still', 'text', 0, 1000)])])
    expect(worldMotionPath(c, 'nope', camera)).toBeNull()
    expect(worldMotionPath(c, 'still', camera)).toBeNull()
    const deep = layer('deep', 'text', 0, 1000, { animations: { 'transform.y': [key(0, 0), key(1000, 800)] } })
    expect(worldMotionPath(world([lane('a', [deep])]), 'deep', camera)).toBeNull()
  })

  it('splits the path where it passes behind the camera', () => {
    // The camera stands at y = -2666.7: the layer goes behind it and comes back.
    const flyby = layer('f', 'text', 0, 2000, {
      animations: {
        'transform.x': [key(0, 0), key(1000, 300), key(2000, 0)],
        'transform.y': [key(0, 0), key(1000, -6000), key(2000, 0)],
      },
    })
    const path = worldMotionPath(world([lane('a', [flyby])]), 'f', camera)
    expect(path?.runs).toHaveLength(2)
    expect(path?.keys.map((k) => k.index)).toEqual([0, 2])
    const [a, b] = path?.runs ?? []
    expect((a?.[a.length - 1]?.timeMs ?? 0) < (b?.[0]?.timeMs ?? 0)).toBe(true)
  })

  it('follows the groups above the layer', () => {
    const group = layer('g', 'group', 0, 2000, { animations: { 'transform.x': [key(0, 0), key(1000, 1000)] }, transform: { z: -50 } })
    const member = layer('m', 'text', 0, 2000, { animations: { 'transform.x': [key(0, 0), key(1000, 100)] } })
    const c = world([lane('g1', [group]), lane('m1', [member], { groupId: 'g' })])
    const at = worldPivotAt(c, 'm', 500)
    expect(at?.[0]).toBeCloseTo(550, 6)
    expect(at?.[2]).toBeCloseTo(-50, 6)
    const path = worldMotionPath(c, 'm', camera, { playheadMs: 500 })
    expect(path?.playhead?.x).toBeCloseTo(960 + 550, 6)
    expect(path?.playhead?.y).toBeCloseTo(540 + 50, 6)
    expect(path?.keys[1]?.x).toBeCloseTo(960 + 1100, 2)
  })

  it('has no pivot for a layer outside its span', () => {
    const c = world([lane('a', [picture])])
    expect(worldPivotAt(c, 'p', 999)).toBeNull()
    expect(worldPivotAt(c, 'p', 2000)).toBeNull()
    expect(worldPivotAt(c, 'p', 1000)?.[0]).toBeCloseTo(0, 9)
  })
})
