import { type Comp, createDefaultProject, type Layer, sequentialIds, Session } from '@uve/core'
import { describe, expect, it } from 'vitest'
import type { Ctx2D } from '../content'
import { buildScene, flattenScene, type SceneNode } from '../scene'
import { forceAcceleration } from './simulate'

const measure = {
  font: '',
  letterSpacing: '',
  textAlign: 'left',
  textBaseline: 'alphabetic',
  measureText: (text: string) => ({ width: text.length * 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2, actualBoundingBoxLeft: 0, actualBoundingBoxRight: text.length * 10 }),
} as unknown as Ctx2D

function setup() {
  const ids = sequentialIds()
  const session = new Session({ project: createDefaultProject(ids), ids })
  const comp = () => session.project.comps[0] as Comp
  // biome-ignore lint/suspicious/noExplicitAny: test results are checked field by field
  const ok = async (name: string, input: unknown = {}): Promise<any> => {
    const result = await session.call(name, input)
    if (!result.ok) throw new Error(`${name} failed: ${result.error} ${result.hint ?? ''}`)
    return result.value
  }
  const node = (id: string, t: number) => flattenScene(buildScene(comp(), { measure, media: session.project.media }, t)).find((n) => n.layer.id === id) as SceneNode
  const at = (id: string, t: number) => {
    const tr = node(id, t).resolved.transform
    return { x: tr.x, y: tr.y, rotation: tr.rotation }
  }
  const box = async (x: number, y: number, width = 100, height = 100, durationMs?: number) =>
    (await ok('layer.create', { kind: 'shape', width, height, x, y, ...(durationMs ? { durationMs } : {}) })).id as string
  return { session, ok, comp, at, box, node }
}

describe('physics: the simulation', () => {
  it('drops a box onto the floor (the comp’s bottom edge) and lets it rest', async () => {
    const { ok, comp, at, box } = setup()
    const id = await box(0, -300)
    await ok('physics.body', { ids: id, bounce: 0 })
    const floor = comp().height / 2
    expect(at(id, 0).y).toBeCloseTo(-300, 6)
    const rest = at(id, 3000)
    expect(rest.y).toBeGreaterThan(floor - 52)
    expect(rest.y).toBeLessThan(floor - 48)
    expect(Math.abs(rest.rotation)).toBeLessThan(1)
    // Falling under 981 px/s²: after 0.3 s it has dropped about ½·g·t².
    expect(at(id, 300).y).toBeCloseTo(-300 + 0.5 * 981 * 0.09, -1)
  })

  it('leaves bodies where their keys put them before the physics start', async () => {
    const { ok, at, box } = setup()
    const id = await box(0, -300)
    await ok('physics.body', { ids: id })
    await ok('physics.scene', { startMs: 1000 })
    expect(at(id, 500).y).toBe(-300)
    expect(at(id, 1000).y).toBeCloseTo(-300, 6)
    expect(at(id, 1500).y).toBeGreaterThan(-200)
  })

  it('gives the same frames twice, in any order of asking', async () => {
    const run = async (times: number[]) => {
      const { ok, at, box } = setup()
      const ids = [await box(-200, -400), await box(-120, -700), await box(-60, -1000), await box(40, -200, 300, 40)]
      await ok('physics.body', { ids: ids.slice(0, 3), spin: [0, 0, 60], velocity: [80, 0, 0], bounce: 0.4 })
      await ok('physics.body', { ids: ids[3], type: 'passive' })
      await ok('physics.scene', { walls: true })
      return times.map((t) => ids.map((id) => at(id, t)))
    }
    const forward = await run([500, 1500, 2500, 4000])
    const backward = (await run([4000, 2500, 1500, 500])).reverse()
    expect(backward).toEqual(forward)
    expect(await run([500, 1500, 2500, 4000])).toEqual(forward)
  })

  it('stops a falling box on a passive shelf, and drops it when the shelf’s clip ends', async () => {
    const { ok, at, box } = setup()
    const shelf = await box(0, 0, 400, 40, 2000)
    const id = await box(0, -300)
    await ok('physics.body', { ids: shelf, type: 'passive' })
    await ok('physics.body', { ids: id, bounce: 0 })
    // Box2D keeps a skin of about 1 px on each polygon.
    expect(Math.abs(at(id, 1800).y + 70)).toBeLessThan(2.5)
    expect(at(id, 2600).y).toBeGreaterThan(0)
  })

  it('pushes with wind along its carrier’s +X, and a gust keys on its strength', async () => {
    const { ok, at, box } = setup()
    const id = await box(0, 0)
    await ok('physics.body', { ids: id, damping: 0 })
    await ok('physics.scene', { gravity: 0, floor: false })
    const { layerId, forceId } = await ok('physics.force', { type: 'wind', strength: 500 })
    expect(at(id, 1000).x).toBeCloseTo(250, -1)
    await ok('keyframes.set', { id: layerId, property: `force.${forceId}.strength`, keys: [{ at: 0, value: 0 }, { at: 1000, value: 0 }] })
    expect(at(id, 1000).x).toBeCloseTo(0, 3)
  })

  it('keeps bodies inside the walls, and lets bodies in from above the frame', async () => {
    const { ok, comp, at, box } = setup()
    const fast = await box(0, 0)
    const above = await box(300, -900)
    await ok('physics.body', { ids: fast, velocity: [4000, 0, 0] })
    await ok('physics.body', { ids: above })
    await ok('physics.scene', { walls: true })
    expect(at(fast, 2000).x).toBeLessThanOrEqual(comp().width / 2 - 49)
    expect(at(above, 4000).y).toBeCloseTo(comp().height / 2 - 50, -1)
  })

  it('hangs a body from the comp on a pin', async () => {
    const { ok, at, box } = setup()
    const id = await box(0, 0, 40, 200)
    await ok('physics.body', { ids: id, spin: [0, 0, 120] })
    await ok('physics.joint', { id, add: [{ type: 'pin', anchor: [0, -100, 0] }] })
    for (const t of [500, 1500, 3000]) {
      const p = at(id, t)
      // The pin stays at (0, −100): the centre swings 100 px from it.
      expect(Math.hypot(p.x, p.y + 100)).toBeCloseTo(100, -0.5)
    }
  })

  it('moves a whole group as one body', async () => {
    const { ok, at, box } = setup()
    const a = await box(-60, -300)
    const b = await box(60, -300)
    const { groupId } = await ok('layers.group', { ids: [a, b] })
    await ok('physics.body', { ids: groupId, bounce: 0 })
    const g = at(groupId, 3000)
    expect(g.y).toBeGreaterThan(240)
    expect(Math.abs(g.rotation)).toBeLessThan(1)
  })
})

describe('physics: forces', () => {
  const base = { id: 'f', type: 'wind' as const, strength: 100, radius: 0, falloff: 'smooth' as const, scale: 240, seed: 0, enabled: true }
  it('blows wind along the carrier’s angle, and fades it with distance', () => {
    const [x, y] = forceAcceleration(base, [0, 0], 90, [0, 0], [0, 0], 0)
    expect(x).toBeCloseTo(0, 6)
    expect(y).toBeCloseTo(100, 6)
    expect(forceAcceleration({ ...base, radius: 100 }, [0, 0], 0, [150, 0], [0, 0], 0)).toEqual([0, 0])
    expect(forceAcceleration({ ...base, radius: 100, falloff: 'linear' }, [0, 0], 0, [50, 0], [0, 0], 0)[0]).toBeCloseTo(50, 6)
  })
  it('pulls toward a point, and drags against the motion', () => {
    expect(forceAcceleration({ ...base, type: 'point' }, [0, 0], 0, [100, 0], [0, 0], 0)[0]).toBeCloseTo(-100, 6)
    expect(forceAcceleration({ ...base, type: 'drag', strength: 50 }, [0, 0], 0, [0, 0], [200, 0], 0)[0]).toBeCloseTo(-100, 6)
  })
  it('gives turbulence that is the same for the same seed and differs between seeds', () => {
    const a = forceAcceleration({ ...base, type: 'turbulence' }, [0, 0], 0, [123, 45], [0, 0], 1.3)
    expect(forceAcceleration({ ...base, type: 'turbulence' }, [0, 0], 0, [123, 45], [0, 0], 1.3)).toEqual(a)
    expect(forceAcceleration({ ...base, type: 'turbulence', seed: 7 }, [0, 0], 0, [123, 45], [0, 0], 1.3)).not.toEqual(a)
  })
})

export type { Layer }
