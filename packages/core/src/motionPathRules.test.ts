import { describe, expect, it } from 'vitest'
import { deepClone } from './clone'
import { createDefaultProject } from './doc'
import { sequentialIds } from './ids'
import { upsertKey } from './keys'
import { arcHandles, motionPointAt } from './motionPath'
import { PROJECT_FILE_VERSION, readProjectFile, writeProjectFile } from './projectFile'
import { evaluateProperty, resolveProperty } from './properties'
import type { Keyframe, Layer, Project } from './schema'
import { Session } from './session'

// The rules around motion paths: evaluation through evaluateProperty, and the
// commands that must not leave handles a key edit has broken.

function setup() {
  const ids = sequentialIds()
  const session = new Session({ project: createDefaultProject(ids), ids, view: () => ({}) })
  // biome-ignore lint/suspicious/noExplicitAny: test results are checked field by field
  const ok = async (name: string, input: unknown = {}): Promise<any> => {
    const result = await session.call(name, input)
    if (!result.ok) throw new Error(`${name} failed: ${result.error}`)
    return result.value
  }
  const layer = () => session.project.comps[0]?.tracks.flatMap((t) => t.layers).find((l) => l.id === 'layer_1') as Layer
  /** Edits the layer outside the command API, as a project file or a later command would. */
  const edit = async (change: (layer: Layer) => void) => {
    const project = deepClone(session.project) as Project
    const target = project.comps[0]?.tracks.flatMap((t) => t.layers).find((l) => l.id === 'layer_1') as Layer
    change(target)
    await session.replace(project)
  }
  return { session, ok, layer, edit }
}

/** A shape hopping from (0, 0) to (300, 0) over 1 s with a 100 px arc and linear easing. */
async function hop() {
  const s = setup()
  await s.ok('layer.create', { kind: 'shape' })
  await s.ok('keyframes.set', {
    id: 'layer_1',
    path: 'position',
    keys: [
      { t: 0, v: [0, 0], ease: 'linear' },
      { t: 1000, v: [300, 0], ease: 'linear' },
    ],
  })
  const { out, in: arrive } = arcHandles([0, 0], [300, 0], 100)
  await s.edit((layer) => {
    const xs = layer.animations['transform.x'] as Keyframe[]
    ;(xs[0] as Keyframe).spatial = { in: null, out }
    ;(xs[1] as Keyframe).spatial = { in: arrive, out: null }
  })
  return s
}

const at = (layer: Layer, name: string, t: number) => evaluateProperty(layer, resolveProperty(layer, name)[0]!, t) as number

describe('evaluateProperty on a motion path', () => {
  it('returns the curve for x and y on a curved segment', async () => {
    const s = await hop()
    expect(at(s.layer(), 'x', 500)).toBeCloseTo(150, 6)
    expect(at(s.layer(), 'y', 500)).toBeCloseTo(-100, 6)
    expect(at(s.layer(), 'x', 250)).toBeCloseTo(75, 6)
    expect(motionPointAt(s.layer(), 250)?.[1]).toBeCloseTo(at(s.layer(), 'y', 250), 9)
  })

  it('keeps the ends and holds outside the keys', async () => {
    const s = await hop()
    expect([at(s.layer(), 'x', 0), at(s.layer(), 'y', 0)]).toEqual([0, 0])
    expect([at(s.layer(), 'x', 1000), at(s.layer(), 'y', 1000)]).toEqual([300, 0])
    expect([at(s.layer(), 'x', 2000), at(s.layer(), 'y', 2000)]).toEqual([300, 0])
  })

  it('leaves straight paths and other properties alone', async () => {
    const s = setup()
    await s.ok('layer.create', { kind: 'shape' })
    await s.ok('keyframes.set', { id: 'layer_1', path: 'position', keys: [{ t: 0, v: [0, 0], ease: 'linear' }, { t: 1000, v: [300, 60], ease: 'linear' }] })
    expect([at(s.layer(), 'x', 500), at(s.layer(), 'y', 500)]).toEqual([150, 30])
  })

  it('freezes on the curve when keyframes.clear clears position', async () => {
    const s = await hop()
    await s.ok('keyframes.clear', { id: 'layer_1', path: 'position', atMs: 500 })
    expect(s.layer().transform.x).toBeCloseTo(150, 6)
    expect(s.layer().transform.y).toBeCloseTo(-100, 6)
    expect(s.layer().animations['transform.x']).toBeUndefined()
  })
})

describe('commands keep handles valid', () => {
  it('keyframes.remove of a y key drops the handles of its x key', async () => {
    const s = await hop()
    await s.ok('keyframes.set', { id: 'layer_1', path: 'y', mode: 'merge', keys: [{ t: 500, v: 0 }] })
    await s.ok('keyframes.remove', { id: 'layer_1', path: 'y', times: [1000] })
    const xs = s.layer().animations['transform.x'] as Keyframe[]
    expect(xs[0]?.spatial?.out).not.toBeNull()
    expect(xs[1]?.spatial).toBeUndefined()
  })

  it('keyframes.remove of an x key takes its handles with it', async () => {
    const s = await hop()
    await s.ok('keyframes.set', { id: 'layer_1', path: 'position', mode: 'merge', keys: [{ t: 2000, v: [400, 0] }] })
    await s.ok('keyframes.remove', { id: 'layer_1', path: 'x', times: [0] })
    expect((s.layer().animations['transform.x'] as Keyframe[]).map((k) => k.t)).toEqual([1000, 2000])
    expect(s.layer().animations['transform.x']?.[0]?.spatial?.in).toEqual(arcHandles([0, 0], [300, 0], 100).in)
  })

  it('keyframes.clear of y alone drops every handle', async () => {
    const s = await hop()
    await s.ok('keyframes.clear', { id: 'layer_1', path: 'y', atMs: 0 })
    expect(s.layer().animations['transform.x']?.every((k) => k.spatial === undefined)).toBe(true)
  })

  it('keyframes.set replacing y drops the handles whose partner went', async () => {
    const s = await hop()
    await s.ok('keyframes.set', { id: 'layer_1', path: 'y', keys: [{ t: 0, v: 0 }, { t: 700, v: 20 }] })
    const xs = s.layer().animations['transform.x'] as Keyframe[]
    expect(xs[0]?.spatial?.out).not.toBeNull()
    expect(xs[1]?.spatial).toBeUndefined()
  })

  it('keyframes.set merging a new x value at a curved key keeps the handles', async () => {
    const s = await hop()
    await s.ok('keyframes.set', { id: 'layer_1', path: 'x', mode: 'merge', keys: [{ t: 1000, v: 320 }] })
    const xs = s.layer().animations['transform.x'] as Keyframe[]
    expect(xs[1]).toMatchObject({ v: 320, spatial: { in: arcHandles([0, 0], [300, 0], 100).in } })
  })

  it('upsertKey keeps handles unless the new key brings its own', () => {
    const keys: Keyframe[] = [{ t: 0, v: 0, ease: 'linear', spatial: { in: null, out: [10, 0] } }]
    upsertKey(keys, { t: 0.2, v: 5, ease: 'ease-in' })
    expect(keys[0]).toEqual({ t: 0.2, v: 5, ease: 'linear', spatial: { in: null, out: [10, 0] } })
    upsertKey(keys, { t: 0, v: 5, ease: 'linear', spatial: { in: [1, 1], out: null } }, false)
    expect(keys[0]?.spatial).toEqual({ in: [1, 1], out: null })
  })

  it('keyframes.simplify leaves a curved position pair alone and says so', async () => {
    const s = await hop()
    await s.ok('keyframes.set', { id: 'layer_1', path: 'position', mode: 'merge', keys: [{ t: 2000, v: [400, 0] }] })
    await s.ok('keyframes.set', { id: 'layer_1', path: 'opacity', keys: [0, 250, 500, 750].map((t) => ({ t, v: t / 1000, ease: 'linear' })) })
    const before = s.layer().animations['transform.x']
    const result = await s.ok('keyframes.simplify', { id: 'layer_1' })
    expect(result.skipped).toEqual([
      { layerId: 'layer_1', path: 'transform.x', reason: 'curved motion path' },
      { layerId: 'layer_1', path: 'transform.y', reason: 'curved motion path' },
    ])
    expect(result.tracks.map((t: { path: string }) => t.path)).toEqual(['transform.opacity'])
    expect(s.layer().animations['transform.x']).toEqual(before)
  })

  it('keyframes.simplify of only a curved path reports it instead of failing', async () => {
    const s = await hop()
    await s.ok('keyframes.set', { id: 'layer_1', path: 'position', mode: 'merge', keys: [{ t: 2000, v: [400, 0] }] })
    const result = await s.ok('keyframes.simplify', { id: 'layer_1', properties: ['position'] })
    expect(result).toMatchObject({ tracks: [], note: 'A curved motion path is left as it is.' })
    expect(result.skipped).toHaveLength(2)
  })

  it('frame.update with scaleContents stretches the handles', async () => {
    const s = await hop()
    const comp = s.session.project.comps[0]!
    await s.ok('frame.update', { id: comp.id, width: comp.width * 2, height: comp.height, scaleContents: true })
    expect(s.layer().animations['transform.x']?.[0]?.spatial?.out?.[0]).toBeCloseTo(200, 6)
    expect(s.layer().animations['transform.x']?.[0]?.spatial?.out?.[1]).toBeCloseTo(-400 / 3, 6)
    expect(at(s.layer(), 'x', 500)).toBeCloseTo(300, 6)
    expect(at(s.layer(), 'y', 500)).toBeCloseTo(-100, 6)
  })
})

describe('project files with motion paths', () => {
  it('saves the current format and reads the handles back', async () => {
    const s = await hop()
    const text = writeProjectFile(s.session.project)
    expect(JSON.parse(text).formatVersion).toBe(PROJECT_FILE_VERSION)

    const back = readProjectFile(text).project
    const layer = back.comps[0]?.tracks.flatMap((t) => t.layers).find((l) => l.id === 'layer_1') as Layer
    expect(layer.animations['transform.x']).toEqual(s.layer().animations['transform.x'])
  })

  it('refuses handles off transform.x or without a y partner', async () => {
    const s = await hop()
    const damaged = (change: (file: { document: Project }) => void) => {
      const file = JSON.parse(writeProjectFile(s.session.project))
      change(file)
      return JSON.stringify(file)
    }
    const layerOf = (file: { document: Project }) => file.document.comps[0]?.tracks.flatMap((t) => t.layers).find((l) => l.id === 'layer_1') as Layer
    expect(() =>
      readProjectFile(
        damaged((file) => {
          ;(layerOf(file).animations['transform.y'] as Keyframe[])[0]!.spatial = { in: null, out: [1, 1] }
        }),
      ),
    ).toThrow(/belong on transform.x/)
    expect(() =>
      readProjectFile(
        damaged((file) => {
          layerOf(file).animations['transform.y'] = [{ t: 0, v: 0, ease: 'linear' }]
        }),
      ),
    ).toThrow(/no transform.y key at that time/)
  })
})
