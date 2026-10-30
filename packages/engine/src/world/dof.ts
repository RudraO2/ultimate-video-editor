import { evaluateProperty, type Layer, propertiesOf, type WorldMat4, type WorldObject } from '@uve/core'
import { WORLD_UNIT } from './threeCamera'

// Depth of field: the numbers behind the blur. A camera layer's `dof` is read
// each frame (focus distance and f-stop sampled when keyed) into a `FrameDof`;
// the renderer turns that into the bokeh pass's focus and aperture.

/** A camera's depth of field at one moment. */
export interface FrameDof {
  /** Distance from the camera to the plane in focus along its view axis, px. */
  focusDistance: number
  fStop: number
}

/** The widest blur, as a fraction of the picture (uv units). */
export const DOF_MAX_BLUR = 0.03

/**
 * The bokeh aperture: f² / (N · (s − f) · s · sensor), with f the focal
 * length and sensor the sensor width in metres, N the f-stop and s the
 * focus distance in metres (1 px of world is 1 cm). A focus closer than the
 * focal length cannot be focused by a real lens; it is held just past it.
 */
export function dofAperture(focalLengthMm: number, fStop: number, focusDistancePx: number, sensorWidthMm: number): number {
  const f = focalLengthMm / 1000
  const sensor = sensorWidthMm / 1000
  const s = Math.max(focusDistancePx * WORLD_UNIT, f * 1.01)
  return (f * f) / (Math.max(fStop, 0.1) * (s - f) * s * sensor)
}

/** How far a point is in front of a camera along its view axis (camera local -Z), px. Negative behind it. */
export function focusAlong(camera: WorldMat4, point: readonly [number, number, number]): number {
  const m = camera
  const len = Math.hypot(m[8] as number, m[9] as number, m[10] as number) || 1
  const forward = [-(m[8] as number) / len, -(m[9] as number) / len, -(m[10] as number) / len] as const
  return (point[0] - (m[12] as number)) * forward[0] + (point[1] - (m[13] as number)) * forward[1] + (point[2] - (m[14] as number)) * forward[2]
}

/**
 * The focus distance a camera uses: the distance to the object in focus along
 * the view axis when `focusObjectId` names a layer that is in the world now
 * (and in front of the camera), else the keyed or stored `focusDistance`.
 */
export function focusDistanceOf(camera: WorldMat4, focusObjectId: string | null, objects: readonly WorldObject[], focusDistance: number): number {
  if (focusObjectId) {
    const object = objects.find((o) => o.layer.id === focusObjectId)
    if (object) {
      const along = focusAlong(camera, object.position)
      if (along > 1e-6) return along
    }
  }
  return Math.max(0, focusDistance)
}

/** A camera layer's depth of field at a layer time (keyed focus distance and f-stop sampled), or undefined when it is off. */
export function cameraDofAt(layer: Layer & { kind: 'camera' }, layerTimeMs: number, matrix: WorldMat4, objects: readonly WorldObject[]): FrameDof | undefined {
  const { dof } = layer.camera
  if (!dof.enabled) return undefined
  const specs = propertiesOf(layer)
  const sampled = (path: string, fallback: number): number => {
    const spec = specs.find((p) => p.path === path)
    const value = spec ? evaluateProperty(layer, spec, layerTimeMs) : undefined
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
  }
  const keyed = sampled('camera.dof.focusDistance', dof.focusDistance)
  return {
    focusDistance: focusDistanceOf(matrix, dof.focusObjectId, objects, keyed),
    fStop: Math.max(0.1, sampled('camera.dof.fStop', dof.fStop)),
  }
}
