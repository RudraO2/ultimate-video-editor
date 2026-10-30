import { ancestorGroups } from './groups'
import { projectWorldPoint, type Vec3, type WorldCamera, worldObjects } from './world'
import type { Comp, Layer } from './schema'

// The motion path of a layer in a 3D world, seen through a camera: where its
// pivot goes in world space over its span, sampled and projected to comp px.
// Read-only geometry for the viewport overlay; pure, no DOM.

const AXES = ['transform.x', 'transform.y', 'transform.z'] as const

/** Times (comp ms) closer than this are one moment. */
const SAME_MOMENT_MS = 0.5
/** AtomCut samples a path 48 times per second of the layer, within these bounds. */
const SAMPLES_PER_SECOND = 48
const MIN_SAMPLES = 2
const MAX_SAMPLES = 160
/** The layer covers [start, end): the last sample is read this far before the end. */
const END_EPSILON_MS = 0.001
/** A path whose projection stays within this of its first point is not drawn. */
const STILL_PX = 0.5

/** The comp times of a layer's keys on x, y and z inside its span, sorted and merged. */
function keyTimes(layer: Layer): number[] {
  const times: number[] = []
  for (const axis of AXES) {
    for (const key of layer.animations[axis] ?? []) {
      if (key.t >= 0 && key.t <= layer.durationMs) times.push(layer.startMs + key.t)
    }
  }
  return mergeTimes(times)
}

function mergeTimes(times: readonly number[]): number[] {
  const out: number[] = []
  for (const t of [...times].sort((a, b) => a - b)) {
    const last = out[out.length - 1]
    if (last === undefined || t - last >= SAME_MOMENT_MS) out.push(t)
  }
  return out
}

/** True when x, y or z has keys at two or more distinct times, all three together. */
function keyedPath(layer: Layer): boolean {
  const times: number[] = []
  for (const axis of AXES) for (const key of layer.animations[axis] ?? []) times.push(key.t)
  return mergeTimes(times).length >= 2
}

/**
 * The layers a layer's follow and childOf constraints read, and those layers'
 * own targets in turn (cycle-safe), each with the groups it stands in: what
 * moves the layer besides its own keys.
 */
function drivers(layer: Layer, comp: Comp): Layer[] {
  const found: Layer[] = []
  const seen = new Set<string>([layer.id])
  const visit = (from: Layer) => {
    for (const c of from.constraints ?? []) {
      if ((c.type !== 'follow' && c.type !== 'childOf') || !c.enabled || c.targetId === null || seen.has(c.targetId)) continue
      const target = comp.tracks.flatMap((t) => t.layers).find((l) => l.id === c.targetId)
      if (!target) continue
      seen.add(target.id)
      found.push(target, ...ancestorGroups(comp, target.id))
      visit(target)
    }
  }
  visit(layer)
  return found
}

/**
 * True when x, y or z has keys at two or more distinct times, all three
 * together. With `comp`, also when the layer follows or is the child of a
 * layer (or a group that layer is in) that has such keys, however far down the
 * chain.
 */
export function hasWorldPath(layer: Layer, comp?: Comp): boolean {
  return keyedPath(layer) || (comp !== undefined && drivers(layer, comp).some(keyedPath))
}

/**
 * The comp times a path is sampled at: n = ceil(seconds × 48) evenly spread
 * over the layer's span (both ends included, n from 2 to 160), plus every key
 * time on x, y and z inside it. Sorted; moments closer than half a ms are one
 * (the key's time wins).
 */
export function worldPathTimes(layer: Layer, comp?: Comp): number[] {
  const n = Math.min(MAX_SAMPLES, Math.max(MIN_SAMPLES, Math.ceil((layer.durationMs / 1000) * SAMPLES_PER_SECOND)))
  const end = layer.startMs + layer.durationMs
  const driven = comp ? drivers(layer, comp).flatMap(keyTimes).filter((t) => t >= layer.startMs && t <= end) : []
  const keys = mergeTimes([...keyTimes(layer), ...driven])
  const samples = Array.from({ length: n }, (_, i) => layer.startMs + (layer.durationMs * i) / (n - 1))
  const out: number[] = []
  for (const t of [...samples.filter((s) => !keys.some((k) => Math.abs(k - s) < SAME_MOMENT_MS)), ...keys].sort((a, b) => a - b)) {
    const last = out[out.length - 1]
    if (last === undefined || t - last >= SAME_MOMENT_MS) out.push(t)
    else if (keys.includes(t)) out[out.length - 1] = t
  }
  return out
}

/**
 * Where a layer's pivot stands in the world at a comp time, every group above
 * it applied; null when the layer is not standing in the world then (outside
 * its span, disabled, on a hidden lane). A layer spans [start, end).
 */
export function worldPivotAt(comp: Comp, layerId: string, timeMs: number): Vec3 | null {
  // Without a box the pivot offset is zero, so the matrix's translation is the pivot.
  const object = worldObjects(comp, timeMs).find((o) => o.layer.id === layerId)
  return object ? object.position : null
}

/**
 * Pivots already sampled, per comp and layer (comps are immutable, so a new
 * comp is a new entry): the viewport redraws every frame while playing, and
 * only the camera moves then.
 */
const pivotCache = new WeakMap<Comp, Map<string, Map<number, Vec3 | null>>>()

function cachedPivot(comp: Comp, layerId: string, timeMs: number): Vec3 | null {
  let layers = pivotCache.get(comp)
  if (!layers) pivotCache.set(comp, (layers = new Map()))
  let times = layers.get(layerId)
  if (!times) layers.set(layerId, (times = new Map()))
  if (!times.has(timeMs)) times.set(timeMs, worldPivotAt(comp, layerId, timeMs))
  return times.get(timeMs) ?? null
}

export interface WorldMotionPath {
  /** The path as polylines in comp px (top-left origin), one per stretch in front of the camera. */
  runs: { x: number; y: number; timeMs: number }[][]
  /** One per distinct key time of x, y and z; `index` counts all of them, so a key behind the camera leaves a gap. */
  keys: { index: number; timeMs: number; x: number; y: number }[]
  /** The pivot at the playhead, when it is within the layer's span and in front of the camera. */
  playhead?: { x: number; y: number }
}

/**
 * The motion path of a layer as `camera` sees it, in comp px with a top-left
 * origin. Null when the layer is not in the comp, has no path (`hasWorldPath`)
 * or its projection never leaves a half pixel around its first point (a move
 * straight along the view axis): AtomCut draws no path then.
 */
export function worldMotionPath(comp: Comp, layerId: string, camera: WorldCamera, options: { playheadMs?: number } = {}): WorldMotionPath | null {
  const layer = comp.tracks.flatMap((t) => t.layers).find((l) => l.id === layerId)
  if (!layer || !hasWorldPath(layer, comp)) return null
  const end = layer.startMs + layer.durationMs
  const project = (timeMs: number): { x: number; y: number } | null => {
    const pivot = cachedPivot(comp, layerId, Math.min(timeMs, end - END_EPSILON_MS))
    const at = pivot ? projectWorldPoint(camera, comp.width, comp.height, pivot) : null
    return at ? { x: at[0], y: at[1] } : null
  }

  const runs: WorldMotionPath['runs'] = []
  let run: WorldMotionPath['runs'][number] = []
  let first: { x: number; y: number } | null = null
  let moved = false
  for (const timeMs of worldPathTimes(layer, comp)) {
    const p = project(timeMs)
    if (!p) {
      if (run.length > 0) runs.push(run)
      run = []
      continue
    }
    first ??= p
    if (Math.hypot(p.x - first.x, p.y - first.y) > STILL_PX) moved = true
    run.push({ ...p, timeMs })
  }
  if (run.length > 0) runs.push(run)
  if (!moved) return null

  const keys: WorldMotionPath['keys'] = []
  keyTimes(layer).forEach((timeMs, index) => {
    const p = project(timeMs)
    if (p) keys.push({ index, timeMs, ...p })
  })
  const result: WorldMotionPath = { runs, keys }
  const playheadMs = options.playheadMs
  if (playheadMs !== undefined && playheadMs >= layer.startMs && playheadMs <= end) {
    const p = project(playheadMs)
    if (p) result.playhead = p
  }
  return result
}
