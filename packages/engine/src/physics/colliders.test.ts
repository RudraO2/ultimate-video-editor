import { type Comp, createDefaultProject, sequentialIds, Session } from '@uve/core'
import { describe, expect, it } from 'vitest'
import type { Ctx2D } from '../content'
import { buildScene, flattenScene, type SceneNode } from '../scene'
import { type BodyShape, bodyColliders, type Collider } from './colliders'
import { polygonArea } from './geometry'

// 10 px per character; ink rises 0.7 of the size above the baseline and falls 0.2 below it.
const measure = {
  font: '' as string,
  letterSpacing: '',
  textAlign: 'left',
  textBaseline: 'alphabetic',
  measureText(this: { font: string }, text: string) {
    const size = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 16)
    return {
      width: text.length * 10,
      actualBoundingBoxAscent: size * 0.7,
      actualBoundingBoxDescent: size * 0.2,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: text.length * 10,
      fontBoundingBoxAscent: size * 0.8,
      fontBoundingBoxDescent: size * 0.2,
    }
  },
} as unknown as Ctx2D

type Pts = [number, number][]

function setup() {
  const ids = sequentialIds()
  const session = new Session({ project: createDefaultProject(ids), ids })
  // biome-ignore lint/suspicious/noExplicitAny: test results are checked field by field
  const ok = async (name: string, input: unknown = {}): Promise<any> => {
    const result = await session.call(name, input)
    if (!result.ok) throw new Error(`${name} failed: ${result.error}`)
    return result.value
  }
  const find = (id: string): SceneNode => {
    const scene = buildScene(session.project.comps[0] as Comp, { measure, media: session.project.media }, 0)
    return flattenScene(scene).find((n) => n.layer.id === id) as SceneNode
  }
  const colliders = (id: string, shape: BodyShape = 'auto', silhouette?: Parameters<typeof bodyColliders>[3]) => bodyColliders(find(id), shape, measure, silhouette ?? (() => undefined))
  return { ok, find, colliders }
}

const polygons = (c: Collider[]): Pts[] => c.flatMap((x) => (x.kind === 'polygon' ? [x.points] : []))
const bounds = (points: Pts) => {
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) }
}
const total = (c: Collider[]) => polygons(c).reduce((s, p) => s + Math.abs(polygonArea(p)), 0)
const convex = (p: Pts) =>
  p.every((a, i) => {
    const b = p[(i + 1) % p.length] as [number, number]
    const c = p[(i + 2) % p.length] as [number, number]
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) >= -1e-6
  })

describe('bodyColliders', () => {
  it('turns a rotated rectangle into one box in comp space', async () => {
    const { ok, colliders } = setup()
    const r = await ok('layer.create', { kind: 'shape', width: 100, height: 50, x: 30, y: -20 })
    await ok('layer.set', { id: r.id, values: { rotation: 90 } })
    const [box, ...rest] = polygons(colliders(r.id))
    expect(rest).toEqual([])
    const b = bounds(box as Pts)
    expect([b.left, b.right, b.top, b.bottom].map(Math.round)).toEqual([5, 55, -70, 30])
    expect(Math.abs(polygonArea(box as Pts))).toBeCloseTo(5000, 3)
  })

  it('makes a round ellipse a circle and another one a polygon', async () => {
    const { ok, colliders } = setup()
    const round = await ok('layer.create', { kind: 'shape', shape: 'ellipse', width: 100, height: 100, x: 10, y: 20 })
    expect(colliders(round.id)).toEqual([{ kind: 'circle', x: 10, y: 20, radius: 50 }])
    const wide = await ok('layer.create', { kind: 'shape', shape: 'ellipse', width: 200, height: 100 })
    const pieces = colliders(wide.id)
    expect(pieces.every((p) => p.kind === 'polygon')).toBe(true)
    expect(total(pieces)).toBeGreaterThan(0.97 * Math.PI * 100 * 50)
    expect(total(pieces)).toBeLessThan(Math.PI * 100 * 50)
  })

  it('cuts a star into convex pieces and gives a hull, a box and a sphere on request', async () => {
    const { ok, colliders } = setup()
    const star = await ok('layer.create', { kind: 'shape', shape: 'star', width: 200, height: 200 })
    const pieces = polygons(colliders(star.id))
    expect(pieces.length).toBeGreaterThanOrEqual(3)
    for (const p of pieces) {
      expect(p.length).toBeLessThanOrEqual(12)
      expect(convex(p)).toBe(true)
    }
    const hull = polygons(colliders(star.id, 'hull'))
    expect(hull).toHaveLength(1)
    expect(hull[0]).toHaveLength(5)
    expect(Math.abs(polygonArea(hull[0] as Pts))).toBeGreaterThan(total(colliders(star.id)))
    expect(Math.abs(polygonArea(polygons(colliders(star.id, 'box'))[0] as Pts))).toBeCloseTo(40000, 3)
    expect(colliders(star.id, 'sphere')).toEqual([{ kind: 'circle', x: 0, y: 0, radius: 100 }])
  })

  it('flattens a path into convex pieces, and an open path into its hull', async () => {
    const { ok, colliders } = setup()
    const w = await ok('layer.create', { kind: 'path', d: 'M0 0 L100 0 L100 100 L50 40 L0 100 Z', x: 200 })
    const pieces = polygons(colliders(w.id))
    expect(pieces.length).toBeGreaterThanOrEqual(2)
    expect(pieces.every(convex)).toBe(true)
    // The square less the notch (a triangle 100 wide and 60 deep).
    expect(total(colliders(w.id))).toBeCloseTo(10000 - 0.5 * 100 * 60, 0)
    expect(bounds(pieces.flat() as Pts).left).toBeCloseTo(150, 3)
    const open = await ok('layer.create', { kind: 'path', d: 'M0 0 L100 0 L100 100' })
    const hull = polygons(colliders(open.id))
    expect(hull).toHaveLength(1)
    expect(Math.abs(polygonArea(hull[0] as Pts))).toBeCloseTo(5000, 3)
  })

  it('joins the members of a group and skips a cutter', async () => {
    const { ok, colliders } = setup()
    const a = await ok('layer.create', { kind: 'shape', width: 100, height: 100, x: -100 })
    const b = await ok('layer.create', { kind: 'shape', width: 100, height: 100, x: 100 })
    const { groupId } = await ok('layers.group', { ids: [a.id, b.id] })
    expect(polygons(colliders(groupId))).toHaveLength(2)
    const hull = polygons(colliders(groupId, 'hull'))
    expect(hull).toHaveLength(1)
    expect(bounds(hull[0] as Pts)).toEqual({ left: -150, right: 150, top: -50, bottom: 50 })
    expect(Math.abs(polygonArea(polygons(colliders(groupId, 'box'))[0] as Pts))).toBeCloseTo(30000, 3)
    await ok('layer.patch', { id: groupId, ops: [{ op: 'set', path: 'mode', value: 'mask' }] })
    expect(polygons(colliders(groupId))).toHaveLength(1)
  })

  it('follows the silhouette of an image, or its box without one', async () => {
    const { ok, colliders } = setup()
    const media = await ok('media.add', { kind: 'image', name: 'cat', path: 'C:/cat.png', width: 200, height: 100 })
    const img = await ok('layer.create', { kind: 'image', mediaId: media.id, x: 50 })
    expect(bounds(polygons(colliders(img.id))[0] as Pts)).toEqual({ left: -50, right: 150, top: -50, bottom: 50 })
    const quarter: [number, number][] = [
      [0.25, 0.25],
      [0.75, 0.25],
      [0.75, 0.75],
      [0.25, 0.75],
    ]
    const seen: string[] = []
    const cut = colliders(img.id, 'auto', (layer) => {
      seen.push(layer.id)
      return [quarter]
    })
    expect(seen).toEqual([img.id])
    expect(bounds(polygons(cut)[0] as Pts)).toEqual({ left: 0, right: 100, top: -25, bottom: 25 })
  })

  it('gives text one box of ink per line, starting at the letters and not the line box', async () => {
    const { ok, colliders } = setup()
    const t = await ok('layer.create', { kind: 'text', text: 'Hello\nWorld', style: { fontSize: 40, lineHeight: 1.2 } })
    const boxes = polygons(colliders(t.id))
    expect(boxes).toHaveLength(2)
    const [first, second] = boxes.map((p) => bounds(p))
    // Two 48 px lines centred on 0 (box top -48); the first baseline is 12 above 0, its ink 28 above that.
    expect(first).toEqual({ left: -25, right: 25, top: -40, bottom: -4 })
    expect(second).toEqual({ left: -25, right: 25, top: 8, bottom: 44 })
    expect(bounds(polygons(colliders(t.id, 'box'))[0] as Pts).top).toBe(-48)
  })
})
