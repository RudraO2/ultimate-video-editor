import { type Comp, CompSchema, type Layer, LayerSchema, PRIMITIVE_IDS, type PrimitiveId, primitiveParams, primitiveSize, TrackSchema } from '@uve/core'
import type { BufferGeometry } from 'three'
import { describe, expect, it } from 'vitest'
import type { Ctx2D } from '../content'
import type { SceneSource } from '../scene'
import { buildWorldFrame } from './frame'
import { acquireGeometry, cachedCount, clearGeometryCache, geometryKey, isOpenSurface, MAX_CACHED, primitiveGeometry, releaseGeometry, shadeGeometry } from './meshes'

// Geometry needs no WebGL, so these run in node.

const spec = (primitive: PrimitiveId, stored: Record<string, number> = {}) => ({ type: 'primitive' as const, primitive, params: primitiveParams(primitive, stored), shading: 'auto' as const, smoothAngle: 30 })

function boundsOf(geometry: BufferGeometry): [number, number, number] {
  geometry.computeBoundingBox()
  const box = geometry.boundingBox as NonNullable<BufferGeometry['boundingBox']>
  return [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z]
}

/** Triangles as [a, b, c] positions, indexed or not. */
function triangles(geometry: BufferGeometry): number[][][] {
  const pos = geometry.getAttribute('position')
  const index = geometry.getIndex()
  const count = index ? index.count : pos.count
  const at = (i: number) => {
    const v = index ? index.getX(i) : i
    return [pos.getX(v), pos.getY(v), pos.getZ(v)]
  }
  const out: number[][][] = []
  for (let i = 0; i < count; i += 3) out.push([at(i), at(i + 1), at(i + 2)])
  return out
}

/** The volume the triangles enclose (positive when they face outward). */
function signedVolume(geometry: BufferGeometry): number {
  let sum = 0
  for (const [a, b, c] of triangles(geometry) as [number[], number[], number[]][]) {
    sum += (a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) - a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!) + a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!)) / 6
  }
  return sum
}

describe('primitive geometry', () => {
  // Bounds match core's primitiveSize exactly, except where the shape is a polygon approximation of a curve.
  // Torus knot: its centre line is sampled, so the bound is within 5 %. Ico sphere at detail 0 is a 20-sided
  // solid whose farthest points are 15 % inside the radius.
  const cases: [string, PrimitiveId, Record<string, number>, number][] = [
    ...PRIMITIVE_IDS.filter((id) => id !== 'torusKnot').map((id): [string, PrimitiveId, Record<string, number>, number] => [`${id} defaults`, id, {}, 1e-3]),
    ['cube boxed', 'cube', { sizeX: 300, sizeY: 50, sizeZ: 120, segments: 3 }, 1e-3],
    ['cube filleted', 'cube', { sizeX: 300, sizeY: 80, sizeZ: 120, fillet: 20, filletSegments: 6, segments: 2 }, 1e-3],
    ['cube fillet over the half size', 'cube', { sizeX: 100, sizeY: 60, sizeZ: 80, fillet: 500 }, 1e-3],
    ['plane', 'plane', { sizeX: 400, sizeY: 90, segments: 4 }, 1e-3],
    ['uvSphere bowl 90', 'uvSphere', { arc: 90 }, 1e-3],
    ['uvSphere bowl 60', 'uvSphere', { arc: 60 }, 0.03],
    ['uvSphere bowl 120', 'uvSphere', { arc: 120, radius: 50 }, 1e-3],
    ['icoSphere detail 1', 'icoSphere', { subdivisions: 1 }, 1e-3],
    ['icoSphere detail 3', 'icoSphere', { subdivisions: 3, radius: 40 }, 1e-3],
    ['icoSphere detail 0', 'icoSphere', { subdivisions: 0 }, 0.16],
    ['cone frustum', 'cone', { radius1: 60, radius2: 90, depth: 50 }, 1e-3],
    ['cone point', 'cone', { radius1: 30, depth: 300 }, 1e-3],
    ['pyramid 3 sides', 'pyramid', { sides: 3, base: 120, height: 80 }, 1e-3],
    ['pyramid 4 sides', 'pyramid', { sides: 4, base: 120, height: 80 }, 1e-3],
    ['pyramid 6 sides', 'pyramid', { sides: 6, base: 120, height: 80 }, 1e-3],
    ['pyramid 5 sides', 'pyramid', { sides: 5, base: 120, height: 80 }, 1e-3],
    ['capsule bare', 'capsule', { length: 0, radius: 30 }, 1e-3],
    ['capsule long', 'capsule', { length: 250, radius: 30, rings: 5 }, 1e-3],
    ['torus thick', 'torus', { majorRadius: 80, minorRadius: 40 }, 1e-3],
    ['tube thin wall', 'tube', { outerRadius: 50, innerRadius: 48, depth: 30 }, 1e-3],
  ]
  for (const [name, id, stored, tolerance] of cases) {
    it(`${name}: the bounding box is primitiveSize`, () => {
      const geometry = primitiveGeometry(spec(id, stored))
      const size = boundsOf(geometry)
      const wanted = primitiveSize(id, stored)
      for (let a = 0; a < 3; a++) {
        const slack = tolerance >= 0.01 ? tolerance * Math.max(wanted[a] as number, 1) : tolerance
        expect(Math.abs((size[a] as number) - (wanted[a] as number))).toBeLessThanOrEqual(slack)
      }
      // Centred: every primitive is centred on its origin in x and y (a bowl and a flat one are not centred in z).
      geometry.computeBoundingBox()
      const box = geometry.boundingBox!
      // (An odd-sided polygon's corners are not symmetric about its centre.)
      const oddPolygon = id === 'pyramid' && (stored.sides ?? 4) % 2 === 1
      if (oddPolygon) return
      expect(Math.abs(box.max.x + box.min.x)).toBeLessThan(Math.max(1e-3, tolerance * wanted[0]!))
      expect(Math.abs(box.max.y + box.min.y)).toBeLessThan(Math.max(1e-3, tolerance * wanted[1]!))
    })
  }

  it('torus knot: fits inside the size box of core and nearly fills it along x', () => {
    // primitiveSize gives the circumscribed box of the knot's centre line (1.5 × radius out on both axes). The (p, q) curve
    // reaches 1.5 × radius out along x only (at u = 0); along y it stays well inside, and the knot is not centred on the origin.
    for (const stored of [{}, { p: 3, q: 5, radius: 60, tube: 8 }, { p: 1, q: 2 }] as Record<string, number>[]) {
      const size = boundsOf(primitiveGeometry(spec('torusKnot', stored)))
      const wanted = primitiveSize('torusKnot', stored)
      expect(size[0]).toBeLessThanOrEqual(wanted[0] + 1e-3)
      expect(size[1]).toBeLessThanOrEqual(wanted[1] + 1e-3)
      expect(size[2]).toBeLessThanOrEqual(wanted[2] * 1.2)
      expect(size[1]).toBeGreaterThan(wanted[1] * 0.5)
    }
    const size = boundsOf(primitiveGeometry(spec('torusKnot')))
    // The (2, 3) knot is not symmetric: it reaches 1.5 × radius on one side of x and about 1 × radius on the other, so its x extent is about 10 % under the box.
    expect(Math.abs(size[0] - primitiveSize('torusKnot')[0])).toBeLessThan(0.12 * primitiveSize('torusKnot')[0])
  })

  it('every primitive has positions and UVs inside range', () => {
    for (const id of PRIMITIVE_IDS) {
      const geometry = primitiveGeometry(spec(id))
      expect(geometry.getAttribute('position').count, id).toBeGreaterThan(0)
      const uv = geometry.getAttribute('uv')
      expect(uv.count, id).toBe(geometry.getAttribute('position').count)
      for (let i = 0; i < uv.count; i++) {
        expect(Number.isFinite(uv.getX(i)) && Number.isFinite(uv.getY(i)), id).toBe(true)
      }
    }
  })

  it('closed solids enclose a positive volume (faces point outward)', () => {
    const solids: [PrimitiveId, Record<string, number>][] = [
      ['cube', {}],
      ['cube', { sizeX: 120, sizeY: 80, sizeZ: 60, fillet: 15, filletSegments: 5 }],
      ['cube', { fillet: 100 }],
      ['icoSphere', {}],
      ['uvSphere', {}],
      ['cylinder', {}],
      ['cone', {}],
      ['cone', { radius2: 50 }],
      ['pyramid', {}],
      ['pyramid', { sides: 3 }],
      ['pyramid', { sides: 7 }],
      ['torus', {}],
      ['capsule', {}],
      ['tube', {}],
      ['torusKnot', {}],
    ]
    for (const [id, stored] of solids) {
      const volume = signedVolume(primitiveGeometry(spec(id, stored)))
      expect(volume, `${id} ${JSON.stringify(stored)}`).toBeGreaterThan(0)
    }
    // Known volumes: a plain box, a cylinder (32-gon), a square pyramid.
    expect(signedVolume(primitiveGeometry(spec('cube', { sizeX: 100, sizeY: 60, sizeZ: 40 })))).toBeCloseTo(100 * 60 * 40, 1)
    expect(signedVolume(primitiveGeometry(spec('pyramid', { base: 90, height: 60, sides: 4 })))).toBeCloseTo((90 * 90 * 60) / 3, 1)
    expect(signedVolume(primitiveGeometry(spec('cylinder', { radius: 50, depth: 80, vertices: 32 })))).toBeCloseTo(0.5 * 32 * Math.sin((2 * Math.PI) / 32) * 50 * 50 * 80, -1)
  })

  it('shaded normals of convex solids point away from the centre', () => {
    const convex: [PrimitiveId, Record<string, number>][] = [
      ['cube', {}],
      ['cube', { fillet: 30 }],
      ['icoSphere', {}],
      ['uvSphere', {}],
      ['cylinder', {}],
      ['cone', {}],
      ['pyramid', {}],
      ['capsule', {}],
    ]
    for (const [id, stored] of convex) {
      for (const shading of ['flat', 'smooth', 'auto'] as const) {
        const shaded = shadeGeometry(primitiveGeometry(spec(id, stored)), shading, 30)
        const pos = shaded.getAttribute('position')
        const normal = shaded.getAttribute('normal')
        expect(normal.count).toBe(pos.count)
        for (let i = 0; i < pos.count; i++) {
          const dot = normal.getX(i) * pos.getX(i) + normal.getY(i) * pos.getY(i) + normal.getZ(i) * pos.getZ(i)
          expect(dot, `${id} ${shading} vertex ${i}`).toBeGreaterThanOrEqual(-1e-6)
        }
      }
    }
  })

  it('rounds the corners of a filleted cube and keeps its size', () => {
    const h = 100
    const f = 30
    const geometry = primitiveGeometry(spec('cube', { sizeX: 2 * h, sizeY: 2 * h, sizeZ: 2 * h, fillet: f }))
    expect(boundsOf(geometry)).toEqual([2 * h, 2 * h, 2 * h].map((v) => expect.closeTo(v, 3)))
    const pos = geometry.getAttribute('position')
    let farthest = 0
    for (let i = 0; i < pos.count; i++) farthest = Math.max(farthest, Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i)))
    expect(farthest).toBeLessThanOrEqual(Math.sqrt(3) * h - f * (Math.sqrt(3) - 1) + 1e-4)
    expect(farthest).toBeGreaterThan(h)
    // A sharp cube reaches its corner.
    const sharp = primitiveGeometry(spec('cube', { sizeX: 2 * h, sizeY: 2 * h, sizeZ: 2 * h }))
    const sp = sharp.getAttribute('position')
    let sharpFar = 0
    for (let i = 0; i < sp.count; i++) sharpFar = Math.max(sharpFar, Math.hypot(sp.getX(i), sp.getY(i), sp.getZ(i)))
    expect(sharpFar).toBeCloseTo(Math.sqrt(3) * h, 5)
  })

  it('a four-sided pyramid is a square of the base size aligned with X and Y', () => {
    const geometry = primitiveGeometry(spec('pyramid', { base: 140, height: 90, sides: 4 }))
    const [x, y, z] = boundsOf(geometry)
    expect(x).toBeCloseTo(140, 6)
    expect(y).toBeCloseTo(140, 6)
    expect(z).toBeCloseTo(90, 6)
    geometry.computeBoundingBox()
    expect(geometry.boundingBox!.min.z).toBeCloseTo(-45, 6)
    expect(geometry.boundingBox!.max.z).toBeCloseTo(45, 6)
  })

  it('flat and smooth shading give a cube different normals', () => {
    const cube = primitiveGeometry(spec('cube'))
    const flat = shadeGeometry(cube, 'flat', 30)
    const smooth = shadeGeometry(cube, 'smooth', 30)
    const auto = shadeGeometry(cube, 'auto', 30)
    const corner = (g: BufferGeometry) => {
      const n = g.getAttribute('normal')
      const p = g.getAttribute('position')
      for (let i = 0; i < p.count; i++) if (p.getX(i) > 99 && p.getY(i) > 99 && p.getZ(i) > 99) return [n.getX(i), n.getY(i), n.getZ(i)]
      throw new Error('no corner')
    }
    // Flat: along one axis. Smooth: toward the corner. Auto at 30° keeps the 90° edges crisp.
    const f = corner(flat)
    expect(Math.max(...f.map(Math.abs))).toBeCloseTo(1, 6)
    for (const v of corner(smooth)) expect(Math.abs(v)).toBeCloseTo(1 / Math.sqrt(3), 5)
    expect(Math.max(...corner(auto).map(Math.abs))).toBeCloseTo(1, 6)
    // The built geometry is left as it was (no normals on it).
    expect(cube.getAttribute('normal')).toBeUndefined()
    // A wide angle smooths what a narrow one keeps.
    const wide = shadeGeometry(cube, 'auto', 120)
    for (const v of corner(wide)) expect(Math.abs(v)).toBeCloseTo(1 / Math.sqrt(3), 5)
  })

  it('flat planes, circles and bowls are open surfaces', () => {
    expect(isOpenSurface(spec('plane'))).toBe(true)
    expect(isOpenSurface(spec('circle'))).toBe(true)
    expect(isOpenSurface(spec('uvSphere', { arc: 90 }))).toBe(true)
    expect(isOpenSurface(spec('uvSphere'))).toBe(false)
    expect(isOpenSurface(spec('cube'))).toBe(false)
  })
})

describe('the geometry cache', () => {
  it('returns the same geometry for the same key and a new one when it changes', () => {
    clearGeometryCache()
    const a = acquireGeometry(spec('torus'))
    const b = acquireGeometry(spec('torus'))
    expect(b.geometry).toBe(a.geometry)
    expect(b.key).toBe(a.key)
    const flat = acquireGeometry({ ...spec('torus'), shading: 'flat' })
    expect(flat.geometry).not.toBe(a.geometry)
    // Auto shading's angle only counts for auto.
    expect(geometryKey({ ...spec('torus'), shading: 'flat', smoothAngle: 5 })).toBe(geometryKey({ ...spec('torus'), shading: 'flat', smoothAngle: 90 }))
    expect(geometryKey({ ...spec('torus'), smoothAngle: 5 })).not.toBe(geometryKey({ ...spec('torus'), smoothAngle: 90 }))
    expect(a.geometry.getAttribute('normal')).toBeDefined()
    for (const g of [a, b, flat]) releaseGeometry(g.key)
  })

  it('keeps at most MAX_CACHED unused geometries and never drops one in use', () => {
    clearGeometryCache()
    const held = acquireGeometry(spec('cylinder', { radius: 11 }))
    for (let i = 0; i < MAX_CACHED + 20; i++) {
      const g = acquireGeometry(spec('cylinder', { radius: 20 + i }))
      releaseGeometry(g.key)
    }
    expect(cachedCount()).toBeLessThanOrEqual(MAX_CACHED)
    // The held one survived and is still the same object.
    expect(acquireGeometry(spec('cylinder', { radius: 11 })).geometry).toBe(held.geometry)
    // Held ones may exceed the cap, but once released they are dropped.
    const many = Array.from({ length: MAX_CACHED + 5 }, (_, i) => acquireGeometry(spec('circle', { radius: 5 + i })))
    expect(cachedCount()).toBeGreaterThan(MAX_CACHED)
    for (const g of many) releaseGeometry(g.key)
    releaseGeometry(held.key)
    releaseGeometry(held.key)
    expect(cachedCount()).toBeLessThanOrEqual(MAX_CACHED)
  })
})

// ---------------------------------------------------------------------------
// The frame lists meshes
// ---------------------------------------------------------------------------

const measure = { font: '', letterSpacing: '', textAlign: 'left', textBaseline: 'alphabetic', measureText: (text: string) => ({ width: text.length * 10 }) } as unknown as Ctx2D
const source: SceneSource = { measure, media: [] }

const meshLayer = (id: string, extra: Record<string, unknown> = {}): Layer =>
  LayerSchema.parse({ id, name: id, kind: 'mesh', startMs: 0, durationMs: 4000, geometry: { type: 'primitive', primitive: 'cube', params: {} }, ...extra }) as Layer

const lane = (id: string, layers: Layer[], extra: Record<string, unknown> = {}) => TrackSchema.parse({ id, layers, ...extra })

const world = (tracks: ReturnType<typeof lane>[]): Comp => CompSchema.parse({ id: 'w', name: 'World', width: 1920, height: 1080, fps: 30, durationMs: 4000, world: {}, tracks }) as Comp

describe('buildWorldFrame meshes', () => {
  const keys = (path: string, from: number, to: number) => ({ [path]: [{ t: 0, v: from, ease: 'linear' }, { t: 2000, v: to, ease: 'linear' }] })

  it('lists a mesh with its params, colour and place, sampled at the time', () => {
    const layer = meshLayer('m', {
      transform: { x: 50, y: -20, z: 120, scaleX: 2, rotation: 30 },
      fills: [{ id: 'f1', type: 'solid', color: '#336699' }],
      animations: { ...keys('geometry.sizeX', 100, 300), ...keys('transform.opacity', 0, 1) },
      geometry: { type: 'primitive', primitive: 'cube', params: { sizeY: 80 } },
      shading: 'flat',
      castShadow: false,
    })
    const comp = world([lane('t', [layer])])
    const at0 = buildWorldFrame(comp, source, 0)
    const at1 = buildWorldFrame(comp, source, 1000)
    expect(at0.meshes).toHaveLength(1)
    const [m0, m1] = [at0.meshes[0]!, at1.meshes[0]!]
    if (m0.geometry.type !== 'primitive' || m1.geometry.type !== 'primitive') throw new Error('a primitive')
    expect(m0.id).toBe('m')
    expect(m0.geometry.primitive).toBe('cube')
    expect(m0.geometry.params.sizeX).toBeCloseTo(100, 6)
    expect(m1.geometry.params.sizeX).toBeCloseTo(200, 6)
    expect(m1.geometry.params.sizeY).toBe(80)
    expect(m1.geometry.params.sizeZ).toBe(200)
    expect(m1.geometry.shading).toBe('flat')
    expect(m0.opacity).toBeCloseTo(0, 6)
    expect(m1.opacity).toBeCloseTo(0.5, 6)
    expect(m0.color).toBe('#336699')
    expect(m0.castShadow).toBe(false)
    expect(m0.receiveShadow).toBe(true)
    expect(m0.material).toBeUndefined()
    expect(m1.matrix[12]).toBeCloseTo(50, 6)
    expect(m1.matrix[13]).toBeCloseTo(-20, 6)
    expect(m1.matrix[14]).toBeCloseTo(120, 6)
    // Scale X is the first column's length.
    expect(Math.hypot(m1.matrix[0]!, m1.matrix[1]!, m1.matrix[2]!)).toBeCloseTo(2, 6)
    expect(at0.planes).toHaveLength(0)
  })

  it('samples a keyed fill and the material', () => {
    const layer = meshLayer('m', {
      fills: [{ id: 'f1', type: 'solid', color: '#000000' }],
      material: { roughness: 0.2 },
      animations: keys('material.roughness', 0, 1),
    })
    const frame = buildWorldFrame(world([lane('t', [layer])]), source, 1000)
    expect(frame.meshes[0]!.material?.roughness).toBeCloseTo(0.5, 6)
  })

  it('skips hidden lanes, disabled layers and layers outside their span, and applies group opacity', () => {
    const group = LayerSchema.parse({ id: 'g', name: 'g', kind: 'group', startMs: 0, durationMs: 4000, transform: { opacity: 0.5 } }) as Layer
    const comp = world([
      lane('t0', [meshLayer('shown')]),
      lane('t1', [meshLayer('hiddenLane')], { hidden: true }),
      lane('t2', [meshLayer('off', { enabled: false })]),
      lane('t3', [meshLayer('later', { startMs: 3000, durationMs: 1000 })]),
      lane('tg', [group]),
      lane('t4', [meshLayer('child')], { groupId: 'g' }),
    ])
    const frame = buildWorldFrame(comp, source, 500)
    expect(frame.meshes.map((m) => m.id).sort()).toEqual(['child', 'shown'])
    expect(frame.meshes.find((m) => m.id === 'child')!.opacity).toBeCloseTo(0.5, 6)
    // The front lane is the front-most mesh: the highest order.
    expect(frame.meshes[0]!.order).toBeGreaterThan(frame.meshes[1]!.order)
    expect(buildWorldFrame(comp, source, 3500).meshes.map((m) => m.id)).toContain('later')
  })
})
