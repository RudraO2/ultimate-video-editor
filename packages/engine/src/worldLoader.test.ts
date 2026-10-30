import { type Comp, CompSchema, LayerSchema, TrackSchema } from '@uve/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CompRenderer } from './renderer'
import { usesWorld, worldLoader } from './worldLoader'

const comp = (id: string, extra: Record<string, unknown> = {}, layers: unknown[] = []): Comp =>
  CompSchema.parse({
    id,
    name: id,
    width: 640,
    height: 360,
    fps: 30,
    durationMs: 2000,
    tracks: layers.map((layer, i) => TrackSchema.parse({ id: `t${i}`, layers: [layer] })),
    ...extra,
  }) as Comp

const nested = (id: string, sourceCompId: string) => LayerSchema.parse({ id, name: id, kind: 'nested', sourceCompId, startMs: 0, durationMs: 2000 })

describe('loading the world renderer', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('knows when a comp needs worlds, through nesting', () => {
    const flat = comp('flat')
    const w = comp('w', { world: {} })
    const holder = comp('holder', {}, [nested('n', 'w')])
    const outer = comp('outer', {}, [nested('m', 'holder')])
    const comps = [flat, w, holder, outer]
    expect(usesWorld(flat, comps)).toBe(false)
    expect(usesWorld(w, comps)).toBe(true)
    expect(usesWorld(holder, comps)).toBe(true)
    expect(usesWorld(outer, comps)).toBe(true)
  })

  it('does not load three.js for a flat project', async () => {
    const spy = vi.spyOn(worldLoader, 'load')
    const flat = comp('flat')
    const holder = comp('holder', {}, [nested('n', 'flat')])
    const renderer = new CompRenderer()
    await renderer.prepare(holder, { media: [], comps: [flat, holder] })
    await renderer.prepare(flat, { media: [], comps: [flat, holder] })
    expect(spy).not.toHaveBeenCalled()
    expect(renderer.worldsReady).toBe(false)
  })

  it('loads it once for a world, however many times it is asked', async () => {
    const spy = vi.spyOn(worldLoader, 'load')
    const w = comp('w', { world: {} })
    const holder = comp('holder', {}, [nested('n', 'w')])
    const renderer = new CompRenderer()
    const doc = { media: [], comps: [w, holder] }
    await Promise.all([renderer.prepare(w, doc), renderer.prepare(holder, doc)])
    await renderer.prepare(w, doc)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(renderer.worldsReady).toBe(true)
  })
})
