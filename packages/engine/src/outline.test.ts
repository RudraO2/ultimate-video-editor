import { ShapeGeometrySchema } from '@uve/core'
import { describe, expect, it } from 'vitest'
import { polylineLength, shapeOutline, trimOutline } from './outline'

const rect = shapeOutline(ShapeGeometrySchema.parse({ width: 200, height: 100 }))

describe('outlines and trim', () => {
  it('measures a rectangle and an ellipse', () => {
    expect(polylineLength(rect)).toBe(600)
    const circle = shapeOutline(ShapeGeometrySchema.parse({ type: 'ellipse', width: 100, height: 100 }), 4)
    expect(polylineLength(circle)).toBeCloseTo(Math.PI * 100, 0)
    const rounded = shapeOutline(ShapeGeometrySchema.parse({ width: 200, height: 100, cornerRadius: 20 }), 4)
    expect(polylineLength(rounded)).toBeCloseTo(600 - 8 * 20 + Math.PI * 40, 0)
    expect(rounded.points[0]).toEqual([-80, -50])
  })

  it('draws a slice from the top-left corner, clockwise', () => {
    // A quarter of 600 px is the 150 px from the top-left corner along the top edge.
    expect(trimOutline(rect, 0, 0.25, 0)).toEqual([
      [
        [-100, -50],
        [50, -50],
      ],
    ])
    expect(trimOutline(rect, 0, 0, 0)).toEqual([])
    expect(trimOutline(rect, 0, 1, 0.3)[0]).toHaveLength(5)
  })

  it('wraps a slice moved past the start into one piece', () => {
    // From 90 % (540 px: 40 px up the left edge) to 10 % (60 px along the top).
    const [piece, extra] = trimOutline(rect, 0, 0.2, 0.9)
    expect(extra).toBeUndefined()
    expect(piece?.[0]).toEqual([-100, 10])
    const [x, y] = piece?.at(-1) ?? []
    expect(x).toBeCloseTo(-40)
    expect(y).toBe(-50)
    expect(piece).toContainEqual([-100, -50])
  })

  it('clips an open line at its ends instead of wrapping', () => {
    const line = { points: [[0, 0] as [number, number], [100, 0] as [number, number]], closed: false }
    expect(trimOutline(line, 0, 0.5, 0.75)).toEqual([
      [
        [75, 0],
        [100, 0],
      ],
    ])
  })
})
