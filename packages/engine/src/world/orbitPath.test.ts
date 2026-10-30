import { type Comp, CompSchema, type Layer, LayerSchema, TrackSchema } from '@uve/core'
import { describe, expect, it } from 'vitest'
import { computePath, moves, pathKeyTimes, pathOf } from './orbitPath'

const keys = (path: string, ...values: [number, number][]) => ({ [path]: values.map(([t, v]) => ({ t, v, ease: 'linear' })) })

const shape = (id: string, extra: Record<string, unknown> = {}) =>
  LayerSchema.parse({ id, name: id, kind: 'shape', startMs: 500, durationMs: 2000, shape: { type: 'rect', width: 100, height: 100 }, ...extra }) as Layer

const world = (layers: Layer[]): Comp =>
  CompSchema.parse({ id: 'w', name: 'W', width: 1920, height: 1080, fps: 30, durationMs: 4000, world: {}, tracks: layers.map((l, i) => TrackSchema.parse({ id: `t${i}`, layers: [l] })) }) as Comp

const first = (comp: Comp): Layer => comp.tracks[0]?.layers[0] as Layer

describe('orbit motion path', () => {
  it('finds the key times of x, y and z inside the layer, merged', () => {
    const layer = shape('a', { animations: { ...keys('transform.x', [0, 0], [1000, 100]), ...keys('transform.z', [1000.2, 0], [2000, 50], [5000, 0]) } })
    expect(pathKeyTimes(layer)).toEqual([500, 1500, 2500])
  })

  it('samples 48 a second over the span, with a point per key', () => {
    const comp = world([shape('a', { animations: keys('transform.x', [0, 0], [1000, 300]) })])
    const path = computePath(comp, first(comp))
    expect(path).not.toBeNull()
    // 2 s at 48 a second is 96 samples; a key time that is not one of them adds one.
    expect(path?.points.length).toBeGreaterThanOrEqual(96)
    expect(path?.points.length).toBeLessThanOrEqual(98)
    expect(path?.keys).toHaveLength(2)
    expect(path?.keys[0]?.[0]).toBeCloseTo(0)
    expect(path?.keys[1]?.[0]).toBeCloseTo(300)
    expect(path?.points[0]).toEqual(path?.keys[0])
  })

  it('skips a layer that moves less than half a px', () => {
    const still = world([shape('a', { animations: keys('transform.x', [0, 10], [1000, 10.2]) })])
    expect(computePath(still, first(still))).toBeNull()
    expect(moves([[0, 0, 0], [0.3, 0.3, 0]])).toBe(false)
    expect(moves([[0, 0, 0], [0.5, 0, 0]])).toBe(true)
    const noKeys = world([shape('b')])
    expect(computePath(noKeys, first(noKeys))).toBeNull()
  })

  it('moves along z too, and remembers a path per comp object', () => {
    const comp = world([shape('a', { animations: keys('transform.z', [0, 0], [1000, 200]) })])
    const path = pathOf(comp, 'a')
    expect(path?.keys[1]?.[2]).toBeCloseTo(200)
    expect(pathOf(comp, 'a')).toBe(path)
    expect(pathOf(comp, 'missing')).toBeNull()
    expect(pathOf(world([shape('a')]), 'a')).toBeNull()
  })
})
