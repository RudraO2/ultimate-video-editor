import { describe, expect, it } from 'vitest'
import { frontCamera, projectionMatrix, projectToPixels } from './camera'
import { layerMatrix } from './evaluate'
import { transformPoint } from './math'

const flat = { x: 0, y: 0, z: 0, rotation: 0, rotationX: 0, rotationY: 0, scaleX: 1, scaleY: 1, scaleZ: 1, anchorX: 0.5, anchorY: 0.5, opacity: 1 }

describe('front camera', () => {
  it('sits where depth 0 is pixel-exact for a 50 mm lens', () => {
    const camera = frontCamera(1920, 1080)
    expect(camera.distance).toBeCloseTo((1920 * 50) / 36)
    expect(projectToPixels(camera, 0, 0, 0)).toEqual([960, 540])
    expect(projectToPixels(camera, 100, -50, 0)).toEqual([1060, 490])
  })

  it('halves sizes one camera distance further away and hides points behind it', () => {
    const camera = frontCamera(1920, 1080)
    expect(projectToPixels(camera, 200, 0, camera.distance)).toEqual([1060, 540])
    expect(projectToPixels(camera, 0, 0, -camera.distance - 1)).toBeNull()
  })

  it('uses the longer side for portrait comps', () => {
    expect(frontCamera(1080, 1920).distance).toBeCloseTo((1920 * 50) / 36)
  })

  it('agrees with the clip-space matrix', () => {
    const camera = frontCamera(1920, 1080)
    const [x, y, , w] = transformPoint(projectionMatrix(camera), 96, -54, 0)
    expect(x / w).toBeCloseTo(0.1)
    expect(y / w).toBeCloseTo(0.1)
  })
})

describe('layer matrix', () => {
  const box = { width: 200, height: 100 }

  it('rotates clockwise on screen around the pivot', () => {
    const [x, y] = transformPoint(layerMatrix({ ...flat, rotation: 90 }, box), 100, 0, 0)
    expect(x).toBeCloseTo(0)
    expect(y).toBeCloseTo(100)
  })

  it('leans the top away for positive rotationX and turns the right side away for positive rotationY', () => {
    expect(transformPoint(layerMatrix({ ...flat, rotationX: 30 }, box), 0, -100, 0)[2]).toBeGreaterThan(0)
    expect(transformPoint(layerMatrix({ ...flat, rotationY: 30 }, box), 100, 0, 0)[2]).toBeGreaterThan(0)
  })

  it('scales around the anchor and then moves to the position', () => {
    // A pivot on the right edge (anchorX 1) of a 200 px box is 100 px right of the centre.
    const t = { ...flat, x: 50, y: 20, scaleX: 2, scaleY: 2, anchorX: 1, anchorY: 0.5 }
    // The anchor point itself lands exactly on the position.
    expect(transformPoint(layerMatrix(t, box), 100, 0, 0).slice(0, 3)).toEqual([50, 20, 0])
    // The left edge, 200 px left of it, lands 400 px left after the 2x scale.
    expect(transformPoint(layerMatrix(t, box), -100, 0, 0)[0]).toBe(-350)
  })
})
