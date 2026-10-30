import { describe, expect, it } from 'vitest'
import { createDefaultProject } from './doc'
import { sequentialIds } from './ids'
import { evaluateProperty, propertiesOf, resolveProperty } from './properties'
import { PROJECT_FILE_VERSION, readProjectFile, writeProjectFile } from './projectFile'
import { type Comp, type Layer, MediaAssetSchema, type Project } from './schema'
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
    return `${result.error}\n${result.hint ?? ''}`
  }
  const comp = (id = 'comp_1') => session.project.comps.find((c) => c.id === id) as Comp
  const layer = (id: string) => session.project.comps.flatMap((c) => c.tracks.flatMap((t) => t.layers)).find((l) => l.id === id) as Layer
  const box = async (name?: string, compId = 'comp_1') => (await ok('layer.create', { compId, kind: 'shape', shape: 'rect', ...(name ? { name } : {}) })).id as string
  return { session, ok, fail, comp, layer, box }
}

describe('physics.scene', () => {
  it('starts without settings and merges what is given over the defaults', async () => {
    const { ok, comp } = setup()
    expect(comp().physics).toBeUndefined()
    const read = await ok('physics.scene', {})
    expect(read.physics).toEqual({ gravity: 981, startMs: 0, floor: true, floorAt: null, walls: false, timeScale: 1 })
    expect(comp().physics).toBeUndefined()
    const first = await ok('physics.scene', { gravity: 0, walls: true })
    expect(first.physics).toMatchObject({ gravity: 0, walls: true, floor: true, timeScale: 1 })
    const second = await ok('physics.scene', { frameId: 'comp_1', floorAt: 300, timeScale: 0.5 })
    expect(second.physics).toEqual({ gravity: 0, startMs: 0, floor: true, floorAt: 300, walls: true, timeScale: 0.5 })
    await ok('physics.scene', { floorAt: null })
    expect(comp().physics?.floorAt).toBeNull()
  })

  it('refuses out-of-range values and 3D worlds, and undoes in one step', async () => {
    const { ok, fail, session, comp } = setup()
    expect(await fail('physics.scene', { timeScale: 9 })).toContain('timeScale')
    const world = (await ok('world.create', {})).frameId as string
    expect(await fail('physics.scene', { compId: world, gravity: 10 })).toContain('later')
    await ok('physics.scene', { compId: 'comp_1', gravity: 500 })
    expect(session.undo()).toBe(true)
    expect(comp().physics).toBeUndefined()
  })
})

describe('physics.body', () => {
  it('makes an active body with defaults, then updates only what is given', async () => {
    const { ok, layer, box } = setup()
    const id = await box('Crate')
    const made = await ok('physics.body', { ids: 'Crate' })
    expect(made.bodies).toEqual([
      { id, name: 'Crate', physics: { type: 'active', shape: 'auto', mass: 1, bounce: 0.3, friction: 0.5, velocity: [0, 0, 0], spin: [0, 0, 0], damping: 0.01, follow: 0 } },
    ])
    await ok('physics.body', { ids: [id], mass: 4, velocity: [100, -50] })
    expect(layer(id).physics).toMatchObject({ type: 'active', mass: 4, bounce: 0.3, velocity: [100, -50, 0] })
    await ok('physics.body', { ids: id, type: 'passive', shape: 'box' })
    expect(layer(id).physics).toMatchObject({ type: 'passive', shape: 'box', mass: 4 })
  })

  it('refuses bad values with the schema message', async () => {
    const { fail, box } = setup()
    const id = await box()
    expect(await fail('physics.body', { ids: id, bounce: 2 })).toContain('bounce')
    expect(await fail('physics.body', { ids: id, mass: 0 })).toContain('mass')
  })

  it('refuses group members, audio, and layers in a 3D world', async () => {
    const { ok, fail, session, box } = setup()
    const a = await box('A')
    const b = await box('B')
    const { groupId } = await ok('layers.group', { ids: [a, b], name: 'Pair' })
    expect(await fail('physics.body', { ids: a })).toContain('Make the whole group the body')
    await ok('physics.body', { ids: groupId })
    const path = 'C:/sounds/pop.wav'
    const media = (await ok('media.add', { kind: 'audio', name: 'pop.wav', path, durationMs: 1000 })).id as string
    const audio = (await ok('layer.create', { kind: 'audio', mediaId: media })).id as string
    expect(await fail('physics.body', { ids: audio })).toContain('audio')
    const world = (await ok('world.create', {})).frameId as string
    const inWorld = session.project.comps.find((c) => c.id === world)?.tracks.flatMap((t) => t.layers)[0] as Layer
    expect(await fail('physics.body', { ids: inWorld.id })).toContain('3D world')
  })

  it('type null removes the body, its joints, and joints on others that hold on to it', async () => {
    const { ok, layer, box } = setup()
    const floor = await box('Floor')
    const ball = await box('Ball')
    const rock = await box('Rock')
    await ok('physics.body', { ids: [floor, ball, rock] })
    await ok('physics.joint', { id: ball, add: [{ type: 'pin', target: floor }, { type: 'spring', target: null }] })
    await ok('physics.joint', { id: rock, add: [{ type: 'rope', target: ball }, { type: 'pin', target: floor }] })
    expect(layer(ball).joints).toHaveLength(2)
    const removed = await ok('physics.body', { ids: ball, type: null })
    expect(removed.bodies).toEqual([{ id: ball, name: 'Ball', physics: null }])
    expect(layer(ball).physics).toBeUndefined()
    expect(layer(ball).joints).toBeUndefined()
    expect(layer(rock).joints?.map((j) => j.target)).toEqual([floor])
    await ok('physics.body', { ids: floor, type: null })
    expect(layer(rock).joints).toBeUndefined()
  })
})

describe('physics.force', () => {
  it('makes an invisible carrier layer with a card, in the comp', async () => {
    const { ok, comp, layer } = setup()
    const made = await ok('physics.force', { type: 'wind', strength: 900, position: [-300, 40], rotation: 90 })
    expect(made.forceId).toBe('force_1')
    expect(made.force).toMatchObject({ id: 'force_1', type: 'wind', strength: 900, radius: 0, falloff: 'smooth', scale: 240, seed: 0, enabled: true })
    const carrier = layer(made.layerId)
    expect(carrier).toMatchObject({ kind: 'shape', name: 'Wind', startMs: 0, durationMs: 10_000, fills: [], strokes: [], transform: { x: -300, y: 40, rotation: 90 } })
    expect(carrier.forces).toEqual([made.force])
    expect(comp().tracks).toHaveLength(1)
  })

  it('names the carrier after the type, or as asked, and defaults to wind at the centre', async () => {
    const { ok, layer } = setup()
    const a = await ok('physics.force', {})
    expect(layer(a.layerId)).toMatchObject({ name: 'Wind', transform: { x: 0, y: 0, rotation: 0 } })
    const b = await ok('physics.force', { type: 'vortex', name: 'Whirl', radius: 400 })
    expect(layer(b.layerId).name).toBe('Whirl')
    expect(b.force).toMatchObject({ type: 'vortex', radius: 400 })
  })

  it('adds a card to an existing layer, appending, and turns it only when asked', async () => {
    const { ok, layer, box } = setup()
    const id = await box('Fan')
    const first = await ok('physics.force', { id, type: 'point', strength: -200 })
    const second = await ok('physics.force', { id, type: 'drag', name: 'Air', rotation: 30 })
    expect(first.layerId).toBe(id)
    expect(layer(id).forces?.map((f) => [f.id, f.type, f.name])).toEqual([
      ['force_1', 'point', undefined],
      ['force_2', 'drag', 'Air'],
    ])
    expect(second.forceId).toBe('force_2')
    expect(layer(id).transform.rotation).toBe(30)
  })

  it('refuses a world and audio, and bad values', async () => {
    const { ok, fail } = setup()
    const world = (await ok('world.create', {})).frameId as string
    expect(await fail('physics.force', { compId: world })).toContain('later')
    expect(await fail('physics.force', { radius: -1 })).toContain('radius')
  })

  it('keys strength like an effect field: a gust is two keys', async () => {
    const { ok, fail, layer } = setup()
    const { layerId, forceId } = await ok('physics.force', { strength: 0 })
    const path = `force.${forceId}.strength`
    const l = layer(layerId)
    expect(propertiesOf(l).map((s) => s.path)).toEqual(expect.arrayContaining([path, `force.${forceId}.radius`, `force.${forceId}.scale`]))
    expect(propertiesOf(l).some((s) => s.path.endsWith('.enabled'))).toBe(false)
    await ok('keyframes.set', { id: layerId, property: path, keys: [{ at: 0, value: 0 }, { at: 1000, value: 1000 }] })
    const spec = resolveProperty(layer(layerId), path)[0]!
    expect(evaluateProperty(layer(layerId), spec, 500)).toBe(500)
    expect(evaluateProperty(layer(layerId), spec, 1000)).toBe(1000)
    expect(await fail('layer.set', { id: layerId, values: { 'force.nope.strength': 1 } })).toContain('force.<forceId>.strength')
    expect(await fail('keyframes.set', { id: layerId, property: `force.${forceId}.enabled`, keys: [{ at: 0, value: 1 }] })).toContain('force.<forceId>')
  })

  it('edits, reorders and removes a card with effects.update', async () => {
    const { ok, fail, layer, box } = setup()
    const id = await box('Gadget')
    const a = (await ok('physics.force', { id, type: 'wind' })).forceId as string
    const b = (await ok('physics.force', { id, type: 'turbulence' })).forceId as string
    const edited = await ok('effects.update', { id, effectId: b, values: { strength: 120, scale: 80, seed: 7 }, enabled: false, index: 0 })
    expect(edited.force).toMatchObject({ id: b, strength: 120, scale: 80, seed: 7, enabled: false })
    expect(layer(id).forces?.map((f) => f.id)).toEqual([b, a])
    expect(await fail('effects.update', { id, effectId: a, values: { colour: 'red' } })).toContain('no field')
    expect(await fail('effects.update', { id, effectId: a, values: { strength: -1000, falloff: 'zigzag' } })).toContain('falloff')
    await ok('keyframes.set', { id, property: `force.${a}.strength`, keys: [{ at: 0, value: 0 }, { at: 500, value: 100 }] })
    expect(await fail('effects.update', { id, effectId: a, values: { strength: 5 } })).toContain('animated')
    const removed = await ok('effects.update', { id, effectId: a, remove: true })
    expect(removed.droppedKeys).toEqual([`force.${a}.strength`])
    expect(layer(id).animations[`force.${a}.strength`]).toBeUndefined()
    await ok('effects.update', { id, effectId: b, remove: true })
    expect(layer(id).forces).toBeUndefined()
  })

  it('leaves effect cards alone', async () => {
    const { ok, layer, box } = setup()
    const id = await box()
    const fx = (await ok('effects.add', { id, type: 'shadow' })).effectId as string
    await ok('physics.force', { id })
    await ok('effects.update', { id, effectId: fx, values: { blur: 3 } })
    expect(layer(id).effects[0]).toMatchObject({ blur: 3 })
    expect(layer(id).forces).toHaveLength(1)
  })

  it('mints ids for forces and joints inserted with layer.patch', async () => {
    const { ok, layer, box } = setup()
    const id = await box()
    await ok('layer.patch', { id, ops: [{ op: 'set', path: 'forces', value: [{ type: 'wind' }] }] })
    expect(layer(id).forces?.[0]?.id).toMatch(/^force_/)
  })
})

describe('physics.joint', () => {
  it('adds joints with defaults, pads anchors, edits and removes them', async () => {
    const { ok, fail, layer, box } = setup()
    const a = await box('Arm')
    const b = await box('Base')
    await ok('physics.body', { ids: [a, b] })
    expect(await fail('physics.joint', { id: await box('Loose'), add: [{}] })).toContain('physics.body')
    const added = await ok('physics.joint', { id: a, add: [{ type: 'rope', target: 'Base', anchor: [10, 20], targetAnchor: [0, 5], length: 150 }, {}] })
    expect(added.joints).toEqual([
      { id: 'joint_1', type: 'rope', target: b, anchor: [10, 20, 0], targetAnchor: [0, 5, 0], stiffness: 40, damping: 2, length: 150, enabled: true },
      { id: 'joint_2', type: 'pin', target: null, anchor: [0, 0, 0], targetAnchor: null, stiffness: 40, damping: 2, length: null, enabled: true },
    ])
    const edited = await ok('physics.joint', { id: a, edit: [{ joint: 'joint_2', type: 'spring', stiffness: 90, targetAnchor: [100, 100], length: null }, { joint: 'joint_1', enabled: false }] })
    expect(edited.joints[0]).toMatchObject({ id: 'joint_1', enabled: false, length: 150 })
    expect(edited.joints[1]).toMatchObject({ id: 'joint_2', type: 'spring', stiffness: 90, targetAnchor: [100, 100, 0] })
    expect((await ok('physics.joint', { id: a })).joints).toHaveLength(2)
    const removed = await ok('physics.joint', { id: a, remove: ['joint_1'] })
    expect(removed.joints.map((j: { id: string }) => j.id)).toEqual(['joint_2'])
    expect(layer(a).joints).toHaveLength(1)
    await ok('physics.joint', { id: a, remove: ['joint_2'] })
    expect(layer(a).joints).toBeUndefined()
  })

  it('refuses a target that is not a body, itself, another comp, or an unknown joint', async () => {
    const { ok, fail, box } = setup()
    const a = await box('A')
    const plain = await box('Plain')
    await ok('physics.body', { ids: a })
    expect(await fail('physics.joint', { id: a, add: [{ target: plain }] })).toContain('not a physics body')
    expect(await fail('physics.joint', { id: a, add: [{ target: a }] })).toContain('itself')
    expect(await fail('physics.joint', { id: a, remove: ['joint_99'] })).toContain('no joint')
    const other = (await ok('frame.create', { name: 'Other' })).id as string
    const foreign = await box('Foreign', other)
    await ok('physics.body', { ids: foreign })
    expect(await fail('physics.joint', { id: a, add: [{ target: foreign }] })).toContain('another comp')
    expect(await fail('physics.joint', { id: a, add: [{ type: 'hinge' }] })).toContain('type')
  })

  it('fails without a trace', async () => {
    const { ok, fail, layer, box, session } = setup()
    const a = await box('A')
    await ok('physics.body', { ids: a })
    const before = JSON.stringify(session.project)
    await fail('physics.joint', { id: a, add: [{ type: 'pin' }, { target: 'nothing' }] })
    expect(JSON.stringify(session.project)).toBe(before)
    expect(layer(a).joints).toBeUndefined()
  })
})

describe('keeping physics consistent', () => {
  it('deleting a layer removes the joints that held on to it', async () => {
    const { ok, layer, box } = setup()
    const a = await box('A')
    const b = await box('B')
    await ok('physics.body', { ids: [a, b] })
    await ok('physics.joint', { id: a, add: [{ target: b }, { target: null }] })
    await ok('layers.delete', { ids: [b] })
    expect(layer(a).joints?.map((j) => j.target)).toEqual([null])
  })

  it('a duplicate keeps its physics, forces and joints; a joint between two copied bodies follows the copies', async () => {
    const { ok, layer, box } = setup()
    const a = await box('A')
    const b = await box('B')
    await ok('physics.body', { ids: [a, b], mass: 3 })
    await ok('physics.joint', { id: a, add: [{ target: b }] })
    await ok('physics.force', { id: a, type: 'wind' })
    const [copyA] = (await ok('layers.duplicate', { ids: [a] })).ids as string[]
    expect(layer(copyA as string)).toMatchObject({ physics: { mass: 3 }, joints: [{ target: b }], forces: [{ type: 'wind' }] })
    const copies = (await ok('layers.copy', { ids: [a, b] })).ids as string[]
    expect(layer(copies[0] as string).joints?.[0]?.target).toBe(copies[1])
  })

  it('a copy sent to another comp drops joints to bodies it left behind', async () => {
    const { ok, layer, box } = setup()
    const a = await box('A')
    const b = await box('B')
    await ok('physics.body', { ids: [a, b] })
    await ok('physics.joint', { id: a, add: [{ target: b }, { target: null }] })
    const other = (await ok('frame.create', { name: 'Other' })).id as string
    const [copy] = (await ok('layers.copy', { ids: [a], toCompId: other })).ids as string[]
    expect(layer(copy as string).joints?.map((j) => j.target)).toEqual([null])
  })
})

describe('project file with physics', () => {
  it('round trips every physics field and the silhouette', async () => {
    const { ok, session, box } = setup()
    const a = await box('A')
    const b = await box('B')
    await ok('physics.scene', { gravity: 300, floorAt: 200, walls: true, startMs: 500, timeScale: 2 })
    await ok('physics.body', { ids: [a, b], spin: [0, 0, 90] })
    await ok('physics.joint', { id: a, add: [{ type: 'spring', target: b, length: 80 }] })
    const { layerId } = await ok('physics.force', { type: 'turbulence', seed: 4, scale: 60 })
    const media = (await ok('media.add', { kind: 'image', name: 'blob.png', path: 'C:/pics/blob.png', width: 100, height: 100 })).id as string
    const outline = [[[0, 0], [1, 0], [0.5, 1]]]
    const project = JSON.parse(JSON.stringify(session.project)) as Project
    project.media = project.media.map((m) => (m.id === media ? MediaAssetSchema.parse({ ...m, silhouette: outline }) : m))

    const text = writeProjectFile(project)
    expect(JSON.parse(text).formatVersion).toBe(PROJECT_FILE_VERSION)
    const back = readProjectFile(text).project as Project
    expect(back).toEqual(project)
    expect(back.media.find((m) => m.id === media)?.silhouette).toEqual(outline)
    expect(back.comps[0]?.physics).toMatchObject({ gravity: 300, floorAt: 200, walls: true, startMs: 500, timeScale: 2 })
    const layers = back.comps[0]?.tracks.flatMap((t) => t.layers) ?? []
    expect(layers.find((l) => l.id === a)).toMatchObject({ physics: { spin: [0, 0, 90] }, joints: [{ type: 'spring', target: b, length: 80 }] })
    expect(layers.find((l) => l.id === layerId)?.forces?.[0]).toMatchObject({ type: 'turbulence', seed: 4, scale: 60 })
  })

  it('opens an earlier file that has no physics', () => {
    const project = createDefaultProject(sequentialIds())
    const text = writeProjectFile(project)
    const older = JSON.parse(text)
    older.formatVersion = 14
    const back = readProjectFile(JSON.stringify(older)).project as Project
    expect(back.comps[0]?.physics).toBeUndefined()
  })
})
