import { CameraSchema, defaultCamera, mat4Compose, projectWorldPoint, TransformSchema, worldMatrix } from '@uve/core'
import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import type { FrameCamera, FrameLens } from './frame'
import { makeThreeCamera, WORLD_UNIT } from './threeCamera'

/** A small deterministic random source, so failures repeat. */
function rng(seed: number) {
  let s = seed
  return (lo: number, hi: number) => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return lo + (s / 4294967296) * (hi - lo)
  }
}

const lensOf = (over: Partial<FrameLens> = {}): FrameLens => {
  const { dof: _dof, ...lens } = CameraSchema.parse(over)
  return lens
}

/** Where three.js puts a world point (px), as comp pixels. */
function viaThree(camera: FrameCamera, comp: { width: number; height: number }, point: [number, number, number]): [number, number] | null {
  const three = makeThreeCamera(camera, comp, comp.width, comp.height)
  const v = new Vector3(point[0], point[1], point[2]).multiplyScalar(WORLD_UNIT).applyMatrix4(three.matrixWorldInverse)
  if (-v.z <= 1e-9) return null
  v.applyMatrix4(three.projectionMatrix)
  return [((v.x + 1) / 2) * comp.width, ((1 - v.y) / 2) * comp.height]
}

function agree(camera: FrameCamera, comp: { width: number; height: number }, seed: number): void {
  const random = rng(seed)
  let seen = 0
  for (let i = 0; i < 200; i++) {
    const point: [number, number, number] = [random(-2000, 2000), random(-2000, 2000), random(-1500, 1500)]
    const expected = projectWorldPoint({ matrix: camera.matrix, spec: camera.lens }, comp.width, comp.height, point)
    const actual = viaThree(camera, comp, point)
    if (!expected || !actual) {
      // Behind the camera for both.
      expect(expected === null && actual === null).toBe(true)
      continue
    }
    seen++
    expect(Math.abs(actual[0] - expected[0])).toBeLessThan(1e-6)
    expect(Math.abs(actual[1] - expected[1])).toBeLessThan(1e-6)
  }
  expect(seen).toBeGreaterThan(40)
}

const placed = (t: Partial<Parameters<typeof TransformSchema.parse>[0]>) => worldMatrix({ kind: 'camera', transform: TransformSchema.parse(t) }, null)

describe('the three.js camera', () => {
  it('projects like projectWorldPoint for the default camera', () => {
    const comp = { width: 1920, height: 1080 }
    const base = defaultCamera(comp.width, comp.height)
    agree({ id: 'default', matrix: base.matrix, lens: lensOf() }, comp, 1)
  })

  it('projects like projectWorldPoint for a turned live camera with a keyed-style lens', () => {
    const comp = { width: 1920, height: 1080 }
    const matrix = placed({ x: 500, y: -1800, z: 300, rotationX: 80, rotationY: 6, rotation: 12 })
    agree({ id: 'c', matrix, lens: lensOf({ focalLength: 35 }) }, comp, 2)
    agree({ id: 'c', matrix, lens: lensOf({ focalLength: 85 }) }, comp, 3)
  })

  it('projects like projectWorldPoint for a portrait comp', () => {
    const comp = { width: 1080, height: 1920 }
    const base = defaultCamera(comp.width, comp.height)
    agree({ id: 'default', matrix: base.matrix, lens: lensOf() }, comp, 4)
    agree({ id: 'c', matrix: placed({ x: -200, y: -2500, z: 100, rotationX: 88, rotation: -9 }), lens: lensOf({ focalLength: 28 }) }, comp, 5)
  })

  it('projects like projectWorldPoint with a lens shift', () => {
    const comp = { width: 1920, height: 1080 }
    const base = defaultCamera(comp.width, comp.height)
    agree({ id: 'c', matrix: base.matrix, lens: lensOf({ shiftX: 0.1, shiftY: -0.05 }) }, comp, 6)
    agree({ id: 'c', matrix: placed({ x: 300, y: -2000, z: 0, rotationX: 85 }), lens: lensOf({ focalLength: 40, shiftX: -0.2, shiftY: 0.15 }) }, comp, 7)
  })

  it('projects like projectWorldPoint when orthographic, with and without a shift', () => {
    const comp = { width: 1920, height: 1080 }
    const matrix = placed({ x: 100, y: -3000, z: 50, rotationX: 90 })
    agree({ id: 'c', matrix, lens: lensOf({ projection: 'orthographic', orthoScale: 2400 }) }, comp, 8)
    agree({ id: 'c', matrix, lens: lensOf({ projection: 'orthographic', orthoScale: 1500, shiftX: 0.1, shiftY: 0.2 }) }, comp, 9)
  })

  it('ignores the camera layer scale', () => {
    const comp = { width: 1920, height: 1080 }
    const scaled = mat4Compose(placed({ x: 0, y: -2000, z: 0, rotationX: 90 }))
    const big = placed({ x: 0, y: -2000, z: 0, rotationX: 90, scaleX: 3, scaleY: 0.5, scaleZ: 2 })
    expect(scaled).not.toEqual(big)
    agree({ id: 'c', matrix: big, lens: lensOf() }, comp, 10)
  })
})
