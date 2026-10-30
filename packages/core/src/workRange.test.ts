import { describe, expect, it } from 'vitest'
import { activeWorkRange, clampWorkRange, MIN_WORK_RANGE_MS, workRangeSpan } from './workRange'

const range = { compId: 'a', startMs: 1000, endMs: 3000 }

describe('activeWorkRange', () => {
  it('is null unless enabled', () => {
    expect(activeWorkRange(range, false, 'a')).toBeNull()
    expect(activeWorkRange(null, true, 'a')).toBeNull()
  })
  it('is null on another comp', () => {
    expect(activeWorkRange(range, true, 'b')).toBeNull()
  })
  it('is null under 100 ms, active at exactly 100 ms', () => {
    expect(activeWorkRange({ ...range, endMs: 1099 }, true, 'a')).toBeNull()
    expect(activeWorkRange({ ...range, endMs: 1100 }, true, 'a')).toEqual({ startMs: 1000, endMs: 1100 })
  })
  it('returns the span when active', () => {
    expect(activeWorkRange(range, true, 'a')).toEqual({ startMs: 1000, endMs: 3000 })
  })
})

describe('clampWorkRange', () => {
  it('keeps a range that fits, rounding to whole ms', () => {
    expect(clampWorkRange({ compId: 'a', startMs: 10.4, endMs: 500.6 }, 5000)).toEqual({ compId: 'a', startMs: 10, endMs: 501 })
  })
  it('limits to the comp', () => {
    expect(clampWorkRange({ compId: 'a', startMs: -50, endMs: 9000 }, 5000)).toEqual({ compId: 'a', startMs: 0, endMs: 5000 })
    expect(clampWorkRange({ compId: 'a', startMs: 6000, endMs: 9000 }, 5000)).toEqual({ compId: 'a', startMs: 4900, endMs: 5000 })
  })
  it('keeps start at most end minus 100', () => {
    expect(clampWorkRange({ compId: 'a', startMs: 2000, endMs: 2010 }, 5000)).toEqual({ compId: 'a', startMs: 2000, endMs: 2000 + MIN_WORK_RANGE_MS })
    expect(clampWorkRange({ compId: 'a', startMs: 3000, endMs: 1000 }, 5000)).toEqual({ compId: 'a', startMs: 3000, endMs: 3100 })
  })
  it('gives a comp under 100 ms its whole length', () => {
    expect(clampWorkRange({ compId: 'a', startMs: 10, endMs: 40 }, 60)).toEqual({ compId: 'a', startMs: 0, endMs: 60 })
  })
})

describe('workRangeSpan', () => {
  it('is the active range', () => {
    expect(workRangeSpan(range, true, 'a', 5000)).toEqual({ startMs: 1000, endMs: 3000 })
  })
  it('is the whole comp otherwise', () => {
    expect(workRangeSpan(range, false, 'a', 5000)).toEqual({ startMs: 0, endMs: 5000 })
    expect(workRangeSpan(range, true, 'b', 5000)).toEqual({ startMs: 0, endMs: 5000 })
    expect(workRangeSpan(null, true, 'a', 5000)).toEqual({ startMs: 0, endMs: 5000 })
  })
})
