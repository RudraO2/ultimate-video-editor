import { type Comp, CompSchema, defaultCamera, type Layer, LayerSchema, TrackSchema } from '@uve/core'
import { describe, expect, it } from 'vitest'
import { isSelectedMotionKey, motionHoverChanged, motionHoverValid, motionTargets, pointAtTime, worldOverlay } from './motionPaths'

const key = (t: number, v: number) => ({ t, v, ease: 'linear' })

/** A layer with `n` motion keys (x and y keyed together), or none. */
function layer(id: string, n: number): Layer {
  const keys = (axis: number) => Array.from({ length: n }, (_, i) => key(i * 1000, i * 100 * axis))
  return { id, startMs: 500, animations: n > 0 ? { 'transform.x': keys(1), 'transform.y': keys(2) } : {} } as unknown as Layer
}

function comp(tracks: { hidden?: boolean; locked?: boolean; layers: Layer[] }[]): Comp {
  return { tracks: tracks.map((t) => ({ hidden: false, locked: false, ...t })) } as unknown as Comp
}

const base = { motionPaths: true, tool: 'move', penActive: false, alsoSelected: [] as string[] }

describe('motionTargets', () => {
  const c = comp([{ layers: [layer('a', 3)] }, { layers: [layer('b', 2)] }, { layers: [layer('still', 1)] }])

  it('takes the selection with two or more motion keys, selected layer first', () => {
    const got = motionTargets({ ...base, comp: c, selectedLayerId: 'b', alsoSelected: ['a', 'still', 'missing'] })
    expect(got.map((t) => t.layer.id)).toEqual(['b', 'a'])
  })

  it('shows nothing when off, on another tool, while drawing with the Pen or with no selection', () => {
    const input = { ...base, comp: c, selectedLayerId: 'a' }
    expect(motionTargets({ ...input, motionPaths: false })).toEqual([])
    expect(motionTargets({ ...input, tool: 'hand' })).toEqual([])
    expect(motionTargets({ ...input, penActive: true })).toEqual([])
    expect(motionTargets({ ...input, selectedLayerId: null })).toEqual([])
  })

  it('skips hidden tracks and marks locked ones', () => {
    const d = comp([
      { hidden: true, layers: [layer('a', 2)] },
      { locked: true, layers: [layer('b', 2)] },
    ])
    const got = motionTargets({ ...base, comp: d, selectedLayerId: 'a', alsoSelected: ['b'] })
    expect(got.map((t) => [t.layer.id, t.locked])).toEqual([['b', true]])
  })
})

describe('motionTargets in a 3D world', () => {
  // Keys on z alone make a world path (no x and y pair needed); the same layer in a flat comp has none.
  const zKeyed = { id: 'z', startMs: 0, animations: { 'transform.z': [key(0, 0), key(1000, 50)] } } as unknown as Layer
  const tracks = [{ hidden: false, locked: false, layers: [zKeyed, layer('xy', 2)] }]
  const input = { ...base, selectedLayerId: 'z', alsoSelected: ['xy'] }

  it('counts keys on x, y or z', () => {
    const flat = { tracks } as unknown as Comp
    expect(motionTargets({ ...input, comp: flat }).map((t) => t.layer.id)).toEqual(['xy'])
    const world = { tracks, world: {} } as unknown as Comp
    expect(motionTargets({ ...input, comp: world }).map((t) => t.layer.id)).toEqual(['z', 'xy'])
  })
})

describe('worldOverlay', () => {
  const picture = LayerSchema.parse({
    id: 'p',
    name: 'p',
    kind: 'text',
    text: 'Hi',
    startMs: 0,
    durationMs: 1000,
    animations: { 'transform.x': [key(0, 0), key(1000, 200)], 'transform.z': [key(0, 0), key(1000, -100)] },
  })
  const comp = CompSchema.parse({
    id: 'w',
    name: 'W',
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 2000,
    world: {},
    tracks: [TrackSchema.parse({ id: 't', layers: [picture] })],
  })

  it('is one segment, the keys and the playhead in screen px, with nothing to edit', () => {
    const k = 0.5
    const overlay = worldOverlay(picture, comp, defaultCamera(1920, 1080), k, 500)
    expect(overlay?.segments).toHaveLength(1)
    expect(overlay?.segments[0]?.curved).toBe(false)
    expect(overlay?.segments[0]?.fromMs).toBe(0)
    expect(overlay?.chevrons).toEqual([])
    expect(overlay?.handles).toEqual([])
    expect(overlay?.keys.map((m) => m.smooth)).toEqual([false, false])
    expect(overlay?.keys[0]?.x).toBeCloseTo(480, 6)
    expect(overlay?.keys[0]?.y).toBeCloseTo(270, 6)
    expect(overlay?.playhead?.x).toBeCloseTo(530, 6)
    expect(overlay?.playhead?.y).toBeCloseTo(295, 6)
  })

  it('is null for a layer that does not move on screen', () => {
    const still = LayerSchema.parse({ id: 's', name: 's', kind: 'text', text: 'Hi', startMs: 0, durationMs: 1000 })
    expect(worldOverlay(still, comp, defaultCamera(1920, 1080), 1)).toBeNull()
  })
})

describe('hover', () => {
  const seg = (index: number, timeMs: number) => ({ layerId: 'a', hit: { kind: 'segment' as const, index, timeMs, u: 0.5 } })
  const key0 = { layerId: 'a', hit: { kind: 'key' as const, key: 0, timeMs: 0 } }

  it('changes only when the hit part does, or the moment on a segment', () => {
    expect(motionHoverChanged(null, null)).toBe(false)
    expect(motionHoverChanged(null, key0)).toBe(true)
    expect(motionHoverChanged(key0, { ...key0, hit: { kind: 'key', key: 0, timeMs: 0 } })).toBe(false)
    expect(motionHoverChanged(key0, { layerId: 'a', hit: { kind: 'key', key: 1, timeMs: 1 } })).toBe(true)
    expect(motionHoverChanged(seg(0, 100), seg(0, 100))).toBe(false)
    expect(motionHoverChanged(seg(0, 100), seg(0, 120))).toBe(true)
    expect(motionHoverChanged(key0, seg(0, 0))).toBe(true)
  })

  it('is valid only while its layer is drawn and unlocked', () => {
    const drawable = (locked: boolean) => [{ layer: layer('a', 2), locked, overlay: {} as never }]
    expect(motionHoverValid(null, [])).toBe(true)
    expect(motionHoverValid(key0, drawable(false))).toBe(true)
    expect(motionHoverValid(key0, drawable(true))).toBe(false)
    expect(motionHoverValid(key0, [])).toBe(false)
  })
})

describe('pointAtTime', () => {
  const points = [
    { x: 0, y: 0, timeMs: 100 },
    { x: 10, y: 20, timeMs: 200 },
    { x: 30, y: 20, timeMs: 400 },
  ]
  it('interpolates along the polyline and clamps at the ends', () => {
    expect(pointAtTime(points, 150)).toEqual([5, 10])
    expect(pointAtTime(points, 300)).toEqual([20, 20])
    expect(pointAtTime(points, 0)).toEqual([0, 0])
    expect(pointAtTime(points, 999)).toEqual([30, 20])
    expect(pointAtTime([], 5)).toBeNull()
  })
})

describe('isSelectedMotionKey', () => {
  const l = layer('a', 2)
  it('matches the layer, an x or y path and the comp time within half a ms', () => {
    expect(isSelectedMotionKey({ layerId: 'a', path: 'transform.y', t: 1000 }, l, 1500)).toBe(true)
    expect(isSelectedMotionKey({ layerId: 'a', path: 'transform.x', t: 1000.4 }, l, 1500)).toBe(true)
    expect(isSelectedMotionKey({ layerId: 'a', path: 'transform.x', t: 1001 }, l, 1500)).toBe(false)
    expect(isSelectedMotionKey({ layerId: 'a', path: 'opacity', t: 1000 }, l, 1500)).toBe(false)
    expect(isSelectedMotionKey({ layerId: 'b', path: 'transform.x', t: 1000 }, l, 1500)).toBe(false)
    expect(isSelectedMotionKey(null, l, 1500)).toBe(false)
  })
})
