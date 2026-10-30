import { describe, expect, it } from 'vitest'
import { formatClock, formatTimecode, frameToMs, msToFrame } from './time'

describe('msToFrame / frameToMs', () => {
  it('lands exactly on frame boundaries', () => {
    expect(msToFrame(1000, 30)).toBe(30)
    expect(msToFrame(61_500, 30)).toBe(1845)
    expect(frameToMs(30, 30)).toBe(1000)
  })

  it('stays on the current frame until the next one starts', () => {
    expect(msToFrame(33.33, 30)).toBe(0)
    expect(msToFrame(33.34, 30)).toBe(1)
  })
})

describe('formatTimecode', () => {
  it('formats HH:MM:SS:FF', () => {
    expect(formatTimecode(0, 30)).toBe('00:00:00:00')
    expect(formatTimecode(61_500, 30)).toBe('00:01:01:15')
    expect(formatTimecode(3_600_000, 25)).toBe('01:00:00:00')
  })

  it('clamps negative times to zero', () => {
    expect(formatTimecode(-500, 30)).toBe('00:00:00:00')
  })
})

describe('formatClock', () => {
  it('formats M:SS and H:MM:SS', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(65_000)).toBe('1:05')
    expect(formatClock(3_725_000)).toBe('1:02:05')
  })
})
