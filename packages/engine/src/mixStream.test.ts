import { builtInCategories, CompSchema, LayerSchema } from '@uve/core'
import { describe, expect, it } from 'vitest'
import { MIX_SAMPLE_RATE, type MediaLayer, type Stereo } from './audio'
import { measure } from './loudness'
import { planMix, type SegmentLevel } from './mixPlan'
import { MixStream, UNROUTED } from './mixStream'

const comp = (soundMix: Record<string, unknown> = {}) => CompSchema.parse({ id: 'c', name: 'C', width: 640, height: 360, fps: 30, durationMs: 4000, soundMix })
const clip = (id: string, extra: Record<string, unknown>): MediaLayer =>
  LayerSchema.parse({ id, name: id, kind: 'audio', mediaId: 'm', startMs: 0, durationMs: 4000, ...extra }) as MediaLayer

const tone = (seconds: number, amplitude: number, hz = 997): Stereo => {
  const left = new Float32Array(Math.round(seconds * MIX_SAMPLE_RATE))
  for (let i = 0; i < left.length; i++) left[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / MIX_SAMPLE_RATE)
  return { left, right: left.slice() }
}
const slice = (s: Stereo, from: number, to: number): Stereo => ({ left: s.left.slice(from, to), right: s.right.slice(from, to) })
const join = (parts: Stereo[]): Stereo => {
  const length = parts.reduce((n, p) => n + p.left.length, 0)
  const out = { left: new Float32Array(length), right: new Float32Array(length) }
  let at = 0
  for (const p of parts) {
    out.left.set(p.left, at)
    out.right.set(p.right, at)
    at += p.left.length
  }
  return out
}
const loudness = (s: Stereo) => measure([s.left, s.right], MIX_SAMPLE_RATE).integrated

/** Runs `buses` through a stream in windows of `window` samples; returns the whole master. */
function run(stream: MixStream, buses: Record<string, Stereo>, window: number): Stereo {
  const length = Object.values(buses)[0]?.left.length ?? 0
  const parts: Stereo[] = []
  for (let first = 0; first < length; first += window) {
    const end = Math.min(length, first + window)
    parts.push(stream.process(first, end - first, new Map(Object.entries(buses).map(([k, v]) => [k, slice(v, first, end)]))))
  }
  parts.push(stream.finish())
  return join(parts)
}

describe('MixStream', () => {
  const voiceLevel: SegmentLevel = { integrated: -16, maxMomentary: -14, active: [{ startMs: 0, endMs: 1000 }] }

  it('keeps every sample under the ceiling, gives back as many samples as it took, and mixes the same in pieces', () => {
    const plan = planMix({ comp: comp(), categories: builtInCategories(), segments: [], hits: [], layerBus: () => undefined, segmentLevel: () => null, hitLevel: () => null })
    const loud = { [UNROUTED]: tone(1, 2.5) }
    const whole = run(new MixStream(plan), loud, 48000)
    const pieces = run(new MixStream(plan), loud, 777)
    expect(whole.left.length).toBe(48000)
    expect(pieces.left).toEqual(whole.left)
    const ceiling = 10 ** (-1 / 20)
    expect(Math.max(...whole.left.map(Math.abs))).toBeLessThanOrEqual(ceiling)
    // Away from the onset, the output is the input turned down, not distorted: it stays in phase.
    expect(Math.sign(whole.left[24001] ?? 0)).toBe(Math.sign(loud[UNROUTED].left[24001] ?? 0))
  })

  it('passes quiet sound through untouched (aligned, the limiter delay made up)', () => {
    const plan = planMix({ comp: comp(), categories: builtInCategories(), segments: [], hits: [], layerBus: () => undefined, segmentLevel: () => null, hitLevel: () => null })
    const quiet = tone(0.5, 0.25)
    const out = run(new MixStream(plan), { [UNROUTED]: quiet }, 1000)
    expect(out.left).toEqual(quiet.left)
  })

  it('dips music 10 dB under dialogue in the mix', () => {
    const voice = clip('v', { soundBus: 'voice', durationMs: 1000 })
    const music = clip('m', { soundBus: 'music' })
    const plan = planMix({
      comp: comp({ leveler: { evenSpeech: false }, limiter: { enabled: false } }),
      categories: builtInCategories(),
      segments: [voice, music],
      hits: [],
      layerBus: () => undefined,
      segmentLevel: (l) => (l.id === 'v' ? voiceLevel : { integrated: -20, maxMomentary: -19, active: [{ startMs: 0, endMs: 4000 }] }),
      hitLevel: () => null,
    })
    const bed = tone(4, 0.1, 440)
    const out = run(new MixStream(plan), { music: bed }, 4800)
    const during = loudness(slice(out, 4800, 43200))
    const after = loudness(slice(out, 96000, 192000))
    expect(after - during).toBeCloseTo(10, 0)
    expect(after).toBeCloseTo(loudness(bed), 1)
  })

  it('compresses speech buses and applies faders', () => {
    const categories = builtInCategories().map((c) => (c.id === 'sfx' ? { ...c, volume: 0.5 } : c))
    const plan = planMix({ comp: comp({ limiter: { enabled: false } }), categories, segments: [], hits: [], layerBus: () => undefined, segmentLevel: () => null, hitLevel: () => null })
    const sfx = run(new MixStream(plan), { sfx: tone(1, 0.2) }, 4800)
    expect(loudness(sfx) - loudness(tone(1, 0.2))).toBeCloseTo(-6.02, 1)
    // A −17 dBFS-peak tone sits 9 dB over the threshold: 3:1 takes about 4 dB off (in the soft knee, a little less), +4 dB makeup.
    const voice = run(new MixStream(plan), { voice: tone(1, 0.141) }, 4800)
    const change = loudness(slice(voice, 24000, 48000)) - loudness(slice(tone(1, 0.141), 24000, 48000))
    expect(change).toBeGreaterThan(-2)
    expect(change).toBeLessThan(2)
  })

  it('applies the master trim after the fader, and measuring leaves it out', () => {
    const base = planMix({ comp: comp({ volume: 0.5, limiter: { enabled: false } }), categories: builtInCategories(), segments: [], hits: [], layerBus: () => undefined, segmentLevel: () => null, hitLevel: () => null })
    const input = { [UNROUTED]: tone(1, 0.2) }
    const plain = run(new MixStream(base), input, 4800)
    const trimmed = run(new MixStream({ ...base, masterTrim: 2 }), input, 4800)
    expect(loudness(trimmed) - loudness(plain)).toBeCloseTo(6.02, 1)
    const measured = run(new MixStream({ ...base, masterTrim: 2 }, MIX_SAMPLE_RATE, { measuring: true }), input, 4800)
    expect(measured.left).toEqual(plain.left)
  })

  it('measuring has no limiter, no delay and no clamp', () => {
    const plan = planMix({ comp: comp(), categories: builtInCategories(), segments: [], hits: [], layerBus: () => undefined, segmentLevel: () => null, hitLevel: () => null })
    const stream = new MixStream(plan, MIX_SAMPLE_RATE, { measuring: true })
    expect(stream.latency).toBe(0)
    const out = run(stream, { [UNROUTED]: tone(1, 2.5) }, 4800)
    expect(out.left.length).toBe(48000)
    expect(Math.max(...out.left.map(Math.abs))).toBeGreaterThan(2.4)
    expect(stream.clamped).toBe(0)
  })
})
