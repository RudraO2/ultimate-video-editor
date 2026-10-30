import { describe, expect, it } from 'vitest'
import { DOF_MAX_BLUR, dofAperture, focusAlong, focusDistanceOf } from './dof'
import { bloomSizes, dofTaps } from './post'
import { aoFactor, BLOOM_KERNELS, BLOOM_LEVELS, bloomLevelWeight, finishBlend, postPlan } from './postMath'

const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

describe('depth of field numbers', () => {
  it('uses aperture = f^2 / (N (s - f) s sensor) in metres', () => {
    // 50 mm lens, f/2.8, focus at 1000 px = 10 m, 36 mm sensor.
    const f = 0.05
    const s = 10
    expect(dofAperture(50, 2.8, 1000, 36)).toBeCloseTo((f * f) / (2.8 * (s - f) * s * 0.036), 12)
  })

  it('blurs more with a wider lens opening, a longer lens and a closer focus', () => {
    const base = dofAperture(50, 2.8, 1000, 36)
    expect(dofAperture(50, 1.4, 1000, 36)).toBeGreaterThan(base)
    expect(dofAperture(85, 2.8, 1000, 36)).toBeGreaterThan(base)
    expect(dofAperture(50, 2.8, 300, 36)).toBeGreaterThan(base)
  })

  it('holds a focus nearer than the focal length just past it', () => {
    const near = dofAperture(50, 2.8, 1, 36)
    expect(Number.isFinite(near)).toBe(true)
    expect(near).toBeGreaterThan(0)
  })

  it('measures the distance to the focused object along the view axis, not as a straight line', () => {
    // A camera at (0, -1000, 0) looking along +Y (camera local -Z points to world +Y).
    const camera = identity()
    camera[8] = 0
    camera[9] = -1
    camera[10] = 0
    camera[13] = -1000
    expect(focusAlong(camera, [0, 0, 0])).toBeCloseTo(1000, 9)
    // Off to the side: the distance along the axis is the same.
    expect(focusAlong(camera, [400, 0, 300])).toBeCloseTo(1000, 9)
    expect(focusAlong(camera, [0, -1500, 0])).toBeCloseTo(-500, 9)
  })

  it('takes the focus object when it is in the world and in front, else the focus distance', () => {
    const camera = identity()
    camera[14] = 1000
    const objects = [{ layer: { id: 'a' }, position: [0, 0, 250] }] as never
    expect(focusDistanceOf(camera, 'a', objects, 777)).toBeCloseTo(750, 9)
    expect(focusDistanceOf(camera, 'missing', objects, 777)).toBe(777)
    expect(focusDistanceOf(camera, null, objects, 777)).toBe(777)
    const behind = [{ layer: { id: 'b' }, position: [0, 0, 2000] }] as never
    expect(focusDistanceOf(camera, 'b', behind, 777)).toBe(777)
  })

  it('keeps the widest blur at three hundredths of the picture', () => {
    expect(DOF_MAX_BLUR).toBe(0.03)
  })

  it('has 41 bokeh taps, the first at the centre', () => {
    const taps = dofTaps()
    expect(taps).toHaveLength(41)
    expect(taps[0]?.length()).toBe(0)
    expect(Math.max(...taps.map((t) => t.length()))).toBeLessThanOrEqual(0.4 + 1e-9)
  })
})

describe('the finish blend', () => {
  it('leaves the picture alone when there is no glow', () => {
    expect(finishBlend([0.2, 0.4, 0.6, 0.8], [0, 0, 0])).toEqual([0.2, 0.4, 0.6, 0.8])
  })

  it('screens the glow over the colour', () => {
    const [r, g, b] = finishBlend([0.5, 0.2, 0, 1], [0.5, 0.5, 0.5])
    expect(r).toBeCloseTo(0.75, 9)
    expect(g).toBeCloseTo(0.6, 9)
    expect(b).toBeCloseTo(0.5, 9)
  })

  it('lets the glow raise the alpha over a transparent world', () => {
    const out = finishBlend([0, 0, 0, 0], [0.3, 0.6, 0.1])
    expect(out).toEqual([0.3, 0.6, 0.1, 0.6])
    // Premultiplied: no channel is above the alpha.
    expect(Math.max(out[0], out[1], out[2])).toBeLessThanOrEqual(out[3])
  })

  it('clamps and never lowers the alpha', () => {
    const out = finishBlend([0.9, 0.9, 0.9, 0.95], [5, 5, 5])
    expect(out).toEqual([1, 1, 1, 1])
    expect(finishBlend([0.1, 0.1, 0.1, 0.7], [0.1, 0.1, 0.1])[3]).toBeCloseTo(0.7, 9)
  })
})

describe('bloom and occlusion numbers', () => {
  it('weights the five levels, tight first at radius 0 and turned round at radius 1', () => {
    expect(BLOOM_LEVELS.map((f) => bloomLevelWeight(f, 0))).toEqual([1, 0.8, 0.6, 0.4, 0.2])
    const wide = BLOOM_LEVELS.map((f) => bloomLevelWeight(f, 1))
    expect(wide[0]).toBeCloseTo(0.2, 9)
    expect(wide[4]).toBeCloseTo(1, 9)
  })

  it('sizes the levels from 256 on the longer side, halving each time', () => {
    const sizes = bloomSizes(1920, 1080)
    expect(sizes).toHaveLength(BLOOM_KERNELS.length)
    expect(sizes[0]).toEqual([256, 144])
    expect(sizes[1]).toEqual([128, 72])
    expect(sizes[4]).toEqual([16, 9])
    expect(bloomSizes(1080, 1920)[0]).toEqual([144, 256])
  })

  it('multiplies by 1 - strength * (1 - occlusion), within 0 and 1', () => {
    expect(aoFactor(1, 1)).toBe(1)
    expect(aoFactor(0.4, 1)).toBeCloseTo(0.4, 9)
    expect(aoFactor(0.4, 0.5)).toBeCloseTo(0.7, 9)
    expect(aoFactor(0.4, 2)).toBe(0)
    expect(aoFactor(0.4, 0)).toBe(1)
  })
})

describe('what a frame needs', () => {
  const render = (ao: boolean, bloom: boolean, source: 'bright' | 'emission' = 'bright') => ({ ao: { enabled: ao }, bloom: { enabled: bloom, source } })

  it('needs no post pass when everything is off, so the frame goes straight to the canvas', () => {
    expect(postPlan(render(false, false), false).any).toBe(false)
  })

  it('needs one for each effect on its own', () => {
    expect(postPlan(render(true, false), false)).toMatchObject({ ao: true, any: true })
    expect(postPlan(render(false, false), true)).toMatchObject({ dof: true, any: true })
    expect(postPlan(render(false, true), false)).toMatchObject({ bloom: true, emission: false, any: true })
    expect(postPlan(render(false, true, 'emission'), false)).toMatchObject({ bloom: true, emission: true })
  })

  it('draws the emission pass only for a bloom that is on', () => {
    expect(postPlan(render(false, false, 'emission'), false).emission).toBe(false)
  })
})
