import { type Comp, type Layer, type MediaAsset, type SoundHit, transitionGains, transitionWindows } from '@uve/core'
import { resolveLayer } from './evaluate'
import { playedMedia } from './nested'
import { synthHit } from './soundSynth'

// The audio mix of an export. Each sounding layer's source sound is resampled
// to the mix rate (speed changes pitch, as on tape, the same as the preview),
// scaled by its volume (above 1 too) and summed. Mixes are made in windows on
// one global sample grid, so mixing a range in pieces gives the same samples
// as mixing it at once.

/** Sample rate of the mix, Hz. */
export const MIX_SAMPLE_RATE = 48000

/** Length of the fades at a layer's edges, in samples (2 ms), so cuts do not click. */
export const EDGE_FADE_SAMPLES = 96

/** Zero crossings of the resampling kernel on each side of its centre. */
const KERNEL_ZEROS = 8
/** Kernel table entries per unit of distance. */
const KERNEL_STEPS = 512
/** Samples between volume evaluations; the volume ramps linearly in between. */
const GAIN_BLOCK = 64

export type MediaLayer = Extract<Layer, { kind: 'video' | 'audio' }>

/** Two channels of the same length. */
export interface Stereo {
  left: Float32Array
  right: Float32Array
}

/** Decoded source sound: `length` stereo samples, the first at `startSec` of source time. */
export interface Pcm extends Stereo {
  sampleRate: number
  startSec: number
  length: number
}

/** Whether a layer's sound fades in at its start and out at its end. */
export interface EdgeFades {
  fadeIn: boolean
  fadeOut: boolean
  /** An extra gain over comp time (ms): a transition's crossfade. */
  envelope?: (ms: number) => number
}

/**
 * The gain a layer's sound gets from the transitions on its cuts: inside a
 * window the outgoing side fades out and the incoming side in, by the
 * preset's curve (equal power, a dip, or linear). Undefined when it has none.
 */
export function transitionEnvelope(comp: Comp, layer: Layer): ((ms: number) => number) | undefined {
  const track = comp.tracks.find((t) => t.layers.some((l) => l.id === layer.id))
  if (!track || track.transitions.length === 0) return undefined
  const windows = transitionWindows(track).filter((w) => w.a?.id === layer.id || w.b?.id === layer.id)
  if (windows.length === 0) return undefined
  return (ms) => {
    let gain = 1
    for (const w of windows) {
      if (ms < w.startMs || ms >= w.endMs) continue
      const gains = transitionGains(w.preset.audio, (ms - w.startMs) / (w.endMs - w.startMs))
      gain *= w.a?.id === layer.id ? gains.a : gains.b
    }
    return gain
  }
}

/** The first mix sample at or after a comp time. */
export function mixSampleAt(ms: number): number {
  return Math.ceil((ms * MIX_SAMPLE_RATE) / 1000 - 1e-6)
}

/** The mix samples [first, end) during which a layer sounds. */
export function layerSamples(layer: Layer): { first: number; end: number } {
  return { first: mixSampleAt(layer.startMs), end: mixSampleAt(layer.startMs + layer.durationMs) }
}

/** The source time, in seconds, that a media layer plays at mix sample `index`. */
function sourceSecAt(layer: MediaLayer, index: number): number {
  return (layer.sourceStartMs + ((index * 1000) / MIX_SAMPLE_RATE - layer.startMs) * layer.playbackRate) / 1000
}

/**
 * The source seconds a layer reads to make mix samples [from, to): their own
 * span, widened by the reach of the resampling kernel (which grows with speed).
 */
export function sourceSpanSec(layer: MediaLayer, from: number, to: number): { startSec: number; endSec: number } {
  // The kernel reaches KERNEL_ZEROS source samples, or KERNEL_ZEROS mix samples' worth when sped up.
  // 8 kHz is the lowest source rate worth planning for; one extra millisecond covers rounding.
  const reachSec = KERNEL_ZEROS * Math.max(1 / 8000, layer.playbackRate / MIX_SAMPLE_RATE) + 0.001
  return { startSec: sourceSecAt(layer, from) - reachSec, endSec: sourceSecAt(layer, to) + reachSec }
}

/**
 * The video and audio layers a comp sounds with, those inside its nested
 * comps included (placed in its time, see nested.ts): enabled, not muted (nor
 * on a muted track), not silent, with media that has sound. Media a pingpong
 * loop plays backwards is left out.
 */
export function audibleLayers(comp: Comp, doc: { media: readonly MediaAsset[]; comps: readonly Comp[] }): MediaLayer[] {
  const layers: MediaLayer[] = []
  // A static frame is a picture: it has no sound.
  if (comp.mode === 'static') return layers
  for (const { layer, trackMuted } of playedMedia(comp, doc.comps)) {
    if (trackMuted || (layer.kind !== 'video' && layer.kind !== 'audio') || !layer.enabled || layer.muted || layer.playbackRate <= 0) continue
    if ((layer.animations.volume?.length ?? 0) === 0 && layer.volume <= 0) continue
    const asset = doc.media.find((m) => m.id === layer.mediaId)
    if (asset && asset.hasAudio !== false) layers.push(layer)
  }
  return layers
}

/** Whether `next` carries on from `layer` without a break: the same media and speed, back to back in comp and source time. */
export function continues(layer: MediaLayer, next: MediaLayer): boolean {
  const end = layer.startMs + layer.durationMs
  return (
    layer.mediaId === next.mediaId &&
    layer.playbackRate === next.playbackRate &&
    Math.abs(end - next.startMs) < 0.5 &&
    Math.abs(layer.sourceStartMs + layer.durationMs * layer.playbackRate - next.sourceStartMs) < 0.5
  )
}

/** A layer fades at an edge unless another sounding layer continues its sound there, as after a split. */
export function edgeFades(layer: MediaLayer, layers: readonly MediaLayer[]): EdgeFades {
  return {
    fadeIn: !layers.some((other) => other !== layer && continues(other, layer)),
    fadeOut: !layers.some((other) => other !== layer && continues(layer, other)),
  }
}

/** Folds decoded channels into stereo: mono plays on both sides; centre and surround channels (L R C LFE Ls Rs order) are mixed in. */
export function toStereo(planes: readonly Float32Array[]): Stereo {
  const [left, right, centre, , leftSurround, rightSurround] = planes
  if (!left) throw new Error('Sound with no channels')
  if (!right) return { left, right: left }
  if (!centre) return { left, right }
  const length = left.length
  const outLeft = new Float32Array(length)
  const outRight = new Float32Array(length)
  // ITU-R BS.775 downmix weights.
  const k = Math.SQRT1_2
  for (let i = 0; i < length; i++) {
    const c = k * (centre[i] ?? 0)
    outLeft[i] = (left[i] ?? 0) + c + k * (leftSurround?.[i] ?? 0)
    outRight[i] = (right[i] ?? 0) + c + k * (rightSurround?.[i] ?? 0)
  }
  return { left: outLeft, right: outRight }
}

let kernelTable: Float32Array | null = null

/** A Blackman-windowed sinc, tabulated from distance 0 to KERNEL_ZEROS. */
function kernel(): Float32Array {
  if (kernelTable) return kernelTable
  const table = new Float32Array(KERNEL_ZEROS * KERNEL_STEPS + 2)
  for (let i = 0; i < KERNEL_ZEROS * KERNEL_STEPS; i++) {
    const u = i / KERNEL_STEPS
    const sinc = u === 0 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u)
    const window = 0.42 + 0.5 * Math.cos((Math.PI * u) / KERNEL_ZEROS) + 0.08 * Math.cos((2 * Math.PI * u) / KERNEL_ZEROS)
    table[i] = sinc * window
  }
  kernelTable = table
  return table
}

/**
 * Adds a media layer's sound to `out`, a piece of the mix whose first sample
 * is mix sample `outFirst`. `pcm` must hold the source span that
 * `sourceSpanSec` names for the samples written; sound outside it is silence.
 * Values are not limited here: see `limitMix`.
 */
export function mixLayer(out: Stereo, outFirst: number, layer: MediaLayer, pcm: Pcm, fades: EdgeFades): void {
  const { first, end } = layerSamples(layer)
  const from = Math.max(first, outFirst)
  const to = Math.min(end, outFirst + out.left.length)
  if (from >= to || pcm.length === 0) return

  const table = kernel()
  const { left, right, length, sampleRate } = pcm
  // Source samples advanced per mix sample. Above 1 the kernel widens to filter out what the mix rate cannot hold.
  const step = (layer.playbackRate * sampleRate) / MIX_SAMPLE_RATE
  const cutoff = Math.min(1, 1 / step)
  const reach = KERNEL_ZEROS / cutoff
  const scale = cutoff * KERNEL_STEPS
  const positionAt = (index: number) => (sourceSecAt(layer, index) - pcm.startSec) * sampleRate
  const volumeAt = (index: number) => {
    const ms = (index * 1000) / MIX_SAMPLE_RATE
    return (resolveLayer(layer, ms).volume ?? layer.volume) * (fades.envelope?.(ms) ?? 1)
  }

  for (let block = from; block < to; block += GAIN_BLOCK) {
    const blockEnd = Math.min(to, block + GAIN_BLOCK)
    const gainStart = volumeAt(block)
    const gainSlope = (volumeAt(block + GAIN_BLOCK) - gainStart) / GAIN_BLOCK
    for (let index = block; index < blockEnd; index++) {
      let gain = gainStart + gainSlope * (index - block)
      if (fades.fadeIn && index - first < EDGE_FADE_SAMPLES) gain *= (index - first + 0.5) / EDGE_FADE_SAMPLES
      if (fades.fadeOut && end - index <= EDGE_FADE_SAMPLES) gain *= (end - index - 0.5) / EDGE_FADE_SAMPLES
      if (gain === 0) continue

      const x = positionAt(index)
      const nearest = Math.round(x)
      let l = 0
      let r = 0
      if (step === 1 && Math.abs(x - nearest) < 1e-6) {
        // Same rate and in phase: the source samples themselves.
        if (nearest >= 0 && nearest < length) {
          l = left[nearest] ?? 0
          r = right[nearest] ?? 0
        }
      } else {
        let weights = 0
        for (let k = Math.ceil(x - reach); k <= x + reach; k++) {
          const at = Math.abs(k - x) * scale
          const i = at | 0
          const lower = table[i] ?? 0
          const w = lower + ((table[i + 1] ?? 0) - lower) * (at - i)
          weights += w
          if (k >= 0 && k < length) {
            l += w * (left[k] ?? 0)
            r += w * (right[k] ?? 0)
          }
        }
        // Normalising keeps the level exact whatever the kernel's width and phase.
        if (weights === 0) continue
        l /= weights
        r /= weights
      }
      const o = index - outFirst
      out.left[o] = (out.left[o] ?? 0) + gain * l
      out.right[o] = (out.right[o] ?? 0) + gain * r
    }
  }
}

/** Clips a finished mix to the range a file can hold, -1 to 1. Returns how many samples were clipped. */
export function limitMix(out: Stereo): number {
  let clipped = 0
  for (const channel of [out.left, out.right]) {
    for (let i = 0; i < channel.length; i++) {
      const v = channel[i] ?? 0
      if (v > 1 || v < -1) {
        channel[i] = v > 1 ? 1 : -1
        clipped++
      }
    }
  }
  return clipped
}

/** How many mix samples a hit lasts: a synthesised pack's length, or a custom sound's rest after its hit point. */
function hitPcm(hit: SoundHit, custom: (assetId: string) => Pcm | null): { left: Float32Array; right: Float32Array; rate: number; lead: number } | null {
  if (hit.voice.pack) {
    const mono = synthHit(hit.voice.pack, hit.pitch, hit.variant, MIX_SAMPLE_RATE)
    return { left: mono, right: mono, rate: 1, lead: 0 }
  }
  if (!hit.voice.custom) return null
  const pcm = custom(hit.voice.custom.assetId)
  if (!pcm) return null
  // The file's own rate and the hit's pitch, in source samples per mix sample; the hit point lands on the moment.
  const rate = (pcm.sampleRate / MIX_SAMPLE_RATE) * hit.pitch
  const lead = Math.round(((hit.voice.custom.hitMs / 1000) * MIX_SAMPLE_RATE) / hit.pitch)
  return { left: pcm.left.subarray(0, pcm.length), right: pcm.right.subarray(0, pcm.length), rate, lead }
}

/**
 * Adds the sounds stack's hits to a window of the mix that starts at mix
 * sample `outFirst`: synthesised packs, and custom sounds (decoded whole by
 * `custom`) resampled by the hit's pitch, each at its volume.
 */
export function mixHits(out: Stereo, outFirst: number, hits: readonly SoundHit[], custom: (assetId: string) => Pcm | null): void {
  const length = out.left.length
  for (const hit of hits) {
    const sound = hitPcm(hit, custom)
    if (!sound) continue
    const start = Math.round((hit.timeMs / 1000) * MIX_SAMPLE_RATE) - sound.lead
    const span = Math.floor(sound.left.length / sound.rate)
    const from = Math.max(start, outFirst)
    const to = Math.min(start + span, outFirst + length)
    for (let i = from; i < to; i++) {
      const at = (i - start) * sound.rate
      const k = Math.floor(at)
      const f = at - k
      const l = (sound.left[k] ?? 0) * (1 - f) + (sound.left[k + 1] ?? 0) * f
      const r = (sound.right[k] ?? 0) * (1 - f) + (sound.right[k + 1] ?? 0) * f
      const o = i - outFirst
      out.left[o] = (out.left[o] ?? 0) + l * hit.volume
      out.right[o] = (out.right[o] ?? 0) + r * hit.volume
    }
  }
}
