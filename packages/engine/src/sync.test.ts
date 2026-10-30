import { describe, expect, it } from 'vitest'
import { type ElementState, planSync, type SyncGoal } from './sync'

const state = (extra: Partial<ElementState> = {}): ElementState => ({
  currentSec: 2,
  paused: true,
  seeking: false,
  rate: 1,
  ...extra,
})

const goal = (extra: Partial<SyncGoal> = {}): SyncGoal => ({
  targetSec: 2,
  playing: false,
  rate: 1,
  frameSec: 1 / 30,
  seekLatencySec: 0.1,
  startLatencySec: 0,
  sinceRateChangeMs: 1000,
  sinceSeekMs: 1000,
  ...extra,
})

describe('planSync while paused', () => {
  it('seeks to the frame under the playhead, and stays put within half a frame', () => {
    expect(planSync(state(), goal({ targetSec: 2.5 }))).toEqual({ action: 'seek', toSec: 2.5 })
    expect(planSync(state(), goal({ targetSec: 2.01 }))).toEqual({ action: 'none' })
  })

  it('stops a playing element, seeking only when it is off', () => {
    expect(planSync(state({ paused: false }), goal())).toEqual({ action: 'pause' })
    expect(planSync(state({ paused: false }), goal({ targetSec: 3 }))).toEqual({ action: 'pause', seekToSec: 3 })
  })
})

describe('planSync while playing', () => {
  it('starts a paused element at the layer speed, seeking first when it is off', () => {
    expect(planSync(state(), goal({ playing: true, rate: 2 }))).toEqual({ action: 'play', rate: 2 })
    expect(planSync(state(), goal({ playing: true, targetSec: 4 }))).toEqual({ action: 'play', rate: 1, seekToSec: 4 })
  })

  it('starts ahead by the time an element takes to get going', () => {
    expect(planSync(state(), goal({ playing: true, rate: 2, startLatencySec: 0.15 }))).toEqual({
      action: 'play',
      rate: 2,
      seekToSec: 2.3,
    })
  })

  it('seeks ahead by the seek latency when far off, but not right after another seek', () => {
    const playing = state({ paused: false, currentSec: 1 })
    expect(planSync(playing, goal({ playing: true }))).toEqual({ action: 'seek', toSec: 2.1 })
    expect(planSync(playing, goal({ playing: true, sinceSeekMs: 100 }))).toEqual({ action: 'none' })
  })

  it('absorbs small drift by changing speed, within limits', () => {
    const behind = planSync(state({ paused: false, currentSec: 1.8 }), goal({ playing: true }))
    expect(behind).toEqual({ action: 'rate', rate: expect.closeTo(1.2, 5) })
    const ahead = planSync(state({ paused: false, currentSec: 2.05 }), goal({ playing: true }))
    expect(ahead).toEqual({ action: 'rate', rate: expect.closeTo(0.925, 5) })
    expect(planSync(state({ paused: false, currentSec: 2.05 }), goal({ playing: true, sinceRateChangeMs: 50 }))).toEqual({
      action: 'none',
    })
  })

  it('returns to the layer speed once in step', () => {
    expect(planSync(state({ paused: false, rate: 1.1 }), goal({ playing: true }))).toEqual({ action: 'rate', rate: 1 })
    expect(planSync(state({ paused: false }), goal({ playing: true }))).toEqual({ action: 'none' })
  })

  it('waits while the element is seeking', () => {
    expect(planSync(state({ paused: false, seeking: true, currentSec: 0 }), goal({ playing: true }))).toEqual({
      action: 'none',
    })
  })
})
