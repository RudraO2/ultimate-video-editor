import { MIX_SAMPLE_RATE, type Stereo } from './audio'
import { Compressor, Limiter } from './dynamics'
import { type MixPlan, tableAt } from './mixPlan'

// The buses and the master of a mix, run over windows of samples: each bus's
// sound (already levelled per segment and cue) goes through the speech
// compressor, its duck gain and its fader; the buses and the unrouted sound
// meet at the master fader and the limiter. State carries from one window to
// the next, so mixing in pieces sounds the same as mixing at once.

/** The speech compressor on voice buses (AtomCut's settings): gentle, with makeup. */
export const SPEECH_COMPRESSOR = { thresholdDb: -26, kneeDb: 18, ratio: 3, attackMs: 12, releaseMs: 300, makeupDb: 4 } as const

/** The key of sound that goes to no bus. */
export const UNROUTED = ''

/** How a MixStream runs. */
export interface MixStreamOptions {
  /**
   * Measuring: the master comes out as it is before the loudness trim and the
   * limiter (and is not clamped), at once, with no delay. The loudness match
   * measures the mix this way.
   */
  measuring?: boolean
}

export class MixStream {
  private readonly compressors = new Map<string, Compressor>()
  private readonly limiter: Limiter | null
  /** Samples of delay still to drop from the front of the output. */
  private pendingDrop: number
  /** Samples cut at full scale with the limiter off. */
  private cut = 0

  constructor(
    private readonly plan: MixPlan,
    private readonly sampleRate = MIX_SAMPLE_RATE,
    private readonly options: MixStreamOptions = {},
  ) {
    for (const bus of plan.buses) if (bus.compress) this.compressors.set(bus.id, new Compressor({ sampleRate, ...SPEECH_COMPRESSOR }))
    this.limiter = plan.limiter.enabled && !options.measuring ? new Limiter({ sampleRate, ceilingDb: plan.limiter.ceilingDb }) : null
    this.pendingDrop = this.limiter?.latency ?? 0
  }

  /** Samples the limiter holds back; `process` and `finish` already make up for them. */
  get latency(): number {
    return this.limiter?.latency ?? 0
  }

  /** Samples the limiter's last clamp cut (0 for normal sound), or with the limiter off, samples past full scale. */
  get clamped(): number {
    return (this.limiter?.clamped ?? 0) + this.cut
  }

  /**
   * Mixes the buses' sound for mix samples [first, first + count) (`buses`
   * keyed by bus id, UNROUTED for the rest; the buffers are changed) and
   * returns the master sound that is ready: the same samples, less the
   * limiter's delay at the very start, which `finish` returns at the end.
   */
  process(first: number, count: number, buses: ReadonlyMap<string, Stereo>): Stereo {
    const left = new Float32Array(count)
    const right = new Float32Array(count)
    const add = (sound: Stereo, gainAt: (i: number) => number) => {
      for (let i = 0; i < count; i++) {
        const g = gainAt(i)
        if (g === 0) continue
        left[i] = (left[i] ?? 0) + g * (sound.left[i] ?? 0)
        right[i] = (right[i] ?? 0) + g * (sound.right[i] ?? 0)
      }
    }
    const msAt = (i: number) => ((first + i) * 1000) / this.sampleRate
    for (const bus of this.plan.buses) {
      const sound = buses.get(bus.id)
      if (!sound) continue
      // The compressor runs even on a muted bus, so its state stays true when it is unmuted mid-mix.
      this.compressors.get(bus.id)?.process(sound.left, sound.right)
      if (bus.gain === 0) continue
      const { duck } = bus
      add(sound, duck ? (i) => bus.gain * tableAt(duck, msAt(i)) : () => bus.gain)
    }
    const unrouted = buses.get(UNROUTED)
    if (unrouted && this.plan.unroutedGain > 0) add(unrouted, () => this.plan.unroutedGain)
    return this.master({ left, right })
  }

  /** The last samples the limiter still holds, after the final `process`. */
  finish(): Stereo {
    if (!this.limiter) return { left: new Float32Array(0), right: new Float32Array(0) }
    const tail = this.limiter.flush()
    return this.trim(tail)
  }

  private master(sound: Stereo): Stereo {
    const volume = this.plan.masterVolume * (this.options.measuring ? 1 : this.plan.masterTrim)
    if (volume !== 1) {
      for (let i = 0; i < sound.left.length; i++) {
        sound.left[i] = (sound.left[i] ?? 0) * volume
        sound.right[i] = (sound.right[i] ?? 0) * volume
      }
    }
    if (this.options.measuring) return sound
    if (!this.limiter) {
      // No limiter: a file still cannot hold more than full scale.
      for (const channel of [sound.left, sound.right]) {
        for (let i = 0; i < channel.length; i++) {
          const v = channel[i] ?? 0
          if (v > 1 || v < -1) {
            channel[i] = v > 1 ? 1 : -1
            this.cut++
          }
        }
      }
      return sound
    }
    this.limiter.process(sound.left, sound.right)
    return this.trim(sound)
  }

  /** Drops what is left of the limiter's initial delay from the front. */
  private trim(sound: Stereo): Stereo {
    if (this.pendingDrop === 0) return sound
    const drop = Math.min(this.pendingDrop, sound.left.length)
    this.pendingDrop -= drop
    return { left: sound.left.subarray(drop), right: sound.right.subarray(drop) }
  }
}
