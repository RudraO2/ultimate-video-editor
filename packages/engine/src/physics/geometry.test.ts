import { describe, expect, it } from 'vitest'
import { convexHull, convexPieces, type Point, polygonArea, simplifyClosed } from './geometry'

const isConvex = (p: Point[]) =>
  p.every((a, i) => {
    const b = p[(i + 1) % p.length] as Point
    const c = p[(i + 2) % p.length] as Point
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) >= -1e-6
  })

const L: Point[] = [[0, 0], [100, 0], [100, 40], [40, 40], [40, 100], [0, 100]]
const C: Point[] = [[0, 0], [100, 0], [100, 30], [30, 30], [30, 70], [100, 70], [100, 100], [0, 100]]
const star: Point[] = Array.from({ length: 10 }, (_, i) => {
  const a = -Math.PI / 2 + (i * Math.PI) / 5
  const r = i % 2 === 0 ? 100 : 40
  return [Math.cos(a) * r, Math.sin(a) * r] as Point
})

function check(polygon: Point[], maxVertices = 12) {
  const pieces = convexPieces(polygon, maxVertices)
  expect(pieces.length).toBeGreaterThan(0)
  for (const p of pieces) {
    expect(isConvex(p)).toBe(true)
    expect(p.length).toBeLessThanOrEqual(maxVertices)
    expect(p.length).toBeGreaterThanOrEqual(3)
  }
  const total = pieces.reduce((s, p) => s + Math.abs(polygonArea(p)), 0)
  expect(Math.abs(total - Math.abs(polygonArea(polygon))) / Math.abs(polygonArea(polygon))).toBeLessThan(0.01)
  return pieces
}

describe('geometry', () => {
  it('takes the hull and the signed area', () => {
    const hull = convexHull([[0, 0], [10, 0], [10, 10], [0, 10], [5, 5], [5, 0], [3, 8]])
    expect(hull).toHaveLength(4)
    expect(polygonArea(hull)).toBe(100)
    expect(polygonArea([...hull].reverse())).toBe(-100)
    expect(convexHull([[1, 1], [1, 1]])).toEqual([[1, 1]])
  })

  it('simplifies a closed ring and thins it to a limit', () => {
    const circle: Point[] = Array.from({ length: 200 }, (_, i) => [50 * Math.cos((i * Math.PI) / 100), 50 * Math.sin((i * Math.PI) / 100)])
    const rough = simplifyClosed(circle, 0.5)
    expect(rough.length).toBeLessThan(60)
    expect(simplifyClosed(circle, 0.001, 20)).toHaveLength(20)
    const square: Point[] = [[0, 0], [5, 0], [10, 0], [10, 5], [10, 10], [5, 10], [0, 10], [0, 5]]
    expect(simplifyClosed(square, 0.1)).toHaveLength(4)
    expect(Math.abs(polygonArea(rough))).toBeGreaterThan(0.97 * Math.PI * 2500)
  })

  it('cuts an L, a C and a star into convex pieces', () => {
    expect(check(L).length).toBeGreaterThanOrEqual(2)
    expect(check(C).length).toBeGreaterThanOrEqual(3)
    expect(check(star).length).toBeGreaterThanOrEqual(3)
    check([...L].reverse())
  })

  it('keeps a convex polygon whole and splits one with too many points', () => {
    expect(convexPieces([[0, 0], [10, 0], [10, 10], [0, 10]])).toHaveLength(1)
    const round: Point[] = Array.from({ length: 40 }, (_, i) => [50 * Math.cos((i * Math.PI) / 20), 50 * Math.sin((i * Math.PI) / 20)])
    const pieces = check(round, 8)
    expect(pieces.length).toBeGreaterThan(1)
  })

  it('never throws on bad input', () => {
    const bow: Point[] = [[0, 0], [100, 100], [100, 0], [0, 100]]
    const pieces = convexPieces(bow)
    expect(pieces).toHaveLength(1)
    expect(pieces[0]?.length).toBe(4)
    expect(convexPieces([])).toEqual([])
    expect(convexPieces([[0, 0], [1, 1]])).toEqual([])
    expect(convexPieces([[0, 0], [50, 0], [100, 0], [20, 0]])).toEqual([])
    expect(convexPieces([[0, 0], [Number.NaN, 4], [10, 10], [0, 10]]).length).toBeLessThanOrEqual(1)
    const mess: Point[] = Array.from({ length: 30 }, (_, i) => [Math.sin(i * 7.3) * 80, Math.cos(i * 3.1) * 80])
    for (const p of convexPieces(mess)) expect(isConvex(p)).toBe(true)
    expect(convexPieces([[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5]])).toEqual([])
  })
})
