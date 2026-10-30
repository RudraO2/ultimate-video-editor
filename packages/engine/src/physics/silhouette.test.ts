import { describe, expect, it } from 'vitest'
import { polygonArea } from './geometry'
import { traceSilhouette } from './silhouette'

function paint(w: number, h: number, solid: (x: number, y: number) => boolean) {
  const rgba = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (solid(x + 0.5, y + 0.5)) rgba[(y * w + x) * 4 + 3] = 255
  return rgba
}

describe('traceSilhouette', () => {
  it('outlines a drawn disc with about its area', () => {
    const rgba = paint(100, 100, (x, y) => Math.hypot(x - 50, y - 50) <= 40)
    const polys = traceSilhouette(rgba, 100, 100)
    expect(polys).toHaveLength(1)
    const poly = polys[0] as [number, number][]
    expect(poly.length).toBeLessThanOrEqual(64)
    expect(Math.abs(polygonArea(poly))).toBeGreaterThan(0.48)
    expect(Math.abs(polygonArea(poly))).toBeLessThan(0.52)
    for (const [x, y] of poly) expect(Math.hypot(x - 0.5, y - 0.5)).toBeGreaterThan(0.36)
  })

  it('finds two blobs, largest first, and ignores specks and holes', () => {
    const rgba = paint(120, 60, (x, y) => (x > 5 && x < 55 && y > 5 && y < 55 && !(x > 20 && x < 40 && y > 20 && y < 40)) || (x > 70 && x < 100 && y > 20 && y < 50) || (x > 110 && x < 111 && y > 5 && y < 6))
    const polys = traceSilhouette(rgba, 120, 60)
    expect(polys).toHaveLength(2)
    expect(Math.abs(polygonArea(polys[0] as [number, number][]))).toBeGreaterThan(Math.abs(polygonArea(polys[1] as [number, number][])))
    expect(polys[0]?.every(([x]) => x < 0.5)).toBe(true)
    expect(polys[1]?.every(([x]) => x > 0.5)).toBe(true)
    expect(traceSilhouette(rgba, 120, 60, { maxPolygons: 1 })).toHaveLength(1)
  })

  it('gives the unit square for an opaque picture and nothing for an empty one', () => {
    expect(traceSilhouette(paint(32, 20, () => true), 32, 20)).toEqual([[[0, 0], [1, 0], [1, 1], [0, 1]]])
    expect(traceSilhouette(paint(32, 20, () => false), 32, 20)).toEqual([])
    expect(traceSilhouette(new Uint8ClampedArray(0), 0, 0)).toEqual([])
  })

  it('squares off a shape drawn to the picture edge', () => {
    const polys = traceSilhouette(paint(40, 40, (x, y) => x < 20 || y < 10), 40, 40)
    const poly = polys[0] as [number, number][]
    for (const corner of [[0, 0], [1, 0], [1, 0.25], [0.5, 1], [0, 1]]) expect(poly).toContainEqual(corner)
    expect(polygonArea(poly)).toBeCloseTo(0.5 + 0.5 * 0.25, 1)
  })
})
