import type { Keyframe, Layer } from './schema'

/** Keys closer together than this are treated as the same moment. */
export const KEY_EPSILON_MS = 0.5

/**
 * Adds a key, or replaces the key at the same time. With `keepEase` a replaced
 * key keeps its easing, so changing a value does not change the motion curve.
 * A replaced key keeps its motion-path handles unless the new key brings its
 * own (they are relative, so they travel with the point). Keys stay sorted by
 * time.
 */
export function upsertKey(keys: Keyframe[], key: Keyframe, keepEase = true): void {
  const index = keys.findIndex((k) => Math.abs(k.t - key.t) < KEY_EPSILON_MS)
  const existing = keys[index]
  if (existing) {
    const spatial = key.spatial ?? existing.spatial
    keys[index] = { ...key, ease: keepEase ? existing.ease : key.ease, ...(spatial ? { spatial } : {}) }
    return
  }
  keys.push(key)
  keys.sort((a, b) => a.t - b.t)
}

/** Whether a track has a key within half a millisecond of `t`. */
function keyedAt(keys: readonly Keyframe[] | undefined, t: number): boolean {
  return keys?.some((k) => Math.abs(k.t - t) < KEY_EPSILON_MS) ?? false
}

/**
 * Why a layer's motion-path handles are misplaced, or null when they are
 * fine: handles belong on `transform.x` keys that have a `transform.y` key at
 * the same time.
 */
export function spatialProblem(layer: Layer): string | null {
  for (const [path, keys] of Object.entries(layer.animations)) {
    for (const key of keys) {
      if (!key.spatial) continue
      if (path !== 'transform.x') return `${layer.name} has motion-path handles on ${path}; they belong on transform.x`
      if (!keyedAt(layer.animations['transform.y'], key.t)) {
        return `${layer.name} has motion-path handles at ${key.t} ms with no transform.y key at that time`
      }
    }
  }
  return null
}

/**
 * Drops the motion-path handles a key edit has broken (in a draft): handles
 * off `transform.x`, handles of an x key whose y partner is gone, and empty
 * ones. Returns how many keys lost theirs.
 */
export function pruneSpatial(animations: Record<string, Keyframe[]>): number {
  let dropped = 0
  for (const [path, keys] of Object.entries(animations)) {
    for (const key of keys) {
      if (!key.spatial) continue
      const empty = key.spatial.in === null && key.spatial.out === null
      if (empty || path !== 'transform.x' || !keyedAt(animations['transform.y'], key.t)) {
        delete key.spatial
        if (!empty) dropped++
      }
    }
  }
  return dropped
}
