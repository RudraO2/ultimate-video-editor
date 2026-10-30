import { describe, expect, it } from 'vitest'
import { createDefaultProject } from './doc'
import { sequentialIds } from './ids'
import { evaluateProperty, resolveProperty } from './properties'
import type { Keyframe, Layer } from './schema'
import { Session } from './session'

// keyframes.set with arc, in and out; keyframes.inspect showing the handles.

function setup() {
  const ids = sequentialIds()
  const session = new Session({ project: createDefaultProject(ids), ids, view: () => ({}) })
  // biome-ignore lint/suspicious/noExplicitAny: test results are checked field by field
  const ok = async (name: string, input: unknown = {}): Promise<any> => {
    const result = await session.call(name, input)
    if (!result.ok) throw new Error(`${name} failed: ${result.error}`)
    return result.value
  }
  /** The failure text, and proof the project did not change. */
  const fail = async (name: string, input: unknown) => {
    const before = JSON.stringify(session.project)
    const result = await session.call(name, input)
    if (result.ok) throw new Error(`${name} should have failed`)
    expect(JSON.stringify(session.project)).toBe(before)
    return `${result.error} ${result.hint ?? ''}`
  }
  const layer = () => session.project.comps[0]?.tracks.flatMap((t) => t.layers).find((l) => l.id === 'layer_1') as Layer
  const xs = () => layer().animations['transform.x'] as Keyframe[]
  const ys = () => layer().animations['transform.y'] as Keyframe[]
  return { session, ok, fail, layer, xs, ys }
}

async function shape(extra: Record<string, unknown> = {}) {
  const s = setup()
  await s.ok('layer.create', { kind: 'shape', ...extra })
  return s
}

const A_TO_B = (first: Record<string, unknown>, second: Record<string, unknown> = {}) => [
  { at: 0, value: [0, 0], ...first },
  { at: 1000, value: [300, 0], ...second },
]

describe('keyframes.set arc', () => {
  it('throws the hop: handles on both ends, linear easing, y follows the curve', async () => {
    const s = await shape()
    const result = await s.ok('keyframes.set', { id: 'layer_1', property: 'position', keys: A_TO_B({ arc: 100 }) })
    expect(result.curved).toBe(2)
    expect(s.xs()[0]?.spatial?.in).toBeNull()
    expect(s.xs()[0]?.spatial?.out?.[0]).toBeCloseTo(100, 6)
    expect(s.xs()[0]?.spatial?.out?.[1]).toBeCloseTo(-400 / 3, 6)
    expect(s.xs()[1]?.spatial?.in?.[0]).toBeCloseTo(-100, 6)
    expect(s.xs()[1]?.spatial?.in?.[1]).toBeCloseTo(-400 / 3, 6)
    expect(s.xs()[1]?.spatial?.out).toBeNull()
    expect(s.xs()[0]?.ease).toBe('linear')
    expect(s.ys()[0]?.ease).toBe('linear')
    const spec = (name: string) => resolveProperty(s.layer(), name)[0] as NonNullable<ReturnType<typeof resolveProperty>[0]>
    expect(evaluateProperty(s.layer(), spec('y'), 500)).toBeCloseTo(-100, 6)
    expect(evaluateProperty(s.layer(), spec('x'), 500)).toBeCloseTo(150, 6)
  })

  it('keeps an explicit easing', async () => {
    const s = await shape()
    await s.ok('keyframes.set', { id: 'layer_1', property: 'position', keys: A_TO_B({ arc: 100, easing: 'ease-out' }) })
    expect(s.xs()[0]?.ease).toBe('ease-out')
    expect(s.ys()[0]?.ease).toBe('ease-out')
  })

  it('sags for a negative arc', async () => {
    const s = await shape()
    await s.ok('keyframes.set', { id: 'layer_1', property: 'position', keys: A_TO_B({ arc: -50 }) })
    expect(s.xs()[0]?.spatial?.out?.[1]).toBeCloseTo(200 / 3, 6)
    const y = resolveProperty(s.layer(), 'y')[0] as NonNullable<ReturnType<typeof resolveProperty>[0]>
    expect(evaluateProperty(s.layer(), y, 500)).toBeCloseTo(50, 6)
  })

  it('wins over an out on the same key', async () => {
    const s = await shape()
    await s.ok('keyframes.set', { id: 'layer_1', property: 'position', keys: A_TO_B({ arc: 100, out: [5, 5] }) })
    expect(s.xs()[0]?.spatial?.out?.[0]).toBeCloseTo(100, 6)
  })

  it('refuses an arc and the next key in handle, and leaves nothing behind', async () => {
    const s = await shape()
    const text = await s.fail('keyframes.set', { id: 'layer_1', property: 'position', keys: A_TO_B({ arc: 100 }, { in: [-10, 0] }) })
    expect(text).toContain('One curve per segment: keep the arc or the handle.')
    expect(text).toContain('0 ms')
    expect(text).toContain('1000 ms')
    expect(s.layer().animations['transform.x']).toBeUndefined()
  })

  it('refuses an arc on the last key', async () => {
    const s = await shape()
    const text = await s.fail('keyframes.set', { id: 'layer_1', property: 'position', keys: A_TO_B({}, { arc: 50 }) })
    expect(text).toContain('arc shapes the segment leaving the key at 1000 ms; there is no later position key.')
  })

  it('reaches an existing next key when merging', async () => {
    const s = await shape()
    await s.ok('keyframes.set', { id: 'layer_1', property: 'position', keys: A_TO_B({}) })
    await s.ok('keyframes.set', { id: 'layer_1', property: 'position', mode: 'merge', keys: [{ at: 0, value: [0, 0], arc: 100 }] })
    expect(s.xs()[0]?.spatial?.out?.[0]).toBeCloseTo(100, 6)
    expect(s.xs()[1]?.spatial?.in?.[0]).toBeCloseTo(-100, 6)
    expect(s.xs()[0]?.ease).toBe('linear')
  })

  it('on one axis adds the other where the layer is', async () => {
    const s = await shape()
    await s.ok('keyframes.set', { id: 'layer_1', property: 'x', keys: [{ at: 0, value: 0, arc: 100 }, { at: 1000, value: 300 }] })
    expect(s.ys().map((k) => k.t)).toEqual([0, 1000])
    expect(s.ys()[0]?.ease).toBe('linear')
    expect(s.xs()[0]?.spatial?.out).toBeTruthy()
    expect(s.xs()[1]?.spatial?.in).toBeTruthy()
  })

  it('uses the comp clock', async () => {
    const s = await shape({ startMs: 500 })
    await s.ok('keyframes.set', { id: 'layer_1', property: 'position', clock: 'comp', keys: [{ at: 500, value: [0, 0], arc: 100 }, { at: 1500, value: [300, 0] }] })
    expect(s.xs().map((k) => k.t)).toEqual([0, 1000])
    expect(s.xs()[0]?.spatial?.out?.[0]).toBeCloseTo(100, 6)
    const text = await s.fail('keyframes.set', { id: 'layer_1', property: 'position', clock: 'comp', keys: [{ at: 500, value: [0, 0] }, { at: 1500, value: [1, 0], arc: 5 }] })
    expect(text).toContain('key at 1500 ms')
  })

  it('takes arc, in and out on our {t, v} key shape too', async () => {
    const s = await shape()
    await s.ok('keyframes.set', { id: 'layer_1', path: 'position', keys: [{ t: 0, v: [0, 0], arc: 100 }, { t: 1000, v: [300, 0] }] })
    expect(s.xs()[0]?.spatial?.out?.[1]).toBeCloseTo(-400 / 3, 6)
    expect(s.xs()[0]?.ease).toBe('linear')
    await s.ok('keyframes.set', { id: 'layer_1', path: 'position', keys: [{ t: 0, v: [0, 0], out: [10, -20] }, { t: 1000, v: [300, 0] }] })
    expect(s.xs()[0]?.spatial?.out).toEqual([10, -20])
    const text = await s.fail('keyframes.set', {
      id: 'layer_1',
      path: 'position',
      keys: [{ t: 0, v: [0, 0], spatial: { in: null, out: [1, 1] }, out: [2, 2] }, { t: 1000, v: [300, 0] }],
    })
    expect(text).toContain('spatial or in/out, not both')
  })
})

describe('keyframes.set in and out', () => {
  it('refuses them off position, and on part of a text', async () => {
    const s = await shape()
    const rule = '`arc`, `in` and `out` shape a motion path.'
    expect(await s.fail('keyframes.set', { id: 'layer_1', property: 'opacity', keys: [{ at: 0, value: 1, in: [1, 1] }] })).toContain(rule)
    expect(await s.fail('keyframes.set', { id: 'layer_1', property: 'opacity', keys: [{ at: 0, value: 1, arc: 10 }] })).toContain(rule)
    expect(await s.fail('keyframes.set', { id: 'layer_1', path: 'scale', keys: [{ t: 0, v: 1, spatial: { out: [1, 1] } }] })).toContain(rule)
    await s.ok('layer.create', { kind: 'text', text: 'Hi' })
    expect(
      await s.fail('keyframes.set', { id: 'layer_2', property: 'opacity', range: { start: 0, end: 1 }, keys: [{ at: 0, value: 1, out: [1, 1] }] }),
    ).toContain(rule)
    // A null says "no handle": harmless anywhere.
    await s.ok('keyframes.set', { id: 'layer_1', property: 'opacity', keys: [{ at: 0, value: 1, in: null, out: null }] })
  })

  it("takes AtomCut's in and out and our spatial", async () => {
    const s = await shape()
    await s.ok('keyframes.set', { id: 'layer_1', property: 'position', keys: A_TO_B({ out: [50, 0] }, { in: [-50, 20] }) })
    expect(s.xs()[0]?.spatial).toEqual({ in: null, out: [50, 0] })
    expect(s.xs()[1]?.spatial).toEqual({ in: [-50, 20], out: null })

    await s.ok('keyframes.set', {
      id: 'layer_1',
      path: 'position',
      keys: [
        { t: 0, v: [0, 0], ease: 'linear', spatial: { out: [10, 10] } },
        { t: 1000, v: [300, 0], spatial: { in: [-10, 10], out: [7, 7] } },
      ],
    })
    expect(s.xs()[0]?.spatial).toEqual({ in: null, out: [10, 10] })
    expect(s.xs()[1]?.spatial).toEqual({ in: [-10, 10], out: [7, 7] })
  })

  it('merges side by side: null clears one, a missing side stays', async () => {
    const s = await shape()
    await s.ok('keyframes.set', { id: 'layer_1', property: 'position', keys: A_TO_B({}, { in: [-50, 20], out: [10, 10] }) })
    await s.ok('keyframes.set', { id: 'layer_1', property: 'position', mode: 'merge', keys: [{ at: 1000, value: [300, 0], in: null }] })
    expect(s.xs()[1]?.spatial).toEqual({ in: null, out: [10, 10] })
    await s.ok('keyframes.set', { id: 'layer_1', property: 'position', mode: 'merge', keys: [{ at: 1000, value: [300, 0], in: [-1, -2] }] })
    expect(s.xs()[1]?.spatial).toEqual({ in: [-1, -2], out: [10, 10] })
    // A key with no handle fields keeps its handles; clearing the last side drops them all.
    await s.ok('keyframes.set', { id: 'layer_1', property: 'position', mode: 'merge', keys: [{ at: 1000, value: [310, 0] }] })
    expect(s.xs()[1]?.spatial).toEqual({ in: [-1, -2], out: [10, 10] })
    await s.ok('keyframes.set', { id: 'layer_1', property: 'position', mode: 'merge', keys: [{ at: 1000, value: [310, 0], in: null, out: null }] })
    expect(s.xs()[1]?.spatial).toBeUndefined()
  })

  it('adds the other axis at its value when only x has a key there', async () => {
    const s = await shape()
    await s.ok('keyframes.set', { id: 'layer_1', property: 'position', keys: [{ t: 0, v: [0, 20], ease: 'linear' }, { t: 1000, v: [300, 60], ease: 'linear' }] })
    const result = await s.ok('keyframes.set', { id: 'layer_1', property: 'x', mode: 'merge', keys: [{ at: 500, value: 100, out: [10, 0] }] })
    expect(result.curved).toBe(1)
    expect(s.ys().map((k) => k.t)).toEqual([0, 500, 1000])
    expect(s.ys()[1]?.v).toBeCloseTo(40, 6)
    expect(s.xs()[1]?.spatial?.out).toEqual([10, 0])
  })

  it('puts the handles of a y key on the x key it adds', async () => {
    const s = await shape()
    await s.ok('keyframes.set', { id: 'layer_1', property: 'position', keys: [{ t: 0, v: [0, 20], ease: 'linear' }, { t: 1000, v: [300, 60], ease: 'linear' }] })
    await s.ok('keyframes.set', { id: 'layer_1', property: 'y', mode: 'merge', keys: [{ at: 250, value: 5, out: [1, 1] }] })
    expect(s.xs().map((k) => k.t)).toEqual([0, 250, 1000])
    expect(s.xs()[1]?.v).toBeCloseTo(75, 6)
    expect(s.xs()[1]?.spatial?.out).toEqual([1, 1])
  })

  it('drops the old handles in replace mode', async () => {
    const s = await shape()
    await s.ok('keyframes.set', { id: 'layer_1', property: 'position', keys: A_TO_B({ arc: 100 }) })
    const result = await s.ok('keyframes.set', { id: 'layer_1', property: 'position', keys: A_TO_B({}) })
    expect(result.curved).toBeUndefined()
    expect(s.xs().every((k) => k.spatial === undefined)).toBe(true)
    await s.ok('keyframes.set', { id: 'layer_1', property: 'position', keys: A_TO_B({ arc: 100 }) })
    await s.ok('keyframes.set', { id: 'layer_1', property: 'x', keys: [{ at: 0, value: 0 }, { at: 1000, value: 300 }] })
    expect(s.xs().every((k) => k.spatial === undefined)).toBe(true)
  })
})

describe('keyframes.inspect on curved keys', () => {
  it('prints ↷ with the handles to 0.1 px', async () => {
    const s = await shape()
    await s.ok('keyframes.set', { id: 'layer_1', property: 'position', keys: A_TO_B({ arc: 100 }) })
    const x = (await s.ok('keyframes.inspect', { id: 'layer_1', properties: ['x'] })).tracks[0]
    expect(x.line).toBe('0 0 ↷(out 100,-133.3) linear · 1000 300 ↷(in -100,-133.3)')

    await s.ok('keyframes.set', { id: 'layer_1', property: 'position', keys: A_TO_B({ out: [100.04, -133.36], easing: 'linear' }, { in: [-100.26, -3], out: [0, 8] }) })
    const both = (await s.ok('keyframes.inspect', { id: 'layer_1', properties: ['x'] })).tracks[0]
    expect(both.line).toBe('0 0 ↷(out 100,-133.4) linear · 1000 300 ↷(out 0,8 in -100.3,-3)')
    const y = (await s.ok('keyframes.inspect', { id: 'layer_1', properties: ['y'] })).tracks[0]
    expect(y.line).not.toContain('↷')
  })

  it('counts curved keys per layer and across the comp', async () => {
    const s = await shape()
    const comp = s.session.project.comps[0]?.id
    expect((await s.ok('keyframes.inspect', { compId: comp })).curvedKeys).toBe(0)
    await s.ok('keyframes.set', { id: 'layer_1', property: 'position', keys: A_TO_B({ arc: 100 }) })
    expect((await s.ok('keyframes.inspect', { id: 'layer_1' })).curvedKeys).toBe(2)
    expect((await s.ok('keyframes.inspect', { compId: comp })).curvedKeys).toBe(2)
    await s.ok('layer.create', { kind: 'shape' })
    await s.ok('keyframes.set', { id: 'layer_2', property: 'position', keys: A_TO_B({ out: [5, 5] }) })
    expect((await s.ok('keyframes.inspect', { compId: comp })).curvedKeys).toBe(3)
    expect((await s.ok('keyframes.inspect', { id: 'layer_2' })).curvedKeys).toBe(1)
    await s.ok('keyframes.clear', { id: 'layer_2', path: 'position', atMs: 0 })
    expect((await s.ok('keyframes.inspect', { id: 'layer_2' })).curvedKeys).toBeUndefined()
  })
})
