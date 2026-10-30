// Dynamics for the mix: a stereo-linked compressor and a look-ahead true-peak
// limiter. Both keep their state between calls and work in place on blocks of
// any length, so processing a sound in pieces gives exactly the samples of
// processing it whole. No DOM or Node types: they run in workers and worklets.

/** Linear gain of a level in dB. */
export function dbToGain(db: number): number {
  return 10 ** (db / 20)
}

/** Level in dB of a linear gain (-Infinity for 0). */
export function gainToDb(gain: number): number {
  return 20 * Math.log10(gain)
}

/** Smoothing coefficient of a one-pole filter with time constant `ms`. */
function poleFor(ms: number, sampleRate: number): number {
  return ms <= 0 ? 0 : Math.exp(-1 / ((ms / 1000) * sampleRate))
}

/** Settings of a `Compressor`. */
export interface CompressorOptions {
  sampleRate: number
  /** Level above which the gain is reduced, dBFS. */
  thresholdDb: number
  /** Width of the soft knee around the threshold, dB (0 is a hard knee). */
  kneeDb: number
  /** Input dB per output dB above the threshold (1 does nothing). */
  ratio: number
  attackMs: number
  releaseMs: number
  /** Gain added after compressing, dB. */
  makeupDb: number
}

/**
 * A feed-forward compressor. One level detector sees the louder of the two
 * channels, so both get the same gain and the stereo image holds. The gain
 * reduction is smoothed in dB, quickly when it grows (attack) and slowly
 * when it shrinks (release). Adds no delay.
 */
export class Compressor {
  private readonly threshold: number
  private readonly knee: number
  private readonly slope: number
  private readonly attack: number
  private readonly release: number
  private readonly makeup: number
  /** Current gain reduction, dB (0 or below). */
  private reduction = 0

  constructor(options: CompressorOptions) {
    this.threshold = options.thresholdDb
    this.knee = Math.max(0, options.kneeDb)
    this.slope = 1 / Math.max(1, options.ratio) - 1
    this.attack = poleFor(options.attackMs, options.sampleRate)
    this.release = poleFor(options.releaseMs, options.sampleRate)
    this.makeup = options.makeupDb
  }

  /** The gain reduction (dB, 0 or below) that a level of `levelDb` calls for. */
  private target(levelDb: number): number {
    const over = levelDb - this.threshold
    if (2 * over < -this.knee) return 0
    if (2 * Math.abs(over) <= this.knee) {
      // Quadratic knee: the slope bends in smoothly across the knee width.
      const into = over + this.knee / 2
      return (this.slope * into * into) / (2 * this.knee)
    }
    return this.slope * over
  }

  /** Compresses both channels in place. */
  process(left: Float32Array, right: Float32Array): void {
    const length = Math.min(left.length, right.length)
    let reduction = this.reduction
    for (let i = 0; i < length; i++) {
      const l = left[i]!
      const r = right[i]!
      const peak = Math.max(Math.abs(l), Math.abs(r), 1e-9)
      const target = this.target(20 * Math.log10(peak))
      const pole = target < reduction ? this.attack : this.release
      reduction = pole * reduction + (1 - pole) * target
      const gain = dbToGain(reduction + this.makeup)
      left[i] = l * gain
      right[i] = r * gain
    }
    this.reduction = reduction
  }
}

/** Settings of a `Limiter`. */
export interface LimiterOptions {
  sampleRate: number
  /** Highest level the output may reach, dBFS. */
  ceilingDb: number
  /** How far ahead the limiter looks, ms (default 1.5). */
  lookaheadMs?: number
  /** How slowly the gain recovers after a peak, ms (default 80). */
  releaseMs?: number
}

/** Samples of input a peak estimate needs after the sample it belongs to. */
const TAPS_AHEAD = 2

/**
 * How far under its ceiling the limiter aims, dB. The cubic estimate reads
 * peaks between samples a little low, and a lossy encoder (AAC) adds a
 * tenth or two, so aiming at the ceiling itself left exports at −0.8 dBTP
 * against a −1 dB ceiling. The final clamp stays at the ceiling.
 */
export const LIMITER_HEADROOM_DB = 0.5

/**
 * A look-ahead brickwall limiter that watches the peaks between samples too.
 *
 * The sound is delayed by `latency` samples, which is the look-ahead,
 * `max(3, round(lookaheadMs * rate / 1000))`. Every sample needs a gain of at
 * most ceiling / peak, where the peak is the larger of the sample and of three
 * cubic estimates between it and the next (4x oversampling). The smallest
 * need in the look-ahead window is averaged over the window, so the gain is
 * fully down when the peak is played and falls smoothly before it. After a
 * peak the gain recovers with a one-pole release. A last clamp at the ceiling
 * makes it a guarantee; `clamped` counts the samples it had to cut.
 */
export class Limiter {
  /** Samples the output is behind the input. */
  readonly latency: number
  /** Samples the final clamp had to cut; stays 0 for normal sound. */
  clamped = 0
  private readonly ceiling: number
  private readonly clampTo: number
  private readonly release: number
  /** Length of the gain ramp: the look-ahead minus the samples the peak estimate waits for. */
  private readonly ramp: number
  // The delay line of the sound, per channel, as a ring.
  private readonly delayL: Float32Array
  private readonly delayR: Float32Array
  private delayAt = 0
  // The last four input samples per channel: x[i-3] .. x[i].
  private readonly hist = new Float64Array(8)
  // Sliding minimum of the needs: indices and values of a monotonic queue, as a ring.
  private readonly queueIdx: Float64Array
  private readonly queueVal: Float64Array
  private queueHead = 0
  private queueCount = 0
  private needIndex = 0
  // Moving average of the minimums, as a ring with a running sum.
  private readonly average: Float64Array
  private averageAt = 0
  private averageSum: number
  private gain = 1

  constructor(options: LimiterOptions) {
    const lookaheadMs = options.lookaheadMs ?? 1.5
    this.latency = Math.max(TAPS_AHEAD + 1, Math.round((lookaheadMs * options.sampleRate) / 1000))
    this.ramp = this.latency - TAPS_AHEAD
    // Aims under the ceiling (see LIMITER_HEADROOM_DB), so true peaks stay under it.
    this.ceiling = dbToGain(options.ceilingDb - LIMITER_HEADROOM_DB)
    let clampTo = Math.fround(dbToGain(options.ceilingDb))
    if (clampTo > dbToGain(options.ceilingDb)) clampTo = Math.fround(clampTo * (1 - 1e-7))
    this.clampTo = clampTo
    this.release = poleFor(options.releaseMs ?? 80, options.sampleRate)
    this.delayL = new Float32Array(this.latency)
    this.delayR = new Float32Array(this.latency)
    this.queueIdx = new Float64Array(this.ramp + 2)
    this.queueVal = new Float64Array(this.ramp + 2)
    this.average = new Float64Array(this.ramp).fill(1)
    this.averageSum = this.ramp
  }

  /** The loudest value, in absolute terms, on the way from sample a1 to a2 (cubic through a0..a3). */
  private static between(a0: number, a1: number, a2: number, a3: number): number {
    const c1 = 0.5 * (a2 - a0)
    const c2 = 0.5 * (2 * a0 - 5 * a1 + 4 * a2 - a3)
    const c3 = 0.5 * (3 * a1 - a0 - 3 * a2 + a3)
    let peak = Math.abs(a1)
    for (let t = 0.25; t < 1; t += 0.25) peak = Math.max(peak, Math.abs(a1 + t * (c1 + t * (c2 + t * c3))))
    return peak
  }

  /** Limits both channels in place; the output is the input `latency` samples earlier. */
  process(left: Float32Array, right: Float32Array): void {
    const length = Math.min(left.length, right.length)
    const { hist, queueIdx, queueVal, average, ramp } = this
    const capacity = queueIdx.length
    for (let i = 0; i < length; i++) {
      const inL = left[i]!
      const inR = right[i]!
      // Shift the history and add the new sample.
      for (let c = 0; c < 2; c++) {
        const o = c * 4
        hist[o] = hist[o + 1]!
        hist[o + 1] = hist[o + 2]!
        hist[o + 2] = hist[o + 3]!
        hist[o + 3] = c === 0 ? inL : inR
      }
      // The need of sample k = i - 2, and of the stretch from it to the next sample.
      const peak = Math.max(
        Limiter.between(hist[0]!, hist[1]!, hist[2]!, hist[3]!),
        Limiter.between(hist[4]!, hist[5]!, hist[6]!, hist[7]!),
      )
      const need = peak > this.ceiling ? this.ceiling / peak : 1
      const k = this.needIndex++
      // Sliding minimum over need[k-ramp .. k].
      while (this.queueCount > 0) {
        const back = (this.queueHead + this.queueCount - 1) % capacity
        if (queueVal[back]! >= need) this.queueCount--
        else break
      }
      const slot = (this.queueHead + this.queueCount) % capacity
      queueIdx[slot] = k
      queueVal[slot] = need
      this.queueCount++
      while (queueIdx[this.queueHead]! < k - ramp) {
        this.queueHead = (this.queueHead + 1) % capacity
        this.queueCount--
      }
      const minimum = queueVal[this.queueHead]!
      // Moving average of the minimums over the ramp.
      this.averageSum += minimum - average[this.averageAt]!
      average[this.averageAt] = minimum
      this.averageAt = (this.averageAt + 1) % ramp
      if (this.averageAt === 0) {
        // Re-sum now and then so rounding never leaves the sum off from 'all ones'.
        let sum = 0
        for (let j = 0; j < ramp; j++) sum += average[j]!
        this.averageSum = sum
      }
      const smooth = Math.min(1, this.averageSum / ramp)
      // Down at once with the ramp, up slowly.
      this.gain = smooth < this.gain ? smooth : smooth + this.release * (this.gain - smooth)
      // Play the delayed sample.
      const outL = this.delayL[this.delayAt]! * this.gain
      const outR = this.delayR[this.delayAt]! * this.gain
      this.delayL[this.delayAt] = inL
      this.delayR[this.delayAt] = inR
      this.delayAt = (this.delayAt + 1) % this.latency
      left[i] = this.clamp(outL)
      right[i] = this.clamp(outR)
    }
  }

  private clamp(value: number): number {
    if (value > this.clampTo) {
      this.clamped++
      return this.clampTo
    }
    if (value < -this.clampTo) {
      this.clamped++
      return -this.clampTo
    }
    return value
  }

  /** Plays out the sound still inside the delay (the last `latency` samples) by feeding silence. */
  flush(): { left: Float32Array; right: Float32Array } {
    const left = new Float32Array(this.latency)
    const right = new Float32Array(this.latency)
    this.process(left, right)
    return { left, right }
  }
}
