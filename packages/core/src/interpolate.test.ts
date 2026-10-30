import { describe, expect, it } from 'vitest'
import { formatColor, parseColor, sampleKeys } from './interpolate'
import type { Easing, Keyframe, KeyValue } from './schema'

const key = (t: number, v: KeyValue, ease: Easing = 'linear'): Keyframe => ({ t, v, ease })

describe('sampleKeys', () => {
  it('holds the first and last values outside the keys', () => {
    const keys = [key(100, 0), key(200, 10)]
    expect(sampleKeys(keys, 0)).toBe(0)
    expect(sampleKeys(keys, 500)).toBe(10)
  })

  it('uses the left key easing for each segment', () => {
    expect(sampleKeys([key(0, 0), key(100, 10)], 50)).toBe(5)
    expect(sampleKeys([key(0, 0, 'hold'), key(100, 10)], 99)).toBe(0)
    expect(sampleKeys([key(0, 0, 'hold'), key(100, 10)], 100)).toBe(10)
  })

  it('finds the right segment among many keys', () => {
    const keys = [key(0, 0), key(10, 10), key(20, 0), key(30, 30)]
    expect(sampleKeys(keys, 25)).toBe(15)
    expect(sampleKeys(keys, 10)).toBe(10)
  })

  it('blends vectors and colours', () => {
    expect(sampleKeys([key(0, [0, 0]), key(10, [10, 20])], 5)).toEqual([5, 10])
    expect(sampleKeys([key(0, '#000000'), key(10, '#ffffff')], 5)).toBe('#808080')
  })

  it('returns undefined without keys', () => {
    expect(sampleKeys([], 5)).toBeUndefined()
  })
})

describe('colours', () => {
  it('round-trips hex colours with and without alpha', () => {
    expect(parseColor('#ff8800')).toEqual([255, 136, 0, 255])
    expect(formatColor([255, 136, 0, 255])).toBe('#ff8800')
    expect(formatColor([255, 136, 0, 128])).toBe('#ff880080')
    expect(parseColor('red')).toBeNull()
  })

  it('clamps channels when formatting', () => {
    expect(formatColor([300, -20, 127.6, 255])).toBe('#ff0080')
  })
})
