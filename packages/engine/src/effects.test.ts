import type { Effect } from '@uve/core'
import { describe, expect, it } from 'vitest'
import { distanceField, effectsReach, shinePosition, textEffectsReach } from './effects'

const card = (type: string, fields: Record<string, number | string | boolean>): Effect => ({ id: 'fx', type, enabled: true, ...fields })

describe('effects', () => {
  it('measures exact distances to the nearest feature pixel', () => {
    // A 7×5 field with one feature in the middle.
    const field = distanceField(7, 5, (i) => i === 2 * 7 + 3)
    expect(field[2 * 7 + 3]).toBe(0)
    expect(field[2 * 7 + 6]).toBeCloseTo(3)
    expect(field[0]).toBeCloseTo(Math.hypot(3, 2))
    expect(field[4 * 7 + 4]).toBeCloseTo(Math.hypot(1, 2))
  })

  it('sweeps a shine on its own clock', () => {
    const once = card('shine', { position: 0, duration: 2, delay: 1, loop: false })
    expect(shinePosition(once, 0)).toBe(0)
    expect(shinePosition(once, 2000)).toBeCloseTo(0.5)
    expect(shinePosition(once, 9000)).toBe(1)
    const looping = card('shine', { position: 0, duration: 1, delay: 1, loop: true })
    expect(shinePosition(looping, 1500)).toBeCloseTo(0.5)
    // Each cycle: the pass, then the delay with the band parked past the layer.
    expect(shinePosition(looping, 2500)).toBe(1)
    expect(shinePosition(looping, 3500)).toBeCloseTo(0.5)
    expect(shinePosition(card('shine', { position: 0.3, duration: 0 }), 5000)).toBe(0.3)
  })

  it('reserves room for what cards draw past the layer', () => {
    const box = { width: 300, height: 400 }
    // A zoom to twice the size reaches half the diagonal further.
    expect(effectsReach([card('zoomBlur', { strength: 0.5 })], box)).toBeCloseTo(250)
    expect(effectsReach([card('shadow', { x: 0, y: 12, blur: 10 })], box)).toBe(42)
    expect(effectsReach([card('stroke', { width: 6, placement: 'inside' })], box)).toBe(0)
    expect(effectsReach([{ ...card('glow', { size: 20 }), enabled: false }], box)).toBe(0)
    expect(textEffectsReach([card('extrude', { length: 26 }), card('echo', { distance: 8, count: 4 })])).toBe(32)
  })
})
