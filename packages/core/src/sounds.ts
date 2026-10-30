import { slotAnimation, textUnits, unitCount, unitStartMs } from './animation'
import { nestedCycleMs } from './nest'
import type { Comp, Layer, NestedLayer, Track } from './schema'
import type { SoundVoice } from './soundVoice'
import { transitionWindows } from './transitions'

// The sounds stack: sounds a layer fires from its own motion — each letter,
// word or line of a text animation, the layer's entrance or exit, or the
// transition on its cut — so they stay in sync when the timing changes. The
// shape follows AtomCut's (`pack` or `custom`, volume, pitch, randomness,
// phase, trigger, anchor, offset); the timing and the synthesis are ours.

/** One sound to play: a voice of a layer at a comp time, with its own pitch and gain. */
export interface SoundHit {
  layerId: string
  voice: SoundVoice
  /** Comp time, ms. */
  timeMs: number
  pitch: number
  volume: number
  /** Which take of a recorded pack (any whole number; the pack wraps it to its takes). */
  variant: number
  /**
   * For a hit fired inside a nested comp: the sound category it goes to (the
   * innermost tag on the way down), or undefined to use its layer's.
   */
  soundBus?: string
}

/** A small, stable hash to [0, 1). */
function seeded(...parts: (string | number)[]): number {
  let h = 2166136261
  for (const part of parts) {
    const text = String(part)
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    h ^= h >>> 13
  }
  return ((h >>> 0) % 100003) / 100003
}

/** The moment of a motion a hit lands on: its start, its middle (peak) or its end. */
function anchored(startMs: number, durationMs: number, anchor: SoundVoice['anchor']): number {
  return anchor === 'start' ? startMs : anchor === 'peak' ? startMs + durationMs / 2 : startMs + durationMs
}

/** Layer times (ms from its start) of a voice's moments, before randomness and offset. */
function moments(layer: Layer, voice: SoundVoice, track: Track | undefined): number[] {
  const slot = voice.phase
  if (voice.trigger.kind === 'text') {
    if (layer.kind !== 'text') return []
    const spec = slotAnimation(layer, 'text', slot)
    if (!spec) return []
    const units = textUnits(layer.text)
    const count = unitCount(units, spec.unit)
    const times: number[] = []
    for (let i = 0; i < count; i++) {
      // Spaces make no sound when letters are the units.
      if (spec.unit === 'letter' && /^\s+$/.test(units.graphemes[i] ?? '')) continue
      times.push(anchored(unitStartMs(spec, slot, i, count, layer), spec.durationMs, voice.anchor))
    }
    return times
  }
  if (voice.trigger.kind === 'layer') {
    const spec = slotAnimation(layer, 'layer', slot)
    if (!spec) return []
    const start = slot === 'in' ? 0 : Math.max(0, layer.durationMs - spec.durationMs)
    return [anchored(start, spec.durationMs, voice.anchor)]
  }
  if (!track) return []
  const window = transitionWindows(track).find((w) => (slot === 'in' ? w.b?.id === layer.id : w.a?.id === layer.id))
  if (!window) return []
  return [anchored(window.startMs - layer.startMs, window.endMs - window.startMs, voice.anchor)]
}

/**
 * The sounds a layer fires, in comp time, inside its own span (a transition's
 * edge may reach a little past it). Randomness varies each hit as AtomCut's
 * does: from one seed in [0, 1), volume × (1 − 0.65·r·seed) and pitch ×
 * (1 + 0.35·r·(frac(7919·seed) − 0.5)); timing never moves. A recorded file
 * (`custom`) moves half as far in pitch (±8.75 %·r): a real recording sped up
 * or slowed by a tenth sounds processed, which a synthesised pop does not
 * (Q10). Seeds come from the layer, the voice and the hit, so the preview and
 * the export hear the same.
 */
export function soundHits(layer: Layer, track?: Track): SoundHit[] {
  const hits: SoundHit[] = []
  for (const voice of layer.sounds) {
    if (!voice.enabled || voice.volume <= 0) continue
    moments(layer, voice, track).forEach((t, i) => {
      // An offset may move a hit before the comp's start: that hit is not heard.
      const timeMs = layer.startMs + t + voice.offsetMs
      if (timeMs < 0) return
      const r = voice.randomness
      const seed = seeded(layer.id, voice.id, i, 'hit')
      const spread = voice.custom ? 0.175 : 0.35
      const pitch = voice.pitch * (1 + spread * r * (((7919 * seed) % 1) - 0.5))
      const volume = voice.volume * (1 - 0.65 * r * seed)
      // A recorded pack's take (a synthesised one has a single sound).
      const variant = Math.floor(seeded(layer.id, voice.id, i, 'take') * 1024)
      hits.push({ layerId: layer.id, voice, timeMs, pitch, volume, variant })
    })
  }
  return hits
}

/** Every hit of a comp's lanes (not muted or hidden-by-mute), sorted by time. */
export function compSoundHits(tracks: readonly Track[]): SoundHit[] {
  const hits: SoundHit[] = []
  for (const track of tracks) {
    if (track.muted) continue
    for (const layer of track.layers) if (layer.enabled && layer.sounds.length > 0) hits.push(...soundHits(layer, track))
  }
  return hits.sort((a, b) => a.timeMs - b.timeMs)
}

/** How deep nested comps are followed for their fired sounds (as the engine follows them for media). */
const MAX_SOUND_NESTING = 16

/**
 * Every hit a comp plays, those fired inside its nested comps (and worlds)
 * included, placed in the comp's time once per pass of a loop, as the
 * engine's `playedMedia` places media: a nested comp made of parts sounds as
 * it does on its own. A hit inside keeps its pitch; its volume takes the
 * nested layer's; a muted or disabled nested layer, a muted lane and a static
 * frame are silent. Inner ids read `<nested id>/<inner id>#<pass>`.
 */
export function compSoundHitsDeep(comp: Comp, comps: readonly Comp[], stack: readonly string[] = [comp.id]): SoundHit[] {
  const hits = compSoundHits(comp.tracks)
  for (const track of comp.tracks) {
    if (track.muted) continue
    for (const layer of track.layers) {
      if (layer.kind !== 'nested' || !layer.enabled || layer.muted) continue
      const source = comps.find((c) => c.id === layer.sourceCompId)
      if (!source || source.mode === 'static' || stack.includes(source.id) || stack.length > MAX_SOUND_NESTING) continue
      const busOf = new Map<string, string | undefined>()
      for (const t of source.tracks) for (const l of t.layers) busOf.set(l.id, l.soundBus)
      for (const inner of compSoundHitsDeep(source, comps, [...stack, source.id])) {
        for (const placed of placeHit(layer, source.durationMs, inner)) {
          const soundBus = inner.soundBus ?? busOf.get(inner.layerId) ?? layer.soundBus
          hits.push(soundBus === undefined ? placed : { ...placed, soundBus })
        }
      }
    }
  }
  return hits.sort((a, b) => a.timeMs - b.timeMs)
}

/** Copies of a hit at source time `inner.timeMs`, in the time of the comp holding `nested`, one per pass that reaches it. */
function placeHit(nested: NestedLayer, sourceDurationMs: number, inner: SoundHit): SoundHit[] {
  const speed = nested.playback.speed
  const cycle = nestedCycleMs(nested, sourceDurationMs)
  if (cycle <= 0 || speed <= 0) return []
  const total = nested.durationMs * speed
  const passes = nested.playback.loop === 'none' ? 1 : Math.ceil(total / cycle - 1e-9)
  const out: SoundHit[] = []
  for (let pass = 0; pass < passes; pass++) {
    const e0 = pass * cycle
    const e1 = Math.min((pass + 1) * cycle, total)
    if (e1 <= e0) break
    const backwards = nested.playback.loop === 'pingpong' && pass % 2 === 1
    // The source time this pass reaches: [u0, u1).
    const u0 = backwards ? nested.trimInMs + cycle - (e1 - e0) : nested.trimInMs
    const u1 = backwards ? nested.trimInMs + cycle : nested.trimInMs + (e1 - e0)
    const u = inner.timeMs
    if (u < u0 || u >= u1) continue
    const timeMs = nested.startMs + (backwards ? e0 + (u1 - u) : e0 + (u - u0)) / speed
    out.push({ ...inner, layerId: `${nested.id}/${inner.layerId}#${pass}`, timeMs, volume: inner.volume * nested.volume })
  }
  return out
}
