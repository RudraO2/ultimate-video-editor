import { describe, expect, it } from 'vitest'
import { deepClone } from './clone'
import { createDefaultProject } from './doc'
import { sequentialIds } from './ids'
import { arcHandles, bezierPoint, motionKeysOf, motionPointAt, segmentOf, smoothTangents } from './motionPath'
import { evaluateProperty, resolveProperty } from './properties'
import type { Keyframe, Layer, Project } from './schema'
import { Session } from './session'

function setup() {
  const ids = sequentialIds()
  const session = new Session({ project: createDefaultProject(ids), ids, view: () => ({}) })
  // biome-ignore lint/suspicious/noExplicitAny: test results are checked field by field
  const ok = async (name: string, input: unknown = {}): Promise<any> => {
    const result = await session.call(name, input)
    if (!result.ok) throw new Error(`${name} failed: ${result.error}`)
    return result.value
  }
  const fail = async (name: string, input: unknown) => {
    const result = await session.call(name, input)
    if (result.ok) throw new Error(`${name} should have failed`)
    return result as { ok: false; error: string; hint?: string }
  }
  const layer = () => session.project.comps[0]?.tracks.flatMap((t) => t.layers).find((l) => l.id === 'layer_1') as Layer
  const edit = async (change: (layer: Layer) => void) => {
    const project = deepClone(session.project) as Project
    change(project.comps[0]?.tracks.flatMap((t) => t.layers).find((l) => l.id === 'layer_1') as Layer)
    await session.replace(project)
  }
  const motion = (input: Record<string, unknown>) => ok('motion.edit', { id: 'layer_1', ...input })
  return { session, ok, fail, layer, edit, motion }
}

type Rig = ReturnType<typeof setup>

/** A shape keyed at the given [t, x, y] stops with one easing. */
async function path(stops: [number, number, number][], easing = 'linear'): Promise<Rig> {
  const s = setup()
  await s.ok('layer.create', { kind: 'shape' })
  await s.ok('keyframes.set', { id: 'layer_1', path: 'position', keys: stops.map(([t, x, y]) => ({ t, v: [x, y], ease: easing })) })
  return s
}

/** The x and y of the layer at layer time `t`, as the renderer samples them. */
function sample(layer: Layer, t: number): [number, number] {
  const at = (name: string) => evaluateProperty(layer, resolveProperty(layer, name)[0]!, t) as number
  return [at('x'), at('y')]
}

const times = Array.from({ length: 41 }, (_, i) => i * 25)

function expectSameMotion(before: Layer, after: Layer) {
  for (const t of times) {
    const [bx, by] = sample(before, t)
    const [ax, ay] = sample(after, t)
    expect(Math.abs(ax - bx), `x at ${t}`).toBeLessThan(1e-3)
    expect(Math.abs(ay - by), `y at ${t}`).toBeLessThan(1e-3)
  }
}

/** Arc handles on the first segment of a two-key path. */
async function arced(easing = 'linear') {
  const s = await path(
    [
      [0, 0, 0],
      [1000, 300, 0],
    ],
    easing,
  )
  const { out, in: arrive } = arcHandles([0, 0], [300, 0], 100)
  await s.edit((layer) => {
    const xs = layer.animations['transform.x'] as Keyframe[]
    ;(xs[0] as Keyframe).spatial = { in: null, out }
    ;(xs[1] as Keyframe).spatial = { in: arrive, out: null }
  })
  return s
}

const three = () =>
  path([
    [0, 0, 0],
    [500, 200, 100],
    [1000, 400, 0],
  ])

describe('motion.edit move', () => {
  it('moves both axes of a point and keeps its handles and easing', async () => {
    const s = await arced('ease-in-out')
    const before = s.layer().animations['transform.x']?.[1]
    const result = await s.motion({ op: 'move', atMs: 1000, value: [400, 50] })
    expect(result).toEqual({ id: 'layer_1', op: 'move', atMs: 1000, motionKeys: 2 })
    expect(motionKeysOf(s.layer())[1]).toMatchObject({ x: 400, y: 50, in: before?.spatial?.in, ease: before?.ease })
    expect(s.layer().animations['transform.y']?.[1]?.v).toBe(50)
  })

  it('reads atMs as comp time', async () => {
    const s = await three()
    await s.edit((layer) => {
      layer.startMs = 200
    })
    await s.motion({ op: 'move', atMs: 700, value: [5, 6] })
    expect(motionKeysOf(s.layer())[1]).toMatchObject({ t: 500, x: 5, y: 6 })
  })
})

describe('motion.edit insert', () => {
  it('keeps a curved segment exactly, with an ease-in-out timing', async () => {
    const s = await arced('ease-in-out')
    const before = deepClone(s.layer()) as Layer
    const result = await s.motion({ op: 'insert', atMs: 400 })
    expect(result.motionKeys).toBe(3)
    expect(result.point).toHaveLength(2)
    expect(motionKeysOf(s.layer()).map((k) => k.t)).toEqual([0, 400, 1000])
    expect(motionKeysOf(s.layer())[1]?.in).not.toBeNull()
    expectSameMotion(before, s.layer())
    // A second insert into the first half, then into the second.
    const mid = deepClone(s.layer()) as Layer
    await s.motion({ op: 'insert', atMs: 150 })
    await s.motion({ op: 'insert', atMs: 800 })
    expect(motionKeysOf(s.layer())).toHaveLength(5)
    expectSameMotion(mid, s.layer())
  })

  it('keeps a curved segment that has one handle only', async () => {
    const s = await arced('ease-out')
    await s.edit((layer) => {
      ;(layer.animations['transform.x'] as Keyframe[])[1]!.spatial = undefined
    })
    const before = deepClone(s.layer()) as Layer
    await s.motion({ op: 'insert', atMs: 600 })
    expectSameMotion(before, s.layer())
  })

  it('keeps a straight segment and its timing, with no handles', async () => {
    const s = await path(
      [
        [0, 0, 0],
        [1000, 300, 60],
      ],
      'ease-in-out',
    )
    const before = deepClone(s.layer()) as Layer
    const result = await s.motion({ op: 'insert', atMs: 300 })
    expect(result.point[0]).toBeCloseTo(sample(before, 300)[0], 6)
    expect(s.layer().animations['transform.x']?.every((k) => k.spatial === undefined)).toBe(true)
    expectSameMotion(before, s.layer())
  })

  it('keeps timing when the two axes ease differently', async () => {
    const s = await path([
      [0, 0, 0],
      [1000, 300, 60],
    ])
    await s.ok('keyframes.set', { id: 'layer_1', path: 'y', keys: [{ t: 0, v: 0, ease: 'ease-out-back' }, { t: 1000, v: 60 }] })
    const before = deepClone(s.layer()) as Layer
    await s.motion({ op: 'insert', atMs: 700 })
    expectSameMotion(before, s.layer())
  })

  it('refuses at a key, outside the path and for stray fields', async () => {
    const s = await three()
    expect((await s.fail('motion.edit', { id: 'layer_1', op: 'insert', atMs: 500 })).error).toBe('Rectangle already has a motion key at 500 ms.')
    const out = await s.fail('motion.edit', { id: 'layer_1', op: 'insert', atMs: 1500 })
    expect(out.hint).toContain('Motion keys at 0, 500, 1000 ms (comp time).')
    expect((await s.fail('motion.edit', { id: 'layer_1', op: 'insert', atMs: 250, u: 0.5 })).error).toBe('u does not apply to op "insert".')
  })
})

describe('motion.edit delete', () => {
  it('removes the middle point and keeps the neighbours handles', async () => {
    const s = await three()
    await s.motion({ op: 'handle', atMs: 0, side: 'out', value: [30, 0] })
    await s.motion({ op: 'smooth', atMs: 500 })
    const result = await s.motion({ op: 'delete', atMs: 500 })
    expect(result.motionKeys).toBe(2)
    expect(motionKeysOf(s.layer()).map((k) => [k.t, k.x, k.y])).toEqual([
      [0, 0, 0],
      [1000, 400, 0],
    ])
    expect(motionKeysOf(s.layer())[0]?.out).toEqual([30, 0])
    expect(s.layer().animations['transform.y']).toHaveLength(2)
  })
})

describe('motion.edit smooth and corner', () => {
  it('gives a middle key flowing handles', async () => {
    const s = await three()
    await s.motion({ op: 'smooth', atMs: 500 })
    const expected = smoothTangents([0, 0], [200, 100], [400, 0])
    expect(motionKeysOf(s.layer())[1]).toMatchObject({ in: expected.in, out: expected.out })
    expect(motionPointAt(s.layer(), 250)).toBeDefined()
  })

  it('gives the first key no in and the last no out', async () => {
    const s = await three()
    await s.motion({ op: 'smooth', atMs: 0 })
    await s.motion({ op: 'smooth', atMs: 1000 })
    const rows = motionKeysOf(s.layer())
    expect(rows[0]?.in).toBeNull()
    expect(rows[0]?.out).not.toBeNull()
    expect(rows[2]?.out).toBeNull()
    expect(rows[2]?.in).not.toBeNull()
  })

  it('corner removes the handles', async () => {
    const s = await three()
    await s.motion({ op: 'smooth', atMs: 500 })
    await s.motion({ op: 'corner', atMs: 500 })
    expect(s.layer().animations['transform.x']?.[1]?.spatial).toBeUndefined()
    expect(motionKeysOf(s.layer())[1]).toMatchObject({ in: null, out: null })
  })
})

describe('motion.edit bend', () => {
  it('makes the curve pass through the point', async () => {
    const s = await three()
    await s.motion({ op: 'bend', atMs: 0, u: 0.5, point: [80, 120] })
    const [a, b] = motionKeysOf(s.layer())
    const through = bezierPoint(segmentOf(a!, b!), 0.5)
    expect(through[0]).toBeCloseTo(80, 6)
    expect(through[1]).toBeCloseTo(120, 6)
    // Linear easing: halfway in time is u 0.5.
    const [x, y] = sample(s.layer(), 250)
    expect([x, y]).toEqual([expect.closeTo(80, 6), expect.closeTo(120, 6)])
  })

  it('bends the segment that contains a time between keys', async () => {
    const s = await three()
    await s.motion({ op: 'bend', atMs: 700, u: 0.5, point: [330, 90] })
    const [, b, c] = motionKeysOf(s.layer())
    expect(b?.out).not.toBeNull()
    expect(c?.in).not.toBeNull()
  })

  it('refuses a bad u and a segment that is not there', async () => {
    const s = await three()
    expect((await s.fail('motion.edit', { id: 'layer_1', op: 'bend', atMs: 0, u: 1, point: [1, 1] })).error).toContain('u must be between 0 and 1')
    expect((await s.fail('motion.edit', { id: 'layer_1', op: 'bend', atMs: 1000, u: 0.5, point: [1, 1] })).hint).toContain('Motion keys at 0, 500, 1000 ms (comp time).')
    expect((await s.fail('motion.edit', { id: 'layer_1', op: 'bend', atMs: 2000, u: 0.5, point: [1, 1] })).hint).toContain('Motion keys at')
  })
})

describe('motion.edit handle', () => {
  it('sets one side, mirrors the other and clears both with null', async () => {
    const s = await three()
    await s.motion({ op: 'handle', atMs: 500, side: 'out', value: [40, 10] })
    expect(motionKeysOf(s.layer())[1]).toMatchObject({ in: null, out: [40, 10] })
    await s.motion({ op: 'handle', atMs: 500, side: 'out', value: [40, 10], mirror: true })
    expect(motionKeysOf(s.layer())[1]).toMatchObject({ in: [-40, -10], out: [40, 10] })
    await s.motion({ op: 'handle', atMs: 500, side: 'in', value: null })
    expect(motionKeysOf(s.layer())[1]).toMatchObject({ in: null, out: [40, 10] })
    await s.motion({ op: 'handle', atMs: 500, side: 'out', value: null, mirror: true })
    expect(s.layer().animations['transform.x']?.[1]?.spatial).toBeUndefined()
  })

  it('skips the mirror side that faces nothing at an end key', async () => {
    const s = await three()
    await s.motion({ op: 'handle', atMs: 0, side: 'out', value: [20, 5], mirror: true })
    expect(motionKeysOf(s.layer())[0]).toMatchObject({ in: null, out: [20, 5] })
  })

  it('refuses in on the first key and out on the last', async () => {
    const s = await three()
    expect((await s.fail('motion.edit', { id: 'layer_1', op: 'handle', atMs: 0, side: 'in', value: [1, 1] })).error).toBe('The first motion key has no segment before it.')
    expect((await s.fail('motion.edit', { id: 'layer_1', op: 'handle', atMs: 1000, side: 'out', value: [1, 1] })).error).toBe('The last motion key has no segment after it.')
  })
})

describe('motion.edit refusals', () => {
  it('refuses a layer without a motion path', async () => {
    const s = setup()
    await s.ok('layer.create', { kind: 'shape' })
    const result = await s.fail('motion.edit', { id: 'layer_1', op: 'delete', atMs: 0 })
    expect(result.error).toBe('Rectangle has no motion path.')
    expect(result.hint).toBe('Key position at two times or more: keyframes.set property "position" with keys [x, y].')
    await s.ok('keyframes.set', { id: 'layer_1', path: 'x', keys: [{ t: 0, v: 0 }, { t: 100, v: 5 }] })
    expect((await s.fail('motion.edit', { id: 'layer_1', op: 'smooth', atMs: 0 })).error).toBe('Rectangle has no motion path.')
  })

  it('names the times when no motion key is there', async () => {
    const s = await three()
    const result = await s.fail('motion.edit', { id: 'layer_1', op: 'move', atMs: 250, value: [1, 1] })
    expect(result.error).toBe('Rectangle has no motion key at 250 ms.')
    expect(result.hint).toBe('Motion keys at 0, 500, 1000 ms (comp time).')
  })

  it('names a missing or extra field', async () => {
    const s = await three()
    expect((await s.fail('motion.edit', { id: 'layer_1', op: 'move', atMs: 0 })).error).toBe('op "move" needs value.')
    expect((await s.fail('motion.edit', { id: 'layer_1', op: 'move', atMs: 0, value: null })).error).toContain('needs value [x, y]')
    expect((await s.fail('motion.edit', { id: 'layer_1', op: 'bend', atMs: 0, point: [1, 1] })).error).toBe('op "bend" needs u.')
    expect((await s.fail('motion.edit', { id: 'layer_1', op: 'handle', atMs: 500, value: [1, 1] })).error).toBe('op "handle" needs side.')
    expect((await s.fail('motion.edit', { id: 'layer_1', op: 'handle', atMs: 500, side: 'out' })).error).toBe('op "handle" needs value.')
    expect((await s.fail('motion.edit', { id: 'layer_1', op: 'corner', atMs: 500, side: 'in' })).error).toBe('side does not apply to op "corner".')
    expect((await s.fail('motion.edit', { id: 'layer_1', op: 'move', atMs: 0, value: [1, 1], mirror: true })).error).toBe('mirror does not apply to op "move".')
  })

  it('leaves the project unchanged when a call fails', async () => {
    const s = await arced('ease-in-out')
    const before = JSON.stringify(s.session.project)
    await s.fail('motion.edit', { id: 'layer_1', op: 'move', atMs: 333, value: [1, 1] })
    await s.fail('motion.edit', { id: 'layer_1', op: 'handle', atMs: 0, side: 'in', value: [1, 1] })
    await s.fail('motion.edit', { id: 'layer_1', op: 'insert', atMs: 1000 })
    await s.fail('motion.edit', { id: 'layer_1', op: 'bend', atMs: 0, u: 2, point: [0, 0] })
    expect(JSON.stringify(s.session.project)).toBe(before)
  })

  it('is one undo step per call, with its label', async () => {
    const s = await three()
    await s.motion({ op: 'smooth', atMs: 500 })
    expect(s.session.undoLabel).toBe('Smooth motion point')
    await s.motion({ op: 'insert', atMs: 250 })
    expect(s.session.undoLabel).toBe('Insert motion point')
    expect(s.session.undo()).toBe(true)
    expect(motionKeysOf(s.layer())).toHaveLength(3)
  })
})
