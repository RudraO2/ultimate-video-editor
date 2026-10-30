import { cameraFov } from '@uve/core'
import { Matrix4, OrthographicCamera, PerspectiveCamera } from 'three'
import type { FrameCamera } from './frame'

/** Three's units: the world is drawn under a root group scaled by this, so 1 px of world is 0.01 units. */
export const WORLD_UNIT = 0.01

/**
 * A three.js camera that sees the world exactly as core's `projectWorldPoint`
 * does: the sensor spans the comp's longer side, a lens shift moves the view
 * by that fraction of the longer side, orthographic spans `orthoScale` px of
 * the longer side. The camera's own scale is taken out of its matrix and its
 * position is in three's units. `comp` is the comp's size (it fixes the field
 * of view); the picture is drawn at the aspect `outWidth` : `outHeight`.
 */
export function makeThreeCamera(camera: FrameCamera, comp: { width: number; height: number }, outWidth: number, outHeight: number): PerspectiveCamera | OrthographicCamera {
  const { lens } = camera
  const long = Math.max(comp.width, comp.height)
  const near = lens.clipStart * WORLD_UNIT
  const far = lens.clipEnd * WORLD_UNIT
  let three: PerspectiveCamera | OrthographicCamera
  if (lens.projection === 'orthographic') {
    const span = lens.orthoScale * WORLD_UNIT
    const halfW = ((comp.width / long) * span) / 2
    const halfH = ((comp.height / long) * span) / 2
    const centreX = lens.shiftX * span
    const centreY = lens.shiftY * span
    three = new OrthographicCamera(centreX - halfW, centreX + halfW, centreY + halfH, centreY - halfH, near, far)
  } else {
    const fovY = cameraFov(lens, comp.width, comp.height).fovY
    const perspective = new PerspectiveCamera(fovY, outWidth / outHeight, near, far)
    // Lens shift is a skew of the projection: the x and y terms that multiply depth.
    perspective.projectionMatrix.elements[8] = (2 * lens.shiftX * long) / comp.width
    perspective.projectionMatrix.elements[9] = (2 * lens.shiftY * long) / comp.height
    perspective.projectionMatrixInverse.copy(perspective.projectionMatrix).invert()
    three = perspective
  }
  const m = camera.matrix
  const axis = (c: number): [number, number, number] => {
    const len = Math.hypot(m[c * 4] as number, m[c * 4 + 1] as number, m[c * 4 + 2] as number) || 1
    return [(m[c * 4] as number) / len, (m[c * 4 + 1] as number) / len, (m[c * 4 + 2] as number) / len]
  }
  const [x, y, z] = [axis(0), axis(1), axis(2)]
  const placed = new Matrix4().set(
    x[0], y[0], z[0], (m[12] as number) * WORLD_UNIT,
    x[1], y[1], z[1], (m[13] as number) * WORLD_UNIT,
    x[2], y[2], z[2], (m[14] as number) * WORLD_UNIT,
    0, 0, 0, 1,
  )
  three.matrixAutoUpdate = false
  three.matrix.copy(placed)
  three.matrixWorld.copy(placed)
  three.matrixWorldInverse.copy(placed).invert()
  return three
}
