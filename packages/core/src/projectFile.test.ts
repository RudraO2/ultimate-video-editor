import { describe, expect, it } from 'vitest'
import { createDefaultProject } from './doc'
import { sequentialIds } from './ids'
import { PROJECT_FILE_VERSION, ProjectFileError, readProjectFile, writeProjectFile } from './projectFile'
import { Session } from './session'

async function sampleProject() {
  const ids = sequentialIds()
  const session = new Session({ project: createDefaultProject(ids), ids })
  const media = await session.call('media.add', { kind: 'video', name: 'clip.mp4', path: 'C:/clips/clip.mp4', durationMs: 4000 })
  if (!media.ok) throw new Error(media.error)
  const { id: mediaId } = media.value as { id: string }
  for (const input of [
    { kind: 'text', text: 'Title', style: { fontFamily: 'Anton' } },
    { kind: 'text', text: 'Sub', style: { fontFamily: 'Inter' } },
    { kind: 'video', mediaId },
  ]) {
    const result = await session.call('layer.create', input)
    if (!result.ok) throw new Error(result.error)
  }
  return session.project
}

const damage = (text: string, edit: (file: { document: any; manifest: any; formatVersion: number }) => void) => {
  const file = JSON.parse(text)
  edit(file)
  return JSON.stringify(file)
}

describe('project file', () => {
  it('round-trips a project and lists its media and fonts in the manifest', async () => {
    const project = await sampleProject()
    const text = writeProjectFile(project, { savedAt: new Date('2026-10-24T10:00:00Z'), app: 'test 1.0' })
    const { project: back, manifest } = readProjectFile(text)
    expect(back).toEqual(project)
    expect(manifest).toMatchObject({
      savedAt: '2026-10-24T10:00:00.000Z',
      app: 'test 1.0',
      project: { id: project.id, name: 'Untitled project' },
      comps: [{ name: 'Comp 1', width: 1920, height: 1080, fps: 30, durationMs: 10_000 }],
      media: [{ kind: 'video', name: 'clip.mp4', path: 'C:/clips/clip.mp4' }],
      fonts: ['Anton', 'Inter'],
    })
  })

  it('says why a file cannot be opened', async () => {
    const text = writeProjectFile(await sampleProject())
    const fails = (bad: string, message: RegExp) => {
      expect(() => readProjectFile(bad)).toThrow(ProjectFileError)
      expect(() => readProjectFile(bad)).toThrow(message)
    }
    fails('{not json', /not valid JSON/)
    fails('{"format":"atomcut-motion"}', /not an Ultimate Video Editor project/)
    fails(damage(text, (f) => (f.formatVersion = PROJECT_FILE_VERSION + 1)), /newer version/)
    fails(damage(text, (f) => (f.document.comps = [])), /damaged.*at comps/)
    fails(damage(text, (f) => (f.document.comps[0].tracks[0].layers[0].bogus = 1)), /damaged/)
    fails(damage(text, (f) => (f.document.media = [])), /uses media .* not in the project/)
    fails(damage(text, (f) => (f.document.comps[0].tracks[1].id = f.document.comps[0].tracks[0].id)), /share the id/)
  })

  it('rebuilds a damaged manifest from the document', async () => {
    const text = writeProjectFile(await sampleProject())
    const { manifest } = readProjectFile(damage(text, (f) => (f.manifest = 'oops')))
    expect(manifest.fonts).toEqual(['Anton', 'Inter'])
  })
})

describe('session revision', () => {
  it('moves on with every change, undo and load, and not with reads or failures', async () => {
    const ids = sequentialIds()
    const session = new Session({ project: createDefaultProject(ids), ids })
    const start = session.revision
    await session.call('doc.overview')
    await session.call('layer.set', { id: 'missing', values: { x: 1 } })
    expect(session.revision).toBe(start)
    await session.call('layer.create', { kind: 'shape' })
    const afterCreate = session.revision
    expect(afterCreate).toBeGreaterThan(start)
    session.undo()
    expect(session.revision).toBeGreaterThan(afterCreate)
    const beforeLoad = session.revision
    await session.replace(createDefaultProject(ids))
    expect(session.revision).toBeGreaterThan(beforeLoad)
    expect(session.canUndo).toBe(false)
  })
  it('turns the pixel pivots of a version 1 file into fractions of the box', async () => {
    const project = await sampleProject()
    const text = damage(writeProjectFile(project), (file) => {
      file.formatVersion = 1
      const comp = file.document.comps[0]
      const shape = {
        id: 'old_shape',
        name: 'Old shape',
        kind: 'shape',
        startMs: 0,
        durationMs: 1000,
        shape: { width: 200, height: 100, fill: '#112233' },
        transform: { anchorX: -100, anchorY: 25 },
        animations: { 'transform.anchorX': [{ t: 0, v: 100, ease: 'linear' }] },
      }
      comp.tracks.unshift({ id: 'old_track', layers: [shape] })
      for (const track of comp.tracks.slice(1)) for (const layer of track.layers) layer.transform = { anchorX: 0, anchorY: 0 }
    })
    const { project: back } = readProjectFile(text)
    const layers = back.comps[0]!.tracks.flatMap((t) => t.layers)
    const old = layers.find((l) => l.id === 'old_shape')!
    expect(old.transform).toMatchObject({ anchorX: 0, anchorY: 0.75 })
    expect(old.animations['transform.anchorX']![0]!.v).toBe(1)
    for (const layer of layers.filter((l) => l.id !== 'old_shape')) expect(layer.transform).toMatchObject({ anchorX: 0.5, anchorY: 0.5 })
  })
  it('opens a file saved before pages and static frames existed', async () => {
    const project = await sampleProject()
    const text = damage(writeProjectFile(project), (file) => {
      file.formatVersion = 6
      delete file.document.pages
      for (const comp of file.document.comps) {
        delete comp.mode
        delete comp.stillMs
        delete comp.overflow
        delete comp.pageId
      }
    })
    const { project: back } = readProjectFile(text)
    expect(back.pages).toEqual([{ id: 'page_1', name: 'Page 1' }])
    expect(back.comps[0]).toMatchObject({ mode: 'timeline', stillMs: 0, overflow: null, pageId: null })
    // A comp with no page is on the first page.
    expect(back).toEqual({ ...project, comps: project.comps.map((c) => ({ ...c, pageId: null })) })
  })
  it("turns a version 2 shape's fill and stroke into paints, keys included", async () => {
    const project = await sampleProject()
    const text = damage(writeProjectFile(project), (file) => {
      file.formatVersion = 2
      file.document.comps[0].tracks.unshift({
        id: 'old_track',
        layers: [
          {
            id: 'old',
            name: 'Old',
            kind: 'shape',
            startMs: 0,
            durationMs: 1000,
            shape: { width: 90, height: 40, fill: '#ff0000', strokeColor: '#00ff00', strokeWidth: 10 },
            transform: { anchorX: 0, anchorY: 0.5 },
            animations: { 'shape.fill': [{ t: 0, v: '#0000ff', ease: 'linear' }] },
          },
        ],
      })
    })
    const { project: back } = readProjectFile(text)
    const old = back.comps[0]!.tracks[0]!.layers[0]!
    if (old.kind !== 'shape') throw new Error('not a shape')
    expect(old.shape).toMatchObject({ type: 'rect', width: 90, height: 40, cornerRadius: 0 })
    expect(old.shape).not.toHaveProperty('fill')
    expect(old.fills).toMatchObject([{ id: 'old_fill', type: 'solid', color: '#ff0000' }])
    expect(old.strokes).toMatchObject([{ id: 'old_stroke', width: 10, paint: { type: 'solid', color: '#00ff00' } }])
    expect(Object.keys(old.animations)).toEqual(['fill.old_fill'])
    // The left edge of the 100 px box with the stroke is 5 px left of the 90 px shape.
    expect(old.transform.anchorX).toBeCloseTo(-5 / 90)
  })
})
