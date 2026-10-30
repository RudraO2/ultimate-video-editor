import { describe, expect, it } from 'vitest'
import { deepClone } from './clone'
import { createDefaultProject } from './doc'
import { sequentialIds } from './ids'
import { evaluateProperty, resolveProperty } from './properties'
import { type CameraLayer, type Comp, LIGHT_TYPES, type Layer, type LightLayer, type Project } from './schema'
import { Session } from './session'
import { lookAtRotation, worldObjects } from './world'

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
  const layers = (id: string) => comp(id).tracks.flatMap((t) => t.layers) as Layer[]
  const layer = (compId: string, id: string) => layers(compId).find((l) => l.id === id) as Layer
  const world = async (durationMs = 4000) => (await ok('world.create', { starter: false, durationMs })).frameId as string
  /** The project before a command, to check that one undo step puts it back. */
  const snapshot = () => deepClone(session.project) as Project
  return { session, ok, fail, comp, layers, layer, world, snapshot }
}

const camera = (s: ReturnType<typeof setup>, compId: string, id: string) => s.layer(compId, id) as CameraLayer
const light = (s: ReturnType<typeof setup>, compId: string, id: string) => s.layer(compId, id) as LightLayer

describe('world.add', () => {
  it('gives every light type its own default intensity, a name and an optional colour', async () => {
    const s = setup()
    const w = await s.world()
    const expected = { point: 1000, spot: 1500, area: 800, sun: 3, environment: 1, hemisphere: 0.6 }
    expect(Object.keys(expected).sort()).toEqual([...LIGHT_TYPES].sort())
    for (const type of LIGHT_TYPES) {
      const made = await s.ok('world.add', { compId: w, kind: 'light', light: type, position: [10, 20, 30] })
      const l = light(s, w, made.id)
      expect(l.kind).toBe('light')
      expect(l.light).toMatchObject({ type, intensity: expected[type] })
      expect(l.transform).toMatchObject({ x: 10, y: 20, z: 30 })
    }
    const custom = await s.ok('world.add', { compId: w, kind: 'light', light: 'spot', intensity: 42, color: '#ff8800', name: 'Key' })
    expect(light(s, w, custom.id)).toMatchObject({ name: 'Key', light: { type: 'spot', intensity: 42, color: '#ff8800' } })
    const plain = await s.ok('world.add', { compId: w, kind: 'light' })
    expect(light(s, w, plain.id)).toMatchObject({ name: 'Point light', light: { type: 'point', intensity: 1000 } })
  })

  it('points a camera along +Y by default, takes a lens, and fills the comp on a new front lane', async () => {
    const s = setup()
    const w = await s.world(5000)
    const made = await s.ok('world.add', { compId: w, kind: 'camera', position: [0, -1500, 100], focalLength: 85 })
    const cam = camera(s, w, made.id)
    expect(cam).toMatchObject({ kind: 'camera', name: 'Camera', startMs: 0, durationMs: 5000 })
    expect(cam.camera.focalLength).toBe(85)
    expect(cam.transform).toMatchObject({ x: 0, y: -1500, z: 100, rotationX: 90, rotationY: 0, rotation: 0 })
    expect(s.comp(w).tracks[0]?.id).toBe(made.trackId)
    const second = await s.ok('world.add', { compId: w, kind: 'camera' })
    expect(s.comp(w).tracks[0]?.id).toBe(second.trackId)
    expect(second.note).toMatch(/live camera/)
    expect(made.note).toBeUndefined()
    expect(camera(s, w, second.id).camera.focalLength).toBe(50)
  })

  it('aims at a point, and at another layer by its position at the start', async () => {
    const s = setup()
    const w = await s.world()
    const point = await s.ok('world.add', { compId: w, kind: 'camera', position: [400, -900, 300], lookAt: [0, 0, 50] })
    expect(camera(s, w, point.id).transform).toMatchObject(lookAtRotation([400, -900, 300], [0, 0, 50], 'camera'))
    const front = await s.ok('world.add', { compId: w, kind: 'camera', position: [0, -1000, 0], lookAt: [0, 0, 0] })
    expect(camera(s, w, front.id).transform.rotationX).toBeCloseTo(90, 9)

    const target = await s.ok('world.add', { compId: w, kind: 'controller', position: [300, 100, 200] })
    const aimed = await s.ok('world.add', { compId: w, kind: 'camera', position: [-200, -800, 0], lookAt: target.id })
    expect(camera(s, w, aimed.id).transform).toMatchObject(lookAtRotation([-200, -800, 0], [300, 100, 200], 'camera'))
    const spot = await s.ok('world.add', { compId: w, kind: 'light', light: 'spot', position: [0, 0, 500], lookAt: target.id })
    expect(light(s, w, spot.id).transform).toMatchObject(lookAtRotation([0, 0, 500], [300, 100, 200], 'light'))
  })

  it('lets rotation win over lookAt, and still checks the target', async () => {
    const s = setup()
    const w = await s.world()
    const made = await s.ok('world.add', { compId: w, kind: 'camera', position: [400, -900, 300], lookAt: [0, 0, 0], rotation: [70, 10, -5] })
    expect(camera(s, w, made.id).transform).toMatchObject({ rotationX: 70, rotationY: 10, rotation: -5 })
    const refused = await s.fail('world.add', { compId: w, kind: 'camera', rotation: [0, 0, 0], lookAt: 'layer_missing' })
    expect(refused.error).toMatch(/layer_missing/)
  })

  it('makes a controller (an empty) with a position and a scale, uniform or per axis', async () => {
    const s = setup()
    const w = await s.world()
    const made = await s.ok('world.add', { compId: w, kind: 'controller', position: [1, 2, 3], scale: 2 })
    const e = s.layer(w, made.id)
    expect(e).toMatchObject({ kind: 'empty', name: 'Controller', transform: { x: 1, y: 2, z: 3, scaleX: 2, scaleY: 2, scaleZ: 2 } })
    const named = await s.ok('world.add', { compId: w, kind: 'controller', name: 'Rig', scale: [1, 2, 3] })
    expect(s.layer(w, named.id)).toMatchObject({ name: 'Rig', transform: { scaleX: 1, scaleY: 2, scaleZ: 3 } })
  })

  it('makes a text plane: the words, the colour, the turns, and world scales read as height', async () => {
    const s = setup()
    const w = await s.world()
    const made = await s.ok('world.add', { compId: w, kind: 'text', text: 'Hello world', color: '#ff0000', position: [50, 10, 200], rotation: [0, 0, 15], scale: [1, 2, 3] })
    const t = s.layer(w, made.id)
    if (t.kind !== 'text') throw new Error('expected a text layer')
    expect(t.text).toBe('Hello world')
    expect(t.name).toBe('Hello world')
    expect(t.style.color).toBe('#ff0000')
    expect(t.transform).toMatchObject({ x: 50, y: 10, z: 200, rotation: 15, scaleX: 1, scaleY: 3, scaleZ: 2 })
    const plain = await s.ok('world.add', { compId: w, kind: 'text' })
    expect(s.layer(w, plain.id)).toMatchObject({ kind: 'text', text: 'Text' })
    const faced = await s.ok('world.add', { compId: w, kind: 'text', position: [0, 0, 0], lookAt: [0, -1000, 0] })
    expect(s.layer(w, faced.id).transform).toMatchObject({ rotationX: 0, rotationY: 0, rotation: 0 })
  })

  it('refuses a flat comp, heads, a late start and a target that is not there', async () => {
    const s = setup()
    const flat = s.session.project.comps[0] as Comp
    const w = await s.world()
    const notWorld = await s.fail('world.add', { compId: flat.id, kind: 'camera' })
    expect(notWorld.error).toBe(`"${flat.name}" is a flat comp, not a 3D world.`)
    expect(notWorld.hint).toMatch(/world_create/)
    expect((await s.fail('world.add', { compId: flat.id, kind: 'mesh' })).error).toMatch(/flat comp/)
    expect((await s.fail('world.add', { compId: w, kind: 'head' })).error).toMatch(/not in this build/)
    expect((await s.fail('world.add', { compId: w, kind: 'camera', startMs: 4000 })).error).toMatch(/past the end/)
    const target = await s.ok('world.add', { compId: w, kind: 'controller', startMs: 0, durationMs: 1000 })
    const late = await s.fail('world.add', { compId: w, kind: 'camera', startMs: 2000, lookAt: target.id })
    expect(late.error).toMatch(/not on the timeline at 2000 ms/)
    expect((await s.fail('world.add', { compId: w, kind: 'camera', lookAt: [0, 0] })).error).toMatch(/Invalid input/)
  })

  it('spans the comp unless given a start and a length, and is one undo step', async () => {
    const s = setup()
    const w = await s.world(6000)
    const before = s.snapshot()
    const rest = await s.ok('world.add', { compId: w, kind: 'light', startMs: 1500 })
    expect(s.layer(w, rest.id)).toMatchObject({ startMs: 1500, durationMs: 4500 })
    const both = await s.ok('world.add', { compId: w, kind: 'light', startMs: 1000, durationMs: 500 })
    expect(s.layer(w, both.id)).toMatchObject({ startMs: 1000, durationMs: 500 })
    s.session.undo()
    s.session.undo()
    expect(s.session.project).toEqual(before)
    await s.ok('world.add', { compId: w, kind: 'text', text: 'x', lookAt: [1, 2, 3] })
    expect(s.comp(w).tracks).toHaveLength(1)
    s.session.undo()
    expect(s.session.project).toEqual(before)
  })
})

describe('world.camera', () => {
  /** Two cameras over the same time, A in front of B, and a point to read the live one by. */
  async function twoCameras() {
    const s = setup()
    const w = await s.world()
    const b = await s.ok('world.add', { compId: w, kind: 'camera', name: 'B', position: [500, -1000, 0] })
    const a = await s.ok('world.add', { compId: w, kind: 'camera', name: 'A', position: [-500, -1000, 0] })
    return { s, w, a: a.id as string, b: b.id as string }
  }

  it('only reports without activate or fromDefault, and writes nothing', async () => {
    const s = setup()
    const w = await s.world()
    expect(await s.ok('world.camera', { compId: w, atMs: 100 })).toEqual({ activeAt: 100, active: 'default' })
    const made = await s.ok('world.add', { compId: w, kind: 'camera' })
    const before = s.snapshot()
    expect(await s.ok('world.camera', { compId: w, atMs: 3000 })).toEqual({ activeAt: 3000, active: made.id })
    expect(s.session.project).toEqual(before)
  })

  it('activates a camera behind the live one by moving its lane in front', async () => {
    const { s, w, a, b } = await twoCameras()
    const before = s.snapshot()
    expect((await s.ok('world.camera', { compId: w, atMs: 500 })).active).toBe(a)
    const moved = await s.ok('world.camera', { compId: w, activate: b, atMs: 500 })
    expect(moved).toMatchObject({ cameraId: b, activeAt: 500, active: b })
    expect(s.comp(w).tracks[0]?.layers[0]?.id).toBe(b)
    expect(s.comp(w).tracks[1]?.layers[0]?.id).toBe(a)
    expect((await s.ok('world.inspect', { compId: w, atMs: 500 })).camera.id).toBe(b)
    s.session.undo()
    expect(s.session.project).toEqual(before)
  })

  it('turns a disabled camera and a hidden lane back on', async () => {
    const { s, w, a, b } = await twoCameras()
    await s.ok('layer.patch', { id: a, ops: [{ op: 'set', path: 'enabled', value: false }] })
    expect((await s.ok('world.camera', { compId: w, atMs: 0 })).active).toBe(b)
    const lane = s.comp(w).tracks[0]?.id as string
    await s.ok('track.update', { id: lane, hidden: true })
    const woken = await s.ok('world.camera', { compId: w, activate: a, atMs: 0 })
    expect(woken.active).toBe(a)
    expect(s.layer(w, a).enabled).toBe(true)
    expect(s.comp(w).tracks[0]?.hidden).toBe(false)
    const again = await s.ok('world.camera', { compId: w, activate: a, atMs: 0 })
    expect(again.note).toMatch(/already/)
  })

  it('refuses a camera that is not on the timeline then, a layer that is not a camera, and both options', async () => {
    const s = setup()
    const w = await s.world()
    const brief = await s.ok('world.add', { compId: w, kind: 'camera', startMs: 0, durationMs: 1000 })
    const lamp = await s.ok('world.add', { compId: w, kind: 'light' })
    const late = await s.fail('world.camera', { compId: w, activate: brief.id, atMs: 2000 })
    expect(late.error).toMatch(/not on the timeline at 2000 ms/)
    expect((await s.fail('world.camera', { compId: w, activate: lamp.id, atMs: 0 })).error).toMatch(/not a camera/)
    expect((await s.fail('world.camera', { compId: w, activate: brief.id, fromDefault: true })).error).toMatch(/not both/)
    const flat = s.session.project.comps[0] as Comp
    expect((await s.fail('world.camera', { compId: flat.id })).error).toBe(`"${flat.name}" is a flat comp, not a 3D world.`)
  })

  it('adds a camera at the default pose that leaves the picture unchanged', async () => {
    const s = setup()
    const w = await s.world()
    const before = await s.ok('world.inspect', { compId: w, atMs: 0 })
    expect(before.camera.id).toBe('default')
    const made = await s.ok('world.camera', { compId: w, fromDefault: true, atMs: 0 })
    expect(made.active).toBe(made.cameraId)
    const after = await s.ok('world.inspect', { compId: w, atMs: 0 })
    expect(after.camera.id).toBe(made.cameraId)
    expect(after.camera).toMatchObject({ position: before.camera.position, rotation: before.camera.rotation, fovY: before.camera.fovY })
    expect(s.layer(w, made.cameraId)).toMatchObject({ startMs: 0, durationMs: 4000 })
  })

  it('puts the default camera behind every other camera, so a cut still wins', async () => {
    const s = setup()
    const w = await s.world()
    const cut = await s.ok('world.add', { compId: w, kind: 'camera', startMs: 0, durationMs: 2000, position: [800, -900, 200], lookAt: [0, 0, 0] })
    const made = await s.ok('world.camera', { compId: w, fromDefault: true, atMs: 1000 })
    expect(made.active).toBe(cut.id)
    expect(s.comp(w).tracks.map((t) => t.layers[0]?.id)).toEqual([cut.id, made.cameraId])
    expect((await s.ok('world.camera', { compId: w, atMs: 3000 })).active).toBe(made.cameraId)
    s.session.undo()
    expect(s.comp(w).tracks).toHaveLength(1)
  })
})

describe('keyable camera, light and depth-scale paths', () => {
  const sampled = (layer: Layer, name: string, t: number) => evaluateProperty(layer, resolveProperty(layer, name)[0]!, t)

  it('keys a lens, a focus and an aperture on a camera', async () => {
    const s = setup()
    const w = await s.world()
    const made = await s.ok('world.add', { compId: w, kind: 'camera' })
    for (const [path, from, to] of [
      ['camera.focalLength', 35, 85],
      ['camera.dof.focusDistance', 500, 2500],
      ['camera.dof.fStop', 1.4, 8],
    ] as const) {
      await s.ok('keyframes.set', { id: made.id, path, keys: [{ t: 0, v: from, ease: 'linear' }, { t: 1000, v: to, ease: 'linear' }] })
      const l = s.layer(w, made.id)
      expect(sampled(l, path, 0)).toBe(from)
      expect(sampled(l, path, 500)).toBeCloseTo((from + to) / 2, 9)
      expect(sampled(l, path, 1000)).toBe(to)
    }
    // Their aliases work, and the range is checked.
    await s.ok('layer.set', { id: made.id, values: { focalLength: 24 }, mode: 'base' })
    expect(camera(s, w, made.id).camera.focalLength).toBe(24)
    expect((await s.fail('keyframes.set', { id: made.id, path: 'fStop', keys: [{ t: 0, v: 0.01 }] })).error).toMatch(/at least 0.1/)
    expect((await s.fail('keyframes.set', { id: made.id, path: 'camera.focalLength', keys: [{ t: 0, v: 6000 }] })).error).toMatch(/at most 5000/)
  })

  it('keys a light intensity and colour, and only on lights', async () => {
    const s = setup()
    const w = await s.world()
    const made = await s.ok('world.add', { compId: w, kind: 'light', light: 'point' })
    await s.ok('keyframes.set', { id: made.id, path: 'light.intensity', keys: [{ t: 0, v: 0, ease: 'linear' }, { t: 1000, v: 2000, ease: 'linear' }] })
    await s.ok('keyframes.set', { id: made.id, path: 'light.color', keys: [{ t: 0, v: '#000000', ease: 'linear' }, { t: 1000, v: '#ffffff', ease: 'linear' }] })
    const l = s.layer(w, made.id)
    expect(sampled(l, 'light.intensity', 250)).toBeCloseTo(500, 9)
    expect(sampled(l, 'light.color', 0)).toBe('#000000')
    expect(sampled(l, 'light.color', 1000)).toBe('#ffffff')
    const mid = sampled(l, 'color', 500)
    expect(mid).toMatch(/^#[0-9a-f]{6}/i)
    expect(mid).not.toBe('#000000')
    expect((await s.fail('keyframes.set', { id: made.id, path: 'camera.focalLength', keys: [{ t: 0, v: 50 }] })).error).toMatch(/no animatable property/)
    expect((await s.fail('keyframes.set', { id: made.id, path: 'light.intensity', keys: [{ t: 0, v: -1 }] })).error).toMatch(/at least 0/)
  })

  it('keys scaleZ on every kind, and a world samples it', async () => {
    const s = setup()
    const w = await s.world()
    const rig = await s.ok('world.add', { compId: w, kind: 'controller' })
    await s.ok('keyframes.set', { id: rig.id, path: 'scaleZ', keys: [{ t: 0, v: 1, ease: 'linear' }, { t: 1000, v: 3, ease: 'linear' }] })
    const at = (t: number) => worldObjects(s.comp(w), t).find((o) => o.layer.id === rig.id)?.scale[2]
    expect(at(0)).toBeCloseTo(1, 9)
    expect(at(500)).toBeCloseTo(2, 9)
    expect(at(1000)).toBeCloseTo(3, 9)

    const card = await s.ok('layer.create', { compId: w, kind: 'shape', shape: { width: 100, height: 100 } })
    await s.ok('keyframes.set', { id: card.id, path: 'transform.scaleZ', keys: [{ t: 0, v: 1 }, { t: 1000, v: 2 }] })
    expect(sampled(s.layer(w, card.id), 'scaleZ', 1000)).toBe(2)
    // A flat comp's layer has the property too (it simply does nothing there).
    const flat = s.session.project.comps[0] as Comp
    const note = await s.ok('layer.create', { compId: flat.id, kind: 'shape' })
    const props = await s.ok('layer.properties', { id: note.id })
    expect(JSON.stringify(props)).toMatch(/transform\.scaleZ/)
  })
})

describe('layer.create in a world', () => {
  it('makes a camera, a light and a controller from their own fields', async () => {
    const s = setup()
    const w = await s.world()
    const cam = await s.ok('layer.create', { compId: w, kind: 'camera', camera: { focalLength: 85, dof: { enabled: true, fStop: 4 } }, transform: { x: 10, rotationX: 90 } })
    expect(camera(s, w, cam.id)).toMatchObject({ kind: 'camera', name: 'Camera', camera: { focalLength: 85, dof: { enabled: true, fStop: 4, focusDistance: 1000 } }, transform: { x: 10, rotationX: 90 } })
    const lamp = await s.ok('layer.create', { compId: w, kind: 'light', name: 'Sun', light: { type: 'sun', intensity: 3, color: '#ffeecc' } })
    expect(light(s, w, lamp.id)).toMatchObject({ kind: 'light', name: 'Sun', light: { type: 'sun', intensity: 3, color: '#ffeecc' } })
    const rig = await s.ok('layer.create', { compId: w, kind: 'empty', empty: { display: 'cube', size: 120 } })
    expect(s.layer(w, rig.id)).toMatchObject({ kind: 'empty', name: 'Controller', empty: { display: 'cube', size: 120 } })
    expect(s.comp(w).tracks.map((t) => t.layers[0]?.id)).toEqual([rig.id, lamp.id, cam.id])
    expect(s.layer(w, cam.id)).toMatchObject({ startMs: 0, durationMs: 4000 })
  })

  it('refuses them in a flat comp, with fields of another kind, and with media or effects', async () => {
    const s = setup()
    const flat = s.session.project.comps[0] as Comp
    const w = await s.world()
    for (const kind of ['camera', 'light', 'empty']) {
      const refused = await s.fail('layer.create', { compId: flat.id, kind })
      expect(refused.error).toBe(`"${flat.name}" is a flat comp, not a 3D world.`)
      expect(refused.hint).toMatch(/world_create/)
    }
    expect((await s.fail('layer.create', { compId: w, kind: 'light', camera: { focalLength: 50 } })).error).toMatch(/camera only applies to camera layers/)
    expect((await s.fail('layer.create', { compId: w, kind: 'text', light: { type: 'sun' } })).error).toMatch(/light only applies/)
    expect((await s.fail('layer.create', { compId: w, kind: 'camera', mediaId: 'media_1' })).error).toMatch(/does not use media/)
    expect((await s.fail('layer.create', { compId: w, kind: 'light', effects: [{ type: 'glow' }] })).error).toMatch(/no pixels for effects/)
    expect(flat.tracks).toHaveLength(0)
  })
})

describe('world.inspect with a keyed lens', () => {
  it('reports the live camera field of view from its keyed focal length', async () => {
    const s = setup()
    const w = await s.world()
    const made = await s.ok('world.add', { compId: w, kind: 'camera', position: [0, -2000, 0], focalLength: 35 })
    await s.ok('keyframes.set', { id: made.id, path: 'camera.focalLength', keys: [{ t: 0, v: 35 }, { t: 2000, v: 85 }] })
    const fovAt = async (atMs: number) => (await s.ok('world.inspect', { compId: w, atMs })).camera.fovY as number
    // Sensor 36 mm on the long side of 1920 × 1080: fovY = 2·atan(18 / f · 1080 / 1920).
    const expected = (f: number) => Math.round(2 * Math.atan((18 / f) * (1080 / 1920)) * (1800 / Math.PI)) / 10
    expect(await fovAt(0)).toBe(expected(35))
    expect(await fovAt(2000)).toBe(expected(85))
    expect(await fovAt(1000)).toBeLessThan(expected(35))
  })
})
