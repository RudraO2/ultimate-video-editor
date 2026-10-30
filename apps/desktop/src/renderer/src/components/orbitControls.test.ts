import { DEFAULT_ORBIT_VIEW, ORBIT_WHEEL_STEP, type OrbitView } from '@uve/engine'
import { describe, expect, it } from 'vitest'
import { clickSelection, dragModeOf, dragView, firstView, framedView, isClick, isTrackpad, orbitKey, wheelView } from './orbitControls'

const view: OrbitView = { target: [10, 20, 30], distance: 1000, yaw: 35, pitch: 25 }
const press = (button: number, mods: { altKey?: boolean; shiftKey?: boolean; ctrlKey?: boolean } = {}) => ({
  button,
  altKey: false,
  shiftKey: false,
  ctrlKey: false,
  ...mods,
})
const wheel = (deltaY: number, rest: Partial<Parameters<typeof wheelView>[1]> = {}) => ({
  deltaX: 0,
  deltaY,
  deltaMode: 0,
  shiftKey: false,
  ctrlKey: false,
  ...rest,
})

describe('dragModeOf', () => {
  it('maps the middle button and its modifiers', () => {
    expect(dragModeOf(press(1), 'move')).toBe('orbit')
    expect(dragModeOf(press(1, { shiftKey: true }), 'move')).toBe('pan')
    expect(dragModeOf(press(1, { ctrlKey: true }), 'move')).toBe('zoom')
  })

  it('maps the left button by modifier and tool', () => {
    expect(dragModeOf(press(0), 'move')).toBe('select')
    expect(dragModeOf(press(0, { altKey: true }), 'move')).toBe('orbit')
    expect(dragModeOf(press(0), 'hand')).toBe('pan')
    expect(dragModeOf(press(0), 'pen')).toBeNull()
    expect(dragModeOf(press(0), 'text')).toBeNull()
    expect(dragModeOf(press(2), 'move')).toBeNull()
  })
})

describe('dragView', () => {
  it('orbits at 0.35 degrees a px', () => {
    const next = dragView(view, 'orbit', 100, 0, 600)
    expect(next.yaw).toBeCloseTo(0, 6)
    expect(next.pitch).toBe(25)
  })

  it('zooms by exp(0.01 dy)', () => {
    expect(dragView(view, 'zoom', 50, 0, 600).distance).toBe(1000)
    expect(dragView(view, 'zoom', 0, 50, 600).distance).toBeCloseTo(1000 * Math.exp(0.5), 6)
  })

  it('pans the target and keeps the angles', () => {
    const next = dragView(view, 'pan', 40, 0, 600)
    expect(next.target).not.toEqual(view.target)
    expect(next.yaw).toBe(view.yaw)
    expect(next.distance).toBe(view.distance)
  })
})

describe('wheelView', () => {
  it('tells a mouse wheel from a trackpad', () => {
    expect(isTrackpad(wheel(100))).toBe(false)
    expect(isTrackpad(wheel(12))).toBe(true)
    expect(isTrackpad(wheel(100, { deltaX: 3 }))).toBe(true)
    expect(isTrackpad(wheel(100.5))).toBe(true)
    expect(isTrackpad(wheel(3, { deltaMode: 1 }))).toBe(false)
  })

  it('steps the distance by 1.15 a notch, farther when scrolling down', () => {
    expect(wheelView(view, wheel(100), 600).distance).toBeCloseTo(1000 * ORBIT_WHEEL_STEP, 6)
    expect(wheelView(view, wheel(-100), 600).distance).toBeCloseTo(1000 / ORBIT_WHEEL_STEP, 6)
  })

  it('orbits on a trackpad scroll, pans with Shift, zooms with Ctrl', () => {
    const turned = wheelView(view, wheel(10, { deltaX: 5 }), 600)
    expect(turned.yaw).toBeCloseTo(35 - 5 * 0.6 * 0.35, 6)
    expect(turned.pitch).toBeCloseTo(25 + 10 * 0.6 * 0.35, 6)
    const panned = wheelView(view, wheel(10, { shiftKey: true }), 600)
    expect(panned.target).not.toEqual(view.target)
    expect(panned.yaw).toBe(35)
    expect(wheelView(view, wheel(10, { ctrlKey: true }), 600).distance).toBeCloseTo(1000 * Math.exp(0.1), 6)
  })
})

describe('orbitKey', () => {
  it('sets the axis views, with Ctrl for the opposite side', () => {
    expect(orbitKey(view, 'Numpad1', false)).toEqual({ view: { ...view, yaw: 0, pitch: 0 } })
    expect(orbitKey(view, 'Numpad1', true)).toEqual({ view: { ...view, yaw: 180, pitch: 0 } })
    expect(orbitKey(view, 'Numpad3', false)).toEqual({ view: { ...view, yaw: 90, pitch: 0 } })
    expect(orbitKey(view, 'Numpad3', true)).toEqual({ view: { ...view, yaw: -90, pitch: 0 } })
    expect(orbitKey(view, 'Numpad7', false)).toEqual({ view: { ...view, yaw: 0, pitch: 90 } })
    expect(orbitKey(view, 'Numpad7', true)).toEqual({ view: { ...view, yaw: 0, pitch: -90 } })
  })

  it('looks from the opposite side with 9', () => {
    expect(orbitKey(view, 'Numpad9', false)).toEqual({ view: { ...view, yaw: -145, pitch: -25 } })
  })

  it('turns by 15 degrees and clamps the pitch', () => {
    expect(orbitKey(view, 'Numpad4', false)).toEqual({ view: { ...view, yaw: 20 } })
    expect(orbitKey(view, 'Numpad6', false)).toEqual({ view: { ...view, yaw: 50 } })
    expect(orbitKey(view, 'Numpad8', false)).toEqual({ view: { ...view, pitch: 40 } })
    expect(orbitKey({ ...view, pitch: 85 }, 'Numpad8', false)).toEqual({ view: { ...view, pitch: 90 } })
    expect(orbitKey({ ...view, pitch: -85 }, 'Numpad2', false)).toEqual({ view: { ...view, pitch: -90 } })
  })

  it('zooms with plus and minus and asks to frame', () => {
    expect((orbitKey(view, 'NumpadAdd', false) as { view: OrbitView }).view.distance).toBeCloseTo(1000 / 1.2, 6)
    expect((orbitKey(view, 'NumpadSubtract', false) as { view: OrbitView }).view.distance).toBeCloseTo(1200, 6)
    expect(orbitKey(view, 'NumpadDecimal', false)).toEqual({ frame: 'selection' })
    expect(orbitKey(view, 'Home', false)).toEqual({ frame: 'all' })
    expect(orbitKey(view, 'KeyA', false)).toBeNull()
  })
})

describe('framing', () => {
  const bounds = { min: [-100, -100, -100], max: [100, 100, 100] } as const

  it('keeps the view without bounds', () => {
    expect(framedView(view, null, 16 / 9)).toBe(view)
    expect(firstView(null, 16 / 9)).toEqual(DEFAULT_ORBIT_VIEW)
  })

  it('centres on the bounds, and the first view backs off to twice the fit', () => {
    const fit = framedView(DEFAULT_ORBIT_VIEW, { min: [...bounds.min], max: [...bounds.max] }, 16 / 9)
    expect(fit.target).toEqual([0, 0, 0])
    const first = firstView({ min: [...bounds.min], max: [...bounds.max] }, 16 / 9)
    expect(first.distance).toBeCloseTo(fit.distance * 2, 6)
    expect(first.yaw).toBe(DEFAULT_ORBIT_VIEW.yaw)
  })
})

describe('clicks', () => {
  it('takes four px or less as a click', () => {
    expect(isClick(3, 2)).toBe(true)
    expect(isClick(4, 4)).toBe(false)
  })

  it('selects, toggles and clears', () => {
    expect(clickSelection('a', false)).toEqual({ id: 'a', additive: false })
    expect(clickSelection('a', true)).toEqual({ id: 'a', additive: true })
    expect(clickSelection(null, false)).toEqual({ id: null, additive: false })
    expect(clickSelection(null, true)).toBeNull()
  })
})
