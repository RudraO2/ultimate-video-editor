import { builtInCategories, CompSchema, LayerSchema } from '@uve/core'
import { MasterMeter, type MediaLayer, MIX_SAMPLE_RATE, MixStream, masterTrimDb, type Pcm, planMix } from '@uve/engine'
import { describe, expect, it } from 'vitest'
import { AUDIO_WINDOW, measureMix, windowMixer } from './mixWindows'
import type { ExportSources } from './sources'

const SECONDS = 4
const clip = (extra: Record<string, unknown> = {}): MediaLayer =>
  LayerSchema.parse({ id: 'a', name: 'a', kind: 'audio', mediaId: 'm', startMs: 0, durationMs: SECONDS * 1000, ...extra }) as MediaLayer

/** Sources that play a 997 Hz tone of `amplitude` (plus a one-sample spike at `spike`, if given), and count how often sounds are closed. */
function toneSources(amplitude: number, spike?: { at: number; value: number }) {
  const closed: string[] = []
  const sources = {
    async sound(_layer: MediaLayer, startSec: number, endSec: number): Promise<Pcm> {
      const first = Math.floor(startSec * MIX_SAMPLE_RATE)
      const length = Math.ceil(endSec * MIX_SAMPLE_RATE) - first
      const left = new Float32Array(length)
      for (let i = 0; i < length; i++) left[i] = amplitude * Math.sin((2 * Math.PI * 997 * (first + i)) / MIX_SAMPLE_RATE)
      if (spike && spike.at >= first && spike.at < first + length) left[spike.at - first] = spike.value
      return { left, right: left.slice(), sampleRate: MIX_SAMPLE_RATE, startSec: first / MIX_SAMPLE_RATE, length }
    },
    async closeSound(id: string) {
      closed.push(id)
    },
    async wholeSound() {
      return null
    },
  }
  return { sources: sources as unknown as ExportSources, closed }
}

const setup = (sources: ExportSources, soundMix: Record<string, unknown> = {}) => {
  const comp = CompSchema.parse({ id: 'c', name: 'C', width: 640, height: 360, fps: 30, durationMs: SECONDS * 1000, soundMix })
  const sounding = [clip()]
  const mix = planMix({ comp, categories: builtInCategories(), segments: sounding, hits: [], layerBus: () => undefined, segmentLevel: () => null, hitLevel: () => null })
  return { comp, sounding, hits: [], mix, sources }
}

/** What the export writes: the whole mix through a stream with the trim set, measured. */
async function exported(s: ReturnType<typeof setup>, trimDb: number) {
  const mixer = windowMixer(s)
  const stream = new MixStream({ ...s.mix, masterTrim: 10 ** (trimDb / 20) })
  const meter = new MasterMeter(MIX_SAMPLE_RATE)
  const total = SECONDS * MIX_SAMPLE_RATE
  for (let at = 0; at < total; at += AUDIO_WINDOW) meter.push(stream.process(at, AUDIO_WINDOW, await mixer(at, AUDIO_WINDOW)))
  meter.push(stream.finish())
  for (const layer of s.sounding) await s.sources.closeSound(layer.id)
  return meter.levels()
}

describe('the loudness match', () => {
  it('measures the mix before the limiter and brings it to the target', async () => {
    const { sources, closed } = toneSources(0.05)
    const s = setup(sources)
    const levels = await measureMix(s, 0, SECONDS * MIX_SAMPLE_RATE)
    expect(levels.integrated).toBeCloseTo(-26, 0)
    expect(levels.peakDb).toBeCloseTo(-26, 0)
    // Every sound is closed afterwards, so the real pass can read the file again from the start.
    expect(closed).toContain('a')
    const trim = masterTrimDb(levels.integrated, levels.peakDb, s.mix.loudness, s.mix.limiter)
    expect(trim).toBeCloseTo(12, 0)
    expect((await exported(s, trim)).integrated).toBeCloseTo(-14, 0)
  })

  it('stops short of the target when the limiter would have to take more than 3 dB off a peak', async () => {
    const { sources } = toneSources(0.05, { at: 20000, value: 0.9 })
    const s = setup(sources)
    const levels = await measureMix(s, 0, SECONDS * MIX_SAMPLE_RATE)
    expect(levels.peakDb).toBeGreaterThan(-1.5)
    const trim = masterTrimDb(levels.integrated, levels.peakDb, s.mix.loudness, s.mix.limiter)
    expect(trim).toBeGreaterThan(2)
    expect(trim).toBeLessThan(4)
    const final = await exported(s, trim)
    expect(final.integrated).toBeLessThan(-18)
    expect(final.truePeakDb).toBeLessThan(0)
  })

  it('leaves the mix as it was when it is off', async () => {
    const { sources } = toneSources(0.05)
    const s = setup(sources, { loudness: { enabled: false } })
    const levels = await measureMix(s, 0, SECONDS * MIX_SAMPLE_RATE)
    expect(masterTrimDb(levels.integrated, levels.peakDb, s.mix.loudness, s.mix.limiter)).toBe(0)
    expect((await exported(s, 0)).integrated).toBeCloseTo(levels.integrated, 1)
  })

  it('measures a span of the mix', async () => {
    const { sources } = toneSources(0.05, { at: 20000, value: 0.9 })
    const s = setup(sources)
    // The spike is in the first second; a span from the second second on does not hear it.
    const later = await measureMix(s, MIX_SAMPLE_RATE, 2 * MIX_SAMPLE_RATE)
    expect(later.peakDb).toBeCloseTo(-26, 0)
  })

  it('rejects when aborted', async () => {
    const { sources } = toneSources(0.05)
    const abort = new AbortController()
    abort.abort()
    await expect(measureMix(setup(sources), 0, SECONDS * MIX_SAMPLE_RATE, abort.signal)).rejects.toBeDefined()
  })
})
