import { type Point, polygonArea, simplifyClosed } from './geometry'

export interface SilhouetteOptions {
  /** Alpha (0..255) from which a pixel counts as solid. Default 128. */
  threshold?: number
  /** Most points in one polygon. Default 64. */
  maxPoints?: number
  /** Most polygons returned. Default 6. */
  maxPolygons?: number
}

// Marching squares on the padded mask. A cell sits between four pixel centres;
// its contour runs between the midpoints of the cell's edges (T, R, B, L),
// walked so that the solid side is on the right on screen. Outer contours then
// have positive area (see `polygonArea`) and holes negative.
const T = 0
const R = 1
const B = 2
const L = 3
/** For each corner pattern (a = top left 8, b = top right 4, c = bottom right 2, d = bottom left 1): the segments as [from, to] edge pairs. Saddles keep their corners apart. */
const SEGMENTS: readonly (readonly (readonly [number, number])[])[] = [
  [], // none
  [[L, B]], // d
  [[B, R]], // c
  [[L, R]], // c d
  [[R, T]], // b
  [
    [R, T],
    [L, B],
  ], // b d
  [[B, T]], // b c
  [[L, T]], // b c d: the missing corner a, reversed
  [[T, L]], // a
  [[T, B]], // a d
  [
    [T, L],
    [B, R],
  ], // a c
  [[T, R]], // a c d: missing b
  [[R, L]], // a b
  [[R, B]], // a b d: missing c
  [[B, L]], // a b c: missing d
  [], // all
]

/**
 * The outlines of the solid part of a picture, as polygons in fractions of
 * its width and height (0..1, y down), largest first: marching squares on
 * alpha, outer contours only (holes ignored), specks dropped, each simplified
 * and rounded to 4 decimals. A fully solid picture gives the unit square and
 * an empty one gives nothing. Linear in the number of pixels.
 */
export function traceSilhouette(rgba: Uint8ClampedArray, width: number, height: number, options: SilhouetteOptions = {}): Point[][] {
  const w = Math.floor(width)
  const h = Math.floor(height)
  if (w < 1 || h < 1 || rgba.length < w * h * 4) return []
  const threshold = options.threshold ?? 128
  const maxPoints = options.maxPoints ?? 64
  const maxPolygons = options.maxPolygons ?? 6

  const mask = new Uint8Array(w * h)
  let solid = 0
  for (let i = 0; i < w * h; i++) {
    if ((rgba[i * 4 + 3] as number) >= threshold) {
      mask[i] = 1
      solid++
    }
  }
  if (solid === 0) return []
  if (solid === w * h) {
    return [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
    ]
  }
  const inside = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? (mask[y * w + x] as number) : 0)

  // Edge midpoints in doubled coordinates (X = 2x, Y = 2y): the keys of a linked list of segments.
  const stride = 2 * w + 3
  const keyOf = (cx: number, cy: number, edge: number): number => {
    const X = edge === T || edge === B ? 2 * cx : edge === R ? 2 * cx + 1 : 2 * cx - 1
    const Y = edge === L || edge === R ? 2 * cy : edge === T ? 2 * cy - 1 : 2 * cy + 1
    return (Y + 1) * stride + (X + 1)
  }
  const next = new Int32Array((2 * h + 3) * stride).fill(-1)
  const starts: number[] = []
  for (let cy = 0; cy <= h; cy++) {
    for (let cx = 0; cx <= w; cx++) {
      const code = (inside(cx - 1, cy - 1) << 3) | (inside(cx, cy - 1) << 2) | (inside(cx, cy) << 1) | inside(cx - 1, cy)
      if (code === 0 || code === 15) continue
      for (const [from, to] of SEGMENTS[code] as readonly (readonly [number, number])[]) {
        const key = keyOf(cx, cy, from)
        next[key] = keyOf(cx, cy, to)
        starts.push(key)
      }
    }
  }

  // Follow the segments into rings; those with positive area are outer contours.
  const loops: { points: Point[]; area: number }[] = []
  const seen = new Uint8Array(next.length)
  for (const start of starts) {
    if (seen[start]) continue
    const points: Point[] = []
    let key = start
    while (key >= 0 && !seen[key]) {
      seen[key] = 1
      points.push([((key % stride) - 1) / 2, (Math.floor(key / stride) - 1) / 2])
      key = next[key] as number
    }
    if (key !== start || points.length < 3) continue
    // A contour touching the picture's edge is pulled onto it, so a picture drawn to its border keeps square corners.
    const snapped = points.map(([x, y]): Point => [x < 0.75 ? 0 : x > w - 0.75 ? w : x, y < 0.75 ? 0 : y > h - 0.75 ? h : y])
    const area = polygonArea(snapped)
    if (area > 0) loops.push({ points: snapped, area })
  }
  loops.sort((a, b) => b.area - a.area)
  const largest = loops[0]?.area ?? 0
  const tolerance = 0.008 * Math.min(w, h)
  const out: Point[][] = []
  for (const loop of loops) {
    if (out.length >= maxPolygons || loop.area < largest * 0.005) break
    const ring = simplifyClosed(loop.points, tolerance, maxPoints)
    const polygon = tidy(ring, w, h)
    if (polygon.length >= 3 && polygonArea(polygon) > 0) out.push(polygon)
  }
  return out
}

/** Fractions rounded to 4 decimals, repeated and straight-through points removed, starting at the top-left-most point. */
function tidy(ring: readonly Point[], w: number, h: number): Point[] {
  const round = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000
  let pts = ring.map(([x, y]): Point => [round(x / w), round(y / h)])
  pts = pts.filter((p, i) => {
    const prev = pts[(i + pts.length - 1) % pts.length] as Point
    return p[0] !== prev[0] || p[1] !== prev[1]
  })
  pts = pts.filter((p, i) => {
    const a = pts[(i + pts.length - 1) % pts.length] as Point
    const c = pts[(i + 1) % pts.length] as Point
    return Math.abs((p[0] - a[0]) * (c[1] - a[1]) - (p[1] - a[1]) * (c[0] - a[0])) > 1e-9
  })
  if (pts.length < 3) return []
  let first = 0
  pts.forEach((p, i) => {
    const f = pts[first] as Point
    if (p[1] < f[1] || (p[1] === f[1] && p[0] < f[0])) first = i
  })
  return [...pts.slice(first), ...pts.slice(0, first)]
}
