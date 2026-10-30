import { describe, expect, it } from 'vitest'
import { convertToWorld, flatEquivalent, flatTurns } from './moveInto'
import { type Layer, LayerSchema, type Transform, TransformSchema } from './schema'
import { mat4Compose, mat4Multiply, mat4Scale, mat4Translate, mat4TransformPoint, PICTURE_AXES, worldMatrix } from './world'

/** A small deterministic random source, so failures repeat. */
function rng(seed: number) {
  let s = seed
  return (lo: number, hi: number) => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return lo + (s / 4294967296) * (hi - lo)
  }
}

const box = { width: 300, height: 200 }

/** A random transform with every turn free, so both rotation and rotationY can be non-zero. */
const randomTransform = (random: ReturnType<typeof rng>, extra: Partial<Transform> = {}): Transform =>
  TransformSchema.parse({
    x: random(-800, 800),
    y: random(-500, 500),
    z: random(-600, 600),
    rotation: random(-180, 180),
    rotationX: random(-80, 80),
    rotationY: random(-80, 80),
    scaleX: random(0.3, 3),
    scaleY: random(0.3, 3),
    anchorX: random(-0.5, 1.5),
    anchorY: random(-0.5, 1.5),
    ...extra,
  })

/** The flat layer matrix (engine `layerMatrix`) rebuilt from core's helpers: T·Rz·Ry(-)·Rx(-)·S(sx, sy, 1)·T(-pivot). */
function flatMatrix(t: Transform): number[] {
  const px = (t.anchorX - 0.5) * box.width
  const py = (t.anchorY - 0.5) * box.height
  return mat4Compose(mat4Translate(t.x, t.y, t.z), flatTurns(t), mat4Scale(t.scaleX, t.scaleY, 1), mat4Translate(-px, -py, 0))
}

const expectSame = (a: number[], b: number[], digits = 9) => {
  for (let i = 0; i < 16; i++) expect(Math.abs((a[i] as number) - (b[i] as number))).toBeLessThan(10 ** -digits)
}

describe('flatEquivalent', () => {
  it('gives P·flatMatrix(F) = worldMatrix(W) entrywise for random world transforms', () => {
    const random = rng(5)
    for (let i = 0; i < 100; i++) {
      const w = randomTransform(random)
      const f = flatEquivalent(w)
      expect(f.scaleZ).toBe(1)
      expectSame(mat4Multiply(PICTURE_AXES, flatMatrix(f)), worldMatrix({ kind: 'shape', transform: w }, box))
    }
  })

  it('lands plane points on the same world points when scaleZ is not 1', () => {
    const random = rng(8)
    for (let i = 0; i < 50; i++) {
      const w = randomTransform(random, { scaleZ: random(0.2, 4) })
      const f = flatEquivalent(w)
      const world = worldMatrix({ kind: 'shape', transform: w }, box)
      const flat = mat4Multiply(PICTURE_AXES, flatMatrix(f))
      for (const [u, v] of [[-150, -100], [150, -100], [150, 100], [-150, 100], [0, 0]] as const) {
        const a = mat4TransformPoint(world, u, v, 0)
        const b = mat4TransformPoint(flat, u, v, 0)
        for (let k = 0; k < 3; k++) expect(Math.abs((a[k] as number) - (b[k] as number))).toBeLessThan(1e-7)
      }
    }
  })

  it('is the inverse of convertToWorld for unkeyed layers', () => {
    const random = rng(21)
    for (let i = 0; i < 100; i++) {
      const transform = randomTransform(random)
      const layer = LayerSchema.parse({ id: 'a', name: 'a', kind: 'shape', startMs: 0, durationMs: 1000, transform }) as Layer
      const flat = layer.transform
      convertToWorld(layer)
      const back = flatEquivalent(layer.transform)
      expectSame(flatMatrix(back), flatMatrix(flat))
      expect(back.opacity).toBe(flat.opacity)
      expect(back.anchorX).toBe(flat.anchorX)
    }
  })

  it('keeps the plain cases plain', () => {
    const f = flatEquivalent(TransformSchema.parse({ x: 10, y: 20, z: 30 }))
    expect([f.x, f.y, f.z, f.rotation, f.rotationX, f.rotationY]).toEqual([10, -30, 20, 0, 0, 0])
  })
})
