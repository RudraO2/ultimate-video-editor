// Mesh primitives for 3D worlds. The table is AtomCut's primitive data (ids,
// labels, params, defaults and ranges; ported with permission). Every
// primitive is centred on its origin with Z up: flat ones (plane, grid,
// circle) lie in the XY plane, round ones (cylinder, cone, pyramid, capsule,
// tube, torus) turn about Z, and a `depth` or `height` runs along Z.
//
// A mesh stores only the params it was given; `primitiveParams` fills in the
// defaults, clamps to the ranges and rounds counts, so the stored values may
// stay sparse (and keys may go out of range without breaking the build).

export interface PrimitiveParam {
  key: string
  label: string
  default: number
  min: number
  max?: number
  /** A count (segments, sides): rounded to a whole number. */
  int?: boolean
  /** `px` for a length or radius, `deg` for an angle; none for a count. */
  unit?: 'px' | 'deg'
}

export interface Primitive {
  id: PrimitiveId
  label: string
  /** What it is for, for agents and the inspector's tooltip. */
  use: string
  params: readonly PrimitiveParam[]
}

const length = (key: string, label: string, value: number): PrimitiveParam => ({ key, label, default: value, min: 0.01, unit: 'px' })
const count = (key: string, label: string, value: number, min = 1, max = 256): PrimitiveParam => ({ key, label, default: value, min, max, int: true })

export const PRIMITIVE_IDS = ['cube', 'plane', 'grid', 'circle', 'uvSphere', 'icoSphere', 'cylinder', 'cone', 'pyramid', 'torus', 'capsule', 'tube', 'torusKnot'] as const
export type PrimitiveId = (typeof PRIMITIVE_IDS)[number]

export const PRIMITIVES: readonly Primitive[] = [
  {
    id: 'cube',
    label: 'Cube',
    use: 'A box; fillet rounds its edges',
    params: [length('sizeX', 'Size X', 200), length('sizeY', 'Size Y', 200), length('sizeZ', 'Size Z', 200), { key: 'fillet', label: 'Fillet', default: 0, min: 0, unit: 'px' }, count('filletSegments', 'Steps', 4, 1, 32), count('segments', 'Segments', 1, 1, 64)],
  },
  { id: 'plane', label: 'Plane', use: 'A flat rectangle lying in XY (a floor or a card)', params: [length('sizeX', 'Size X', 200), length('sizeY', 'Size Y', 200), count('segments', 'Segments', 1, 1, 256)] },
  { id: 'grid', label: 'Grid', use: 'A plane cut into a grid of faces', params: [length('sizeX', 'Size X', 200), length('sizeY', 'Size Y', 200), count('segments', 'Segments', 10, 1, 256)] },
  { id: 'circle', label: 'Circle', use: 'A flat disc lying in XY', params: [length('radius', 'Radius', 100), count('vertices', 'Vertices', 32, 3, 512)] },
  {
    id: 'uvSphere',
    label: 'UV Sphere',
    use: 'A sphere of rings and segments; arc below 180 opens it into a bowl from the bottom pole',
    params: [length('radius', 'Radius', 100), count('segments', 'Segments', 32, 3, 256), count('rings', 'Rings', 16, 2, 128), { key: 'arc', label: 'Arc', default: 180, min: 1, max: 180, unit: 'deg' }],
  },
  { id: 'icoSphere', label: 'Ico Sphere', use: 'An even, faceted sphere', params: [length('radius', 'Radius', 100), count('subdivisions', 'Detail', 2, 0, 6)] },
  { id: 'cylinder', label: 'Cylinder', use: 'A capped cylinder standing along Z', params: [length('radius', 'Radius', 100), length('depth', 'Depth', 200), count('vertices', 'Vertices', 32, 3, 256)] },
  {
    id: 'cone',
    label: 'Cone',
    use: 'A cone along Z; a top radius above 0 makes a frustum',
    params: [length('radius1', 'Base radius', 100), { key: 'radius2', label: 'Top radius', default: 0, min: 0, unit: 'px' }, length('depth', 'Depth', 200), count('vertices', 'Vertices', 32, 3, 256)],
  },
  { id: 'pyramid', label: 'Pyramid', use: 'A pyramid along Z; 4 sides give a square base of side `base`', params: [length('base', 'Base', 200), length('height', 'Height', 200), count('sides', 'Sides', 4, 3, 64)] },
  {
    id: 'torus',
    label: 'Torus',
    use: 'A ring (doughnut) around Z',
    params: [length('majorRadius', 'Major radius', 100), length('minorRadius', 'Minor radius', 25), count('majorSegments', 'Around', 48, 3, 256), count('minorSegments', 'Tube sides', 12, 3, 128)],
  },
  {
    id: 'capsule',
    label: 'Capsule',
    use: 'A pill along Z: a cylinder of `length` with round caps',
    params: [length('radius', 'Radius', 50), { key: 'length', label: 'Length', default: 100, min: 0, unit: 'px' }, count('segments', 'Segments', 32, 3, 256), count('rings', 'Cap rings', 8, 2, 64)],
  },
  {
    id: 'tube',
    label: 'Tube',
    use: 'A hollow pipe along Z with a wall between the two radii',
    params: [length('outerRadius', 'Outer radius', 100), length('innerRadius', 'Inner radius', 70), length('depth', 'Depth', 200), count('vertices', 'Vertices', 32, 3, 256)],
  },
  {
    id: 'torusKnot',
    label: 'Torus Knot',
    use: 'A tube tied in a (p, q) knot',
    params: [length('radius', 'Radius', 100), length('tube', 'Tube', 20), count('p', 'P', 2, 1, 20), count('q', 'Q', 3, 1, 20), count('segments', 'Segments', 128, 8, 1024), count('tubeSegments', 'Tube sides', 12, 3, 64)],
  },
]

/** Every param key of every primitive (the size formulas read them by name). */
type ParamKey =
  | 'sizeX' | 'sizeY' | 'sizeZ' | 'fillet' | 'filletSegments' | 'segments' | 'radius' | 'vertices' | 'rings' | 'arc' | 'subdivisions' | 'depth'
  | 'radius1' | 'radius2' | 'base' | 'height' | 'sides' | 'majorRadius' | 'minorRadius' | 'majorSegments' | 'minorSegments' | 'length'
  | 'outerRadius' | 'innerRadius' | 'tube' | 'p' | 'q' | 'tubeSegments'

export function findPrimitive(id: string): Primitive | undefined {
  return PRIMITIVES.find((p) => p.id === id)
}

/** Every param of a primitive, from its stored (possibly sparse) values: defaults filled in, clamped, counts rounded. */
export function primitiveParams(id: PrimitiveId, stored: Readonly<Record<string, number>> = {}): Record<string, number> {
  const primitive = findPrimitive(id)
  if (!primitive) throw new Error(`No primitive "${id}"`)
  const out: Record<string, number> = {}
  for (const param of primitive.params) {
    const given = stored[param.key]
    let value = typeof given === 'number' && Number.isFinite(given) ? given : param.default
    value = Math.max(param.min, value)
    if (param.max !== undefined) value = Math.min(param.max, value)
    out[param.key] = param.int ? Math.round(value) : value
  }
  return out
}

/** A stable cache key for a primitive's resolved params (`cube|200|200|200|0|4|1`). */
export function primitiveKey(id: PrimitiveId, stored: Readonly<Record<string, number>> = {}): string {
  const params = primitiveParams(id, stored)
  return [id, ...findPrimitive(id)!.params.map((p) => params[p.key])].join('|')
}

/** The size of a primitive's bounding box [x, y, z] in px, before the layer's scale. */
export function primitiveSize(id: PrimitiveId, stored: Readonly<Record<string, number>> = {}): [number, number, number] {
  const p = primitiveParams(id, stored) as Record<ParamKey, number>
  switch (id) {
    case 'cube':
      return [p.sizeX, p.sizeY, p.sizeZ]
    case 'plane':
    case 'grid':
      return [p.sizeX, p.sizeY, 0]
    case 'circle':
      return [2 * p.radius, 2 * p.radius, 0]
    case 'uvSphere': {
      // The bowl runs from the bottom pole (z = −radius) up to z = −cos(arc)·radius; the sphere's centre stays at the origin.
      const arc = (p.arc * Math.PI) / 180
      const wide = 2 * p.radius * (p.arc >= 90 ? 1 : Math.sin(arc))
      return [wide, wide, p.radius * (1 - Math.cos(arc))]
    }
    case 'icoSphere':
      return [2 * p.radius, 2 * p.radius, 2 * p.radius]
    case 'cylinder':
      return [2 * p.radius, 2 * p.radius, p.depth]
    case 'cone': {
      const r = Math.max(p.radius1, p.radius2)
      return [2 * r, 2 * r, p.depth]
    }
    case 'pyramid':
      return pyramidSize(p.base, p.height, p.sides)
    case 'torus':
      return [2 * (p.majorRadius + p.minorRadius), 2 * (p.majorRadius + p.minorRadius), 2 * p.minorRadius]
    case 'capsule':
      return [2 * p.radius, 2 * p.radius, p.length + 2 * p.radius]
    case 'tube':
      return [2 * p.outerRadius, 2 * p.outerRadius, p.depth]
    case 'torusKnot': {
      // The knot's centre line reaches 1.5 × radius out and 0.5 × radius up.
      const out = 1.5 * p.radius + p.tube
      return [2 * out, 2 * out, p.radius + 2 * p.tube]
    }
  }
}

function pyramidSize(base: number, height: number, sides: number): [number, number, number] {
  // The base polygon's corners sit on a circle of radius base/2·√2; four sides are turned 45° into a square of side `base`.
  if (sides === 4) return [base, base, height]
  const r = (base / 2) * Math.SQRT2
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2
    minX = Math.min(minX, r * Math.cos(a))
    maxX = Math.max(maxX, r * Math.cos(a))
    minY = Math.min(minY, r * Math.sin(a))
    maxY = Math.max(maxY, r * Math.sin(a))
  }
  return [maxX - minX, maxY - minY, height]
}
