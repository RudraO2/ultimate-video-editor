import { describe, expect, it } from 'vitest'
import { toEasing } from './compat'
import { createDefaultProject } from './doc'
import { sequentialIds } from './ids'
import { Session } from './session'

function setup(view: { playheadMs?: number; compId?: string } = {}) {
  const ids = sequentialIds()
  const session = new Session({ project: createDefaultProject(ids), ids, view: () => view })
  // biome-ignore lint/suspicious/noExplicitAny: test results are checked field by field
  const ok = async (name: string, input: unknown = {}): Promise<any> => {
    const result = await session.call(name, input)
    if (!result.ok) throw new Error(`${name} failed: ${result.error}`)
    return result.value
  }
  const fail = async (name: string, input: unknown) => {
    const result = await session.call(name, input)
    if (result.ok) throw new Error(`${name} should have failed`)
    return `${result.error} ${result.hint ?? ''}`
  }
  const layer = (id: string) => session.project.comps[0]?.tracks.flatMap((t) => t.layers).find((l) => l.id === id)
  return { session, ok, fail, layer }
}

describe("AtomCut's easing shapes", () => {
  it('turns CSS curves and kind objects into ours', () => {
    expect(toEasing('cubic-bezier(0.2, 0, 0.4, 1.3)')).toEqual({ type: 'bezier', x1: 0.2, y1: 0, x2: 0.4, y2: 1.3 })
    expect(toEasing({ kind: 'preset', name: 'ease-out-expo' })).toBe('ease-out-expo')
    expect(toEasing({ kind: 'linear' })).toBe('linear')
    expect(toEasing({ kind: 'bezier', values: [0, 0, 1, 1] })).toEqual({ type: 'bezier', x1: 0, y1: 0, x2: 1, y2: 1 })
    expect(() => toEasing('cubic-bezier(1.5, 0, 0.4, 1)')).toThrow(/not a timing curve/)
  })
})

describe("keyframes.set in AtomCut's shape", () => {
  it('takes property and {at, value, easing}, and replace: false merges', async () => {
    const { ok, layer } = setup()
    await ok('layer.create', { kind: 'shape' })
    const result = await ok('keyframes.set', {
      id: 'layer_1',
      property: 'opacity',
      keys: [
        { at: 0, value: 0, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
        { at: 500, value: 1 },
      ],
    })
    expect(result).toMatchObject({ paths: ['transform.opacity'], keys: 2, mode: 'replace' })
    await ok('keyframes.set', { id: 'layer_1', property: 'opacity', replace: false, keys: [{ at: 900, value: 0.5, easing: 'ease-out-elastic' }] })
    expect(layer('layer_1')?.animations['transform.opacity']).toEqual([
      { t: 0, v: 0, ease: { type: 'bezier', x1: 0.16, y1: 1, x2: 0.3, y2: 1 } },
      { t: 500, v: 1, ease: 'ease-in-out' },
      { t: 900, v: 0.5, ease: 'ease-out-elastic' },
    ])
  })

  it('keys position as [x, y]', async () => {
    const { ok, layer } = setup()
    await ok('layer.create', { kind: 'shape' })
    await ok('keyframes.set', { id: 'layer_1', property: 'position', keys: [{ at: 0, value: [-200, 40] }, { at: 400, value: [0, 0] }] })
    expect(layer('layer_1')?.animations['transform.x']?.map((k) => k.v)).toEqual([-200, 0])
    expect(layer('layer_1')?.animations['transform.y']?.map((k) => k.v)).toEqual([40, 0])
  })

  it('refuses contradictions and arcs with nowhere to land', async () => {
    const { ok, fail } = setup()
    await ok('layer.create', { kind: 'text', text: 'Hi' })
    expect(await fail('keyframes.set', { id: 'layer_1', property: 'x', keys: [{ at: 0, value: 0, arc: 80 }] })).toMatch(/no later position key/)
    expect(await fail('keyframes.set', { id: 'layer_1', property: 'x', range: { start: 0, end: 1 }, keys: [{ at: 0, value: 0 }] })).toMatch(/part of a text/)
    expect(await fail('keyframes.set', { id: 'layer_1', path: 'x', property: 'y', keys: [{ t: 0, v: 0 }] })).toMatch(/disagree/)
    expect(await fail('keyframes.set', { id: 'layer_1', property: 'x', mode: 'merge', replace: true, keys: [{ t: 0, v: 0 }] })).toMatch(/disagree/)
    expect(await fail('keyframes.set', { id: 'layer_1', property: 'position', keys: [{ at: 0, value: [1, 2, 3] }] })).toMatch(/takes 2 values/)
    // A key with no arc, in or out (null) is a plain key.
    await ok('keyframes.set', { id: 'layer_1', property: 'x', keys: [{ at: 0, value: 0, arc: null, in: null, out: null }] })
  })
})

describe("layer.set in AtomCut's shape", () => {
  it('sets several layers by ids, and keys at the playhead in auto and keyframe modes', async () => {
    const { ok, layer } = setup({ playheadMs: 1000 })
    await ok('layer.create', { kind: 'shape' })
    await ok('layer.create', { kind: 'shape', startMs: 500 })
    await ok('layer.set', { ids: ['layer_1', 'layer_2'], values: { opacity: 0.5 } })
    expect([layer('layer_1')?.transform.opacity, layer('layer_2')?.transform.opacity]).toEqual([0.5, 0.5])

    const keyed = await ok('layer.set', { ids: 'layer_2', values: { x: 100 }, mode: 'keyframe' })
    expect(keyed).toMatchObject({ updated: ['layer_2'], keyed: ['transform.x'], atMs: 1000 })
    expect(layer('layer_2')?.animations['transform.x']).toEqual([{ t: 500, v: 100, ease: 'ease-in-out' }])

    // auto keys an animated property at the playhead; base writes the resting value under the keys.
    await ok('layer.set', { id: 'layer_2', values: { x: 50 } })
    expect(layer('layer_2')?.animations['transform.x']?.[0]?.v).toBe(50)
    await ok('layer.set', { id: 'layer_2', values: { x: 7 }, mode: 'base' })
    expect(layer('layer_2')?.transform.x).toBe(7)
    expect(layer('layer_2')?.animations['transform.x']).toHaveLength(1)
  })

  it('needs atMs to key when there is no playhead', async () => {
    const { ok, fail } = setup()
    await ok('layer.create', { kind: 'shape' })
    expect(await fail('layer.set', { id: 'layer_1', values: { x: 1 }, mode: 'keyframe' })).toMatch(/needs atMs/)
    expect(await fail('layer.set', { id: 'layer_1', ids: ['layer_1'], values: { x: 1 } })).toMatch(/not both/)
  })
})

describe("layer.create in AtomCut's shape", () => {
  it('takes frameId, top-level x, y and shape fields, and set', async () => {
    const { ok, layer, session } = setup()
    const compId = session.project.comps[0]?.id
    await ok('layer.create', {
      frameId: compId,
      kind: 'shape',
      shape: 'ellipse',
      width: 300,
      fill: '#ff3366',
      stroke: { color: '#ffffff', width: 6 },
      x: 120,
      y: -40,
      set: { opacity: 0.8, rotation: -4 },
    })
    expect(layer('layer_1')).toMatchObject({
      shape: { type: 'ellipse', width: 300 },
      fills: [{ type: 'solid', color: '#ff3366' }],
      strokes: [{ width: 6, align: 'center', paint: { type: 'solid', color: '#ffffff' } }],
      transform: { x: 120, y: -40, opacity: 0.8, rotation: -4 },
    })
  })

  it('makes a media layer of the media kind from assetId', async () => {
    const { ok, layer } = setup()
    const { id } = await ok('media.add', { kind: 'image', name: 'logo.png', path: 'C:/a/logo.png', width: 100, height: 100 })
    await ok('layer.create', { kind: 'media', assetId: id })
    expect(layer('layer_1')?.kind).toBe('image')
  })

  it('leaves nothing behind when set fails, and refuses shapes it lacks', async () => {
    const { ok, fail, session } = setup()
    expect(await fail('layer.create', { kind: 'shape', set: { opacity: 3 } })).toMatch(/set: opacity must be at most 1/)
    expect(session.project.comps[0]?.tracks).toHaveLength(0)
    expect(await fail('layer.create', { kind: 'group' })).toMatch(/Groups are made from layers/)
    expect(await fail('layer.create', { kind: 'text', width: 100 })).toMatch(/only apply to shape layers/)
    expect(await fail('layer.create', { kind: 'image', fill: '#ffffff' })).toMatch(/only apply to shape, path, text and mesh layers/)
    await ok('layer.create', { kind: 'text', text: 'x' })
  })
})

describe('keyframes.clear and keyframes.inspect', () => {
  it('freezes each property at its value at atMs', async () => {
    const { ok, layer } = setup()
    await ok('layer.create', { kind: 'shape' })
    await ok('keyframes.set', { id: 'layer_1', path: 'x', keys: [{ t: 0, v: 0, ease: 'linear' }, { t: 1000, v: 100 }] })
    const result = await ok('keyframes.clear', { id: 'layer_1', properties: ['x'], atMs: 250 })
    expect(result).toEqual({ cleared: ['transform.x'], frozenAtMs: 250 })
    expect(layer('layer_1')?.transform.x).toBeCloseTo(25)
    expect(layer('layer_1')?.animations).toEqual({})
  })

  it("lists a layer's tracks in comp time and audits a comp", async () => {
    const { ok } = setup()
    await ok('layer.create', { kind: 'shape', startMs: 1000 })
    await ok('keyframes.set', { id: 'layer_1', path: 'opacity', keys: [{ t: 0, v: 0, ease: 'cubic-bezier(0.16, 1, 0.3, 1)' }, { t: 400, v: 1 }] })
    const baked = Array.from({ length: 30 }, (_, i) => ({ t: (i * 1000) / 30, v: i }))
    await ok('keyframes.set', { id: 'layer_1', path: 'rotation', keys: baked })
    const one = await ok('keyframes.inspect', { id: 'layer_1', properties: ['opacity'] })
    expect(one.tracks).toEqual([
      { path: 'transform.opacity', alias: 'opacity', keys: 2, baked: false, line: '1000 0 cubic-bezier(0.16, 1, 0.3, 1) · 1400 1' },
    ])
    const audit = await ok('keyframes.inspect', { limit: 1 })
    expect(audit).toMatchObject({ layers: 1, animatedLayers: 1, tracks: 2, keys: 32, bakedTracks: 1 })
    expect(audit.heaviest).toEqual([{ layerId: 'layer_1', layerName: 'Rectangle', path: 'transform.rotation', keys: 30, baked: true }])
  })
})

describe('flags and numbers sent as strings', () => {
  it('reads them as meant when that makes the input valid', async () => {
    const { session, ok, layer } = setup()
    const { id } = await ok('layer.create', { kind: 'text', text: '12', startMs: '500', durationMs: '1000' })
    expect(layer(id)).toMatchObject({ kind: 'text', text: '12', startMs: 500, durationMs: 1000 })
    await ok('frame.update', { width: '960', scaleContents: 'true' })
    expect(session.project.comps[0]?.width).toBe(960)
    expect(layer(id)?.transform.scaleX).toBe(0.5)
  })

  it('still refuses input that is wrong either way', async () => {
    const { fail } = setup()
    expect(await fail('layer.create', { kind: 'text', startMs: 'soon' })).toMatch(/Invalid input/)
  })
})
