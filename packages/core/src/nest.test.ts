import { describe, expect, it } from 'vitest'
import { createDefaultProject } from './doc'
import { groupStructureProblem } from './groups'
import { sequentialIds } from './ids'
import { nestedTime } from './nest'
import { readProjectFile, writeProjectFile } from './projectFile'
import type { Measure, Placement } from './registry'
import { type Comp, type Layer, LayerSchema, type NestedLayer } from './schema'
import { Session } from './session'

/** A stand-in for the editor's measurer: a shape's box at its position. */
const fakeMeasure: Measure = (comp: Comp) => {
  const out = new Map<string, Placement>()
  for (const layer of comp.tracks.flatMap((t) => t.layers)) {
    const t = layer.transform
    const width = layer.kind === 'shape' ? layer.shape.width : 100
    const height = layer.kind === 'shape' ? layer.shape.height : 40
    out.set(layer.id, {
      x: t.x,
      y: t.y,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      bounds: { left: t.x - width / 2, top: t.y - height / 2, width, height },
    })
  }
  return out
}

function setup(measure: Measure | null = fakeMeasure) {
  const ids = sequentialIds()
  const session = new Session({ project: createDefaultProject(ids), ids, measure: measure ?? undefined })
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
  const compById = (id: string) => session.project.comps.find((c) => c.id === id) as Comp
  const main = () => session.project.comps[0] as Comp
  const layer = (id: string) => session.project.comps.flatMap((c) => c.tracks.flatMap((t) => t.layers)).find((l) => l.id === id) as Layer
  return { session, ok, fail, compById, main, layer }
}

const nested = (fields: Omit<Partial<NestedLayer>, 'playback'> & { playback?: Partial<NestedLayer['playback']> }) =>
  LayerSchema.parse({ id: 'n', name: 'N', kind: 'nested', sourceCompId: 'c', startMs: 1000, durationMs: 10_000, ...fields }) as NestedLayer

describe('nestedTime', () => {
  it('runs from trimInMs at the speed, and shows nothing past a play-once source', () => {
    const layer = nested({ trimInMs: 500, playback: { speed: 2 } })
    expect(nestedTime(layer, 3000, 999)).toBeNull()
    expect(nestedTime(layer, 3000, 1000)).toEqual({ timeMs: 500, cycle: 0 })
    expect(nestedTime(layer, 3000, 2000)).toEqual({ timeMs: 2500, cycle: 0 })
    expect(nestedTime(layer, 3000, 2250)).toBeNull()
  })

  it('loops and ping-pongs over the cycle', () => {
    const loop = nested({ playback: { loop: 'loop', loopLengthMs: 1000 } })
    expect(nestedTime(loop, 3000, 3500)).toEqual({ timeMs: 500, cycle: 2 })
    const pingpong = nested({ playback: { loop: 'pingpong' } })
    expect(nestedTime(pingpong, 2000, 3500)).toEqual({ timeMs: 1500, cycle: 1 })
    expect(nestedTime(pingpong, 2000, 5250)).toEqual({ timeMs: 250, cycle: 2 })
  })
})

describe('layers.nest', () => {
  it('moves layers into a comp that hugs them, keeping them where they are, as one undo step', async () => {
    const { session, ok, compById, main, layer } = setup()
    const a = await ok('layer.create', { kind: 'shape', name: 'A', width: 200, height: 100, x: 100, y: 0, startMs: 1000, durationMs: 2000 })
    const b = await ok('layer.create', { kind: 'shape', name: 'B', width: 100, height: 100, x: 300, y: 100, startMs: 1500, durationMs: 2000 })
    await ok('keyframes.set', { id: b.id, path: 'transform.x', keys: [{ t: 0, v: 300 }, { t: 500, v: 350 }] })
    await ok('layer.create', { kind: 'shape', name: 'Back' })
    const result = await ok('layers.nest', { ids: [a.id, b.id], name: 'Card' })
    // Measured at rest: A spans x 0…200, B 250…350; y −50…150.
    expect(result.box).toEqual({ width: 350, height: 200, x: 175, y: 50 })
    const inside = compById(result.sourceCompId)
    expect(inside).toMatchObject({ embedded: true, width: 350, height: 200, durationMs: 2500, background: '#00000000' })
    expect(layer(a.id)).toMatchObject({ startMs: 0, transform: { x: -75, y: -50 } })
    expect(layer(b.id).animations['transform.x']?.map((k) => k.v)).toEqual([125, 175])
    expect(layer(result.id)).toMatchObject({ kind: 'nested', startMs: 1000, durationMs: 2500, transform: { x: 175, y: 50 } })
    expect(main().tracks.map((t) => t.layers.map((l) => l.name).join('+'))).toEqual(['Back', 'Card'])
    const listed = await ok('layers.list', { compId: main().id })
    expect(listed.tracks[1].layers[0]).toMatchObject({ kind: 'nested', inside: 'embedded', sourceCompId: result.sourceCompId })
    session.undo()
    expect(session.project.comps).toHaveLength(1)
    expect(main().tracks).toHaveLength(3)
  })

  it('nests a group with its members, keeps the level, and refuses without measuring unless fullFrame', async () => {
    const { ok, fail, compById, main } = setup(null)
    const a = await ok('layer.create', { kind: 'shape', name: 'A', x: 40 })
    const b = await ok('layer.create', { kind: 'shape', name: 'B' })
    const { groupId } = await ok('layers.group', { ids: [a.id, b.id], name: 'G' })
    expect(await fail('layers.nest', { ids: [groupId] })).toMatch(/measure/)
    const result = await ok('layers.nest', { ids: groupId, fullFrame: true })
    const inside = compById(result.sourceCompId)
    expect(inside.width).toBe(1920)
    expect(inside.tracks.map((t) => t.layers.map((l) => l.name).join('+'))).toEqual(['G', 'B', 'A'])
    expect(groupStructureProblem(inside)).toBeNull()
    expect(main().tracks).toHaveLength(1)
  })

  it('deletes an embedded comp with its layer, and keeps a linked one', async () => {
    const { ok, session } = setup()
    const a = await ok('layer.create', { kind: 'shape', name: 'A' })
    const { id } = await ok('layers.nest', { ids: [a.id] })
    expect(session.project.comps).toHaveLength(2)
    await ok('layers.delete', { ids: [id] })
    expect(session.project.comps).toHaveLength(1)
    const other = await ok('comp.create', { name: 'Scene' })
    const link = await ok('layer.create', { kind: 'comp', sourceFrameId: other.id, compId: session.project.comps[0]?.id })
    await ok('layers.delete', { ids: [link.id] })
    expect(session.project.comps).toHaveLength(2)
  })
})

describe('nested layers', () => {
  it('links a comp with layer.create, refusing loops, and lasts as long as it', async () => {
    const { ok, fail, main } = setup()
    const scene = await ok('comp.create', { name: 'Scene', width: 800, height: 600, durationMs: 4000 })
    const created = await ok('layer.create', { compId: main().id, kind: 'nested', sourceCompId: scene.id })
    const listed = await ok('layers.list', { compId: main().id })
    expect(listed.tracks[0].layers[0]).toMatchObject({ name: 'Scene', endMs: 4000, inside: 'linked' })
    expect(created.id).toBeTruthy()
    expect(await fail('layer.create', { compId: scene.id, kind: 'nested', sourceCompId: main().id })).toMatch(/cannot show itself/)
    expect(await fail('layer.create', { compId: main().id, kind: 'nested', sourceCompId: main().id })).toMatch(/cannot show itself/)
    expect(await fail('layer.patch', { id: created.id, ops: [{ op: 'set', path: 'sourceCompId', value: main().id }] })).toMatch(/cannot change/)
  })

  it('makeUnique copies a linked source into an embedded comp, and skips embedded ones', async () => {
    const { ok, compById, main, session } = setup()
    const scene = await ok('comp.create', { name: 'Scene' })
    const inner = await ok('layer.create', { compId: scene.id, kind: 'shape', name: 'Inner' })
    const one = await ok('layer.create', { compId: main().id, kind: 'nested', sourceCompId: scene.id })
    await ok('layer.create', { compId: main().id, kind: 'nested', sourceCompId: scene.id })
    const { made } = await ok('layers.makeUnique', { ids: one.id })
    const copy = compById(made[one.id])
    expect(copy.embedded).toBe(true)
    expect(copy.tracks[0]?.layers[0]?.id).not.toBe(inner.id)
    expect(copy.tracks[0]?.layers[0]?.name).toBe('Inner')
    expect(await ok('layers.makeUnique', { ids: [one.id] })).toEqual({ made: {}, skipped: [one.id] })
    expect(session.project.comps).toHaveLength(3)
  })

  it('keeps the inside in place when split or trimmed, and refuses to move a loop\'s start', async () => {
    const { ok, fail, main, layer } = setup()
    const scene = await ok('comp.create', { name: 'Scene', durationMs: 5000 })
    const n = await ok('layer.create', { compId: main().id, kind: 'nested', sourceCompId: scene.id, startMs: 1000 })
    await ok('layer.patch', { id: n.id, ops: [{ op: 'merge', path: 'playback', value: { speed: 2 } }] })
    const { right } = await ok('timeline.split', { id: n.id, atMs: 2000 })
    expect(layer(right)).toMatchObject({ startMs: 2000, trimInMs: 2000 })
    await ok('timeline.trim', { id: n.id, startMs: 1500 })
    expect(layer(n.id)).toMatchObject({ startMs: 1500, trimInMs: 1000 })
    await ok('layer.patch', { id: n.id, ops: [{ op: 'merge', path: 'playback', value: { loop: 'loop' } }] })
    expect(await fail('timeline.trim', { id: n.id, startMs: 1600 })).toMatch(/loops/)
  })

  it('round-trips through a project file', async () => {
    const { ok, session } = setup()
    const a = await ok('layer.create', { kind: 'shape', name: 'A' })
    await ok('layers.nest', { ids: [a.id] })
    const back = readProjectFile(writeProjectFile(session.project))
    expect(back.project.comps[1]?.embedded).toBe(true)
  })
})
