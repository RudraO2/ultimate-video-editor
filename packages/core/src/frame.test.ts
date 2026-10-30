import { describe, expect, it } from 'vitest'
import { createDefaultProject, pageOf } from './doc'
import { sequentialIds } from './ids'
import type { Measure, Placement } from './registry'
import type { Comp, Layer } from './schema'
import { Session } from './session'

/** A stand-in for the editor's measurer: a shape's box at its position. */
const fakeMeasure: Measure = (comp: Comp) => {
  const out = new Map<string, Placement>()
  for (const layer of comp.tracks.flatMap((t) => t.layers)) {
    const t = layer.transform
    const width = layer.kind === 'shape' ? layer.shape.width : 100
    const height = layer.kind === 'shape' ? layer.shape.height : 40
    out.set(layer.id, { x: t.x, y: t.y, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, bounds: { left: t.x - width / 2, top: t.y - height / 2, width, height } })
  }
  return out
}

function setup() {
  const ids = sequentialIds()
  const session = new Session({ project: createDefaultProject(ids), ids, measure: fakeMeasure })
  // biome-ignore lint/suspicious/noExplicitAny: test results are checked field by field
  const ok = async (name: string, input: unknown = {}): Promise<any> => {
    const result = await session.call(name, input)
    if (!result.ok) throw new Error(name + ' failed: ' + result.error)
    return result.value
  }
  const fail = async (name: string, input: unknown) => {
    const result = await session.call(name, input)
    if (result.ok) throw new Error(name + ' should have failed')
    return result.error + '\n' + (result.hint ?? '')
  }
  const comp = (id: string) => session.project.comps.find((c) => c.id === id) as Comp
  const layers = (id: string) => comp(id).tracks.flatMap((t) => t.layers) as Layer[]
  return { session, ok, fail, comp, layers }
}

describe('frame.create', () => {
  it('makes a frame on the page of the frame in view, with defaults, and keeps comp.create working', async () => {
    const { session, ok, comp } = setup()
    const first = session.project.comps[0] as Comp
    const made = await ok('frame.create', { name: 'Poster', width: 1080, height: 1350 })
    expect(made.pageId).toBe(first.pageId)
    expect(comp(made.id)).toMatchObject({ name: 'Poster', width: 1080, height: 1350, fps: 30, durationMs: 10000, mode: 'timeline', stillMs: 0, overflow: null })
    const old = await ok('comp.create', {})
    expect(comp(old.id).name).toBe('Frame 3')
    // The old name is an alias: only the new one is listed.
    const names = session.registry.list().map((d) => d.name)
    expect(names).toContain('frame.create')
    expect(names).not.toContain('comp.create')
  })

  it('makes a static frame one second long, and refuses a flipbook', async () => {
    const { ok, fail, comp } = setup()
    const still = await ok('frame.create', { width: 1280, height: 720, mode: 'static', atMs: 400 })
    expect(comp(still.id)).toMatchObject({ mode: 'static', durationMs: 1000, stillMs: 400 })
    expect(await fail('frame.create', { width: 100, height: 100, mode: 'flipbook' })).toContain('Flipbook')
  })

  it('puts it on a named page', async () => {
    const { session, ok, fail } = setup()
    const page = await ok('page.create', { name: 'Deliverables' })
    const made = await ok('frame.create', { width: 640, height: 360, pageId: 'deliverables' })
    expect(made.pageId).toBe(page.id)
    expect(pageOf(session.project, session.project.comps.at(-1) as Comp)?.name).toBe('Deliverables')
    expect(await fail('frame.create', { width: 640, height: 360, pageId: 'Nowhere' })).toContain('No page')
  })
})

describe('frame.update', () => {
  it('renames, resizes and changes timing, with the open frame as the default', async () => {
    const { session, ok, comp } = setup()
    const id = (session.project.comps[0] as Comp).id
    await ok('frame.update', { name: 'Main', fps: 24, durationMs: 4000, background: '#101010' })
    expect(comp(id)).toMatchObject({ name: 'Main', fps: 24, durationMs: 4000, background: '#101010' })
    await ok('frame.update', { id, width: 1280, height: 720 })
    expect(comp(id)).toMatchObject({ width: 1280, height: 720 })
  })

  it('scales the contents when asked: positions by the ratios, sizes by the smaller', async () => {
    const { ok, session, comp, layers } = setup()
    const id = (session.project.comps[0] as Comp).id
    const made = await ok('layer.create', { kind: 'shape', width: 100, height: 100, x: 200, y: -100 })
    await ok('keyframes.set', { id: made.id, path: 'transform.x', keys: [{ t: 0, v: 100 }, { t: 1000, v: 300 }] })
    await ok('frame.update', { id, width: 960, height: 1080, scaleContents: true })
    const layer = layers(id)[0] as Layer
    // 1920 to 960 is half across, the same up and down: positions and sizes halve (the smaller ratio).
    expect(layer.transform).toMatchObject({ x: 100, y: -100, scaleX: 0.5, scaleY: 0.5 })
    expect(layer.animations['transform.x']?.map((k) => k.v)).toEqual([50, 150])
    const kept = await ok('layer.create', { kind: 'shape', x: 40 })
    await ok('frame.update', { id, width: 480, height: 540 })
    expect((layers(id).find((l) => l.id === kept.id) as Layer).transform.x).toBe(40)
    void session
  })

  it('stills a timeline at the playhead or atMs, resumes it, and moves the still', async () => {
    const { session, ok, fail, comp } = setup()
    const id = (session.project.comps[0] as Comp).id
    session.view = () => ({ compId: id, playheadMs: 2500 })
    expect(await ok('frame.update', { id, mode: 'static' })).toMatchObject({ mode: 'static', stillMs: 2500 })
    expect(comp(id)).toMatchObject({ mode: 'static', stillMs: 2500 })
    await ok('frame.update', { id, atMs: 1200 })
    expect(comp(id).stillMs).toBe(1200)
    await ok('frame.update', { id, mode: 'timeline' })
    expect(comp(id)).toMatchObject({ mode: 'timeline', stillMs: 1200 })
    expect(await fail('frame.update', { id, atMs: 100 })).toContain('static frame shows')
    expect(await fail('frame.update', { id, mode: 'static', atMs: 99_000 })).toContain('past the frame end')
    expect(await fail('frame.update', { id, mode: 'flipbook' })).toContain('Flipbook')
  })

  it('patches other fields by path and guards the ones with their own inputs', async () => {
    const { session, ok, fail, comp } = setup()
    const id = (session.project.comps[0] as Comp).id
    await ok('frame.update', { id, ops: [{ op: 'set', path: 'overflow', value: 0 }] })
    expect(comp(id).overflow).toBe(0)
    expect(await fail('frame.update', { id, ops: [{ op: 'set', path: 'tracks', value: [] }] })).toContain('Use the layer and track commands')
    expect(await fail('frame.update', { id, ops: [{ op: 'set', path: 'mode', value: 'static' }] })).toContain('mode input')
    expect(await fail('frame.update', { id, ops: [{ op: 'set', path: 'overflow', value: 7 }] })).toContain('patched frame')
    void session
  })

  it('moves a frame to a page', async () => {
    const { session, ok, comp } = setup()
    const id = (session.project.comps[0] as Comp).id
    const page = await ok('page.create', { name: 'Archive' })
    await ok('frame.update', { id, pageId: 'Archive' })
    expect(comp(id).pageId).toBe(page.id)
  })
})

describe('frame.delete and frame.duplicate', () => {
  it('deletes a frame with its layers, but not the last one, nor one that others show', async () => {
    const { ok, fail, session, comp } = setup()
    const first = (session.project.comps[0] as Comp).id
    expect(await fail('frame.delete', { id: first })).toContain('at least one frame')
    const other = await ok('frame.create', { name: 'Scene', width: 640, height: 360 })
    await ok('layer.create', { compId: other.id, kind: 'shape', width: 50, height: 50 })
    // The first frame shows Scene inside a nested layer.
    await ok('layer.create', { compId: first, kind: 'comp', sourceCompId: other.id })
    expect(await fail('frame.delete', { id: other.id })).toContain('is shown inside')
    expect(comp(other.id)).toBeTruthy()
    const spare = await ok('frame.create', { name: 'Spare', width: 320, height: 180 })
    expect(await ok('frame.delete', { id: spare.id })).toMatchObject({ deleted: spare.id })
    session.undo()
    expect(comp(spare.id)).toBeTruthy()
  })

  it('refuses the inside of a nested layer, and drops embedded comps with the frame that held them', async () => {
    const { ok, fail, session, comp } = setup()
    const first = (session.project.comps[0] as Comp).id
    const scene = await ok('frame.create', { name: 'Scene', width: 640, height: 360 })
    const shape = await ok('layer.create', { compId: scene.id, kind: 'shape', width: 50, height: 50 })
    const nested = await ok('layers.nest', { ids: [shape.id] })
    const inside = session.project.comps.find((c) => c.embedded) as Comp
    expect(inside).toBeTruthy()
    expect(await fail('frame.delete', { id: inside.id })).toContain('inside of a nested layer')
    await ok('frame.delete', { id: scene.id })
    expect(session.project.comps.some((c) => c.embedded)).toBe(false)
    expect(comp(first)).toBeTruthy()
    void nested
  })

  it('duplicates a frame independently: new ids, groups and transitions follow, what a nested layer owns is copied', async () => {
    const { ok, session, comp, layers } = setup()
    const first = (session.project.comps[0] as Comp).id
    const a = await ok('layer.create', { kind: 'shape', width: 100, height: 100, name: 'A', startMs: 0, durationMs: 2000 })
    const b = await ok('layer.create', { kind: 'shape', width: 100, height: 100, name: 'B', trackId: a.trackId, startMs: 2000, durationMs: 2000 })
    await ok('transition.add', { ids: [a.id, b.id], preset: 'cross-dissolve' })
    const c = await ok('layer.create', { kind: 'shape', width: 40, height: 40, name: 'C' })
    const d = await ok('layer.create', { kind: 'shape', width: 40, height: 40, name: 'D' })
    const grouped = await ok('layers.group', { ids: [c.id, d.id], name: 'CD' })
    const n = await ok('layer.create', { kind: 'shape', width: 30, height: 30, name: 'N' })
    await ok('layers.nest', { ids: [n.id] })
    const copy = await ok('frame.duplicate', { id: first, name: 'Copy of main' })
    const source = comp(first)
    const made = comp(copy.id)
    expect(made.name).toBe('Copy of main')
    expect(made.pageId).toBe(source.pageId)
    const sourceIds = new Set(layers(first).map((l) => l.id))
    expect(layers(copy.id).map((l) => l.name).sort()).toEqual(layers(first).map((l) => l.name).sort())
    expect(layers(copy.id).every((l) => !sourceIds.has(l.id))).toBe(true)
    // The group's lanes follow the copy of the group, not the original.
    const group = layers(copy.id).find((l) => l.kind === 'group') as Layer
    expect(group.id).not.toBe(grouped.groupId)
    expect(made.tracks.filter((t) => t.groupId !== null).every((t) => t.groupId === group.id)).toBe(true)
    // The transition points at the copies of its layers.
    const lane = made.tracks.find((t) => t.transitions.length > 0)
    const copyA = layers(copy.id).find((l) => l.name === 'A') as Layer
    const copyB = layers(copy.id).find((l) => l.name === 'B') as Layer
    const seam = lane?.transitions.find((t) => t.aLayerId !== null && t.bLayerId !== null)
    expect([seam?.aLayerId, seam?.bLayerId]).toEqual([copyA.id, copyB.id])
    const sourceSeam = comp(first).tracks.flatMap((t) => t.transitions).find((t) => t.aLayerId !== null && t.bLayerId !== null)
    expect(seam?.id).not.toBe(sourceSeam?.id)
    // The nested layer owns a copy of its inside.
    const nest = layers(copy.id).find((l) => l.kind === 'nested')
    const original = layers(first).find((l) => l.kind === 'nested')
    expect(nest?.kind === 'nested' && original?.kind === 'nested' && nest.sourceCompId !== original.sourceCompId).toBe(true)
    expect(session.project.comps.filter((x) => x.embedded)).toHaveLength(2)
    // Changing the copy leaves the source alone.
    await ok('layer.set', { id: copyA.id, values: { x: 300 } })
    expect((layers(first).find((l) => l.name === 'A') as Layer).transform.x).toBe(0)
  })
})

describe('pages', () => {
  it('creates pages with unique names, moves frames onto them, renames and reorders', async () => {
    const { ok, fail, session } = setup()
    const frame = await ok('frame.create', { name: 'Reel', width: 1080, height: 1920 })
    const page = await ok('page.create', { name: 'Cutdowns', frameIds: ['Reel'] })
    expect(session.project.pages.map((p) => p.name)).toEqual(['Page 1', 'Cutdowns'])
    expect(session.project.comps.find((c) => c.id === frame.id)?.pageId).toBe(page.id)
    expect(await fail('page.create', { name: 'cutdowns' })).toContain('exists')
    await ok('page.update', { id: 'Cutdowns', name: 'Social', index: 0 })
    expect(session.project.pages.map((p) => p.name)).toEqual(['Social', 'Page 1'])
    expect(await fail('page.update', { id: 'Social' })).toContain('Say what to change')
    expect(await fail('page.update', { id: 'Social', name: 'page 1' })).toContain('exists')
    const overview = await ok('doc.overview')
    expect(overview.pages).toEqual([
      { id: page.id, name: 'Social', frames: [frame.id] },
      expect.objectContaining({ name: 'Page 1' }),
    ])
  })

  it('deletes a page: frames need somewhere to go, the last page stays', async () => {
    const { ok, fail, session } = setup()
    const first = (session.project.comps[0] as Comp).id
    const spare = await ok('page.create', { name: 'Spare' })
    const frame = await ok('frame.create', { name: 'Extra', width: 640, height: 360, pageId: 'Spare' })
    expect(await fail('page.delete', { id: 'Spare' })).toContain('still holds 1 frame')
    expect(await fail('page.delete', { id: 'Spare', moveTo: 'Spare' })).toContain('being deleted')
    await ok('page.delete', { id: 'Spare', moveTo: 'Page 1' })
    expect(session.project.pages).toHaveLength(1)
    expect(pageOf(session.project, session.project.comps.find((c) => c.id === frame.id) as Comp)?.name).toBe('Page 1')
    expect(await fail('page.delete', { id: 'Page 1' })).toContain('last page stays')

    const second = await ok('page.create', { name: 'Trash' })
    const gone = await ok('frame.create', { name: 'Gone', width: 640, height: 360, pageId: second.id })
    expect(await ok('page.delete', { id: 'Trash', comps: 'delete' })).toMatchObject({ deletedFrames: [gone.id] })
    expect(session.project.comps.some((c) => c.id === gone.id)).toBe(false)
    expect(session.project.comps.some((c) => c.id === first)).toBe(true)
    void spare
  })

  it('refuses to delete the frames that are all that is left', async () => {
    const { ok, fail, session } = setup()
    await ok('page.create', { name: 'Other' })
    // The only frame is on Page 1: deleting Page 1 with its frames would leave none.
    expect(await fail('page.delete', { id: 'Page 1', comps: 'delete' })).toContain('at least one frame')
    expect(session.project.pages).toHaveLength(2)
  })
})

describe('static frames', () => {
  it('make layers span the frame whatever times they are given', async () => {
    const { ok, layers } = setup()
    const still = await ok('frame.create', { width: 800, height: 600, mode: 'static', durationMs: 2000 })
    const shape = await ok('layer.create', { compId: still.id, kind: 'shape', startMs: 700, durationMs: 100 })
    const layer = layers(still.id).find((l) => l.id === shape.id) as Layer
    expect([layer.startMs, layer.durationMs]).toEqual([0, 2000])
  })
})
