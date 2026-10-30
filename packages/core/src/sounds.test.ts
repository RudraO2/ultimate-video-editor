import { describe, expect, it } from 'vitest'
import { createDefaultProject } from './doc'
import { sequentialIds } from './ids'
import type { Comp, Layer, Track } from './schema'
import { Session } from './session'
import { compSoundHits, compSoundHitsDeep, soundHits } from './sounds'

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
  const layer = (id: string) => comp().tracks.flatMap((t) => t.layers).find((l) => l.id === id) as Layer
  const track = (id: string) => comp().tracks.find((t) => t.layers.some((l) => l.id === id)) as Track
  return { ok, fail, comp, layer, track, comps: () => session.project.comps }
}

describe('the sounds stack', () => {
  it('fires once per word of a text entrance, skipping spaces for letters', async () => {
    const { ok, layer } = setup()
    const { id } = await ok('layer.create', {
      kind: 'text',
      text: 'one two three',
      startMs: 1000,
      sounds: [{ pack: 'pop', volume: 0.3, randomness: 0 }],
    })
    await ok('animation.set', { id, slot: 'in', preset: 'fade-up', unit: 'word', staggerMs: 100, durationMs: 300 })
    expect(soundHits(layer(id)).map((h) => h.timeMs)).toEqual([1000, 1100, 1200])
    await ok('animation.set', { id, slot: 'in', preset: 'typewriter', unit: 'letter', staggerMs: 50 })
    // 13 graphemes, 2 of them spaces.
    expect(soundHits(layer(id))).toHaveLength(11)
  })

  it('anchors on the peak or end, offsets, and varies pitch and volume (never timing) with randomness', async () => {
    const { ok, layer } = setup()
    const { id } = await ok('layer.create', { kind: 'shape', startMs: 500, sounds: [{ pack: 'thock', trigger: { kind: 'layer' }, anchor: 'end', offsetMs: -20, randomness: 0 }] })
    await ok('animation.set', { id, slot: 'in', preset: 'pop-in', durationMs: 400 })
    expect(soundHits(layer(id)).map((h) => h.timeMs)).toEqual([880])
    await ok('layer.patch', { id, ops: [{ op: 'set', path: 'sounds[0].randomness', value: 1 }] })
    const hit = soundHits(layer(id))[0]
    expect(hit?.timeMs).toBe(880)
    expect(hit?.pitch).not.toBe(1)
    // AtomCut's ranges at randomness 1: pitch within ±17.5 %, volume down by at most 65 %.
    expect(Math.abs((hit?.pitch ?? 1) - 1)).toBeLessThanOrEqual(0.175)
    expect(hit?.volume).toBeLessThanOrEqual(0.32)
    expect(hit?.volume).toBeGreaterThanOrEqual(0.32 * 0.35)
  })

  it('moves a recorded sound half as far in pitch', async () => {
    const { ok, layer } = setup()
    const { id } = await ok('layer.create', { kind: 'shape', sounds: [{ pack: 'thock', trigger: { kind: 'layer' }, randomness: 1 }] })
    await ok('animation.set', { id, slot: 'in', preset: 'pop-in', durationMs: 400 })
    const synth = soundHits(layer(id))[0]?.pitch ?? 1
    await ok('layer.patch', { id, ops: [{ op: 'set', path: 'sounds[0].pack', value: null }, { op: 'set', path: 'sounds[0].custom', value: { assetId: 'media_x', hitMs: 0 } }] })
    const recorded = soundHits(layer(id))[0]?.pitch ?? 1
    expect(synth).not.toBe(1)
    expect(recorded - 1).toBeCloseTo((synth - 1) / 2, 9)
  })

  it('fires on the transition at its cut', async () => {
    const { ok, layer, track } = setup()
    const a = await ok('layer.create', { kind: 'shape', startMs: 0, durationMs: 1000 })
    const b = await ok('layer.create', { kind: 'shape', startMs: 1000, durationMs: 1000, trackId: a.trackId, sounds: [{ pack: 'soft', trigger: { kind: 'transition' }, anchor: 'peak', randomness: 0 }] })
    await ok('transition.add', { ids: [a.id], preset: 'push', edge: 'out', durationMs: 400 })
    expect(soundHits(layer(b.id), track(b.id)).map((h) => h.timeMs)).toEqual([1000])
  })

  it('needs a pack or a custom sound, mints ids, and leaves muted lanes silent', async () => {
    const { ok, fail, layer, comp } = setup()
    const { id, trackId } = await ok('layer.create', { kind: 'shape' })
    expect(await fail('layer.patch', { id, ops: [{ op: 'insert', path: 'sounds[-]', value: { volume: 0.2 } }] })).toContain('pack or custom')
    await ok('layer.patch', { id, ops: [{ op: 'insert', path: 'sounds[-]', value: { pack: 'pop', trigger: { kind: 'layer' } } }] })
    expect(layer(id).sounds[0]?.id).toBeTruthy()
    await ok('animation.set', { id, slot: 'in', preset: 'fade' })
    expect(compSoundHits(comp().tracks)).toHaveLength(1)
    await ok('track.update', { id: trackId, muted: true })
    expect(compSoundHits(comp().tracks)).toHaveLength(0)
  })

  it('fires from inside nested comps and worlds, in the outer time, with the nested layer\'s volume, bus and mute', async () => {
    const { ok, comp, comps } = setup()
    const { id } = await ok('layer.create', { kind: 'shape', startMs: 1000, sounds: [{ pack: 'pop', volume: 0.4, trigger: { kind: 'layer' }, randomness: 0 }] })
    await ok('animation.set', { id, slot: 'in', preset: 'fade', durationMs: 300 })
    const deep = () => compSoundHitsDeep(comp(), comps())
    expect(deep().map((h) => h.timeMs)).toEqual([1000])
    // Nested: the outer lanes alone are silent, the deep hits are where they were.
    const nested = (await ok('layers.nest', { ids: [id], fullFrame: true })).id as string
    expect(compSoundHits(comp().tracks)).toHaveLength(0)
    expect(deep()).toMatchObject([{ timeMs: 1000, volume: 0.4, layerId: `${nested}/${id}#0` }])
    await ok('layer.patch', { id: nested, ops: [{ op: 'set', path: 'volume', value: 0.5 }, { op: 'set', path: 'soundBus', value: 'ambience' }] })
    expect(deep()).toMatchObject([{ timeMs: 1000, volume: 0.2, soundBus: 'ambience' }])
    await ok('timeline.move', { id: nested, startMs: 3000 })
    expect(deep().map((h) => h.timeMs)).toEqual([3000])
    await ok('layer.patch', { id: nested, ops: [{ op: 'set', path: 'muted', value: true }] })
    expect(deep()).toHaveLength(0)
  })

  it('keeps a layer\'s sounds when it moves into a world', async () => {
    const { ok, comp, comps } = setup()
    const { id } = await ok('layer.create', { kind: 'text', text: 'drizzle', startMs: 500, sounds: [{ pack: 'pop', trigger: { kind: 'layer' }, randomness: 0 }] })
    await ok('animation.set', { id, slot: 'in', preset: 'fade', durationMs: 300 })
    const before = compSoundHitsDeep(comp(), comps()).map((h) => h.timeMs)
    await ok('world.move_into', { ids: [id] })
    expect(compSoundHitsDeep(comp(), comps()).map((h) => h.timeMs)).toEqual(before)
  })
})
