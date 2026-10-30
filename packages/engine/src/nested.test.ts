import { type Comp, createDefaultProject, type Layer, sequentialIds, Session } from '@uve/core'
import { describe, expect, it } from 'vitest'
import { audibleLayers } from './audio'
import type { Ctx2D } from './content'
import { playedMedia } from './nested'
import { buildScene, type NestedNode, nodeBounds, placementsOf, type SceneNode } from './scene'

const measure = {
  font: '',
  letterSpacing: '',
  textAlign: 'left',
  textBaseline: 'alphabetic',
  measureText: (text: string) => ({ width: text.length * 10 }),
} as unknown as Ctx2D

function setup() {
  const ids = sequentialIds()
  const session = new Session({ project: createDefaultProject(ids), ids })
  const main = () => session.project.comps[0] as Comp
  const scene = (t = 0, comp = main()) => buildScene(comp, { measure, media: [], comps: session.project.comps }, t)
  session.measure = (c, t) => placementsOf(buildScene(c, { measure, media: [], comps: session.project.comps }, t))
  // biome-ignore lint/suspicious/noExplicitAny: test results are checked field by field
  const ok = async (name: string, input: unknown = {}): Promise<any> => {
    const result = await session.call(name, input)
    if (!result.ok) throw new Error(`${name} failed: ${result.error}`)
    return result.value
  }
  return { session, ok, main, scene }
}

const rounded = (r: { left: number; top: number; width: number; height: number }) =>
  Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round(v * 1000) / 1000]))

describe('scene: nested comps', () => {
  it('keeps every pixel in place when layers are nested, and moves them as one after', async () => {
    const { ok, scene } = setup()
    const a = await ok('layer.create', { kind: 'shape', width: 100, height: 100, x: -100, y: 20 })
    const b = await ok('layer.create', { kind: 'shape', width: 50, height: 50, x: 200 })
    const leafBounds = () => {
      const out: Record<string, unknown> = {}
      const walk = (nodes: SceneNode[]) => {
        for (const n of nodes) {
          if (n.kind === 'leaf') out[n.layer.id] = rounded(nodeBounds(n))
          else walk(n.children)
        }
      }
      walk(scene())
      return out
    }
    const before = leafBounds()
    const { id } = await ok('layers.nest', { ids: [a.id, b.id] })
    expect(leafBounds()).toEqual(before)
    const node = scene().find((n) => n.layer.id === id) as NestedNode
    expect(node.kind).toBe('nested')
    // The box hugs them (375 × 100); its centre is rounded to whole pixels (38, 20).
    expect(rounded(nodeBounds(node))).toEqual({ left: -149.5, top: -30, width: 375, height: 100 })
    await ok('layer.set', { id, values: { x: 138 } })
    expect((leafBounds()[a.id] as { left: number }).left).toBe(-50)
    // Placements stop at the nested layer: what is inside is in another comp.
    const placed = placementsOf(scene())
    expect(placed.has(id)).toBe(true)
    expect(placed.has(a.id)).toBe(false)
  })

  it('shows the inside at its own clock, and nothing past the end of a source that plays once', async () => {
    const { ok, main, scene } = setup()
    const inner = await ok('comp.create', { name: 'Inner', width: 400, height: 400, durationMs: 2000 })
    await ok('layer.create', { compId: inner.id, kind: 'shape', name: 'Late', startMs: 1000, durationMs: 1000 })
    const n = await ok('layer.create', { compId: main().id, kind: 'nested', sourceCompId: inner.id, startMs: 500, durationMs: 5000 })
    const childrenAt = (t: number) => (scene(t).find((x) => x.layer.id === n.id) as NestedNode | undefined)?.children.length ?? null
    expect(childrenAt(1000)).toBe(0)
    expect(childrenAt(1500)).toBe(1)
    expect(childrenAt(2600)).toBeNull()
    await ok('layer.patch', { id: n.id, ops: [{ op: 'merge', path: 'playback', value: { loop: 'loop' } }] })
    expect(childrenAt(4000)).toBe(1)
  })

  it('crops a comp with a background and lets a transparent one spill, unless told', async () => {
    const { ok, main, scene } = setup()
    const card = await ok('comp.create', { name: 'Card', width: 200, height: 200, background: '#112233' })
    const n = await ok('layer.create', { compId: main().id, kind: 'nested', sourceCompId: card.id })
    const node = () => scene().find((x) => x.layer.id === n.id) as NestedNode
    expect(node().clip).toBe(true)
    expect(node().container).not.toBeNull()
    await ok('layer.patch', { id: n.id, ops: [{ op: 'set', path: 'clipContent', value: false }] })
    expect(node().clip).toBe(false)
  })
})

describe('media inside nested comps', () => {
  it('places inner media in the outer time, per pass of a loop, with speed', async () => {
    const { ok, session, main } = setup()
    await ok('media.add', { kind: 'audio', name: 'Song', path: 'C:/s.mp3', durationMs: 60_000 })
    const mediaId = session.project.media[0]?.id as string
    const inner = await ok('comp.create', { name: 'Inner', durationMs: 2000 })
    const song = await ok('layer.create', { compId: inner.id, kind: 'audio', mediaId, startMs: 500, durationMs: 1000 })
    const n = await ok('layer.create', { compId: main().id, kind: 'nested', sourceCompId: inner.id, startMs: 1000, durationMs: 2000 })
    await ok('layer.patch', { id: n.id, ops: [{ op: 'merge', path: 'playback', value: { speed: 2, loop: 'loop' } }] })
    const placed = playedMedia(main(), session.project.comps).map((p) => p.layer as Extract<Layer, { kind: 'audio' }>)
    expect(placed.map((l) => [l.id, l.startMs, l.durationMs, l.playbackRate])).toEqual([
      [`${n.id}/${song.id}#0`, 1250, 500, 2],
      [`${n.id}/${song.id}#1`, 2250, 500, 2],
    ])
    expect(audibleLayers(main(), { media: session.project.media, comps: session.project.comps })).toHaveLength(2)
  })

  it('plays a pingpong pass backwards, and leaves it out of the sound', async () => {
    const { ok, session, main } = setup()
    await ok('media.add', { kind: 'video', name: 'Clip', path: 'C:/c.mp4', durationMs: 60_000, hasAudio: true })
    const mediaId = session.project.media[0]?.id as string
    const inner = await ok('comp.create', { name: 'Inner', durationMs: 1000 })
    await ok('layer.create', { compId: inner.id, kind: 'video', mediaId, startMs: 0, durationMs: 1000 })
    const n = await ok('layer.create', { compId: main().id, kind: 'nested', sourceCompId: inner.id, durationMs: 2000 })
    await ok('layer.patch', { id: n.id, ops: [{ op: 'merge', path: 'playback', value: { loop: 'pingpong' } }] })
    const placed = playedMedia(main(), session.project.comps).map((p) => p.layer as Extract<Layer, { kind: 'video' }>)
    expect(placed.map((l) => [l.startMs, l.sourceStartMs, l.playbackRate])).toEqual([
      [0, 0, 1],
      [1000, 1000, -1],
    ])
    expect(audibleLayers(main(), { media: session.project.media, comps: session.project.comps })).toHaveLength(1)
  })
})
