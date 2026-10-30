import { type Mat4, mat4 } from './math'

/** Sensor width of the front camera along the comp's longer side, in mm (full frame). */
export const SENSOR_MM = 36
export const DEFAULT_FOCAL_LENGTH_MM = 50

/** The camera every flat comp is seen through. It looks down +z from in front of the picture. */
export interface FrontCamera {
  width: number
  height: number
  /** Distance from the camera to the depth-0 plane, in comp pixels. */
  distance: number
}

/**
 * Places the camera so that depth 0 maps exactly 1:1 to comp pixels: the
 * sensor's span over the focal length equals the comp's longer side over the
 * distance (similar triangles).
 */
export function frontCamera(width: number, height: number, focalLengthMm = DEFAULT_FOCAL_LENGTH_MM): FrontCamera {
  return { width, height, distance: (Math.max(width, height) * focalLengthMm) / SENSOR_MM }
}

/**
 * Clip-space projection for comp coordinates (origin at the centre, +y down,
 * +z away). w = distance + z, so depth 0 is pixel-exact and a point one
 * camera distance further away appears at half size. Depth is not used for
 * hiding: flat comps keep their stacking order.
 */
export function projectionMatrix(camera: FrontCamera): Mat4 {
  const { width, height, distance: d } = camera
  return mat4((2 * d) / width, 0, 0, 0, 0, (-2 * d) / height, 0, 0, 0, 0, 0, 0, 0, 0, 1, d)
}

/** Projects a comp-space point to comp pixels (top-left origin); null when it is behind the camera. */
export function projectToPixels(camera: FrontCamera, x: number, y: number, z: number): [number, number] | null {
  const w = camera.distance + z
  if (w <= 1e-3) return null
  const k = camera.distance / w
  return [camera.width / 2 + x * k, camera.height / 2 + y * k]
}
