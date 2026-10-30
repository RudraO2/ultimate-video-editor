import { describe, expect, it } from 'vitest'
import { activeRanges, energyToLufs, kWeighting, LoudnessMeter, lufsToEnergy, MasterMeter, measure, TruePeakMeter } from './loudness'

const sine = (rate: number, seconds: number, amplitude: number, freq = 997): Float32Array => {
  const out = new Float32Array(Math.round(rate * seconds))
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / rate)
  return out
}
const db = (x: number) => 20 * Math.log10(x)

describe('kWeighting', () => {
  it('matches the BS.1770 table at 48 kHz', () => {
    const { shelf, highpass } = kWeighting(48000)
    expect(shelf.b0).toBeCloseTo(1.53512485958697, 6)
    expect(shelf.b1).toBeCloseTo(-2.69169618940638, 6)
    expect(shelf.b2).toBeCloseTo(1.19839281085285, 6)
    expect(shelf.a1).toBeCloseTo(-1.69065929318241, 6)
    expect(shelf.a2).toBeCloseTo(0.73248077421585, 6)
    expect([highpass.b0, highpass.b1, highpass.b2]).toEqual([1, -2, 1])
    expect(highpass.a1).toBeCloseTo(-1.99004745483398, 6)
    expect(highpass.a2).toBeCloseTo(0.99007225036621, 6)
  })
})

describe('LoudnessMeter', () => {
  for (const rate of [48000, 44100]) {
    it(`reads a 997 Hz sine at ${rate} Hz`, () => {
      const a = 0.25
      const both = measure([sine(rate, 5, a), sine(rate, 5, a)], rate)
      expect(both.integrated).toBeCloseTo(db(a), 1)
      expect(both.maxMomentary).toBeCloseTo(db(a), 1)
      const one = measure([sine(rate, 5, 1)], rate)
      expect(one.integrated).toBeCloseTo(-3.01, 1)
    })
  }

  it('gives the same blocks whether fed whole or in odd pieces', () => {
    const rate = 48000
    const left = sine(rate, 2, 0.3)
    const right = sine(rate, 2, 0.2, 440)
    const whole = new LoudnessMeter(rate)
    whole.push([left, right])
    const pieces = new LoudnessMeter(rate)
    for (let at = 0, n = 1; at < left.length; at += n, n = n * 3 + 1) {
      pieces.push([left.subarray(at, at + n), right.subarray(at, at + n)])
    }
    expect(Array.from(pieces.blocks())).toEqual(Array.from(whole.blocks()))
    expect(pieces.blocks().length).toBe(20)
  })

  it('gates out silence', () => {
    const rate = 48000
    const target = -20
    const loud = sine(rate, 10, 10 ** (target / 20))
    const pcm = new Float32Array(rate * 20)
    pcm.set(loud)
    const m = measure([pcm, pcm], rate)
    expect(Math.abs(m.integrated - target)).toBeLessThan(0.1)
  })

  it('is -Infinity for silence', () => {
    const m = measure([new Float32Array(48000), new Float32Array(48000)], 48000)
    expect(m.integrated).toBe(Number.NEGATIVE_INFINITY)
    expect(m.maxMomentary).toBe(Number.NEGATIVE_INFINITY)
  })

  it('spreads a short burst over the 400 ms window', () => {
    const rate = 48000
    const burst = sine(rate, 0.05, 0.5)
    const meter = new LoudnessMeter(rate)
    meter.push([burst, burst])
    const burstOnly = measure([sine(rate, 2, 0.5), sine(rate, 2, 0.5)], rate)
    // Energy of the burst over 400 ms: its sustained loudness minus 10 log10(400/50).
    expect(meter.maxMomentary()).toBeGreaterThan(burstOnly.maxMomentary - 10 * Math.log10(8) - 1.5)
    expect(meter.maxMomentary()).toBeLessThan(burstOnly.maxMomentary - 10 * Math.log10(8) + 1.5)
    expect(meter.blocks().length).toBe(0)
    expect(meter.momentaryAt(0)).toBe(meter.maxMomentary())
  })

  it('converts between energy and LUFS', () => {
    expect(energyToLufs(lufsToEnergy(-23))).toBeCloseTo(-23, 9)
    expect(energyToLufs(0)).toBe(Number.NEGATIVE_INFINITY)
  })
})

describe('activeRanges', () => {
  const quiet = lufsToEnergy(-80)
  const loud = lufsToEnergy(-20)
  const blocks = (pattern: number[]) => Float32Array.from(pattern.map((p) => (p ? loud : quiet)))
  it('merges a 200 ms gap', () => {
    const r = activeRanges(blocks([1, 1, 0, 0, 1, 1]))
    expect(r).toEqual([{ startMs: 0, endMs: 600 }])
  })
  it('splits a 500 ms gap', () => {
    const r = activeRanges(blocks([1, 1, 0, 0, 0, 0, 0, 1]))
    expect(r).toEqual([
      { startMs: 0, endMs: 200 },
      { startMs: 700, endMs: 800 },
    ])
  })
  it('is empty for silence', () => {
    expect(activeRanges(blocks([0, 0, 0]))).toEqual([])
  })
})

describe('TruePeakMeter', () => {
  it('reads a plain sine as its amplitude, at any piece size', () => {
    const x = sine(48000, 1, 0.5)
    const meter = new TruePeakMeter()
    for (let at = 0; at < x.length; at += 777) meter.push([x.subarray(at, at + 777)])
    meter.finish()
    expect(db(meter.samplePeak())).toBeCloseTo(-6.02, 1)
    expect(db(meter.truePeak())).toBeCloseTo(-6.02, 1)
  })

  it('finds the peak between samples: a sine at a quarter of the rate, 45 degrees off, has samples at 0.707 of a peak of 1', () => {
    const x = new Float32Array(4800)
    for (let i = 0; i < x.length; i++) x[i] = Math.sin((Math.PI / 2) * i + Math.PI / 4)
    const meter = new TruePeakMeter()
    meter.push([x, x])
    meter.finish()
    expect(db(meter.samplePeak())).toBeCloseTo(-3.01, 1)
    expect(db(meter.truePeak())).toBeGreaterThan(-0.4)
    expect(db(meter.truePeak())).toBeLessThan(0.1)
  })

  it('is silent for silence', () => {
    const meter = new TruePeakMeter()
    meter.push([new Float32Array(100)])
    meter.finish()
    expect(meter.truePeak()).toBe(0)
  })
})

describe('MasterMeter', () => {
  it('reads loudness and peaks of a stereo sine, and -Infinity for silence', () => {
    const meter = new MasterMeter(48000)
    const x = sine(48000, 3, 0.25)
    meter.push({ left: x, right: x })
    const levels = meter.levels()
    expect(levels.integrated).toBeCloseTo(db(0.25), 1)
    expect(levels.samplePeakDb).toBeCloseTo(db(0.25), 1)
    expect(levels.truePeakDb).toBeCloseTo(db(0.25), 1)
    const quiet = new MasterMeter(48000)
    quiet.push({ left: new Float32Array(48000), right: new Float32Array(48000) })
    expect(quiet.levels()).toEqual({ integrated: Number.NEGATIVE_INFINITY, samplePeakDb: Number.NEGATIVE_INFINITY, truePeakDb: Number.NEGATIVE_INFINITY })
  })
})
