import { CompSchema } from '@uve/core'
import { describe, expect, it } from 'vitest'
import { renderPlan } from './export'

const comp = (extra: Record<string, unknown>) =>
  CompSchema.parse({ id: 'c', name: 'Comp', width: 1920, height: 1080, fps: 30, durationMs: 10000, ...extra })

describe('renderPlan', () => {
  it('renders every frame that starts before the comp ends', () => {
    expect(renderPlan(comp({})).frameCount).toBe(300)
    expect(renderPlan(comp({ durationMs: 10010 })).frameCount).toBe(301)
    expect(renderPlan(comp({ durationMs: 10010 })).durationMs).toBeCloseTo(10033.33, 2)
  })

  it('counts frames exactly at fractional rates', () => {
    const plan = renderPlan(comp({ fps: 30000 / 1001, durationMs: 1001 }))
    expect(plan.frameCount).toBe(30)
    expect(plan.durationMs).toBeCloseTo(1001, 6)
  })

  it('plans a span from its first whole frame', () => {
    const whole = renderPlan(comp({}))
    expect([whole.firstFrame, whole.startMs]).toEqual([0, 0])
    const plan = renderPlan(comp({}), { startMs: 1000, endMs: 3000 })
    expect([plan.firstFrame, plan.startMs, plan.frameCount]).toEqual([30, 1000, 60])
    expect(plan.durationMs).toBeCloseTo(2000, 6)
    // A start between frames rounds up to the next frame.
    const late = renderPlan(comp({}), { startMs: 1010, endMs: 1100 })
    expect([late.firstFrame, late.frameCount]).toEqual([31, 2])
    expect(late.startMs).toBeCloseTo(1033.33, 2)
  })

  it('renders at least one frame of a span', () => {
    expect(renderPlan(comp({}), { startMs: 1000, endMs: 1001 }).frameCount).toBe(1)
  })

  it('makes both sides even', () => {
    const plan = renderPlan(comp({ width: 1081, height: 721 }))
    expect([plan.width, plan.height]).toEqual([1080, 720])
  })

  it('scales the picture and keeps sides even', () => {
    expect(renderPlan(comp({})).scale).toBe(1)
    const half = renderPlan(comp({}), undefined, { scale: 0.5 })
    expect([half.width, half.height, half.scale]).toEqual([960, 540, 0.5])
    const odd = renderPlan(comp({ width: 1001, height: 1001 }), undefined, { scale: 0.5 })
    expect([odd.width, odd.height]).toEqual([500, 500])
    const tiny = renderPlan(comp({}), undefined, { scale: 0.0001 })
    expect([tiny.width, tiny.height]).toEqual([2, 2])
  })

  it('plans at another output frame rate', () => {
    const plan = renderPlan(comp({}), undefined, { fps: 24 })
    expect([plan.fps, plan.frameCount, plan.durationMs]).toEqual([24, 240, 10000])
    const span = renderPlan(comp({}), { startMs: 1000, endMs: 3500 }, { fps: 24 })
    expect([span.firstFrame, span.frameCount]).toEqual([24, 60])
    expect(span.startMs).toBeCloseTo(1000, 6)
  })
})
