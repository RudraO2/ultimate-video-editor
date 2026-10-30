import { type MeshGeometry, type PrimitiveGeometry, type PrimitiveId, primitiveKey } from '@uve/core'
import {
  BufferGeometry,
  CapsuleGeometry,
  CircleGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  IcosahedronGeometry,
  PlaneGeometry,
  SphereGeometry,
  TorusGeometry,
  TorusKnotGeometry,
} from 'three'
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js'

// The geometry of mesh layers (the 13 primitives of core's primitives.ts), in
// the world's own space: Z up, 1 unit = 1 px (the stage's root scales it by
// 0.01), centred on the origin. Flat primitives lie in XY, round ones stand
// along Z. three's built-ins are used where they fit (turned from Y up to Z
// up); the cube, pyramid and tube are built here.
//
// Every geometry faces outward and has UVs. `shadeGeometry` then gives it
// normals: crisp per face, smooth, or smoothed below an angle.
//
// Geometries are cached by what they are made of (`geometryKey`), so a mesh
// that stands still keeps its buffers, and many meshes of one kind share one.
// A view takes a geometry with `acquireGeometry` and gives it back with
// `releaseGeometry`; only unused ones are dropped (least recently used first)
// when the cache holds more than `MAX_CACHED`.

const DEG = Math.PI / 180

/** Flat shading's crease angle: toCreasedNormals skips a face whose own normal does not beat cos(angle), so 0 would leave a face with no normal. */
const FLAT_ANGLE = 1e-4

/** A geometry under construction: indexed triangles with UVs. */
class Mesher {
  position: number[] = []
  uv: number[] = []
  index: number[] = []

  vertex(x: number, y: number, z: number, u: number, v: number): number {
    this.position.push(x, y, z)
    this.uv.push(u, v)
    return this.position.length / 3 - 1
  }

  tri(a: number, b: number, c: number): void {
    this.index.push(a, b, c)
  }

  build(): BufferGeometry {
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute(this.position, 3))
    geometry.setAttribute('uv', new Float32BufferAttribute(this.uv, 2))
    geometry.setIndex(this.index)
    return geometry
  }
}

/** A cylinder-like three geometry (axis Y) turned to stand along Z. */
function alongZ(geometry: BufferGeometry): BufferGeometry {
  geometry.rotateX(Math.PI / 2)
  return geometry
}

// ---------------------------------------------------------------------------
// Cube
// ---------------------------------------------------------------------------

/**
 * The grid lines along one axis of a face: `segments` even steps across the
 * flat middle and, with a fillet, `steps` more on each side whose spacing makes
 * the rounded edge even (each strip covers 45° of the 90° turn, at
 * f·tan(k/steps·45°) from the strip's inner end).
 */
function axisCoords(half: number, fillet: number, steps: number, segments: number): number[] {
  const out: number[] = []
  const push = (v: number) => {
    if (out.length === 0 || v - (out[out.length - 1] as number) > 1e-9) out.push(v)
  }
  if (fillet <= 1e-9) {
    for (let i = 0; i <= segments; i++) push(-half + (2 * half * i) / segments)
    return out
  }
  const inner = half - fillet
  const tan = (k: number) => Math.tan(((k / steps) * Math.PI) / 4)
  push(-half)
  for (let k = steps - 1; k >= 1; k--) push(-inner - fillet * tan(k))
  for (let i = 0; i <= segments; i++) push(-inner + (2 * inner * i) / segments)
  for (let k = 1; k <= steps - 1; k++) push(inner + fillet * tan(k))
  push(half)
  return out
}

function cubeGeometry(p: Record<string, number>): BufferGeometry {
  const half = [p.sizeX! / 2, p.sizeY! / 2, p.sizeZ! / 2]
  const fillet = Math.min(p.fillet!, ...half)
  const steps = p.filletSegments!
  const segments = p.segments!
  const coords = half.map((h) => axisCoords(h, fillet, steps, segments))
  const inner = half.map((h) => h - fillet)
  const mesher = new Mesher()
  for (let w = 0; w < 3; w++) {
    const u = (w + 1) % 3
    const v = (w + 2) % 3
    for (const sign of [1, -1]) {
      const cu = coords[u] as number[]
      const cv = coords[v] as number[]
      const at = new Map<number, number>()
      const vertexAt = (i: number, j: number): number => {
        const key = i * cv.length + j
        const known = at.get(key)
        if (known !== undefined) return known
        const point = [0, 0, 0]
        point[w] = sign * (half[w] as number)
        point[u] = cu[i] as number
        point[v] = cv[j] as number
        const texU = ((cu[i] as number) + (half[u] as number)) / (2 * (half[u] as number))
        const texV = ((cv[j] as number) + (half[v] as number)) / (2 * (half[v] as number))
        if (fillet > 1e-9) {
          // Pull the point onto the rounded box: the nearest point of the inner box plus `fillet` outward.
          const clamped = point.map((x, a) => Math.max(-(inner[a] as number), Math.min(inner[a] as number, x)))
          const d = point.map((x, a) => x - (clamped[a] as number))
          const length = Math.hypot(d[0] as number, d[1] as number, d[2] as number) || 1
          for (let a = 0; a < 3; a++) point[a] = (clamped[a] as number) + ((d[a] as number) / length) * fillet
        }
        const id = mesher.vertex(point[0] as number, point[1] as number, point[2] as number, sign > 0 ? texU : 1 - texU, texV)
        at.set(key, id)
        return id
      }
      for (let i = 0; i < cu.length - 1; i++) {
        for (let j = 0; j < cv.length - 1; j++) {
          const a = vertexAt(i, j)
          const b = vertexAt(i + 1, j)
          const c = vertexAt(i, j + 1)
          const d = vertexAt(i + 1, j + 1)
          // e_u × e_v = e_w, so a, b, c turns counter-clockwise seen from +w.
          if (sign > 0) {
            mesher.tri(a, b, c)
            mesher.tri(b, d, c)
          } else {
            mesher.tri(a, c, b)
            mesher.tri(b, c, d)
          }
        }
      }
    }
  }
  return mesher.build()
}

// ---------------------------------------------------------------------------
// Pyramid and tube
// ---------------------------------------------------------------------------

function pyramidGeometry(p: Record<string, number>): BufferGeometry {
  const sides = p.sides!
  const height = p.height!
  const radius = (p.base! / 2) * Math.SQRT2
  // Four sides are turned 45° so the base is a square aligned with X and Y.
  const turn = sides === 4 ? Math.PI / 4 : 0
  const corner = (i: number): [number, number] => {
    const a = turn + (i / sides) * Math.PI * 2
    return [radius * Math.cos(a), radius * Math.sin(a)]
  }
  const mesher = new Mesher()
  const bottom = -height / 2
  for (let i = 0; i < sides; i++) {
    const [x0, y0] = corner(i)
    const [x1, y1] = corner(i + 1)
    const a = mesher.vertex(x0, y0, bottom, i / sides, 0)
    const b = mesher.vertex(x1, y1, bottom, (i + 1) / sides, 0)
    const apex = mesher.vertex(0, 0, height / 2, (i + 0.5) / sides, 1)
    mesher.tri(a, b, apex)
  }
  const centre = mesher.vertex(0, 0, bottom, 0.5, 0.5)
  for (let i = 0; i < sides; i++) {
    const [x0, y0] = corner(i)
    const [x1, y1] = corner(i + 1)
    const a = mesher.vertex(x0, y0, bottom, 0.5 + x0 / (2 * radius), 0.5 + y0 / (2 * radius))
    const b = mesher.vertex(x1, y1, bottom, 0.5 + x1 / (2 * radius), 0.5 + y1 / (2 * radius))
    mesher.tri(centre, b, a)
  }
  return mesher.build()
}

function tubeGeometry(p: Record<string, number>): BufferGeometry {
  const outer = p.outerRadius!
  // An inner radius at or past the outer one would turn the wall inside out: keep a sliver of wall.
  const inner = Math.min(p.innerRadius!, outer * 0.999)
  const n = p.vertices!
  const top = p.depth! / 2
  const mesher = new Mesher()
  const ring = (radius: number, z: number, v: number): number[] => {
    const ids: number[] = []
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2
      ids.push(mesher.vertex(radius * Math.cos(a), radius * Math.sin(a), z, i / n, v))
    }
    return ids
  }
  const quads = (a: number[], b: number[], flip: boolean) => {
    // The strip between two rings: `a` then `b` along +Z, or the annulus from outer to inner; counter-clockwise seen from outside when not flipped.
    for (let i = 0; i < n; i++) {
      const [p0, p1, q0, q1] = [a[i] as number, a[i + 1] as number, b[i] as number, b[i + 1] as number]
      if (flip) {
        mesher.tri(p0, q0, p1)
        mesher.tri(p1, q0, q1)
      } else {
        mesher.tri(p0, p1, q0)
        mesher.tri(p1, q1, q0)
      }
    }
  }
  quads(ring(outer, -top, 0), ring(outer, top, 1), false)
  quads(ring(inner, -top, 0), ring(inner, top, 1), true)
  // Top annulus faces +Z (outer ring to inner ring), the bottom faces -Z.
  quads(ring(outer, top, 1), ring(inner, top, 0), false)
  quads(ring(outer, -top, 1), ring(inner, -top, 0), true)
  return mesher.build()
}

// ---------------------------------------------------------------------------
// The primitives
// ---------------------------------------------------------------------------

/**
 * The geometry of a primitive with its params resolved (`meshGeometryAt`), in
 * Z-up px, centred on the origin, facing outward, with UVs. It has no
 * `normal` yet (see `shadeGeometry`). Round shapes are approximations by
 * `vertices`/`segments`: a polygon's bounds are exact at its corners only.
 */
export function primitiveGeometry(geometry: Pick<PrimitiveGeometry, 'primitive' | 'params'>): BufferGeometry {
  const p = geometry.params
  switch (geometry.primitive) {
    case 'cube':
      return cubeGeometry(p)
    case 'plane':
    case 'grid':
      return new PlaneGeometry(p.sizeX, p.sizeY, p.segments, p.segments)
    case 'circle':
      return new CircleGeometry(p.radius, p.vertices)
    case 'uvSphere': {
      // Poles on Z; an arc under 180 keeps the bottom cap, a bowl rising from z = -radius.
      const arc = (p.arc! * Math.PI) / 180
      const sphere = new SphereGeometry(p.radius, p.segments, p.rings, 0, Math.PI * 2, Math.PI - arc, arc)
      sphere.rotateX(Math.PI / 2)
      return sphere
    }
    case 'icoSphere':
      // Our detail is the number of recursive 4-way splits; three's is the cuts per edge.
      return new IcosahedronGeometry(p.radius, 2 ** p.subdivisions! - 1)
    case 'cylinder':
      return alongZ(new CylinderGeometry(p.radius, p.radius, p.depth, p.vertices))
    case 'cone':
      return alongZ(new CylinderGeometry(p.radius2, p.radius1, p.depth, p.vertices))
    case 'pyramid':
      return pyramidGeometry(p)
    case 'torus':
      return new TorusGeometry(p.majorRadius, p.minorRadius, p.minorSegments, p.majorSegments)
    case 'capsule':
      return alongZ(new CapsuleGeometry(p.radius, p.length, p.rings, p.segments))
    case 'tube':
      return tubeGeometry(p)
    case 'torusKnot':
      return new TorusKnotGeometry(p.radius, p.tube, p.segments, p.tubeSegments, p.p, p.q)
  }
}

/** Whether a mesh is an open surface (seen from both sides): a flat primitive or a bowl; a model is not (its materials say). */
export function isOpenSurface(geometry: MeshGeometry): boolean {
  if (geometry.type !== 'primitive') return false
  const { primitive, params } = geometry
  return primitive === 'plane' || primitive === 'grid' || primitive === 'circle' || (primitive === 'uvSphere' && (params.arc ?? 180) < 180 - 1e-9)
}

/**
 * Gives a geometry normals: flat (each face its own), smooth (blended across
 * every shared vertex) or auto (blended where the faces meet at less than
 * `smoothAngle` degrees). The result is not indexed; the input is left alone.
 */
export function shadeGeometry(source: BufferGeometry, shading: MeshGeometry['shading'], smoothAngle: number): BufferGeometry {
  const angle = shading === 'flat' ? FLAT_ANGLE : shading === 'smooth' ? Math.PI : Math.min(180, Math.max(0, smoothAngle)) * DEG
  // toCreasedNormals works in place on a geometry that is not indexed: shade a copy so the source stays as built.
  return toCreasedNormals(source.index ? source : source.clone(), angle)
}

// ---------------------------------------------------------------------------
// The cache
// ---------------------------------------------------------------------------

/** The most geometries kept; unused ones past it are dropped, least recently used first. */
export const MAX_CACHED = 64

interface Cached {
  geometry: BufferGeometry
  refs: number
  used: number
}

const cache = new Map<string, Cached>()
let clock = 0

/** What a built geometry depends on: the primitive's resolved params and how it is shaded (the angle only counts for auto). */
export function geometryKey(geometry: PrimitiveGeometry): string {
  const angle = geometry.shading === 'auto' ? Math.round(geometry.smoothAngle * 100) / 100 : 0
  return `${primitiveKey(geometry.primitive as PrimitiveId, geometry.params)}|${geometry.shading}|${angle}`
}

function evict(): void {
  while (cache.size > MAX_CACHED) {
    let oldest: [string, Cached] | null = null
    for (const entry of cache) if (entry[1].refs === 0 && (!oldest || entry[1].used < oldest[1].used)) oldest = entry
    if (!oldest) return
    oldest[1].geometry.dispose()
    cache.delete(oldest[0])
  }
}

/** The shaded geometry of a mesh, built once per key and shared; each call must be matched by `releaseGeometry(key)`. */
export function acquireGeometry(geometry: PrimitiveGeometry): { key: string; geometry: BufferGeometry } {
  const key = geometryKey(geometry)
  let entry = cache.get(key)
  if (!entry) {
    const built = primitiveGeometry(geometry)
    const shaded = shadeGeometry(built, geometry.shading, geometry.smoothAngle)
    if (shaded !== built) built.dispose()
    entry = { geometry: shaded, refs: 0, used: 0 }
    cache.set(key, entry)
  }
  entry.refs++
  entry.used = ++clock
  evict()
  return { key, geometry: entry.geometry }
}

/** Gives a geometry back; it stays cached (and may be dropped later) once nothing holds it. */
export function releaseGeometry(key: string): void {
  const entry = cache.get(key)
  if (!entry) return
  entry.refs = Math.max(0, entry.refs - 1)
  evict()
}

/** How many geometries are cached (for tests). */
export const cachedCount = (): number => cache.size

/** Drops every geometry that nothing holds (for tests and a lost context). */
export function clearGeometryCache(): void {
  for (const [key, entry] of cache) {
    if (entry.refs > 0) continue
    entry.geometry.dispose()
    cache.delete(key)
  }
}
