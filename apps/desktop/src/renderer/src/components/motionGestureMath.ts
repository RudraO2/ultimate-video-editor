import type { Vec2 } from '@uve/core'
import type { Mat4 } from '@uve/engine'

/** A press becomes a drag after this many screen px. */
export const DRAG_LATCH_PX = 4
/** A handle drag ending this close to its key (screen px) removes the handle. */
export const HANDLE_REMOVE_PX = 4
/** Shift snaps a handle's angle to multiples of this. */
export const ANGLE_STEP_DEG = 15
/** Relative slack when deciding whether two handles form a mirrored or collinear pair. */
export const MIRROR_TOLERANCE = 0.01

export type PairMode = 'mirrored' | 'collinear' | 'broken'

const length = (v: Vec2): number => Math.hypot(v[0], v[1])

/** Turns -0 into 0 so results compare equal with `toEqual`. */
const clean = (n: number): number => (n === 0 ? 0 : n)

/** How two handles of one key relate: equal and opposite, opposite directions, or independent. */
export function pairMode(handle: Vec2 | null, partner: Vec2 | null): PairMode {
  if (!handle || !partner) return 'broken'
  const a = length(handle)
  const b = length(partner)
  if (a === 0 || b === 0) return 'broken'
  const sum = Math.hypot(handle[0] + partner[0], handle[1] + partner[1])
  if (sum <= MIRROR_TOLERANCE * Math.max(a, b)) return 'mirrored'
  const dot = handle[0] * partner[0] + handle[1] * partner[1]
  const cross = handle[0] * partner[1] - handle[1] * partner[0]
  if (dot < 0 && Math.abs(cross) / (a * b) <= MIRROR_TOLERANCE) return 'collinear'
  return 'broken'
}

/** Alt breaks a mirrored or collinear pair and mirrors a broken one. */
export function effectiveMode(mode: PairMode, alt: boolean): PairMode {
  if (!alt) return mode
  return mode === 'broken' ? 'mirrored' : 'broken'
}

/** Keeps the length and rounds the angle to the nearest multiple of `stepDeg`. */
export function snapAngle(v: Vec2, stepDeg = ANGLE_STEP_DEG): Vec2 {
  const len = length(v)
  if (len === 0) return v
  const step = (stepDeg * Math.PI) / 180
  const angle = Math.round(Math.atan2(v[1], v[0]) / step) * step
  return [clean(Math.cos(angle) * len), clean(Math.sin(angle) * len)]
}

/** What to write on the other handle while `value` is dragged, or undefined to leave it. */
export function partnerValue(value: Vec2, partner: Vec2 | null, mode: PairMode): Vec2 | undefined {
  if (mode === 'mirrored') return [clean(-value[0]), clean(-value[1])]
  if (mode !== 'collinear' || !partner) return undefined
  const len = length(value)
  const keep = length(partner)
  if (len === 0 || keep === 0) return undefined
  const k = keep / len
  return [clean(-value[0] * k), clean(-value[1] * k)]
}

export interface SnapTargets {
  xs: readonly number[]
  ys: readonly number[]
}

function snapAxis(v: number, targets: readonly number[], threshold: number): number | null {
  let best: number | null = null
  let bestDistance = Infinity
  for (const t of targets) {
    const d = Math.abs(t - v)
    if (d <= threshold && d < bestDistance) {
      best = t
      bestDistance = d
    }
  }
  return best
}

/** Snaps each axis on its own to the nearest target within `threshold` (inclusive). */
export function snapPoint(
  value: Vec2,
  targets: SnapTargets,
  threshold: number,
): { value: Vec2; snappedX: number | null; snappedY: number | null } {
  const snappedX = snapAxis(value[0], targets.xs, threshold)
  const snappedY = snapAxis(value[1], targets.ys, threshold)
  return { value: [snappedX ?? value[0], snappedY ?? value[1]], snappedX, snappedY }
}

/**
 * The inverse of mapping a parent-space point through `above` into comp space,
 * using only the 2D affine part. Identity when there is no matrix or it is singular.
 */
export function parentFromComp(above: Mat4 | undefined): (x: number, y: number) => Vec2 {
  const identity = (x: number, y: number): Vec2 => [x, y]
  if (!above) return identity
  const a = above[0] as number
  const c = above[1] as number
  const b = above[4] as number
  const d = above[5] as number
  const tx = above[12] as number
  const ty = above[13] as number
  const det = a * d - b * c
  if (Math.abs(det) < 1e-9) return identity
  return (x, y) => {
    const dx = x - tx
    const dy = y - ty
    return [(d * dx - b * dy) / det, (-c * dx + a * dy) / det]
  }
}
