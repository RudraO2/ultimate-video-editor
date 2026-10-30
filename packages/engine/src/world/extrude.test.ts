import { describe, expect, it } from 'vitest'
import { acquireExtrusion, releaseExtrusion, simplify, traceAlpha } from './extrude'
import type { WorldPlane } from './frame'

describe('extrusion contours', () => {
  it('uses the 128 alpha threshold and preserves a hole', () => {
    const pixels = new Uint8ClampedArray(5 * 5 * 4)
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) pixels[(y * 5 + x) * 4 + 3] = x === 2 && y === 2 ? 127 : 128
    const rings = traceAlpha(pixels, 5, 5)
    expect(rings).toHaveLength(2)
    expect(rings.map(r => r.length)).toEqual([4, 4])
  })
  it('puts the bevelled side behind the picture and reuses its geometry', () => {
    const plane = { layer: { kind: 'shape' }, local: { left: -50, top: -25, width: 100, height: 50 }, node: { kind: 'leaf', layer: { kind: 'shape', shape: { type: 'rect', width: 100, height: 50, cornerRadius: 0, pointCount: 4, innerRatio: 1 } }, resolved: {} } } as unknown as WorldPlane
    const spec = { depth: 40, bevel: 4, bevelSegments: 3, sideColor: null, fit: 'outline' as const }
    const rect = plane.local
    const a = acquireExtrusion('test-outline', 'test-extrusion', plane, null as unknown as OffscreenCanvas, rect, spec)
    const b = acquireExtrusion('test-outline', 'test-extrusion', plane, null as unknown as OffscreenCanvas, rect, spec)
    expect(a).toBe(b)
    a.computeBoundingBox()
    expect(a.boundingBox!.min.z).toBeCloseTo(0)
    expect(a.boundingBox!.max.z).toBeCloseTo(48)
    const normals = a.getAttribute('normal')
    expect(Array.from({ length: normals.count }, (_, i) => normals.getZ(i)).some(z => z > 0.99)).toBe(true)
    releaseExtrusion('test-extrusion')
    releaseExtrusion('test-extrusion')
  })
  it('keeps the front of a box slab and drops it from an outline solid', () => {
    const plane = { layer: { kind: 'text' }, local: { left: -50, top: -25, width: 100, height: 50 }, node: { kind: 'leaf', layer: { kind: 'text' }, resolved: {} } } as unknown as WorldPlane
    const fronts = (fit: 'outline' | 'box') => {
      const spec = { depth: 20, bevel: 0, bevelSegments: 3, sideColor: null, fit }
      const geometry = acquireExtrusion('slab-' + fit, 'slab-' + fit + '|20', fit === 'box' ? plane : { ...plane, node: { kind: 'leaf', layer: { kind: 'shape', shape: { type: 'rect', width: 100, height: 50, cornerRadius: 0, pointCount: 4, innerRatio: 1 } }, resolved: {} } } as unknown as WorldPlane, null as unknown as OffscreenCanvas, plane.local, spec)
      const normals = geometry.getAttribute('normal')
      releaseExtrusion('slab-' + fit + '|20')
      return Array.from({ length: normals.count }, (_, i) => normals.getZ(i)).filter(z => z < -0.99).length
    }
    expect(fronts('box')).toBeGreaterThan(0)
    expect(fronts('outline')).toBe(0)
  })
  it('simplifies collinear points while retaining corners', () => {
    expect(simplify([[0, 0], [1, 0], [2, 0], [2, 1]], 0.1)).toEqual([[0, 0], [2, 0], [2, 1]])
  })
})
