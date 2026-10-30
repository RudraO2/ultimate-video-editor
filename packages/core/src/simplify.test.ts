import { describe, expect, it } from 'vitest'
import { createDefaultProject } from './doc'
import { ease } from './easing'
import { sequentialIds } from './ids'
import { sampleKeys } from './interpolate'
import { Session } from './session'

function setup(view: { playheadMs?: number; compId?: string } = {}) {
  const ids = sequentialIds()
  const session = new Session({ project: createDefaultProject(ids), ids, view: () => view })
  // biome-ignore lint/suspicious/noExplicitAny: test results are checked field by field
  const ok = async (name: string, input: unknown = {}): Promise<any> => {
    const result = await session.call(name, input)
    if (!result.ok) throw new Error(`${name} failed: ${result.error}`)
    return result.value
  }
  const fail = async (name: string, input: unknown) => {
    const result = await session.call(name, input)
    if (result.ok) throw new Error(`${name} should have failed`)
    return `${result.error} ${result.hint ?? ''}`
  }
  const layer = (id: string) => session.project.comps[0]?.tracks.flatMap((t) => t.layers).find((l) => l.id === id)
  const fps = session.project.comps[0]?.fps ?? 30
  return { session, ok, fail, layer, fps }
}

type Setup = ReturnType<typeof setup>

/** One linear key per frame for `frames` frames, valued by `f(progress 0..1)`. */
const baked = (fps: number, frames: number, f: (p: number) => number) =>
  Array.from({ length: frames }, (_, i) => ({ t: (i * 1000) / fps, v: f(i / (frames - 1)), ease: 'linear' }))

/** The largest difference between two key lists, over every frame. */
function worstGap(fps: number, a: readonly any[], b: readonly any[], frames: number, startMs = 0): number {
  let worst = 0
  for (let i = 0; i < frames; i++) {
    const t = (i * 1000) / fps - startMs
    worst = Math.max(worst, Math.abs((sampleKeys(a, t) as number) - (sampleKeys(b, t) as number)))
  }
  return worst
}

async function shapeWith(s: Setup, path: string, keys: unknown[]) {
  await s.ok('layer.create', { kind: 'shape' })
  await s.ok('keyframes.set', { id: 'layer_1', path, keys })
}

describe('keyframes.simplify', () => {
  it('turns a baked linear ramp into two keys with exact ends', async () => {
    const s = setup()
    await shapeWith(s, 'opacity', baked(s.fps, 60, (p) => p))
    const result = await s.ok('keyframes.simplify', { id: 'layer_1' })
    expect(result).toMatchObject({ keysBefore: 60, keysAfter: 2 })
    const keys = s.layer('layer_1')?.animations['transform.opacity'] ?? []
    expect(keys).toHaveLength(2)
    expect(keys[0]).toMatchObject({ t: 0, v: 0 })
    expect(keys[1]).toMatchObject({ t: (59 * 1000) / s.fps, v: 1 })
  })

  it('fits a baked ease-out curve in a few keys, within tolerance on every frame', async () => {
    const s = setup()
    await shapeWith(s, 'x', baked(s.fps, 45, (p) => -300 + 600 * ease('ease-out', p)))
    const before = [...(s.layer('layer_1')?.animations['transform.x'] ?? [])]
    await s.ok('keyframes.simplify', { id: 'layer_1' })
    const after = s.layer('layer_1')?.animations['transform.x'] ?? []
    expect(after.length).toBeLessThanOrEqual(4)
    expect(worstGap(s.fps, before, after, 45)).toBeLessThanOrEqual(0.5)
  })

  it('fits a curve that is no preset with a bezier of its own', async () => {
    const s = setup()
    await shapeWith(s, 'rotation', baked(s.fps, 60, (p) => 90 * ease({ type: 'bezier', x1: 0.2, y1: 0.8, x2: 0.7, y2: 1.15 }, p)))
    const before = [...(s.layer('layer_1')?.animations['transform.rotation'] ?? [])]
    await s.ok('keyframes.simplify', { id: 'layer_1' })
    const after = s.layer('layer_1')?.animations['transform.rotation'] ?? []
    expect(after.length).toBeLessThanOrEqual(4)
    expect(worstGap(s.fps, before, after, 60)).toBeLessThanOrEqual(0.25)
  })

  it('reduces a baked x/y path together, on shared key times', async () => {
    const s = setup()
    await s.ok('layer.create', { kind: 'shape' })
    const frames = 60
    await s.ok('keyframes.set', { id: 'layer_1', path: 'x', keys: baked(s.fps, frames, (p) => -400 + 800 * p) })
    await s.ok('keyframes.set', { id: 'layer_1', path: 'y', keys: baked(s.fps, frames, (p) => 200 * ease('ease-out', p)) })
    const x0 = [...(s.layer('layer_1')?.animations['transform.x'] ?? [])]
    const y0 = [...(s.layer('layer_1')?.animations['transform.y'] ?? [])]
    const result = await s.ok('keyframes.simplify', { id: 'layer_1', properties: ['position'] })
    expect(result.tracks.map((t: { path: string }) => t.path)).toEqual(['transform.x', 'transform.y'])
    const ax = s.layer('layer_1')?.animations['transform.x'] ?? []
    const ay = s.layer('layer_1')?.animations['transform.y'] ?? []
    expect(ax.length).toBeLessThanOrEqual(3)
    expect(ax.map((k) => k.t)).toEqual(ay.map((k) => k.t))
    for (let i = 0; i < frames; i++) {
      const t = (i * 1000) / s.fps
      const dx = (sampleKeys(x0, t) as number) - (sampleKeys(ax, t) as number)
      const dy = (sampleKeys(y0, t) as number) - (sampleKeys(ay, t) as number)
      expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(0.5)
    }
  })

  it('fits an arc to its very end, with no run of one-frame keys', async () => {
    const s = setup()
    await s.ok('layer.create', { kind: 'shape' })
    const frames = 60
    await s.ok('keyframes.set', { id: 'layer_1', path: 'x', keys: baked(s.fps, frames, (p) => 300 * Math.cos(p * Math.PI)) })
    await s.ok('keyframes.set', { id: 'layer_1', path: 'y', keys: baked(s.fps, frames, (p) => 200 * Math.sin(p * Math.PI)) })
    const x0 = [...(s.layer('layer_1')?.animations['transform.x'] ?? [])]
    const y0 = [...(s.layer('layer_1')?.animations['transform.y'] ?? [])]
    await s.ok('keyframes.simplify', { id: 'layer_1' })
    const ax = s.layer('layer_1')?.animations['transform.x'] ?? []
    const ay = s.layer('layer_1')?.animations['transform.y'] ?? []
    expect(ax.length).toBeLessThanOrEqual(8)
    const frameMs = 1000 / s.fps
    const oneFrame = ax.slice(1).filter((k, i) => k.t - (ax[i]?.t ?? 0) < 1.5 * frameMs).length
    expect(oneFrame).toBeLessThanOrEqual(1)
    for (let i = 0; i < frames; i++) {
      const t = i * frameMs
      const dx = (sampleKeys(x0, t) as number) - (sampleKeys(ax, t) as number)
      const dy = (sampleKeys(y0, t) as number) - (sampleKeys(ay, t) as number)
      expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(0.5)
    }
  })

  it('keeps a hold step as a step', async () => {
    const s = setup()
    await shapeWith(s, 'opacity', baked(s.fps, 30, (p) => (p < 0.5 ? 0 : 1)))
    const before = [...(s.layer('layer_1')?.animations['transform.opacity'] ?? [])]
    await s.ok('keyframes.simplify', { id: 'layer_1' })
    const after = s.layer('layer_1')?.animations['transform.opacity'] ?? []
    expect(after.length).toBeLessThanOrEqual(3)
    expect(worstGap(s.fps, before, after, 30)).toBeLessThanOrEqual(0.01)
  })

  it('leaves colour tracks alone', async () => {
    const s = setup()
    await s.ok('layer.create', { kind: 'text', text: 'Hi' })
    await s.ok('keyframes.set', {
      id: 'layer_1',
      path: 'color',
      keys: [
        { t: 0, v: '#ff0000' },
        { t: 300, v: '#00ff00' },
        { t: 600, v: '#0000ff' },
        { t: 900, v: '#ffffff' },
      ],
    })
    await s.ok('keyframes.set', { id: 'layer_1', path: 'opacity', keys: baked(s.fps, 30, (p) => p) })
    const result = await s.ok('keyframes.simplify', { id: 'layer_1' })
    expect(result.tracks.map((t: { path: string }) => t.path)).toEqual(['transform.opacity'])
    expect(s.layer('layer_1')?.animations['style.color']).toHaveLength(4)
    expect(await s.fail('keyframes.simplify', { id: 'layer_1', properties: ['color'] })).toMatch(/no numeric track/)
  })

  it('on a comp touches baked tracks only', async () => {
    const s = setup()
    await s.ok('layer.create', { kind: 'shape' })
    await s.ok('layer.create', { kind: 'shape' })
    await s.ok('keyframes.set', { id: 'layer_1', path: 'rotation', keys: baked(s.fps, 30, (p) => 360 * p) })
    await s.ok('keyframes.set', {
      id: 'layer_2',
      path: 'x',
      keys: [{ t: 0, v: 0, ease: 'linear' }, { t: 400, v: 50, ease: 'linear' }, { t: 800, v: 100, ease: 'linear' }],
    })
    const compId = s.session.project.comps[0]?.id
    const result = await s.ok('keyframes.simplify', { frameId: compId })
    expect(result.tracks).toEqual([{ layerId: 'layer_1', path: 'transform.rotation', before: 30, after: 2 }])
    expect(s.layer('layer_2')?.animations['transform.x']).toHaveLength(3)
    // With neither id nor comp, the comp open in the editor (here the only one).
    expect(await s.ok('keyframes.simplify')).toMatchObject({ tracks: [], note: 'No baked tracks in this comp.' })
  })

  it('tolerance changes the result', async () => {
    const s = setup()
    const noisy = baked(s.fps, 45, (p) => 200 * p + 3 * Math.sin(p * 40))
    await shapeWith(s, 'x', noisy)
    const loose = await s.ok('keyframes.simplify', { id: 'layer_1', tolerance: 20 })
    expect(loose.keysAfter).toBe(2)
    await s.session.undo()
    expect(s.layer('layer_1')?.animations['transform.x']).toHaveLength(45)
    const tight = await s.ok('keyframes.simplify', { id: 'layer_1', tolerance: 0.1 })
    expect(tight.keysAfter).toBeGreaterThan(loose.keysAfter)
  })

  it('is one undo step, and undo restores the keys', async () => {
    const s = setup()
    await shapeWith(s, 'opacity', baked(s.fps, 60, (p) => p))
    const before = JSON.parse(JSON.stringify(s.layer('layer_1')?.animations))
    await s.ok('keyframes.simplify', { id: 'layer_1' })
    expect(s.layer('layer_1')?.animations['transform.opacity']).toHaveLength(2)
    await s.session.undo()
    expect(s.layer('layer_1')?.animations).toEqual(before)
  })

  it('refuses properties without id, and a layer with nothing to simplify', async () => {
    const s = setup()
    await shapeWith(s, 'opacity', [{ t: 0, v: 0 }, { t: 500, v: 1 }])
    expect(await s.fail('keyframes.simplify', { properties: ['opacity'] })).toMatch(/needs id/)
    expect(await s.fail('keyframes.simplify', { id: 'layer_1' })).toMatch(/3 or more keys/)
  })

  it('is fast on a long baked track', async () => {
    const s = setup()
    await shapeWith(s, 'x', baked(60, 601, (p) => 500 * ease('ease-in-out-back', p)))
    const started = Date.now()
    await s.ok('keyframes.simplify', { id: 'layer_1' })
    expect(Date.now() - started).toBeLessThan(1000)
  })
})
