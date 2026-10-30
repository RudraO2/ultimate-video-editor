import { type Comp, createDefaultProject, type Layer, sequentialIds, Session } from '@uve/core'
import { describe, expect, it } from 'vitest'
import { audibleLayers } from './audio'
import type { Ctx2D } from './content'
import { nodeBounds, buildScene, flattenScene, type SceneNode } from './scene'

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
  // biome-ignore lint/suspicious/noExplicitAny: test results are checked field by field
  const ok = async (name: string, input: unknown = {}): Promise<any> => {
    const result = await session.call(name, input)
    if (!result.ok) throw new Error(name + ' failed: ' + result.error)
    return result.value
  }
  const comp = (id: string) => session.project.comps.find((c) => c.id === id) as Comp
  const scene = (id: string, t: number) => buildScene(comp(id), { measure, media: session.project.media, comps: session.project.comps }, t)
  const find = (id: string, layerId: string, t: number) => flattenScene(scene(id, t)).find((n) => n.layer.id === layerId) as SceneNode
  return { session, ok, comp, scene, find }
}

describe('static frames', () => {
  it('draw the same moment whatever time is asked', async () => {
    const { ok, find } = setup()
    const still = await ok('frame.create', { width: 800, height: 600, mode: 'static', durationMs: 4000, atMs: 1000 })
    const shape = await ok('layer.create', { compId: still.id, kind: 'shape', width: 100, height: 100 })
    await ok('keyframes.set', { id: shape.id, path: 'transform.x', keys: [{ t: 0, v: 0 }, { t: 2000, v: 200 }] })
    // The still is at 1 s: halfway along the move, at 1 s, at 3 s, and at 0.
    for (const t of [0, 1000, 3000, 99_000]) expect(nodeBounds(find(still.id, shape.id, t)).left).toBeCloseTo(50, 3)
    // A timeline frame still moves.
    await ok('frame.update', { id: still.id, mode: 'timeline' })
    expect(nodeBounds(find(still.id, shape.id, 2000)).left).toBeCloseTo(150, 3)
  })

  it('hold when shown inside another frame, whatever the nested layer does with time', async () => {
    const { ok, find, session } = setup()
    const host = session.project.comps[0] as Comp
    const still = await ok('frame.create', { width: 400, height: 400, mode: 'static', durationMs: 4000, atMs: 2000 })
    const shape = await ok('layer.create', { compId: still.id, kind: 'shape', width: 50, height: 50 })
    await ok('keyframes.set', { id: shape.id, path: 'transform.x', keys: [{ t: 0, v: -100 }, { t: 4000, v: 100 }] })
    const nested = await ok('layer.create', { compId: host.id, kind: 'comp', sourceCompId: still.id })
    const every = (nodes: SceneNode[]): SceneNode[] => nodes.flatMap((n) => (n.kind === 'leaf' ? [n] : [n, ...every(n.children)]))
    const inside = (t: number) => every(buildScene(session.project.comps[0] as Comp, { measure, media: [], comps: session.project.comps }, t)).find((n) => n.layer.id === shape.id) as SceneNode
    // At 2 s of 4 the shape is at x = 0; nested, it stays there as the host plays.
    for (const t of [0, 1500, 3900]) expect(nodeBounds(inside(t)).left + 25).toBeCloseTo(0, 3)
    void nested
    void find
  })

  it('are silent: a static frame plays no sound', async () => {
    const { session, ok } = setup()
    const media = await ok('media.add', { kind: 'audio', name: 'tone.wav', path: 'C:/tone.wav', durationMs: 3000 })
    const still = await ok('frame.create', { width: 320, height: 180, mode: 'static', durationMs: 3000 })
    await ok('layer.create', { compId: still.id, kind: 'audio', mediaId: media.id })
    const comp = session.project.comps.find((c) => c.id === still.id) as Comp
    expect(audibleLayers(comp, { media: session.project.media, comps: session.project.comps })).toEqual([])
    await ok('frame.update', { id: still.id, mode: 'timeline' })
    const timeline = session.project.comps.find((c) => c.id === still.id) as Comp
    expect(audibleLayers(timeline, { media: session.project.media, comps: session.project.comps })).toHaveLength(1)
  })

  it("crop or spill what is shown inside a nested layer by the frame's overflow", async () => {
    const { ok, session } = setup()
    const host = session.project.comps[0] as Comp
    const part = await ok('frame.create', { width: 200, height: 200, background: '#112233' })
    await ok('layer.create', { compId: part.id, kind: 'shape', width: 50, height: 50 })
    const nested = await ok('layer.create', { compId: host.id, kind: 'comp', sourceCompId: part.id })
    const clip = () => flattenScene(buildScene(session.project.comps[0] as Comp, { measure, media: [], comps: session.project.comps }, 0)).length
    void clip
    // A visible background crops by default; overflow 1 lets it spill, overflow 0 crops even a transparent one.
    const clipOf = () => {
      const roots = buildScene(session.project.comps[0] as Comp, { measure, media: [], comps: session.project.comps }, 0)
      const node = roots.find((n) => n.layer.id === nested.id)
      return node?.kind === 'nested' ? node.clip : null
    }
    expect(clipOf()).toBe(true)
    await ok('frame.update', { id: part.id, ops: [{ op: 'set', path: 'overflow', value: 1 }] })
    expect(clipOf()).toBe(false)
    await ok('frame.update', { id: part.id, background: '#00000000', ops: [{ op: 'set', path: 'overflow', value: 0 }] })
    expect(clipOf()).toBe(true)
    // The nested layer's own choice wins over the frame's.
    await ok('layer.patch', { id: nested.id, ops: [{ op: 'set', path: 'clipContent', value: false }] })
    expect(clipOf()).toBe(false)
  })
})

export type { Layer }
