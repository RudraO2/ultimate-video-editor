import { defaultCamera, mat4Compose, mat4RotateX, mat4RotateY, mat4RotateZ, mat4Scale, mat4Translate, type Vec3 } from '@uve/core'
import { describe, expect, it } from 'vitest'
import { deltaInParent, type DragCamera, pixelsPerUnit, screenToWorldDelta } from './worldDrag'

const SIZE = { width: 1920, height: 1080 }
/** The default camera distance: sensor-fit focal length of a 50 mm lens on a 36 mm sensor. */
const FRONT = (1920 * 50) / 36
const RAD = Math.PI / 180
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

const front = (): DragCamera => {
  const base = defaultCamera(SIZE.width, SIZE.height)
  return { matrix: base.matrix, lens: base.spec }
}

describe('screenToWorldDelta', () => {
  it('moves one unit per pixel along X and Z for the default camera at depth 0', () => {
    const [x, y, z] = screenToWorldDelta(front(), SIZE, [0, 0, 0], [10, 20]) as Vec3
    expect(x).toBeCloseTo(10, 6)
    expect(y).toBeCloseTo(0, 6)
    expect(z).toBeCloseTo(-20, 6)
  })

  it('moves farther per pixel at greater depth', () => {
    const near = screenToWorldDelta(front(), SIZE, [0, 0, 0], [10, 0]) as Vec3
    const far = screenToWorldDelta(front(), SIZE, [0, FRONT, 0], [10, 0]) as Vec3
    expect(near[0]).toBeCloseTo(10, 6)
    expect(far[0]).toBeCloseTo(20, 4)
  })

  it('has no delta for a point behind the camera', () => {
    expect(screenToWorldDelta(front(), SIZE, [0, -5000, 0], [10, 0])).toBeNull()
  })

  it('stays in the view plane of a turned camera', () => {
    // Raised 35 degrees, turned 40 and rolled 10, 900 units from the point.
    const matrix = mat4Compose(mat4Translate(500, -600, 400), mat4RotateZ(40 * RAD), mat4RotateY(10 * RAD), mat4RotateX(55 * RAD))
    const camera: DragCamera = { matrix, lens: front().lens }
    const point: Vec3 = [120, 80, -30]
    const delta = screenToWorldDelta(camera, SIZE, point, [37, -22]) as Vec3
    const forward: Vec3 = [-(matrix[8] as number), -(matrix[9] as number), -(matrix[10] as number)]
    expect(dot(delta, forward)).toBeCloseTo(0, 6)
    const k = pixelsPerUnit(camera, SIZE, point) as number
    expect(Math.hypot(...delta)).toBeCloseTo(Math.hypot(37, 22) / k, 6)
  })

  it('maps screen right to the camera right axis when the camera has turned to look along -X', () => {
    // Rz(90) · Rx(90): looks along -X, its right is +Y.
    const matrix = mat4Compose(mat4Translate(FRONT, 0, 0), mat4RotateZ(90 * RAD), mat4RotateX(90 * RAD))
    const camera: DragCamera = { matrix, lens: front().lens }
    const [x, y, z] = screenToWorldDelta(camera, SIZE, [0, 0, 0], [10, 0]) as Vec3
    expect(x).toBeCloseTo(0, 6)
    expect(y).toBeCloseTo(10, 6)
    expect(z).toBeCloseTo(0, 6)
  })

  it('uses a fixed scale for an orthographic camera', () => {
    const base = front()
    const camera: DragCamera = { matrix: base.matrix, lens: { ...base.lens, projection: 'orthographic', orthoScale: 960 } }
    const [x] = screenToWorldDelta(camera, SIZE, [0, 3000, 0], [10, 0]) as Vec3
    expect(x).toBeCloseTo(5, 6)
  })
})

describe('deltaInParent', () => {
  it('leaves a delta alone with no parent', () => {
    expect(deltaInParent(null, [1, 2, 3])).toEqual([1, 2, 3])
  })

  it('takes a group move, turn and scale off the delta', () => {
    const parent = mat4Compose(mat4Translate(50, 60, 70), mat4RotateZ(90 * RAD), mat4Scale(2, 2, 2))
    const [x, y, z] = deltaInParent(parent, [0, 10, 4])
    // Rz(90) sends local +X to world +Y: a world +Y move of 10 is 5 along local X.
    expect(x).toBeCloseTo(5, 6)
    expect(y).toBeCloseTo(0, 6)
    expect(z).toBeCloseTo(2, 6)
  })
})
