import { SOUND_PACK_IDS, type SoundHit, SoundVoiceSchema } from '@uve/core'
import { describe, expect, it } from 'vitest'
import { MIX_SAMPLE_RATE, mixHits } from './audio'
import { packPitch, packReady, registerPackTakes, synthHit } from './soundSynth'

const peakDb = (pcm: Float32Array) => 20 * Math.log10(Math.max(...pcm.map(Math.abs)))
const synthesised = SOUND_PACK_IDS.filter((p) => p !== 'keys')

describe('synthesised packs', () => {
  it("makes AtomCut's six: short, fading to −80 dB, the same hit every time", () => {
    // Lengths: the tone's duration (or the noise's, when longer), AtomCut's recipes.
    const lengthMs = { mechanical: 30, soft: 50, vintage: 60, thock: 80, digital: 18, pop: 90 }
    for (const pack of synthesised) {
      const hit = synthHit(pack, 1, 0, 48000)
      expect(hit.length / 48, pack).toBeCloseTo(lengthMs[pack as keyof typeof lengthMs], 0)
      // The last millisecond is near −80 dB: no click where the buffer ends.
      expect(Math.max(...hit.subarray(hit.length - 48).map(Math.abs)), pack).toBeLessThan(10 ** (-66 / 20))
      expect(synthHit(pack, 1, 0, 48000)).toBe(hit)
      // No takes: the variant does not change a synthesised hit.
      expect(synthHit(pack, 1, 3, 48000)).toBe(hit)
      expect(packReady(pack)).toBe(true)
    }
  })

  it('keeps each pack at its own level: typing ticks far under thock and pop', () => {
    const level = (pack: (typeof synthesised)[number]) => peakDb(synthHit(pack, 1, 0, 48000))
    expect(level('thock')).toBeGreaterThan(level('mechanical') + 6)
    expect(level('pop')).toBeGreaterThan(level('digital') + 6)
    expect(level('pop')).toBeLessThan(0)
  })

  it('pitch raises the sound, not its length, in 0.5 % steps', () => {
    expect(synthHit('pop', 1.2, 0, 48000).length).toBe(synthHit('pop', 1, 0, 48000).length)
    expect(synthHit('pop', 1.2, 0, 48000)).not.toEqual(synthHit('pop', 1, 0, 48000))
    expect(packPitch(1.0123)).toBe(1.01)
    expect(synthHit('soft', 1.0001, 0, 48000)).toBe(synthHit('soft', 1, 0, 48000))
  })

  it('mixes hits into the right window of the mix, at their volume', () => {
    const voice = SoundVoiceSchema.parse({ id: 'v', pack: 'thock' })
    const hit: SoundHit = { layerId: 'l', voice, timeMs: 1000, pitch: 1, volume: 0.5, variant: 0 }
    const window = (first: number) => {
      const out = { left: new Float32Array(MIX_SAMPLE_RATE / 10), right: new Float32Array(MIX_SAMPLE_RATE / 10) }
      mixHits(out, first, [hit], () => null)
      return Math.max(...out.left.map(Math.abs))
    }
    expect(window(0)).toBe(0)
    // The window starting at 1 s holds the hit, at half its own peak.
    const own = Math.max(...synthHit('thock', 1, 0, MIX_SAMPLE_RATE).map(Math.abs))
    expect(window(MIX_SAMPLE_RATE)).toBeCloseTo(own * 0.5, 3)
  })
})

describe('recorded packs', () => {
  it('stay silent until their takes are registered, then play a take per variant', () => {
    expect(synthHit('keys', 1, 0, 48000).length).toBe(0)
    const take = (value: number, length: number) => new Float32Array(length).fill(value)
    registerPackTakes('keys', { sampleRate: 24000, takes: [take(0.1, 2400), take(0.2, 1200)] })
    expect(packReady('keys')).toBe(true)
    // At 48 kHz a 24 kHz take lasts twice the samples; variants wrap around the takes.
    expect(synthHit('keys', 1, 0, 48000).length).toBeCloseTo(4798, -1)
    expect(synthHit('keys', 1, 3, 48000)[10]).toBeCloseTo(0.2)
    // A higher pitch plays it faster.
    expect(synthHit('keys', 2, 0, 48000).length).toBeCloseTo(2399, -1)
  })
})
