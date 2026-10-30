import { type Comp, createDefaultProject, type Layer, motionPointAt, sequentialIds, Session } from '@uve/core'
import { describe, expect, it } from 'vitest'
import type { Ctx2D } from './content'
import { transformPoint } from './math'
import { centreOf, planMotion } from './motion'
import { buildScene, flattenScene, type NestedNode, placementsOf, type SceneNode } from './scene'

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
  const comp = () => session.project.comps[0] as Comp
  const source = () => ({ measure, media: [], comps: session.project.comps })
  session.measure = (c, t) => placementsOf(buildScene(c, source(), t))
  // biome-ignore lint/suspicious/noExplicitAny: test results are checked field by field
  const ok = async (name: string, input: unknown = {}): Promise<any> => {
    const result = await session.call(name, input)
    if (!result.ok) throw new Error(`${name} failed: ${result.error}`)
    return result.value
  }
  const layer = (id: string) => session.project.comps.flatMap((c) => c.tracks.flatMap((t) => t.layers)).find((l) => l.id === id) as Layer
  const scene = (t: number, c: Comp = comp()) => buildScene(c, source(), t)
  const find = (id: string, t: number) => flattenScene(scene(t)).find((n) => n.layer.id === id) as SceneNode
  const place = (id: string, t: number) => placementsOf(scene(t)).get(id) as { x: number; y: number }
  const plan = (t: number) => {
    const build = (time: number) => scene(time)
    return planMotion(comp(), build(t), build, t, 1)
  }
  return { session, ok, comp, layer, scene, find, place, plan }
}

const HOP = [
  { at: 0, value: [-300, 200], arc: 250 },
  { at: 800, value: [0, 200], arc: 120 },
  { at: 1400, value: [300, 200] },
]

describe('curved motion paths in the engine', () => {
  it('puts a plain layer on the curve, also when it starts late', async () => {
    const { ok, layer, place } = setup()
    const a = await ok('layer.create', { kind: 'shape', width: 40, height: 40, durationMs: 3000 })
    await ok('keyframes.set', { id: a.id, property: 'position', keys: HOP })
    for (const t of [0, 200, 400, 800, 1100, 1399]) {
      const want = motionPointAt(layer(a.id), t)!
      expect(want).toBeDefined()
      const got = place(a.id, t)
      expect(got.x).toBeCloseTo(want[0], 3)
      expect(got.y).toBeCloseTo(want[1], 3)
    }
    const apex = place(a.id, 400)
    expect(apex.x).toBeCloseTo(-150, 3)
    expect(apex.y).toBeCloseTo(-50, 3)

    // Late start: the keys stay relative to the layer start.
    await ok('timeline.move', { id: a.id, startMs: 700 })
    for (const t of [700, 900, 1100, 1500, 1900, 2099]) {
      const want = motionPointAt(layer(a.id), t - 700)!
      expect(want).toBeDefined()
      const got = place(a.id, t)
      expect(got.x).toBeCloseTo(want[0], 3)
      expect(got.y).toBeCloseTo(want[1], 3)
    }
    expect(place(a.id, 1100).y).toBeCloseTo(-50, 3)
  })

  it('puts a grouped layer on the curve through the group chain', async () => {
    const { ok, layer, find, place } = setup()
    const a = await ok('layer.create', { kind: 'shape', width: 40, height: 40, durationMs: 3000 })
    await ok('keyframes.set', { id: a.id, property: 'position', keys: HOP })
    const plain = [400, 1000].map((t) => place(a.id, t))
    const { groupId } = await ok('layers.group', { ids: [a.id] })
    await ok('layer.set', { id: groupId, values: { x: 60, y: -30, rotation: 25, scaleX: 1.5, scaleY: 1.5 } })
    for (const [i, t] of [400, 1000].entries()) {
      const want = motionPointAt(layer(a.id), t)!
      const node = find(a.id, t)
      const [ex, ey] = transformPoint(node.above, want[0], want[1], 0)
      const got = place(a.id, t)
      expect(got.x).toBeCloseTo(ex, 3)
      expect(got.y).toBeCloseTo(ey, 3)
      const p = plain[i] as { x: number; y: number }
      expect(Math.hypot(got.x - p.x, got.y - p.y)).toBeGreaterThan(10)
    }
  })

  it('puts a nested layer on the curve at the inner clock', async () => {
    const { ok, session, layer, scene, find, comp } = setup()
    const a = await ok('layer.create', { kind: 'shape', width: 40, height: 40, durationMs: 3000 })
    await ok('keyframes.set', { id: a.id, property: 'position', keys: HOP })
    const { id: nestedId, sourceCompId } = await ok('layers.nest', { ids: [a.id] })
    await ok('layer.set', { id: nestedId, values: { x: 100, y: 50 } })
    await ok('timeline.move', { id: nestedId, startMs: 500 })
    const inner = session.project.comps.find((c) => c.id === sourceCompId) as Comp
    const innerLayer = layer(a.id)
    expect(comp().id).not.toBe(inner.id)
    let delta: [number, number] | null = null
    for (const innerT of [100, 400, 700, 1000, 1300]) {
      const outerT = innerT + 500
      const nested = find(nestedId, outerT) as NestedNode
      expect(nested.kind).toBe('nested')
      const leaf = flattenScene(nested.children).find((n) => n.layer.id === a.id) as SceneNode
      expect(leaf).toBeDefined()
      const [lx, ly] = transformPoint(leaf.matrix, 0, 0, 0)
      const own = motionPointAt(innerLayer, innerT)!
      // The inside is the same layer seen through one fixed move, so its offset from the curve is constant.
      const dx = lx - own[0]
      const dy = ly - own[1]
      if (!delta) delta = [dx, dy]
      expect(dx).toBeCloseTo(delta[0], 3)
      expect(dy).toBeCloseTo(delta[1], 3)
    }
    // And that inner layer alone, in its own comp, is on the curve at the inner clock.
    const own = flattenScene(scene(700, inner)).find((n) => n.layer.id === a.id) as SceneNode
    const [ox, oy] = transformPoint(own.matrix, 0, 0, 0)
    expect(ox).toBeCloseTo(motionPointAt(innerLayer, 700)![0], 3)
    expect(oy).toBeCloseTo(motionPointAt(innerLayer, 700)![1], 3)
  })

  it('samples motion blur along the curve, not the chord', async () => {
    const { ok, layer, find, plan, comp } = setup()
    expect(comp().motionBlur.enabled).toBe(true)
    const a = await ok('layer.create', { kind: 'shape', width: 40, height: 40, durationMs: 3000 })
    await ok('keyframes.set', {
      id: a.id,
      property: 'position',
      keys: [
        { at: 0, value: [-500, 300], arc: 400 },
        { at: 300, value: [500, 300] },
      ],
    })
    const t = 150
    const moving = plan(t).get(a.id)
    expect(moving).toBeDefined()
    const samples = moving!.samples
    expect(samples.length).toBeGreaterThanOrEqual(3)
    for (const s of samples) {
      const want = motionPointAt(layer(a.id), s.node.resolved.layerTimeMs)!
      expect(want).toBeDefined()
      const [cx, cy] = centreOf(s.node)
      expect(cx).toBeCloseTo(want[0], 3)
      expect(cy).toBeCloseTo(want[1], 3)
    }
    const first = centreOf((samples[0] as { node: SceneNode }).node)
    const last = centreOf((samples[samples.length - 1] as { node: SceneNode }).node)
    const mid = centreOf((samples[Math.floor(samples.length / 2)] as { node: SceneNode }).node)
    // Distance of the middle sample from the chord through the first and last.
    const [dx, dy] = [last[0] - first[0], last[1] - first[1]]
    const off = Math.abs(dx * (mid[1] - first[1]) - dy * (mid[0] - first[0])) / Math.hypot(dx, dy)
    expect(off).toBeGreaterThan(0.01)
    expect(find(a.id, t)).toBeDefined()
  })

  it('treats a curved loop with equal ends as moving', async () => {
    const { ok, place, plan } = setup()
    const a = await ok('layer.create', { kind: 'shape', width: 40, height: 40, durationMs: 3000 })
    await ok('keyframes.set', {
      id: a.id,
      property: 'position',
      keys: [
        { at: 0, value: [0, 0], out: [300, -300] },
        { at: 1000, value: [0, 0], in: [-300, -300] },
      ],
    })
    const mid = place(a.id, 500)
    expect(Math.hypot(mid.x, mid.y)).toBeGreaterThan(50)
    // Where the ends meet the layer is back at the start, but still moving in between.
    expect(place(a.id, 0).x).toBeCloseTo(0, 3)
    for (const t of [250, 500, 750, 950]) {
      expect(plan(t).has(a.id), `moving at ${t}`).toBe(true)
    }
  })
})
