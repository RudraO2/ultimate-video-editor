import { type Layer, LayerSchema } from '@uve/core'
import { describe, expect, it } from 'vitest'
import { isActiveAt, needsProjection, resolveLayer } from './evaluate'

const shape = (extra: Record<string, unknown> = {}): Layer =>
  LayerSchema.parse({
    id: 'layer_1',
    name: 'Box',
    kind: 'shape',
    startMs: 1000,
    durationMs: 2000,
    fills: [{ id: 'f1', type: 'solid', color: '#000000' }],
    strokes: [{ id: 's1', paint: { id: 'p1', type: 'solid', color: '#ffffff' }, width: 4 }],
    ...extra,
  })

const animation = (preset: string, extra: Record<string, unknown> = {}) => ({ preset, durationMs: 500, easing: 'linear', ...extra })

describe('resolveLayer with entrance and exit presets', () => {
  it('moves, scales, fades and blurs the whole layer from its keyed values', () => {
    const layer = shape({ transform: { x: 100, scaleX: 2, scaleY: 2 }, animIn: animation('punch', { params: { from: 200, blur: 10 } }) })
    const start = resolveLayer(layer, 1000)
    expect(start.transform).toMatchObject({ x: 100, scaleX: 4, scaleY: 4, opacity: 0 })
    expect(start.blur).toBe(10)
    const done = resolveLayer(layer, 1600)
    expect(done.transform).toMatchObject({ scaleX: 2, opacity: 1 })
    expect(done.blur).toBeUndefined()
  })

  it('gives text its per-grapheme poses and shapes their draw-on', () => {
    const text = LayerSchema.parse({ id: 't', name: 'T', kind: 'text', text: 'ab', startMs: 0, durationMs: 2000, textIn: { ...animation('fade'), unit: 'letter', staggerMs: 500 } })
    const glyphs = resolveLayer(text, 250).glyphs
    expect(glyphs?.poses.map((p) => p.opacity)).toEqual([0.5, 0])
    const drawn = resolveLayer(shape({ animIn: animation('draw') }), 1250).drawOn
    expect(drawn?.progress).toBeCloseTo(0.5)
  })
})

describe('resolveLayer', () => {
  it('samples animated properties relative to the layer start', () => {
    const layer = shape({
      animations: {
        'transform.x': [
          { t: 0, v: 0, ease: 'linear' },
          { t: 1000, v: 300, ease: 'linear' },
        ],
        'fill.f1': [
          { t: 0, v: '#000000', ease: 'linear' },
          { t: 1000, v: '#ffffff', ease: 'linear' },
        ],
        'stroke.s1.trim.end': [
          { t: 0, v: 0, ease: 'ease-out-back' },
          { t: 1000, v: 1 },
        ],
      },
    })
    const resolved = resolveLayer(layer, 1500)
    expect(resolved.transform.x).toBeCloseTo(150)
    expect(resolved.fills?.[0]).toMatchObject({ color: '#808080' })
    expect(resolved.shape?.width).toBe(400)
    // The overshooting easing is kept inside the trim's 0 to 1.
    expect(resolveLayer(layer, 1900).strokes?.[0]?.trim.end).toBeLessThanOrEqual(1)
    // The document itself is untouched.
    expect(layer.kind === 'shape' && layer.fills[0]).toMatchObject({ color: '#000000' })
  })

  it('keeps opacity in range when an easing overshoots', () => {
    const layer = shape({
      animations: {
        'transform.opacity': [
          { t: 0, v: 0, ease: 'ease-out-back' },
          { t: 1000, v: 1 },
        ],
      },
    })
    for (const time of [1400, 1600, 1800]) {
      const { opacity } = resolveLayer(layer, time).transform
      expect(opacity).toBeGreaterThanOrEqual(0)
      expect(opacity).toBeLessThanOrEqual(1)
    }
  })
})

describe('visibility', () => {
  it('shows a layer from its start up to, but not including, its end', () => {
    const layer = shape()
    expect(isActiveAt(layer, 999)).toBe(false)
    expect(isActiveAt(layer, 1000)).toBe(true)
    expect(isActiveAt(layer, 2999)).toBe(true)
    expect(isActiveAt(layer, 3000)).toBe(false)
    expect(isActiveAt({ ...layer, enabled: false }, 1500)).toBe(false)
  })

  it('needs perspective only for depth or tilt', () => {
    const { transform } = shape()
    expect(needsProjection(transform)).toBe(false)
    expect(needsProjection({ ...transform, rotation: 45 })).toBe(false)
    expect(needsProjection({ ...transform, z: 10 })).toBe(true)
    expect(needsProjection({ ...transform, rotationY: 5 })).toBe(true)
  })
})
