import { type CameraSpec, type Comp, type Layer, type LightSpec, mat4TransformPoint, type Vec3, type WorldMat4 } from '@uve/core'

// The shapes the orbit view draws for the objects that have no surface:
// cameras, lights and controllers, plus the ground grid's constants and the
// selection colours. Pure geometry in each object's local space (units px;
// a camera or light shines down its local −Z, +Y up), with no three.js so it
// can be tested; helpers.ts turns the segments into lines. Sizes follow
// AtomCut's orbit viewport: they are in world px and do not scale with the
// distance of the view.

/** A line from one point to another. */
export type Segment = readonly [Vec3, Vec3]

/** Gizmos and motion paths are drawn in this colour unless the caller gives one. */
export const WIRE_COLOR = '#8a8a94'
/** The primary selection's outline and the key points of a path. */
export const SELECT_PRIMARY = '#ffaa40'
/** The outline of the other selected layers. */
export const SELECT_OTHER = '#f15800'

/** How far out a camera's frustum rectangle is drawn, px. */
export const CAMERA_GIZMO_DEPTH = 100
/** A point or sun light's circle, px. */
export const LIGHT_RADIUS = 18
/** A sun's line along its direction, px. */
export const SUN_LINE = 400
/** A spot's cone is drawn out to this distance, px. */
export const SPOT_DEPTH = 150
/** An area light's normal line, px. */
export const AREA_NORMAL = 120
/** An environment light's circles, px. */
export const ENVIRONMENT_RADIUS = 28.8
/** Any other light's circle, px. */
export const OTHER_LIGHT_RADIUS = 27

/** A gizmo is picked within this many screen px of its origin... */
export const GIZMO_PICK_ORIGIN_PX = 16
/** ...or of one of its lines. */
export const GIZMO_PICK_LINE_PX = 10

const CIRCLE_STEPS = 48
const RAD = Math.PI / 180

type Plane = 'xy' | 'xz' | 'yz'

const onPlane = (plane: Plane, a: number, b: number, depth = 0): Vec3 => (plane === 'xy' ? [a, b, depth] : plane === 'xz' ? [a, depth, b] : [depth, a, b])

/** The segments that close a ring of points. */
export function loop(points: readonly Vec3[]): Segment[] {
  return points.map((p, i) => [p, points[(i + 1) % points.length] as Vec3] as const)
}

/** A circle's segments, centred on `depth` along the plane's normal. */
export function circle(radius: number, plane: Plane, depth = 0, steps = CIRCLE_STEPS): Segment[] {
  const points: Vec3[] = []
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2
    points.push(onPlane(plane, Math.cos(a) * radius, Math.sin(a) * radius, depth))
  }
  return loop(points)
}

/** The twelve edges of a box. */
export function boxEdges(min: Vec3, max: Vec3): Segment[] {
  const at = (i: number): Vec3 => [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]]
  const out: Segment[] = []
  for (let i = 0; i < 8; i++) {
    for (const bit of [1, 2, 4]) if (!(i & bit)) out.push([at(i), at(i | bit)])
  }
  return out
}

/** A camera's gizmo for a comp of the given size: the frustum from the eye to a rectangle 100 px out, and a small triangle above it that says which way is up. */
export function cameraGizmo(camera: Pick<CameraSpec, 'projection' | 'focalLength' | 'sensorWidth' | 'orthoScale'>, comp: { width: number; height: number }): Segment[] {
  const long = Math.max(comp.width, comp.height)
  const depth = CAMERA_GIZMO_DEPTH
  let hw: number
  let hh: number
  if (camera.projection === 'orthographic') {
    hw = ((comp.width / long) * camera.orthoScale) / 2
    hh = ((comp.height / long) * camera.orthoScale) / 2
  } else {
    // The sensor spans the longer side (core's `cameraFov`): half its tangent is sensor / 2 / focal.
    const half = camera.sensorWidth / 2 / camera.focalLength
    hw = depth * half * (comp.width / long)
    hh = depth * half * (comp.height / long)
  }
  const corner = (sx: number, sy: number, z: number): Vec3 => [sx * hw, sy * hh, z]
  const far: Vec3[] = [corner(-1, 1, -depth), corner(1, 1, -depth), corner(1, -1, -depth), corner(-1, -1, -depth)]
  const out: Segment[] = loop(far)
  if (camera.projection === 'orthographic') {
    const near: Vec3[] = [corner(-1, 1, 0), corner(1, 1, 0), corner(1, -1, 0), corner(-1, -1, 0)]
    out.push(...loop(near), ...near.map((p, i) => [p, far[i] as Vec3] as const))
  } else {
    out.push(...far.map((p) => [[0, 0, 0] as Vec3, p] as const))
  }
  // The "up" triangle: a base over the middle of the top edge and an apex above it.
  out.push(...loop([corner(-0.3, 1.08, -depth), corner(0.3, 1.08, -depth), corner(0, 1.55, -depth)]))
  return out
}

/** A light's gizmo, by kind (see the constants above). */
export function lightGizmo(light: Pick<LightSpec, 'type' | 'spotAngle' | 'width' | 'height'>): Segment[] {
  switch (light.type) {
    case 'point':
      return [...circle(LIGHT_RADIUS, 'xy'), ...circle(LIGHT_RADIUS, 'xz'), ...circle(LIGHT_RADIUS, 'yz')]
    case 'sun': {
      const rays: Segment[] = []
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2
        rays.push([onPlane('xy', Math.cos(a) * LIGHT_RADIUS, Math.sin(a) * LIGHT_RADIUS), onPlane('xy', Math.cos(a) * (LIGHT_RADIUS + 10), Math.sin(a) * (LIGHT_RADIUS + 10))])
      }
      return [...circle(LIGHT_RADIUS, 'xy'), ...rays, [[0, 0, 0], [0, 0, -SUN_LINE]]]
    }
    case 'spot': {
      // A cone of 180° or more has no end: the drawing stops short of it.
      const radius = SPOT_DEPTH * Math.tan((Math.min(light.spotAngle, 170) / 2) * RAD)
      const lines: Segment[] = [0, 1, 2, 3].map((i) => [[0, 0, 0], onPlane('xy', Math.cos((i * Math.PI) / 2) * radius, Math.sin((i * Math.PI) / 2) * radius, -SPOT_DEPTH)] as const)
      return [...circle(radius, 'xy', -SPOT_DEPTH), ...lines]
    }
    case 'area': {
      const w = light.width / 2
      const h = light.height / 2
      return [...loop([[-w, -h, 0], [w, -h, 0], [w, h, 0], [-w, h, 0]]), [[0, 0, 0], [0, 0, -AREA_NORMAL]]]
    }
    case 'environment':
      return [...circle(ENVIRONMENT_RADIUS, 'xy'), ...circle(ENVIRONMENT_RADIUS, 'xz'), ...circle(ENVIRONMENT_RADIUS, 'yz')]
    default: {
      const spokes: Segment[] = []
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2
        spokes.push([onPlane('xy', Math.cos(a) * OTHER_LIGHT_RADIUS, Math.sin(a) * OTHER_LIGHT_RADIUS), onPlane('xy', Math.cos(a) * (OTHER_LIGHT_RADIUS + 12), Math.sin(a) * (OTHER_LIGHT_RADIUS + 12))])
      }
      return [...circle(OTHER_LIGHT_RADIUS, 'xy'), ...spokes]
    }
  }
}

/** A controller's marker in the editor: its axes, a cube, a sphere or arrows (the axes with a head). */
export function emptyGizmo(empty: { display: 'axes' | 'cube' | 'sphere' | 'arrows'; size: number }): Segment[] {
  const s = empty.size
  const axes: Segment[] = [
    [[0, 0, 0], [s, 0, 0]],
    [[0, 0, 0], [0, s, 0]],
    [[0, 0, 0], [0, 0, s]],
  ]
  switch (empty.display) {
    case 'cube':
      return boxEdges([-s / 2, -s / 2, -s / 2], [s / 2, s / 2, s / 2])
    case 'sphere':
      return [...circle(s / 2, 'xy'), ...circle(s / 2, 'xz'), ...circle(s / 2, 'yz')]
    case 'arrows': {
      const head = s * 0.15
      return [
        ...axes,
        [[s, 0, 0], [s - head, head / 2, 0]],
        [[s, 0, 0], [s - head, -head / 2, 0]],
        [[0, s, 0], [head / 2, s - head, 0]],
        [[0, s, 0], [-head / 2, s - head, 0]],
        [[0, 0, s], [0, head / 2, s - head]],
        [[0, 0, s], [0, -head / 2, s - head]],
      ]
    }
    default:
      return axes
  }
}

/** A matrix with its scale taken out: gizmos keep their size however an object is scaled. */
export function rigid(m: WorldMat4): WorldMat4 {
  const out = [...m]
  for (let c = 0; c < 3; c++) {
    const len = Math.hypot(m[c * 4] as number, m[c * 4 + 1] as number, m[c * 4 + 2] as number) || 1
    for (let r = 0; r < 3; r++) out[c * 4 + r] = (m[c * 4 + r] as number) / len
  }
  return out
}

/** Segments moved by a matrix. */
export function transformSegments(m: WorldMat4, segments: readonly Segment[]): Segment[] {
  const move = (p: Vec3): Vec3 => {
    const [x, y, z] = mat4TransformPoint(m, p[0], p[1], p[2])
    return [x, y, z]
  }
  return segments.map(([a, b]) => [move(a), move(b)] as const)
}

/** The distance from a 2D point to a 2D segment. */
export function pointSegmentDistance(p: readonly [number, number], a: readonly [number, number], b: readonly [number, number]): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const length2 = dx * dx + dy * dy
  const t = length2 === 0 ? 0 : Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2))
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

// ---------------------------------------------------------------------------
// The ground grid
// ---------------------------------------------------------------------------

/** The grid's lines, measured on AtomCut's viewport: white at 16 % for the major lines, the minor ones 0.55 of that, the axes at 75 %. */
export const GRID_MAJOR_ALPHA = 0.16
export const GRID_MINOR_FACTOR = 0.55
export const GRID_AXIS_ALPHA = 0.75
/** The X axis line, and the Y axis line (sRGB). */
export const GRID_X_COLOR = '#ff3352'
export const GRID_Y_COLOR = '#8bdc00'

/** Where the grid ends, px from its centre: it fades out from 35 % of this to 100 %. */
export function gridReach(distance: number): { start: number; end: number } {
  const end = Math.max(2000, 12 * distance)
  return { start: end * 0.35, end }
}

/** The spacing of the minor and major lines, px: a major line every `size`, a minor one every size / divisions. */
export function gridSpacing(grid: { size: number; divisions: number }): { minor: number; major: number } {
  const major = Math.max(1, grid.size)
  return { minor: major / Math.max(1, Math.round(grid.divisions)), major }
}

/** The gizmo of a camera, light or controller layer in a comp (local space), or null for any other kind. */
export function gizmoOf(layer: Layer, comp: Pick<Comp, 'width' | 'height'>): Segment[] | null {
  switch (layer.kind) {
    case 'camera':
      return cameraGizmo(layer.camera, comp)
    case 'light':
      return lightGizmo(layer.light)
    case 'empty':
      return emptyGizmo(layer.empty)
    default:
      return null
  }
}
