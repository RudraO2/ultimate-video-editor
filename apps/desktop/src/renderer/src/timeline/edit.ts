import { type Comp, type Layer, layerEnd, type MediaAsset, type Track } from '@uve/core'

// Pure helpers behind timeline gestures: snapping, trim limits and finding room
// on a track. The commands check everything again; these keep a drag smooth.

/** Times that clip edges snap to: the comp start and end, the playhead and the edges of other layers. */
export function snapTargets(comp: Comp, playheadMs: number, ignoreId?: string): number[] {
  const targets = new Set([0, comp.durationMs, playheadMs])
  for (const track of comp.tracks) {
    for (const layer of track.layers) {
      if (layer.id === ignoreId) continue
      targets.add(layer.startMs)
      targets.add(layerEnd(layer))
    }
  }
  return [...targets]
}

/**
 * The smallest shift that puts one of `edges` on one of `targets`, if one is
 * within `toleranceMs`; `at` is the target it lands on.
 */
export function snapShift(
  edges: readonly number[],
  targets: readonly number[],
  toleranceMs: number,
): { shift: number; at: number | null } {
  let best = { shift: 0, at: null as number | null }
  let bestDistance = toleranceMs
  for (const edge of edges) {
    for (const target of targets) {
      const distance = Math.abs(target - edge)
      if (distance <= bestDistance) {
        bestDistance = distance
        best = { shift: target - edge, at: target }
      }
    }
  }
  return best
}

/** The track a layer is on. */
export function trackOf(comp: Comp, layerId: string): Track | undefined {
  return comp.tracks.find((t) => t.layers.some((l) => l.id === layerId))
}

/**
 * How far a layer's edges can move when trimming: up to its neighbours on the
 * track, never before 0, and, for video and audio, not past either end of the
 * source file. A layer stays at least `minDurationMs` long.
 */
export function trimLimits(
  comp: Comp,
  layer: Layer,
  media: MediaAsset | undefined,
  minDurationMs: number,
): { start: [min: number, max: number]; end: [min: number, max: number] } {
  const end = layerEnd(layer)
  let minStart = 0
  let maxEnd = Number.POSITIVE_INFINITY
  for (const other of trackOf(comp, layer.id)?.layers ?? []) {
    if (other.id === layer.id) continue
    if (layerEnd(other) <= layer.startMs) minStart = Math.max(minStart, layerEnd(other))
    if (other.startMs >= end) maxEnd = Math.min(maxEnd, other.startMs)
  }
  if (layer.kind === 'video' || layer.kind === 'audio') {
    const rate = layer.playbackRate
    minStart = Math.max(minStart, layer.startMs - layer.sourceStartMs / rate)
    if (media?.durationMs !== undefined) {
      maxEnd = Math.min(maxEnd, layer.startMs + (media.durationMs - layer.sourceStartMs) / rate)
    }
  }
  return {
    start: [Math.min(minStart, end - minDurationMs), end - minDurationMs],
    end: [layer.startMs + minDurationMs, Math.max(maxEnd, layer.startMs + minDurationMs)],
  }
}

/**
 * The start nearest to `wantedMs` where a layer of `durationMs` fits on the
 * track without overlapping anything, or null when the nearest fit is more
 * than `reachMs` away. Lets a dragged clip stop flush against a neighbour.
 */
export function nearestFreeStart(
  track: Track,
  wantedMs: number,
  durationMs: number,
  ignoreId: string | undefined,
  reachMs: number,
): number | null {
  const others = track.layers.filter((l) => l.id !== ignoreId).sort((a, b) => a.startMs - b.startMs)
  let best: number | null = null
  let gapStart = 0
  for (let i = 0; i <= others.length; i++) {
    const gapEnd = others[i]?.startMs ?? Number.POSITIVE_INFINITY
    if (gapEnd - gapStart >= durationMs) {
      const fit = Math.min(Math.max(wantedMs, gapStart), gapEnd - durationMs)
      if (best === null || Math.abs(fit - wantedMs) < Math.abs(best - wantedMs)) best = fit
    }
    const next = others[i]
    if (next) gapStart = Math.max(gapStart, layerEnd(next))
  }
  return best !== null && Math.abs(best - wantedMs) <= reachMs ? best : null
}
