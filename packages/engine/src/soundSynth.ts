import type { SoundPackId } from '@uve/core'

// The sound packs a sounds stack fires. Six are synthesised, each hit made
// from scratch: one oscillator swept from one pitch to another while its gain
// falls exponentially to −80 dB, plus an optional burst of filtered noise
// with its own decay. Their recipes (waveform, frequencies, lengths, levels,
// filters) are AtomCut's typing packs, ported as data with its author's
// permission (docs/research/atomcut-inspiration.md ▸ "The synthesised packs
// against ours"); the synthesis is our own code. Each pack keeps its own
// level, as AtomCut's do, so a stream of `mechanical` typing sits far under a
// `pop`. Hits have no takes: randomness varies only their pitch and volume.
// The recorded packs (`keys`) play takes the app registers (registerPackTakes).

interface Recipe {
  wave: 'sine' | 'triangle' | 'square'
  /** Hz at the start and at the end of the sweep (flat without an end). */
  freq: number
  endFreq?: number
  /** Seconds the tone sweeps and fades over. */
  duration: number
  /** Peak gain at volume 1. */
  volume: number
  /** A low-pass on the tone, Hz. */
  toneLowpass?: number
  /** Noise level as a share of `volume`. */
  noise?: number
  /** Seconds the noise fades over (60 % of the tone's by default). */
  noiseDuration?: number
  /** The noise's filter: a band-pass that follows the pitch, else a fixed 2 kHz high-pass. */
  noiseBand?: { freq: number; q: number }
}

/** AtomCut's six typing packs (AtomCut 4.9.0), as data. */
const RECIPES: Record<Exclude<SoundPackId, 'keys'>, Recipe> = {
  mechanical: { wave: 'triangle', freq: 520, endFreq: 240, duration: 0.03, volume: 0.32, toneLowpass: 2400, noise: 0.9, noiseDuration: 0.016, noiseBand: { freq: 2600, q: 1.1 } },
  soft: { wave: 'sine', freq: 620, endFreq: 400, duration: 0.05, volume: 0.4, noise: 0.15 },
  vintage: { wave: 'triangle', freq: 1000, endFreq: 500, duration: 0.06, volume: 0.55, noise: 0.5, noiseDuration: 0.045 },
  thock: { wave: 'sine', freq: 220, endFreq: 90, duration: 0.08, volume: 0.9, noise: 0.25, noiseDuration: 0.02 },
  digital: { wave: 'square', freq: 1800, duration: 0.018, volume: 0.22, toneLowpass: 3200 },
  pop: { wave: 'sine', freq: 320, endFreq: 900, duration: 0.09, volume: 0.7 },
}

/** The noise burst every hit draws from: 50 ms, made once per sample rate (seeded, so the preview and the export hear the same). */
const NOISE_SEC = 0.05
const noiseBuffers = new Map<number, Float32Array>()

function noiseBuffer(sampleRate: number): Float32Array {
  let buffer = noiseBuffers.get(sampleRate)
  if (!buffer) {
    buffer = new Float32Array(Math.floor(NOISE_SEC * sampleRate))
    let a = 0x2545f491
    for (let i = 0; i < buffer.length; i++) {
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      buffer[i] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1
    }
    noiseBuffers.set(sampleRate, buffer)
  }
  return buffer
}

/**
 * A biquad run over `input` in place: low-pass and high-pass take their
 * resonance in dB (as Web Audio's do; 1 dB by default), band-pass its Q.
 */
function biquad(input: Float32Array, kind: 'lowpass' | 'highpass' | 'bandpass', sampleRate: number, freq: number, q: number): void {
  const w = (2 * Math.PI * Math.min(freq, sampleRate * 0.49)) / sampleRate
  const cos = Math.cos(w)
  const alpha = Math.sin(w) / (2 * (kind === 'bandpass' ? q : 10 ** (q / 20)))
  const a0 = 1 + alpha
  const [b0, b1, b2] = kind === 'lowpass' ? [(1 - cos) / 2, 1 - cos, (1 - cos) / 2] : kind === 'highpass' ? [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2] : [alpha, 0, -alpha]
  const a1 = (-2 * cos) / a0
  const a2 = (1 - alpha) / a0
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < input.length; i++) {
    const x = input[i] as number
    const y = (b0 * x + b1 * x1 + b2 * x2) / a0 - a1 * y1 - a2 * y2
    x2 = x1
    x1 = x
    y2 = y1
    y1 = y
    input[i] = y
  }
}

/** One sample of a band-limited wave at `phase` (radians), with harmonics up to `harmonics`; triangle and square peak near 1. */
function wave(shape: Recipe['wave'], phase: number, harmonics: number): number {
  if (shape === 'sine') return Math.sin(phase)
  let v = 0
  for (let k = 1; k <= harmonics; k += 2) {
    if (shape === 'square') v += Math.sin(k * phase) / k
    else v += (((k - 1) / 2) % 2 === 1 ? -1 : 1) * (Math.sin(k * phase) / (k * k))
  }
  // The ideal square's and triangle's partial sums peak at π/4 and π²/8.
  return shape === 'square' ? v * (4 / Math.PI) * 0.85 : v * (8 / (Math.PI * Math.PI))
}

/** One synthesised hit at `pitch`, at the pack's own level (volume 1). */
function synthesise(recipe: Recipe, pitch: number, sampleRate: number): Float32Array {
  const noiseSec = recipe.noise ? Math.min(NOISE_SEC, recipe.noiseDuration ?? 0.6 * recipe.duration) : 0
  const out = new Float32Array(Math.ceil(Math.max(recipe.duration, noiseSec) * sampleRate))
  const f0 = recipe.freq * pitch
  const f1 = (recipe.endFreq ?? recipe.freq) * pitch
  const toneLength = Math.ceil(recipe.duration * sampleRate)
  const tone = new Float32Array(toneLength)
  let phase = 0
  for (let i = 0; i < toneLength; i++) {
    const t = i / sampleRate / recipe.duration
    const freq = f0 * (f1 / f0) ** t
    phase += (2 * Math.PI * freq) / sampleRate
    tone[i] = wave(recipe.wave, phase, Math.floor(sampleRate / 2 / freq))
  }
  if (recipe.toneLowpass) biquad(tone, 'lowpass', sampleRate, recipe.toneLowpass, 1)
  // The gain falls from the volume to −80 dB (1e-4) over the duration, with no separate attack.
  for (let i = 0; i < toneLength; i++) out[i] = (tone[i] as number) * recipe.volume * (1e-4 / recipe.volume) ** (i / sampleRate / recipe.duration)
  if (recipe.noise && noiseSec > 0) {
    const level = recipe.volume * recipe.noise
    const noise = noiseBuffer(sampleRate).slice(0, Math.ceil(noiseSec * sampleRate))
    if (recipe.noiseBand) biquad(noise, 'bandpass', sampleRate, recipe.noiseBand.freq * pitch, recipe.noiseBand.q)
    else biquad(noise, 'highpass', sampleRate, 2000, 1)
    const fade = recipe.noiseDuration ?? 0.6 * recipe.duration
    for (let i = 0; i < noise.length; i++) out[i] = (out[i] as number) + (noise[i] as number) * level * (1e-4 / level) ** (i / sampleRate / fade)
  }
  return out
}

/** Recorded takes of a pack, at their own sample rate. */
interface Takes {
  sampleRate: number
  takes: Float32Array[]
}
const recorded = new Map<SoundPackId, Takes>()

/**
 * Gives a recorded pack its takes (mono, each starting just before its hit),
 * so synthHit can play them. Hits of a recorded pack are silent until then.
 */
export function registerPackTakes(pack: SoundPackId, takes: Takes): void {
  recorded.set(pack, takes)
  for (const key of cache.keys()) if (key.startsWith(`${pack}|`)) cache.delete(key)
}

/** Whether a pack's hits can be made now: synthesised packs always, recorded ones once their takes are registered. */
export function packReady(pack: SoundPackId): boolean {
  return pack in RECIPES || recorded.has(pack)
}

/** A recorded take at `pitch`, resampled to `sampleRate` (linear: the takes are short and the steps small). */
function playTake(takes: Takes, variant: number, pitch: number, sampleRate: number): Float32Array {
  const take = takes.takes[Math.abs(Math.floor(variant)) % takes.takes.length] as Float32Array
  const step = (takes.sampleRate / sampleRate) * pitch
  const out = new Float32Array(Math.max(0, Math.floor((take.length - 1) / step)))
  for (let i = 0; i < out.length; i++) {
    const at = i * step
    const j = Math.floor(at)
    const f = at - j
    out[i] = (take[j] as number) * (1 - f) + (take[j + 1] ?? 0) * f
  }
  return out
}

/** Hit pitches are rounded to 0.5 % steps (under a tenth of a semitone), so the cache stays small. */
export function packPitch(pitch: number): number {
  return Math.round(pitch * 200) / 200
}

const CACHE_LIMIT = 256
const cache = new Map<string, Float32Array>()

/**
 * One hit of a pack as mono PCM at `sampleRate`, at the pack's own level
 * (the voice's volume scales it): `pitch` scales its frequencies (a recorded
 * take plays faster), `variant` picks a recorded pack's take and does not
 * change a synthesised one. Empty while a recorded pack has no takes.
 */
export function synthHit(pack: SoundPackId, pitch: number, variant: number, sampleRate: number): Float32Array {
  const step = packPitch(pitch)
  const takes = recorded.get(pack)
  const key = `${pack}|${step}|${takes ? Math.abs(Math.floor(variant)) % takes.takes.length : 0}|${sampleRate}`
  const known = cache.get(key)
  if (known) {
    // Most recently used last, so the oldest goes first when the cache is full.
    cache.delete(key)
    cache.set(key, known)
    return known
  }
  const recipe = pack === 'keys' ? undefined : RECIPES[pack]
  const out = recipe ? synthesise(recipe, step, sampleRate) : takes ? playTake(takes, variant, step, sampleRate) : null
  if (!out) return new Float32Array(0)
  cache.set(key, out)
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
  return out
}
