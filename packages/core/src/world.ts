import { groupOnLane } from './groups'
import { evaluateProperty, propertiesOf } from './properties'
import {
  type CameraLayer,
  type CameraSpec,
  CameraSchema,
  type Comp,
  type Constraint,
  type Layer,
  type LayerKind,
  SPATIAL_KINDS,
  type Track,
  type Transform,
  type World,
} from './schema'

// The maths of a 3D world (a comp with `world`). Space: Z up, X right, Y away
// from the front view, 1 unit = 1 px, right-handed. A world's picture planes
// (every 2D kind) stand in the XZ plane facing -Y, so the front camera at
// (0, -D, 0) sees them exactly as a flat comp shows them. Everything here is
// pure: no rendering, no commands, no engine.

/** A point or direction in world space. */
export type Vec3 = [x: number, y: number, z: number]

/**
 * A 4×4 matrix in column-major order, laid out exactly like the engine's
 * `Mat4` (m[column * 4 + row]), so the engine can mix them.
 */
export type WorldMat4 = number[]

const RAD = Math.PI / 180
const DEG = 180 / Math.PI

/** -0 reads as a different number to `toEqual`; adding 0 turns it into 0. */
const clean = (v: number): number => v + 0

// ---------------------------------------------------------------------------
// Matrix helpers (own copies, same memory layout as the engine's math.ts)
// ---------------------------------------------------------------------------

/** Builds a matrix from values written row by row. */
function fromRows(...rows: number[]): WorldMat4 {
  const m = new Array<number>(16)
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) m[c * 4 + r] = rows[r * 4 + c] ?? 0
  return m
}

/** The identity matrix. */
export const mat4Identity = (): WorldMat4 => fromRows(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)

/** a·b: b is applied first. */
export function mat4Multiply(a: WorldMat4, b: WorldMat4): WorldMat4 {
  const out = new Array<number>(16).fill(0)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0
      for (let k = 0; k < 4; k++) sum += (a[k * 4 + r] as number) * (b[c * 4 + k] as number)
      out[c * 4 + r] = sum
    }
  }
  return out
}

/** Multiplies several matrices left to right: mat4Compose(A, B, C) = A·B·C. */
export function mat4Compose(...matrices: WorldMat4[]): WorldMat4 {
  return matrices.reduce((acc, m) => mat4Multiply(acc, m))
}

export const mat4Translate = (x: number, y: number, z: number): WorldMat4 => fromRows(1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1)

export const mat4Scale = (x: number, y: number, z: number): WorldMat4 => fromRows(x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1)

/** The standard right-handed rotation about +X, in radians. */
export function mat4RotateX(radians: number): WorldMat4 {
  const c = Math.cos(radians)
  const s = Math.sin(radians)
  return fromRows(1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1)
}

/** The standard right-handed rotation about +Y, in radians. */
export function mat4RotateY(radians: number): WorldMat4 {
  const c = Math.cos(radians)
  const s = Math.sin(radians)
  return fromRows(c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1)
}

/** The standard right-handed rotation about +Z, in radians. */
export function mat4RotateZ(radians: number): WorldMat4 {
  const c = Math.cos(radians)
  const s = Math.sin(radians)
  return fromRows(c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)
}

/** Applies a matrix to a point, returning homogeneous coordinates [x, y, z, w]. */
export function mat4TransformPoint(m: WorldMat4, x: number, y: number, z: number): [number, number, number, number] {
  const at = (i: number) => m[i] as number
  return [
    at(0) * x + at(4) * y + at(8) * z + at(12),
    at(1) * x + at(5) * y + at(9) * z + at(13),
    at(2) * x + at(6) * y + at(10) * z + at(14),
    at(3) * x + at(7) * y + at(11) * z + at(15),
  ]
}

/** The inverse of a matrix, or null when it has none. */
export function mat4Invert(m: WorldMat4): WorldMat4 | null {
  const a = (i: number) => m[i] as number
  const [a00, a01, a02, a03] = [a(0), a(1), a(2), a(3)]
  const [a10, a11, a12, a13] = [a(4), a(5), a(6), a(7)]
  const [a20, a21, a22, a23] = [a(8), a(9), a(10), a(11)]
  const [a30, a31, a32, a33] = [a(12), a(13), a(14), a(15)]
  const b00 = a00 * a11 - a01 * a10
  const b01 = a00 * a12 - a02 * a10
  const b02 = a00 * a13 - a03 * a10
  const b03 = a01 * a12 - a02 * a11
  const b04 = a01 * a13 - a03 * a11
  const b05 = a02 * a13 - a03 * a12
  const b06 = a20 * a31 - a21 * a30
  const b07 = a20 * a32 - a22 * a30
  const b08 = a20 * a33 - a23 * a30
  const b09 = a21 * a32 - a22 * a31
  const b10 = a21 * a33 - a23 * a31
  const b11 = a22 * a33 - a23 * a32
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06
  if (!Number.isFinite(det) || Math.abs(det) < 1e-300) return null
  const k = 1 / det
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * k,
    (a02 * b10 - a01 * b11 - a03 * b09) * k,
    (a31 * b05 - a32 * b04 + a33 * b03) * k,
    (a22 * b04 - a21 * b05 - a23 * b03) * k,
    (a12 * b08 - a10 * b11 - a13 * b07) * k,
    (a00 * b11 - a02 * b08 + a03 * b07) * k,
    (a32 * b02 - a30 * b05 - a33 * b01) * k,
    (a20 * b05 - a22 * b02 + a23 * b01) * k,
    (a10 * b10 - a11 * b08 + a13 * b06) * k,
    (a01 * b08 - a00 * b10 - a03 * b06) * k,
    (a30 * b04 - a31 * b02 + a33 * b00) * k,
    (a21 * b02 - a20 * b04 - a23 * b00) * k,
    (a11 * b07 - a10 * b09 - a12 * b06) * k,
    (a00 * b09 - a01 * b07 + a02 * b06) * k,
    (a31 * b01 - a30 * b03 - a32 * b00) * k,
    (a20 * b03 - a21 * b01 + a22 * b00) * k,
  ]
}

// ---------------------------------------------------------------------------
// Worlds and axes
// ---------------------------------------------------------------------------

/** Whether a comp is a 3D world: it has `world`. */
export function isWorld(comp: Comp): comp is Comp & { world: World } {
  return comp.world !== undefined
}

/**
 * The change of axes from a picture's own space (flat comp: +x right, +y
 * down, +z away) to world space: P(x, y, z) = (x, z, -y). A picture's local
 * point (u, v) lands at world (u, 0, -v), facing -Y.
 */
export const PICTURE_AXES: WorldMat4 = fromRows(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1)

const isSpatial = (kind: LayerKind): boolean => (SPATIAL_KINDS as readonly string[]).includes(kind)

/**
 * The matrix of a layer's local space in the world, from its own transform
 * only (parent groups are applied by `worldObjects`). Angles are degrees and
 * the order is T·Rz·Ry·Rx·S, with the standard right-handed rotations. In
 * world space a positive rotationX turns the +Y axis toward +Z, so it tilts a
 * picture's top toward the viewer; the flat comp's rotationX leans it away.
 *
 * - Camera, light, empty and mesh: S(scaleX, scaleY, scaleZ) about the position.
 * - Any 2D kind (a picture plane): the box is first turned into the XZ plane
 *   by `PICTURE_AXES` about the pivot, and the scales read as (scaleX,
 *   scaleZ, scaleY): scaleY is the picture's height, which is world Z.
 *   `box` (null: 0 × 0) places the pivot, a fraction of the box.
 */
export function worldMatrix(layer: { kind: LayerKind; transform: Transform }, box: { width: number; height: number } | null): WorldMat4 {
  const core = worldCore(layer)
  if (isSpatial(layer.kind)) return core
  return mat4Compose(core, PICTURE_AXES, pictureTail(layer.transform, box))
}

/**
 * A layer's matrix up to its pivot: T·Rz·Ry·Rx·S about its position. For a
 * picture this leaves out the change of axes and the pivot offset (see
 * `worldMatrix`), so it does not depend on the picture's size: its
 * translation is the pivot's world position. Constraints work on it.
 */
export function worldCore(layer: { kind: LayerKind; transform: Transform }): WorldMat4 {
  const t = layer.transform
  const turn = [mat4RotateZ(t.rotation * RAD), mat4RotateY(t.rotationY * RAD), mat4RotateX(t.rotationX * RAD)] as const
  if (isSpatial(layer.kind)) return mat4Compose(mat4Translate(t.x, t.y, t.z), ...turn, mat4Scale(t.scaleX, t.scaleY, t.scaleZ))
  return mat4Compose(mat4Translate(t.x, t.y, t.z), ...turn, mat4Scale(t.scaleX, t.scaleZ, t.scaleY))
}

/** The pivot offset a picture's matrix ends with. */
const pictureTail = (t: Transform, box: { width: number; height: number } | null): WorldMat4 =>
  mat4Translate(-(t.anchorX - 0.5) * (box?.width ?? 0), -(t.anchorY - 0.5) * (box?.height ?? 0), 0)

/**
 * A group's own matrix in a world: T(x, y, z)·Rz·Ry·Rx·S(scaleX, scaleZ,
 * scaleY) about the world origin. There is no pivot and no change of axes: a
 * group has no picture of its own, so its members are placed in world space
 * and the group only moves, turns and scales them.
 */
export function groupWorldMatrix(t: Transform): WorldMat4 {
  return mat4Compose(
    mat4Translate(t.x, t.y, t.z),
    mat4RotateZ(t.rotation * RAD),
    mat4RotateY(t.rotationY * RAD),
    mat4RotateX(t.rotationX * RAD),
    mat4Scale(t.scaleX, t.scaleZ, t.scaleY),
  )
}

/** Position, turns (degrees, T·Rz·Ry·Rx·S order) and scale of a matrix. */
export interface XYZPose {
  position: Vec3
  rotation: { rotationX: number; rotationY: number; rotation: number }
  scale: Vec3
}

/**
 * Splits a matrix made as T·Rz·Ry·Rx·S back into its parts (the inverse of
 * the composition in `worldMatrix`; scales are assumed positive). At gimbal
 * lock (rotationY = ±90°) the turn about Z is set to 0 and rotationX takes
 * the whole remaining angle, so the result is stable.
 */
export function decomposeXYZ(m: WorldMat4): XYZPose {
  const at = (i: number) => m[i] as number
  const sx = Math.hypot(at(0), at(1), at(2))
  const sy = Math.hypot(at(4), at(5), at(6))
  const sz = Math.hypot(at(8), at(9), at(10))
  const [kx, ky, kz] = [sx || 1, sy || 1, sz || 1]
  // The rotation's entries, row r and column c.
  const r00 = at(0) / kx
  const r10 = at(1) / kx
  const r20 = at(2) / kx
  const r01 = at(4) / ky
  const r11 = at(5) / ky
  const r21 = at(6) / ky
  const r22 = at(10) / kz
  const cosY = Math.hypot(r00, r10)
  const rotationY = Math.atan2(-r20, cosY)
  let rotationX: number
  let rotation: number
  if (cosY > 1e-9) {
    rotationX = Math.atan2(r21, r22)
    rotation = Math.atan2(r10, r00)
  } else {
    rotationX = Math.atan2(r20 < 0 ? r01 : -r01, r11)
    rotation = 0
  }
  return {
    position: [clean(at(12)), clean(at(13)), clean(at(14))],
    rotation: { rotationX: clean(rotationX * DEG), rotationY: clean(rotationY * DEG), rotation: clean(rotation * DEG) },
    scale: [sx, sy, sz],
  }
}

// ---------------------------------------------------------------------------
// Cameras
// ---------------------------------------------------------------------------

/** The part of a camera that decides what it sees. */
export type CameraLens = Pick<CameraSpec, 'projection' | 'focalLength' | 'sensorWidth' | 'orthoScale' | 'shiftX' | 'shiftY'>

/** A camera: its matrix (camera space to world) and lens. It looks down its local -Z, with +Y up and +X right. */
export interface WorldCamera {
  matrix: WorldMat4
  spec: CameraLens
}

/** The sensor spans the comp's longer side: the focal length in px that makes a distance of that many px one to one. */
const sensorFit = (spec: Pick<CameraSpec, 'focalLength' | 'sensorWidth'>, width: number, height: number): number =>
  (Math.max(width, height) * spec.focalLength) / spec.sensorWidth

/**
 * Where a world with no live camera is seen from: in front of the pictures,
 * looking along +Y, far enough that the plane y = 0 maps one unit to one
 * pixel (D = the front camera's distance for a 50 mm lens).
 */
export function defaultCameraPose(width: number, height: number) {
  const distance = sensorFit({ focalLength: 50, sensorWidth: 36 }, width, height)
  return { position: [0, -distance, 0] as Vec3, rotationX: 90, rotationY: 0, rotation: 0, distance }
}

/** The default camera as a matrix and a lens (50 mm, 36 mm sensor, perspective, no shift). */
export function defaultCamera(width: number, height: number): WorldCamera & { spec: CameraSpec } {
  const pose = defaultCameraPose(width, height)
  const [x, y, z] = pose.position
  const matrix = mat4Compose(mat4Translate(x, y, z), mat4RotateZ(pose.rotation * RAD), mat4RotateY(pose.rotationY * RAD), mat4RotateX(pose.rotationX * RAD))
  return { matrix, spec: CameraSchema.parse({}) }
}

/**
 * A lens's field of view in degrees. The sensor spans the longer side: that
 * axis is 2·atan(sensor / 2 / focal) and the other follows from the aspect.
 */
export function cameraFov(spec: Pick<CameraSpec, 'focalLength' | 'sensorWidth'>, width: number, height: number): { fovX: number; fovY: number } {
  const long = Math.max(width, height)
  const half = Math.atan(spec.sensorWidth / 2 / spec.focalLength)
  const fovLong = 2 * half * DEG
  const fovShort = 2 * Math.atan(Math.tan(half) * (Math.min(width, height) / long)) * DEG
  return width >= height ? { fovX: fovLong, fovY: fovShort } : { fovX: fovShort, fovY: fovLong }
}

/**
 * Projects a world point to comp pixels (top-left origin) through a camera.
 * Perspective follows the sensor-fit rule, so the default camera maps the
 * plane y = 0 one to one: world (u, 0, -v) lands at (w/2 + u, h/2 + v).
 * Orthographic spans `orthoScale` px of the longer side. A lens shift moves
 * the view by that fraction of the longer side, as Blender does: +shiftX
 * moves the view right (the picture left), +shiftY up (the picture down).
 * The camera's own scale is ignored. Null when the point is at or behind the
 * camera (depth ≤ 1e-6).
 */
export function projectWorldPoint(camera: WorldCamera, width: number, height: number, point: Vec3): [number, number] | null {
  const m = camera.matrix
  const at = (i: number) => m[i] as number
  // Camera axes in world space (columns, scale taken out), and the point in them.
  const axis = (c: number): Vec3 => {
    const len = Math.hypot(at(c * 4), at(c * 4 + 1), at(c * 4 + 2)) || 1
    return [at(c * 4) / len, at(c * 4 + 1) / len, at(c * 4 + 2) / len]
  }
  const dx: Vec3 = [point[0] - at(12), point[1] - at(13), point[2] - at(14)]
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const right = dot(dx, axis(0))
  const up = dot(dx, axis(1))
  const depth = -dot(dx, axis(2))
  if (depth <= 1e-6) return null
  const long = Math.max(width, height)
  const { spec } = camera
  const k = spec.projection === 'orthographic' ? long / spec.orthoScale : sensorFit(spec, width, height) / depth
  return [width / 2 + right * k - spec.shiftX * long, height / 2 - up * k + spec.shiftY * long]
}

/**
 * The camera a world shows at a time: the topmost camera layer that covers
 * it (lanes run front to back; hidden lanes and disabled layers are skipped;
 * a layer spans [start, end)). Null in a gap: the caller uses the default
 * camera.
 */
export function liveCamera(comp: Comp, timeMs: number): CameraLayer | null {
  for (const track of comp.tracks) {
    if (track.hidden) continue
    for (const layer of track.layers) {
      if (layer.kind === 'camera' && layer.enabled && timeMs >= layer.startMs && timeMs < layer.startMs + layer.durationMs) return layer
    }
  }
  return null
}

/**
 * How far a point is from a camera along its view axis (the camera's local
 * -Z, scale taken out), in px: the depth a lens focuses at. A point beside or
 * behind the camera gives 0, never a negative distance.
 */
export function focusDistanceOf(cameraMatrix: WorldMat4, target: Vec3): number {
  const at = (i: number) => cameraMatrix[i] as number
  const len = Math.hypot(at(8), at(9), at(10)) || 1
  const depth = -((target[0] - at(12)) * at(8) + (target[1] - at(13)) * at(9) + (target[2] - at(14)) * at(10)) / len
  return Math.max(0, clean(depth))
}

// ---------------------------------------------------------------------------
// Aiming
// ---------------------------------------------------------------------------

type Vec = Vec3
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const unit = (a: Vec): Vec => {
  const len = Math.hypot(a[0], a[1], a[2])
  return len > 0 ? [a[0] / len, a[1] / len, a[2] / len] : [0, 0, 0]
}

/**
 * The turns (degrees, for rotationX, rotationY, rotation) that aim a layer
 * at a point. A camera or light aims its local -Z, with its local +Y as
 * close to world +Z as it can be (a level horizon); any other kind aims its
 * local -Y, with local +Z up. Looking straight up or down has no horizon, so
 * the top then points toward +Y (down) or -Y (up). A target on the position
 * gives no turn.
 */
export function lookAtRotation(position: Vec3, target: Vec3, kind: LayerKind): { rotationX: number; rotationY: number; rotation: number } {
  const aim = unit(sub(target, position))
  if (aim[0] === 0 && aim[1] === 0 && aim[2] === 0) return { rotationX: 0, rotationY: 0, rotation: 0 }
  const lens = kind === 'camera' || kind === 'light'
  // The axis that points away from the target, and the one that should be up.
  const back: Vec = [-aim[0], -aim[1], -aim[2]]
  const sideOf = (up: Vec): Vec => (lens ? cross(up, back) : cross(back, up))
  let side = sideOf([0, 0, 1])
  if (Math.hypot(...side) < 1e-9) side = sideOf(aim[2] < 0 ? [0, 1, 0] : [0, -1, 0])
  side = unit(side)
  // Right-handed frame x, y, z: a lens has z = back and y near up; the rest have y = back and z near up.
  const [x, y, z]: [Vec, Vec, Vec] = lens ? [side, cross(back, side), back] : [side, back, cross(side, back)]
  const frame = fromRows(x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, 0, 0, 0, 1)
  return decomposeXYZ(frame).rotation
}

// ---------------------------------------------------------------------------
// Constraints
// ---------------------------------------------------------------------------

/** Position, turns and scale of a matrix as a unit quaternion, for blending. */
interface Trs {
  t: Vec3
  q: [x: number, y: number, z: number, w: number]
  s: Vec3
}

function toTrs(m: WorldMat4): Trs {
  const at = (i: number) => m[i] as number
  const sx = Math.hypot(at(0), at(1), at(2)) || 1
  const sy = Math.hypot(at(4), at(5), at(6)) || 1
  const sz = Math.hypot(at(8), at(9), at(10)) || 1
  const [r00, r10, r20] = [at(0) / sx, at(1) / sx, at(2) / sx]
  const [r01, r11, r21] = [at(4) / sy, at(5) / sy, at(6) / sy]
  const [r02, r12, r22] = [at(8) / sz, at(9) / sz, at(10) / sz]
  const trace = r00 + r11 + r22
  let q: Trs['q']
  if (trace > 0) {
    const k = Math.sqrt(trace + 1) * 2
    q = [(r21 - r12) / k, (r02 - r20) / k, (r10 - r01) / k, k / 4]
  } else if (r00 > r11 && r00 > r22) {
    const k = Math.sqrt(1 + r00 - r11 - r22) * 2
    q = [k / 4, (r01 + r10) / k, (r02 + r20) / k, (r21 - r12) / k]
  } else if (r11 > r22) {
    const k = Math.sqrt(1 + r11 - r00 - r22) * 2
    q = [(r01 + r10) / k, k / 4, (r12 + r21) / k, (r02 - r20) / k]
  } else {
    const k = Math.sqrt(1 + r22 - r00 - r11) * 2
    q = [(r02 + r20) / k, (r12 + r21) / k, k / 4, (r10 - r01) / k]
  }
  return { t: [at(12), at(13), at(14)], q, s: [sx, sy, sz] }
}

function fromTrs({ t, q, s }: Trs): WorldMat4 {
  const [x, y, z, w] = q
  const col = (a: number, b: number, c: number, k: number): number[] => [a * k, b * k, c * k, 0]
  return [
    ...col(1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), s[0]),
    ...col(2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), s[1]),
    ...col(2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), s[2]),
    t[0],
    t[1],
    t[2],
    1,
  ]
}

function slerp(a: Trs['q'], b: Trs['q'], k: number): Trs['q'] {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
  const sign = dot < 0 ? -1 : 1
  dot *= sign
  let [wa, wb] = [1 - k, k]
  if (dot < 0.9995) {
    const angle = Math.acos(Math.min(1, dot))
    const sin = Math.sin(angle)
    wa = Math.sin((1 - k) * angle) / sin
    wb = Math.sin(k * angle) / sin
  }
  const out = a.map((v, i) => v * wa + (b[i] as number) * sign * wb)
  const len = Math.hypot(...out) || 1
  return out.map((v) => v / len) as Trs['q']
}

/**
 * Blends two matrices: weight 0 is `a`, 1 is exactly `b`; between, position
 * and scale are mixed linearly and the turn by the shortest way round.
 */
export function blendMatrices(a: WorldMat4, b: WorldMat4, weight: number): WorldMat4 {
  if (weight >= 1) return b
  if (weight <= 0) return a
  const [from, to] = [toTrs(a), toTrs(b)]
  const mix = (p: Vec3, q: Vec3): Vec3 => [p[0] + (q[0] - p[0]) * weight, p[1] + (q[1] - p[1]) * weight, p[2] + (q[2] - p[2]) * weight]
  return fromTrs({ t: mix(from.t, to.t), q: slerp(from.q, to.q, weight), s: mix(from.s, to.s) })
}

/** One layer as the constraint solver sees it. */
export interface ConstraintNode {
  id: string
  kind: LayerKind
  /** The group it stands in (only when that group is a node too), whose changes carry it. */
  parentId: string | null
  constraints: readonly Constraint[] | undefined
  /** Unconstrained world matrix up to the pivot (`worldCore`, groups above applied). */
  core: WorldMat4
}

/** The constraint stages, in the order they run. */
export const CONSTRAINT_STAGES = ['childOf', 'follow', 'lookAt'] as const
export type ConstraintStage = (typeof CONSTRAINT_STAGES)[number]

/** Turns a matrix up to the pivot to face a point, keeping its position and scale. Unchanged when it already stands on the point. */
function aimedAt(core: WorldMat4, kind: LayerKind, point: Vec3): WorldMat4 {
  const pose = decomposeXYZ(core)
  const [x, y, z] = pose.position
  if (Math.hypot(point[0] - x, point[1] - y, point[2] - z) < 1e-6) return core
  const turn = lookAtRotation(pose.position, point, kind)
  return mat4Compose(
    mat4Translate(x, y, z),
    mat4RotateZ(turn.rotation * RAD),
    mat4RotateY(turn.rotationY * RAD),
    mat4RotateX(turn.rotationX * RAD),
    mat4Scale(...pose.scale),
  )
}

/**
 * Applies the constraints of a world's layers. Three stages run in order:
 * childOf (a parent's result before its children's, cycle-safe), follow (every
 * target read as childOf left it) and lookAt (aimed at where the target
 * stands by then). A disabled constraint, one without a target, one on itself
 * and one whose target is not a node do nothing. A group's change carries its
 * members before their own constraints run. Returns the final matrix of every
 * node (the very same array when nothing changed it); `upTo` stops after a
 * stage.
 */
export function solveConstraints(nodes: readonly ConstraintNode[], upTo: ConstraintStage = 'lookAt'): Map<string, WorldMat4> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  let prev = new Map(nodes.map((n) => [n.id, n.core]))
  for (const stage of CONSTRAINT_STAGES) {
    const readsFresh = stage !== 'follow'
    const next = new Map<string, WorldMat4>()
    const visiting = new Set<string>()
    const resolve = (id: string): WorldMat4 => {
      const done = next.get(id)
      if (done) return done
      const node = byId.get(id) as ConstraintNode
      const before = prev.get(id) as WorldMat4
      if (visiting.has(id)) return before
      visiting.add(id)
      let input = before
      if (node.parentId !== null && byId.has(node.parentId)) {
        const parentNow = resolve(node.parentId)
        const parentBefore = prev.get(node.parentId) as WorldMat4
        const inverse = parentNow === parentBefore ? null : mat4Invert(parentBefore)
        if (inverse) input = mat4Compose(parentNow, inverse, before)
      }
      let out = input
      const c = node.constraints?.find((k) => k.type === stage)
      if (c && c.enabled && c.influence > 0 && c.targetId !== null && c.targetId !== id && byId.has(c.targetId)) {
        const target = readsFresh ? resolve(c.targetId) : (prev.get(c.targetId) as WorldMat4)
        const place: Vec3 = [target[12] as number, target[13] as number, target[14] as number]
        let moved: WorldMat4
        if (c.type === 'childOf') moved = mat4Multiply(target, c.inverse && c.inverse.length === 16 ? mat4Multiply(c.inverse, input) : input)
        else if (c.type === 'follow') moved = mat4Multiply(c.rotation ? target : mat4Translate(...place), input)
        else moved = aimedAt(input, node.kind, place)
        out = blendMatrices(input, moved, c.influence)
      }
      visiting.delete(id)
      next.set(id, out)
      return out
    }
    for (const node of nodes) resolve(node.id)
    prev = next
    if (stage === upTo) break
  }
  return prev
}

// ---------------------------------------------------------------------------
// The objects of a world at a time
// ---------------------------------------------------------------------------

/** One layer of a world at a moment, placed in world space. */
export interface WorldObject {
  layer: Layer
  track: Track
  /** The group the layer is in, or null. */
  parentId: string | null
  kind: LayerKind
  /** The transform sampled at this moment (own values, before groups). */
  transform: Transform
  /** Local space to world, groups above it included. */
  matrix: WorldMat4
  /** The translation of `matrix`: where the layer's local origin is in the world (a picture's box centre). */
  position: Vec3
  /** The turns of `matrix`, degrees. */
  rotation: { rotationX: number; rotationY: number; rotation: number }
  /** The column lengths of `matrix`. */
  scale: Vec3
  /** Own opacity times that of every group above. */
  opacity: number
  /**
   * Set only when constraints (or a constrained group above) moved the layer:
   * `final = correction · unconstrained`, both as `matrix` is, so a picture
   * built from the flat, unconstrained matrices is placed by multiplying it
   * on the left. `matrix`, `position`, `rotation` and `scale` already
   * hold the final values.
   */
  correction?: WorldMat4
}

export interface WorldObjectsOptions {
  /** A picture's box size, for its pivot; null (or no callback) puts the pivot at the centre. */
  box?: (layer: Layer) => { width: number; height: number } | null
  /** Stop the constraints after their childOf stage (the matrices a childOf binds to). */
  stage?: 'childOf'
}

/** A layer's transform at a time measured from its start: keyed values sampled, the rest as stored. */
export function transformAt(layer: Layer, layerTimeMs: number): Transform {
  const specs = propertiesOf(layer)
  const out: Record<string, number> = { ...layer.transform }
  for (const name of Object.keys(layer.transform)) {
    const path = `transform.${name}`
    const spec = specs.find((s) => s.path === path)
    const value = spec ? evaluateProperty(layer, spec, layerTimeMs) : undefined
    if (typeof value === 'number' && Number.isFinite(value)) out[name] = value
  }
  return out as Transform
}

/**
 * Every layer standing in a world at a time, front lane first: enabled,
 * covering the time, on a visible lane, audio left out. Groups are listed
 * too and act as parents: a member's matrix is its groups' (outermost first)
 * times its own, and its opacity multiplies theirs. A group's own matrix has
 * no pivot (see `groupWorldMatrix`). Whole-layer entrance and exit poses
 * (animIn, animOut) are not applied here: the engine adds them (A7d).
 */
export function worldObjects(comp: Comp, timeMs: number, options: WorldObjectsOptions = {}): WorldObject[] {
  return placeWorld(comp, timeMs, options, false).objects
}

/**
 * The matrices up to the pivot (`worldCore`) of every object standing at a
 * time, after the constraints (or only after their childOf stage, with
 * `stage`): what a childOf binds to. Keyed by layer id.
 */
export function worldCoresAt(comp: Comp, timeMs: number, stage?: 'childOf'): Map<string, WorldMat4> {
  return placeWorld(comp, timeMs, { stage }, true).cores as Map<string, WorldMat4>
}

function placeWorld(comp: Comp, timeMs: number, options: WorldObjectsOptions, wantCores: boolean): { objects: WorldObject[]; cores: Map<string, WorldMat4> | null } {
  const groups = new Map<string, Layer>()
  for (const track of comp.tracks) {
    const group = groupOnLane(track)
    if (group) groups.set(group.id, group)
  }
  // A group's own matrix (all groups above it applied) and opacity, memoised.
  const placed = new Map<string, { matrix: WorldMat4; opacity: number }>()
  const parentOf = new Map<string, string | null>()
  for (const track of comp.tracks) for (const layer of track.layers) parentOf.set(layer.id, track.groupId)
  const placeGroup = (id: string, seen: Set<string>): { matrix: WorldMat4; opacity: number } => {
    const known = placed.get(id)
    if (known) return known
    const group = groups.get(id)
    const own = group ? transformAt(group, timeMs - group.startMs) : null
    const parent = parentOf.get(id) ?? null
    const above = own && parent && groups.has(parent) && !seen.has(parent) ? placeGroup(parent, new Set(seen).add(id)) : null
    const result = {
      matrix: own ? (above ? mat4Multiply(above.matrix, groupWorldMatrix(own)) : groupWorldMatrix(own)) : mat4Identity(),
      opacity: (own?.opacity ?? 1) * (above?.opacity ?? 1),
    }
    placed.set(id, result)
    return result
  }

  const objects: WorldObject[] = []
  const nodes: ConstraintNode[] = []
  const tails: WorldMat4[] = []
  const constrained = wantCores || comp.tracks.some((t) => t.layers.some((l) => (l.constraints?.length ?? 0) > 0))
  for (const track of comp.tracks) {
    if (track.hidden) continue
    for (const layer of track.layers) {
      if (layer.kind === 'audio' || !layer.enabled || timeMs < layer.startMs || timeMs >= layer.startMs + layer.durationMs) continue
      const transform = transformAt(layer, timeMs - layer.startMs)
      const parentId = track.groupId && groups.has(track.groupId) ? track.groupId : null
      const above = parentId ? placeGroup(parentId, new Set([layer.id])) : null
      const own = layer.kind === 'group' ? groupWorldMatrix(transform) : worldMatrix({ kind: layer.kind, transform }, options.box?.(layer) ?? null)
      const matrix = above ? mat4Multiply(above.matrix, own) : own
      const pose = decomposeXYZ(matrix)
      if (constrained) {
        const core = layer.kind === 'group' ? own : worldCore({ kind: layer.kind, transform })
        const coreWorld = above ? mat4Multiply(above.matrix, core) : core
        nodes.push({ id: layer.id, kind: layer.kind, parentId, constraints: layer.constraints, core: coreWorld })
        tails.push(hasTail(layer.kind) ? mat4Multiply(PICTURE_AXES, pictureTail(transform, options.box?.(layer) ?? null)) : mat4Identity())
      }
      objects.push({
        layer,
        track,
        parentId,
        kind: layer.kind,
        transform,
        matrix,
        position: pose.position,
        rotation: pose.rotation,
        scale: pose.scale,
        opacity: transform.opacity * (above?.opacity ?? 1),
      })
    }
  }
  if (!constrained) return { objects, cores: null }
  const finals = solveConstraints(nodes, options.stage)
  objects.forEach((o, i) => {
    const node = nodes[i] as ConstraintNode
    const core = finals.get(node.id) as WorldMat4
    if (core === node.core) return
    const matrix = hasTail(o.kind) ? mat4Multiply(core, tails[i] as WorldMat4) : core
    const pose = decomposeXYZ(matrix)
    const inverse = mat4Invert(node.core)
    const correction = inverse ? mat4Multiply(core, inverse) : null
    o.matrix = matrix
    o.position = pose.position
    o.rotation = pose.rotation
    o.scale = pose.scale
    if (correction && !isIdentity(correction)) o.correction = correction
  })
  return { objects, cores: finals }
}

/** Pictures end their matrix with the change of axes and the pivot offset; cameras, lights, empties, meshes and groups do not. */
const hasTail = (kind: LayerKind): boolean => !isSpatial(kind) && kind !== 'group'

function isIdentity(m: WorldMat4): boolean {
  const id = mat4Identity()
  return m.every((v, i) => Math.abs(v - (id[i] as number)) < 1e-9)
}
