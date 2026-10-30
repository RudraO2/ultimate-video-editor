import type { Easing, EasingPreset } from './schema'

type Curve = readonly [x1: number, y1: number, x2: number, y2: number]

// The curves of AtomCut's easing presets (preset data, ported with
// permission), so motion made here moves as it does there. ease-in-back is
// ours: AtomCut has no back-in preset.
const CURVES: Record<Exclude<EasingPreset, 'linear' | 'hold'>, Curve> = {
  'ease-in': [0.55, 0.06, 0.68, 0.19],
  'ease-out': [0.25, 0.46, 0.45, 0.94],
  'ease-in-out': [0.65, 0, 0.35, 1],
  'ease-in-back': [0.36, 0, 0.66, -0.56],
  'ease-out-back': [0.34, 1.56, 0.64, 1],
  'ease-out-quart': [0.25, 1, 0.5, 1],
  'ease-out-expo': [0.16, 1, 0.3, 1],
  'ease-in-out-back': [0.68, -0.6, 0.32, 1.6],
  'ease-out-elastic': [0.5, 1.75, 0.4, 0.95],
}

/**
 * Maps linear progress `p` (0 to 1) between two keys to eased progress.
 * `hold` keeps the first key's value until the next key is reached.
 */
export function ease(easing: Easing, p: number): number {
  if (p <= 0) return 0
  if (p >= 1) return 1
  if (easing === 'linear') return p
  if (easing === 'hold') return 0
  const [x1, y1, x2, y2] = typeof easing === 'string' ? CURVES[easing] : [easing.x1, easing.y1, easing.x2, easing.y2]
  return cubicBezier(x1, y1, x2, y2, p)
}

/**
 * Splits an easing at linear progress `p` (0 to 1, exclusive) into the two
 * easings that, on the two halves of a segment cut there, play exactly as the
 * original did: E1(s) = E(s·p) / E(p) and
 * E2(s) = (E(p + s·(1 − p)) − E(p)) / (1 − E(p)).
 * Linear stays linear and hold stays hold; the Bézier curves are cut with de
 * Casteljau at the parameter where x = p and each half is scaled back into the
 * unit box. A half that covers no distance (E(p) at 0 or 1) becomes hold. The
 * x of a half is kept inside 0 to 1, which only matters for curves that
 * double back horizontally (none of the presets do).
 */
export function splitEasing(easing: Easing, p: number): [Easing, Easing] {
  if (easing === 'linear') return ['linear', 'linear']
  if (easing === 'hold') return ['hold', 'hold']
  const [x1, y1, x2, y2] = typeof easing === 'string' ? CURVES[easing] : [easing.x1, easing.y1, easing.x2, easing.y2]

  // The curve parameter whose x is p (x is monotonic for x1, x2 in [0, 1]).
  const xAt = (t: number) => 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t
  let lo = 0
  let hi = 1
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (xAt(mid) < p) lo = mid
    else hi = mid
  }
  const t = (lo + hi) / 2

  type P = readonly [number, number]
  const lerp = (a: P, b: P): P => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
  const p1: P = [x1, y1]
  const p2: P = [x2, y2]
  const a = lerp([0, 0], p1)
  const b = lerp(p1, p2)
  const c = lerp(p2, [1, 1])
  const d = lerp(a, b)
  const e = lerp(b, c)
  const m = lerp(d, e)

  const unit = (v: number) => Math.min(1, Math.max(0, v))
  const first: Easing =
    Math.abs(m[1]) < 1e-6 || m[0] <= 0
      ? 'hold'
      : { type: 'bezier', x1: unit(a[0] / m[0]), y1: a[1] / m[1], x2: unit(d[0] / m[0]), y2: d[1] / m[1] }
  const rest = 1 - m[0]
  const drop = 1 - m[1]
  const second: Easing =
    Math.abs(drop) < 1e-6 || rest <= 0
      ? 'hold'
      : {
          type: 'bezier',
          x1: unit((e[0] - m[0]) / rest),
          y1: (e[1] - m[1]) / drop,
          x2: unit((c[0] - m[0]) / rest),
          y2: (c[1] - m[1]) / drop,
        }
  return [first, second]
}

/**
 * Evaluates a CSS-style cubic Bézier timing curve through (0,0) and (1,1) at
 * horizontal position `x`, solving numerically for the curve parameter.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  // Polynomial coefficients of each axis: f(t) = ((a·t + b)·t + c)·t
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx

  // Newton–Raphson converges in a few steps on typical curves.
  let t = x
  for (let i = 0; i < 8; i++) {
    const error = sampleX(t) - x
    if (Math.abs(error) < 1e-7) return sampleY(t)
    const slope = slopeX(t)
    if (Math.abs(slope) < 1e-6) break
    t -= error / slope
  }

  // Bisection always converges: x(t) is monotonic when x1 and x2 lie in [0, 1].
  let lo = 0
  let hi = 1
  t = x
  while (hi - lo > 1e-7) {
    if (sampleX(t) < x) lo = t
    else hi = t
    t = (lo + hi) / 2
  }
  return sampleY(t)
}
