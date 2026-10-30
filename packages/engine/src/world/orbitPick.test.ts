import { type Comp, CompSchema, type Layer, LayerSchema, TrackSchema, worldPivotAt } from '@uve/core'
import { describe, expect, it } from 'vitest'
import type { Ctx2D } from '../content'
import { frameBounds, orbitCamera, type OrbitView } from '../orbit'
import type { SceneSource } from '../scene'
import { buildWorldFrame } from './frame'
import type { WorldHost } from './host'
import { hitPlane, orbitPick, orbitRay } from './orbitPick'
import { orbitBounds, orbitFrame } from './orbitView'

const W = 1920
const H = 1080
const measure = { font: '', letterSpacing: '', textAlign: 'left', textBaseline: 'alphabetic', measureText: (text: string) => ({ width: text.length * 10 }) } as unknown as Ctx2D
const source: SceneSource = { measure, media: [] }
const host = {} as WorldHost

const shape = (id: string, extra: Record<string, unknown> = {}) =>
  LayerSchema.parse({ id, name: id, kind: 'shape', startMs: 0, durationMs: 4000, shape: { type: 'rect', width: 200, height: 100 }, ...extra }) as Layer

const layer = (id: string, kind: 'camera' | 'light', extra: Record<string, unknown> = {}) =>
  LayerSchema.parse({ id, name: id, kind, startMs: 0, durationMs: 4000, ...extra }) as Layer

const world = (layers: Layer[], track: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Comp =>
  CompSchema.parse({ id: 'w', name: 'W', width: W, height: H, fps: 30, durationMs: 4000, world: {}, tracks: layers.map((l, i) => TrackSchema.parse({ id: `t${i}`, layers: [l], ...track })), ...extra }) as Comp

const front: OrbitView = { target: [0, 0, 0], distance: 1500, yaw: 0, pitch: 0 }

/** Where a world point lands in comp px through the front view. */
function through(view: OrbitView, p: readonly [number, number, number]): [number, number] {
  const c = orbitCamera(view, W, H)
  const m = c.matrix as number[]
  const d = [p[0] - (m[12] as number), p[1] - (m[13] as number), p[2] - (m[14] as number)]
  const dot = (i: number) => d[0]! * (m[i] as number) + d[1]! * (m[i + 1] as number) + d[2]! * (m[i + 2] as number)
  const k = (W * c.spec.focalLength) / c.spec.sensorWidth / -dot(8)
  return [W / 2 + dot(0) * k, H / 2 - dot(4) * k]
}

describe('orbit ray', () => {
  it('goes through the target from the canvas centre', () => {
    const ray = orbitRay(front, { width: W, height: H }, [W / 2, H / 2])
    expect(ray.origin[1]).toBeCloseTo(-1500)
    expect(ray.origin[1] + ray.direction[1] * 1500).toBeCloseTo(0, 6)
    expect(ray.origin[0] + ray.direction[0] * 1500).toBeCloseTo(0, 6)
    expect(Math.hypot(...ray.direction)).toBeCloseTo(1)
  })

  it('agrees with the camera projection off the centre', () => {
    const view: OrbitView = { target: [40, 10, 25], distance: 900, yaw: 35, pitch: 25 }
    const ray = orbitRay(view, { width: W, height: H }, [1500, 300])
    const p: [number, number, number] = [ray.origin[0] + ray.direction[0] * 700, ray.origin[1] + ray.direction[1] * 700, ray.origin[2] + ray.direction[2] * 700]
    const [x, y] = through(view, p)
    expect(x).toBeCloseTo(1500, 4)
    expect(y).toBeCloseTo(300, 4)
  })

  it('crosses a plane in its local space', () => {
    const ray = orbitRay(front, { width: W, height: H }, [W / 2, H / 2])
    // A picture plane stands in XZ: local x right, local y down, normal along −Y.
    const hit = hitPlane([1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1], ray)
    expect(hit?.t).toBeCloseTo(1500)
    expect(hit?.x).toBeCloseTo(0, 6)
    expect(hit?.y).toBeCloseTo(0, 6)
  })
})

describe('orbit picking', () => {
  const centre: [number, number] = [W / 2, H / 2]

  it('picks the picture standing in front of the view, and misses beside it', () => {
    const comp = world([shape('a')])
    expect(orbitPick(host, comp, source, 0, front, centre)?.id).toBe('a')
    expect(orbitPick(host, comp, source, 0, front, [W / 2 + 600, H / 2])).toBeNull()
  })

  it('takes the nearer of two pictures along the ray', () => {
    const comp = world([shape('far', { transform: { y: 300 } }), shape('near', { transform: { y: -300 } })])
    expect(orbitPick(host, comp, source, 0, front, centre)?.id).toBe('near')
  })

  it('skips locked layers unless asked', () => {
    const comp = world([shape('a')], { locked: true })
    expect(orbitPick(host, comp, source, 0, front, centre)).toBeNull()
    expect(orbitPick(host, comp, source, 0, front, centre, { includeLocked: true })?.id).toBe('a')
  })

  it('picks a camera by its origin, and gizmos win over pictures', () => {
    const camera = layer('cam', 'camera', { transform: { x: 400, y: -200, z: 100 } })
    const comp = world([shape('a'), camera])
    const [px, py] = through(front, worldPivotAt(comp, 'cam', 0) as [number, number, number])
    expect(orbitPick(host, comp, source, 0, front, [px + 10, py])?.id).toBe('cam')
    expect(orbitPick(host, comp, source, 0, front, [px + 400, py + 400])).toBeNull()
    expect(orbitPick(host, comp, source, 0, front, centre)?.id).toBe('a')
    // A gizmo that sits over a picture takes the pick there.
    const over = world([shape('a'), layer('cam2', 'camera', { transform: { x: 0, y: -200, z: 0 } })])
    expect(orbitPick(host, over, source, 0, front, centre)?.id).toBe('cam2')
  })

  it('scales the gizmo radius with the screen size of a comp px', () => {
    const comp = world([layer('lamp', 'light', { light: { type: 'point' }, transform: { x: 600, y: 0, z: 0 } })])
    const [px, py] = through(front, worldPivotAt(comp, 'lamp', 0) as [number, number, number])
    // 11 comp px from the origin and about 1.2 from the nearest line: inside 16 screen px at 1 px per comp px, outside at 16 (1 comp px, 0.6 for a line).
    expect(orbitPick(host, comp, source, 0, front, [px + 8, py + 8], { pxPerComp: 1 })?.id).toBe('lamp')
    expect(orbitPick(host, comp, source, 0, front, [px + 8, py + 8], { pxPerComp: 16 })).toBeNull()
  })
})

describe('orbit frame and bounds', () => {
  it('sees the world from the orbit camera, with no depth of field', () => {
    const frame = orbitFrame(buildWorldFrame(world([shape('a')]), source, 0), front, 'rendered')
    expect(frame.camera.id).toBe('orbit')
    expect(frame.camera.dof).toBeUndefined()
    expect(frame.camera.matrix[13]).toBeCloseTo(-1500)
    expect(frame.planes).toHaveLength(1)
  })

  it('turns the scene lights, shadows, mist, floor and post off for Solid and Material', () => {
    const comp = world([shape('a')], {}, { world: { render: { shadows: true, bloom: { enabled: true }, ao: { enabled: true }, floor: { mode: 'solid' } }, fog: { enabled: true } } })
    const base = buildWorldFrame(comp, source, 0)
    for (const shading of ['solid', 'material'] as const) {
      const frame = orbitFrame(base, front, shading)
      expect(frame.lights).toEqual([])
      expect(frame.fog.enabled).toBe(false)
      expect(frame.render.shadows).toBe(false)
      expect(frame.render.bloom.enabled).toBe(false)
      expect(frame.render.ao.enabled).toBe(false)
      expect(frame.render.floor.mode).toBe('none')
    }
    const rendered = orbitFrame(base, front, 'rendered')
    expect(rendered.render.bloom.enabled).toBe(true)
    expect(rendered.render.floor.mode).toBe('solid')
    expect(rendered.fog.enabled).toBe(true)
  })

  it('bounds pictures by their boxes, and cameras only when named', () => {
    const camera = layer('cam', 'camera', { transform: { x: 900, y: -500, z: 0 } })
    const comp = world([shape('a', { transform: { x: 100, y: 0, z: 50 } }), camera])
    const all = orbitBounds(host, comp, source, 0)
    expect(all?.min[0]).toBeCloseTo(0)
    expect(all?.max[0]).toBeCloseTo(200)
    expect(all?.max[1]).toBeCloseTo(0)
    expect(all?.min[2]).toBeCloseTo(0)
    expect(all?.max[2]).toBeCloseTo(100)
    expect(orbitBounds(host, comp, source, 0, ['a', 'cam'])?.max[0]).toBeCloseTo(900)
    expect(orbitBounds(host, comp, source, 0, ['cam'])?.min).toEqual([900, -500, 0])
    expect(orbitBounds(host, world([]), source, 0)).toBeNull()
    const framed = frameBounds(front, all as NonNullable<typeof all>, W / H)
    expect(framed.yaw).toBe(0)
    expect(framed.target[0]).toBeCloseTo(100)
  })
})
