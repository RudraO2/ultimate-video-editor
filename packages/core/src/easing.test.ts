import { describe, expect, it } from 'vitest'
import { cubicBezier, ease, splitEasing } from './easing'
import { EASING_PRESETS } from './schema'

describe('ease', () => {
  it('pins both end points for every preset', () => {
    for (const preset of EASING_PRESETS.filter((p) => p !== 'hold')) {
      expect(ease(preset, 0)).toBe(0)
      expect(ease(preset, 1)).toBe(1)
    }
  })

  it('holds the first value until the next key', () => {
    expect(ease('hold', 0.99)).toBe(0)
  })

  it('follows the shape of each curve', () => {
    expect(ease('linear', 0.3)).toBeCloseTo(0.3)
    expect(cubicBezier(0.42, 0, 0.58, 1, 0.5)).toBeCloseTo(0.5, 5)
    expect(ease('ease-in', 0.5)).toBeLessThan(0.5)
    expect(ease('ease-out', 0.5)).toBeGreaterThan(0.5)
  })

  it('overshoots with back easing', () => {
    const samples = [0.6, 0.7, 0.8, 0.9].map((p) => ease('ease-out-back', p))
    expect(Math.max(...samples)).toBeGreaterThan(1)
  })

  it('accepts custom Bézier curves', () => {
    expect(ease({ type: 'bezier', x1: 0, y1: 0, x2: 1, y2: 1 }, 0.25)).toBeCloseTo(0.25, 5)
  })
})

describe('splitEasing', () => {
  it('keeps linear and hold as they are', () => {
    expect(splitEasing('linear', 0.4)).toEqual(['linear', 'linear'])
    expect(splitEasing('hold', 0.4)).toEqual(['hold', 'hold'])
  })

  it('plays the two halves as the original played the whole', () => {
    for (const preset of EASING_PRESETS.filter((p) => p !== 'hold' && p !== 'linear')) {
      for (const p of [0.25, 0.5, 0.8]) {
        const [first, second] = splitEasing(preset, p)
        const whole = ease(preset, p)
        for (let i = 0; i <= 20; i++) {
          const s = i / 20
          expect(ease(first, s), `${preset} first half at p ${p}, s ${s}`).toBeCloseTo(ease(preset, s * p) / whole, 4)
          expect(ease(second, s), `${preset} second half at p ${p}, s ${s}`).toBeCloseTo((ease(preset, p + s * (1 - p)) - whole) / (1 - whole), 4)
        }
      }
    }
  })

  it('splits a custom curve and a split curve again', () => {
    const custom = { type: 'bezier', x1: 0.2, y1: 0.8, x2: 0.7, y2: 0.1 } as const
    const [first] = splitEasing(custom, 0.6)
    const [a, b] = splitEasing(first, 0.5)
    for (let i = 0; i <= 10; i++) {
      const s = i / 10
      expect(ease(a, s)).toBeCloseTo(ease(custom, s * 0.3) / ease(custom, 0.3), 4)
      expect(ease(b, s)).toBeCloseTo((ease(custom, 0.3 + s * 0.3) - ease(custom, 0.3)) / (ease(custom, 0.6) - ease(custom, 0.3)), 4)
    }
  })

  it('returns hold for a half that covers no distance', () => {
    expect(splitEasing({ type: 'bezier', x1: 0.5, y1: 0, x2: 0.5, y2: 0 }, 0.000001)[0]).toBe('hold')
  })
})
