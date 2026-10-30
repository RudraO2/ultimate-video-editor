import { type Comp, type Keyframe, type Layer, type NestedLayer, nestedCycleMs } from '@uve/core'

// Media inside nested comps. The scene draws a nested comp's pictures from
// its own layers, but whatever decodes media (the preview's players, an
// export's decoders, the audio mix) works in the time of the comp being
// played. So each media layer inside is copied into that time, once per pass
// of a loop: `<nested id>/<inner id>#<pass>`, the key the scene asks for its
// frames with (see `nestedFrames`).

/** A layer that shows or plays a media file. */
export type PlayedLayer = Extract<Layer, { kind: 'video' | 'audio' | 'image' }>

/** A media layer a comp plays, with whether the lanes it is on (outside and in) are muted. */
export interface PlayedMedia {
  layer: PlayedLayer
  trackMuted: boolean
}

/** How deep nested comps are followed; deeper ones are not drawn either. */
export const MAX_NESTING = 16

/** The key a media layer inside a nested layer is decoded under, for one pass of its loop. */
export const nestedKey = (nestedId: string, innerKey: string, pass: number) => `${nestedId}/${innerKey}#${pass}`

/**
 * Every media layer `comp` plays, those inside its nested comps included,
 * placed in `comp`'s time. A pingpong pass that runs back plays its media
 * backwards (a negative `playbackRate`), which pictures can follow and the
 * sound mix leaves out.
 */
export function playedMedia(comp: Comp, comps: readonly Comp[], stack: readonly string[] = [comp.id]): PlayedMedia[] {
  const out: PlayedMedia[] = []
  for (const track of comp.tracks) {
    for (const layer of track.layers) {
      if (layer.kind === 'video' || layer.kind === 'audio' || layer.kind === 'image') out.push({ layer, trackMuted: track.muted })
      else if (layer.kind === 'nested') {
        const source = comps.find((c) => c.id === layer.sourceCompId)
        if (!source || stack.includes(source.id) || stack.length > MAX_NESTING) continue
        for (const inner of playedMedia(source, comps, [...stack, source.id])) {
          // A static frame shown inside another holds one moment and is silent: only its pictures are placed.
          if (source.mode === 'static' && inner.layer.kind !== 'image') continue
          for (const placed of placeInside(layer, source, inner.layer)) out.push({ layer: placed, trackMuted: track.muted || inner.trackMuted })
        }
      }
    }
  }
  return out
}

/** Copies of `inner` (in the source's time) placed in the time of the comp that holds `nested`, one per pass that shows it. */
function placeInside(nested: NestedLayer, source: Comp, inner: PlayedLayer): PlayedLayer[] {
  const speed = nested.playback.speed
  const cycle = nestedCycleMs(nested, source.durationMs)
  if (cycle <= 0) return []
  const total = nested.durationMs * speed
  const passes = nested.playback.loop === 'none' ? 1 : Math.ceil(total / cycle - 1e-9)
  const out: PlayedLayer[] = []
  for (let pass = 0; pass < passes; pass++) {
    const e0 = pass * cycle
    const e1 = Math.min((pass + 1) * cycle, total)
    if (e1 <= e0) break
    const backwards = nested.playback.loop === 'pingpong' && pass % 2 === 1
    // The stretch of source time this pass shows.
    const u0 = backwards ? nested.trimInMs + cycle - (e1 - e0) : nested.trimInMs
    const u1 = backwards ? nested.trimInMs + cycle : nested.trimInMs + (e1 - e0)
    const a = Math.max(inner.startMs, u0)
    const b = Math.min(inner.startMs + inner.durationMs, u1)
    if (b - a < 0.5) continue
    // Comp time of source time u in this pass.
    const at = (u: number) => nested.startMs + (backwards ? e0 + (u1 - u) : e0 + (u - u0)) / speed
    const startMs = backwards ? at(b) : at(a)
    const placed = {
      ...inner,
      id: nestedKey(nested.id, inner.id, pass),
      startMs,
      durationMs: (b - a) / speed,
      enabled: inner.enabled && nested.enabled,
      animations: {},
    } as PlayedLayer
    // The innermost sound category wins; the nested layer's own duck rules apply inside it too.
    const soundBus = inner.soundBus ?? nested.soundBus
    if (soundBus !== undefined) placed.soundBus = soundBus
    if (nested.ducking?.length) placed.ducking = [...(inner.ducking ?? []), ...nested.ducking]
    if (placed.kind !== 'image' && inner.kind !== 'image') {
      const offset = (backwards ? b : a) - inner.startMs
      placed.sourceStartMs = inner.sourceStartMs + offset * inner.playbackRate
      placed.playbackRate = inner.playbackRate * speed * (backwards ? -1 : 1)
      placed.volume = inner.volume * nested.volume
      placed.muted = inner.muted || nested.muted
      const keys = inner.animations.volume
      if (keys && !backwards) {
        placed.animations = { volume: keys.map((k): Keyframe => ({ ...k, t: (k.t - offset) / speed, v: typeof k.v === 'number' ? k.v * nested.volume : k.v })) }
      }
    }
    out.push(placed)
  }
  return out
}
