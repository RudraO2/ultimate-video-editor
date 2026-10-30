import { describe, expect, it } from 'vitest'
import { deepClone } from './clone'
import { createDefaultProject } from './doc'
import { sequentialIds } from './ids'
import { applyMaterialPreset, MATERIAL_PRESETS, materialAt } from './materials'
import { evaluateProperty, propertiesOf, resolveProperty } from './properties'
import { type Comp, type Layer, MaterialSchema, type Project } from './schema'
import { Session } from './session'

function setup() {
  const ids = sequentialIds()
  const session = new Session({ project: createDefaultProject(ids), ids })
  // biome-ignore lint/suspicious/noExplicitAny: test results are checked field by field
  const ok = async (name: string, input: unknown = {}): Promise<any> => {
    const result = await session.call(name, input)
    if (!result.ok) throw new Error(`${name} failed: ${result.error}`)
    return result.value
  }
  const fail = async (name: string, input: unknown) => {
    const result = await session.call(name, input)
    if (result.ok) throw new Error(`${name} should have failed`)
    return { error: result.error, hint: result.hint ?? '' }
  }
  const comp = (id: string) => session.project.comps.find((c) => c.id === id) as Comp
  const layer = (id: string) => session.project.comps.flatMap((c) => c.tracks.flatMap((t) => t.layers)).find((l) => l.id === id) as Layer
  return { session, ok, fail, comp, layer }
}

/** A world with one shape plane. */
async function withPlane() {
  const s = setup()
  const w = (await s.ok('world.create', { starter: false })).frameId as string
  const plane = (await s.ok('layer.create', { compId: w, kind: 'shape', shape: { width: 100, height: 100 } })).id as string
  return { ...s, w, plane }
}

describe('material presets', () => {
  it('has AtomCut\'s 17 presets with their values over the defaults', () => {
    expect(MATERIAL_PRESETS.map((p) => p.id)).toEqual([
      'plastic', 'matte', 'clay', 'ceramic', 'rubber', 'metal', 'chrome', 'gold', 'copper', 'carpaint', 'glass', 'frosted', 'velvet', 'pearl', 'neon', 'toon', 'flat',
    ])
    expect(applyMaterialPreset('gold')).toMatchObject({ color: '#f5c46b', roughness: 0.18, metalness: 1, model: 'pbr', preset: 'gold', ior: 1.45, clearcoatRoughness: 0.1 })
    expect(applyMaterialPreset('glass')).toMatchObject({ roughness: 0.02, transmission: 1, ior: 1.5, thickness: 20, color: null })
    expect(applyMaterialPreset('neon')).toMatchObject({ emission: '#ff2fb1', emissionStrength: 4 })
    expect(applyMaterialPreset('toon')).toMatchObject({ model: 'toon', toonSteps: 3 })
    expect(applyMaterialPreset('flat').model).toBe('unlit')
    expect(applyMaterialPreset('carpaint')).toMatchObject({ metalness: 0.6, clearcoat: 1, clearcoatRoughness: 0.03 })
  })

  it('has AtomCut\'s defaults when parsed empty', () => {
    expect(MaterialSchema.parse({})).toEqual({
      model: 'pbr', color: null, roughness: 0.5, metalness: 0, emission: '#000000', emissionStrength: 1, transmission: 0, ior: 1.45, thickness: 0,
      clearcoat: 0, clearcoatRoughness: 0.1, sheen: 0, iridescence: 0, toonSteps: 3, doubleSided: false, source: 'custom', preset: null,
    })
  })
})

describe('world.material', () => {
  it('applies a preset, then values over it', async () => {
    const s = await withPlane()
    const done = await s.ok('world.material', { ids: s.plane, preset: 'gold' })
    expect(done.updated).toEqual([s.plane])
    expect(s.layer(s.plane).material).toMatchObject({ preset: 'gold', metalness: 1, color: '#f5c46b' })
    await s.ok('world.material', { ids: [s.plane], preset: 'chrome', values: { roughness: 0.3 } })
    expect(s.layer(s.plane).material).toMatchObject({ preset: 'chrome', roughness: 0.3, metalness: 1 })
  })

  it('merges values into the material it has, leaving the other fields', async () => {
    const s = await withPlane()
    await s.ok('world.material', { ids: s.plane, preset: 'copper' })
    await s.ok('world.material', { ids: s.plane, values: { emission: '#ff0000', emissionStrength: 3 } })
    expect(s.layer(s.plane).material).toMatchObject({ preset: 'copper', roughness: 0.25, emission: '#ff0000', emissionStrength: 3 })
    const fresh = await s.ok('layer.create', { compId: s.w, kind: 'shape', shape: { width: 10, height: 10 } })
    await s.ok('world.material', { ids: fresh.id, values: { roughness: 0.9 } })
    expect(s.layer(fresh.id).material).toMatchObject({ roughness: 0.9, metalness: 0, preset: null })
  })

  it('removes a material with preset null, keys and all, and undoes', async () => {
    const s = await withPlane()
    await s.ok('world.material', { ids: s.plane, preset: 'plastic' })
    await s.ok('keyframes.set', { id: s.plane, path: 'roughness', keys: [{ t: 0, v: 0.1 }, { t: 1000, v: 0.9 }] })
    expect(Object.keys(s.layer(s.plane).animations)).toContain('material.roughness')
    const before = deepClone(s.session.project) as Project
    await s.ok('world.material', { ids: s.plane, preset: null })
    expect(s.layer(s.plane).material).toBeUndefined()
    expect(Object.keys(s.layer(s.plane).animations)).not.toContain('material.roughness')
    s.session.undo()
    expect(s.session.project).toEqual(before)
  })

  it('refuses flat comps, cameras, bad presets and empty requests, writing nothing', async () => {
    const s = await withPlane()
    const flat = s.session.project.comps.find((c) => !c.world) as Comp
    const flatLayer = (await s.ok('layer.create', { compId: flat.id, kind: 'shape' })).id as string
    expect((await s.fail('world.material', { ids: flatLayer, preset: 'gold' })).error).toMatch(/flat comp, not a 3D world/)
    const cam = (await s.ok('world.add', { compId: s.w, kind: 'camera', position: [0, -500, 0] })).id as string
    expect((await s.fail('world.material', { ids: cam, preset: 'gold' })).error).toMatch(/camera/)
    const bad = await s.fail('world.material', { ids: s.plane, preset: 'wood' })
    expect(bad.error).toMatch(/No material preset "wood"/)
    expect(bad.hint).toMatch(/plastic/)
    expect((await s.fail('world.material', { ids: s.plane })).error).toMatch(/Say what material/)
    expect((await s.fail('world.material', { ids: s.plane, preset: null, values: { roughness: 1 } })).error).toMatch(/removes the material/)
    expect((await s.fail('world.material', { ids: [s.plane, flatLayer], preset: 'gold' })).error).toMatch(/flat comp/)
    expect(s.layer(s.plane).material).toBeUndefined()
  })

  it('keys roughness, metalness, emission, emissionStrength and transmission once there is a material', async () => {
    const s = await withPlane()
    expect(propertiesOf(s.layer(s.plane)).some((p) => p.path.startsWith('material.'))).toBe(false)
    await s.ok('world.material', { ids: s.plane, preset: 'plastic' })
    const layer = s.layer(s.plane)
    expect(propertiesOf(layer).filter((p) => p.path.startsWith('material.')).map((p) => p.path)).toEqual([
      'material.roughness', 'material.metalness', 'material.emissionStrength', 'material.emission', 'material.transmission',
    ])
    expect(resolveProperty(layer, 'material.emission')[0]?.type).toBe('color')
    await s.ok('keyframes.set', { id: s.plane, path: 'material.roughness', keys: [{ t: 0, v: 0, ease: 'linear' }, { t: 1000, v: 1, ease: 'linear' }] })
    await s.ok('keyframes.set', { id: s.plane, path: 'material.emission', keys: [{ t: 0, v: '#000000' }, { t: 1000, v: '#ffffff' }] })
    const spec = resolveProperty(s.layer(s.plane), 'material.roughness')[0]!
    expect(evaluateProperty(s.layer(s.plane), spec, 500)).toBeCloseTo(0.5, 6)
    const sampled = materialAt(s.layer(s.plane), 250)
    expect(sampled?.roughness).toBeCloseTo(0.25, 6)
    expect(sampled?.metalness).toBe(0)
    expect(materialAt(s.layer(s.plane), 0)?.emission).toBe('#000000')
  })

  it('takes the material off a picture that leaves its world by copy', async () => {
    const s = await withPlane()
    await s.ok('world.material', { ids: s.plane, preset: 'gold' })
    await s.ok('keyframes.set', { id: s.plane, path: 'metalness', keys: [{ t: 0, v: 0 }, { t: 100, v: 1 }] })
    const flat = s.session.project.comps.find((c) => !c.world) as Comp
    const copied = await s.ok('layers.copy', { ids: s.plane, toCompId: flat.id })
    const copy = s.layer(copied.ids[0])
    expect(copy.material).toBeUndefined()
    expect(Object.keys(copy.animations).some((p) => p.startsWith('material.'))).toBe(false)
    expect(s.layer(s.plane).material?.preset).toBe('gold')
  })
})

describe('world.look', () => {
  it('changes only the fields given and reports the result', async () => {
    const s = await withPlane()
    const done = await s.ok('world.look', { compId: s.w, toneMapping: 'aces', exposure: 1.5 })
    expect(done).toMatchObject({ toneMapping: 'aces', exposure: 1.5, shadows: true, shadowQuality: 'medium' })
    const w = s.comp(s.w).world!
    expect(w.render).toMatchObject({ toneMapping: 'aces', exposure: 1.5, shadows: true, bloom: { enabled: false } })
    await s.ok('world.look', { compId: s.w, shadows: false, shadowQuality: 'high' })
    expect(s.comp(s.w).world!.render).toMatchObject({ toneMapping: 'aces', exposure: 1.5, shadows: false, shadowQuality: 'high' })
  })

  it('maps mist to fog and merges its fields', async () => {
    const s = await withPlane()
    await s.ok('world.look', { compId: s.w, mist: { enabled: true, color: '#223344' } })
    expect(s.comp(s.w).world!.fog).toEqual({ enabled: true, color: '#223344', start: 1000, end: 20000 })
    await s.ok('world.look', { compId: s.w, mist: { start: 200, end: 5000 } })
    expect(s.comp(s.w).world!.fog).toEqual({ enabled: true, color: '#223344', start: 200, end: 5000 })
    expect((await s.fail('world.look', { compId: s.w, mist: { start: 900, end: 100 } })).error).toMatch(/ends \(100\) before it starts/)
    expect(s.comp(s.w).world!.fog.start).toBe(200)
  })

  it('refuses flat comps, empty calls and out-of-range values; one undo step', async () => {
    const s = await withPlane()
    const flat = s.session.project.comps.find((c) => !c.world) as Comp
    expect((await s.fail('world.look', { compId: flat.id, exposure: 1 })).error).toMatch(/flat comp, not a 3D world/)
    expect((await s.fail('world.look', { compId: s.w })).error).toMatch(/Say what to change/)
    expect((await s.fail('world.look', { compId: s.w, exposure: 99 })).error).toBeTruthy()
    const before = deepClone(s.session.project) as Project
    await s.ok('world.look', { compId: s.w, toneMapping: 'neutral', mist: { enabled: true } })
    s.session.undo()
    expect(s.session.project).toEqual(before)
  })

  it('turns bloom, ao and dof on when given fields without enabled', async () => {
    const s = await withPlane()
    const done = await s.ok('world.look', { compId: s.w, bloom: { strength: 0.9 }, ao: { radius: 40 } })
    expect(done.bloom).toMatchObject({ enabled: true, strength: 0.9 })
    expect(done.ao).toMatchObject({ enabled: true, radius: 40 })
  })

  it('sets bloom, ao and floor fields, with shorthands, keeping the rest', async () => {
    const s = await withPlane()
    const done = await s.ok('world.look', { compId: s.w, bloom: { enabled: true, strength: 2 }, ao: { enabled: false, radius: 120 }, floor: { mode: 'solid', color: '#112233' } })
    expect(done.bloom).toEqual({ enabled: true, strength: 2, radius: 0.5, threshold: 0.75, source: 'bright' })
    expect(done.ao).toEqual({ enabled: false, radius: 120, strength: 1 })
    expect(done.floor).toEqual({ mode: 'solid', color: '#112233', opacity: 0.45, z: 0 })
    await s.ok('world.look', { compId: s.w, bloom: { source: 'emission' }, floor: { opacity: 0.8, z: -50 } })
    const r = s.comp(s.w).world!.render
    expect(r.bloom).toEqual({ enabled: true, strength: 2, radius: 0.5, threshold: 0.75, source: 'emission' })
    expect(r.floor).toEqual({ mode: 'solid', color: '#112233', opacity: 0.8, z: -50 })
    await s.ok('world.look', { compId: s.w, bloom: false, ao: true, floor: 'mirror' })
    const r2 = s.comp(s.w).world!.render
    expect(r2.bloom).toMatchObject({ enabled: false, strength: 2 })
    expect(r2.ao).toEqual({ enabled: true, radius: 120, strength: 1 })
    expect(r2.floor).toMatchObject({ mode: 'mirror', color: '#112233', opacity: 0.8 })
    expect(r2.toneMapping).toBe('agx')
  })

  it('refuses out-of-range and unknown post values, writing nothing', async () => {
    const s = await withPlane()
    const before = deepClone(s.session.project) as Project
    for (const input of [
      { bloom: { strength: 5 } },
      { bloom: { radius: 2 } },
      { ao: { radius: 0 } },
      { ao: { strength: 3 } },
      { floor: 'lava' },
      { floor: { opacity: 2 } },
      { bloom: { glow: 1 } },
    ]) {
      expect((await s.fail('world.look', { compId: s.w, ...input })).error).toBeTruthy()
    }
    expect(s.session.project).toEqual(before)
  })

  describe('depth of field', () => {
    type CameraLayer = Layer & { kind: 'camera' }

    async function withCamera() {
      const s = await withPlane()
      const cam = (await s.ok('world.add', { compId: s.w, kind: 'camera', position: [0, -800, 0] })).id as string
      return { ...s, cam, camera: () => s.layer(cam) as CameraLayer }
    }

    it('writes the camera named by cameraId, mapping focusOn to focusObjectId', async () => {
      const s = await withCamera()
      const done = await s.ok('world.look', { compId: s.w, cameraId: s.cam, dof: { enabled: true, focusDistance: 640, fStop: 1.8 } })
      expect(done.cameraId).toBe(s.cam)
      expect(done.dof).toEqual({ enabled: true, focusDistance: 640, fStop: 1.8, focusObjectId: null })
      expect(done.note).toBeUndefined()
      await s.ok('world.look', { compId: s.w, cameraId: s.cam, dof: { focusOn: s.plane } })
      expect(s.camera().camera.dof).toEqual({ enabled: true, focusDistance: 640, fStop: 1.8, focusObjectId: s.plane })
      await s.ok('world.look', { compId: s.w, cameraId: s.cam, dof: { focusObjectId: null } })
      expect(s.camera().camera.dof.focusObjectId).toBeNull()
    })

    it('uses the live camera without cameraId, and infers the world from the camera', async () => {
      const s = await withCamera()
      s.session.view = () => ({ compId: s.w, playheadMs: 500 })
      const done = await s.ok('world.look', { dof: { enabled: true } })
      expect(done.cameraId).toBe(s.cam)
      expect(s.camera().camera.dof.enabled).toBe(true)
      s.session.view = () => ({})
      const other = await s.ok('world.look', { cameraId: s.cam, dof: { fStop: 4 } })
      expect(other.frameId).toBe(s.w)
      expect(other.dof.fStop).toBe(4)
    })

    it('refuses the default camera, a missing dof, and bad camera or focus targets', async () => {
      const s = await withPlane()
      const noCam = await s.fail('world.look', { compId: s.w, dof: { enabled: true } })
      expect(noCam.error).toMatch(/default camera/)
      expect(noCam.hint).toBe('world_camera {fromDefault: true} adds a camera at the default view first.')
      const cam = (await s.ok('world.add', { compId: s.w, kind: 'camera' })).id as string
      expect((await s.fail('world.look', { compId: s.w, cameraId: cam })).error).toMatch(/dof is missing/)
      expect((await s.fail('world.look', { compId: s.w, cameraId: s.plane, dof: { enabled: true } })).error).toMatch(/not a camera/)
      expect((await s.fail('world.look', { compId: s.w, cameraId: cam, dof: { focusOn: cam } })).error).toMatch(/cannot focus on itself/)
      expect((await s.fail('world.look', { compId: s.w, cameraId: cam, dof: { focusOn: 'nope' } })).error).toBeTruthy()
      expect((await s.fail('world.look', { compId: s.w, cameraId: cam, dof: {} })).error).toMatch(/nothing to change/)
      expect((await s.fail('world.look', { compId: s.w, cameraId: cam, dof: { fStop: 0 } })).error).toBeTruthy()
      expect((await s.fail('world.look', { compId: s.w, cameraId: cam, dof: { focusDistance: -1 } })).error).toBeTruthy()
      expect((await s.fail('world.look', { compId: s.w, cameraId: cam, dof: { focusOn: s.plane, focusObjectId: cam } })).error).toMatch(/different layers/)
      const other = (await s.ok('world.create', { starter: false })).frameId as string
      const foreign = (await s.ok('layer.create', { compId: other, kind: 'shape' })).id as string
      expect((await s.fail('world.look', { compId: s.w, cameraId: cam, dof: { focusOn: foreign } })).error).toMatch(/not in/)
      const flat = s.session.project.comps.find((c) => !c.world) as Comp
      expect((await s.fail('world.look', { compId: flat.id, dof: { enabled: true } })).error).toMatch(/flat comp/)
    })

    it('notes keyed focusDistance or fStop', async () => {
      const s = await withCamera()
      await s.ok('keyframes.set', { id: s.cam, path: 'camera.dof.focusDistance', keys: [{ t: 0, v: 300 }, { t: 1000, v: 900 }] })
      const done = await s.ok('world.look', { compId: s.w, cameraId: s.cam, dof: { focusDistance: 500, fStop: 2 } })
      expect(done.note).toMatch(/focusDistance is keyed/)
      expect(s.camera().camera.dof.focusDistance).toBe(500)
      const quiet = await s.ok('world.look', { compId: s.w, cameraId: s.cam, dof: { fStop: 3 } })
      expect(quiet.note).toBeUndefined()
    })

    it('is one undo step for look and camera together', async () => {
      const s = await withCamera()
      const before = deepClone(s.session.project) as Project
      await s.ok('world.look', { compId: s.w, exposure: 2, bloom: true, floor: 'shadow', cameraId: s.cam, dof: { enabled: true, focusOn: s.plane } })
      s.session.undo()
      expect(s.session.project).toEqual(before)
    })

    it('shows the look and the live camera dof in world.inspect', async () => {
      const s = await withCamera()
      await s.ok('world.look', { compId: s.w, bloom: { enabled: true }, ao: true, floor: { mode: 'solid' }, cameraId: s.cam, dof: { enabled: true, fStop: 2, focusOn: s.plane } })
      const info = await s.ok('world.inspect', { compId: s.w })
      expect(info.look.bloom.enabled).toBe(true)
      expect(info.look.ao.enabled).toBe(true)
      expect(info.look.floor.mode).toBe('solid')
      expect(info.camera.dof).toEqual({ enabled: true, focusDistance: 1000, fStop: 2, focusObjectId: s.plane })
      const def = await withPlane()
      expect((await def.ok('world.inspect', { compId: def.w })).camera.dof).toBeUndefined()
    })
  })
})
