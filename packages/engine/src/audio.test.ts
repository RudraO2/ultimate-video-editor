import { type Comp, CompSchema, LayerSchema, type MediaAsset } from '@uve/core'
import { describe, expect, it } from 'vitest'
import {
  audibleLayers,
  EDGE_FADE_SAMPLES,
  edgeFades,
  limitMix,
  type MediaLayer,
  MIX_SAMPLE_RATE,
  mixLayer,
  type Pcm,
  sourceSpanSec,
  type Stereo,
  toStereo,
} from './audio'

const audio = (extra: Record<string, unknown> = {}): MediaLayer =>
  LayerSchema.parse({
    id: 'a1',
    name: 'Sound',
    kind: 'audio',
    mediaId: 'm1',
    startMs: 0,
    durationMs: 1000,
    ...extra,
  }) as MediaLayer

/** A source of `seconds` of sound at `rate`, made by `wave` (a function of source seconds). */
function pcm(rate: number, seconds: number, wave: (sec: number) => number, startSec = 0): Pcm {
  const length = Math.round(rate * seconds)
  const left = new Float32Array(length)
  for (let i = 0; i < length; i++) left[i] = wave(startSec + i / rate)
  return { sampleRate: rate, startSec, left, right: left.slice(), length }
}

const silence = (samples: number): Stereo => ({ left: new Float32Array(samples), right: new Float32Array(samples) })
const noFades = { fadeIn: false, fadeOut: false }
const sine = (hz: number) => (sec: number) => Math.sin(2 * Math.PI * hz * sec)

/** The largest difference between `out` and `expected` (a function of the mix sample index), over [from, to). */
function maxError(out: Float32Array, expected: (index: number) => number, from: number, to: number): number {
  let worst = 0
  for (let i = from; i < to; i++) worst = Math.max(worst, Math.abs((out[i] ?? 0) - expected(i)))
  return worst
}

describe('mixLayer', () => {
  it('copies a source at the mix rate unchanged', () => {
    const source = pcm(MIX_SAMPLE_RATE, 1, sine(440))
    const out = silence(MIX_SAMPLE_RATE)
    mixLayer(out, 0, audio(), source, noFades)
    expect(Array.from(out.left)).toEqual(Array.from(source.left))
  })

  it('resamples 44.1 kHz sound to the mix rate', () => {
    const out = silence(MIX_SAMPLE_RATE)
    mixLayer(out, 0, audio(), pcm(44100, 1.1, sine(1000)), noFades)
    const error = maxError(out.left, (i) => Math.sin((2 * Math.PI * 1000 * i) / MIX_SAMPLE_RATE), 500, 47000)
    expect(error).toBeLessThan(2e-3)
  })

  it('plays faster and higher at twice the speed', () => {
    const out = silence(MIX_SAMPLE_RATE / 2)
    mixLayer(out, 0, audio({ playbackRate: 2, durationMs: 500 }), pcm(MIX_SAMPLE_RATE, 1.1, sine(440)), noFades)
    const error = maxError(out.right, (i) => Math.sin((2 * Math.PI * 880 * i) / MIX_SAMPLE_RATE), 500, 23500)
    expect(error).toBeLessThan(2e-3)
  })

  it('places the layer in comp time and reads from its source start', () => {
    const layer = audio({ startMs: 500, sourceStartMs: 1000, durationMs: 250 })
    const out = silence(MIX_SAMPLE_RATE)
    mixLayer(out, 0, layer, pcm(MIX_SAMPLE_RATE, 2, (sec) => sec), noFades)
    expect(out.left[23999]).toBe(0)
    expect(out.left[24000]).toBeCloseTo(1, 5)
    expect(out.left[24000 + 4800]).toBeCloseTo(1.1, 5)
    expect(out.left[36000]).toBe(0)
  })

  it('applies volume above 100 % without limiting, and limitMix clips the result', () => {
    const out = silence(1000)
    mixLayer(out, 0, audio({ volume: 2.5 }), pcm(MIX_SAMPLE_RATE, 1, () => 0.5), noFades)
    expect(out.left[10]).toBeCloseTo(1.25, 6)
    expect(limitMix(out)).toBe(2000)
    expect(out.left[10]).toBe(1)
  })

  it('follows volume keyframes', () => {
    const layer = audio({
      animations: {
        volume: [
          { t: 0, v: 0, ease: 'linear' },
          { t: 1000, v: 1, ease: 'linear' },
        ],
      },
    })
    const out = silence(MIX_SAMPLE_RATE)
    mixLayer(out, 0, layer, pcm(MIX_SAMPLE_RATE, 1, () => 1), noFades)
    expect(out.left[12000]).toBeCloseTo(0.25, 4)
    expect(out.left[36000]).toBeCloseTo(0.75, 4)
  })

  it('keeps an overshooting volume easing inside 0 to 4', () => {
    const layer = audio({
      animations: {
        volume: [
          { t: 0, v: 0, ease: 'ease-in-back' },
          { t: 1000, v: 4, ease: 'linear' },
        ],
      },
    })
    const out = silence(MIX_SAMPLE_RATE)
    mixLayer(out, 0, layer, pcm(MIX_SAMPLE_RATE, 1, () => 1), noFades)
    expect(Math.min(...out.left)).toBeGreaterThanOrEqual(0)
  })

  it('gives the same samples whether a range is mixed at once or in pieces', () => {
    const layer = audio({ playbackRate: 1.5, startMs: 10, durationMs: 600 })
    const source = pcm(44100, 1.2, sine(330))
    const whole = silence(MIX_SAMPLE_RATE)
    mixLayer(whole, 0, layer, source, edgeFades(layer, [layer]))
    const first = silence(20000)
    const second = silence(MIX_SAMPLE_RATE - 20000)
    mixLayer(first, 0, layer, source, edgeFades(layer, [layer]))
    mixLayer(second, 20000, layer, source, edgeFades(layer, [layer]))
    expect([...first.left, ...second.left]).toEqual(Array.from(whole.left))
  })

  it('fades the edges, but not where a split layer carries on', () => {
    const left = audio({ id: 'a1', durationMs: 500 })
    const right = audio({ id: 'a2', startMs: 500, sourceStartMs: 500, durationMs: 500 })
    const both = [left, right]
    expect(edgeFades(left, both)).toEqual({ fadeIn: true, fadeOut: false })
    expect(edgeFades(right, both)).toEqual({ fadeIn: false, fadeOut: true })

    const out = silence(MIX_SAMPLE_RATE)
    const source = pcm(MIX_SAMPLE_RATE, 1, () => 1)
    for (const layer of both) mixLayer(out, 0, layer, source, edgeFades(layer, both))
    expect(out.left[0]).toBeCloseTo(0.5 / EDGE_FADE_SAMPLES, 6)
    expect(out.left[EDGE_FADE_SAMPLES]).toBe(1)
    // The join at 500 ms has no dip.
    for (let i = 23990; i < 24010; i++) expect(out.left[i]).toBe(1)
    expect(out.left[MIX_SAMPLE_RATE - 1]).toBeCloseTo(0.5 / EDGE_FADE_SAMPLES, 6)
  })
})

describe('sourceSpanSec', () => {
  it('covers the samples asked for, widened by the kernel reach', () => {
    const span = sourceSpanSec(audio({ sourceStartMs: 2000, playbackRate: 2 }), 0, MIX_SAMPLE_RATE / 2)
    expect(span.startSec).toBeLessThan(2)
    expect(span.startSec).toBeGreaterThan(1.99)
    expect(span.endSec).toBeGreaterThan(3)
    expect(span.endSec).toBeLessThan(3.01)
  })
})

describe('audibleLayers', () => {
  const media: MediaAsset[] = [
    { id: 'm1', kind: 'audio', name: 'a.wav', path: '/a.wav', hasAudio: true },
    { id: 'm2', kind: 'video', name: 'silent.mp4', path: '/silent.mp4', hasAudio: false },
  ]
  const comp = (layers: unknown[]): Comp =>
    CompSchema.parse({ id: 'c', name: 'Comp', width: 640, height: 360, fps: 30, durationMs: 5000, tracks: [{ id: 't', layers }] })

  it('keeps enabled, unmuted, sounding layers only', () => {
    const layers = [
      { ...audio({ id: 'ok' }) },
      { ...audio({ id: 'muted', startMs: 1000, muted: true }) },
      { ...audio({ id: 'off', startMs: 2000, enabled: false }) },
      { ...audio({ id: 'quiet', startMs: 3000, volume: 0 }) },
      { ...audio({ id: 'nosound', startMs: 4000 }), kind: 'video', mediaId: 'm2' },
    ]
    expect(audibleLayers(comp(layers), { media, comps: [] }).map((l) => l.id)).toEqual(['ok'])
  })

  it('skips every layer on a muted track', () => {
    const muted = CompSchema.parse({
      ...comp([]),
      tracks: [
        { id: 't1', muted: true, layers: [audio({ id: 'a' })] },
        { id: 't2', layers: [audio({ id: 'b' })] },
      ],
    })
    expect(audibleLayers(muted, { media, comps: [] }).map((l) => l.id)).toEqual(['b'])
  })
})

describe('toStereo', () => {
  it('plays mono on both sides and folds 5.1 down', () => {
    const mono = new Float32Array([0.5])
    expect(toStereo([mono])).toEqual({ left: mono, right: mono })
    const [l, r, c, lfe, ls, rs] = [0.1, 0.2, 0.3, 0.9, 0.4, 0.5].map((v) => new Float32Array([v]))
    const stereo = toStereo([l, r, c, lfe, ls, rs] as Float32Array[])
    expect(stereo.left[0]).toBeCloseTo(0.1 + Math.SQRT1_2 * (0.3 + 0.4), 6)
    expect(stereo.right[0]).toBeCloseTo(0.2 + Math.SQRT1_2 * (0.3 + 0.5), 6)
  })
})
