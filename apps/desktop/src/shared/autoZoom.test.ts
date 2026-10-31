import { describe, expect, it } from 'vitest'
import { planAutoZoom, recordedClicks, zoomKeyframes, ZOOM_DEPTH_SCALES } from './autoZoom'
import type { CursorRecording, CursorSample } from './recording'

const move = (timeMs: number, cx = 0.5, cy = 0.5): CursorSample => ({ timeMs, cx, cy, assetId: null, visible: true, cursorType: 'arrow', interactionType: 'move' })
const click = (timeMs: number, cx: number, cy: number): CursorSample[] => [
  { ...move(timeMs, cx, cy), interactionType: 'click' },
  { ...move(timeMs + 80, cx, cy), interactionType: 'mouseup' },
]
const recording = (samples: CursorSample[], surface?: CursorRecording['surface']): CursorRecording => ({ version: 2, provider: 'native', samples, assets: [], ...(surface ? { surface } : {}) })

describe('planAutoZoom (OpenScreen port)', () => {
  it('zooms on a click, starting before it and holding after', () => {
    const rec = recording([move(0), ...click(5000, 0.3, 0.4), move(15000)])
    const [shot, ...rest] = planAutoZoom(rec, { fromMs: 0, toMs: 15000 })
    expect(rest).toHaveLength(0)
    expect(shot).toMatchObject({ startMs: 4500, endMs: 6500, clicks: 1, scale: ZOOM_DEPTH_SCALES[3] })
    expect(shot!.cx).toBeCloseTo(0.3)
    expect(shot!.cy).toBeCloseTo(0.4)
  })

  it('keeps the opening wide and ignores the click on Stop', () => {
    const rec = recording([move(0), ...click(500, 0.5, 0.5), ...click(9600, 0.5, 0.5), move(10000)])
    expect(planAutoZoom(rec, { fromMs: 0, toMs: 10000 })).toEqual([])
  })

  it('merges clicks close in time and space into one shot that sees them all', () => {
    const rec = recording([move(0), ...click(5000, 0.4, 0.4), ...click(6500, 0.6, 0.5), move(20000)])
    const shots = planAutoZoom(rec, { fromMs: 0, toMs: 20000 })
    expect(shots).toHaveLength(1)
    expect(shots[0]!.clicks).toBe(2)
    expect(1 / shots[0]!.scale).toBeGreaterThan(0.2 + 0.24)
  })

  it('keeps the zoomed view inside the picture', () => {
    const rec = recording([move(0), ...click(5000, 0.98, 0.02), move(15000)])
    const [shot] = planAutoZoom(rec, { fromMs: 0, toMs: 15000 })
    const half = 1 / (2 * shot!.scale)
    expect(shot!.cx).toBeCloseTo(1 - half)
    expect(shot!.cy).toBeCloseTo(half)
  })

  it('moves a window recording off its invisible frame', () => {
    const rec = recording([...click(5000, 11 / 1942, 11 / 1102)], { kind: 'window', name: 'w', x: -11, y: -11, width: 1942, height: 1102 })
    const [c] = recordedClicks(rec, { width: 1920, height: 1080 })
    expect(c!.cx).toBeCloseTo(0)
    expect(c!.cy).toBeCloseTo(0)
  })
})

describe('zoomKeyframes', () => {
  it('rests at the clip pose and fills its footprint with the focus', () => {
    const shots = [{ startMs: 4500, endMs: 6800, cx: 0.5, cy: 0.5, scale: 2, clicks: 1 }]
    const clip = { x: 0, y: 0, scale: 1, anchorX: 0.5, anchorY: 0.5, width: 1920, height: 1080, sourceStartMs: 0, playbackRate: 1, durationMs: 15000 }
    const { scale, position } = zoomKeyframes(shots, clip)
    expect(scale.map((k) => k.v)).toEqual([1, 2, 2, 1])
    expect(position[1]!.v).toEqual([0, 0])
    expect(scale[1]!.t).toBe(4500)
    expect(scale[0]!.t).toBeLessThan(4500)
    const right = zoomKeyframes([{ ...shots[0]!, cx: 0.75 }], clip).position[1]!.v as number[]
    expect(right[0]).toBeCloseTo(-0.25 * 1920 * 2)
  })
})
