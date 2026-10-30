import { describe, expect, it } from 'vitest'
import { createDefaultProject, isSpatialKind, newTrack, worldStructureProblem } from './doc'
import { sequentialIds } from './ids'
import { PROJECT_FILE_VERSION, ProjectFileError, readProjectFile, writeProjectFile } from './projectFile'
import { type CameraLayer, type Comp, CompSchema, type EmptyLayer, type Layer, LayerSchema, type LightLayer, type Project, WorldSchema } from './schema'
import { Session } from './session'

const base = { startMs: 0, durationMs: 5000 }
const camera = LayerSchema.parse({ id: 'cam', name: 'Camera', kind: 'camera', ...base }) as CameraLayer
const light = LayerSchema.parse({ id: 'lit', name: 'Key light', kind: 'light', ...base }) as LightLayer
const empty = LayerSchema.parse({ id: 'emp', name: 'Rig', kind: 'empty', ...base }) as EmptyLayer
const title = LayerSchema.parse({ id: 'ttl', name: 'Title', kind: 'text', text: 'Hi', ...base }) as Layer

/** A project with a 3D world ("World") holding a camera, a light, a controller and a title, and a flat comp ("Flat"). */
function projectWithWorld(): Project {
  const project = createDefaultProject(sequentialIds())
  const world = CompSchema.parse({ id: 'world', name: 'World', width: 1920, height: 1080, fps: 30, durationMs: 5000, world: {} })
  world.tracks = [newTrack('t1', [camera]), newTrack('t2', [light]), newTrack('t3', [empty]), newTrack('t4', [title])]
  const flat = CompSchema.parse({ id: 'flat', name: 'Flat', width: 1280, height: 720, fps: 30, durationMs: 5000 })
  project.comps.push(world, flat)
  return project
}

const sessionOf = (project: Project) => new Session({ project, ids: sequentialIds() })

describe('world structure', () => {
  it('knows the spatial kinds', () => {
    expect(['camera', 'light', 'empty'].every(isSpatialKind)).toBe(true)
    expect(['text', 'group', 'nested', 'audio'].some(isSpatialKind)).toBe(false)
  })

  it('lets a world hold spatial layers and refuses them in a flat comp', () => {
    const project = projectWithWorld()
    const [, world, flat] = project.comps as [Comp, Comp, Comp]
    expect(worldStructureProblem(world)).toBeNull()
    expect(worldStructureProblem(flat)).toBeNull()
    flat.tracks.push(newTrack('t9', [{ ...camera, id: 'cam2', name: 'Stray' }]))
    expect(worldStructureProblem(flat)).toBe('comp "Flat" is flat but holds the camera "Stray"; cameras, lights, controllers and meshes live only in 3D worlds')
  })
})

describe('world in the project file', () => {
  it('is format 12 or later', () => {
    expect(PROJECT_FILE_VERSION).toBeGreaterThanOrEqual(12)
  })

  it('round-trips a world with a camera, a light and a controller, defaults filled', () => {
    const project = projectWithWorld()
    const { project: back } = readProjectFile(writeProjectFile(project))
    expect(back).toEqual(project)
    const world = back.comps.find((c) => c.id === 'world') as Comp
    expect(world.world).toMatchObject({
      render: { toneMapping: 'agx', shadowQuality: 'medium', bloom: { strength: 0.8 }, floor: { color: '#202024' } },
      fog: { end: 20_000 },
    })
    const [cam, lit, emp] = world.tracks.flatMap((t) => t.layers) as [CameraLayer, LightLayer, EmptyLayer]
    expect(cam.camera).toMatchObject({ focalLength: 50, sensorWidth: 36, clipEnd: 100_000, dof: { fStop: 2.8 } })
    expect(lit.light).toMatchObject({ intensity: 1000, spotAngle: 45, environment: 'studio' })
    expect(emp.empty).toMatchObject({ display: 'axes', size: 80 })
    expect(cam.transform.scaleZ).toBe(1)
  })

  it('still reads a format 7 file', () => {
    const file = JSON.parse(writeProjectFile(createDefaultProject(sequentialIds())))
    file.formatVersion = 7
    expect(readProjectFile(JSON.stringify(file)).project.comps[0]?.world).toBeUndefined()
  })

  it('refuses a camera in a flat comp as damage', () => {
    const project = projectWithWorld()
    const file = JSON.parse(writeProjectFile(project))
    delete file.document.comps[1].world
    const text = JSON.stringify(file)
    expect(() => readProjectFile(text)).toThrow(ProjectFileError)
    expect(() => readProjectFile(text)).toThrow(/is flat but holds the camera "Camera"/)
  })
})

describe('commands keep cameras in their world', () => {
  const failure = async (session: Session, name: string, input: unknown) => {
    const result = await session.call(name, input)
    if (result.ok) throw new Error(`${name} should have failed`)
    return result
  }

  it('layers.copy refuses a camera into a flat comp, and copies it into a world', async () => {
    const session = sessionOf(projectWithWorld())
    const before = JSON.stringify(session.project)
    const result = await failure(session, 'layers.copy', { ids: ['cam'], toCompId: 'flat' })
    expect(result.error).toContain('"Flat" is a flat comp, so it cannot hold a camera, light or controller.')
    expect(JSON.stringify(session.project)).toBe(before)
    expect((await session.call('layers.copy', { ids: ['cam'], toCompId: 'world' })).ok).toBe(true)
    expect(worldStructureProblem(session.project.comps[1] as Comp)).toBeNull()
  })

  it('layers.nest refuses a camera', async () => {
    const session = sessionOf(projectWithWorld())
    const before = JSON.stringify(session.project)
    const result = await failure(session, 'layers.nest', { ids: ['cam', 'ttl'], fullFrame: true })
    expect(result.error).toContain('"Camera" is a camera and cannot be nested.')
    expect(JSON.stringify(session.project)).toBe(before)
    expect((await session.call('layers.nest', { ids: ['ttl'], fullFrame: true })).ok).toBe(true)
  })

  it('frame.update refuses to take the world off a comp that holds a camera', async () => {
    const session = sessionOf(projectWithWorld())
    const before = JSON.stringify(session.project)
    const result = await failure(session, 'frame.update', { id: 'world', ops: [{ op: 'remove', path: 'world' }] })
    expect(result.error).toContain('which still holds a camera, light or controller')
    expect(JSON.stringify(session.project)).toBe(before)
  })

  it('frame.update takes the world off a comp that holds only picture layers', async () => {
    const project = projectWithWorld()
    const world = project.comps[1] as Comp
    world.tracks = [newTrack('t4', [title])]
    const session = sessionOf(project)
    const result = await session.call('frame.update', { id: 'world', ops: [{ op: 'remove', path: 'world' }] })
    expect(result.ok).toBe(true)
    expect((session.project.comps[1] as Comp).world).toBeUndefined()
  })

  it('a world schema parses with no input', () => {
    expect(WorldSchema.parse({}).fog.enabled).toBe(false)
  })
})
