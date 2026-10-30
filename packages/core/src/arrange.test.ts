import { describe, expect, it } from 'vitest'
import { createDefaultProject } from './doc'
import { groupStructureProblem } from './groups'
import { sequentialIds } from './ids'
import type { Comp, Layer } from './schema'
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
    return result.error
  }
  const comp = (i = 0) => session.project.comps[i] as Comp
  const lanes = (i = 0) => comp(i).tracks.map((t) => `${t.layers.map((l) => l.name).join('+') || '∅'}${t.groupId ? `@${t.groupId}` : ''}`)
  const layer = (id: string, i = 0) => comp(i).tracks.flatMap((t) => t.layers).find((l) => l.id === id) as Layer
  return { session, ok, fail, comp, lanes, layer }
}

describe('layers.duplicate', () => {
  it('puts each copy on a new lane in front of its source, keeping values and keys, as one undo step', async () => {
    const { session, ok, lanes, layer } = setup()
    const a = await ok('layer.create', { kind: 'shape', name: 'A', x: 120, fill: '#ff0000' })
    await ok('layer.create', { kind: 'shape', name: 'B' })
    await ok('keyframes.set', { id: a.id, path: 'transform.opacity', keys: [{ t: 0, v: 0 }, { t: 500, v: 1 }] })
    const { ids } = await ok('layers.duplicate', { ids: a.id })
    expect(lanes()).toEqual(['B', 'A', 'A'])
    const copy = layer(ids[0])
    expect(copy.id).not.toBe(a.id)
    expect(copy.transform.x).toBe(120)
    expect(copy.animations['transform.opacity']).toHaveLength(2)
    session.undo()
    expect(lanes()).toEqual(['B', 'A'])
  })

  it('duplicates a group with everything in it, the copies pointing at the copied group', async () => {
    const { ok, comp, lanes } = setup()
    const a = await ok('layer.create', { kind: 'shape', name: 'A' })
    const b = await ok('layer.create', { kind: 'shape', name: 'B' })
    const { groupId } = await ok('layers.group', { ids: [a.id, b.id], name: 'G' })
    const { ids, alsoCopied } = await ok('layers.duplicate', { ids: [groupId, a.id] })
    expect(ids).toHaveLength(1)
    expect(alsoCopied).toBe(2)
    expect(lanes()).toEqual(['G', `B@${ids[0]}`, `A@${ids[0]}`, 'G', `B@${groupId}`, `A@${groupId}`])
    expect(groupStructureProblem(comp())).toBeNull()
  })

  it('keeps a copy of a member in its group', async () => {
    const { ok, lanes } = setup()
    const a = await ok('layer.create', { kind: 'shape', name: 'A' })
    const b = await ok('layer.create', { kind: 'shape', name: 'B' })
    const { groupId } = await ok('layers.group', { ids: [a.id, b.id], name: 'G' })
    await ok('layers.duplicate', { ids: [a.id] })
    expect(lanes()).toEqual(['G', `B@${groupId}`, `A@${groupId}`, `A@${groupId}`])
  })
})

describe('layers.copy', () => {
  it('copies into another comp at the front, timing kept or moved by atMs', async () => {
    const { ok, fail, lanes, layer } = setup()
    const a = await ok('layer.create', { kind: 'shape', name: 'A', startMs: 1000, durationMs: 2000, x: 50 })
    const other = await ok('comp.create', { name: 'Short', width: 1080, height: 1920 })
    await ok('layer.create', { compId: other.id, kind: 'shape', name: 'Back' })
    const kept = await ok('layers.copy', { ids: [a.id], toFrameId: other.id })
    expect(lanes(1)).toEqual(['A', 'Back'])
    expect(layer(kept.ids[0], 1)).toMatchObject({ startMs: 1000, durationMs: 2000, transform: { x: 50 } })
    const moved = await ok('layers.copy', { ids: a.id, toCompId: other.id, atMs: 0 })
    expect(moved.shiftedMs).toBe(-1000)
    expect(layer(moved.ids[0], 1).startMs).toBe(0)
    expect(await fail('layers.copy', { ids: [a.id], toCompId: 'nope' })).toMatch(/No comp/)
  })

  it('brings a group with its members, and lifts members copied without their group to the top level', async () => {
    const { ok, comp, lanes } = setup()
    const a = await ok('layer.create', { kind: 'shape', name: 'A' })
    const b = await ok('layer.create', { kind: 'shape', name: 'B' })
    const { groupId } = await ok('layers.group', { ids: [a.id, b.id], name: 'G' })
    const other = await ok('comp.create', { name: 'Other' })
    const whole = await ok('layers.copy', { ids: [groupId], toCompId: other.id })
    expect(lanes(1)).toEqual(['G', `B@${whole.ids[0]}`, `A@${whole.ids[0]}`])
    expect(groupStructureProblem(comp(1))).toBeNull()
    await ok('layers.copy', { ids: [a.id], toCompId: other.id })
    expect(lanes(1)[0]).toBe('A')
  })
})

describe('layers.restack', () => {
  it('brings to the front and sends to the back, moving whole lanes', async () => {
    const { ok, lanes, comp } = setup()
    const a = await ok('layer.create', { kind: 'shape', name: 'A' })
    await ok('layer.create', { kind: 'shape', name: 'B' })
    const c = await ok('layer.create', { kind: 'shape', name: 'C' })
    const laneOfA = comp().tracks[2]?.id
    await ok('layers.restack', { ids: [a.id], to: 'front' })
    expect(lanes()).toEqual(['A', 'C', 'B'])
    expect(comp().tracks[0]?.id).toBe(laneOfA)
    await ok('layers.restack', { ids: [c.id], to: 'back' })
    expect(lanes()).toEqual(['A', 'B', 'C'])
  })

  it('places above or below a layer, joining its group, and keeps the order given', async () => {
    const { ok, fail, lanes, comp } = setup()
    const a = await ok('layer.create', { kind: 'shape', name: 'A' })
    const b = await ok('layer.create', { kind: 'shape', name: 'B' })
    const { groupId } = await ok('layers.group', { ids: [a.id, b.id], name: 'G' })
    const x = await ok('layer.create', { kind: 'shape', name: 'X' })
    const y = await ok('layer.create', { kind: 'shape', name: 'Y' })
    await ok('layers.restack', { ids: [x.id, y.id], to: { below: b.id } })
    expect(lanes()).toEqual(['G', `B@${groupId}`, `X@${groupId}`, `Y@${groupId}`, `A@${groupId}`])
    await ok('layers.restack', { ids: [x.id], to: { above: groupId } })
    expect(lanes()).toEqual(['X', 'G', `B@${groupId}`, `Y@${groupId}`, `A@${groupId}`])
    await ok('layers.restack', { ids: [groupId], to: 'front' })
    expect(lanes()[0]).toBe('G')
    expect(groupStructureProblem(comp())).toBeNull()
    expect(await fail('layers.restack', { ids: [groupId], to: { below: a.id } })).toMatch(/inside/)
    expect(await fail('layers.restack', { ids: [a.id], to: { above: a.id } })).toMatch(/being moved/)
  })

  it('gives a layer that shares a lane a lane of its own', async () => {
    const { ok, lanes, comp } = setup()
    const a = await ok('layer.create', { kind: 'shape', name: 'A', durationMs: 1000 })
    const track = comp().tracks[0]?.id
    await ok('layer.create', { kind: 'shape', name: 'B', startMs: 1000, durationMs: 1000, trackId: track })
    await ok('layer.create', { kind: 'shape', name: 'C' })
    await ok('layers.restack', { ids: [a.id], to: 'front' })
    expect(lanes()).toEqual(['A', 'C', 'B'])
  })

  it('refuses audio in a group', async () => {
    const { ok, fail, session } = setup()
    const media = await ok('media.add', { kind: 'audio', name: 'Song', path: 'C:/song.mp3', durationMs: 5000 })
    const song = await ok('layer.create', { kind: 'audio', mediaId: media.id })
    const a = await ok('layer.create', { kind: 'shape', name: 'A' })
    await ok('layers.group', { ids: [a.id] })
    expect(await fail('layers.restack', { ids: [song.id], to: { below: a.id } })).toMatch(/audio/)
    expect(session.project.comps[0]?.tracks.length).toBe(3)
  })
})
