import type { SoundPackId } from '@uve/core'
import { registerPackTakes, synthHit } from '@uve/engine'
import keysIndex from './keys.json'
import keysUrl from './keys.wav?url'

// The built-in packs: AtomCut's six typing packs, synthesised by the engine
// (soundSynth.ts), and `keys`, 32 recorded keypresses (CC0) shipped with the
// app. The same hits play here, in the preview and in exports.

export const SOUND_PACKS: readonly { id: SoundPackId; name: string; tagline: string }[] = [
  { id: 'mechanical', name: 'Mechanical', tagline: 'Thin clicky ticks, quiet' },
  { id: 'soft', name: 'Soft', tagline: 'Soft rounded taps' },
  { id: 'vintage', name: 'Vintage', tagline: 'Bright typewriter-like strikes' },
  { id: 'thock', name: 'Thock', tagline: 'Deep, heavy keys, loud' },
  { id: 'digital', name: 'Digital', tagline: 'Clean electronic blips, quiet' },
  { id: 'pop', name: 'Pop', tagline: 'Bubbly rising pops, loud' },
  { id: 'keys', name: 'Keys', tagline: 'Recorded keyboard keypresses (unicaegames, CC0)' },
]

export type SoundPack = (typeof SOUND_PACKS)[number]

/** How many takes the recorded `keys` pack has. */
export const KEYS_TAKES = keysIndex.takes.length

/** 16-bit PCM samples of a WAV file's data chunk, as floats. */
function wavSamples(bytes: ArrayBuffer): Float32Array {
  const view = new DataView(bytes)
  for (let at = 12; at + 8 <= view.byteLength; ) {
    const id = String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3))
    const size = view.getUint32(at + 4, true)
    if (id === 'data') {
      const out = new Float32Array(Math.floor(Math.min(size, view.byteLength - at - 8) / 2))
      for (let i = 0; i < out.length; i++) out[i] = view.getInt16(at + 8 + i * 2, true) / 32768
      return out
    }
    at += 8 + size + (size % 2)
  }
  throw new Error('The keys sound file has no data.')
}

let keysLoading: Promise<void> | null = null

/** Loads the recorded packs' takes into the engine (once); the export waits for it, the preview starts it. */
export function loadPackTakes(): Promise<void> {
  keysLoading ??= fetch(keysUrl)
    .then((r) => r.arrayBuffer())
    .then((bytes) => {
      const all = wavSamples(bytes)
      registerPackTakes('keys', { sampleRate: keysIndex.sampleRate, takes: keysIndex.takes.map((t) => all.subarray(t.start, t.start + t.length)) })
    })
    .catch((error: unknown) => {
      keysLoading = null
      console.warn('The recorded keys pack could not be loaded:', error)
    })
  return keysLoading
}

let context: AudioContext | null = null

/** Plays a short burst of hits in a pack's sound, as a stack would fire them (volume and pitch varied as randomness 0.6 does). */
export async function previewPack(pack: { id: SoundPackId }, strokes = 6, volume = 0.6, pitch = 1): Promise<void> {
  context ??= new AudioContext()
  const ctx = context
  void ctx.resume()
  if (pack.id === 'keys') await loadPackTakes()
  for (let i = 0; i < strokes; i++) {
    const seed = ((i * 0.618034 + 0.31) % 1)
    const pcm = synthHit(pack.id, pitch * (1 + 0.35 * 0.6 * (((7919 * seed) % 1) - 0.5)), i * 7 + 3, ctx.sampleRate)
    if (pcm.length === 0) continue
    const buffer = ctx.createBuffer(1, pcm.length, ctx.sampleRate)
    buffer.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    const gain = ctx.createGain()
    gain.gain.value = volume * (1 - 0.65 * 0.6 * seed)
    source.connect(gain).connect(ctx.destination)
    source.start(ctx.currentTime + 0.05 + i * (0.09 + ((i * 13) % 5) * 0.01))
  }
}
