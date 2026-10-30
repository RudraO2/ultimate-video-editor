import {
  type Comp,
  createDefaultProject,
  defaultCamera,
  type Layer,
  mat4TransformPoint,
  projectWorldPoint,
  sequentialIds,
  Session,
  type Transform,
  worldObjects,
} from '@uve/core'
import { describe, expect, it } from 'vitest'
import { frontCamera, projectToPixels } from './camera'
import type { Ctx2D } from './content'
import { layerMatrix, resolveLayer } from './evaluate'
import { transformPoint } from './math'
import { buildScene, flattenScene, placementsOf } from './scene'

// The no-visual-jump proof for world.move_into: a flat layer's box corners
// through the flat front camera equal the same corners after the move, through
// the world's default camera.

const W = 1920
const H = 1080
const measure = { font: '', letterSpacing: '', textAlign: 'left', textBaseline: 'alphabetic', measureText: (text: string) => ({ width: text.length * 10 }) } as unknown as Ctx2D

/** A small deterministic random source, so failures repeat. */
function rng(seed: number) {
  let s = seed
  return (lo: number, hi: number) => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return lo + (s / 4294967296) * (hi - lo)
  }
}

function setup() {
  const ids = sequentialIds()
  const session = new Session({ project: createDefaultProject(ids), ids })
  session.measure = (c, t) => placementsOf(buildScene(c, { measure, media: [] }, t))
  // biome-ignore lint/suspicious/noExplicitAny: test results are checked field by field
  const ok = async (name: string, input: unknown = {}): Promise<any> => {
    const result = await session.call(name, input)
    if (!result.ok) throw new Error(`${name} failed: ${result.error}`)
    return result.value
  }
  const comp = (id: string) => session.project.comps.find((c) => c.id === id) as Comp
  const layer = (id: string) => session.project.comps.flatMap((c) => c.tracks.flatMap((t) => t.layers)).find((l) => l.id === id) as Layer
  return { session, ok, comp, layer }
}

const boxOf = (l: Layer) => (l.kind === 'shape' ? { width: l.shape.width, height: l.shape.height } : null)

/** The four corners and the centre of a w × h box. */
const corners = (w: number, h: number): [number, number][] => [
  [-w / 2, -h / 2],
  [w / 2, -h / 2],
  [w / 2, h / 2],
  [-w / 2, h / 2],
  [0, 0],
]

type Pixels = ([number, number] | null)[]

/** Through the flat comp: a matrix to comp space, then the front camera. */
function flatPixels(matrix: number[], w: number, h: number): Pixels {
  const front = frontCamera(W, H)
  return corners(w, h).map(([cx, cy]) => {
    const [x, y, z] = transformPoint(matrix, cx, cy, 0)
    return projectToPixels(front, x, y, z)
  })
}

/** Through the world: its matrix, then the default camera. */
function worldPixels(matrix: number[], w: number, h: number): Pixels {
  const camera = defaultCamera(W, H)
  return corners(w, h).map(([cx, cy]) => {
    const [x, y, z] = mat4TransformPoint(matrix, cx, cy, 0)
    return projectWorldPoint(camera, W, H, [x, y, z])
  })
}

function expectSame(actual: Pixels, expected: Pixels): void {
  expect(actual).toHaveLength(expected.length)
  for (const [i, e] of expected.entries()) {
    expect(e).not.toBeNull()
    expect(actual[i]).not.toBeNull()
    expect(actual[i]?.[0]).toBeCloseTo((e as number[])[0] as number, 6)
    expect(actual[i]?.[1]).toBeCloseTo((e as number[])[1] as number, 6)
  }
}

describe('world.move_into: no visual jump', () => {
  it('keeps 40 random flat layers on the same pixels (rotation and rotationY both turning)', async () => {
    const { ok, comp, layer } = setup()
    const random = rng(11)
    const made: { id: string; w: number; h: number; transform: Transform }[] = []
    for (let i = 0; i < 40; i++) {
      const w = Math.round(random(60, 400))
      const h = Math.round(random(40, 300))
      const transform = {
        x: random(-800, 800),
        y: random(-450, 450),
        z: random(-600, 600),
        rotation: random(-180, 180),
        rotationX: random(-60, 60),
        rotationY: random(-70, 70),
        scaleX: random(0.3, 3),
        scaleY: random(0.3, 3),
        anchorX: random(-0.5, 1.5),
        anchorY: random(-0.5, 1.5),
      }
      const created = await ok('layer.create', { kind: 'shape', name: `S${i}`, width: w, height: h, transform })
      made.push({ id: created.id, w, h, transform: layer(created.id).transform })
    }
    const expected = made.map((m) => flatPixels(layerMatrix(m.transform, { width: m.w, height: m.h }), m.w, m.h))
    const moved = await ok('world.move_into', { ids: made.map((m) => m.id) })
    expect(moved.approximate).toBeUndefined()
    const objects = worldObjects(comp(moved.frameId), 0, { box: boxOf })
    expect(objects).toHaveLength(40)
    for (const [i, m] of made.entries()) {
      const object = objects.find((o) => o.layer.id === m.id)
      expect(object).toBeDefined()
      expectSame(worldPixels((object as { matrix: number[] }).matrix, m.w, m.h), expected[i] as Pixels)
    }
  })

  it('keeps keyed moves on the same pixels at several times', async () => {
    const { ok, comp, layer } = setup()
    const random = rng(23)
    const times = [0, 137, 500, 999]
    const made: { id: string; w: number; h: number }[] = []
    for (let i = 0; i < 12; i++) {
      const w = Math.round(random(60, 400))
      const h = Math.round(random(40, 300))
      const created = await ok('layer.create', {
        kind: 'shape',
        name: `K${i}`,
        width: w,
        height: h,
        transform: { rotationY: 0, scaleX: random(0.5, 2), scaleY: random(0.5, 2), anchorX: random(-0.3, 1.3), anchorY: random(-0.3, 1.3), rotation: random(-30, 30) },
      })
      const ranges: [string, number, number][] = [
        ['transform.x', -700, 700],
        ['transform.y', -400, 400],
        ['transform.z', -500, 500],
        ['transform.rotationX', -50, 50],
        ['transform.rotation', -170, 170],
      ]
      for (const [path, lo, hi] of ranges) {
        const keys = [0, 400, 1000].map((t) => ({ t, v: random(lo, hi) }))
        await ok('keyframes.set', { id: created.id, path, keys })
      }
      made.push({ id: created.id, w, h })
    }
    const expected = new Map<string, Pixels>()
    for (const m of made) {
      const l = layer(m.id)
      for (const t of times) expected.set(`${m.id}@${t}`, flatPixels(layerMatrix(resolveLayer(l, t).transform, { width: m.w, height: m.h }), m.w, m.h))
    }
    const moved = await ok('world.move_into', { ids: made.map((m) => m.id) })
    expect(moved.approximate).toBeUndefined()
    for (const t of times) {
      const objects = worldObjects(comp(moved.frameId), t, { box: boxOf })
      for (const m of made) {
        const object = objects.find((o) => o.layer.id === m.id)
        expect(object).toBeDefined()
        expectSame(worldPixels((object as { matrix: number[] }).matrix, m.w, m.h), expected.get(`${m.id}@${t}`) as Pixels)
      }
    }
  })

  it('keeps the members of a turned, scaled group on the same pixels, with the engine measuring the pivot', async () => {
    const { ok, session, comp } = setup()
    const members: { id: string; w: number; h: number }[] = []
    for (const [i, [x, y]] of [
      [-420, -120],
      [310, 80],
      [40, 260],
    ].entries()) {
      const created = await ok('layer.create', { kind: 'shape', name: `M${i}`, width: 180 + i * 20, height: 120, transform: { x, y, rotation: i * 12 } })
      members.push({ id: created.id, w: 180 + i * 20, h: 120 })
    }
    const { groupId } = await ok('layers.group', { ids: members.map((m) => m.id), name: 'G' })
    await ok('layer.patch', {
      id: groupId,
      ops: [{ op: 'merge', path: 'transform', value: { x: 60, y: -35, z: 90, rotation: 28, rotationX: 17, rotationY: 12, scaleX: 1.4, scaleY: 0.75, anchorX: 0.2, anchorY: 0.8 } }],
    })
    const flat = buildScene(session.project.comps[0] as Comp, { measure, media: [] }, 0)
    const nodes = flattenScene(flat)
    const expected = members.map((m) => flatPixels((nodes.find((n) => n.layer.id === m.id) as { matrix: number[] }).matrix, m.w, m.h))
    const moved = await ok('world.move_into', { ids: [groupId] })
    expect(moved.approximate).toBeUndefined()
    const objects = worldObjects(comp(moved.frameId), 0, { box: boxOf })
    for (const [i, m] of members.entries()) {
      const object = objects.find((o) => o.layer.id === m.id)
      expect(object?.parentId).toBe(groupId)
      expectSame(worldPixels((object as { matrix: number[] }).matrix, m.w, m.h), expected[i] as Pixels)
    }
  })
})
