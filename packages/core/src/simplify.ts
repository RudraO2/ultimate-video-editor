import { ease } from './easing'
import { evaluateProperty, type PropertySpec, propertiesOf } from './properties'
import type { Easing, Keyframe, Layer } from './schema'

// Turning sampled keys (a track keyed on every frame) into the fewest eased
// keys that play the same, within a tolerance. Our own algorithm: greedy
// segments, each fitted by the simplest easing that stays inside the
// tolerance at every frame.

/** Simplest first: the segment gets the first easing that fits. */
const CANDIDATES: readonly Easing[] = [
  'linear',
  'hold',
  'ease-in-out',
  'ease-out',
  'ease-in',
  'ease-out-quart',
  'ease-out-expo',
  'ease-out-back',
  'ease-in-back',
  'ease-in-out-back',
  'ease-out-elastic',
]

/** Grid of the bezier's horizontal handles; the vertical ones are solved by least squares. */
const GRID = [0.1, 0.3, 0.5, 0.7, 0.9]
const Y_MIN = -2
const Y_MAX = 3
const EPS_MS = 1e-3

/** Layer-time sample points: every comp frame inside [startMs, endMs], and both ends exactly. */
export function sampleTimes(startMs: number, endMs: number, layerStartMs: number, fps: number): number[] {
  const times = [startMs]
  if (endMs <= startMs) return times
  const frameMs = 1000 / fps
  const first = Math.ceil((layerStartMs + startMs) / frameMs - 1e-9)
  const last = Math.floor((layerStartMs + endMs) / frameMs + 1e-9)
  for (let k = first; k <= last; k++) {
    const t = k * frameMs - layerStartMs
    if (t > startMs + EPS_MS && t < endMs - EPS_MS) times.push(t)
  }
  times.push(endMs)
  return times
}

/** The largest |a + d·ease(e, p) − y| over the samples, giving up early past `limit`. */
function axisError(e: Easing, a: number, d: number, p: Float64Array, y: Float64Array, limit: number): number {
  let worst = 0
  for (let k = 0; k < p.length; k++) {
    const value = e === 'linear' ? a + d * (p[k] as number) : a + d * ease(e, p[k] as number)
    const err = Math.abs(value - (y[k] as number))
    if (err > worst) {
      worst = err
      if (worst > limit) return worst
    }
  }
  return worst
}

/** A cubic-bezier easing through (0,0) and (1,1) for normalised samples (p, q), or null when none fits within `limit` of q. */
function fitBezier(a: number, d: number, p: Float64Array, y: Float64Array, limit: number): Easing | null {
  const n = p.length
  const q = new Float64Array(n)
  for (let k = 0; k < n; k++) q[k] = ((y[k] as number) - a) / d
  const t = new Float64Array(n)
  let best: { x1: number; y1: number; x2: number; y2: number; err: number } | null = null
  for (const x1 of GRID) {
    for (const x2 of GRID) {
      // Curve parameter of each sample: x(t) = p, found by bisection.
      for (let k = 0; k < n; k++) {
        let lo = 0
        let hi = 1
        const target = p[k] as number
        for (let it = 0; it < 22; it++) {
          const mid = (lo + hi) / 2
          const u = 1 - mid
          const x = 3 * u * u * mid * x1 + 3 * u * mid * mid * x2 + mid * mid * mid
          if (x < target) lo = mid
          else hi = mid
        }
        t[k] = (lo + hi) / 2
      }
      // y(t) = 3u²t·y1 + 3ut²·y2 + t³ is linear in y1, y2: solve the 2x2 normal equations.
      let s11 = 0
      let s12 = 0
      let s22 = 0
      let r1 = 0
      let r2 = 0
      for (let k = 0; k < n; k++) {
        const tk = t[k] as number
        const u = 1 - tk
        const b1 = 3 * u * u * tk
        const b2 = 3 * u * tk * tk
        const r = (q[k] as number) - tk * tk * tk
        s11 += b1 * b1
        s12 += b1 * b2
        s22 += b2 * b2
        r1 += b1 * r
        r2 += b2 * r
      }
      const det = s11 * s22 - s12 * s12
      let y1: number
      let y2: number
      if (Math.abs(det) > 1e-12) {
        y1 = (r1 * s22 - r2 * s12) / det
        y2 = (s11 * r2 - s12 * r1) / det
      } else {
        // Too few samples to tell the handles apart (one in between): fit them as one, y1 = y2.
        const s = s11 + 2 * s12 + s22
        if (s < 1e-12) continue
        y1 = y2 = (r1 + r2) / s
      }
      y1 = Math.min(Y_MAX, Math.max(Y_MIN, y1))
      y2 = Math.min(Y_MAX, Math.max(Y_MIN, y2))
      let err = 0
      for (let k = 0; k < n; k++) {
        const tk = t[k] as number
        const u = 1 - tk
        const yy = 3 * u * u * tk * y1 + 3 * u * tk * tk * y2 + tk * tk * tk
        err = Math.max(err, Math.abs(yy - (q[k] as number)))
      }
      if (!best || err < best.err) best = { x1, y1, x2, y2, err }
    }
  }
  if (!best || best.err * Math.abs(d) > limit * 1.5) return null
  const rounded = (v: number) => Math.round(v * 1e5) / 1e5
  const easing: Easing = { type: 'bezier', x1: best.x1, y1: rounded(best.y1), x2: best.x2, y2: rounded(best.y2) }
  // The rounded curve is what plays: check it for real.
  return axisError(easing, a, d, p, y, limit) <= limit ? easing : null
}

/** The simplest easing that carries one axis from sample i to sample j within `limit`, or null. */
function fitAxis(times: readonly number[], values: readonly number[], i: number, j: number, limit: number): Easing | null {
  if (j === i + 1) return 'linear'
  const a = values[i] as number
  const b = values[j] as number
  const d = b - a
  const t0 = times[i] as number
  const span = (times[j] as number) - t0
  const count = j - i - 1
  const p = new Float64Array(count)
  const y = new Float64Array(count)
  for (let k = 0; k < count; k++) {
    p[k] = ((times[i + 1 + k] as number) - t0) / span
    y[k] = values[i + 1 + k] as number
  }
  if (Math.abs(d) < 1e-12) return axisError('linear', a, 0, p, y, limit) <= limit ? 'linear' : null
  for (const e of CANDIDATES) {
    if (axisError(e, a, d, p, y, limit) <= limit) return e
  }
  return fitBezier(a, d, p, y, limit)
}

export interface Reduced {
  /** Indices of the kept samples, first to last. */
  keep: number[]
  /** Per axis: the easing leaving each kept sample except the last. */
  eases: Easing[][]
}

/**
 * Reduces sampled values to a few eased keys. `axes[a][k]` is axis a at time
 * `times[k]`; the error is the distance between the played and the sampled
 * point (an axis alone is its absolute error), at most `tolerance` at every
 * sample. Axes share key times and each picks its own easing per segment.
 */
export function reduceSeries(times: readonly number[], axes: readonly (readonly number[])[], tolerance: number): Reduced {
  const n = times.length
  const limit = tolerance / Math.sqrt(axes.length)
  const fit = (i: number, j: number): Easing[] | null => {
    const out: Easing[] = []
    for (const values of axes) {
      const e = fitAxis(times, values, i, j, limit)
      if (e === null) return null
      out.push(e)
    }
    return out
  }
  const keep = [0]
  const eases: Easing[][] = axes.map(() => [])
  let i = 0
  while (i < n - 1) {
    let lo = i + 1
    let loFit = fit(i, lo) as Easing[]
    let hi = -1
    // Gallop out to the first segment that does not fit, then bisect back.
    for (let step = 2; lo < n - 1; step *= 2) {
      const probe = Math.min(n - 1, i + step)
      const f = fit(i, probe)
      if (f) {
        lo = probe
        loFit = f
      } else {
        hi = probe
        break
      }
    }
    while (hi >= 0 && hi - lo > 1) {
      const mid = (lo + hi) >> 1
      const f = fit(i, mid)
      if (f) {
        lo = mid
        loFit = f
      } else {
        hi = mid
      }
    }
    keep.push(lo)
    loFit.forEach((e, axis) => eases[axis]?.push(e))
    i = lo
  }
  return { keep, eases }
}

const round3 = (n: number) => Math.round(n * 1000) / 1000
const round6 = (n: number) => Math.round(n * 1e6) / 1e6

/** Default tolerance by property: pixels for place and size, degrees for turns, a share of the range otherwise. */
export function defaultTolerance(path: string, range: number): number {
  if (/^transform\.[xyz]$/.test(path) || /(^|\.)(width|height|maxWidth|maxHeight|fontSize)$/.test(path)) return 0.5
  if (/(rotation|rotationX|rotationY|skew)$/.test(path)) return 0.25
  return Math.max(1e-5, 0.003 * range)
}

/** The numeric tracks of a layer a simplify can reduce: 3 keys or more, all numbers. */
export function simplifiableTracks(layer: Layer): { spec: PropertySpec; keys: readonly Keyframe[] }[] {
  const found: { spec: PropertySpec; keys: readonly Keyframe[] }[] = []
  for (const spec of propertiesOf(layer)) {
    const keys = layer.animations[spec.path]
    if (spec.type !== 'number' || !keys || keys.length < 3) continue
    if (keys.every((k) => typeof k.v === 'number')) found.push({ spec, keys })
  }
  return found
}

export interface TrackResult {
  spec: PropertySpec
  before: number
  after: number
  /** The new keys, when the track gets rewritten. */
  keys?: Keyframe[]
}

interface Sampled {
  spec: PropertySpec
  keys: readonly Keyframe[]
}

/** Samples a track at the given layer times, as what plays now. */
function sampleTrack(layer: Layer, spec: PropertySpec, times: readonly number[]): number[] {
  return times.map((t) => evaluateProperty(layer, spec, t) as number)
}

/** Keys from kept samples: first and last exact, the rest rounded; the last key keeps its old easing. */
function buildKeys(times: readonly number[], values: readonly number[], keep: readonly number[], eases: readonly Easing[], lastEase: Easing): Keyframe[] {
  return keep.map((index, m) => {
    const exact = index === 0 || index === times.length - 1
    const t = exact ? (times[index] as number) : round3(times[index] as number)
    const v = exact ? (values[index] as number) : round6(values[index] as number)
    return { t, v, ease: m < keep.length - 1 ? (eases[m] as Easing) : lastEase }
  })
}

/**
 * Simplifies some of a layer's numeric tracks. When transform.x and transform.y
 * are both there they are reduced together (one shared set of key times, the
 * error is the distance on the canvas); a track is rewritten only when that
 * leaves it with fewer keys.
 */
export function simplifyTracks(layer: Layer, tracks: readonly Sampled[], fps: number, tolerance?: number): TrackResult[] {
  const results = new Map<string, TrackResult>()
  const single = (track: Sampled) => {
    const first = track.keys[0] as Keyframe
    const last = track.keys[track.keys.length - 1] as Keyframe
    const times = sampleTimes(first.t, last.t, layer.startMs, fps)
    const values = sampleTrack(layer, track.spec, times)
    const range = Math.max(...values) - Math.min(...values)
    const reduced = reduceSeries(times, [values], tolerance ?? defaultTolerance(track.spec.path, range))
    const keys = buildKeys(times, values, reduced.keep, reduced.eases[0] ?? [], last.ease)
    const result: TrackResult = { spec: track.spec, before: track.keys.length, after: track.keys.length }
    if (keys.length < track.keys.length) {
      result.after = keys.length
      result.keys = keys
    }
    results.set(track.spec.path, result)
  }

  const x = tracks.find((t) => t.spec.path === 'transform.x')
  const y = tracks.find((t) => t.spec.path === 'transform.y')
  let joined = false
  if (x && y) {
    const firsts = [x, y].map((t) => (t.keys[0] as Keyframe).t)
    const lasts = [x, y].map((t) => (t.keys[t.keys.length - 1] as Keyframe).t)
    const times = sampleTimes(Math.min(...firsts), Math.max(...lasts), layer.startMs, fps)
    const xs = sampleTrack(layer, x.spec, times)
    const ys = sampleTrack(layer, y.spec, times)
    const reduced = reduceSeries(times, [xs, ys], tolerance ?? defaultTolerance('transform.x', 0))
    const after = reduced.keep.length
    if (after <= x.keys.length && after <= y.keys.length && 2 * after < x.keys.length + y.keys.length) {
      joined = true
      ;[
        { track: x, values: xs, eases: reduced.eases[0] ?? [] },
        { track: y, values: ys, eases: reduced.eases[1] ?? [] },
      ].forEach(({ track, values, eases }) => {
        const keys = buildKeys(times, values, reduced.keep, eases, (track.keys[track.keys.length - 1] as Keyframe).ease)
        results.set(track.spec.path, { spec: track.spec, before: track.keys.length, after, keys })
      })
    }
  }
  for (const track of tracks) {
    if (joined && (track === x || track === y)) continue
    single(track)
  }
  return tracks.map((t) => results.get(t.spec.path) as TrackResult)
}
