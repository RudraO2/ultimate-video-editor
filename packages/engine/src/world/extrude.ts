import { flattenSvgPath, parseSvgPath, svgPathBounds, type Layer } from '@uve/core'
import { BufferGeometry, ExtrudeGeometry, Float32BufferAttribute, Path, Shape, Vector2 } from 'three'
import { shapeOutline, type Pt } from '../outline'
import type { Rect } from '../scene'
import type { WorldPlane } from './frame'
import { textOutlineRings } from './textOutlines'

type Ring = Pt[]
const area = (p: Ring) => p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]!; return s + a[0] * b[1] - b[0] * a[1] }, 0) / 2
function contains(p: Ring, q: Pt): boolean {
  let inside = false
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const a = p[i]!, b = p[j]!
    if ((a[1] > q[1]) !== (b[1] > q[1]) && q[0] < (b[0] - a[0]) * (q[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside
  }
  return inside
}
/** Ramer–Douglas–Peucker simplification in texture-pixel space. */
export function simplify(points: Ring, tolerance: number): Ring {
  if (points.length <= 2) return points
  const a = points[0]!, b = points[points.length - 1]!
  const dx = b[0] - a[0], dy = b[1] - a[1], length = dx * dx + dy * dy
  let max = 0, at = 0
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]!, t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0
    const d = Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
    if (d > max) { max = d; at = i }
  }
  return max > tolerance ? [...simplify(points.slice(0, at + 1), tolerance).slice(0, -1), ...simplify(points.slice(at), tolerance)] : [a, b]
}
/** Trace the edges of pixels with alpha at least 128, including holes. */
export function traceAlpha(data: Uint8ClampedArray, width: number, height: number): Ring[] {
  const edges = new Map<string, Pt[]>()
  const opaque = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && data[(y * width + x) * 4 + 3]! >= 128
  const add = (a: Pt, b: Pt) => { const k = a.join(','); const out = edges.get(k) ?? []; out.push(b); edges.set(k, out) }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (opaque(x, y)) {
    if (!opaque(x, y - 1)) add([x, y], [x + 1, y])
    if (!opaque(x + 1, y)) add([x + 1, y], [x + 1, y + 1])
    if (!opaque(x, y + 1)) add([x + 1, y + 1], [x, y + 1])
    if (!opaque(x - 1, y)) add([x, y + 1], [x, y])
  }
  const rings: Ring[] = []
  while (edges.size) {
    const start = edges.keys().next().value as string
    let key = start
    const points: Ring = []
    do {
      const ends = edges.get(key)
      if (!ends?.length) break
      const [x, y] = key.split(',').map(Number) as Pt
      points.push([x, y])
      const next = ends.pop()!
      if (!ends.length) edges.delete(key)
      key = next.join(',')
    } while (key !== start)
    if (key === start && points.length >= 3) {
      // Split at the farthest point so a closed loop's coincident endpoints do not collapse it.
      const a = points[0]!, split = points.reduce((best, p, i) => Math.hypot(p[0]-a[0], p[1]-a[1]) > Math.hypot(points[best]![0]-a[0], points[best]![1]-a[1]) ? i : best, 0)
      // One bitmap pixel straightens the staircase of a traced curve, which would otherwise shade as ridges; a ring that small keeps a finer tolerance.
      const reduce = (tolerance: number) => [...simplify(points.slice(0, split + 1), tolerance).slice(0, -1), ...simplify([...points.slice(split), a], tolerance).slice(0, -1)]
      let reduced = reduce(1)
      if (reduced.length < 3) reduced = reduce(0.4)
      if (reduced.length >= 3) rings.push(reduced)
    }
  }
  return rings
}
function shapeRings(plane: WorldPlane, canvas: OffscreenCanvas, rect: Rect, fit: 'outline' | 'box'): Ring[] {
  const node = plane.node, layer = node.layer
  if (fit === 'box' || layer.kind === 'video' || layer.kind === 'nested') {
    const { left, top, width, height } = plane.local
    return [[[left, top], [left + width, top], [left + width, top + height], [left, top + height]]]
  }
  if (layer.kind === 'text') { const glyphs = textOutlineRings(plane); if (glyphs) return glyphs }
  if (layer.kind === 'shape' && node.kind === 'leaf') return [shapeOutline(node.resolved.shape ?? layer.shape).points]
  if (layer.kind === 'path' && node.kind === 'leaf') {
    const bounds = svgPathBounds(parseSvgPath(layer.geometry)), cx = bounds.left + bounds.width / 2, cy = bounds.top + bounds.height / 2
    return flattenSvgPath(parseSvgPath(node.resolved.geometry ?? layer.geometry), 24).filter(p => p.closed).map(p => p.points.map(([x, y]) => [x - cx, y - cy]))
  }
  // Bound tracing work and keep its tolerance in bitmap pixels.
  const scale = Math.min(1, 320 / Math.max(canvas.width, canvas.height))
  const width = Math.max(1, Math.round(canvas.width * scale)), height = Math.max(1, Math.round(canvas.height * scale))
  const traced = scale === 1 ? canvas : new OffscreenCanvas(width, height)
  const ctx = traced.getContext('2d')!
  if (traced !== canvas) ctx.drawImage(canvas, 0, 0, width, height)
  return traceAlpha(ctx.getImageData(0, 0, width, height).data, width, height).map(r => r.map(([x, y]) => [rect.left + x * rect.width / width, rect.top + y * rect.height / height]))
}
function toShapes(rings: Ring[]): Shape[] {
  const sorted = rings.filter(r => Math.abs(area(r)) > 1e-6).sort((a, b) => Math.abs(area(b)) - Math.abs(area(a)))
  const parents = sorted.map((ring, i) => { for (let j = i - 1; j >= 0; j--) if (contains(sorted[j]!, ring[0]!)) return j; return -1 })
  const depth = parents.map((p, i) => { let n = 0; while (p >= 0) { n++; p = parents[p]! }; return n })
  const shapes = new Map<number, Shape>()
  sorted.forEach((ring, i) => {
    const pts = ring.map(([x, y]) => new Vector2(x, y))
    if (depth[i]! % 2 === 0) shapes.set(i, new Shape(pts))
    else { let p = parents[i]!; while (p >= 0 && !shapes.has(p)) p = parents[p]!; shapes.get(p)?.holes.push(new Path(pts)) }
  })
  return [...shapes.values()]
}
interface Cached { geometry: BufferGeometry; refs: number; used: number }
const cache = new Map<string, Cached>()
let clock = 0
/** Outlines by picture, so keyed depth or bevel builds new solids without tracing again. */
const outlines = new Map<string, Shape[]>()
function outlineOf(outlineKey: string, plane: WorldPlane, canvas: OffscreenCanvas, rect: Rect, fit: 'outline' | 'box'): Shape[] {
  let shapes = outlines.get(outlineKey)
  if (shapes) outlines.delete(outlineKey)
  else shapes = toShapes(shapeRings(plane, canvas, rect, fit))
  outlines.set(outlineKey, shapes)
  if (outlines.size > 64) outlines.delete(outlines.keys().next().value as string)
  return shapes
}
/** The solid behind a picture: `outlineKey` names its outline, `key` that outline at this depth and bevel. */
export function acquireExtrusion(outlineKey: string, key: string, plane: WorldPlane, canvas: OffscreenCanvas, rect: Rect, spec: NonNullable<Layer['extrude']>): BufferGeometry {
  let entry = cache.get(key)
  if (!entry) {
    const shapes = outlineOf(outlineKey, plane, canvas, rect, spec.fit)
    // A slab keeps its front: where the picture is clear, the slab shows instead of its hollow inside.
    const box = spec.fit === 'box' || plane.node.layer.kind === 'video' || plane.node.layer.kind === 'nested'
    const built = new ExtrudeGeometry(shapes, { depth: spec.depth, bevelEnabled: spec.bevel > 0, bevelThickness: spec.bevel, bevelSize: spec.bevel, bevelOffset: -spec.bevel, bevelSegments: spec.bevelSegments, steps: 1 })
    // The face is the picture plane (an outline solid drops its front cap). Retain the rear cap and sides in their solid material.
    // ExtrudeGeometry puts both caps in one group, so select rear triangles by Z.
    const positions = built.getAttribute('position')
    const vertices: number[] = []
    for (const group of built.groups) {
      for (let i = group.start; i < group.start + group.count; i += 3) {
        if (group.materialIndex === 1 || box || (positions.getZ(i) >= spec.depth - 1e-6 && positions.getZ(i + 1) >= spec.depth - 1e-6 && positions.getZ(i + 2) >= spec.depth - 1e-6)) vertices.push(i, i + 1, i + 2)
      }
    }
    const geometry = new BufferGeometry()
    for (const name of ['position', 'normal', 'uv']) {
      const source = built.getAttribute(name)
      const values: number[] = []
      for (const i of vertices) for (let c = 0; c < source.itemSize; c++) values.push(source.array[i * source.itemSize + c] as number)
      geometry.setAttribute(name, new Float32BufferAttribute(values, source.itemSize))
    }
    geometry.translate(0, 0, spec.bevel)
    built.dispose()
    entry = { geometry, refs: 0, used: 0 }; cache.set(key, entry)
  }
  entry.refs++; entry.used = ++clock
  while (cache.size > 64) { const victim = [...cache.entries()].filter(([, v]) => !v.refs).sort((a, b) => a[1].used - b[1].used)[0]; if (!victim) break; victim[1].geometry.dispose(); cache.delete(victim[0]) }
  return entry.geometry
}
export function releaseExtrusion(key: string): void { const e = cache.get(key); if (e) e.refs = Math.max(0, e.refs - 1) }

