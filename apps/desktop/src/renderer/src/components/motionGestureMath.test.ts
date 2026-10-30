import { transformPoint } from '@uve/engine'
import { describe, expect, it } from 'vitest'
import { compose, mat4, rotateZ, scale, translate } from '../../../../../../packages/engine/src/math'
import {
  ANGLE_STEP_DEG,
  DRAG_LATCH_PX,
  effectiveMode,
  HANDLE_REMOVE_PX,
  MIRROR_TOLERANCE,
  pairMode,
  parentFromComp,
  partnerValue,
  snapAngle,
  snapPoint,
} from './motionGestureMath'

describe('constants', () => {
  it('has the agreed values', () => {
    expect([DRAG_LATCH_PX, HANDLE_REMOVE_PX, ANGLE_STEP_DEG, MIRROR_TOLERANCE]).toEqual([4, 4, 15, 0.01])
  })
})

describe('pairMode', () => {
  it('is mirrored for equal and opposite handles, within tolerance', () => {
    expect(pairMode([30, -10], [-30, 10])).toBe('mirrored')
    expect(pairMode([100, 0], [-100.5, 0])).toBe('mirrored')
  })

  it('is collinear for opposite directions with different lengths', () => {
    expect(pairMode([30, 10], [-60, -20])).toBe('collinear')
  })

  it('is broken for other angles, same direction, zero or missing handles', () => {
    expect(pairMode([30, 10], [-30, 20])).toBe('broken')
    expect(pairMode([30, 10], [60, 20])).toBe('broken')
    expect(pairMode([0, 0], [10, 0])).toBe('broken')
    expect(pairMode([10, 0], [0, 0])).toBe('broken')
    expect(pairMode(null, [10, 0])).toBe('broken')
    expect(pairMode([10, 0], null)).toBe('broken')
    expect(pairMode(null, null)).toBe('broken')
  })
})

describe('effectiveMode', () => {
  it('keeps the mode without Alt', () => {
    for (const m of ['mirrored', 'collinear', 'broken'] as const) expect(effectiveMode(m, false)).toBe(m)
  })

  it('breaks a mirrored or collinear pair with Alt and mirrors a broken one', () => {
    expect(effectiveMode('mirrored', true)).toBe('broken')
    expect(effectiveMode('collinear', true)).toBe('broken')
    expect(effectiveMode('broken', true)).toBe('mirrored')
  })
})

describe('snapAngle', () => {
  it('rounds a small angle to 0 and keeps the length', () => {
    const [x, y] = snapAngle([10, 1])
    expect(x).toBeCloseTo(Math.hypot(10, 1), 9)
    expect(x).toBeCloseTo(10.05, 2)
    expect(y).toBeCloseTo(0, 9)
  })

  it('rounds 50 degrees to 45', () => {
    const a = (50 * Math.PI) / 180
    const [x, y] = snapAngle([Math.cos(a) * 20, Math.sin(a) * 20])
    expect(x).toBeCloseTo(Math.cos(Math.PI / 4) * 20, 9)
    expect(y).toBeCloseTo(Math.sin(Math.PI / 4) * 20, 9)
  })

  it('takes a custom step and handles negative angles', () => {
    const [x, y] = snapAngle([3, -10], 90)
    expect(x).toBeCloseTo(0, 9)
    expect(y).toBeCloseTo(-Math.hypot(3, 10), 9)
  })

  it('returns the zero vector unchanged', () => {
    const zero: [number, number] = [0, 0]
    expect(snapAngle(zero)).toBe(zero)
  })
})

describe('partnerValue', () => {
  it('mirrors, normalising -0', () => {
    expect(partnerValue([5, 0], [1, 1], 'mirrored')).toEqual([-5, 0])
    expect(partnerValue([0, 0], null, 'mirrored')).toEqual([0, 0])
    expect(Object.is(partnerValue([0, 3], null, 'mirrored')?.[0], 0)).toBe(true)
  })

  it('keeps the partner length when collinear', () => {
    const got = partnerValue([3, 4], [-10, 0], 'collinear') as [number, number]
    expect(got[0]).toBeCloseTo(-6, 9)
    expect(got[1]).toBeCloseTo(-8, 9)
    expect(Math.hypot(got[0], got[1])).toBeCloseTo(10, 9)
  })

  it('normalises -0 when collinear', () => {
    const got = partnerValue([5, 0], [-2, 0], 'collinear') as [number, number]
    expect(got).toEqual([-2, 0])
    expect(Object.is(got[1], 0)).toBe(true)
  })

  it('is undefined for broken, a missing partner or zero lengths', () => {
    expect(partnerValue([3, 4], [-1, 0], 'broken')).toBeUndefined()
    expect(partnerValue([3, 4], null, 'collinear')).toBeUndefined()
    expect(partnerValue([0, 0], [-1, 0], 'collinear')).toBeUndefined()
    expect(partnerValue([3, 4], [0, 0], 'collinear')).toBeUndefined()
  })
})

describe('snapPoint', () => {
  const targets = { xs: [0, 100], ys: [50] }

  it('snaps each axis on its own', () => {
    expect(snapPoint([97, 200], targets, 5)).toEqual({ value: [100, 200], snappedX: 100, snappedY: null })
    expect(snapPoint([40, 53], targets, 5)).toEqual({ value: [40, 50], snappedX: null, snappedY: 50 })
  })

  it('snaps both axes and picks the nearest target', () => {
    expect(snapPoint([3, 48], { xs: [0, 5], ys: [50] }, 5)).toEqual({ value: [5, 50], snappedX: 5, snappedY: 50 })
  })

  it('treats the threshold as inclusive and leaves far points alone', () => {
    expect(snapPoint([5, 0], { xs: [0], ys: [] }, 5).snappedX).toBe(0)
    expect(snapPoint([5.1, 0], { xs: [0], ys: [] }, 5)).toEqual({ value: [5.1, 0], snappedX: null, snappedY: null })
  })
})

describe('parentFromComp', () => {
  it('is the identity without a matrix', () => {
    expect(parentFromComp(undefined)(12, -7)).toEqual([12, -7])
  })

  it('round-trips points through translate, rotate and scale', () => {
    const m = compose(translate(120, -40, 0), rotateZ(0.6), scale(2, 0.5, 1))
    const back = parentFromComp(m)
    for (const [x, y] of [
      [0, 0],
      [30, -20],
      [-100, 55],
    ] as const) {
      const [cx, cy] = transformPoint(m, x, y, 0)
      const [px, py] = back(cx, cy)
      expect(px).toBeCloseTo(x, 9)
      expect(py).toBeCloseTo(y, 9)
    }
  })

  it('ignores z and perspective', () => {
    const m = mat4(1, 0, 0.5, 10, 0, 1, 0.5, 20, 0, 0, 1, 0, 0, 0, 0.001, 1)
    expect(parentFromComp(m)(15, 27)).toEqual([5, 7])
  })

  it('falls back to the identity when singular', () => {
    expect(parentFromComp(scale(0, 1, 1))(4, 5)).toEqual([4, 5])
    expect(parentFromComp(mat4(1, 2, 0, 0, 2, 4, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1))(4, 5)).toEqual([4, 5])
  })
})
