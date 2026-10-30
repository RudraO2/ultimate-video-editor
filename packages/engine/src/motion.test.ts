import { type Comp, createDefaultProject, sequentialIds, Session } from '@uve/core'
import { describe, expect, it } from 'vitest'
import type { Ctx2D } from './content'
import { planMotion } from './motion'
import { buildScene } from './scene'

const measure = {
  font: '',
  letterSpacing: '',
  textAlign: 'left',
  textBaseline: 'alphabetic',
  measureText: (text: string) => ({ width: text.length * 10 }),
} as unknown as Ctx2D

function setup() {
  const ids = sequentialIds()
  const session = new Session({ project: createDefaultProject(ids), ids })
  const comp = () => session.project.comps[0] as Comp
  // biome-ignore lint/suspicious/noExplicitAny: test results are checked field by field
  const ok = async (name: string, input: unknown = {}): Promise<any> => {
    const result = await session.call(name, input)
    if (!result.ok) throw new Error(`${name} failed: ${result.error}`)
    return result.value
  }
  let builds = 0
  const plan = (t: number, cap?: number) => {
    builds = 0
    const build = (time: number) => {
      builds++
      return buildScene(comp(), { measure, media: [] }, time)
    }
    return planMotion(comp(), build(t), build, t, 1, cap)
  }
  return { ok, comp, plan, builds: () => builds }
}

describe('motion blur planning', () => {
  it('samples a layer that moves while the shutter is open, and leaves still ones alone', async () => {
    const { ok, plan, comp } = setup()
    // 30 fps: a 180° shutter is open 1/60 s; 3000 px/s is 50 px of travel.
    const fast = await ok('layer.create', { kind: 'shape', width: 100, height: 100 })
    await ok('keyframes.set', { id: fast.id, property: 'x', keys: [{ at: 0, value: 0, easing: 'linear' }, { at: 1000, value: 3000 }] })
    const still = await ok('layer.create', { kind: 'shape', width: 100, height: 100, y: 200 })
    expect(comp().fps).toBe(30)
    const motion = plan(500)
    expect([...motion.keys()]).toEqual([fast.id])
    const moving = motion.get(fast.id)!
    // About one moment per 1.5 px, at most the shutter's 16.
    expect(moving.samples).toHaveLength(16)
    expect(moving.samples.reduce((a, s) => a + s.weight, 0)).toBeCloseTo(1)
    expect(motion.has(still.id)).toBe(false)
    expect(plan(500, 4).get(fast.id)!.samples).toHaveLength(4)
  })

  it('obeys the comp master switch and the layer switch', async () => {
    const { ok, plan, comp } = setup()
    const a = await ok('layer.create', { kind: 'shape' })
    await ok('keyframes.set', { id: a.id, property: 'x', keys: [{ at: 0, value: 0 }, { at: 1000, value: 2000 }] })
    expect(plan(500).size).toBe(1)
    await ok('layer.patch', { id: a.id, ops: [{ op: 'set', path: 'motionBlur.enabled', value: false }] })
    expect(plan(500).size).toBe(0)
    await ok('layer.patch', { id: a.id, ops: [{ op: 'set', path: 'motionBlur.enabled', value: true }] })
    await ok('comp.update', { id: comp().id, motionBlur: { enabled: false } })
    expect(plan(500).size).toBe(0)
  })

  it('builds only the shutter ends when nothing moves', async () => {
    const { ok, plan, builds } = setup()
    await ok('layer.create', { kind: 'shape' })
    expect(plan(500).size).toBe(0)
    expect(builds()).toBe(3)
  })
})
