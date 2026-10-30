import { type Comp, CompSchema, defaultCamera, type Layer, LayerSchema, TrackSchema } from '@uve/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Ctx2D } from '../content'
import { CompRenderer } from '../renderer'
import type { SceneSource } from '../scene'
import { worldLoader } from '../worldLoader'
import { buildWorldFrame } from './frame'
import { BLUR_THRESHOLD_PX, holdUnblurred, planWorldBlur, sampleCount, worldShutter, worldTravel } from './worldBlur'

const W = 1920
const H = 1080
const measure = { font: '', letterSpacing: '', textAlign: 'left', textBaseline: 'alphabetic', measureText: (text: string) => ({ width: text.length * 10 }) } as unknown as Ctx2D
const source: SceneSource = { measure, media: [] }

const ramp = (path: string, from: number, to: number, ms = 1000) => ({
  [path]: [
    { t: 0, v: from, ease: 'linear' },
    { t: ms, v: to, ease: 'linear' },
  ],
})

const shape = (id: string, extra: Record<string, unknown> = {}) =>
  LayerSchema.parse({ id, name: id, kind: 'shape', startMs: 0, durationMs: 4000, shape: { type: 'rect', width: 240, height: 120 }, ...extra }) as Layer

/** A camera layer standing where the default camera does (so a picture at depth 0 is seen 1:1). */
const camera = (id: string, extra: Record<string, unknown> = {}) =>
  LayerSchema.parse({ id, name: id, kind: 'camera', startMs: 0, durationMs: 4000, transform: { y: defaultCamera(W, H).matrix[13], rotationX: 90 }, ...extra }) as Layer

const world = (layers: Layer[], extra: Record<string, unknown> = {}): Comp =>
  CompSchema.parse({
    id: 'w',
    name: 'World',
    width: W,
    height: H,
    fps: 30,
    durationMs: 4000,
    world: {},
    tracks: layers.map((layer, i) => TrackSchema.parse({ id: `t${i}`, layers: [layer] })),
    ...extra,
  }) as Comp

const builder = (comp: Comp) => (t: number) => buildWorldFrame(comp, source, t)

/** A plane moving 3000 px/s: 100 px in the 33 ms the shutter spans at most. */
const mover = () => shape('m', { animations: ramp('transform.x', 0, 3000) })

describe('which shutter a world uses', () => {
  it('needs the comp master switch', () => {
    const comp = world([mover()], { motionBlur: { enabled: false } })
    expect(worldShutter(comp, {})).toBeNull()
  })

  it('uses the comp master settings for the default camera', () => {
    const comp = world([mover()], { motionBlur: { shutterAngle: 90, maxSamples: 5 } })
    const settings = worldShutter(comp, {})
    expect(settings?.shutterAngle).toBe(90)
    expect(settings?.maxSamples).toBe(5)
  })

  it('lets the live camera layer switch blur off or bring its own shutter', () => {
    const comp = world([mover()])
    expect(worldShutter(comp, { motionBlur: { enabled: false, override: null } })).toBeNull()
    const own = { enabled: true, override: { ...comp.motionBlur, shutterAngle: 360, maxSamples: 3 } }
    expect(worldShutter(comp, { motionBlur: own })?.maxSamples).toBe(3)
    expect(worldShutter(comp, { motionBlur: { enabled: true, override: null } })?.shutterAngle).toBe(180)
  })

  it('draws nothing blurred for a closed shutter, no stretch or no strength', () => {
    expect(worldShutter(world([], { motionBlur: { shutterAngle: 0 } }), {})).toBeNull()
    expect(worldShutter(world([], { motionBlur: { amount: 0 } }), {})).toBeNull()
    expect(worldShutter(world([], { motionBlur: { strength: 0 } }), {})).toBeNull()
  })
})

describe('how many moments', () => {
  it('is about one per 1.5 px of travel plus one, at least 2, at most the shutter and the cap', () => {
    const settings = { maxSamples: 16 }
    expect(sampleCount(0.6, settings)).toBe(2)
    expect(sampleCount(6, settings)).toBe(5)
    expect(sampleCount(30, settings)).toBe(16)
    expect(sampleCount(30, { maxSamples: 8 })).toBe(8)
    expect(sampleCount(30, settings, 4)).toBe(4)
    expect(sampleCount(30, settings, 1)).toBe(2)
  })
})

describe('how far things move', () => {
  it('measures a plane that slides, in output px', () => {
    const comp = world([mover()])
    const a = buildWorldFrame(comp, source, 0)
    const b = buildWorldFrame(comp, source, 100)
    // 3000 px/s over 100 ms is 300 px, seen 1:1 by the default camera.
    expect(worldTravel(a, b, 1)).toBeCloseTo(300, 2)
    expect(worldTravel(a, b, 0.5)).toBeCloseTo(150, 2)
  })

  it('is zero for a world standing still', () => {
    const comp = world([shape('s')])
    expect(worldTravel(buildWorldFrame(comp, source, 0), buildWorldFrame(comp, source, 300), 1)).toBe(0)
  })

  it('counts a camera that moves as everything moving', () => {
    const comp = world([shape('s'), camera('c', { animations: ramp('transform.x', 0, 1000) })])
    const a = buildWorldFrame(comp, source, 0)
    const b = buildWorldFrame(comp, source, 100)
    expect(worldTravel(a, b, 1)).toBeGreaterThan(50)
  })
})

describe('planning the moments of a frame', () => {
  const timeMs = 500

  it('takes moments across the shutter, weights summing to one, the first and last at its edges', () => {
    const comp = world([mover()])
    const base = buildWorldFrame(comp, source, timeMs)
    const samples = planWorldBlur(base, builder(comp), timeMs, W)
    expect(samples).not.toBeNull()
    // 180 degrees of a 30 fps frame is 16.7 ms: 50 px of travel, 34 moments wanted, the shutter allows 16.
    expect(samples).toHaveLength(16)
    expect(samples?.reduce((sum, s) => sum + s.weight, 0)).toBeCloseTo(1, 9)
    const xs = samples?.map((s) => s.frame.planes[0]?.matrix[12] as number) as number[]
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(50, 0)
  })

  it('honours the cap and the output scale', () => {
    const comp = world([mover()])
    const base = buildWorldFrame(comp, source, timeMs)
    expect(planWorldBlur(base, builder(comp), timeMs, W, { maxSamples: 4 })).toHaveLength(4)
    // At a tenth of the size the same motion is 5 px: 5 / 1.5 rounded up, plus 1.
    expect(planWorldBlur(base, builder(comp), timeMs, W / 10)).toHaveLength(5)
  })

  it('draws no blur when it is switched off, the comp is static, or nothing moves enough', () => {
    const comp = world([mover()])
    const base = buildWorldFrame(comp, source, timeMs)
    expect(planWorldBlur(base, builder(comp), timeMs, W, { motionBlur: false })).toBeNull()
    const off = world([mover()], { motionBlur: { enabled: false } })
    expect(planWorldBlur(buildWorldFrame(off, source, timeMs), builder(off), timeMs, W)).toBeNull()
    const still = world([shape('s')])
    expect(planWorldBlur(buildWorldFrame(still, source, timeMs), builder(still), timeMs, W)).toBeNull()
    // At 1/200 of the size the motion is 0.25 px, under the threshold.
    expect(50 / 200).toBeLessThan(BLUR_THRESHOLD_PX)
    expect(planWorldBlur(base, builder(comp), timeMs, W / 200)).toBeNull()
    const frozen = world([mover()], { mode: 'static', stillMs: 500 })
    expect(planWorldBlur(buildWorldFrame(frozen, source, timeMs), builder(frozen), timeMs, W)).toBeNull()
  })

  it('uses the live camera layer shutter, and no blur when that camera has it off', () => {
    const own = camera('c', { motionBlur: { enabled: true, override: { shutterAngle: 360, shutterPhase: -180, weighting: 'box', sampling: 'transform', combine: 'average', strength: 1, amount: 1, maxSamples: 3 } } })
    const comp = world([mover(), own])
    const base = buildWorldFrame(comp, source, timeMs)
    expect(planWorldBlur(base, builder(comp), timeMs, W)).toHaveLength(3)
    const quiet = world([mover(), camera('c', { motionBlur: { enabled: false } })])
    expect(planWorldBlur(buildWorldFrame(quiet, source, timeMs), builder(quiet), timeMs, W)).toBeNull()
  })

  it('keeps the sharp frame in the mix when the strength is below one', () => {
    const comp = world([mover()], { motionBlur: { strength: 0.6 } })
    const base = buildWorldFrame(comp, source, timeMs)
    const samples = planWorldBlur(base, builder(comp), timeMs, W) ?? []
    expect(samples.reduce((sum, s) => sum + s.weight, 0)).toBeCloseTo(1, 9)
    const sharp = samples[samples.length - 1]
    expect(sharp?.frame).toBe(base)
    expect(sharp?.weight).toBeCloseTo(0.4, 9)
  })

  it('holds a layer with its own blur off at the frame time', () => {
    const held = shape('h', { animations: ramp('transform.x', 0, 3000), motionBlur: { enabled: false, override: null } })
    const comp = world([mover(), held])
    const base = buildWorldFrame(comp, source, timeMs)
    const samples = planWorldBlur(base, builder(comp), timeMs, W) ?? []
    expect(samples.length).toBeGreaterThan(2)
    const heldAt = samples.map((s) => s.frame.planes.find((p) => p.id === 'h')?.matrix[12])
    const movingAt = samples.map((s) => s.frame.planes.find((p) => p.id === 'm')?.matrix[12])
    expect(new Set(heldAt).size).toBe(1)
    expect(heldAt[0]).toBe(base.planes.find((p) => p.id === 'h')?.matrix[12])
    expect(new Set(movingAt).size).toBeGreaterThan(2)
  })

  it('swaps the held layers of one frame for those of another', () => {
    const held = shape('h', { motionBlur: { enabled: false, override: null } })
    const comp = world([held, shape('s')])
    const a = buildWorldFrame(comp, source, 0)
    const b = buildWorldFrame(comp, source, 100)
    const mixed = holdUnblurred(b, a)
    expect(mixed.planes.find((p) => p.id === 'h')).toBe(a.planes.find((p) => p.id === 'h'))
    expect(mixed.planes.find((p) => p.id === 's')).toBe(b.planes.find((p) => p.id === 's'))
  })
})

describe('depth of field on the frame camera', () => {
  it('has none for the default camera or a camera with it off', () => {
    expect(buildWorldFrame(world([shape('s')]), source, 0).camera.dof).toBeUndefined()
    expect(buildWorldFrame(world([shape('s'), camera('c')]), source, 0).camera.dof).toBeUndefined()
  })

  it('reads the focus distance and f-stop, keyed values sampled', () => {
    const c = camera('c', {
      camera: { dof: { enabled: true, focusDistance: 800, fStop: 4 } },
      animations: { ...ramp('camera.dof.focusDistance', 1000, 2000), ...ramp('camera.dof.fStop', 2, 8) },
    })
    const frame = buildWorldFrame(world([shape('s'), c]), source, 500)
    expect(frame.camera.dof?.focusDistance).toBeCloseTo(1500, 6)
    expect(frame.camera.dof?.fStop).toBeCloseTo(5, 6)
    const plain = camera('c', { camera: { dof: { enabled: true, focusDistance: 800, fStop: 4 } } })
    expect(buildWorldFrame(world([plain]), source, 0).camera.dof).toEqual({ focusDistance: 800, fStop: 4 })
  })

  it('focuses on a layer by its distance along the view axis', () => {
    // The camera looks along +Y; a picture pushed 500 px away (world y) is 500 px farther along the axis.
    const target = shape('target', { transform: { y: 500 } })
    const c = camera('c', { camera: { dof: { enabled: true, focusDistance: 100, fStop: 2.8, focusObjectId: 'target' } } })
    const frame = buildWorldFrame(world([target, c]), source, 0)
    const dof = frame.camera.dof
    expect(dof).toBeDefined()
    expect(dof?.focusDistance).not.toBe(100)
    // The default pose puts the camera at its front distance; the target is 500 px farther along the axis.
    const sameSpot = buildWorldFrame(world([shape('target'), camera('c', { camera: { dof: { enabled: true, focusDistance: 100, fStop: 2.8, focusObjectId: 'target' } } })]), source, 0)
    expect((dof?.focusDistance ?? 0) - (sameSpot.camera.dof?.focusDistance ?? 0)).toBeCloseTo(500, 6)
    expect(sameSpot.camera.dof?.focusDistance).toBeCloseTo(-(defaultCamera(W, H).matrix[13] as number), 6)
  })
})

describe('handing the render options on', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    worldLoader.module = null
  })

  const stubCanvas = () => vi.stubGlobal('OffscreenCanvas', class { getContext() { return measure } })

  const fakeCtx = () =>
    ({
      canvas: { width: 640, height: 360 },
      save: () => {},
      restore: () => {},
      setTransform: () => {},
      clearRect: () => {},
      fillRect: () => {},
      drawImage: () => {},
      getTransform: () => ({ a: 1, b: 0, c: 0, d: 1 }),
    }) as unknown as Ctx2D

  it('gives a world its render options, motion blur switch and sample cap', () => {
    stubCanvas()
    const renderWorld = vi.fn((..._args: unknown[]) => null)
    worldLoader.module = { renderWorld } as never
    const renderer = new CompRenderer()
    const comp = world([mover()])
    renderer.render(fakeCtx(), comp, { media: [], comps: [comp] }, 0, 1, undefined, { motionBlur: false, maxMotionSamples: 6 })
    expect(renderWorld).toHaveBeenCalledTimes(1)
    expect(renderWorld.mock.calls[0]?.[6]).toEqual({ motionBlur: false, maxSamples: 6 })
    renderer.render(fakeCtx(), comp, { media: [], comps: [comp] }, 0, 1)
    expect(renderWorld.mock.calls[1]?.[6]).toEqual({ motionBlur: undefined, maxSamples: undefined })
  })

  it('draws a world nested in a flat comp with the options of the render in progress', () => {
    stubCanvas()
    const renderWorld = vi.fn((..._args: unknown[]) => null)
    worldLoader.module = { renderWorld } as never
    const renderer = new CompRenderer() as unknown as {
      options: unknown
      paintWorld(ctx: Ctx2D, world: Comp, source: SceneSource, timeMs: number, width: number, height: number): void
    }
    renderer.options = { motionBlur: false, maxMotionSamples: 3 }
    const comp = world([shape('s')])
    renderer.paintWorld(fakeCtx(), comp, source, 0, 100, 100)
    expect(renderWorld.mock.calls[0]?.[6]).toEqual({ motionBlur: false, maxSamples: 3 })
  })
})
