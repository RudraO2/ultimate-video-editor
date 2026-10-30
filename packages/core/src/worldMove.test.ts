import { describe, expect, it } from 'vitest'
import { deepClone } from './clone'
import { createDefaultProject } from './doc'
import { sequentialIds } from './ids'
import { flatTurns } from './moveInto'
import type { Measure, Placement } from './registry'
import type { Comp, Layer } from './schema'
import { Session } from './session'
import { mat4Compose, mat4Multiply, mat4Scale, mat4Translate, PICTURE_AXES, worldObjects } from './world'

/** A group's measured box, as the editor would report it. */
const BOX = { left: -300, top: -130, width: 500, height: 230 }

const stubMeasure: Measure = (comp: Comp) => {
  const out = new Map<string, Placement>()
  for (const layer of comp.tracks.flatMap((t) => t.layers)) {
    if (layer.kind !== 'group') continue
    out.set(layer.id, { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, bounds: BOX, box: BOX })
  }
  return out
}

function setup(measure?: Measure) {
  const ids = sequentialIds()
  const session = new Session({ project: createDefaultProject(ids), ids, ...(measure ? { measure } : {}) })
  // biome-ignore lint/suspicious/noExplicitAny: test results are checked field by field
  const ok = async (name: string, input: unknown = {}): Promise<any> => {
    const result = await session.call(name, input)
    if (!result.ok) throw new Error(`${name} failed: ${result.error}`)
    return result.value
  }
  const fail = async (name: string, input: unknown) => {
    const result = await session.call(name, input)
    if (result.ok) throw new Error(`${name} should have failed`)
    return result.error
  }
  const comp = (id: string) => session.project.comps.find((c) => c.id === id) as Comp
  const main = () => session.project.comps[0] as Comp
  const layer = (id: string) => session.project.comps.flatMap((c) => c.tracks.flatMap((t) => t.layers)).find((l) => l.id === id) as Layer
  return { session, ok, fail, comp, main, layer }
}

const shape = { width: 200, height: 100 }

describe('world.move_into: refusals', () => {
  it('refuses a world, audio only, and neither or both of ids and compId', async () => {
    const { ok, fail } = setup()
    const made = await ok('world.create', { starter: false })
    const inside = await ok('layer.create', { compId: made.frameId, kind: 'shape', name: 'Plane' })
    expect(await fail('world.move_into', { ids: [inside.id] })).toMatch(/Nothing to move: pick 2D layers in a flat comp/)
    expect(await fail('world.move_into', { compId: made.frameId })).toMatch(/already a 3D world/)
    const flat = await ok('comp.create', { name: 'Flat' })
    const media = await ok('media.add', { kind: 'audio', name: 'Song', path: 'C:/song.mp3', durationMs: 5000 })
    const song = await ok('layer.create', { compId: flat.id, kind: 'audio', mediaId: media.id })
    expect(await fail('world.move_into', { ids: [song.id] })).toBe('Nothing to move: pick 2D layers in a flat comp (audio, adjustments and 3D objects stay).')
    expect(await fail('world.move_into', {})).toMatch(/ids or compId/)
    expect(await fail('world.move_into', { ids: [song.id], compId: flat.id })).toMatch(/not both/)
  })
})

describe('world.move_into: layers', () => {
  it('nests full frame into a world with a clear background, no camera and one undo step', async () => {
    const { session, ok, comp, main, layer } = setup()
    const back = await ok('layer.create', { kind: 'shape', name: 'Back', startMs: 500, durationMs: 2000, shape })
    const front = await ok('layer.create', { kind: 'shape', name: 'Front', startMs: 1000, durationMs: 3000, shape })
    const before = deepClone(session.project)
    const moved = await ok('world.move_into', { ids: [back.id, front.id] })
    expect(moved.approximate).toBeUndefined()
    const world = comp(moved.frameId)
    expect(world).toMatchObject({ name: 'Front · 3D', width: 1920, height: 1080, background: '#00000000', embedded: true })
    expect(world.world).toBeDefined()
    expect(world.tracks.flatMap((t) => t.layers).some((l) => l.kind === 'camera')).toBe(false)
    expect(world.durationMs).toBe(3500)
    expect(main().tracks).toHaveLength(1)
    expect(main().tracks[0]?.layers[0]).toMatchObject({ id: moved.nestedId, kind: 'nested', sourceCompId: moved.frameId, startMs: 500, durationMs: 3500 })
    expect(layer(front.id).startMs).toBe(500)
    expect(session.undo()).toBe(true)
    expect(session.project).toEqual(before)
    expect(session.undo()).toBe(true)
  })

  it('swaps positions and renames key tracks, negating y and rotationX, and drops motion-path handles', async () => {
    const { ok, layer } = setup()
    const a = await ok('layer.create', { kind: 'shape', name: 'A', shape, transform: { x: 10, y: 20, z: 30, rotationX: 15, rotation: 40 } })
    await ok('keyframes.set', { id: a.id, property: 'position', keys: [{ at: 0, value: [0, 5], arc: 100 }, { at: 1000, value: [300, 50] }] })
    await ok('keyframes.set', { id: a.id, path: 'transform.z', keys: [{ t: 0, v: 7 }, { t: 1000, v: 70 }] })
    await ok('keyframes.set', { id: a.id, path: 'transform.rotationX', keys: [{ t: 0, v: 5 }, { t: 1000, v: 25 }] })
    await ok('keyframes.set', { id: a.id, path: 'transform.rotation', keys: [{ t: 0, v: 10 }, { t: 1000, v: 90 }] })
    expect(layer(a.id).animations['transform.x']?.[0]?.spatial).toBeDefined()
    const moved = await ok('world.move_into', { ids: a.id })
    const l = layer(a.id)
    const values = (path: string) => l.animations[path]?.map((k) => k.v)
    expect(l.transform).toMatchObject({ x: 10, y: 30, z: -20, rotationX: -15, rotationY: 40, rotation: 0 })
    expect(values('transform.x')).toEqual([0, 300])
    expect(l.animations['transform.x']?.every((k) => k.spatial === undefined)).toBe(true)
    expect(values('transform.z')).toEqual([-5, -50])
    expect(values('transform.y')).toEqual([7, 70])
    expect(values('transform.rotationX')).toEqual([-5, -25])
    expect(values('transform.rotationY')).toEqual([10, 90])
    expect(values('transform.rotation')).toBeUndefined()
    expect(moved.approximate).toBeUndefined()
  })

  it('lists a layer in approximate when rotation and rotationY both turn and one is keyed', async () => {
    const { ok } = setup()
    const a = await ok('layer.create', { kind: 'shape', name: 'A', shape, transform: { rotationY: 20 } })
    await ok('keyframes.set', { id: a.id, path: 'transform.rotation', keys: [{ t: 0, v: 0 }, { t: 1000, v: 90 }] })
    const b = await ok('layer.create', { kind: 'shape', name: 'B', shape, transform: { rotation: 20, rotationY: 30 } })
    const moved = await ok('world.move_into', { ids: [a.id, b.id] })
    expect(moved.approximate).toEqual([a.id])
  })
})

describe('world.move_into: frames', () => {
  it('makes a whole frame 3D, leaving audio and the frame in place', async () => {
    const { ok, comp, main } = setup()
    const media = await ok('media.add', { kind: 'audio', name: 'Song', path: 'C:/song.mp3', durationMs: 5000 })
    const song = await ok('layer.create', { kind: 'audio', mediaId: media.id })
    const a = await ok('layer.create', { kind: 'shape', name: 'A', shape })
    const b = await ok('layer.create', { kind: 'shape', name: 'B', shape })
    const moved = await ok('world.move_into', { frameId: main().id, name: 'Scene 3D' })
    expect(comp(moved.frameId).name).toBe('Scene 3D')
    expect(comp(moved.frameId).tracks.flatMap((t) => t.layers.map((l) => l.id)).sort()).toEqual([a.id, b.id].sort())
    expect(main().tracks.map((t) => t.layers.map((l) => l.id))).toEqual([[moved.nestedId], [song.id]])
  })

  it('gives an empty frame an empty world named after it', async () => {
    const { ok, comp, session } = setup()
    const scene = await ok('comp.create', { name: 'Scene', durationMs: 4000, width: 800, height: 600 })
    const before = deepClone(session.project)
    const moved = await ok('world.move_into', { compId: scene.id })
    const world = comp(moved.frameId)
    expect(world).toMatchObject({ name: 'Scene · 3D', width: 800, height: 600, durationMs: 4000, embedded: true, background: '#00000000' })
    expect(world.world).toBeDefined()
    expect(world.tracks).toHaveLength(0)
    expect(comp(scene.id).tracks[0]?.layers[0]).toMatchObject({ id: moved.nestedId, kind: 'nested', startMs: 0, durationMs: 4000 })
    session.undo()
    expect(session.project).toEqual(before)
  })
})

describe('world.move_into: groups', () => {
  it('keeps a turned, scaled group and its member where they were (group matrix about its measured pivot)', async () => {
    const { ok, comp } = setup(stubMeasure)
    const a = await ok('layer.create', { kind: 'shape', name: 'A', shape, transform: { x: 100, y: 50 } })
    const b = await ok('layer.create', { kind: 'shape', name: 'B', shape, transform: { x: -200, y: -80 } })
    const { groupId } = await ok('layers.group', { ids: [a.id, b.id], name: 'G' })
    const flatGroup = { x: 30, y: -20, z: 40, rotation: 25, rotationX: 15, rotationY: 10, scaleX: 1.5, scaleY: 0.8, anchorX: 0.3, anchorY: 0.7 }
    await ok('layer.patch', { id: groupId, ops: [{ op: 'merge', path: 'transform', value: flatGroup }] })
    const moved = await ok('world.move_into', { ids: [groupId] })
    expect(moved.approximate).toBeUndefined()
    const world = comp(moved.frameId)
    const objects = worldObjects(world, 0, { box: (l) => (l.kind === 'shape' ? l.shape : null) })
    const member = objects.find((o) => o.layer.id === a.id)
    expect(member?.parentId).toBe(groupId)
    // The flat matrices, written in the standard terms: T(t + p)·R·S·T(-p), then the member's own T(x, y).
    const px = BOX.left + flatGroup.anchorX * BOX.width
    const py = BOX.top + flatGroup.anchorY * BOX.height
    const g = mat4Compose(
      mat4Translate(flatGroup.x + px, flatGroup.y + py, flatGroup.z),
      flatTurns(flatGroup),
      mat4Scale(flatGroup.scaleX, flatGroup.scaleY, 1),
      mat4Translate(-px, -py, 0),
    )
    const flatMember = mat4Multiply(PICTURE_AXES, mat4Multiply(g, mat4Translate(100, 50, 0)))
    expect(member).toBeDefined()
    for (const [i, v] of flatMember.entries()) expect(member?.matrix[i]).toBeCloseTo(v, 9)
  })

  it('lists a turned group in approximate when no measure is there to find its pivot', async () => {
    const { ok } = setup()
    const a = await ok('layer.create', { kind: 'shape', name: 'A', shape })
    const { groupId } = await ok('layers.group', { ids: [a.id], name: 'G' })
    await ok('layer.patch', { id: groupId, ops: [{ op: 'merge', path: 'transform', value: { rotation: 30 } }] })
    expect((await ok('world.move_into', { ids: [groupId] })).approximate).toEqual([groupId])
  })

  it('needs no measure for a group that does not turn or scale', async () => {
    const { ok } = setup()
    const a = await ok('layer.create', { kind: 'shape', name: 'A', shape })
    const { groupId } = await ok('layers.group', { ids: [a.id], name: 'G' })
    await ok('layer.patch', { id: groupId, ops: [{ op: 'merge', path: 'transform', value: { x: 40, y: 10 } }] })
    expect((await ok('world.move_into', { ids: [groupId] })).approximate).toBeUndefined()
  })
})
