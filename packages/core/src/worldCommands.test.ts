import { describe, expect, it } from 'vitest'
import { deepClone } from './clone'
import { createDefaultProject } from './doc'
import { sequentialIds } from './ids'
import { type Comp, type Layer, ProjectSchema } from './schema'
import { Session } from './session'
import { lookAtRotation, mat4RotateX, mat4RotateY, mat4RotateZ, mat4Compose, mat4TransformPoint } from './world'

function setup() {
  const ids = sequentialIds()
  const session = new Session({ project: createDefaultProject(ids), ids })
  // biome-ignore lint/suspicious/noExplicitAny: test results are checked field by field
  const ok = async (name: string, input: unknown = {}): Promise<any> => {
    const result = await session.call(name, input)
    if (!result.ok) throw new Error(name + ' failed: ' + result.error)
    return result.value
  }
  const fail = async (name: string, input: unknown) => {
    const result = await session.call(name, input)
    if (result.ok) throw new Error(name + ' should have failed')
    return { error: result.error, hint: result.hint ?? '' }
  }
  const comp = (id: string) => session.project.comps.find((c) => c.id === id) as Comp
  const layers = (id: string) => comp(id).tracks.flatMap((t) => t.layers) as Layer[]
  return { session, ok, fail, comp, layers }
}

const rad = (deg: number) => (deg * Math.PI) / 180

describe('world.create', () => {
  it('makes a world with the starter camera and lights, each on its own lane over the whole frame', async () => {
    const { ok, comp, layers } = setup()
    const made = await ok('world.create', {})
    const world = comp(made.frameId)
    expect(world.world?.render.toneMapping).toBe('agx')
    expect(world.world?.fog.enabled).toBe(false)
    expect([world.width, world.height, world.background]).toEqual([1920, 1080, '#16171b'])
    expect(made.objects.map((o: { kind: string }) => o.kind)).toEqual(['camera', 'light', 'light', 'mesh'])
    expect(made.note).toBeUndefined()
    expect(world.tracks).toHaveLength(4)
    const [camera, point, studio, cube] = layers(made.frameId)
    for (const l of [camera, point, studio, cube]) expect([l?.startMs, l?.durationMs]).toEqual([0, world.durationMs])
    expect(camera?.transform).toMatchObject({ x: 736, y: -693, z: 496 })
    expect(point?.kind === 'light' && point.light).toMatchObject({ type: 'point', intensity: 1500 })
    expect(point?.transform).toMatchObject({ x: 408, y: 100, z: 590 })
    expect(studio?.kind === 'light' && studio.light).toMatchObject({ type: 'environment', environment: 'studio', intensity: 0.3 })
  })

  it('aims the starter camera at the origin', async () => {
    const { ok, layers } = setup()
    const made = await ok('world.create', {})
    const t = (layers(made.frameId)[0] as Layer).transform
    const turn = mat4Compose(mat4RotateZ(rad(t.rotation)), mat4RotateY(rad(t.rotationY)), mat4RotateX(rad(t.rotationX)))
    const [fx, fy, fz] = mat4TransformPoint(turn, 0, 0, -1)
    const length = Math.hypot(736, 693, 496)
    expect(fx).toBeCloseTo(-736 / length, 9)
    expect(fy).toBeCloseTo(693 / length, 9)
    expect(fz).toBeCloseTo(-496 / length, 9)
    expect(t).toMatchObject(lookAtRotation([736, -693, 496], [0, 0, 0], 'camera'))
  })

  it('makes an empty transparent world, and is one undo step', async () => {
    const { ok, session, comp } = setup()
    const before = session.project.comps.length
    const made = await ok('world.create', { name: 'Space', width: 1080, height: 1920, starter: false, transparent: true })
    expect(made.objects).toEqual([])
    expect(made.note).toBeUndefined()
    expect(comp(made.frameId)).toMatchObject({ name: 'Space', width: 1080, height: 1920, background: '#00000000', tracks: [] })
    session.undo()
    expect(session.project.comps).toHaveLength(before)
  })
})

describe('world.inspect', () => {
  it('refuses a flat comp with AtomCut\'s message', async () => {
    const { session, fail } = setup()
    const flat = session.project.comps[0] as Comp
    const refused = await fail('world.inspect', { compId: flat.id })
    expect(refused.error).toBe(`"${flat.name}" is a flat comp, not a 3D world.`)
    expect(refused.hint).toMatch(/world_create/)
  })

  it('reports the starter camera, the environment and every object, rounded to 0.1', async () => {
    const { ok } = setup()
    const made = await ok('world.create', {})
    const seen = await ok('world.inspect', { frameId: made.frameId, atMs: 500 })
    expect(seen.output).toEqual([1920, 1080])
    expect(seen.liveCameraAtMs).toBe(500)
    expect(seen.camera.id).toBe(made.objects[0].id)
    expect(seen.camera.position).toEqual([736, -693, 496])
    expect(seen.camera.fovY).toBeCloseTo(22.9, 1)
    expect(seen.environment).toMatchObject({ preset: 'studio', intensity: 0.3 })
    expect(seen.objects.map((o: { kind: string }) => o.kind)).toEqual(['camera', 'light', 'light', 'mesh'])
    for (const o of seen.objects) for (const v of [...o.position, ...o.rotation]) expect(Math.round(v * 10) / 10).toBe(v)
  })

  it('falls back to the default front camera, and lists 2D layers as planes at their pivot', async () => {
    const { ok } = setup()
    const made = await ok('world.create', { starter: false })
    await ok('layer.create', { compId: made.frameId, kind: 'shape', name: 'Card', shape: { width: 200, height: 100 }, transform: { x: 50, y: 30, z: -20, anchorX: 0, anchorY: 0, scaleX: 2 } })
    const seen = await ok('world.inspect', { frameId: made.frameId, atMs: 0 })
    expect(seen.camera).toEqual({ id: 'default', position: [0, -2666.7, 0], rotation: [90, 0, 0], fovY: 22.9 })
    expect(seen.environment).toBeNull()
    expect(seen.objects).toEqual([{ id: expect.any(String), name: 'Card', kind: 'plane (shape)', position: [50, 30, -20], rotation: [0, 0, 0], size: [400, 100], opacity: 1 }])
  })

  it('follows the cut to a second camera on the lane, and skips a hidden lane', async () => {
    const { ok, session } = setup()
    const made = await ok('world.create', { starter: false, durationMs: 4000 })
    const camera = (id: string, startMs: number, x: number, focalLength: number) => ({
      id,
      name: id,
      kind: 'camera',
      startMs,
      durationMs: 2000,
      transform: { x, y: -1000, rotationX: 90 },
      camera: { focalLength },
    })
    const project = deepClone(session.project) as unknown as { comps: { id: string; tracks: unknown[] }[] }
    const world = project.comps.find((c) => c.id === made.frameId) as { tracks: unknown[] }
    world.tracks = [
      { id: 'lane_hidden', hidden: true, layers: [camera('cam_hidden', 0, -500, 20)] },
      { id: 'lane_cams', layers: [camera('cam_a', 0, 0, 50), camera('cam_b', 2000, 500, 85)] },
    ]
    session.load(ProjectSchema.parse(project))
    const atA = await ok('world.inspect', { frameId: made.frameId, atMs: 1999 })
    const atB = await ok('world.inspect', { frameId: made.frameId, atMs: 2000 })
    expect(atA.camera.id).toBe('cam_a')
    expect(atB.camera).toMatchObject({ id: 'cam_b', position: [500, -1000, 0], rotation: [90, 0, 0] })
    expect(atB.camera.fovY).toBeLessThan(atA.camera.fovY)
  })
})
