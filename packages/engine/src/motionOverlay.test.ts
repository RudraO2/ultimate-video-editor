import { type Comp, createDefaultProject, type Layer, sequentialIds, Session } from '@uve/core'
import { describe, expect, it } from 'vitest'
import type { Ctx2D } from './content'
import { translate } from './math'
import { hitMotion, MOTION_HIT_RADIUS, motionOverlay, parentMatrixOf, type ScreenPoint } from './motionOverlay'
import { buildScene, flattenScene } from './scene'

const measure = {
  font: '',
  letterSpacing: '',
  textAlign: 'left',
  textBaseline: 'alphabetic',
  measureText: (text: string) => ({ width: text.length * 10 }),
} as unknown as Ctx2D

const same = (x: number, y: number): ScreenPoint => [x, y]

function setup() {
  const ids = sequentialIds()
  const session = new Session({ project: createDefaultProject(ids), ids })
  const comp = () => session.project.comps[0] as Comp
  // biome-ignore lint/suspicious/noExplicitAny: test results are checked field by field
  const ok = async (name: string, input: unknown = {}): Promise<any> => {
    const result = await session.call(name, input)
    if (!result.ok) throw new Error(`${name} failed: ${result.error}`)
    return result.value
  }
  const layer = (id: string) => comp().tracks.flatMap((t) => t.layers).find((l) => l.id === id) as Layer
  const hop = async () => {
    const a = await ok('layer.create', { kind: 'shape', width: 100, height: 100 })
    await ok('keyframes.set', {
      id: a.id,
      property: 'position',
      keys: [
        { at: 0, value: [-300, 200], arc: 250 },
        { at: 800, value: [0, 200], arc: 120 },
        { at: 1400, value: [300, 200] },
      ],
    })
    return a.id as string
  }
  return { ok, comp, layer, hop, session }
}

describe('motion overlay', () => {
  it('is null under two motion keys', async () => {
    const { ok, comp, layer } = setup()
    const a = await ok('layer.create', { kind: 'shape' })
    expect(motionOverlay(layer(a.id), comp(), same)).toBeNull()
    await ok('keyframes.set', { id: a.id, property: 'position', keys: [{ at: 0, value: [10, 20] }] })
    expect(motionOverlay(layer(a.id), comp(), same)).toBeNull()
  })

  it('draws curved segments along the curve, 33 samples each, with comp times', async () => {
    const { hop, comp, layer } = setup()
    const o = motionOverlay(layer(await hop()), comp(), same)!
    expect(o.segments).toHaveLength(2)
    const s0 = o.segments[0]!
    expect(s0.curved).toBe(true)
    expect(s0.points).toHaveLength(33)
    expect(s0.points[0]).toMatchObject({ x: -300, y: 200, timeMs: 0 })
    expect(s0.points[32]).toMatchObject({ x: 0, y: 200, timeMs: 800 })
    const mid = s0.points[16]!
    expect(mid.timeMs).toBeCloseTo(400)
    expect(mid.x).toBeCloseTo(-150)
    expect(mid.y).toBeCloseTo(-50)
    expect(o.segments[1]!.points[16]!.timeMs).toBeCloseTo(1100)
    expect(o.segments[1]!.points[16]!.y).toBeCloseTo(80)
  })

  it('draws a straight segment truly when x and y ease differently', async () => {
    const { ok, comp, layer } = setup()
    const a = await ok('layer.create', { kind: 'shape' })
    await ok('keyframes.set', { id: a.id, property: 'x', keys: [{ at: 0, value: 0, easing: 'linear' }, { at: 1000, value: 100 }] })
    await ok('keyframes.set', { id: a.id, property: 'y', keys: [{ at: 0, value: 0, easing: 'ease-in' }, { at: 1000, value: 100 }] })
    const o = motionOverlay(layer(a.id), comp(), same)!
    expect(o.segments[0]!.curved).toBe(false)
    const p = o.segments[0]!.points[16]!
    expect(p.x).toBeCloseTo(50)
    expect(p.y).toBeLessThan(45)
  })

  it('applies above and then toScreen to every position', async () => {
    const { hop, comp, layer } = setup()
    const toScreen = (x: number, y: number): ScreenPoint => [x * 2, y * 2]
    const o = motionOverlay(layer(await hop()), comp(), toScreen, { above: translate(10, 20, 0), playheadMs: 400 })!
    // key 0: (-300, 200) -> (-290, 220) -> (-580, 440)
    expect(o.keys[0]).toMatchObject({ x: -580, y: 440 })
    expect(o.segments[0]!.points[0]).toMatchObject({ x: -580, y: 440 })
    expect(o.segments[0]!.points[16]!.x).toBeCloseTo(-280)
    expect(o.segments[0]!.points[16]!.y).toBeCloseTo(-60)
    expect(o.playhead!.x).toBeCloseTo(-280)
    expect(o.playhead!.y).toBeCloseTo(-60)
    const h = o.handles[0]!
    expect(h.fromX).toBeCloseTo(-580)
    // The handle is key + vector in parent space, then mapped: x differs from the key by twice the vector.
    expect((h.x - h.fromX) / 2).toBeCloseTo(100, 5)
  })

  it('puts one chevron on every frame in the span except those near keys', async () => {
    const { hop, comp, layer } = setup()
    const o = motionOverlay(layer(await hop()), comp(), same)!
    // 30 fps over 0..1400 ms is frames 0..42; frames 0, 24 and 42 sit on keys.
    expect(comp().fps).toBe(30)
    expect(o.chevrons).toHaveLength(40)
    for (const c of o.chevrons) {
      for (const k of o.keys) expect(Math.abs(c.timeMs - k.timeMs)).toBeGreaterThanOrEqual(1000 / 30 / 2 - 1e-6)
    }
    const at = (ms: number) => o.chevrons.find((c) => Math.abs(c.timeMs - ms) < 1)!
    // Rising on the way up, level at the apex, falling on the way down (screen y is down).
    expect(at(100).angle).toBeGreaterThan(-Math.PI / 2)
    expect(at(100).angle).toBeLessThan(0)
    expect(Math.abs(at(400).angle)).toBeLessThan(0.05)
    expect(at(700).angle).toBeGreaterThan(0)
    expect(Math.abs(at(1100).angle)).toBeLessThan(0.05)
    expect(at(1300).angle).toBeGreaterThan(0)
  })

  it('caps the chevrons at 240 on a long span and points them along the travel', async () => {
    const { ok, comp, layer } = setup()
    const a = await ok('layer.create', { kind: 'shape', durationMs: 20000 })
    await ok('keyframes.set', { id: a.id, property: 'position', keys: [{ at: 0, value: [0, 0], easing: 'linear' }, { at: 20000, value: [600, 300] }] })
    const o = motionOverlay(layer(a.id), comp(), same)!
    expect(o.chevrons).toHaveLength(240)
    for (const c of o.chevrons) expect(c.angle).toBeCloseTo(Math.atan2(300, 600), 4)
    const times = o.chevrons.map((c) => c.timeMs)
    expect([...times].sort((x, y) => x - y)).toEqual(times)
  })

  it('lists keys with their smooth flag and handles only where stored', async () => {
    const { ok, comp, layer } = setup()
    const a = await ok('layer.create', { kind: 'shape' })
    await ok('keyframes.set', { id: a.id, property: 'position', keys: [{ at: 0, value: [0, 0], out: [100, 50] }, { at: 1000, value: [300, 0] }] })
    const o = motionOverlay(layer(a.id), comp(), same)!
    expect(o.keys.map((k) => [k.index, k.timeMs, k.x, k.y, k.smooth])).toEqual([
      [0, 0, 0, 0, true],
      [1, 1000, 300, 0, false],
    ])
    expect(o.handles).toEqual([{ key: 0, side: 'out', x: 100, y: 50, fromX: 0, fromY: 0 }])
    expect(o.segments[0]!.curved).toBe(true)
  })

  it('gives a playhead only inside the span', async () => {
    const { hop, comp, layer } = setup()
    const l = layer(await hop())
    expect(motionOverlay(l, comp(), same)!.playhead).toBeUndefined()
    const at = (ms: number) => motionOverlay(l, comp(), same, { playheadMs: ms })!.playhead
    expect(at(-1)).toBeUndefined()
    expect(at(1401)).toBeUndefined()
    expect(at(0)).toEqual({ x: -300, y: 200 })
    expect(at(1400)!.x).toBeCloseTo(300)
    expect(at(400)!.x).toBeCloseTo(-150)
    expect(at(400)!.y).toBeCloseTo(-50)
  })
})

describe('motion overlay hits', () => {
  async function pathAndHandle() {
    const { ok, comp, layer } = setup()
    const a = await ok('layer.create', { kind: 'shape' })
    await ok('keyframes.set', { id: a.id, property: 'position', keys: [{ at: 0, value: [0, 0], out: [100, 0] }, { at: 1000, value: [300, 0] }] })
    return motionOverlay(layer(a.id), comp(), same)!
  }

  it('prefers a handle over a key over a segment', async () => {
    const { ok, comp, layer } = setup()
    const a = await ok('layer.create', { kind: 'shape' })
    await ok('keyframes.set', { id: a.id, property: 'position', keys: [{ at: 0, value: [0, 0], out: [3, 4] }, { at: 1000, value: [300, 0] }] })
    const o = motionOverlay(layer(a.id), comp(), same)!
    // On the key: the handle (5 px away) is in reach too, and wins.
    expect(hitMotion(o, [0, 0])).toEqual({ kind: 'handle', key: 0, side: 'out' })
    // Out of the handle's reach, still on the key and the start of the curve: the key wins.
    expect(hitMotion(o, [-6, 0])).toEqual({ kind: 'key', key: 0, timeMs: 0 })
    // Only the curve is near.
    const p = o.segments[0]!.points[16]!
    expect(hitMotion(o, [p.x, p.y])).toMatchObject({ kind: 'segment', index: 0 })
    expect(hitMotion(o, [1000, 1000])).toBeNull()
  })

  it('uses the radii as inclusive edges', async () => {
    const o = await pathAndHandle()
    expect(MOTION_HIT_RADIUS).toEqual({ handle: 8, key: 9, segment: 7 })
    expect(hitMotion(o, [100, 7.9])).toEqual({ kind: 'handle', key: 0, side: 'out' })
    expect(hitMotion(o, [100, 8.1])).toBeNull()
    expect(hitMotion(o, [-8.9, 0])).toMatchObject({ kind: 'key', key: 0 })
    expect(hitMotion(o, [-9.1, 0])).toBeNull()
    expect(hitMotion(o, [150, 6.9])).toMatchObject({ kind: 'segment' })
    expect(hitMotion(o, [150, 7.1])).toBeNull()
  })

  it('reports the time and curve parameter of a segment hit', async () => {
    const { hop, comp, layer } = setup()
    const o = motionOverlay(layer(await hop()), comp(), same)!
    const hit = hitMotion(o, [-150, -50])
    expect(hit).toMatchObject({ kind: 'segment', index: 0 })
    if (hit?.kind !== 'segment') return
    expect(hit.timeMs).toBeCloseTo(400, 3)
    expect(hit.u).toBeCloseTo(0.5, 3)
    const late = hitMotion(o, [150, 80])
    expect(late).toMatchObject({ kind: 'segment', index: 1 })
    if (late?.kind !== 'segment') return
    expect(late.timeMs).toBeCloseTo(1100, 3)
  })
})

describe('parentMatrixOf', () => {
  it('finds the matrix above a layer, through groups', async () => {
    const { ok, comp } = setup()
    const a = await ok('layer.create', { kind: 'shape', width: 100, height: 100, x: -100 })
    const b = await ok('layer.create', { kind: 'shape', width: 100, height: 100, x: 100 })
    const { groupId } = await ok('layers.group', { ids: [a.id] })
    await ok('layer.set', { id: groupId, values: { x: 30, rotation: 90 } })
    const scene = buildScene(comp(), { measure, media: [] }, 0)
    const nodes = flattenScene(scene)
    const node = nodes.find((n) => n.layer.id === a.id)!
    const found = parentMatrixOf(scene, a.id)!
    expect(found).toEqual(node.above)
    expect(found).not.toEqual(translate(0, 0, 0))
    expect(parentMatrixOf(scene, groupId)).toEqual(nodes.find((n) => n.layer.id === groupId)!.above)
    expect(parentMatrixOf(scene, b.id)).toEqual(nodes.find((n) => n.layer.id === b.id)!.above)
    expect(parentMatrixOf(scene, 'nope')).toBeUndefined()
  })
})
