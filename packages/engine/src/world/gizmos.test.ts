import { cameraFov, mat4Translate } from '@uve/core'
import { describe, expect, it } from 'vitest'
import { boxEdges, cameraGizmo, circle, emptyGizmo, gridReach, gridSpacing, lightGizmo, pointSegmentDistance, rigid, SPOT_DEPTH, transformSegments } from './gizmos'

const comp = { width: 1920, height: 1080 }
const lens = { projection: 'perspective' as const, focalLength: 50, sensorWidth: 36, orthoScale: 1000 }
const points = (segments: readonly (readonly [readonly number[], readonly number[]])[]) => segments.flatMap(([a, b]) => [a, b])
const light = (type: 'point' | 'sun' | 'spot' | 'area' | 'environment' | 'hemisphere', extra: { spotAngle?: number; width?: number; height?: number } = {}) =>
  lightGizmo({ type, spotAngle: 45, width: 100, height: 100, ...extra })

describe('gizmo shapes', () => {
  it('draws a 50 mm camera as a frustum to a rectangle 100 px out', () => {
    const segments = cameraGizmo(lens, comp)
    const { fovX, fovY } = cameraFov(lens, comp.width, comp.height)
    const hw = 100 * Math.tan((fovX * Math.PI) / 360)
    const hh = 100 * Math.tan((fovY * Math.PI) / 360)
    expect(hw).toBeCloseTo(36)
    expect(hh).toBeCloseTo(20.25)
    // Four lines from the eye to the corners of the rectangle.
    const fromEye = segments.filter(([a]) => a[0] === 0 && a[1] === 0 && a[2] === 0)
    expect(fromEye).toHaveLength(4)
    const corners = fromEye.map(([, b]) => b)
    for (const [sx, sy] of [[-1, 1], [1, 1], [1, -1], [-1, -1]] as const) {
      const hit = corners.find((c) => Math.abs(c[0] - sx * hw) < 1e-9 && Math.abs(c[1] - sy * hh) < 1e-9)
      expect(hit?.[2]).toBe(-100)
    }
    // The up triangle sits above the top edge.
    const above = points(segments).filter((p) => (p[1] as number) > hh + 1e-9)
    expect(above.length).toBeGreaterThan(0)
  })

  it('follows the aspect of a portrait comp', () => {
    const tall = points(cameraGizmo(lens, { width: 1080, height: 1920 })).filter((p) => p[2] === -100)
    const halfWidth = Math.max(...tall.map((p) => Math.abs(p[0] as number)))
    expect(halfWidth).toBeCloseTo(20.25)
  })

  it('draws a spot as a circle 150 px out of radius 150 tan(angle / 2)', () => {
    const segments = light('spot', { spotAngle: 90 })
    const ring = segments.filter(([a, b]) => a[2] === -SPOT_DEPTH && b[2] === -SPOT_DEPTH)
    expect(ring.length).toBeGreaterThanOrEqual(24)
    for (const [a] of ring) expect(Math.hypot(a[0], a[1])).toBeCloseTo(150)
    expect(segments.filter(([a]) => a[2] === 0)).toHaveLength(4)
  })

  it('draws the other lights', () => {
    const sun = light('sun')
    expect(sun.some(([a, b]) => a[2] === 0 && b[2] === -400)).toBe(true)
    for (const [a] of light('point')) expect(Math.hypot(...a)).toBeCloseTo(18)
    const area = light('area', { width: 200, height: 80 })
    expect(Math.max(...points(area).map((p) => p[0] as number))).toBe(100)
    expect(area.some(([a, b]) => a[2] === 0 && b[2] === -120)).toBe(true)
    for (const [a] of light('environment')) expect(Math.hypot(...a)).toBeCloseTo(28.8)
    expect(Math.hypot(...(light('hemisphere')[0] as readonly [readonly [number, number, number], unknown])[0])).toBeCloseTo(27)
  })

  it('draws a controller by its display', () => {
    expect(emptyGizmo({ display: 'axes', size: 80 })).toHaveLength(3)
    expect(emptyGizmo({ display: 'cube', size: 80 })).toHaveLength(12)
    expect(boxEdges([0, 0, 0], [1, 2, 3])).toHaveLength(12)
    expect(circle(5, 'xz')[0]?.[0][1]).toBe(0)
  })

  it('keeps a gizmo the same size when the object is scaled, and moves it with the object', () => {
    const scaled = [3, 0, 0, 0, 0, 3, 0, 0, 0, 0, 3, 0, 10, 20, 30, 1]
    const [a, b] = transformSegments(rigid(scaled), [[[0, 0, 0], [1, 0, 0]]])[0] as readonly [readonly number[], readonly number[]]
    expect(a).toEqual([10, 20, 30])
    expect(b[0]).toBeCloseTo(11)
    expect(transformSegments(mat4Translate(1, 2, 3), [[[0, 0, 0], [0, 0, 1]]])[0]?.[1]).toEqual([1, 2, 4])
  })

  it('measures the distance to a segment', () => {
    expect(pointSegmentDistance([5, 5], [0, 0], [10, 0])).toBe(5)
    expect(pointSegmentDistance([-3, 4], [0, 0], [10, 0])).toBe(5)
    expect(pointSegmentDistance([1, 1], [2, 2], [2, 2])).toBeCloseTo(Math.SQRT2)
  })
})

describe('the grid', () => {
  it('fades from 35 % to 100 % of max(2000, 12 × distance)', () => {
    expect(gridReach(100)).toEqual({ start: 700, end: 2000 })
    expect(gridReach(1000).end).toBe(12000)
    expect(gridReach(1000).start).toBeCloseTo(4200)
  })

  it('puts a major line every size and a minor one every size / divisions', () => {
    expect(gridSpacing({ size: 100, divisions: 10 })).toEqual({ minor: 10, major: 100 })
    expect(gridSpacing({ size: 50, divisions: 0 })).toEqual({ minor: 50, major: 50 })
  })
})
