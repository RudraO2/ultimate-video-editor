import { describe, expect, it } from 'vitest'
import { createDefaultProject } from './doc'
import { sequentialIds } from './ids'
import { modelClipAt } from './meshes'
import { PROJECT_FILE_VERSION, ProjectFileError, readProjectFile, writeProjectFile } from './projectFile'
import type { Comp, Layer, MeshLayer, ModelInfo, Project } from './schema'
import { Session } from './session'

// Imported 3D models: the clip clock, adding a model to a world, changing its
// clip, and the project file.

const MODEL: ModelInfo = {
  format: 'glb',
  clips: [
    { name: 'Walk', durationMs: 2000 },
    { name: 'Idle', durationMs: 1000 },
  ],
  size: [120, 80, 180],
}

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
  const mesh = (compId: string, id: string) => layers(compId).find((l) => l.id === id) as MeshLayer
  const world = async () => (await ok('world.create', { starter: false })).frameId as string
  const model = async (clips = true, path = 'C:/models/Robot.glb') =>
    (await ok('media.add', { kind: 'model', name: 'Robot.glb', path, model: clips ? MODEL : { ...MODEL, clips: [] } })).id as string
  return { session, ok, fail, comp, layers, mesh, world, model }
}

describe('modelClipAt', () => {
  const asset = { model: MODEL }
  const at = (animation: MeshLayer['animation'], ms: number, ...given: [] | [typeof asset | undefined]) => modelClipAt({ animation }, given.length > 0 ? given[0] : asset, ms)

  it('wraps a looping clip and holds a clip that does not loop', () => {
    expect(at({ clip: 'Walk', speed: 1, loop: true }, 500)).toEqual({ clip: 'Walk', seconds: 0.5 })
    expect(at({ clip: 'Walk', speed: 1, loop: true }, 2500)?.seconds).toBeCloseTo(0.5)
    expect(at({ clip: 'Walk', speed: 1, loop: false }, 2500)).toEqual({ clip: 'Walk', seconds: 2 })
    expect(at({ clip: 'Walk', speed: 1, loop: false }, 60_000)?.seconds).toBe(2)
  })

  it('starts at 0 before the layer starts, and scales by speed', () => {
    expect(at({ clip: 'Idle', speed: 1, loop: true }, -300)).toEqual({ clip: 'Idle', seconds: 0 })
    expect(at({ clip: 'Walk', speed: 2, loop: true }, 750)?.seconds).toBeCloseTo(1.5)
    expect(at({ clip: 'Walk', speed: 0, loop: true }, 5000)?.seconds).toBe(0)
  })

  it('is null at rest: no animation, no clip, an unknown clip or an asset without clips', () => {
    expect(at(undefined, 100)).toBeNull()
    expect(at({ clip: null, speed: 1, loop: true }, 100)).toBeNull()
    expect(at({ clip: 'Run', speed: 1, loop: true }, 100)).toBeNull()
    expect(at({ clip: 'Walk', speed: 1, loop: true }, 100, undefined)).toBeNull()
    expect(at({ clip: 'Walk', speed: 1, loop: true }, 100, { model: { ...MODEL, clips: [] } })).toBeNull()
  })
})

describe('media.add for a model', () => {
  it('needs the model info, and only models take it', async () => {
    const s = setup()
    expect((await s.fail('media.add', { kind: 'model', name: 'a.glb', path: 'C:/a.glb' })).error).toMatch(/needs model/)
    expect((await s.fail('media.add', { kind: 'image', name: 'a.png', path: 'C:/a.png', model: MODEL })).error).toMatch(/only applies to 3D models/)
    const id = await s.model()
    expect(s.session.project.media.find((m) => m.id === id)).toMatchObject({ kind: 'model', model: { format: 'glb', clips: [{ name: 'Walk' }, { name: 'Idle' }] } })
    expect((await s.ok('media.add', { kind: 'model', name: 'Robot.glb', path: 'C:/models/Robot.glb', model: MODEL })).reused).toBe(true)
  })
})

describe('world.add with a model', () => {
  it('makes a mesh named after the file, playing its first clip in a loop', async () => {
    const s = setup()
    const w = await s.world()
    const assetId = await s.model()
    const made = await s.ok('world.add', { compId: w, kind: 'mesh', assetId, position: [10, 20, 30] })
    const robot = s.mesh(w, made.id)
    expect(robot).toMatchObject({ kind: 'mesh', name: 'Robot', geometry: { type: 'asset', assetId }, animation: { clip: 'Walk', speed: 1, loop: true }, fills: [] })
    expect(robot.transform).toMatchObject({ x: 10, y: 20, z: 30 })
  })

  it('has no animation when the file has no clips, and keeps a given name', async () => {
    const s = setup()
    const w = await s.world()
    const assetId = await s.model(false, 'C:/models/still.glb')
    const robot = s.mesh(w, (await s.ok('world.add', { compId: w, kind: 'mesh', assetId, name: 'Statue' })).id)
    expect(robot.name).toBe('Statue')
    expect(robot.animation).toBeUndefined()
  })

  it('refuses a missing asset, a non-model asset, and a primitive with an asset', async () => {
    const s = setup()
    const w = await s.world()
    const image = (await s.ok('media.add', { kind: 'image', name: 'a.png', path: 'C:/a.png', width: 10, height: 10 })).id as string
    expect((await s.fail('world.add', { compId: w, kind: 'mesh', assetId: 'media_missing' })).error).toMatch(/No media/)
    const notModel = await s.fail('world.add', { compId: w, kind: 'mesh', assetId: image })
    expect(notModel.error).toMatch(/not a 3D model/)
    expect(notModel.hint).toMatch(/world_import_model/)
    const assetId = await s.model()
    expect((await s.fail('world.add', { compId: w, kind: 'mesh', assetId, primitive: 'torus' })).error).toMatch(/not both/)
    expect((await s.fail('world.add', { compId: w, kind: 'light', assetId })).error).toMatch(/only apply to meshes/)
  })

  it('lists the model in world.inspect with its clips and size', async () => {
    const s = setup()
    const w = await s.world()
    const assetId = await s.model()
    await s.ok('world.add', { compId: w, kind: 'mesh', assetId })
    const inspected = await s.ok('world.inspect', { compId: w })
    const robot = inspected.objects.find((o: { name: string }) => o.name === 'Robot')
    expect(robot.model).toEqual({ assetId, clips: ['Walk', 'Idle'], clip: 'Walk' })
    expect(robot.size).toEqual([120, 80, 180])
  })
})

describe('changing a clip', () => {
  it('layer.set merges animation fields and checks the clip', async () => {
    const s = setup()
    const w = await s.world()
    const assetId = await s.model()
    const id = (await s.ok('world.add', { compId: w, kind: 'mesh', assetId })).id as string
    await s.ok('layer.set', { id, animation: { clip: 'Idle' } })
    expect(s.mesh(w, id).animation).toEqual({ clip: 'Idle', speed: 1, loop: true })
    await s.ok('layer.set', { id, animation: { speed: 2, loop: false } })
    expect(s.mesh(w, id).animation).toEqual({ clip: 'Idle', speed: 2, loop: false })
    await s.ok('layer.set', { id, animation: { clip: null } })
    expect(s.mesh(w, id).animation?.clip).toBeNull()
    const unknown = await s.fail('layer.set', { id, animation: { clip: 'Fly' } })
    expect(unknown.error).toMatch(/no animation clip "Fly"/)
    expect(unknown.hint).toMatch(/Walk, Idle/)
    expect(s.mesh(w, id).animation?.clip).toBeNull()
    // layer.set with neither values nor animation asks for one.
    expect((await s.fail('layer.set', { id })).error).toMatch(/at least one/)
  })

  it('layer.patch checks it too, and a primitive has no clips', async () => {
    const s = setup()
    const w = await s.world()
    const assetId = await s.model()
    const id = (await s.ok('world.add', { compId: w, kind: 'mesh', assetId })).id as string
    await s.ok('layer.patch', { id, ops: [{ op: 'set', path: 'animation.clip', value: 'Idle' }] })
    expect(s.mesh(w, id).animation?.clip).toBe('Idle')
    expect((await s.fail('layer.patch', { id, ops: [{ op: 'set', path: 'animation.clip', value: 'Fly' }] })).error).toMatch(/no animation clip/)

    const cube = (await s.ok('world.add', { compId: w, kind: 'mesh' })).id as string
    const refused = await s.fail('layer.set', { id: cube, animation: { clip: 'Walk' } })
    expect(refused.error).toMatch(/primitive/)
    expect((await s.fail('layer.patch', { id: cube, ops: [{ op: 'set', path: 'animation', value: { clip: null, speed: 1, loop: true } }] })).error).toMatch(/primitive/)
    const text = (await s.ok('layer.create', { compId: w, kind: 'text', text: 'Hi' })).id as string
    expect((await s.fail('layer.set', { id: text, animation: { clip: 'Walk' } })).error).toMatch(/only applies to model meshes/)
  })
})

describe('layer.create from model media', () => {
  it('refuses a flat comp, naming the world commands', async () => {
    const s = setup()
    const assetId = await s.model()
    const refused = await s.fail('layer.create', { kind: 'media', assetId })
    expect(refused.error).toBe('A model goes into a 3D world.')
    expect(refused.hint).toMatch(/world_create/)
    expect(refused.hint).toMatch(/world_import_model/)
  })

  it('makes a mesh in a world, from kind media or an explicit mesh', async () => {
    const s = setup()
    const w = await s.world()
    const assetId = await s.model()
    const fromMedia = s.mesh(w, (await s.ok('layer.create', { compId: w, kind: 'media', assetId })).id)
    expect(fromMedia).toMatchObject({ kind: 'mesh', name: 'Robot', geometry: { type: 'asset', assetId }, animation: { clip: 'Walk' }, fills: [] })
    const explicit = s.mesh(w, (await s.ok('layer.create', { compId: w, kind: 'mesh', mesh: { assetId } })).id)
    expect(explicit.geometry).toEqual({ type: 'asset', assetId })
    expect((await s.fail('layer.create', { compId: w, kind: 'media', assetId: 'media_missing' })).error).toMatch(/No media/)
  })

  it('counts a model mesh as a use of its media, so the file is kept until the mesh goes', async () => {
    const s = setup()
    const w = await s.world()
    const assetId = await s.model()
    const id = (await s.ok('world.add', { compId: w, kind: 'mesh', assetId })).id as string
    expect((await s.fail('media.remove', { id: assetId })).error).toMatch(/used by 1 layer/)
    await s.ok('layers.delete', { ids: [id] })
    await s.ok('media.remove', { id: assetId })
    expect(s.session.project.media).toHaveLength(0)
  })
})

describe('the project file with a model', () => {
  it('round trips the asset, the mesh and its animation, and lists the path in the manifest', async () => {
    const s = setup()
    const w = await s.world()
    const assetId = await s.model()
    const id = (await s.ok('world.add', { compId: w, kind: 'mesh', assetId })).id as string
    await s.ok('layer.set', { id, animation: { clip: 'Idle', speed: 0.5 } })
    const text = writeProjectFile(s.session.project)
    const file = JSON.parse(text)
    expect(file.formatVersion).toBe(PROJECT_FILE_VERSION)
    expect(PROJECT_FILE_VERSION).toBeGreaterThanOrEqual(11)
    expect(file.manifest.media).toEqual([{ id: assetId, kind: 'model', name: 'Robot.glb', path: 'C:/models/Robot.glb' }])
    const back = readProjectFile(text).project as Project
    expect(back.media[0]).toMatchObject({ kind: 'model', model: { format: 'glb', size: [120, 80, 180] } })
    const mesh = back.comps.find((c) => c.id === w)?.tracks.flatMap((t) => t.layers).find((l) => l.id === id) as MeshLayer
    expect(mesh).toMatchObject({ geometry: { type: 'asset', assetId }, animation: { clip: 'Idle', speed: 0.5, loop: true } })
  })

  it('refuses a mesh whose model is not in the project', async () => {
    const s = setup()
    const w = await s.world()
    const assetId = await s.model()
    await s.ok('world.add', { compId: w, kind: 'mesh', assetId })
    const file = JSON.parse(writeProjectFile(s.session.project))
    file.document.media = []
    file.manifest.media = []
    expect(() => readProjectFile(JSON.stringify(file))).toThrow(ProjectFileError)
    expect(() => readProjectFile(JSON.stringify(file))).toThrow(/model/)
  })
})
