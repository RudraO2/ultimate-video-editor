import {
  type CameraSpec,
  type Comp,
  defaultCamera,
  evaluateProperty,
  liveCamera,
  mat4Invert,
  mat4TransformPoint,
  propertiesOf,
  type Vec3,
  type WorldCamera,
  type WorldMat4,
  type WorldObject,
  worldObjects,
} from '@uve/core'

// Dragging a layer in a 3D world with the Move tool. The pointer moves a
// layer in the plane that faces the live camera, through the layer's own
// position: a screen pixel there is (depth / focal length in px) world units,
// along the camera's right and up axes. With the default camera and a layer
// at depth 0 that is one pixel per unit along X and Z.

/** The part of a lens the drag reads. */
export type DragLens = Pick<CameraSpec, 'projection' | 'focalLength' | 'sensorWidth' | 'orthoScale'>

/** The camera a world is seen through: camera space to world, and its lens. */
export interface DragCamera {
  matrix: WorldMat4
  lens: DragLens
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** A matrix column as a unit vector (the camera's own scale is ignored). */
function axis(m: WorldMat4, column: number): Vec3 {
  const at = (row: number) => m[column * 4 + row] as number
  const len = Math.hypot(at(0), at(1), at(2)) || 1
  return [at(0) / len, at(1) / len, at(2) / len]
}

/**
 * The comp pixels one world unit covers at a point, on the plane facing the
 * camera: sensor-fit focal length over depth for a perspective lens, the
 * longer side over `orthoScale` for an orthographic one. Null when the point
 * is at or behind the camera.
 */
export function pixelsPerUnit(camera: DragCamera, size: { width: number; height: number }, point: Vec3): number | null {
  const long = Math.max(size.width, size.height)
  const { lens } = camera
  if (lens.projection === 'orthographic') return long / lens.orthoScale
  const m = camera.matrix
  const forward = axis(m, 2).map((v) => -v) as Vec3
  const depth = dot([point[0] - (m[12] as number), point[1] - (m[13] as number), point[2] - (m[14] as number)], forward)
  if (depth <= 1e-6) return null
  return ((long * lens.focalLength) / lens.sensorWidth) / depth
}

/**
 * The world move that a pointer move of `screen` comp pixels (right, down)
 * makes at `point`: in the camera's view plane. Null when the point is
 * behind the camera.
 */
export function screenToWorldDelta(camera: DragCamera, size: { width: number; height: number }, point: Vec3, screen: readonly [number, number]): Vec3 | null {
  const k = pixelsPerUnit(camera, size, point)
  if (k === null) return null
  const right = axis(camera.matrix, 0)
  const up = axis(camera.matrix, 1)
  const [sx, sy] = [screen[0] / k, -screen[1] / k]
  return [right[0] * sx + up[0] * sy, right[1] * sx + up[1] * sy, right[2] * sx + up[2] * sy]
}

/** A world delta in a parent group's space: the inverse of the group's matrix, without its translation. */
export function deltaInParent(parent: WorldMat4 | null, delta: Vec3): Vec3 {
  if (!parent) return delta
  const inverse = mat4Invert(parent)
  if (!inverse) return delta
  const [ox, oy, oz] = mat4TransformPoint(inverse, 0, 0, 0)
  const [x, y, z] = mat4TransformPoint(inverse, delta[0], delta[1], delta[2])
  return [x - ox, y - oy, z - oz]
}

/** The camera a world shows at a comp time: the live camera with its keyed lens, or the default camera. */
export function worldCameraAt(comp: Comp, timeMs: number, objects: readonly WorldObject[] = worldObjects(comp, timeMs)): WorldCamera {
  const live = liveCamera(comp, timeMs)
  const object = live ? objects.find((o) => o.layer.id === live.id) : undefined
  if (live && object) {
    const spec = propertiesOf(live).find((s) => s.path === 'camera.focalLength')
    const sampled = spec ? evaluateProperty(live, spec, timeMs - live.startMs) : undefined
    const focalLength = typeof sampled === 'number' && Number.isFinite(sampled) ? Math.min(5000, Math.max(1, sampled)) : live.camera.focalLength
    return { matrix: object.matrix, spec: { ...live.camera, focalLength } }
  }
  return defaultCamera(comp.width, comp.height)
}

/** The camera a drag reads: `worldCameraAt`, with the lens it needs. */
export function dragCameraAt(comp: Comp, timeMs: number, objects: readonly WorldObject[]): DragCamera {
  const { matrix, spec } = worldCameraAt(comp, timeMs, objects)
  return { matrix, lens: spec }
}

/** What a drag in a world needs, taken once when it starts. */
export interface WorldDrag {
  camera: DragCamera
  /** The layer's pivot in world space: the depth at which the drag is scaled. */
  position: Vec3
  /** The matrix of the group the layer is in, or null. */
  parent: WorldMat4 | null
}

/** The drag set-up for a layer of a world at a comp time; null when the layer is not standing there. */
export function worldDragAt(comp: Comp, layerId: string, timeMs: number): WorldDrag | null {
  const objects = worldObjects(comp, timeMs)
  const object = objects.find((o) => o.layer.id === layerId)
  if (!object) return null
  const parent = object.parentId ? (objects.find((o) => o.layer.id === object.parentId)?.matrix ?? null) : null
  return { camera: dragCameraAt(comp, timeMs, objects), position: object.position, parent }
}

/** The change of a layer's own x, y, z for a pointer move of `screen` comp pixels; null when it is behind the camera. */
export function worldDragDelta(drag: WorldDrag, size: { width: number; height: number }, screen: readonly [number, number]): Vec3 | null {
  const world = screenToWorldDelta(drag.camera, size, drag.position, screen)
  return world ? deltaInParent(drag.parent, world) : null
}
