import { describe, expect, it } from 'vitest'
import { deepClone } from './clone'
import { createDefaultProject } from './doc'
import { sequentialIds } from './ids'
import { MESH_DEFAULT_COLOR, meshColor, meshGeometryAt, type PrimitiveGeometry } from './meshes'
import { findPrimitive, PRIMITIVE_IDS, PRIMITIVES, primitiveKey, primitiveParams, primitiveSize } from './primitives'
import { propertiesOf, resolveProperty } from './properties'
import { readProjectFile, writeProjectFile } from './projectFile'
import { type Comp, type Layer, type MeshLayer, type Project } from './schema'
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
  const layers = (id: string) => comp(id).tracks.flatMap((t) => t.layers) as Layer[]
  const mesh = (compId: string, id: string) => layers(compId).find((l) => l.id === id) as MeshLayer
  const world = async () => (await ok('world.create', { starter: false })).frameId as string
  return { session, ok, fail, comp, layers, mesh, world }
}

describe('primitives', () => {
  it('has the 13 primitives, each with params that resolve to defaults', () => {
    expect(PRIMITIVES.map((p) => p.id)).toEqual([...PRIMITIVE_IDS])
    expect(PRIMITIVE_IDS).toHaveLength(13)
    for (const p of PRIMITIVES) {
      expect(Object.keys(primitiveParams(p.id))).toEqual(p.params.map((q) => q.key))
      expect(primitiveSize(p.id).every((v) => Number.isFinite(v))).toBe(true)
    }
  })

  it('clamps to the ranges, rounds counts and ignores what is not a number', () => {
    expect(primitiveParams('cube', { sizeX: -5, segments: 2.6, filletSegments: 99 })).toMatchObject({ sizeX: 0.01, sizeY: 200, segments: 3, filletSegments: 32 })
    expect(primitiveParams('uvSphere', { arc: 400, radius: Number.NaN })).toMatchObject({ arc: 180, radius: 100 })
    expect(primitiveParams('icoSphere', { subdivisions: 2.4 }).subdivisions).toBe(2)
    expect(primitiveKey('cube', { sizeX: 200 })).toBe('cube|200|200|200|0|4|1')
  })

  it('measures its bounding box before the scale', () => {
    expect(primitiveSize('cube')).toEqual([200, 200, 200])
    expect(primitiveSize('plane', { sizeX: 300, sizeY: 100 })).toEqual([300, 100, 0])
    expect(primitiveSize('uvSphere', { radius: 50 })).toEqual([100, 100, 100])
    expect(primitiveSize('capsule')).toEqual([100, 100, 200])
    expect(primitiveSize('torus')).toEqual([250, 250, 50])
    expect(primitiveSize('cone', { radius1: 40, radius2: 60, depth: 10 })).toEqual([120, 120, 10])
    expect(primitiveSize('pyramid')).toEqual([200, 200, 200])
  })
})

describe('world.add mesh', () => {
  it('adds a default cube at the origin, filling the frame, with a grey fill', async () => {
    const s = setup()
    const w = await s.world()
    const made = await s.ok('world.add', { compId: w, kind: 'mesh' })
    const cube = s.mesh(w, made.id)
    expect(cube).toMatchObject({ kind: 'mesh', name: 'Cube', startMs: 0, durationMs: 10_000, shading: 'auto', smoothAngle: 30, castShadow: true, receiveShadow: true })
    expect(cube.geometry).toEqual({ type: 'primitive', primitive: 'cube', params: {} })
    expect(cube.transform).toMatchObject({ x: 0, y: 0, z: 0, scaleX: 1, scaleY: 1, scaleZ: 1 })
    expect(meshColor(cube)).toBe(MESH_DEFAULT_COLOR)
    expect(cube.fills).toHaveLength(1)
    expect(cube.material).toBeUndefined()
  })

  it('takes a primitive, params as given (sparse), a colour, a name and scale as [x, y, z]', async () => {
    const s = setup()
    const w = await s.world()
    const made = await s.ok('world.add', { compId: w, kind: 'mesh', primitive: 'torus', params: { majorRadius: 150 }, color: '#ff8800', name: 'Ring', position: [10, 20, 30], scale: [1, 2, 3] })
    const ring = s.mesh(w, made.id)
    expect(ring).toMatchObject({ name: 'Ring', geometry: { primitive: 'torus', params: { majorRadius: 150 } } })
    expect(meshColor(ring)).toBe('#ff8800')
    expect(ring.transform).toMatchObject({ x: 10, y: 20, z: 30, scaleX: 1, scaleY: 2, scaleZ: 3 })
    const unnamed = await s.ok('world.add', { compId: w, kind: 'mesh', primitive: 'uvSphere' })
    expect(s.mesh(w, unnamed.id).name).toBe('UV Sphere')
  })

  it('refuses an unknown primitive or param and a value that is not a number, leaving nothing behind', async () => {
    const s = setup()
    const w = await s.world()
    const before = deepClone(s.session.project) as Project
    const bad = await s.fail('world.add', { compId: w, kind: 'mesh', primitive: 'teapot' })
    expect(bad.error).toMatch(/No primitive "teapot"/)
    expect(bad.hint).toContain('uvSphere')
    const param = await s.fail('world.add', { compId: w, kind: 'mesh', primitive: 'cube', params: { radius: 5 } })
    expect(param.error).toMatch(/no param "radius"/)
    expect(param.hint).toContain('sizeX')
    expect((await s.fail('world.add', { compId: w, kind: 'mesh', params: { sizeX: 'big' } })).error).toMatch(/needs a number/)
    expect((await s.fail('world.add', { compId: w, kind: 'light', primitive: 'cube' })).error).toMatch(/only apply to meshes/)
    expect(s.session.project).toEqual(before)
  })

  it('gives a material by preset or by values, and refuses an unknown preset without a trace', async () => {
    const s = setup()
    const w = await s.world()
    const glass = await s.ok('world.add', { compId: w, kind: 'mesh', material: 'glass' })
    expect(s.mesh(w, glass.id).material).toMatchObject({ preset: 'glass', transmission: 1 })
    const rough = await s.ok('world.add', { compId: w, kind: 'mesh', material: { roughness: 0.3, metalness: 1 } })
    expect(s.mesh(w, rough.id).material).toMatchObject({ roughness: 0.3, metalness: 1 })
    const before = deepClone(s.session.project) as Project
    expect((await s.fail('world.add', { compId: w, kind: 'mesh', material: 'plasma' })).error).toMatch(/No material preset/)
    expect(s.session.project).toEqual(before)
    // world.material reaches a mesh too.
    await s.ok('world.material', { ids: [glass.id], preset: 'gold' })
    expect(s.mesh(w, glass.id).material?.preset).toBe('gold')
  })

  it('is refused in a flat comp and is one undo step, material included', async () => {
    const s = setup()
    const flat = s.session.project.comps[0] as Comp
    expect((await s.fail('world.add', { compId: flat.id, kind: 'mesh' })).error).toMatch(/flat comp/)
    expect((await s.fail('layer.create', { compId: flat.id, kind: 'mesh' })).error).toMatch(/flat comp/)
    const w = await s.world()
    const before = deepClone(s.session.project) as Project
    await s.ok('world.add', { compId: w, kind: 'mesh', primitive: 'cone', material: 'chrome' })
    expect(s.layers(w)).toHaveLength(1)
    s.session.undo()
    expect(s.session.project).toEqual(before)
  })

  it('is made by layer.create too, with a default fill, and takes no strokes', async () => {
    const s = setup()
    const w = await s.world()
    const made = await s.ok('layer.create', { compId: w, kind: 'mesh', mesh: { primitive: 'cylinder', params: { radius: 30 }, shading: 'flat' }, fill: '#336699' })
    expect(s.mesh(w, made.id)).toMatchObject({ name: 'Cylinder', shading: 'flat', geometry: { primitive: 'cylinder', params: { radius: 30 } } })
    expect(meshColor(s.mesh(w, made.id))).toBe('#336699')
    const plain = await s.ok('layer.create', { compId: w, kind: 'mesh' })
    expect(meshColor(s.mesh(w, plain.id))).toBe(MESH_DEFAULT_COLOR)
    expect((await s.fail('layer.create', { compId: w, kind: 'mesh', stroke: '#ffffff' })).error).toMatch(/no strokes/)
  })
})

describe('mesh properties and keys', () => {
  it('lists geometry.<param> for its own primitive and smoothAngle, read as resolved', async () => {
    const s = setup()
    const w = await s.world()
    const made = await s.ok('world.add', { compId: w, kind: 'mesh', primitive: 'cylinder', params: { radius: 40 } })
    const cylinder = s.mesh(w, made.id)
    const paths = propertiesOf(cylinder).map((p) => p.path)
    expect(paths).toEqual(expect.arrayContaining(['geometry.radius', 'geometry.depth', 'geometry.vertices', 'smoothAngle', 'transform.scaleZ']))
    expect(paths).not.toContain('geometry.sizeX')
    const [radius] = resolveProperty(cylinder, 'geometry.radius')
    expect(radius).toMatchObject({ label: 'Radius', min: 0.01, default: 100 })
    const [depth] = resolveProperty(cylinder, 'geometry.depth')
    expect(depth?.get?.(cylinder)).toBe(200)
    expect(resolveProperty(cylinder, 'smoothAngle')[0]).toMatchObject({ label: 'Auto angle', min: 0, max: 180 })
  })

  it('samples a keyed geometry.radius at two times, clamped, and a keyed smoothAngle', async () => {
    const s = setup()
    const w = await s.world()
    const made = await s.ok('world.add', { compId: w, kind: 'mesh', primitive: 'uvSphere', params: { segments: 16 } })
    await s.ok('keyframes.set', { id: made.id, path: 'geometry.radius', keys: [{ t: 0, v: 50, ease: 'linear' }, { t: 1000, v: 150, ease: 'linear' }] })
    await s.ok('keyframes.set', { id: made.id, path: 'smoothAngle', keys: [{ t: 0, v: 10, ease: 'linear' }, { t: 1000, v: 90, ease: 'linear' }] })
    const sphere = s.mesh(w, made.id)
    expect(meshGeometryAt(sphere, 0)).toMatchObject({ primitive: 'uvSphere', params: { radius: 50, segments: 16, rings: 16, arc: 180 }, smoothAngle: 10, shading: 'auto' })
    const params = (t: number) => (meshGeometryAt(sphere, t) as PrimitiveGeometry).params
    expect(params(500).radius).toBeCloseTo(100)
    expect(meshGeometryAt(sphere, 500).smoothAngle).toBeCloseTo(50)
    expect(params(1000).radius).toBe(150)
    expect(params(5000).radius).toBe(150)
    expect((await s.fail('keyframes.set', { id: made.id, path: 'geometry.radius', keys: [{ t: 0, v: -3 }] })).error).toMatch(/at least 0.01/)
    // A fill key reaches the colour like a shape's.
    const fill = sphere.fills[0]
    expect(resolveProperty(sphere, "fill")[0]?.path).toBe(`fill.${fill?.id}`)
  })

  it('refuses a param of another primitive as a key', async () => {
    const s = setup()
    const w = await s.world()
    const made = await s.ok('world.add', { compId: w, kind: 'mesh', primitive: 'cube' })
    expect((await s.fail('keyframes.set', { id: made.id, path: 'geometry.radius', keys: [{ t: 0, v: 5 }] })).error).toMatch(/no animatable property/)
  })
})

describe('worlds with meshes', () => {
  it('world.create adds a starter cube at the origin, and not without a starter', async () => {
    const s = setup()
    const made = await s.ok('world.create', {})
    const cube = s.layers(made.frameId).find((l) => l.kind === 'mesh') as MeshLayer
    expect(cube).toMatchObject({ name: 'Cube', startMs: 0, durationMs: 10_000, geometry: { primitive: 'cube', params: {} } })
    expect(cube.transform).toMatchObject({ x: 0, y: 0, z: 0 })
    expect(made.objects.map((o: { kind: string }) => o.kind)).toContain('mesh')
    expect(s.layers(await s.world()).some((l) => l.kind === 'mesh')).toBe(false)
  })

  it('world.inspect lists a mesh with its size: the primitive box times the scales', async () => {
    const s = setup()
    const w = await s.world()
    await s.ok('world.add', { compId: w, kind: 'mesh', primitive: 'cube', params: { sizeX: 100, sizeY: 50, sizeZ: 20 }, scale: [2, 3, 4], position: [5, 6, 7], rotation: [0, 0, 90] })
    const seen = await s.ok('world.inspect', { compId: w, atMs: 0 })
    const entry = seen.objects.find((o: { kind: string }) => o.kind === 'mesh')
    expect(entry.size).toEqual([200, 150, 80])
    expect(entry.position).toEqual([5, 6, 7])
    expect(entry.rotation).toEqual([0, 0, 90])
  })

  it('cannot be nested out of its world', async () => {
    const s = setup()
    const w = await s.world()
    const made = await s.ok('world.add', { compId: w, kind: 'mesh' })
    expect((await s.fail('layers.nest', { ids: [made.id] })).error).toMatch(/mesh/)
  })

  it('survives a project file round trip', async () => {
    const s = setup()
    const made = await s.ok('world.create', {})
    const w = made.frameId as string
    const added = await s.ok('world.add', { compId: w, kind: 'mesh', primitive: 'torusKnot', params: { p: 3, q: 5 }, color: '#00ccff', material: 'metal' })
    await s.ok('keyframes.set', { id: added.id, path: 'geometry.tube', keys: [{ t: 0, v: 10, ease: 'linear' }, { t: 500, v: 30, ease: 'linear' }] })
    const read = readProjectFile(writeProjectFile(s.session.project)).project
    const back = read.comps.find((c) => c.id === w)?.tracks.flatMap((t) => t.layers).find((l) => l.id === added.id)
    expect(back).toEqual(s.mesh(w, added.id))
    expect(back).toMatchObject({ kind: 'mesh', geometry: { primitive: 'torusKnot', params: { p: 3, q: 5 } }, material: { preset: 'metal' } })
    expect(findPrimitive('torusKnot')?.params.map((p) => p.key)).toContain('tube')
  })
})
