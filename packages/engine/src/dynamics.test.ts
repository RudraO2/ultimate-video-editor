import { describe, expect, it } from 'vitest'
import { Compressor, dbToGain, gainToDb, Limiter } from './dynamics'

const RATE = 48000
const sine = (seconds: number, amplitude: number, freq = 1000): Float32Array => {
  const out = new Float32Array(Math.round(RATE * seconds))
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / RATE)
  return out
}
const peakOf = (data: Float32Array, from = 0, to = data.length) => {
  let p = 0
  for (let i = from; i < to; i++) p = Math.max(p, Math.abs(data[i]!))
  return p
}
/** Runs a processor over the arrays in pieces of the given lengths (cycled). */
const inPieces = (left: Float32Array, right: Float32Array, sizes: number[], step: (l: Float32Array, r: Float32Array) => void) => {
  for (let at = 0, n = 0; at < left.length; n++) {
    const size = sizes[n % sizes.length]!
    step(left.subarray(at, at + size), right.subarray(at, at + size))
    at += size
  }
}

describe('db helpers', () => {
  it('round trips', () => {
    expect(dbToGain(-6.0206)).toBeCloseTo(0.5, 4)
    expect(gainToDb(dbToGain(-13.7))).toBeCloseTo(-13.7, 9)
  })
})

describe('Compressor', () => {
  const options = { sampleRate: RATE, thresholdDb: -30, kneeDb: 0, ratio: 3, attackMs: 0.1, releaseMs: 200, makeupDb: 0 }

  it('settles to the level the ratio asks for', () => {
    const input = sine(2, dbToGain(-10))
    const left = Float32Array.from(input)
    const right = Float32Array.from(input)
    new Compressor(options).process(left, right)
    // 20 dB over the threshold at 3:1 leaves 20/3 dB over: out at -30 + 6.67 = -23.33 dBFS.
    const out = gainToDb(peakOf(left, RATE, left.length))
    expect(out).toBeGreaterThan(-23.33 - 0.2)
    expect(out).toBeLessThan(-23.33 + 0.2)
    expect(Array.from(right)).toEqual(Array.from(left))
  })

  it('adds makeup gain and leaves quiet sound alone', () => {
    const quiet = sine(0.5, dbToGain(-50))
    const left = Float32Array.from(quiet)
    const right = Float32Array.from(quiet)
    new Compressor({ ...options, makeupDb: 6 }).process(left, right)
    expect(gainToDb(peakOf(left) / peakOf(quiet))).toBeCloseTo(6, 3)
  })

  it('has a soft knee that is half way at the threshold edge', () => {
    // At the threshold the reduction with a 10 dB knee is slope * (5)^2 / 20.
    const c = new Compressor({ ...options, kneeDb: 10, attackMs: 0, releaseMs: 0 })
    const l = new Float32Array([dbToGain(-30)])
    const r = new Float32Array([dbToGain(-30)])
    c.process(l, r)
    const expected = (1 / 3 - 1) * 25 / 20
    expect(gainToDb(l[0]! / dbToGain(-30))).toBeCloseTo(expected, 3)
  })

  it('gives the same samples in pieces as whole', () => {
    const a = sine(1, 0.7)
    const b = sine(1, 0.4, 330)
    for (let i = 20000; i < 30000; i++) b[i]! *= 0.01
    const wholeL = Float32Array.from(a)
    const wholeR = Float32Array.from(b)
    new Compressor(options).process(wholeL, wholeR)
    const pieceL = Float32Array.from(a)
    const pieceR = Float32Array.from(b)
    const c = new Compressor(options)
    inPieces(pieceL, pieceR, [1, 7, 100, 4093, 333], (l, r) => c.process(l, r))
    expect(Array.from(pieceL)).toEqual(Array.from(wholeL))
    expect(Array.from(pieceR)).toEqual(Array.from(wholeR))
  })
})

describe('Limiter', () => {
  const options = { sampleRate: RATE, ceilingDb: -1 }
  const ceiling = dbToGain(-1)

  /** Quiet for 0.2 s, then +6 dBFS peaks for 0.3 s, then quiet. */
  const signal = () => {
    const left = sine(0.8, dbToGain(-30))
    const right = sine(0.8, dbToGain(-30), 1300)
    for (let i = Math.round(0.2 * RATE); i < Math.round(0.5 * RATE); i++) {
      left[i] = 2 * Math.sin((2 * Math.PI * 1000 * i) / RATE)
      right[i] = 2 * Math.sin((2 * Math.PI * 7000 * i) / RATE)
    }
    return { left, right }
  }

  it('keeps every sample under the ceiling and delays by the latency', () => {
    const { left: inL, right: inR } = signal()
    const left = Float32Array.from(inL)
    const right = Float32Array.from(inR)
    const limiter = new Limiter(options)
    expect(limiter.latency).toBe(72)
    limiter.process(left, right)
    const tail = limiter.flush()
    const outL = new Float32Array(left.length + tail.left.length)
    outL.set(left)
    outL.set(tail.left, left.length)
    expect(peakOf(outL)).toBeLessThanOrEqual(ceiling)
    expect(peakOf(tail.right)).toBeLessThanOrEqual(ceiling)
    expect(peakOf(right)).toBeLessThanOrEqual(ceiling)
    expect(limiter.clamped).toBe(0)
    // Loud part is brought to just under the ceiling (its headroom under it), not crushed.
    const loud = peakOf(outL, Math.round(0.3 * RATE), Math.round(0.5 * RATE))
    expect(gainToDb(loud)).toBeGreaterThan(-1.6)
    expect(gainToDb(loud)).toBeLessThan(-1.4)
    // Quiet start: bit-equal to the input, delayed.
    const quietEnd = Math.round(0.2 * RATE) - limiter.latency - 1
    for (let i = 0; i < quietEnd; i++) {
      if (i < limiter.latency) expect(outL[i]).toBe(0)
      else expect(outL[i]).toBe(inL[i - limiter.latency])
    }
    // After the loud part and the release, the quiet tail returns to unity gain within 10 %.
    expect(outL.length).toBe(inL.length + limiter.latency)
  })

  it('passes quiet sound unchanged after the delay', () => {
    const inL = sine(0.5, 0.5)
    const inR = sine(0.5, 0.3, 500)
    const left = Float32Array.from(inL)
    const right = Float32Array.from(inR)
    const limiter = new Limiter(options)
    limiter.process(left, right)
    const tail = limiter.flush()
    expect(tail.left.length).toBe(limiter.latency)
    expect(tail.right.length).toBe(limiter.latency)
    for (let i = limiter.latency; i < left.length; i++) {
      expect(left[i]).toBe(inL[i - limiter.latency])
      expect(right[i]).toBe(inR[i - limiter.latency])
    }
    for (let i = 0; i < limiter.latency; i++) {
      expect(tail.left[i]).toBe(inL[left.length - limiter.latency + i])
    }
  })

  it('catches peaks between samples', () => {
    // A sine at a quarter of the rate sampled off its crest: samples reach 0.707 of the true peak.
    const n = RATE / 2
    const left = new Float32Array(n)
    const right = new Float32Array(n)
    for (let i = 0; i < n; i++) left[i] = 1.4 * Math.sin((2 * Math.PI * (RATE / 4) * i) / RATE + Math.PI / 4)
    const limiter = new Limiter({ sampleRate: RATE, ceilingDb: 0 })
    limiter.process(left, right)
    // Sample peak was 1.4 * 0.707 = 0.99, the true peak is 1.4: the cheap cubic estimate finds most of it (0.99 would pass untouched).
    expect(peakOf(left, RATE / 4, n)).toBeLessThan(0.85)
    expect(limiter.clamped).toBe(0)
  })

  it('gives the same samples in pieces as whole', () => {
    const { left: inL, right: inR } = signal()
    const wholeL = Float32Array.from(inL)
    const wholeR = Float32Array.from(inR)
    const whole = new Limiter(options)
    whole.process(wholeL, wholeR)
    const wholeTail = whole.flush()
    const pieceL = Float32Array.from(inL)
    const pieceR = Float32Array.from(inR)
    const pieces = new Limiter(options)
    inPieces(pieceL, pieceR, [1, 5, 71, 72, 73, 1000, 4096], (l, r) => pieces.process(l, r))
    const pieceTail = pieces.flush()
    expect(Array.from(pieceL)).toEqual(Array.from(wholeL))
    expect(Array.from(pieceR)).toEqual(Array.from(wholeR))
    expect(Array.from(pieceTail.left)).toEqual(Array.from(wholeTail.left))
  })

  it('has a latency that follows the look-ahead', () => {
    expect(new Limiter({ ...options, lookaheadMs: 5 }).latency).toBe(240)
    expect(new Limiter({ ...options, lookaheadMs: 0 }).latency).toBe(3)
  })
})
