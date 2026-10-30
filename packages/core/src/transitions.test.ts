import { describe, expect, it } from 'vitest'
import { createDefaultProject } from './doc'
import { sequentialIds } from './ids'
import type { Comp, Track } from './schema'
import { Session } from './session'
import { TRANSITION_PRESETS, transitionGains, transitionSides, transitionWindows } from './transitions'

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
    return `${result.error}\n${result.hint ?? ''}`
  }
  const comp = () => session.project.comps[0] as Comp
  const trackOf = (id: string) => comp().tracks.find((t) => t.layers.some((l) => l.id === id)) as Track
  /** Two shapes back to back on one lane: A 0–1000, B 1000–2000. */
  const pair = async () => {
    const a = await ok('layer.create', { kind: 'shape', startMs: 0, durationMs: 1000 })
    const b = await ok('layer.create', { kind: 'shape', startMs: 1000, durationMs: 1000, trackId: a.trackId })
    return { a: a.id as string, b: b.id as string }
  }
  return { session, ok, fail, comp, trackOf, pair }
}

describe('transitions', () => {
  it("has AtomCut's 23 presets, every pose at rest or gone at the ends", () => {
    expect(TRANSITION_PRESETS).toHaveLength(23)
    for (const preset of TRANSITION_PRESETS) {
      const start = preset.mix(0, {})
      const end = preset.mix(1, {})
      // At the start A is fully there; at the end B is.
      if (!start.wipe) expect(start.a.opacity, preset.id).toBeCloseTo(1)
      if (!end.wipe) expect(end.b.opacity, preset.id).toBeCloseTo(1)
      expect(end.b.dx, preset.id).toBeCloseTo(0)
      expect(end.b.scale, preset.id).toBeCloseTo(1)
      expect(end.veil, preset.id).toBeCloseTo(0)
    }
  })

  it('puts one transition on a shared cut, centred on it', async () => {
    const { ok, pair, trackOf } = setup()
    const { a, b } = await pair()
    const result = await ok('transition.add', { ids: [a, b], preset: 'cross-dissolve', edge: 'any' })
    // A's tail and B's head are one seam; A's head and B's tail are lone edges.
    const seam = result.transitions.find((t: { kind: string }) => t.kind === 'seam')
    expect(seam).toMatchObject({ aLayerId: a, bLayerId: b, durationMs: 600, splitMs: 300, startMs: 700, endMs: 1300 })
    expect(result.transitions.map((t: { kind: string }) => t.kind).sort()).toEqual(['head', 'seam', 'tail'])
    expect(trackOf(a).transitions).toHaveLength(3)
    // Adding on the same cut replaces it.
    await ok('transition.add', { ids: [a], preset: 'push', edge: 'out' })
    const track = trackOf(a)
    expect(track.transitions).toHaveLength(3)
    expect(track.transitions.find((t) => t.aLayerId === a && t.bLayerId === b)?.preset).toBe('push')
  })

  it('poses both sides inside the window, holding A past its end and B before its start', async () => {
    const { ok, pair, trackOf } = setup()
    const { a, b } = await pair()
    await ok('transition.add', { ids: [a], preset: 'cross-dissolve', edge: 'out', durationMs: 400 })
    const at = (t: number) => transitionSides(trackOf(a), t)
    expect(at(700).size).toBe(0)
    const mid = at(1000)
    expect(mid.get(b)?.pose.opacity).toBeCloseTo(0.5)
    expect(mid.get(a)?.drawAtMs).toBeCloseTo(999)
    expect(at(850).get(b)?.drawAtMs).toBe(1000)
    expect(at(1199).get(b)?.pose.opacity).toBeGreaterThan(0.99)
  })

  it('fits the duration to the layers and checks knobs and colour', async () => {
    const { ok, fail, comp } = setup()
    const a = await ok('layer.create', { kind: 'shape', startMs: 0, durationMs: 200 })
    const r = await ok('transition.add', { ids: [a.id], preset: 'fade', edge: 'in', durationMs: 900 })
    expect(r.transitions[0]).toMatchObject({ kind: 'head', durationMs: 200, splitMs: 0 })
    expect(r.warnings[0]).toContain('Shortened')
    expect(await fail('transition.add', { ids: [a.id], preset: 'push', params: { speed: 2 } })).toContain('no knob "speed"')
    expect(await fail('transition.add', { ids: [a.id], preset: 'fade', color: '#ff0000' })).toContain('does not use a colour')
    expect(await fail('transition.add', { ids: [a.id], preset: 'morph' })).toContain('No transition preset')
    void comp
  })

  it('drops transitions whose layers go, hands a tail to the right half of a split, and is removable', async () => {
    const { ok, pair, trackOf, session } = setup()
    const { a, b } = await pair()
    const { transitions } = await ok('transition.add', { ids: [a], preset: 'fade', edge: 'out' })
    const id = transitions[0].id
    const split = await ok('timeline.split', { id: a, atMs: 500 })
    expect(trackOf(b).transitions[0]?.aLayerId).toBe(split.right)
    expect(transitionWindows(trackOf(b))).toHaveLength(1)
    session.undo()
    await ok('layers.delete', { ids: [b] })
    expect(trackOf(a).transitions).toHaveLength(0)
    session.undo()
    await ok('transition.remove', { transitionId: id })
    expect(trackOf(a).transitions).toHaveLength(0)
  })

  it('crossfades sound', () => {
    expect(transitionGains('equal-power', 0.5).a).toBeCloseTo(Math.SQRT1_2)
    expect(transitionGains('dip', 0.25)).toEqual({ a: 0.5, b: 0 })
  })
})
