import { CommandError } from '@uve/core'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AUDIO_BITRATE,
  EXPORT_QUALITIES,
  audioBitrateOf,
  checkScale,
  clampFps,
  qualityBitrate,
  recommendedBitrate,
  videoBitrateOf,
} from './options'

const errorOf = (fn: () => unknown): CommandError => {
  try {
    fn()
  } catch (e) {
    return e as CommandError
  }
  throw new Error('did not throw')
}

describe('bitrates by quality', () => {
  it('recommends 0.4 bit per pixel, between 8 and 120 Mbps', () => {
    expect(recommendedBitrate(1920, 1080, 30)).toBe(24_883_200)
    expect(recommendedBitrate(320, 240, 24)).toBe(8_000_000)
    expect(recommendedBitrate(7680, 4320, 60)).toBe(120_000_000)
  })

  it('scales the recommendation by quality', () => {
    expect(EXPORT_QUALITIES).toEqual(['draft', 'high', 'master'])
    expect(qualityBitrate('draft', 1920, 1080, 30)).toBe(12_441_600)
    expect(qualityBitrate('high', 1920, 1080, 30)).toBe(24_883_200)
    expect(qualityBitrate('master', 1920, 1080, 30)).toBe(49_766_400)
  })

  it('rounds to whole bits', () => {
    expect(Number.isInteger(qualityBitrate('draft', 1001, 563, 29.97))).toBe(true)
  })
})

describe('clampFps', () => {
  it('clamps to 1..240 and keeps 3 decimals', () => {
    expect(clampFps(23.976)).toBe(23.976)
    expect(clampFps(29.97002997)).toBe(29.97)
    expect(clampFps(0.2)).toBe(1)
    expect(clampFps(500)).toBe(240)
    expect(clampFps(60)).toBe(60)
  })

  it('refuses a value that is not a number', () => {
    expect(() => clampFps(Number.NaN)).toThrow(CommandError)
    expect(() => clampFps(Infinity)).toThrow(CommandError)
  })
})

describe('loose bitrates', () => {
  it('reads a small video value as Mbps and a large one as bps', () => {
    expect(videoBitrateOf(25)).toBe(25_000_000)
    expect(videoBitrateOf(0.5)).toBe(500_000)
    expect(videoBitrateOf(8_000_000)).toBe(8_000_000)
  })

  it('refuses a video bitrate out of range, with the range in the hint', () => {
    expect(() => videoBitrateOf(0.01)).toThrow(CommandError)
    expect(() => videoBitrateOf(600_000_000)).toThrow(CommandError)
    expect(errorOf(() => videoBitrateOf(600_000_000)).hint).toMatch(/500 Mbps/)
    expect(() => videoBitrateOf(0)).toThrow(CommandError)
    expect(() => videoBitrateOf(-5)).toThrow(CommandError)
    expect(() => videoBitrateOf(Number.NaN)).toThrow(CommandError)
  })

  it('reads a small audio value as kbps, a large one as bps, and clamps', () => {
    expect(DEFAULT_AUDIO_BITRATE).toBe(192_000)
    expect(audioBitrateOf(192)).toBe(192_000)
    expect(audioBitrateOf(128_000)).toBe(128_000)
    expect(audioBitrateOf(16)).toBe(64_000)
    expect(audioBitrateOf(512)).toBe(320_000)
    expect(audioBitrateOf(900_000)).toBe(320_000)
  })

  it('refuses a non-positive audio bitrate', () => {
    expect(() => audioBitrateOf(0)).toThrow(CommandError)
    expect(() => audioBitrateOf(-1)).toThrow(CommandError)
    expect(() => audioBitrateOf(Infinity)).toThrow(CommandError)
  })
})

describe('checkScale', () => {
  it('returns a scale in range', () => {
    expect(checkScale(1)).toBe(1)
    expect(checkScale(0.05)).toBe(0.05)
    expect(checkScale(4)).toBe(4)
  })

  it('refuses a scale out of range, with a hint', () => {
    for (const scale of [0.04, 4.1, 0, -1, Number.NaN, Infinity]) {
      const error = errorOf(() => checkScale(scale))
      expect(error.message).toBe('scale must be between 0.05 and 4.')
      expect(error.hint).toMatch(/0\.5 is half/)
    }
  })
})
