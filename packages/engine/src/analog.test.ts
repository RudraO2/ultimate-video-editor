import type { Effect } from '@uve/core'
import { describe, expect, it } from 'vitest'
import { hash, noiseField, random, rollAt } from './analog'

const card = (fields: Record<string, number | string | boolean>): Effect => ({ id: 'fx', type: 'grain', enabled: true, seed: 1, rate: 24, jitter: 0, stutter: 0, ...fields })

describe('analog cards', () => {
  it('re-roll on a seeded clock, and hold one look when still', () => {
    expect(rollAt(card({ animate: false }), 5000)).toBe(0)
    const moving = card({ animate: true, rate: 10 })
    expect(rollAt(moving, 0)).toBe(0)
    expect(rollAt(moving, 150)).toBe(1)
    expect(rollAt(moving, 1050)).toBe(10)
    // Stutter 1 holds every step over (except the first).
    expect(rollAt(card({ animate: true, rate: 10, stutter: 1 }), 1050)).toBe(9)
  })

  it('hashes and generates the same numbers for the same seed', () => {
    expect(hash(1, 2, 3)).toBe(hash(1, 2, 3))
    expect(hash(1, 2, 3)).not.toBe(hash(1, 2, 4))
    const a = random(7)
    const b = random(7)
    const values = Array.from({ length: 5 }, () => a())
    expect(values).toEqual(Array.from({ length: 5 }, () => b()))
    for (const v of values) expect(v >= 0 && v < 1).toBe(true)
  })

  it('keeps the noise field between 0 and 1, smooth from point to point', () => {
    const e = card({ type: 'noise', shape: 'fractal', octaves: 4, roughness: 0.5, lacunarity: 2, contrast: 1, brightness: 0 })
    let last = noiseField(e, 0, 0, 0)
    for (let i = 1; i < 200; i++) {
      const v = noiseField(e, i * 0.01, i * 0.007, 0)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
      expect(Math.abs(v - last)).toBeLessThan(0.1)
      last = v
    }
    expect(noiseField({ ...e, brightness: 1 }, 0.3, 0.3, 0)).toBe(1)
  })
})
