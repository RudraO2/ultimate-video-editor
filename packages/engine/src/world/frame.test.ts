import {
  type Comp,
  CompSchema,
  flatEquivalent,
  type Layer,
  layerPose,
  LayerSchema,
  mat4Multiply,
  PICTURE_AXES,
  TrackSchema,
  type Transform,
  TransformSchema,
  transformAt,
  worldObjects,
} from '@uve/core'
import { describe, expect, it } from 'vitest'
import type { Ctx2D } from '../content'
import { layerMatrix, resolveLayer } from '../evaluate'
import type { SceneSource } from '../scene'
import { buildWorldFrame, MAX_TEXTURE, pickPlane, planeCorners, standAlone, textureSpec } from './frame'

const W = 1920
const H = 1080
const measure = { font: '', letterSpacing: '', textAlign: 'left', textBaseline: 'alphabetic', measureText: (text: string) => ({ width: text.length * 10 }) } as unknown as Ctx2D
const source: SceneSource = { measure, media: [] }

/** A small deterministic random source, so failures repeat. */
function rng(seed: number) {
  let s = seed
  return (lo: number, hi: number) => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return lo + (s / 4294967296) * (hi - lo)
  }
}

const randomTransform = (random: ReturnType<typeof rng>, extra: Partial<Transform> = {}): Transform =>
  TransformSchema.parse({
    x: random(-600, 600),
    y: random(-600, 600),
    z: random(-400, 400),
    rotation: random(-90, 90),
    rotationX: random(-70, 70),
    rotationY: random(-70, 70),
    scaleX: random(0.4, 2.5),
    scaleY: random(0.4, 2.5),
    anchorX: random(-0.2, 1.2),
    anchorY: random(-0.2, 1.2),
    ...extra,
  })

const shape = (id: string, transform: Transform, extra: Record<string, unknown> = {}) =>
  LayerSchema.parse({ id, name: id, kind: 'shape', startMs: 0, durationMs: 4000, transform, shape: { type: 'rect', width: 240, height: 120 }, ...extra }) as Layer

const lane = (id: string, layers: Layer[], extra: Record<string, unknown> = {}) => TrackSchema.parse({ id, layers, ...extra })

const world = (tracks: ReturnType<typeof lane>[]): Comp =>
  CompSchema.parse({ id: 'w', name: 'World', width: W, height: H, fps: 30, durationMs: 4000, world: {}, tracks }) as Comp

const boxOf = (l: Layer) => (l.kind === 'shape' ? { width: l.shape.width, height: l.shape.height } : null)

const expectSame = (a: readonly number[], b: readonly number[], tolerance = 1e-6) => {
  for (let i = 0; i < 16; i++) expect(Math.abs((a[i] as number) - (b[i] as number))).toBeLessThan(tolerance)
}

describe('the flat proxy', () => {
  it('puts every plane where core worldObjects puts it (random transforms, keyed ones, a group parent)', () => {
    const random = rng(4)
    const tracks: ReturnType<typeof lane>[] = []
    for (let i = 0; i < 8; i++) tracks.push(lane(`t${i}`, [shape(`s${i}`, randomTransform(random, { scaleZ: 1 }))]))
    // Keyed: x and the turn about Y move over the layer's life.
    const keyed = shape('k', randomTransform(random, { scaleZ: 1 }), {
      animations: {
        'transform.x': [
          { t: 0, v: -500, ease: 'linear' },
          { t: 2000, v: 400, ease: 'linear' },
        ],
        'transform.rotationY': [
          { t: 0, v: -20, ease: 'linear' },
          { t: 2000, v: 80, ease: 'linear' },
        ],
      },
    })
    tracks.push(lane('tk', [keyed]))
    // A group with a turned, scaled, faded transform holding two members.
    const group = LayerSchema.parse({
      id: 'g',
      name: 'g',
      kind: 'group',
      startMs: 0,
      durationMs: 4000,
      transform: randomTransform(random, { scaleZ: 1.5, opacity: 0.5, scaleX: 1.2, scaleY: 0.8 }),
    }) as Layer
    tracks.push(lane('tg', [group]))
    tracks.push(lane('tm1', [shape('m1', randomTransform(random, { scaleZ: 1 }))], { groupId: 'g' }))
    tracks.push(lane('tm2', [shape('m2', randomTransform(random, { scaleZ: 1, opacity: 0.8 }))], { groupId: 'g' }))
    const comp = world(tracks)
    for (const t of [0, 700, 1500]) {
      const frame = buildWorldFrame(comp, source, t)
      const objects = worldObjects(comp, t, { box: boxOf })
      expect(frame.planes).toHaveLength(11)
      for (const plane of frame.planes) {
        const object = objects.find((o) => o.layer.id === plane.id)
        expect(object).toBeDefined()
        expectSame(plane.matrix, (object as { matrix: number[] }).matrix)
        expect(plane.opacity).toBeCloseTo((object as { opacity: number }).opacity, 9)
      }
    }
  })

  it('moves constrained planes where core worldObjects puts them (child of, follow, look at, a followed group)', () => {
    const random = rng(9)
    const controller = LayerSchema.parse({
      id: 'c',
      name: 'c',
      kind: 'empty',
      startMs: 0,
      durationMs: 4000,
      transform: TransformSchema.parse({ x: 100, y: 50, z: 30 }),
      animations: {
        'transform.x': [
          { t: 0, v: -300, ease: 'linear' },
          { t: 3000, v: 300, ease: 'linear' },
        ],
        'transform.rotation': [
          { t: 0, v: 0, ease: 'linear' },
          { t: 3000, v: 120, ease: 'linear' },
        ],
      },
    }) as Layer
    const cns = (type: string, extra: Record<string, unknown> = {}) => ({ constraints: [{ id: `cns_${type}`, type, targetId: 'c', ...extra }] })
    const group = LayerSchema.parse({ id: 'g', name: 'g', kind: 'group', startMs: 0, durationMs: 4000, transform: randomTransform(random, { scaleZ: 1 }), ...cns('follow', { rotation: true }) }) as Layer
    const comp = world([
      lane('tc', [controller]),
      lane('t1', [shape('child', randomTransform(random, { scaleZ: 1 }), cns('childOf'))]),
      lane('t2', [shape('follower', randomTransform(random, { scaleZ: 1 }), cns('follow', { influence: 0.5 }))]),
      lane('t3', [shape('aimed', randomTransform(random, { scaleZ: 1 }), cns('lookAt'))]),
      lane('tg', [group]),
      lane('tm', [shape('member', randomTransform(random, { scaleZ: 1 }))], { groupId: 'g' }),
    ])
    for (const t of [0, 1200, 2900]) {
      const frame = buildWorldFrame(comp, source, t)
      const objects = worldObjects(comp, t, { box: boxOf })
      expect(frame.planes).toHaveLength(4)
      for (const plane of frame.planes) {
        const object = objects.find((o) => o.layer.id === plane.id) as { matrix: number[]; correction?: number[] }
        expect(object.correction).toBeDefined()
        expectSame(plane.matrix, object.matrix)
      }
    }
  })

  it('draws a whole-layer entrance pose at P times the flat posed matrix', () => {
    const base = TransformSchema.parse({ x: 120, y: -40, z: 60, rotationX: -25, rotationY: 30, scaleX: 1.3, anchorX: 0.2 })
    const animIn = { preset: 'slide-left', durationMs: 600, easing: 'linear' }
    const slid = shape('a', base, { animIn })
    const still = shape('a', base)
    for (const t of [0, 150, 300, 599, 900]) {
      const frame = buildWorldFrame(world([lane('t', [slid])]), source, t)
      const plane = frame.planes[0]
      expect(plane).toBeDefined()
      // The flat layer that the proxy stands for, resolved by the flat engine.
      const flat = { ...slid, transform: flatEquivalent(transformAt(slid, t)) } as Layer
      const resolved = resolveLayer(flat, t)
      expectSame((plane as { matrix: number[] }).matrix, mat4Multiply(PICTURE_AXES, layerMatrix(resolved.transform, { width: 240, height: 120 })))
      const unposed = buildWorldFrame(world([lane('t', [still])]), source, t).planes[0] as { matrix: number[] }
      const pose = layerPose(slid, t)
      const m = (plane as { matrix: number[] }).matrix
      if (pose && (pose.dx !== 0 || pose.dy !== 0)) {
        // An offset of the picture is applied outside its turns: the world translation moves by P(dx, dy) = (dx, 0, -dy).
        expect(m[12]).toBeCloseTo((unposed.matrix[12] as number) + pose.dx, 6)
        expect(m[13]).toBeCloseTo(unposed.matrix[13] as number, 6)
        expect(m[14]).toBeCloseTo((unposed.matrix[14] as number) - pose.dy, 6)
      }
    }
    // The pose really moved it somewhere at the start.
    const early = buildWorldFrame(world([lane('t', [slid])]), source, 0).planes[0] as { matrix: number[] }
    const rest = buildWorldFrame(world([lane('t', [still])]), source, 0).planes[0] as { matrix: number[] }
    expect(Math.abs((early.matrix[12] as number) - (rest.matrix[12] as number))).toBeGreaterThan(1)
  })

  it('leaves out cameras, lights and nested worlds, and orders planes back to front', () => {
    const camera = LayerSchema.parse({ id: 'c', name: 'c', kind: 'camera', startMs: 0, durationMs: 4000 }) as Layer
    const light = LayerSchema.parse({ id: 'l', name: 'l', kind: 'light', startMs: 0, durationMs: 4000 }) as Layer
    const comp = world([
      lane('tc', [camera]),
      lane('tl', [light]),
      lane('front', [shape('front', TransformSchema.parse({}))]),
      lane('back', [shape('back', TransformSchema.parse({}))]),
    ])
    const frame = buildWorldFrame(comp, source, 0)
    expect(frame.planes.map((p) => p.id)).toEqual(['back', 'front'])
    expect(frame.planes.map((p) => p.order)).toEqual([0, 1])
    expect(frame.camera.id).toBe('c')
  })
})

describe('plane textures', () => {
  it('stands a node alone in its own space at full opacity', () => {
    const t = TransformSchema.parse({ x: 300, y: 50, rotation: 20, scaleX: 2, opacity: 0.4 })
    const node = buildWorldFrame(world([lane('t', [shape('a', t)])]), source, 0).planes[0]?.node
    expect(node).toBeDefined()
    const alone = standAlone(node as NonNullable<typeof node>)
    expect(alone.matrix[12]).toBe(0)
    expect(alone.matrix[0]).toBe(1)
    expect(alone.resolved.transform.opacity).toBe(1)
  })

  it('lands texels on whole output pixels for an unturned plane at depth 0 seen by the default camera', () => {
    const random = rng(9)
    for (let i = 0; i < 40; i++) {
      const scale = i % 2 === 0 ? 1 : 0.5
      const s = random(0.6, 2.4)
      const t = TransformSchema.parse({ x: random(-500, 500), z: random(-300, 300), scaleX: s, scaleY: s })
      const frame = buildWorldFrame(world([lane('t', [shape('a', t)])]), source, 0)
      const plane = frame.planes[0] as NonNullable<(typeof frame.planes)[number]>
      const reach = Math.round(random(0, 12))
      const spec = textureSpec(frame, plane, reach, scale)
      expect(spec.snap).not.toBeNull()
      expect(spec.raster).toBeCloseTo(scale * s, 9)
      // Where the texture's left and top edges, and its size, land in output pixels.
      const m = plane.node.matrix
      const left = scale * ((m[12] as number) + W / 2) + spec.raster * spec.rect.left
      const top = scale * ((m[13] as number) + H / 2) + spec.raster * spec.rect.top
      expect(Math.abs(left - Math.round(left))).toBeLessThan(1e-6)
      expect(Math.abs(top - Math.round(top))).toBeLessThan(1e-6)
      expect(Math.abs(spec.rect.width * spec.raster - spec.width)).toBeLessThan(1e-9)
      // It covers the grown box.
      expect(spec.rect.left).toBeLessThanOrEqual(plane.local.left - reach + 1e-9)
      expect(spec.rect.left + spec.rect.width).toBeGreaterThanOrEqual(plane.local.left + plane.local.width + reach - 1e-9)
    }
  })

  it('does not snap a turned plane and caps the texture size', () => {
    const turned = buildWorldFrame(world([lane('t', [shape('a', TransformSchema.parse({ rotationY: 40 }))])]), source, 0)
    const spec = textureSpec(turned, turned.planes[0] as NonNullable<(typeof turned.planes)[number]>, 0, 1)
    expect(spec.snap).toBeNull()
    const huge = buildWorldFrame(world([lane('t', [shape('a', TransformSchema.parse({ scaleX: 3, scaleY: 3 }), { shape: { type: 'rect', width: 3000, height: 100 } })])]), source, 0)
    const big = textureSpec(huge, huge.planes[0] as NonNullable<(typeof huge.planes)[number]>, 0, 1)
    expect(Math.max(big.width, big.height)).toBeLessThanOrEqual(MAX_TEXTURE + 1)
  })
})


describe('outlines and picking', () => {
  it('puts a plane on the pixels the flat renderer would, and picks the front one', () => {
    const t = TransformSchema.parse({ x: 200, z: -100, scaleX: 1.5, scaleY: 0.8 })
    const comp = world([lane('front', [shape('front', t)]), lane('back', [shape('back', t)])])
    const frame = buildWorldFrame(comp, source, 0)
    const plane = frame.planes.find((p) => p.id === 'front') as NonNullable<(typeof frame.planes)[number]>
    const corners = planeCorners(frame, plane) as [number, number][]
    // The flat layer is at (200, 100) in comp px, 360 × 96 on screen, in a 1920 × 1080 comp.
    expect(corners[0]?.[0]).toBeCloseTo(W / 2 + 200 - 180, 6)
    expect(corners[0]?.[1]).toBeCloseTo(H / 2 + 100 - 48, 6)
    expect(corners[2]?.[0]).toBeCloseTo(W / 2 + 200 + 180, 6)
    expect(corners[2]?.[1]).toBeCloseTo(H / 2 + 100 + 48, 6)
    expect(pickPlane(frame, [W / 2 + 200, H / 2 + 100])?.id).toBe('front')
    expect(pickPlane(frame, [10, 10])).toBeNull()
  })
})
