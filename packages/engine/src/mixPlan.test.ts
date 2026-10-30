import { builtInCategories, CompSchema, LayerSchema, type SoundCategory, type SoundHit, SoundVoiceSchema } from '@uve/core'
import { describe, expect, it } from 'vitest'
import type { MediaLayer } from './audio'
import { DUCK_STEP_MS, duckEnvelope, levelerTrimDb, LOUDNESS_MAX_LIMIT_DB, masterTrimDb, type MixInputs, planMix, type SegmentLevel, segmentGain, tableAt } from './mixPlan'

const clip = (id: string, extra: Record<string, unknown> = {}): MediaLayer =>
  LayerSchema.parse({ id, name: id, kind: 'audio', mediaId: 'm1', startMs: 0, durationMs: 4000, ...extra }) as MediaLayer

const comp = (soundMix: Record<string, unknown> = {}) => CompSchema.parse({ id: 'c', name: 'C', width: 640, height: 360, fps: 30, durationMs: 6000, soundMix })

const db = (gain: number) => 20 * Math.log10(gain)

function inputs(extra: Partial<MixInputs> & { levels?: Record<string, SegmentLevel> }): MixInputs {
  const { levels = {}, ...rest } = extra
  return {
    comp: comp(),
    categories: builtInCategories(),
    segments: [],
    hits: [],
    layerBus: () => undefined,
    segmentLevel: (layer) => levels[layer.id] ?? null,
    hitLevel: () => -10,
    ...rest,
  }
}

const level = (integrated: number, active = [{ startMs: 0, endMs: 4000 }]): SegmentLevel => ({ integrated, maxMomentary: integrated + 3, active })

const hit = (layerId: string, timeMs: number, volume = 0.3): SoundHit => ({
  layerId,
  voice: SoundVoiceSchema.parse({ id: 'v', pack: 'pop' }),
  timeMs,
  pitch: 1,
  volume,
  variant: 0,
})

describe('the leveler', () => {
  const leveler = comp().soundMix.leveler
  it('tames loud sound by its strength, leaves quiet sound alone by default, and clamps', () => {
    expect(levelerTrimDb(-10, -16, leveler)).toBeCloseTo(-6 * 0.8)
    expect(levelerTrimDb(-30, -16, leveler)).toBe(0)
    expect(levelerTrimDb(-30, -16, { ...leveler, liftQuiet: true, strength: 1 })).toBe(12)
    expect(levelerTrimDb(-70, -16, { ...leveler, liftQuiet: true })).toBe(0)
    expect(levelerTrimDb(-10, -16, { ...leveler, enabled: false })).toBe(0)
  })

  it('brings a −26 LUFS voice to its −16 target, and unrouted media to −18', () => {
    const voice = clip('v', { soundBus: 'voice' })
    const plain = clip('p')
    const plan = planMix(
      inputs({ comp: comp({ leveler: { liftQuiet: true, strength: 1 } }), segments: [voice, plain], levels: { v: level(-26), p: level(-28) } }),
    )
    expect(db(plan.segmentTrim.get('v') ?? 0)).toBeCloseTo(10)
    expect(db(plan.segmentTrim.get('p') ?? 0)).toBeCloseTo(10)
    expect(plan.segmentBus.get('v')).toBe('voice')
    expect(plan.segmentBus.get('p')).toBeNull()
  })

  it('counts the clip volume, and levels split halves as one', () => {
    const a = clip('a', { soundBus: 'music', durationMs: 2000, volume: 2 })
    const b = clip('b', { soundBus: 'music', startMs: 2000, sourceStartMs: 2000, durationMs: 2000, volume: 2 })
    const plan = planMix(inputs({ segments: [a, b], levels: { a: level(-20), b: level(-26) } }))
    expect(plan.segmentTrim.get('a')).toBe(plan.segmentTrim.get('b'))
    expect(plan.segmentTrim.get('a')).toBeLessThan(1)
  })

  it('measures the sfx bus by its loudest moment', () => {
    const plan = planMix(inputs({ segments: [clip('s', { soundBus: 'sfx' })], levels: { s: level(-19) } }))
    expect(db(plan.segmentTrim.get('s') ?? 0)).toBeCloseTo(-3 * 0.8)
  })
})

describe('rapid-fire cues', () => {
  it('puts twenty typing hits 7 dB under one pop of the same sound', () => {
    const typing = Array.from({ length: 20 }, (_, i) => hit('typing', 1000 + i * 60))
    const plan = planMix(inputs({ hits: [hit('pop', 500), ...typing], comp: comp({ leveler: { liftQuiet: true, strength: 1 } }) }))
    const one = db(plan.hitTrim[0] ?? 0)
    const many = db(plan.hitTrim[1] ?? 0)
    // Twenty in 400 ms windows: seven at most at once (+8.45 dB), and 7 dB lower target.
    expect(one - many).toBeCloseTo(7 + 10 * Math.log10(7), 1)
    expect(plan.hitBus).toEqual(Array(21).fill('sfx'))
  })

  it('routes a hit by its layer tag, unknown tags to master', () => {
    const plan = planMix(inputs({ hits: [hit('a', 0), hit('b', 0)], layerBus: (id) => (id === 'a' ? 'voice' : 'gone') }))
    expect(plan.hitBus).toEqual(['voice', null])
  })
})

describe('ducking', () => {
  it('dips music 10 dB under dialogue, with the first word already ducked', () => {
    const voice = clip('v', { soundBus: 'voice', startMs: 1000, durationMs: 2000 })
    const music = clip('m', { soundBus: 'music', durationMs: 6000 })
    const plan = planMix(inputs({ segments: [voice, music], levels: { v: level(-16, [{ startMs: 0, endMs: 2000 }]), m: level(-20, [{ startMs: 0, endMs: 6000 }]) } }))
    const duck = plan.buses.find((b) => b.id === 'music')?.duck
    if (!duck) throw new Error('music should duck')
    expect(db(tableAt(duck, 500))).toBeCloseTo(0)
    expect(db(tableAt(duck, 1000))).toBeCloseTo(-10)
    expect(db(tableAt(duck, 2000))).toBeCloseTo(-10)
    expect(db(tableAt(duck, 3250))).toBeCloseTo(-5, 0)
    expect(db(tableAt(duck, 3600))).toBeCloseTo(0)
    // Voice itself never ducks.
    expect(plan.buses.find((b) => b.id === 'voice')?.duck).toBeNull()
  })

  it('ramps linearly in steps of 10 ms and multiplies rules', () => {
    const table = duckEnvelope([{ startMs: 200, endMs: 400 }], { depthDb: 20, attackMs: 100, releaseMs: 100 }, 1000)
    expect(table.length).toBe(1000 / DUCK_STEP_MS + 1)
    expect(db(table[10] ?? 0)).toBeCloseTo(-2)
    expect(db(table[20] ?? 0)).toBeCloseTo(-20)
    expect(db(table[50] ?? 0)).toBeCloseTo(0)
  })

  it('applies a clip rule that listens to a nested layer', () => {
    const inner = clip('nest1/v1#0', { soundBus: 'voice', startMs: 1000, durationMs: 1000 })
    const bed = clip('bed', { ducking: [{ id: 'd', under: { kind: 'clip', id: 'nest1' }, depthDb: 6, attackMs: 0, releaseMs: 0 }] })
    const plan = planMix(inputs({ segments: [inner, bed] }))
    expect(db(segmentGain(plan, 'bed', 1500))).toBeCloseTo(-6)
    expect(db(segmentGain(plan, 'bed', 500))).toBeCloseTo(0)
  })
})

describe('buses', () => {
  it('applies fader, mute and solo; solo silences the unrouted input', () => {
    const categories: SoundCategory[] = builtInCategories().map((c) => (c.id === 'music' ? { ...c, volume: 0.5 } : c.id === 'sfx' ? { ...c, muted: true } : c))
    const plan = planMix(inputs({ categories }))
    expect(plan.buses.map((b) => [b.id, b.gain])).toEqual([
      ['voice', 1],
      ['music', 0.5],
      ['sfx', 0],
      ['ambience', 1],
    ])
    expect(plan.buses.find((b) => b.id === 'voice')?.compress).toBe(true)
    const solo = planMix(inputs({ categories: categories.map((c) => (c.id === 'voice' ? { ...c, solo: true } : c)) }))
    expect(solo.buses.map((b) => b.gain)).toEqual([1, 0, 0, 0])
    expect(solo.unroutedGain).toBe(0)
  })
})

describe('masterTrimDb', () => {
  const on = { enabled: true, targetLufs: -14 }
  const limited = { enabled: true, ceilingDb: -1 }
  const open = { enabled: false, ceilingDb: -1 }

  it('reaches the target when the peaks allow', () => {
    expect(masterTrimDb(-20, -12, on, limited)).toBeCloseTo(6, 6)
    expect(masterTrimDb(-10, -3, on, limited)).toBeCloseTo(-4, 6)
    expect(masterTrimDb(-20, -12, { enabled: true, targetLufs: -16 }, limited)).toBeCloseTo(4, 6)
  })

  it('lets the limiter take at most 3 dB off the loudest peak', () => {
    expect(LOUDNESS_MAX_LIMIT_DB).toBe(3)
    // Peak at -3 dBFS, ceiling -1: the trim may reach -1 - (-3) + 3 = 5 dB, though the target asks 12.
    expect(masterTrimDb(-26, -3, on, limited)).toBeCloseTo(5, 6)
    // A lower ceiling lowers the reach.
    expect(masterTrimDb(-26, -3, on, { enabled: true, ceilingDb: -3 })).toBeCloseTo(3, 6)
  })

  it('lets nothing clip with the limiter off', () => {
    expect(masterTrimDb(-26, -3, on, open)).toBeCloseTo(3, 6)
    expect(masterTrimDb(-20, -12, on, open)).toBeCloseTo(6, 6)
  })

  it('is 0 when off, silent or not finite, and stays within 24 dB', () => {
    expect(masterTrimDb(-20, -12, { enabled: false, targetLufs: -14 }, limited)).toBe(0)
    expect(masterTrimDb(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, on, limited)).toBe(0)
    expect(masterTrimDb(-20, Number.NaN, on, limited)).toBe(0)
    expect(masterTrimDb(-70, -40, on, limited)).toBe(24)
    expect(masterTrimDb(10, 0, { enabled: true, targetLufs: -30 }, limited)).toBe(-24)
  })

  it('is in the plan as 1 until set, with the settings of the comp', () => {
    const plan = planMix(inputs({ comp: comp({ loudness: { targetLufs: -16 } }) }))
    expect(plan.masterTrim).toBe(1)
    expect(plan.loudness).toEqual({ enabled: true, targetLufs: -16 })
  })
})
