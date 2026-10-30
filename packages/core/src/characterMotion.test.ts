import { describe, expect, it } from 'vitest'
import {
  blinkAt,
  blinkWindows,
  breatheAt,
  envelopeAt,
  envelopeFromSamples,
  glanceAt,
  hash01,
  mouthMember,
  MOUTH_SHAPES,
  seedOf,
  swayAt,
  talkBlocks,
  talkShapeAt,
  type BlinkParams,
  type Envelope,
} from './characterMotion'

const BLINK: BlinkParams = { every: 4, closedMs: 120, variance: 40, doubles: 17, seed: 7 }

describe('hashing', () => {
  it('is deterministic, in [0, 1) and spread', () => {
    expect(hash01(1, 2, 3)).toBe(hash01(1, 2, 3))
    expect(hash01(1, 2, 3)).not.toBe(hash01(3, 2, 1))
    let sum = 0
    for (let i = 0; i < 2000; i++) {
      const h = hash01(5, i)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThan(1)
      sum += h
    }
    expect(sum / 2000).toBeGreaterThan(0.45)
    expect(sum / 2000).toBeLessThan(0.55)
  })
  it('seeds from text (FNV-1a)', () => {
    expect(seedOf('')).toBe(0x811c9dc5)
    expect(seedOf('a')).toBe(0xe40c292c)
    expect(seedOf('hello')).toBe(seedOf('hello'))
    expect(seedOf('hello')).not.toBe(seedOf('hellp'))
  })
})

describe('blinks', () => {
  it('is deterministic', () => {
    expect(blinkWindows(BLINK, 60000)).toEqual(blinkWindows({ ...BLINK }, 60000))
  })
  it('starts the first blink in [0.3 P, P]', () => {
    for (let seed = 0; seed < 50; seed++) {
      const w = blinkWindows({ ...BLINK, seed }, 20000)
      expect(w[0]!.startMs).toBeGreaterThanOrEqual(0.3 * 4000)
      expect(w[0]!.startMs).toBeLessThanOrEqual(4000)
    }
  })
  it('keeps gaps within P*[0.6, 1.4] and about 17 % doubles', () => {
    const p = { ...BLINK, variance: 40, seed: 11 }
    const w = blinkWindows(p, 120000)
    const firsts: number[] = []
    for (let i = 0; i < w.length; i++) {
      const prev = firsts[firsts.length - 1]
      if (prev !== undefined && w[i]!.startMs - prev < 3.5 * 120) {
        expect(w[i]!.startMs - prev).toBeCloseTo(2.2 * 120, 6)
        expect(w[i]!.endMs - w[i]!.startMs).toBeCloseTo(120, 6)
      } else firsts.push(w[i]!.startMs)
    }
    for (let i = 1; i < firsts.length; i++) {
      const gap = firsts[i]! - firsts[i - 1]!
      expect(gap).toBeGreaterThanOrEqual(4000 * 0.6 - 1e-6)
      expect(gap).toBeLessThanOrEqual(4000 * 1.4 + 1e-6)
    }
    // A long run: share of doubles near 17 % (loose).
    const long = blinkWindows({ ...p, every: 1 }, 4_000_000)
    const second = long.filter((b, i) => i > 0 && b.startMs - long[i - 1]!.startMs < 3.5 * 120).length
    const share = second / (long.length - second)
    expect(share).toBeGreaterThan(0.1)
    expect(share).toBeLessThan(0.25)
  })
  it('reads shut, half and open per frame', () => {
    const w = blinkWindows(BLINK, 20000)[0]!
    expect(blinkAt(BLINK, -5)).toBe(0)
    expect(blinkAt(BLINK, w.startMs - 1)).toBe(0)
    expect(blinkAt(BLINK, w.startMs + 1)).toBe(0.5)
    expect(blinkAt(BLINK, w.startMs + 60)).toBe(1)
    expect(blinkAt(BLINK, w.endMs - 1)).toBe(0.5)
    expect(blinkAt(BLINK, w.endMs + 1)).toBe(0)
    // Lazy extension agrees with a fresh list.
    const far = blinkWindows(BLINK, 90000)
    const late = far[far.length - 1]!
    expect(blinkAt(BLINK, late.startMs + 60)).toBe(1)
  })
})

describe('breathe and sway', () => {
  const b = { amount: 3, rate: 15, phase: 0 }
  it('is 0 at t = 0 and peaks at half a period', () => {
    expect(breatheAt(b, 0)).toBeCloseTo(0, 12)
    expect(breatheAt(b, 2000)).toBeCloseTo(0.03, 12)
    expect(breatheAt(b, 4000)).toBeCloseTo(0, 12)
    expect(breatheAt({ ...b, phase: 50 }, 0)).toBeCloseTo(0.03, 12)
  })
  it('sways within ± amount, deterministically, and actually moves', () => {
    const p = { amount: 5, speed: 0.4, seed: 3 }
    let min = Infinity
    let max = -Infinity
    for (let t = 0; t < 60000; t += 37) {
      const v = swayAt(p, t)
      expect(Math.abs(v)).toBeLessThanOrEqual(5)
      expect(v).toBe(swayAt({ ...p }, t))
      min = Math.min(min, v)
      max = Math.max(max, v)
    }
    expect(max - min).toBeGreaterThan(2)
  })
})

describe('glance', () => {
  const g = { rangeX: 12, rangeY: 6, hold: 1.2, moveMs: 150, centre: 40, seed: 9 }
  it('starts at the centre, stays in range, returns to centre sometimes', () => {
    expect(glanceAt(g, 0)).toEqual({ x: 0, y: 0 })
    expect(glanceAt(g, -10)).toEqual({ x: 0, y: 0 })
    let centred = 0
    let off = 0
    for (let t = 0; t < 120000; t += 100) {
      const { x, y } = glanceAt(g, t)
      expect(Math.abs(x)).toBeLessThanOrEqual(12 + 1e-9)
      expect(Math.abs(y)).toBeLessThanOrEqual(6 + 1e-9)
      expect(glanceAt({ ...g }, t)).toEqual({ x, y })
      if (x === 0 && y === 0) centred++
      else off++
    }
    expect(centred).toBeGreaterThan(50)
    expect(off).toBeGreaterThan(50)
  })
  it('eases between targets', () => {
    // Find a target change and check the move is monotone from one hold to the next.
    let prev = glanceAt(g, 0)
    let moved = false
    for (let t = 1; t < 30000 && !moved; t++) {
      const cur = glanceAt(g, t)
      if (cur.x !== prev.x) {
        moved = true
        const later = glanceAt(g, t + 400)
        expect(Math.abs(later.x - prev.x)).toBeGreaterThan(Math.abs(cur.x - prev.x) - 1e-9)
      }
      prev = cur
    }
    expect(moved).toBe(true)
  })
})

/** A mono test signal: 440 Hz bursts with silence around them. */
function burst(sampleRate: number, segments: Array<[number, number, number]>, total: number): Float32Array {
  const out = new Float32Array(Math.round(total * sampleRate))
  for (const [from, to, amp] of segments) {
    for (let i = Math.round(from * sampleRate); i < Math.round(to * sampleRate); i++) {
      out[i] = amp * Math.sin((2 * Math.PI * 440 * i) / sampleRate)
    }
  }
  return out
}

describe('envelope', () => {
  const sr = 16000
  const env = envelopeFromSamples(burst(sr, [[0.5, 1.5, 0.5]], 2.5), sr)
  it('is near 1 inside the burst and 0 in silence', () => {
    expect(env.rate).toBe(100)
    expect(env.values.length).toBe(250)
    expect(envelopeAt(env, 1000)).toBeGreaterThan(0.97)
    expect(envelopeAt(env, 200)).toBe(0)
    expect(envelopeAt(env, 2300)).toBe(0)
    expect(envelopeAt(env, -5)).toBe(0)
    expect(envelopeAt(env, 99999)).toBe(0)
    for (const v of env.values) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
      expect(v).toBe(Math.round(v * 1000) / 1000)
    }
  })
  it('attacks faster than it releases', () => {
    const rise = env.values.findIndex((v, i) => i >= 50 && v > 0.63) - 50
    const fall = env.values.findIndex((v, i) => i >= 150 && v < 0.37) - 150
    expect(rise).toBeGreaterThanOrEqual(0)
    expect(fall).toBeGreaterThan(rise)
    // Release ends near zero within half a second.
    expect(envelopeAt(env, 2100)).toBeLessThan(0.01)
  })
  it('interpolates and handles silence', () => {
    expect(envelopeAt({ rate: 100, values: [0, 1] }, 5)).toBeCloseTo(0.5, 12)
    const silent = envelopeFromSamples(new Float32Array(8000), 8000)
    expect(silent.values.length).toBe(100)
    expect(silent.values.every((v) => v === 0)).toBe(true)
    expect(envelopeFromSamples(new Float32Array(0), 8000).values).toEqual([])
  })
  it('puts a 20 dB quieter burst well below a loud one', () => {
    const e = envelopeFromSamples(burst(sr, [[0.2, 1.2, 0.5], [1.5, 2.5, 0.05]], 3), sr)
    expect(envelopeAt(e, 0.9 * 1000)).toBeGreaterThan(0.95)
    expect(envelopeAt(e, 2.2 * 1000)).toBeGreaterThan(0.4)
    expect(envelopeAt(e, 2.2 * 1000)).toBeLessThan(0.65)
  })
})

describe('talk', () => {
  const opts = { fromMs: 0, toMs: 2500, lead: 40, frameMs: 1000 / 30, seed: 5 }
  it('is one rest block over silence', () => {
    const silent: Envelope = { rate: 100, values: new Array<number>(250).fill(0) }
    expect(talkBlocks(silent, opts)).toEqual([{ startMs: 0, endMs: 2500, shape: 'X' }])
    expect(talkBlocks(silent, { ...opts, toMs: 0 })).toEqual([])
  })
  it('makes held, frame-aligned, gapless blocks from speech-like loudness', () => {
    // Syllables: loud/soft pulses every ~180 ms with a pause in the middle.
    const values: number[] = []
    for (let i = 0; i < 250; i++) {
      const talking = i < 100 || i > 150
      values.push(talking ? 0.35 + 0.35 * Math.abs(Math.sin((i * Math.PI) / 18)) : 0)
    }
    const env: Envelope = { rate: 100, values }
    const blocks = talkBlocks(env, opts)
    expect(blocks.length).toBeGreaterThan(3)
    expect(talkBlocks(env, { ...opts })).toBe(blocks)
    expect(blocks[0]!.startMs).toBe(0)
    expect(blocks[blocks.length - 1]!.endMs).toBe(2500)
    blocks.forEach((b, i) => {
      expect(MOUTH_SHAPES).toContain(b.shape)
      const frames = (b.startMs - opts.fromMs) / opts.frameMs
      expect(Math.abs(frames - Math.round(frames))).toBeLessThan(1e-9)
      if (i > 0) {
        expect(b.startMs).toBe(blocks[i - 1]!.endMs)
        expect(b.shape).not.toBe(blocks[i - 1]!.shape)
      }
      // Holds, except the last block, which the clip end may cut short.
      if (i < blocks.length - 1 && i > 0) expect(b.endMs - b.startMs).toBeGreaterThanOrEqual(opts.frameMs - 1e-9)
    })
    // The pause shows a closed or resting mouth.
    expect(['X', 'MBP']).toContain(talkShapeAt(blocks, 1250))
    expect(talkShapeAt(blocks, -5)).toBe('X')
    expect(talkShapeAt(blocks, 9999)).toBe('X')
  })
  it('leads the sound', () => {
    const values = new Array<number>(100).fill(0)
    for (let i = 40; i < 100; i++) values[i] = 0.9
    const env: Envelope = { rate: 100, values }
    const blocks = talkBlocks(env, { fromMs: 0, toMs: 1000, lead: 100, frameMs: 10, seed: 1 })
    const speech = blocks.find((b) => b.shape !== 'X')!
    expect(speech.startMs).toBeLessThanOrEqual(310)
    expect(speech.startMs).toBeGreaterThanOrEqual(250)
  })
  it('uses the clip offset as the frame grid origin', () => {
    const env: Envelope = { rate: 100, values: Array.from({ length: 300 }, (_, i) => (i % 40 < 20 ? 0.8 : 0.05)) }
    const o = { fromMs: 505, toMs: 2500, lead: 30, frameMs: 40, seed: 2 }
    for (const b of talkBlocks(env, o)) expect(((b.startMs - 505) / 40) % 1).toBeCloseTo(0, 9)
  })
})

describe('mouthMember', () => {
  it('matches names loosely, then aliases', () => {
    expect(mouthMember('AI', ['Rest', 'Wide', 'Round'])).toBe(1)
    expect(mouthMember('X', ['mouth_rest', 'rest'])).toBe(1)
    expect(mouthMember('O', ['Rest', 'Oh!', 'Wide'])).toBe(1)
    expect(mouthMember('U', ['x', 'W-oo', 'oo'])).toBe(2)
    expect(mouthMember('E', ['closed', 'Smile', 'open'])).toBe(1)
    expect(mouthMember('MBP', ['rest', 'P', 'open'])).toBe(1)
    expect(mouthMember('mbp', ['MBP', 'X'])).toBe(0)
  })
  it('lets the map win', () => {
    expect(mouthMember('AI', ['rest', 'open', 'big'], { ai: 'Big' })).toBe(2)
    expect(mouthMember('AI', ['rest', 'open', 'big'], { AI: 'missing' })).toBe(1)
  })
  it('falls back through near shapes', () => {
    expect(mouthMember('U', ['rest', 'round', 'open'])).toBe(1)
    expect(mouthMember('U', ['rest', 'open'])).toBe(1)
    expect(mouthMember('E', ['rest', 'open'])).toBe(1)
    expect(mouthMember('MBP', ['rest', 'open'])).toBe(0)
  })
  it('falls back to the position when names are unknown', () => {
    const names = ['m0', 'm1', 'm2', 'm3', 'm4']
    expect(mouthMember('X', names)).toBe(0)
    expect(mouthMember('MBP', names)).toBe(0)
    expect(mouthMember('E', names)).toBe(2)
    expect(mouthMember('U', names)).toBe(1)
    expect(mouthMember('O', names)).toBe(3)
    expect(mouthMember('AI', names)).toBe(4)
    expect(mouthMember('AI', [])).toBe(-1)
  })
})
