import { describe, expect, it } from 'vitest'
import { deepClone } from './clone'
import { createDefaultProject } from './doc'
import { ease } from './easing'
import { sequentialIds } from './ids'
import { motionPointAt } from './motionPath'
import { evaluateProperty, resolveProperty } from './properties'
import type { Keyframe, Layer, Project } from './schema'
import { Session } from './session'
import { monotoneSlopes, smoothEasing } from './smooth'

function setup() {
  const ids = sequentialIds()
  const session = new Session({ project: createDefaultProject(ids), ids, view: () => ({}) })
  // biome-ignore lint/suspicious/noExplicitAny: test results are checked field by field
  const ok = async (name: string, input: unknown = {}): Promise<any> => {
    const result = await session.call(name, input)
    if (!result.ok) throw new Error(`${name} failed: ${result.error}`)
    return result.value
  }
  const fail = async (name: string, input: unknown) => {
    const result = await session.call(name, input)
    if (result.ok) throw new Error(`${name} should have failed`)
    return result as { ok: false; error: string; hint?: string }
  }
  const layer = () => session.project.comps[0]?.tracks.flatMap((t) => t.layers).find((l) => l.id === 'layer_1') as Layer
  const edit = async (change: (layer: Layer) => void) => {
    const project = deepClone(session.project) as Project
    change(project.comps[0]?.tracks.flatMap((t) => t.layers).find((l) => l.id === 'layer_1') as Layer)
    await session.replace(project)
  }
  const smooth = (input: Record<string, unknown> = {}) => ok('keyframes.smooth', { id: 'layer_1', ...input })
  return { session, ok, fail, layer, edit, smooth }
}

/** A shape keyed at the given [t, x, y] stops. */
async function path(stops: [number, number, number][], easing = 'linear') {
  const s = setup()
  await s.ok('layer.create', { kind: 'shape' })
  await s.ok('keyframes.set', { id: 'layer_1', path: 'position', keys: stops.map(([t, x, y]) => ({ t, v: [x, y], ease: easing })) })
  return s
}

/** A shape with an opacity track at the given [t, v] keys. */
async function fade(stops: [number, number][], easing = 'ease-in') {
  const s = setup()
  await s.ok('layer.create', { kind: 'shape' })
  await s.ok('keyframes.set', { id: 'layer_1', path: 'opacity', keys: stops.map(([t, v]) => ({ t, v, ease: easing })) })
  return s
}

function position(layer: Layer, t: number): [number, number] {
  const curved = motionPointAt(layer, t)
  if (curved) return curved
  const at = (name: string) => evaluateProperty(layer, resolveProperty(layer, name)[0]!, t) as number
  return [at('x'), at('y')]
}

const opacityAt = (layer: Layer, t: number) => evaluateProperty(layer, resolveProperty(layer, 'opacity')[0]!, t) as number

/** The speed just before and just after time `t`. */
function speeds(at: (t: number) => number[], t: number, dt = 0.01): [number, number] {
  const p = at(t)
  const before = at(t - dt)
  const after = at(t + dt)
  const dist = (a: number[], b: number[]) => Math.hypot(...a.map((v, i) => v - (b[i] as number)))
  return [dist(p, before) / dt, dist(after, p) / dt]
}

describe('monotoneSlopes', () => {
  it('follows the chord of two points', () => {
    expect(monotoneSlopes([0, 10], [0, 5])).toEqual([0.5, 0.5])
  })

  it('keeps monotone data monotone and flat at an extremum', () => {
    const rising = monotoneSlopes([0, 1, 2, 3], [0, 1, 4, 5])
    for (const m of rising) expect(m).toBeGreaterThanOrEqual(0)
    const peak = monotoneSlopes([0, 1, 2], [0, 5, 0])
    expect(peak[1]).toBe(0)
  })

  it('gives straight data its own slope', () => {
    for (const m of monotoneSlopes([0, 1, 3, 6], [0, 2, 6, 12])) expect(m).toBeCloseTo(2, 9)
  })

  it('never exceeds three times the chord slope at an end', () => {
    const m = monotoneSlopes([0, 1, 2], [0, 1, 1.1])
    expect(Math.abs(m[0] as number)).toBeLessThanOrEqual(3)
  })
})

describe('smoothEasing', () => {
  it('is linear when both slopes are 1', () => {
    expect(smoothEasing(1, 1)).toBe('linear')
  })

  it('is a Hermite Bézier with its x handles on the thirds', () => {
    const easing = smoothEasing(0.5, 2)
    expect(easing).toEqual({ type: 'bezier', x1: 0.333333, y1: 0.166667, x2: 0.666667, y2: 0.333333 })
    const dt = 1e-4
    expect((ease(easing, dt) - ease(easing, 0)) / dt).toBeCloseTo(0.5, 2)
    expect((ease(easing, 1) - ease(easing, 1 - dt)) / dt).toBeCloseTo(2, 2)
  })
})

describe('keyframes.smooth on a motion path', () => {
  const stops: [number, number, number][] = [
    [0, 0, 0],
    [300, 200, 100],
    [1000, 400, 0],
  ]

  it('gives each key Catmull-Rom handles, none outside the ends', async () => {
    const s = await path(stops)
    const result = await s.smooth()
    expect(result.curved).toBe(3)
    expect(result.tracks).toEqual([
      { path: 'transform.x', keys: 3 },
      { path: 'transform.y', keys: 3 },
    ])
    const xs = s.layer().animations['transform.x'] as Keyframe[]
    expect(xs[0]?.spatial?.in).toBeNull()
    expect(xs[0]?.spatial?.out).toEqual([200 / 6, 100 / 6])
    expect(xs[1]?.spatial?.in?.[0]).toBeCloseTo(-400 / 6, 9)
    expect(xs[1]?.spatial?.in?.[1]).toBeCloseTo(0, 9)
    expect(xs[1]?.spatial?.out?.[0]).toBeCloseTo(400 / 6, 9)
    expect(xs[1]?.spatial?.out?.[1]).toBeCloseTo(0, 9)
    expect(xs[2]?.spatial?.in).toEqual([-200 / 6, 100 / 6])
    expect(xs[2]?.spatial?.out).toBeNull()
    // x and y of a segment share the easing; the last key keeps its own
    const ys = s.layer().animations['transform.y'] as Keyframe[]
    expect(xs[0]?.ease).toEqual(ys[0]?.ease)
    expect(xs[1]?.ease).toEqual(ys[1]?.ease)
    expect(xs[2]?.ease).toBe('linear')
    expect(typeof xs[0]?.ease).toBe('object')
  })

  it('moves at the same speed either side of the middle key', async () => {
    const s = await path(stops)
    await s.smooth()
    const layer = s.layer()
    const [before, after] = speeds((t) => position(layer, t), 300)
    expect(before).toBeGreaterThan(0)
    expect(Math.abs(before - after) / before).toBeLessThan(0.01)
  })

  it('still passes through every key and stays within the keys in time', async () => {
    const s = await path(stops)
    await s.smooth()
    const layer = s.layer()
    expect(position(layer, 0)).toEqual([0, 0])
    const mid = position(layer, 300)
    expect(mid[0]).toBeCloseTo(200, 6)
    expect(mid[1]).toBeCloseTo(100, 6)
    const end = position(layer, 1000)
    expect(end[0]).toBeCloseTo(400, 6)
  })

  it('leaves a straight two-key path straight and linear', async () => {
    const s = await path(
      [
        [0, 0, 0],
        [1000, 300, 400],
      ],
      'ease-in-out',
    )
    const result = await s.smooth()
    expect(result.curved).toBeUndefined()
    const layer = s.layer()
    expect(layer.animations['transform.x']?.[0]?.spatial).toBeUndefined()
    expect(layer.animations['transform.x']?.[0]?.ease).toBe('linear')
    expect(layer.animations['transform.y']?.[0]?.ease).toBe('linear')
    const [x, y] = position(layer, 500)
    expect(x).toBeCloseTo(150, 6)
    expect(y).toBeCloseTo(200, 6)
  })

  it('keeps the first key\'s existing in and the last key\'s out', async () => {
    const s = await path(stops)
    await s.edit((layer) => {
      const xs = layer.animations['transform.x'] as Keyframe[]
      ;(xs[0] as Keyframe).spatial = { in: [5, 6], out: null }
      ;(xs[2] as Keyframe).spatial = { in: null, out: [7, 8] }
    })
    await s.smooth()
    const xs = s.layer().animations['transform.x'] as Keyframe[]
    expect(xs[0]?.spatial?.in).toEqual([5, 6])
    expect(xs[2]?.spatial?.out).toEqual([7, 8])
  })

  it('smooths x and y alone when keys are unpaired', async () => {
    const s = await path(stops)
    await s.ok('keyframes.set', { id: 'layer_1', path: 'x', mode: 'merge', keys: [{ t: 600, v: 300, ease: 'linear' }] })
    const result = await s.smooth()
    expect(result.curved).toBeUndefined()
    expect(s.layer().animations['transform.x']?.some((k) => k.spatial)).toBe(false)
    expect(result.tracks).toEqual([
      { path: 'transform.x', keys: 4 },
      { path: 'transform.y', keys: 3 },
    ])
  })
})

describe('keyframes.smooth on a numeric track', () => {
  const stops: [number, number][] = [
    [0, 0],
    [300, 0.2],
    [1000, 1],
  ]

  it('moves at the same speed either side of a key', async () => {
    const s = await fade(stops)
    const result = await s.smooth({ properties: ['opacity'] })
    expect(result.tracks).toEqual([{ path: 'transform.opacity', keys: 3 }])
    const layer = s.layer()
    const [before, after] = speeds((t) => [opacityAt(layer, t)], 300)
    expect(before).toBeGreaterThan(0)
    expect(Math.abs(before - after) / before).toBeLessThan(0.01)
    expect(opacityAt(layer, 300)).toBeCloseTo(0.2, 9)
  })

  it('does not overshoot the keys', async () => {
    const s = await fade([
      [0, 0],
      [300, 1],
      [600, 0.9],
      [1000, 0],
    ])
    await s.smooth()
    const layer = s.layer()
    for (let t = 0; t <= 1000; t += 10) {
      const v = opacityAt(layer, t)
      expect(v).toBeGreaterThanOrEqual(-1e-6)
      expect(v).toBeLessThanOrEqual(1 + 1e-6)
    }
  })

  it('makes a segment between equal values linear', async () => {
    const s = await fade([
      [0, 0.5],
      [500, 0.5],
      [1000, 1],
    ])
    await s.smooth()
    expect(s.layer().animations['transform.opacity']?.[0]?.ease).toBe('linear')
  })

  it('smooths every numeric track when no properties are given and skips colours', async () => {
    const s = setup()
    await s.ok('layer.create', { kind: 'text', text: 'Hi' })
    await s.ok('keyframes.set', { id: 'layer_1', path: 'opacity', keys: stops.map(([t, v]) => ({ t, v, ease: 'ease-in' })) })
    await s.ok('keyframes.set', {
      id: 'layer_1',
      path: 'color',
      keys: [
        { t: 0, v: '#ff0000', ease: 'hold' },
        { t: 500, v: '#00ff00' },
      ],
    })
    const result = await s.smooth()
    expect(result.tracks).toEqual([{ path: 'transform.opacity', keys: 3 }])
    expect(s.layer().animations['style.color']?.[0]?.ease).toBe('hold')
  })
})

describe('keyframes.smooth range', () => {
  it('changes only the keys between fromMs and toMs (comp time)', async () => {
    const s = await fade([
      [0, 0],
      [500, 0.3],
      [1000, 0.8],
      [1500, 1],
    ])
    await s.edit((layer) => {
      layer.startMs = 1000
    })
    const result = await s.smooth({ fromMs: 1500, toMs: 2500 })
    expect(result.tracks).toEqual([{ path: 'transform.opacity', keys: 3 }])
    const keys = s.layer().animations['transform.opacity'] as Keyframe[]
    expect(keys[0]?.ease).toBe('ease-in')
    expect(keys[1]?.ease).not.toBe('ease-in')
    expect(keys[2]?.ease).not.toBe('ease-in')
    expect(keys[3]?.ease).toBe('ease-in')
  })

  it('leaves the keys of a path outside the range alone', async () => {
    const s = await path([
      [0, 0, 0],
      [500, 100, 50],
      [1000, 200, 0],
      [1500, 300, 50],
    ])
    await s.smooth({ fromMs: 500 })
    const xs = s.layer().animations['transform.x'] as Keyframe[]
    expect(xs[0]?.ease).toBe('linear')
    expect(xs[0]?.spatial).toBeUndefined()
    expect(xs[1]?.spatial?.in).toBeNull()
    expect(xs[1]?.spatial?.out).not.toBeNull()
    expect(xs[3]?.spatial?.in).not.toBeNull()
    expect(xs[3]?.spatial?.out).toBeNull()
    expect(xs[3]?.ease).toBe('linear')
  })
})

describe('keyframes.smooth refusals', () => {
  it('refuses when no track has two keys in range', async () => {
    const s = await fade([
      [0, 0],
      [500, 1],
    ])
    const error = await s.fail('keyframes.smooth', { id: 'layer_1', fromMs: 5000 })
    expect(error.error).toContain('has no keys to smooth between')
    expect(error.hint).toContain('keyframes.inspect')
  })

  it('refuses a layer with nothing keyed', async () => {
    const s = setup()
    await s.ok('layer.create', { kind: 'shape' })
    const error = await s.fail('keyframes.smooth', { id: 'layer_1' })
    expect(error.error).toContain('has no keys to smooth.')
  })

  it('refuses a property that is not numeric', async () => {
    const s = setup()
    await s.ok('layer.create', { kind: 'text', text: 'Hi' })
    const error = await s.fail('keyframes.smooth', { id: 'layer_1', properties: ['color'] })
    expect(error.error).toBe('color is not a numeric property.')
    expect(error.hint).toContain('colours')
  })

  it('refuses fromMs after toMs', async () => {
    const s = await fade([
      [0, 0],
      [500, 1],
    ])
    const error = await s.fail('keyframes.smooth', { id: 'layer_1', fromMs: 400, toMs: 100 })
    expect(error.error).toContain('fromMs')
  })

  it('rejects unknown fields', async () => {
    const s = await fade([
      [0, 0],
      [500, 1],
    ])
    await s.fail('keyframes.smooth', { id: 'layer_1', tension: 1 })
  })

  it('leaves no trace when it fails', async () => {
    const s = await fade([
      [0, 0],
      [500, 1],
    ])
    const before = JSON.stringify(s.session.project)
    await s.fail('keyframes.smooth', { id: 'layer_1', fromMs: 5000 })
    expect(JSON.stringify(s.session.project)).toBe(before)
  })
})

describe('keyframes.smooth undo', () => {
  it('is one undo step that restores the exact keys', async () => {
    const s = await path([
      [0, 0, 0],
      [300, 200, 100],
      [1000, 400, 0],
    ])
    const before = JSON.stringify(s.layer().animations)
    await s.smooth()
    expect(s.session.undoLabel).toBe('Smooth keys')
    expect(JSON.stringify(s.layer().animations)).not.toBe(before)
    expect(s.session.undo()).toBe(true)
    expect(JSON.stringify(s.layer().animations)).toBe(before)
  })
})
