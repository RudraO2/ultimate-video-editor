import { type Comp, type Layer, mat4Invert, mat4TransformPoint, projectWorldPoint, type Vec3, type WorldMat4, worldObjects } from '@uve/core'
import { Raycaster, type Object3D, Vector3 } from 'three'
import { orbitCamera, type OrbitView } from '../orbit'
import type { SceneSource } from '../scene'
import { buildWorldFrame } from './frame'
import { GIZMO_PICK_LINE_PX, GIZMO_PICK_ORIGIN_PX, gizmoOf, pointSegmentDistance, rigid, transformSegments } from './gizmos'
import type { WorldHost } from './host'
import { orbitKey, worldTime } from './orbitView'
import { peekView, type View } from './stage'
import { WORLD_UNIT } from './threeCamera'

// Picking through the orbit view: the layer under a point of the viewport.
// Cameras, lights and controllers are picked in screen space (near their
// origin or one of their lines) and win over everything; then the nearest
// picture (where it has ink), mesh or model along the ray. Meshes and models
// are raycast in the orbit scene as the last draw left it; the ray itself
// comes from the view given here.

/** A ray in world px; `direction` has length 1. */
export interface Ray {
  origin: Vec3
  direction: Vec3
}

/** Where a picture has ink: an alpha above this (0 to 255)... */
export const INK_ALPHA = 24
/** ...at the hit or within this many px of it (in the picture's own px). */
export const INK_REACH_PX = 6

/** The ray from the orbit camera through a point given in comp pixels (the view spans the comp's width × height). */
export function orbitRay(view: OrbitView, comp: Pick<Comp, 'width' | 'height'>, point: readonly [number, number]): Ray {
  const { matrix, spec } = orbitCamera(view, comp.width, comp.height)
  const long = Math.max(comp.width, comp.height)
  // A pixel's offset from the centre, in focal lengths (the sensor spans the longer side).
  const k = (long * spec.focalLength) / spec.sensorWidth
  const right = (point[0] - comp.width / 2 + spec.shiftX * long) / k
  const up = -(point[1] - comp.height / 2 - spec.shiftY * long) / k
  const column = (c: number): Vec3 => [matrix[c * 4] as number, matrix[c * 4 + 1] as number, matrix[c * 4 + 2] as number]
  const [x, y, z] = [column(0), column(1), column(2)]
  const d: Vec3 = [x[0] * right + y[0] * up - z[0], x[1] * right + y[1] * up - z[1], x[2] * right + y[2] * up - z[2]]
  const length = Math.hypot(d[0], d[1], d[2])
  return { origin: [matrix[12] as number, matrix[13] as number, matrix[14] as number], direction: [d[0] / length, d[1] / length, d[2] / length] }
}

/** Where a ray crosses the plane z = 0 of a local space: the distance along the ray and the local x, y; null when it runs parallel or the plane is behind. */
export function hitPlane(matrix: WorldMat4, ray: Ray): { t: number; x: number; y: number } | null {
  const inverse = mat4Invert(matrix)
  if (!inverse) return null
  const [ox, oy, oz] = mat4TransformPoint(inverse, ray.origin[0], ray.origin[1], ray.origin[2])
  // A direction is moved without the translation: the point one unit along, minus the origin.
  const [px, py, pz] = mat4TransformPoint(inverse, ray.origin[0] + ray.direction[0], ray.origin[1] + ray.direction[1], ray.origin[2] + ray.direction[2])
  const [dx, dy, dz] = [px - ox, py - oy, pz - oz]
  if (Math.abs(dz) < 1e-12) return null
  const t = -oz / dz
  if (t <= 0) return null
  return { t, x: ox + dx * t, y: oy + dy * t }
}

/** The picture under a local point has ink there or within `INK_REACH_PX` of it. */
function hasInk(entry: NonNullable<ReturnType<View['entries']['get']>>, x: number, y: number): boolean {
  const { canvas, spec } = entry
  const context = canvas.getContext('2d')
  if (!context || canvas.width < 1 || canvas.height < 1) return true
  const cx = Math.floor(((x - spec.rect.left) / spec.rect.width) * canvas.width)
  const cy = Math.floor(((y - spec.rect.top) / spec.rect.height) * canvas.height)
  const reach = Math.min(16, Math.max(1, Math.ceil(INK_REACH_PX * spec.raster)))
  const left = Math.max(0, cx - reach)
  const top = Math.max(0, cy - reach)
  const width = Math.min(canvas.width, cx + reach + 1) - left
  const height = Math.min(canvas.height, cy + reach + 1) - top
  if (width < 1 || height < 1) return false
  const data = context.getImageData(left, top, width, height).data
  for (let i = 3; i < data.length; i += 4) if ((data[i] as number) > INK_ALPHA) return true
  return false
}

/** The layer under a point in comp pixels through the orbit view, or null. See the module comment; `pxPerComp` is screen px per comp px, for the gizmo radii. */
export function orbitPick(
  host: WorldHost,
  comp: Comp,
  source: SceneSource,
  timeMs: number,
  view: OrbitView,
  point: readonly [number, number],
  options: { includeLocked?: boolean; pxPerComp?: number } = {},
): Layer | null {
  const includeLocked = options.includeLocked ?? false
  const perComp = Math.max(1e-6, options.pxPerComp ?? 1)
  const t = worldTime(comp, timeMs)
  const objects = worldObjects(comp, t)
  const camera = orbitCamera(view, comp.width, comp.height)

  // Gizmos first: the nearest to the point, each as a share of its own radius.
  let gizmo: { layer: Layer; score: number } | null = null
  for (const object of objects) {
    if (object.track.locked && !includeLocked) continue
    const local = gizmoOf(object.layer, comp)
    if (!local) continue
    const consider = (score: number) => {
      if (score <= 1 && (!gizmo || score < gizmo.score)) gizmo = { layer: object.layer, score }
    }
    const origin = projectWorldPoint(camera, comp.width, comp.height, object.position)
    if (origin) consider(Math.hypot(origin[0] - point[0], origin[1] - point[1]) / (GIZMO_PICK_ORIGIN_PX / perComp))
    for (const [a, b] of transformSegments(rigid(object.matrix), local)) {
      const pa = projectWorldPoint(camera, comp.width, comp.height, a)
      const pb = projectWorldPoint(camera, comp.width, comp.height, b)
      if (pa && pb) consider(pointSegmentDistance(point as [number, number], pa, pb) / (GIZMO_PICK_LINE_PX / perComp))
    }
  }
  if (gizmo) return (gizmo as { layer: Layer }).layer

  // Then the nearest surface along the ray.
  const ray = orbitRay(view, comp, point)
  const frame = buildWorldFrame(comp, source, timeMs)
  const scene = peekView(host, orbitKey(comp))
  let best: { layer: Layer; t: number } | null = null
  const offer = (layer: Layer, distance: number) => {
    if (!best || distance < best.t) best = { layer, t: distance }
  }
  for (const plane of frame.planes) {
    if (plane.opacity <= 0 || plane.node.stencil || (plane.locked && !includeLocked)) continue
    const hit = hitPlane(plane.matrix, ray)
    if (!hit) continue
    const { left, top, width, height } = plane.local
    if (hit.x < left || hit.x > left + width || hit.y < top || hit.y > top + height) continue
    const entry = scene?.entries.get(plane.id)
    if (entry && !hasInk(entry, hit.x, hit.y)) continue
    offer(plane.layer, hit.t)
  }
  if (scene) {
    scene.root.updateMatrixWorld(true)
    const caster = new Raycaster(new Vector3(...ray.origin).multiplyScalar(WORLD_UNIT), new Vector3(...ray.direction))
    for (const item of frame.meshes) {
      const locked = objects.find((o) => o.layer.id === item.id)?.track.locked ?? false
      if (item.opacity <= 0 || (locked && !includeLocked)) continue
      const target: Object3D | undefined = scene.meshes.get(item.id)?.mesh ?? scene.models.get(item.id)?.instance.group
      if (!target) continue
      const nearest = caster.intersectObject(target, true)[0]
      if (nearest) offer(item.layer, nearest.distance / WORLD_UNIT)
    }
  }
  return (best as { layer: Layer } | null)?.layer ?? null
}
