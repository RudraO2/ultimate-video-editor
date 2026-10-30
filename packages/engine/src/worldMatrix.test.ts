import { defaultCamera, mat4Multiply, mat4TransformPoint, PICTURE_AXES, projectWorldPoint, type Transform, worldMatrix } from '@uve/core'
import { describe, expect, it } from 'vitest'
import { frontCamera, projectToPixels } from './camera'
import { layerMatrix } from './evaluate'
import { transformPoint } from './math'

const W = 1920
const H = 1080
const box = { width: 300, height: 200 }

/** A small deterministic random source, so failures repeat. */
function rng(seed: number) {
  let s = seed
  return (lo: number, hi: number) => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return lo + (s / 4294967296) * (hi - lo)
  }
}

/**
 * A random flat transform turned in the picture plane or about Y, not both:
 * with both, the turns cannot be written in the world's Z·Y·X order.
 */
function flatTransform(random: ReturnType<typeof rng>, i: number): Transform {
  const turn = random(-180, 180)
  return {
    x: random(-800, 800),
    y: random(-500, 500),
    z: random(-600, 600),
    rotation: i % 2 === 0 ? turn : 0,
    rotationX: random(-60, 60),
    rotationY: i % 2 === 0 ? 0 : turn / 3,
    scaleX: random(0.3, 3),
    scaleY: random(0.3, 3),
    scaleZ: 1,
    anchorX: random(-0.5, 1.5),
    anchorY: random(-0.5, 1.5),
    opacity: 1,
  }
}

/**
 * The same picture as a world layer. A flat turn in the picture plane is a
 * turn about world Y, flat depth is world Y and flat down is world -Z. The
 * world's rotationX is the standard right-handed turn about X, which tilts a
 * picture's top toward the viewer, so it is the flat rotationX negated. The
 * flat rotationY (right edge away) is a turn about world Z with the same sign.
 */
function worldTransform(flat: Transform): Transform {
  return { ...flat, x: flat.x, y: flat.z, z: -flat.y, rotationX: -flat.rotationX, rotationY: flat.rotation, rotation: flat.rotationY, scaleZ: 1 }
}

describe('world matrix against the flat layer matrix', () => {
  it('lands box corners on the same pixels through the default camera', () => {
    const random = rng(3)
    const front = frontCamera(W, H)
    const camera = defaultCamera(W, H)
    expect(front.distance).toBeCloseTo(-(camera.matrix[13] as number), 9)
    for (let i = 0; i < 100; i++) {
      const flat = flatTransform(random, i)
      const converted = worldTransform(flat)
      const flatM = layerMatrix(flat, box)
      const worldM = worldMatrix({ kind: 'image', transform: converted }, box)
      for (const [cx, cy] of [
        [-150, -100],
        [150, -100],
        [150, 100],
        [-150, 100],
        [0, 0],
      ] as const) {
        const [fx, fy, fz] = transformPoint(flatM, cx, cy, 0)
        const expected = projectToPixels(front, fx, fy, fz)
        const [wx, wy, wz] = mat4TransformPoint(worldM, cx, cy, 0)
        const actual = projectWorldPoint(camera, W, H, [wx, wy, wz])
        expect(expected).not.toBeNull()
        expect(actual).not.toBeNull()
        expect(actual?.[0]).toBeCloseTo((expected as number[])[0] as number, 6)
        expect(actual?.[1]).toBeCloseTo((expected as number[])[1] as number, 6)
      }
    }
  })

  it('equals P·layerMatrix entrywise', () => {
    const random = rng(5)
    for (let i = 0; i < 100; i++) {
      const flat = flatTransform(random, i)
      const worldM = worldMatrix({ kind: 'image', transform: worldTransform(flat) }, box)
      const expected = mat4Multiply(PICTURE_AXES, layerMatrix(flat, box))
      expected.forEach((v, k) => expect(worldM[k]).toBeCloseTo(v, 9))
    }
  })
})
