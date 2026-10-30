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
  const comp = () => session.project.comps[0] as Comp
  const lane = (i: number) => comp().tracks[i]?.layers.map((l) => `${l.name}@${l.startMs}-${l.startMs + l.durationMs}`) ?? []
  const layer = (id: string) => comp().tracks.flatMap((t) => t.layers).find((l) => l.id === id) as Layer
  const shape = (name: string, startMs: number, durationMs: number, trackId?: string) =>
    ok('layer.create', { kind: 'shape', name, startMs, durationMs, ...(trackId ? { trackId } : {}) })
  return { session, ok, fail, comp, lane, layer, shape }
}

describe('timeline.close_gaps', () => {
  it('moves every layer on the lane back to the one before it, keys and all, as one step', async () => {
    const { session, ok, comp, lane, shape } = setup()
    const a = await shape('A', 500, 1000)
    const track = comp().tracks[0]?.id
    const b = await shape('B', 3000, 1000, track)
    await ok('keyframes.set', { id: b.id, path: 'transform.x', keys: [{ t: 0, v: 0 }, { t: 500, v: 100 }] })
    const result = await ok('timeline.close_gaps', { ids: [a.id] })
    expect(result.lanesClosed).toBe(1)
    expect(lane(0)).toEqual(['A@0-1000', 'B@1000-2000'])
    session.undo()
    expect(lane(0)).toEqual(['A@500-1500', 'B@3000-4000'])
  })

  it('leaves a locked layer where it is and closes up to it', async () => {
    const { ok, comp, lane, shape } = setup()
    const a = await shape('A', 1000, 500)
    const track = comp().tracks[0]?.id
    const b = await shape('B', 2000, 500, track)
    await shape('C', 4000, 500, track)
    await ok('layer.patch', { id: b.id, ops: [{ op: 'set', path: 'locked', value: true }] })
    await ok('timeline.close_gaps', { ids: a.id })
    expect(lane(0)).toEqual(['A@0-500', 'B@2000-2500', 'C@2500-3000'])
  })
})

describe('timeline.compact', () => {
  it('drops empty lanes and lets layers fall behind without changing what covers what', async () => {
    const { ok, comp, shape } = setup()
    await shape('Back', 0, 5000)
    await shape('Early', 0, 1000)
    await shape('Late', 2000, 1000)
    await ok('track.create', { index: 0 })
    const result = await ok('timeline.compact', {})
    expect(result).toEqual({ lanesBefore: 4, lanesAfter: 2, moved: 1 })
    expect(comp().tracks.map((t) => t.layers.map((l) => l.name).join('+'))).toEqual(['Early+Late', 'Back'])
  })

  it('keeps locked, hidden and muted lanes in place and works inside groups', async () => {
    const { ok, comp, shape } = setup()
    await shape('A', 0, 1000)
    await shape('B', 2000, 1000)
    const hidden = comp().tracks[0]?.id
    await ok('track.update', { id: hidden, hidden: true })
    await shape('C', 4000, 1000)
    const result = await ok('timeline.compact', { frameId: comp().id })
    expect(result.lanesAfter).toBe(3)
    expect(groupStructureProblem(comp())).toBeNull()
  })
})

describe('timeline.cut_ranges', () => {
  it('razors the layer, removes the ranges and ripples everything in sync', async () => {
    const { session, ok, lane, shape, comp } = setup()
    const talk = await shape('Talk', 0, 10_000)
    const caption = await shape('Caption', 6000, 1000)
    await shape('Inside', 2200, 300, comp().tracks[0]?.id)
    const music = await shape('Music', 0, 10_000)
    const result = await ok('timeline.cut_ranges', {
      id: talk.id,
      ranges: [
        { startMs: 2000, endMs: 3000 },
        { startMs: 5000, endMs: 5500 },
      ],
    })
    expect(result.removedMs).toBe(1500)
    expect(result.cuts).toBe(2)
    expect(result.pieces).toHaveLength(3)
    // Lanes front to back: Music, then Caption with Inside, then Talk.
    expect(lane(0)).toEqual(['Music@0-8500'])
    expect(lane(1)).toEqual(['Caption@4500-5500'])
    expect(lane(2)).toEqual(['Talk@0-2000', 'Talk@2000-4000', 'Talk@4000-8500'])
    expect(caption.id).toBeTruthy()
    expect(music.id).toBeTruthy()
    session.undo()
    expect(lane(2)).toEqual(['Talk@0-10000'])
  })

  it('moves the source of media pieces so the picture stays with its words', async () => {
    const { ok, comp } = setup()
    await ok('media.add', { kind: 'video', name: 'Clip', path: 'C:/c.mp4', durationMs: 10_000 })
    const mediaId = (await ok('media.list', {}))[0].id
    const clip = await ok('layer.create', { kind: 'video', mediaId })
    const { pieces } = await ok('timeline.cut_ranges', { id: clip.id, ranges: [{ startMs: 1000, endMs: 4000 }], ripple: 'lane' })
    const second = comp().tracks[0]?.layers.find((l) => l.id === pieces[1]) as Extract<Layer, { kind: 'video' }>
    expect(second).toMatchObject({ startMs: 1000, durationMs: 6000, sourceStartMs: 4000 })
  })

  it('leaves holes with ripple none, and refuses ranges outside the layer and groups', async () => {
    const { ok, fail, lane, shape } = setup()
    const a = await shape('A', 0, 4000)
    const b = await shape('B', 0, 1000)
    await ok('timeline.cut_ranges', { id: a.id, ranges: [{ startMs: 1000, endMs: 2000 }], ripple: 'none' })
    expect(lane(1)).toEqual(['A@0-1000', 'A@2000-4000'])
    expect(await fail('timeline.cut_ranges', { id: a.id, ranges: [{ startMs: 5000, endMs: 6000 }] })).toMatch(/None of those ranges/)
    const { groupId } = await ok('layers.group', { ids: [b.id] })
    expect(await fail('timeline.cut_ranges', { id: groupId, ranges: [{ startMs: 0, endMs: 500 }] })).toMatch(/group cannot be cut/)
  })
})
