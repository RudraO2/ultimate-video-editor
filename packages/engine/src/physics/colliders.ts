import { flattenSvgPath, type Layer, parseSvgPath, svgPathBounds } from '@uve/core'
import { type Ctx2D, layoutText } from '../content'
import type { Mat4 } from '../math'
import { transformPoint } from '../math'
import { polygonPoints } from '../outline'
import type { GroupNode, LeafNode, NestedNode, SceneNode } from '../scene'
import { convexHull, convexPieces, type Point, polygonArea, simplifyClosed } from './geometry'

/** How a body is cut for collisions: from its looks (auto), or forced. */
export type BodyShape = 'auto' | 'box' | 'sphere' | 'hull' | 'outline'

/** A collision shape in comp space (origin at the comp centre, +y down, px). Polygons are convex with at most 12 points. */
export type Collider = { kind: 'circle'; x: number; y: number; radius: number } | { kind: 'polygon'; points: Point[] }

/** Most points of a polygon fixture (Box2D's limit). */
const MAX_POLYGON_POINTS = 12
/** Points drawn around an ellipse that is not round. */
const ELLIPSE_POINTS = 24
/** Smaller than this (px²) is not a shape. */
const MIN_AREA = 0.5

/** What a node outlines as, in comp space: closed rings to cut into convex pieces, open lines (hull only), or a circle. */
interface Outline {
  rings: Point[][]
  open: Point[][]
  circle?: { x: number; y: number; radius: number }
}

const through = (m: Mat4, points: readonly (readonly [number, number])[]): Point[] =>
  points.map(([x, y]) => {
    const p = transformPoint(m, x, y, 0)
    return [p[0], p[1]]
  })

const cornersOf = (w: number, h: number): Point[] => [
  [-w / 2, -h / 2],
  [w / 2, -h / 2],
  [w / 2, h / 2],
  [-w / 2, h / 2],
]

/** The node's own box through its matrix: four corners, oriented. A group's box is its layout's, or its members'. */
function boxPoints(node: SceneNode): Point[] {
  if (node.kind === 'leaf') return through(node.matrix, cornersOf(node.content.box.width, node.content.box.height))
  const { left, top, width, height } = node.box
  return through(node.matrix, [
    [left, top],
    [left + width, top],
    [left + width, top + height],
    [left, top + height],
  ])
}

const distance = (a: Point, b: Point) => Math.hypot(b[0] - a[0], b[1] - a[1])

/** A polygon collider (its convex hull, so it is convex and wound one way), or none when it is too small or has fewer than three distinct points. */
function polygonCollider(points: Point[]): Collider[] {
  const hull = convexHull(points)
  if (hull.length < 3 || polygonArea(hull) < MIN_AREA) return []
  return [{ kind: 'polygon', points: hull }]
}

/** A convex ring cut down to `limit` points by dropping the vertex that changes its area least; it stays convex. */
function reduceConvex(hull: Point[], limit: number): Point[] {
  const ring = [...hull]
  while (ring.length > limit) {
    let best = 0
    let least = Number.POSITIVE_INFINITY
    for (let i = 0; i < ring.length; i++) {
      const a = ring[(i + ring.length - 1) % ring.length] as Point
      const b = ring[i] as Point
      const c = ring[(i + 1) % ring.length] as Point
      const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]))
      if (area < least) {
        least = area
        best = i
      }
    }
    ring.splice(best, 1)
  }
  return ring
}

/** A ring simplified enough to cut quickly, without visibly changing it. */
function lighten(ring: Point[]): Point[] {
  if (ring.length <= 16) return ring
  const xs = ring.map((p) => p[0])
  const ys = ring.map((p) => p[1])
  const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
  return simplifyClosed(ring, Math.max(0.25, size * 0.004), 64)
}

/** The ink of each line of a text layer, as a box in the layer's space: cap top (tallest glyph) to descender, left to right ink. */
function textInk(node: LeafNode, measure: Ctx2D): [number, number, number, number][] {
  const layer = node.layer as Extract<Layer, { kind: 'text' }>
  const resolved = node.resolved
  const style = resolved.style ?? layer.style
  const spec = { ...(resolved.textBox ?? { maxWidth: layer.maxWidth, maxHeight: layer.maxHeight }), verticalAlign: layer.verticalAlign }
  const layout = layoutText(measure, layer.text, style, spec, resolved.ranges ?? layer.ranges)
  const fontOf = (s: typeof style) => `${s.italic ? 'italic ' : ''}${s.fontWeight} ${s.fontSize}px "${s.fontFamily.replace(/["\\]/g, '')}", system-ui, sans-serif`
  const setFont = (s: typeof style) => {
    measure.font = fontOf(s)
    measure.letterSpacing = `${s.letterSpacing}px`
    measure.textAlign = 'left'
    measure.textBaseline = 'alphabetic'
  }
  // Where a line's baseline sits, as the layer draws it (see textContent in content.ts).
  setFont(style)
  const probe = measure.measureText('Hg')
  const ascentRatio = (probe.fontBoundingBoxAscent || style.fontSize * 0.8) / style.fontSize
  const descentRatio = (probe.fontBoundingBoxDescent || style.fontSize * 0.2) / style.fontSize
  const number = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
  const boxes: [number, number, number, number][] = []
  for (const line of layout.lines) {
    const baseline = line.top + (line.height - line.size * (ascentRatio + descentRatio)) / 2 + line.size * ascentRatio
    let left = Number.POSITIVE_INFINITY
    let right = Number.NEGATIVE_INFINITY
    let top = Number.POSITIVE_INFINITY
    let bottom = Number.NEGATIVE_INFINITY
    for (const f of line.fragments) {
      if (f.text.trim() === '') continue
      setFont(f.style)
      const m = measure.measureText(f.text)
      const size = f.style.fontSize
      left = Math.min(left, f.x - number(m.actualBoundingBoxLeft, 0))
      right = Math.max(right, f.x + number(m.actualBoundingBoxRight, f.width))
      top = Math.min(top, baseline - number(m.actualBoundingBoxAscent, size * 0.72))
      bottom = Math.max(bottom, baseline + number(m.actualBoundingBoxDescent, size * 0.2))
    }
    if (right - left >= 0.5 && bottom - top >= 0.5) boxes.push([left, top, right, bottom])
  }
  return boxes
}

/** An ellipse as points in the layer's space. */
function ellipsePoints(width: number, height: number): Point[] {
  return Array.from({ length: ELLIPSE_POINTS }, (_, i): Point => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / ELLIPSE_POINTS
    return [(Math.cos(a) * width) / 2, (Math.sin(a) * height) / 2]
  })
}

/** What a leaf or nested node outlines as. */
function outlineOf(node: LeafNode | NestedNode, measure: Ctx2D, silhouetteOf: SilhouetteOf): Outline {
  const box = boxPoints(node)
  const boxOutline: Outline = { rings: [box], open: [] }
  if (node.kind === 'nested') return boxOutline
  const { layer, resolved } = node
  switch (layer.kind) {
    case 'shape': {
      const shape = resolved.shape ?? layer.shape
      if (shape.type === 'ellipse') {
        const w = distance(box[0] as Point, box[1] as Point)
        const h = distance(box[0] as Point, box[3] as Point)
        if (Math.abs(w - h) <= 0.02 * Math.max(w, h)) {
          const [x, y] = transformPoint(node.matrix, 0, 0, 0)
          return { rings: [], open: [], circle: { x, y, radius: (w + h) / 4 } }
        }
        return { rings: [through(node.matrix, ellipsePoints(shape.width, shape.height))], open: [] }
      }
      if (shape.type === 'polygon' || shape.type === 'star') return { rings: [through(node.matrix, polygonPoints(shape))], open: [] }
      return boxOutline
    }
    case 'path': {
      const base = svgPathBounds(parseSvgPath(layer.geometry))
      const cx = base.left + base.width / 2
      const cy = base.top + base.height / 2
      const rings: Point[][] = []
      const open: Point[][] = []
      for (const piece of flattenSvgPath(parseSvgPath(resolved.geometry ?? layer.geometry), 16)) {
        let points = piece.points
        const first = points[0] as [number, number]
        const last = points[points.length - 1] as [number, number]
        const closed = piece.closed || (points.length > 2 && first[0] === last[0] && first[1] === last[1])
        if (closed && points.length > 1 && first[0] === last[0] && first[1] === last[1]) points = points.slice(0, -1)
        const mapped = through(
          node.matrix,
          points.map(([x, y]): [number, number] => [x - cx, y - cy]),
        )
        if (mapped.length < 2) continue
        if (closed) rings.push(lighten(mapped))
        else open.push(mapped)
      }
      return { rings, open }
    }
    case 'image': {
      const polygons = silhouetteOf(layer)
      if (!polygons || polygons.length === 0) return boxOutline
      const { width, height } = node.content.box
      return { rings: polygons.map((poly) => through(node.matrix, poly.map(([u, v]): [number, number] => [(u - 0.5) * width, (v - 0.5) * height]))), open: [] }
    }
    case 'text': {
      const ink = textInk(node, measure)
      if (ink.length === 0) return boxOutline
      return { rings: ink.map(([l, t, r, b]) => through(node.matrix, [[l, t], [r, t], [r, b], [l, b]])), open: [] }
    }
    default:
      return boxOutline
  }
}

type SilhouetteOf = (layer: Layer) => readonly (readonly [number, number])[][] | undefined

/** The members that count, in a group (stencils only cut, so they are skipped). */
const membersOf = (node: GroupNode): SceneNode[] => node.children.filter((c) => !c.stencil)

/** Every outline point under a node: for hulls. */
function allPoints(node: SceneNode, measure: Ctx2D, silhouetteOf: SilhouetteOf): Point[] {
  if (node.kind === 'group') return membersOf(node).flatMap((c) => allPoints(c, measure, silhouetteOf))
  const outline = outlineOf(node, measure, silhouetteOf)
  const round: Point[] = outline.circle
    ? Array.from({ length: ELLIPSE_POINTS }, (_, i): Point => {
        const a = (i * 2 * Math.PI) / ELLIPSE_POINTS
        const c = outline.circle as { x: number; y: number; radius: number }
        return [c.x + Math.cos(a) * c.radius, c.y + Math.sin(a) * c.radius]
      })
    : []
  return [...outline.rings.flat(), ...outline.open.flat(), ...round]
}

/** The convex pieces of a node's own looks. */
function autoColliders(node: SceneNode, measure: Ctx2D, silhouetteOf: SilhouetteOf): Collider[] {
  if (node.kind === 'group') return membersOf(node).flatMap((c) => autoColliders(c, measure, silhouetteOf))
  const outline = outlineOf(node, measure, silhouetteOf)
  const out: Collider[] = []
  if (outline.circle && outline.circle.radius > 0.25) out.push({ kind: 'circle', ...outline.circle })
  for (const ring of outline.rings) {
    for (const piece of convexPieces(ring, MAX_POLYGON_POINTS)) out.push(...polygonCollider(piece))
  }
  for (const line of outline.open) {
    const hull = convexHull(line)
    if (hull.length >= 3) for (const piece of convexPieces(hull, MAX_POLYGON_POINTS)) out.push(...polygonCollider(piece))
  }
  return out
}

/**
 * The colliders of a scene node, in comp space, at this moment. `auto`
 * follows the looks: a rectangle is a box, a round ellipse a circle, other
 * shapes and paths their outline cut into convex pieces, a picture its
 * silhouette (when `silhouetteOf` knows it, else its box), text one box of ink
 * per line, a group its members' colliders (cutters skipped). `box` is the
 * node's box, `sphere` a circle around it, `hull` one convex shape around
 * everything (at most 12 points), `outline` the exact pieces.
 */
export function bodyColliders(node: SceneNode, shape: BodyShape, measure: Ctx2D, silhouetteOf: SilhouetteOf): Collider[] {
  switch (shape) {
    case 'box':
      return polygonCollider(boxPoints(node))
    case 'sphere': {
      const box = boxPoints(node)
      const [a, b, c] = [box[0], box[1], box[2]] as [Point, Point, Point]
      const radius = Math.max(distance(a, b), distance(b, c)) / 2
      if (!(radius > 0.25)) return []
      return [{ kind: 'circle', x: (a[0] + c[0]) / 2, y: (a[1] + c[1]) / 2, radius }]
    }
    case 'hull': {
      const hull = reduceConvex(convexHull(allPoints(node, measure, silhouetteOf)), MAX_POLYGON_POINTS)
      return polygonCollider(hull)
    }
    default:
      return autoColliders(node, measure, silhouetteOf)
  }
}
