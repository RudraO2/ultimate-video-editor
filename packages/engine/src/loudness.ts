// A loudness meter after ITU-R BS.1770 / EBU R128: K-weighting, 100 ms blocks,
// 400 ms momentary windows and the two-stage gate for integrated loudness.
// All channels weigh 1 (no surround weights). Works on any sample rate, in
// small pieces, with no DOM or Node types.

/** Length of one measurement block, ms. A momentary window is four of them. */
export const LOUDNESS_BLOCK_MS = 100

/** Blocks quieter than this never count towards integrated loudness, LUFS. */
const ABSOLUTE_GATE_LUFS = -70
/** Blocks this far below the mean of the blocks above the absolute gate are dropped, LU. */
const RELATIVE_GATE_LU = -10
/** Blocks in one 400 ms window. */
const WINDOW_BLOCKS = 4
/** Energy below this counts as silence. */
const SILENCE_ENERGY = 1e-12

/** One biquad: y = b0 x + b1 x1 + b2 x2 - a1 y1 - a2 y2 (a0 is 1). */
export interface Biquad {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

/** The two filters of K-weighting. */
export interface KWeighting {
  /** High shelf, about +4 dB above 1.7 kHz: the head's acoustics. */
  shelf: Biquad
  /** High-pass at about 38 Hz. */
  highpass: Biquad
}

/**
 * The K-weighting filters for a sample rate. The analog prototypes are
 * mapped with the bilinear transform; at 48 kHz this gives the numbers in
 * the BS.1770 table.
 */
export function kWeighting(sampleRate: number): KWeighting {
  // High shelf
  const shelfF = 1681.974450955533
  const shelfGainDb = 3.999843853973347
  const shelfQ = 0.7071752369554196
  const k1 = Math.tan((Math.PI * shelfF) / sampleRate)
  const vh = 10 ** (shelfGainDb / 20)
  const vb = vh ** 0.4996667741545416
  const a0 = 1 + k1 / shelfQ + k1 * k1
  const shelf: Biquad = {
    b0: (vh + (vb * k1) / shelfQ + k1 * k1) / a0,
    b1: (2 * (k1 * k1 - vh)) / a0,
    b2: (vh - (vb * k1) / shelfQ + k1 * k1) / a0,
    a1: (2 * (k1 * k1 - 1)) / a0,
    a2: (1 - k1 / shelfQ + k1 * k1) / a0,
  }
  // High-pass
  const hpF = 38.13547087602444
  const hpQ = 0.5003270373238773
  const k2 = Math.tan((Math.PI * hpF) / sampleRate)
  const d0 = 1 + k2 / hpQ + k2 * k2
  const highpass: Biquad = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (k2 * k2 - 1)) / d0,
    a2: (1 - k2 / hpQ + k2 * k2) / d0,
  }
  return { shelf, highpass }
}

/** Loudness in LUFS of a mean-square energy; -Infinity for silence. */
export function energyToLufs(energy: number): number {
  return energy <= SILENCE_ENERGY ? Number.NEGATIVE_INFINITY : -0.691 + 10 * Math.log10(energy)
}

/** The energy that has a loudness in LUFS (inverse of `energyToLufs`). */
export function lufsToEnergy(lufs: number): number {
  return 10 ** ((lufs + 0.691) / 10)
}

/** Filter memory of one channel: two stages, two taps each. */
interface ChannelState {
  s1x1: number
  s1x2: number
  s1y1: number
  s1y2: number
  s2x1: number
  s2x2: number
  s2y1: number
  s2y2: number
}

const freshState = (): ChannelState => ({
  s1x1: 0,
  s1x2: 0,
  s1y1: 0,
  s1y2: 0,
  s2x1: 0,
  s2x2: 0,
  s2y1: 0,
  s2y2: 0,
})

/** The mean of the energies of the four blocks starting at `start`; blocks past the end count as zero. */
function windowEnergy(blocks: ArrayLike<number>, start: number): number {
  let sum = 0
  for (let i = 0; i < WINDOW_BLOCKS; i++) sum += start + i < blocks.length ? blocks[start + i]! : 0
  return sum / WINDOW_BLOCKS
}

/**
 * A streaming loudness meter. Push sound in pieces of any length; it
 * keeps the energy of every finished 100 ms block and answers with
 * integrated and momentary loudness.
 */
export class LoudnessMeter {
  readonly sampleRate: number
  /** Samples in one block. */
  readonly blockSamples: number
  private readonly filters: KWeighting
  private readonly states: ChannelState[] = []
  private readonly energies: number[] = []
  /** Summed squares of the block being filled, all channels. */
  private acc = 0
  private filled = 0

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate
    this.blockSamples = Math.max(1, Math.round((sampleRate * LOUDNESS_BLOCK_MS) / 1000))
    this.filters = kWeighting(sampleRate)
  }

  /** Feeds the next samples of every channel (all the same length). */
  push(channels: readonly Float32Array[]): void {
    const length = channels[0]?.length ?? 0
    while (this.states.length < channels.length) this.states.push(freshState())
    const { shelf: f1, highpass: f2 } = this.filters
    let at = 0
    while (at < length) {
      const end = Math.min(length, at + this.blockSamples - this.filled)
      for (let c = 0; c < channels.length; c++) {
        const data = channels[c]!
        const s = this.states[c]!
        let sum = 0
        for (let i = at; i < end; i++) {
          const x = data[i]!
          const y1 = f1.b0 * x + f1.b1 * s.s1x1 + f1.b2 * s.s1x2 - f1.a1 * s.s1y1 - f1.a2 * s.s1y2
          s.s1x2 = s.s1x1
          s.s1x1 = x
          s.s1y2 = s.s1y1
          s.s1y1 = y1
          const y2 = f2.b0 * y1 + f2.b1 * s.s2x1 + f2.b2 * s.s2x2 - f2.a1 * s.s2y1 - f2.a2 * s.s2y2
          s.s2x2 = s.s2x1
          s.s2x1 = y1
          s.s2y2 = s.s2y1
          s.s2y1 = y2
          sum += y2 * y2
        }
        this.acc += sum
      }
      this.filled += end - at
      at = end
      if (this.filled === this.blockSamples) {
        this.energies.push(this.acc / this.blockSamples)
        this.acc = 0
        this.filled = 0
      }
    }
  }

  /** Mean-square energy of every finished 100 ms block so far. */
  blocks(): Float32Array {
    return Float32Array.from(this.energies)
  }

  /** Finished blocks, plus the unfinished one padded with silence. */
  private paddedBlocks(): number[] {
    return this.filled > 0 ? [...this.energies, this.acc / this.blockSamples] : this.energies
  }

  /**
   * Loudness (LUFS) of the 400 ms window that starts at block `block`.
   * An unfinished last block and anything past the end count as silence.
   * -Infinity when the window starts past the end.
   */
  momentaryAt(block: number): number {
    const blocks = this.paddedBlocks()
    if (block < 0 || block >= blocks.length) return Number.NEGATIVE_INFINITY
    return energyToLufs(windowEnergy(blocks, block))
  }

  /** Loudness (LUFS) of the loudest 400 ms window; a sound shorter than that counts as padded with silence. */
  maxMomentary(): number {
    const blocks = this.paddedBlocks()
    let best = 0
    for (let k = 0; k < Math.max(1, blocks.length - WINDOW_BLOCKS + 1); k++) {
      best = Math.max(best, windowEnergy(blocks, k))
    }
    return energyToLufs(best)
  }

  /**
   * Integrated loudness (LUFS) with the BS.1770 gate: 400 ms windows every
   * 100 ms; windows below -70 LUFS are dropped, then those more than 10 LU
   * below the mean of the rest. -Infinity when nothing passes. Fewer than
   * four finished blocks make one window, padded with silence.
   */
  integrated(): number {
    const energies: number[] = []
    if (this.energies.length >= WINDOW_BLOCKS) {
      for (let k = 0; k + WINDOW_BLOCKS <= this.energies.length; k++) energies.push(windowEnergy(this.energies, k))
    } else if (this.filled > 0 || this.energies.length > 0) {
      energies.push(windowEnergy(this.paddedBlocks(), 0))
    }
    const mean = (list: number[]) => list.reduce((a, b) => a + b, 0) / list.length
    const absolute = energies.filter((e) => energyToLufs(e) > ABSOLUTE_GATE_LUFS)
    if (absolute.length === 0) return Number.NEGATIVE_INFINITY
    const relativeGate = energyToLufs(mean(absolute)) + RELATIVE_GATE_LU
    const kept = absolute.filter((e) => energyToLufs(e) > relativeGate)
    if (kept.length === 0) return Number.NEGATIVE_INFINITY
    return energyToLufs(mean(kept))
  }
}

/** A stretch of time in ms. */
export interface TimeRange {
  startMs: number
  endMs: number
}

/**
 * The stretches where a sound is sounding: 100 ms blocks whose own loudness
 * is above `thresholdLufs`, joined across gaps of at most `mergeGapMs`.
 * Times are in ms from the first block.
 */
export function activeRanges(
  blockEnergies: ArrayLike<number>,
  thresholdLufs = -45,
  mergeGapMs = 350,
): TimeRange[] {
  const ranges: TimeRange[] = []
  for (let i = 0; i < blockEnergies.length; i++) {
    if (!(energyToLufs(blockEnergies[i]!) > thresholdLufs)) continue
    const startMs = i * LOUDNESS_BLOCK_MS
    const endMs = startMs + LOUDNESS_BLOCK_MS
    const last = ranges[ranges.length - 1]
    if (last && startMs - last.endMs <= mergeGapMs) last.endMs = endMs
    else ranges.push({ startMs, endMs })
  }
  return ranges
}

/** Integrated loudness, loudest momentary loudness and block energies of a whole sound. */
export function measure(
  channels: readonly Float32Array[],
  sampleRate: number,
): { integrated: number; maxMomentary: number; blocks: Float32Array } {
  const meter = new LoudnessMeter(sampleRate)
  meter.push(channels)
  return { integrated: meter.integrated(), maxMomentary: meter.maxMomentary(), blocks: meter.blocks() }
}

/** Taps of the true-peak interpolator per phase (BS.1770-4 uses 12 per phase for 4x oversampling). */
const TRUE_PEAK_TAPS = 12
/** Oversampling factor of the true-peak estimate. */
const TRUE_PEAK_FACTOR = 4

/** The 3 interpolation phases (1/4, 2/4, 3/4 of the way to the next sample): Hann-windowed sinc, each summing to 1. */
const TRUE_PEAK_PHASES: readonly Float64Array[] = Array.from({ length: TRUE_PEAK_FACTOR - 1 }, (_, p) => {
  const frac = (p + 1) / TRUE_PEAK_FACTOR
  const half = TRUE_PEAK_TAPS / 2
  const taps = new Float64Array(TRUE_PEAK_TAPS)
  let sum = 0
  for (let j = 0; j < TRUE_PEAK_TAPS; j++) {
    // Tap j weighs the sample at offset (j - half + 1) from the one the phase follows.
    const x = j - half + 1 - frac
    const sinc = Math.sin(Math.PI * x) / (Math.PI * x)
    taps[j] = sinc * (0.5 + 0.5 * Math.cos((Math.PI * x) / half))
    sum += taps[j]!
  }
  for (let j = 0; j < TRUE_PEAK_TAPS; j++) taps[j]! /= sum
  return taps
})

/**
 * A streaming true-peak meter: the largest sample, and the largest value
 * between samples by 4x oversampling (12-tap windowed sinc, after BS.1770-4).
 * Push sound in pieces of any length, call `finish` once at the end (it plays
 * out the interpolator's last samples), then read the peaks.
 */
export class TruePeakMeter {
  private readonly rings: Float64Array[] = []
  private at = 0
  private sample = 0
  private between = 0

  /** Feeds the next samples of every channel (all the same length). */
  push(channels: readonly Float32Array[]): void {
    while (this.rings.length < channels.length) this.rings.push(new Float64Array(TRUE_PEAK_TAPS))
    const length = channels[0]?.length ?? 0
    for (let i = 0; i < length; i++) {
      for (let c = 0; c < channels.length; c++) this.add(c, channels[c]![i]!)
      this.at = (this.at + 1) % TRUE_PEAK_TAPS
    }
  }

  /** Plays out the samples the interpolator still holds. */
  finish(): void {
    const silence = new Float32Array(TRUE_PEAK_TAPS / 2)
    this.push(this.rings.map(() => silence))
  }

  /** Largest absolute sample, linear. */
  samplePeak(): number {
    return this.sample
  }

  /** Largest absolute value including the points between samples, linear (never below `samplePeak`). */
  truePeak(): number {
    return Math.max(this.sample, this.between)
  }

  private add(channel: number, x: number): void {
    const ring = this.rings[channel]!
    ring[this.at] = x
    const abs = Math.abs(x)
    if (abs > this.sample) this.sample = abs
    // The ring now ends with x; the phases follow the sample half a window back.
    for (const taps of TRUE_PEAK_PHASES) {
      let sum = 0
      for (let j = 0; j < TRUE_PEAK_TAPS; j++) sum += taps[j]! * ring[(this.at + 1 + j) % TRUE_PEAK_TAPS]!
      const value = Math.abs(sum)
      if (value > this.between) this.between = value
    }
  }
}

/** What a `MasterMeter` read. */
export interface MasterLevels {
  /** Integrated loudness, LUFS (-Infinity when silent). */
  integrated: number
  /** Largest sample, dBFS (-Infinity when silent). */
  samplePeakDb: number
  /** Largest value between samples too, dBTP (-Infinity when silent). */
  truePeakDb: number
}

/** Loudness and peaks of a stereo master, fed in pieces. */
export class MasterMeter {
  private readonly loudness: LoudnessMeter
  private readonly peaks = new TruePeakMeter()

  constructor(sampleRate: number) {
    this.loudness = new LoudnessMeter(sampleRate)
  }

  push(sound: { left: Float32Array; right: Float32Array }): void {
    if (sound.left.length === 0) return
    this.loudness.push([sound.left, sound.right])
    this.peaks.push([sound.left, sound.right])
  }

  /** Reads the levels; call after the last `push` (it flushes the true-peak filter, so push nothing after). */
  levels(): MasterLevels {
    this.peaks.finish()
    const db = (gain: number) => (gain > 0 ? 20 * Math.log10(gain) : Number.NEGATIVE_INFINITY)
    return { integrated: this.loudness.integrated(), samplePeakDb: db(this.peaks.samplePeak()), truePeakDb: db(this.peaks.truePeak()) }
  }
}
