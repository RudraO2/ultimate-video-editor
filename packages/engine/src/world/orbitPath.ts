import { type Comp, type Layer, type Vec3, worldPathTimes, worldPivotAt } from '@uve/core'

// The 3D motion path of a layer as the orbit view draws it: where its pivot
// stands in the world over its span (sampled as the camera view's overlay
// does, see core's `worldPathTimes`), and one point per key time of x, y and
// z. Pure; the lines are made in helpers.ts.

/** A path that never moves this far from its first point is not drawn, px. */
export const PATH_STILL_PX = 0.5
/** Key times closer than this are one key, ms. */
const SAME_MOMENT_MS = 0.5
/** A layer covers [start, end): its last sample is read this far before the end. */
const END_EPSILON_MS = 0.001

const AXES = ['transform.x', 'transform.y', 'transform.z'] as const

/** A layer's path through the world. */
export interface OrbitPath {
  /** The pivot at each sample, in time order, world px. */
  points: Vec3[]
  /** The pivot at each distinct key time on x, y and z. */
  keys: Vec3[]
}

/** The comp times of a layer's keys on x, y and z that lie inside its span, sorted and merged. */
export function pathKeyTimes(layer: Layer): number[] {
  const times: number[] = []
  for (const axis of AXES) {
    for (const key of layer.animations[axis] ?? []) {
      if (key.t >= 0 && key.t <= layer.durationMs) times.push(layer.startMs + key.t)
    }
  }
  const out: number[] = []
  for (const t of times.sort((a, b) => a - b)) {
    const last = out[out.length - 1]
    if (last === undefined || t - last >= SAME_MOMENT_MS) out.push(t)
  }
  return out
}

/** Whether any of the points is at least `PATH_STILL_PX` from the first. */
export function moves(points: readonly Vec3[]): boolean {
  const first = points[0]
  if (!first) return false
  return points.some((p) => Math.hypot(p[0] - first[0], p[1] - first[1], p[2] - first[2]) >= PATH_STILL_PX)
}

/** Computes a layer's path; null when the layer is not in the comp or its pivot stays within half a px. */
export function computePath(comp: Comp, layer: Layer): OrbitPath | null {
  const end = layer.startMs + layer.durationMs
  const pivot = (t: number) => worldPivotAt(comp, layer.id, Math.min(t, end - END_EPSILON_MS))
  const points: Vec3[] = []
  for (const t of worldPathTimes(layer, comp)) {
    const p = pivot(t)
    if (p) points.push(p)
  }
  if (points.length < 2 || !moves(points)) return null
  const keys: Vec3[] = []
  for (const t of pathKeyTimes(layer)) {
    const p = pivot(t)
    if (p) keys.push(p)
  }
  return { points, keys }
}

/** Paths already computed, per comp object (a new comp is a new entry) and layer id. */
const cache = new WeakMap<Comp, Map<string, OrbitPath | null>>()

/** `computePath` for a layer id, remembered until the document changes (comps are immutable). */
export function pathOf(comp: Comp, layerId: string): OrbitPath | null {
  let byLayer = cache.get(comp)
  if (!byLayer) cache.set(comp, (byLayer = new Map()))
  if (byLayer.has(layerId)) return byLayer.get(layerId) ?? null
  const layer = comp.tracks.flatMap((t) => t.layers).find((l) => l.id === layerId)
  const path = layer ? computePath(comp, layer) : null
  byLayer.set(layerId, path)
  return path
}
