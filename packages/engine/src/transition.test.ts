import { type Comp, createDefaultProject, sequentialIds, Session } from '@uve/core'
import { describe, expect, it } from 'vitest'
import { transitionEnvelope } from './audio'
import type { Ctx2D } from './content'
import { buildScene, flattenScene, nodeBounds } from './scene'

const measure = {
  font: '',
  letterSpacing: '',
  textAlign: 'left',
  textBaseline: 'alphabetic',
  measureText: (text: string) => ({ width: text.length * 10 }),
} as unknown as Ctx2D

async function setup(preset: string, params: Record<string, number> = {}) {
  const ids = sequentialIds()
  const session = new Session({ project: createDefaultProject(ids), ids })
  const comp = () => session.project.comps[0] as Comp
  const call = async (name: string, input: unknown) => {
    const result = await session.call(name, input)
    if (!result.ok) throw new Error(`${name} failed: ${result.error}`)
    // biome-ignore lint/suspicious/noExplicitAny: test results are checked field by field
    return result.value as any
  }
  const a = await call('layer.create', { kind: 'shape', width: 200, height: 200, startMs: 0, durationMs: 1000 })
  const b = await call('layer.create', { kind: 'shape', width: 200, height: 200, startMs: 1000, durationMs: 1000, trackId: a.trackId })
  await call('transition.add', { ids: [a.id], preset, edge: 'out', durationMs: 400, params })
  const at = (t: number) => new Map(flattenScene(buildScene(comp(), { measure, media: [] }, t)).map((n) => [n.layer.id, n]))
  return { a: a.id as string, b: b.id as string, at, comp }
}

describe('transitions in the scene', () => {
  it('shows both sides in the window, the incoming one fading in', async () => {
    const { a, b, at } = await setup('cross-dissolve')
    const before = at(900)
    // The window runs 800–1200 ms: 100 ms before its start B shows, a quarter in.
    expect(before.get(b)?.resolved.transform.opacity).toBeCloseTo(0.25)
    expect(before.get(a)?.resolved.transform.opacity).toBeCloseTo(1)
    // A shows 100 ms past its end.
    expect(at(1100).has(a)).toBe(true)
    expect(at(1250).has(a)).toBe(false)
    expect(at(700).has(b)).toBe(false)
  })

  it('pushes the outgoing side off by the comp width', async () => {
    const { a, b, at, comp } = await setup('push')
    const mid = at(1000)
    const shift = (id: string) => {
      const box = nodeBounds(mid.get(id) as never)
      return box.left + box.width / 2
    }
    // Direction 180: B comes in from the left, A leaves to the right, half way at the cut.
    expect(shift(a)).toBeCloseTo(comp().width / 2)
    expect(shift(b)).toBeCloseTo(-comp().width / 2)
    expect(mid.get(b)?.transition).toMatchObject({ role: 'b', wipe: null })
  })

  it('crossfades the sound of the two sides', async () => {
    const { a, b, comp } = await setup('cross-dissolve')
    const layers = comp().tracks.flatMap((t) => t.layers)
    const out = transitionEnvelope(comp(), layers.find((l) => l.id === a) as never)
    const into = transitionEnvelope(comp(), layers.find((l) => l.id === b) as never)
    expect(out?.(1000)).toBeCloseTo(Math.SQRT1_2)
    expect(into?.(1000)).toBeCloseTo(Math.SQRT1_2)
    expect(out?.(500)).toBe(1)
  })
})
