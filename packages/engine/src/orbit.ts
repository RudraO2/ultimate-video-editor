import { CameraSchema, type CameraSpec, mat4Compose, mat4Translate, type Vec3, type WorldCamera, type WorldMat4 } from '@uve/core'

// The orbit view of a world: a free camera the editor looks through, kept as
// editor state (never in the document), so it never changes what renders or
// exports. Pure maths, no three.js: the desktop drives it and the world
// renderer (world/orbitView.ts) draws through it. Constants follow AtomCut's
// orbit viewport (see "The orbit viewport" in the research notes).

/** How the orbit view shades the world. */
export type OrbitShading = 'solid' | 'material' | 'rendered'

/** Where the orbit view looks from: a target, a distance (px) and two turns (degrees). Z is up. */
export interface OrbitView {
  /** The point turned around, world px. */
  target: Vec3
  /** From the target to the eye, px (1 to 1e7). */
  distance: number
  /** Turn about +Z; 0 looks along +Y (the front view), 90 from +X. */
  yaw: number
  /** Height of the eye: 0 level, 90 straight down from above (−90 to 90). */
  pitch: number
}

/** The orbit camera's vertical field of view, degrees. */
export const ORBIT_FOV_Y = 30
export const ORBIT_MIN_DISTANCE = 1
export const ORBIT_MAX_DISTANCE = 1e7
/** Degrees turned per px dragged. */
export const ORBIT_DEG_PER_PX = 0.35
/** Distance factor per mouse-wheel notch. */
export const ORBIT_WHEEL_STEP = 1.15

/** The view a world opens with before anything is framed. */
export const DEFAULT_ORBIT_VIEW: OrbitView = { target: [0, 0, 0], distance: 1500, yaw: 35, pitch: 25 }

const RAD = Math.PI / 180
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** The camera's axes in the world: right (x), up (y) and back (z, from the target toward the eye). */
export function orbitAxes(view: Pick<OrbitView, 'yaw' | 'pitch'>): { right: Vec3; up: Vec3; back: Vec3 } {
  const sy = Math.sin(view.yaw * RAD)
  const cy = Math.cos(view.yaw * RAD)
  const sp = Math.sin(view.pitch * RAD)
  const cp = Math.cos(view.pitch * RAD)
  return { right: [cy, sy, 0], up: [-sp * sy, sp * cy, cp], back: [sy * cp, -cy * cp, sp] }
}

/** The eye's position, world px. */
export function orbitEye(view: OrbitView): Vec3 {
  const { back } = orbitAxes(view)
  const [x, y, z] = view.target
  return [x + back[0] * view.distance, y + back[1] * view.distance, z + back[2] * view.distance]
}

/** The orbit camera's matrix (camera space to world: it looks down its local −Z, +Y up), column-major. */
export function orbitMatrix(view: OrbitView): WorldMat4 {
  const { right, up, back } = orbitAxes(view)
  const rotation = [right[0], right[1], right[2], 0, up[0], up[1], up[2], 0, back[0], back[1], back[2], 0, 0, 0, 0, 1]
  const [x, y, z] = orbitEye(view)
  return mat4Compose(mat4Translate(x, y, z), rotation)
}

/**
 * The orbit camera as a world camera for a view of `width` × `height` px:
 * a perspective lens whose vertical field of view is `ORBIT_FOV_Y` (the
 * focal length is chosen for the sensor-fit rule), near and far clips that
 * follow the distance. `projectWorldPoint` works with it.
 */
export function orbitCamera(view: OrbitView, width: number, height: number): WorldCamera & { spec: CameraSpec } {
  const base = CameraSchema.parse({})
  const long = Math.max(width, height)
  const focalLength = ((base.sensorWidth / 2) * (height / long)) / Math.tan((ORBIT_FOV_Y / 2) * RAD)
  return {
    matrix: orbitMatrix(view),
    spec: {
      ...base,
      projection: 'perspective',
      focalLength,
      clipStart: Math.max(0.1, view.distance * 0.002),
      clipEnd: Math.max(200_000, view.distance * 200),
    },
  }
}

/** Turns the view by a drag of (dx, dy) px: right turns the world left (yaw −0.35°/px), down raises the eye. */
export function orbitBy(view: OrbitView, dx: number, dy: number, degPerPx = ORBIT_DEG_PER_PX): OrbitView {
  return { ...view, yaw: normalizeYaw(view.yaw - dx * degPerPx), pitch: clamp(view.pitch + dy * degPerPx, -90, 90) }
}

/** Keeps a yaw in (−180, 180]. */
export function normalizeYaw(yaw: number): number {
  const turned = ((((yaw + 180) % 360) + 360) % 360) - 180
  return turned === -180 ? 180 : turned
}

/** Moves the target so the world follows a drag of (dx, dy) px on a view `viewHeight` px tall. */
export function panBy(view: OrbitView, dx: number, dy: number, viewHeight: number): OrbitView {
  const k = (2 * view.distance * Math.tan((ORBIT_FOV_Y / 2) * RAD)) / Math.max(1, viewHeight)
  const { right, up } = orbitAxes(view)
  const [x, y, z] = view.target
  return {
    ...view,
    target: [x - right[0] * dx * k + up[0] * dy * k, y - right[1] * dx * k + up[1] * dy * k, z - right[2] * dx * k + up[2] * dy * k],
  }
}

/** Multiplies the distance (below 1 comes closer), kept within 1…1e7 px. */
export function zoomBy(view: OrbitView, factor: number): OrbitView {
  return { ...view, distance: clamp(view.distance * factor, ORBIT_MIN_DISTANCE, ORBIT_MAX_DISTANCE) }
}

/** World bounds, px. */
export interface Bounds3 {
  min: Vec3
  max: Vec3
}

/**
 * Frames bounds in a view of the given aspect (width / height), keeping the
 * turns: the target is the bounds' centre and the distance fits a sphere of
 * half the diagonal (at least 10 px) in the narrower field, with 8 % margin.
 */
export function frameBounds(view: OrbitView, bounds: Bounds3, aspect: number): OrbitView {
  const { min, max } = bounds
  const target: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
  const radius = Math.max(10, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2)
  const halfY = (ORBIT_FOV_Y / 2) * RAD
  const halfX = Math.atan(Math.tan(halfY) * aspect)
  const distance = clamp((radius / Math.sin(Math.min(halfY, halfX))) * 1.08, ORBIT_MIN_DISTANCE, ORBIT_MAX_DISTANCE)
  return { ...view, target, distance }
}

/** The six axis views (yaw, pitch): front looks along +Y, right along −X, top straight down. */
export const ORBIT_AXIS_VIEWS = {
  front: { yaw: 0, pitch: 0 },
  back: { yaw: 180, pitch: 0 },
  right: { yaw: 90, pitch: 0 },
  left: { yaw: -90, pitch: 0 },
  top: { yaw: 0, pitch: 90 },
  bottom: { yaw: 0, pitch: -90 },
} as const satisfies Record<string, Pick<OrbitView, 'yaw' | 'pitch'>>

/** What the orbit view is drawn with (`CompRenderer.renderOrbit`). Editor state only: nothing here is in the document. */
export interface OrbitRenderOptions {
  view: OrbitView
  shading: OrbitShading
  grid: { show: boolean; size: number; divisions: number }
  /** The background in Solid shading (the theme's void colour, e.g. '#060406'). */
  voidColor: string
  /** Selected layer ids; the first is the primary selection (#ffaa40), the rest #f15800. */
  selectedIds: readonly string[]
  /** Whether to draw the 3D motion paths of the selected layers. */
  motionPaths: boolean
  /** Gizmo and path colour, default '#8a8a94'. */
  wireColor?: string
  /** While playing: fewer post samples are fine. */
  playing?: boolean
}
