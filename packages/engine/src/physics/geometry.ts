// Plain 2D polygon helpers for collision shapes: hulls, areas, simplifying a
// ring, and cutting a simple polygon into convex pieces. Nothing here knows
// about scenes or layers, and nothing throws: bad input gives a safe answer.

export type Point = [number, number]

const at = (points: readonly Point[], i: number): Point => points[((i % points.length) + points.length) % points.length] as Point

/** Cross product of (b - a) and (c - a): positive when c is left of a→b in y-up maths. */
const cross = (a: Point, b: Point, c: Point): number => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

const finite = (p: Point): boolean => Number.isFinite(p[0]) && Number.isFinite(p[1])

/** The signed area of a closed ring (shoelace): positive when it runs counter-clockwise in y-up maths, so clockwise on screen. */
export function polygonArea(points: readonly Point[]): number {
  let sum = 0
  for (let i = 0; i < points.length; i++) {
    const a = at(points, i)
    const b = at(points, i + 1)
    sum += a[0] * b[1] - b[0] * a[1]
  }
  return sum / 2
}

/** The convex hull (monotone chain), with positive area and no collinear points. Fewer than three distinct points come back as they are. */
export function convexHull(points: readonly Point[]): Point[] {
  const sorted = points
    .filter(finite)
    .map((p): Point => [p[0], p[1]])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const unique = sorted.filter((p, i) => i === 0 || p[0] !== (sorted[i - 1] as Point)[0] || p[1] !== (sorted[i - 1] as Point)[1])
  if (unique.length < 3) return unique
  const half = (pts: Point[]): Point[] => {
    const out: Point[] = []
    for (const p of pts) {
      while (out.length >= 2 && cross(out[out.length - 2] as Point, out[out.length - 1] as Point, p) <= 0) out.pop()
      out.push(p)
    }
    out.pop()
    return out
  }
  const hull = [...half(unique), ...half([...unique].reverse())]
  return hull.length >= 3 && polygonArea(hull) < 0 ? hull.reverse() : hull
}

function lineDistance(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = Math.hypot(dx, dy)
  if (len === 0) return Math.hypot(p[0] - a[0], p[1] - a[1])
  return Math.abs(dx * (p[1] - a[1]) - dy * (p[0] - a[0])) / len
}

/** Douglas–Peucker on the open run of `ring` from index `from` to `to`; marks the points it keeps. */
function douglasPeucker(ring: readonly Point[], from: number, to: number, tolerance: number, keep: boolean[]): void {
  const stack: [number, number][] = [[from, to]]
  while (stack.length > 0) {
    const [i, j] = stack.pop() as [number, number]
    let worst = -1
    let far = tolerance
    for (let k = i + 1; k < j; k++) {
      const d = lineDistance(ring[k] as Point, ring[i] as Point, ring[j] as Point)
      if (d > far) {
        far = d
        worst = k
      }
    }
    if (worst < 0) continue
    keep[worst] = true
    stack.push([i, worst], [worst, j])
  }
}

/** Drops the vertex whose triangle with its neighbours is smallest, again and again, until `maxPoints` are left. */
function thin(ring: Point[], maxPoints: number): Point[] {
  const out = [...ring]
  while (out.length > Math.max(3, maxPoints)) {
    let best = 0
    let least = Number.POSITIVE_INFINITY
    for (let i = 0; i < out.length; i++) {
      const area = Math.abs(cross(at(out, i - 1), at(out, i), at(out, i + 1)))
      if (area < least) {
        least = area
        best = i
      }
    }
    out.splice(best, 1)
  }
  return out
}

/**
 * Simplifies a closed ring: Douglas–Peucker from two extreme points (so a
 * corner is never the start of a cut), then thinned to `maxPoints`. A ring of
 * fewer than four points is returned as it is.
 */
export function simplifyClosed(points: readonly Point[], tolerance: number, maxPoints = 64): Point[] {
  const ring = points.filter(finite).map((p): Point => [p[0], p[1]])
  if (ring.length < 4) return ring
  const farthest = (from: Point): number => {
    let best = 0
    let far = -1
    ring.forEach((p, i) => {
      const d = Math.hypot(p[0] - from[0], p[1] - from[1])
      if (d > far) {
        far = d
        best = i
      }
    })
    return best
  }
  const start = farthest(ring[farthest(ring[0] as Point)] as Point)
  // Walk the ring from `start`; the far end of the walk is the point farthest from it.
  const walk = [...ring.slice(start), ...ring.slice(0, start)]
  const first = walk[0] as Point
  let opposite = 1
  let far = -1
  walk.forEach((p, i) => {
    const d = Math.hypot(p[0] - first[0], p[1] - first[1])
    if (d > far) {
      far = d
      opposite = i
    }
  })
  const keep = new Array<boolean>(walk.length + 1).fill(false)
  const closed = [...walk, walk[0] as Point]
  keep[0] = true
  keep[opposite] = true
  keep[walk.length] = true
  douglasPeucker(closed, 0, opposite, tolerance, keep)
  douglasPeucker(closed, opposite, walk.length, tolerance, keep)
  let out = walk.filter((_, i) => keep[i])
  if (out.length < 3) out = walk.length > 3 ? [walk[0] as Point, walk[Math.floor(walk.length / 3)] as Point, walk[Math.floor((2 * walk.length) / 3)] as Point] : walk
  return out.length > maxPoints ? thin(out, maxPoints) : out
}

/** Removes repeated points and points lying on the line between their neighbours. */
function clean(points: readonly Point[], eps: number): Point[] {
  let ring = points.filter(finite).map((p): Point => [p[0], p[1]])
  for (let pass = 0; pass < 4; pass++) {
    const before = ring.length
    ring = ring.filter((p, i) => {
      const prev = at(ring, i - 1)
      return Math.hypot(p[0] - prev[0], p[1] - prev[1]) > eps
    })
    ring = ring.filter((p, i) => ring.length < 3 || Math.abs(cross(at(ring, i - 1), p, at(ring, i + 1))) > eps * Math.hypot(at(ring, i + 1)[0] - at(ring, i - 1)[0], at(ring, i + 1)[1] - at(ring, i - 1)[1]))
    if (ring.length === before) break
  }
  return ring
}

/** Whether two segments cross each other properly (a shared end point or a touch does not count). */
function crosses(a: Point, b: Point, c: Point, d: Point): boolean {
  const d1 = cross(a, b, c)
  const d2 = cross(a, b, d)
  const d3 = cross(c, d, a)
  const d4 = cross(c, d, b)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

function selfIntersects(ring: readonly Point[]): boolean {
  const n = ring.length
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue
      if (crosses(at(ring, i), at(ring, i + 1), at(ring, j), at(ring, j + 1))) return true
    }
  }
  return false
}

function inTriangle(p: Point, a: Point, b: Point, c: Point, eps: number): boolean {
  return cross(a, b, p) >= -eps && cross(b, c, p) >= -eps && cross(c, a, p) >= -eps
}

/** Ear clipping of a simple counter-clockwise ring into triangles (index triples); null when it gets stuck. */
function earClip(ring: readonly Point[], eps: number): [number, number, number][] | null {
  const idx = ring.map((_, i) => i)
  const triangles: [number, number, number][] = []
  let guard = ring.length * ring.length + 10
  let i = 0
  while (idx.length > 3 && guard-- > 0) {
    const n = idx.length
    const ia = idx[(i + n - 1) % n] as number
    const ib = idx[i % n] as number
    const ic = idx[(i + 1) % n] as number
    const a = ring[ia] as Point
    const b = ring[ib] as Point
    const c = ring[ic] as Point
    let ear = cross(a, b, c) > eps
    if (ear) {
      for (const k of idx) {
        if (k === ia || k === ib || k === ic) continue
        const p = ring[k] as Point
        const same = (q: Point) => p[0] === q[0] && p[1] === q[1]
        if (same(a) || same(b) || same(c)) continue
        if (inTriangle(p, a, b, c, eps)) {
          ear = false
          break
        }
      }
    }
    if (ear) {
      triangles.push([ia, ib, ic])
      idx.splice(i % n, 1)
      i = i % idx.length
    } else i = (i + 1) % n
  }
  if (idx.length !== 3) return null
  triangles.push([idx[0] as number, idx[1] as number, idx[2] as number])
  return triangles
}

/** Whether polygon `poly` (indices into `ring`) turns left (or straight) at each of its vertices. */
function convexAt(ring: readonly Point[], poly: readonly number[], k: number, eps: number): boolean {
  const n = poly.length
  const a = ring[poly[(k + n - 1) % n] as number] as Point
  const b = ring[poly[k] as number] as Point
  const c = ring[poly[(k + 1) % n] as number] as Point
  return cross(a, b, c) >= -eps
}

/** Hertel–Mehlhorn: merges neighbouring convex polygons across their shared diagonal while the result stays convex and small enough. */
function mergePieces(ring: readonly Point[], triangles: [number, number, number][], maxVertices: number, eps: number): number[][] {
  const polys: number[][] = triangles.map((t) => [...t])
  let merged = true
  while (merged) {
    merged = false
    outer: for (let i = 0; i < polys.length; i++) {
      for (let j = i + 1; j < polys.length; j++) {
        const pi = polys[i] as number[]
        const pj = polys[j] as number[]
        if (pi.length + pj.length - 2 > maxVertices) continue
        for (let p = 0; p < pi.length; p++) {
          const a = pi[p] as number
          const b = pi[(p + 1) % pi.length] as number
          const q = pj.findIndex((v, k) => v === b && pj[(k + 1) % pj.length] === a)
          if (q < 0) continue
          // i runs b … a, then j continues after a up to the vertex before b.
          const next: number[] = []
          for (let k = 1; k <= pi.length; k++) next.push(pi[(p + k) % pi.length] as number)
          for (let k = 2; k < pj.length; k++) next.push(pj[(q + k) % pj.length] as number)
          const atA = next.indexOf(a)
          const atB = next.indexOf(b)
          if (!convexAt(ring, next, atA, eps) || !convexAt(ring, next, atB, eps)) continue
          polys[i] = next
          polys.splice(j, 1)
          merged = true
          continue outer
        }
      }
    }
  }
  return polys
}

/** The pieces of a ring that are convex and small enough already, or the hull cut up when there are too many points. */
function pipeline(input: readonly Point[], maxVertices: number, trusted: boolean): Point[][] | null {
  let ring = clean(input, 1e-9)
  if (ring.length < 3) return []
  const xs = ring.map((p) => p[0])
  const ys = ring.map((p) => p[1])
  const diag = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
  const eps = 1e-9 * Math.max(1, diag) * Math.max(1, diag)
  ring = clean(ring, 1e-7 * Math.max(1, diag))
  if (ring.length < 3) return []
  if (polygonArea(ring) < 0) ring.reverse()
  if (!trusted && selfIntersects(ring)) return null
  const convex = ring.every((_, i) => cross(at(ring, i - 1), at(ring, i), at(ring, i + 1)) >= -eps)
  if (convex && ring.length <= maxVertices) return [ring]
  const triangles = earClip(ring, eps)
  if (!triangles) return null
  return mergePieces(ring, triangles, maxVertices, eps).map((poly) => poly.map((i) => ring[i] as Point))
}

/**
 * Cuts a simple polygon (concave allowed, either winding) into convex pieces
 * of at most `maxVertices` points: ear clipping, then Hertel–Mehlhorn
 * merging. Specks smaller than 1 px² or a tiny share of the whole are
 * dropped. It never throws: a polygon that is degenerate or crosses itself
 * becomes its convex hull (cut up when it has too many points). Pieces have
 * positive area.
 */
export function convexPieces(polygon: readonly Point[], maxVertices = 12): Point[][] {
  const limit = Math.max(3, Math.floor(maxVertices))
  let ring = polygon.filter(finite).map((p): Point => [p[0], p[1]])
  if (ring.length > 256) {
    const xs = ring.map((p) => p[0])
    const ys = ring.map((p) => p[1])
    const diag = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
    ring = simplifyClosed(ring, diag * 0.002, 200)
  }
  let pieces: Point[][] | null = null
  try {
    pieces = pipeline(ring, limit, false)
    if (!pieces) pieces = pipeline(convexHull(ring), limit, true)
  } catch {
    pieces = null
  }
  if (!pieces) {
    try {
      pieces = pipeline(convexHull(ring), limit, true) ?? []
    } catch {
      pieces = []
    }
  }
  const total = pieces.reduce((sum, p) => sum + Math.abs(polygonArea(p)), 0)
  if (total < 1) return []
  const floor = Math.max(1, total * 2e-4)
  const kept = pieces.filter((p) => Math.abs(polygonArea(p)) >= floor && p.length >= 3)
  return kept.map((p) => (polygonArea(p) < 0 ? [...p].reverse() : p))
}
