import type { ShapeGeometry } from '@uve/core'

export type Pt = [x: number, y: number]

/** An outline as a list of points, in layer space (origin at the box centre). */
export interface Polyline {
  points: Pt[]
  closed: boolean
}

/** Points along an arc, with segments about `step` px long. */
function arcPoints(cx: number, cy: number, rx: number, ry: number, from: number, to: number, step: number): Pt[] {
  const length = Math.abs(to - from) * Math.max(rx, ry)
  const count = Math.max(2, Math.ceil(length / step))
  const points: Pt[] = []
  for (let i = 0; i <= count; i++) {
    const a = from + ((to - from) * i) / count
    points.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)])
  }
  return points
}

/**
 * A shape's outline as a closed polyline, fine enough to draw smoothly at
 * `pixelsPerUnit` output pixels per layer pixel. A rectangle's starts at its
 * top-left corner (past the rounding) and an ellipse's at the top; both run
 * clockwise on screen.
 */
export function shapeOutline(shape: ShapeGeometry, pixelsPerUnit = 1): Polyline {
  const step = Math.max(0.25, 2 / Math.max(pixelsPerUnit, 0.01))
  const w = shape.width / 2
  const h = shape.height / 2
  if (shape.type === 'polygon' || shape.type === 'star') return { points: polygonPoints(shape), closed: true }
  if (shape.type === 'ellipse') {
    // Starts at the top, like a clock.
    return { points: arcPoints(0, 0, w, h, -Math.PI / 2, (Math.PI * 3) / 2, step), closed: true }
  }
  const r = Math.min(shape.cornerRadius, w, h)
  if (r <= 0) {
    return {
      points: [
        [-w, -h],
        [w, -h],
        [w, h],
        [-w, h],
      ],
      closed: true,
    }
  }
  const half = Math.PI / 2
  const topLeft = arcPoints(-w + r, -h + r, r, r, Math.PI, Math.PI + half, step)
  return {
    points: [
      [-w + r, -h],
      ...arcPoints(w - r, -h + r, r, r, -half, 0, step),
      ...arcPoints(w - r, h - r, r, r, 0, half, step),
      ...arcPoints(-w + r, h - r, r, r, half, Math.PI, step),
      ...topLeft.slice(0, -1),
    ],
    closed: true,
  }
}

/**
 * The corners of a polygon or star inside the shape's box, starting at the
 * top and running clockwise; a star alternates its outer and inner radius.
 */
export function polygonPoints(shape: ShapeGeometry): Pt[] {
  const star = shape.type === 'star'
  const count = star ? shape.pointCount * 2 : shape.pointCount
  const points: Pt[] = []
  for (let i = 0; i < count; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / count
    const r = star && i % 2 === 1 ? shape.innerRatio : 1
    points.push([(Math.cos(a) * r * shape.width) / 2, (Math.sin(a) * r * shape.height) / 2])
  }
  return points
}

/** The length of a polyline, closing segment included when closed. */
export function polylineLength({ points, closed }: Polyline): number {
  let length = 0
  for (let i = 1; i < points.length; i++) length += distance(points[i - 1] as Pt, points[i] as Pt)
  if (closed && points.length > 1) length += distance(points[points.length - 1] as Pt, points[0] as Pt)
  return length
}

function distance(a: Pt, b: Pt): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1])
}

/** The open polyline between two distances along `line` (0 ≤ from ≤ to ≤ its length). */
function slice(line: Polyline, from: number, to: number): Pt[] {
  const pts = line.closed ? [...line.points, line.points[0] as Pt] : line.points
  const out: Pt[] = []
  let walked = 0
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as Pt
    const b = pts[i] as Pt
    const seg = distance(a, b)
    const segEnd = walked + seg
    if (segEnd >= from && walked <= to && seg > 0) {
      const at = (d: number): Pt => {
        const t = Math.min(1, Math.max(0, (d - walked) / seg))
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
      }
      if (out.length === 0) out.push(at(Math.max(from, walked)))
      out.push(at(Math.min(to, segEnd)))
    }
    walked = segEnd
    if (walked > to) break
  }
  return out
}

/**
 * The pieces of an outline that a stroke trim draws: the slice from `start`
 * to `end` (fractions of the length), moved along by `offset` laps. On a
 * closed outline the slice wraps past the start point as one piece.
 */
export function trimOutline(line: Polyline, start: number, end: number, offset: number): Pt[][] {
  const total = polylineLength(line)
  const span = Math.abs(end - start)
  if (total <= 0 || span <= 0) return []
  if (span >= 1 && line.closed) return [[...line.points, line.points[0] as Pt]]
  let from = Math.min(start, end) + offset
  if (!line.closed) {
    // An open line does not wrap: the slice is clipped to its ends.
    const a = Math.max(0, Math.min(1, from)) * total
    const b = Math.max(0, Math.min(1, from + span)) * total
    return b > a ? [slice(line, a, b)] : []
  }
  from = ((from % 1) + 1) % 1
  const to = from + span
  if (to <= 1) return [slice(line, from * total, to * total)]
  return [[...slice(line, from * total, total), ...slice(line, 0, (to - 1) * total).slice(1)]]
}
