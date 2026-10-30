import {
  type Bounds3,
  DEFAULT_ORBIT_VIEW,
  frameBounds,
  normalizeYaw,
  ORBIT_AXIS_VIEWS,
  ORBIT_WHEEL_STEP,
  orbitBy,
  type OrbitView,
  panBy,
  zoomBy,
} from '@uve/engine'

// The orbit view's controls as pure maths: which drag does what, how a wheel
// event turns the view, and what each numpad key does. Viewport.tsx wires
// them to the pointer and the keyboard. Behaviour follows AtomCut's orbit
// viewport (observed): immediate, no damping.

/** What a pointer drag does in the orbit view. */
export type OrbitDrag = 'orbit' | 'pan' | 'zoom' | 'select'

/** Zoom a Ctrl+middle drag or a pinch makes per px of travel (distance × exp(k·px)). */
export const ORBIT_ZOOM_PER_PX = 0.01
/** A trackpad scroll turns the view by this many drag px per scroll px. */
export const ORBIT_SCROLL_GAIN = 0.6
/** Degrees the numpad turns the view by, and the distance factor of its plus and minus. */
export const ORBIT_KEY_TURN = 15
export const ORBIT_KEY_ZOOM = 1.2
/** The first view of a world is framed, then backed off by this factor so the whole scene sits in the view. */
export const ORBIT_FIRST_WIDEN = 2

/** The drag a press begins, or null when it does nothing (a creation tool). */
export function dragModeOf(e: { button: number; altKey: boolean; shiftKey: boolean; ctrlKey: boolean }, tool: string): OrbitDrag | null {
  if (e.button === 1) return e.ctrlKey ? 'zoom' : e.shiftKey ? 'pan' : 'orbit'
  if (e.button !== 0) return null
  if (e.altKey) return 'orbit'
  if (tool === 'hand') return 'pan'
  return tool === 'move' ? 'select' : null
}

/** Turns a drag of (dx, dy) screen px into the new view; `viewHeight` is the artboard's CSS height. */
export function dragView(view: OrbitView, mode: OrbitDrag, dx: number, dy: number, viewHeight: number): OrbitView {
  if (mode === 'orbit') return orbitBy(view, dx, dy)
  if (mode === 'pan') return panBy(view, dx, dy, viewHeight)
  if (mode === 'zoom') return zoomBy(view, Math.exp(ORBIT_ZOOM_PER_PX * dy))
  return view
}

/** The part of a wheel event the controls read. */
export interface WheelInput {
  deltaX: number
  deltaY: number
  deltaMode: number
  shiftKey: boolean
  ctrlKey: boolean
}

/** A trackpad sends pixel deltas that are small, sideways or fractional; a mouse wheel sends whole notches. */
export function isTrackpad(e: Pick<WheelInput, 'deltaX' | 'deltaY' | 'deltaMode'>): boolean {
  return e.deltaMode === 0 && (e.deltaX !== 0 || !Number.isInteger(e.deltaY) || Math.abs(e.deltaY) < 40)
}

/**
 * The view after a wheel event. A mouse wheel steps the distance by 1.15 a
 * notch (scrolling up comes closer). On a trackpad, scrolling orbits, Shift
 * pans and Ctrl (a pinch) zooms.
 */
export function wheelView(view: OrbitView, e: WheelInput, viewHeight: number): OrbitView {
  if (!isTrackpad(e)) {
    if (e.deltaY === 0) return view
    return zoomBy(view, e.deltaY > 0 ? ORBIT_WHEEL_STEP : 1 / ORBIT_WHEEL_STEP)
  }
  if (e.ctrlKey) return zoomBy(view, Math.exp(ORBIT_ZOOM_PER_PX * e.deltaY))
  if (e.shiftKey) return panBy(view, -e.deltaX, -e.deltaY, viewHeight)
  return orbitBy(view, e.deltaX * ORBIT_SCROLL_GAIN, e.deltaY * ORBIT_SCROLL_GAIN)
}

/** What a key asks of the orbit view: a new view, or to frame the selection or everything (the viewport knows the bounds). */
export type OrbitKeyResult = { view: OrbitView } | { frame: 'selection' | 'all' } | null

const clampPitch = (pitch: number) => Math.min(90, Math.max(-90, pitch))

/** The numpad and Home keys, by `KeyboardEvent.code`; null for any other key. */
export function orbitKey(view: OrbitView, code: string, ctrl: boolean): OrbitKeyResult {
  const turned = (axis: keyof typeof ORBIT_AXIS_VIEWS): OrbitKeyResult => ({ view: { ...view, ...ORBIT_AXIS_VIEWS[axis] } })
  switch (code) {
    case 'Numpad1':
      return turned(ctrl ? 'back' : 'front')
    case 'Numpad3':
      return turned(ctrl ? 'left' : 'right')
    case 'Numpad7':
      return turned(ctrl ? 'bottom' : 'top')
    case 'Numpad9':
      return { view: { ...view, yaw: normalizeYaw(view.yaw + 180), pitch: -view.pitch } }
    case 'Numpad4':
      return { view: { ...view, yaw: normalizeYaw(view.yaw - ORBIT_KEY_TURN) } }
    case 'Numpad6':
      return { view: { ...view, yaw: normalizeYaw(view.yaw + ORBIT_KEY_TURN) } }
    case 'Numpad8':
      return { view: { ...view, pitch: clampPitch(view.pitch + ORBIT_KEY_TURN) } }
    case 'Numpad2':
      return { view: { ...view, pitch: clampPitch(view.pitch - ORBIT_KEY_TURN) } }
    case 'NumpadAdd':
      return { view: zoomBy(view, 1 / ORBIT_KEY_ZOOM) }
    case 'NumpadSubtract':
      return { view: zoomBy(view, ORBIT_KEY_ZOOM) }
    case 'NumpadDecimal':
      return { frame: 'selection' }
    case 'Home':
      return { frame: 'all' }
    default:
      return null
  }
}

/**
 * `view` framed on `bounds` for a picture of this aspect (width / height),
 * then backed off by `widen`. With no bounds the view stays as it is.
 */
export function framedView(view: OrbitView, bounds: Bounds3 | null, aspect: number, widen = 1): OrbitView {
  if (!bounds) return view
  return zoomBy(frameBounds(view, bounds, aspect), widen)
}

/** The view a world opens with: everything framed from the default angle, backed off to twice the fit. */
export function firstView(bounds: Bounds3 | null, aspect: number): OrbitView {
  return framedView(DEFAULT_ORBIT_VIEW, bounds, aspect, ORBIT_FIRST_WIDEN)
}

/** Whether a press is a click: it stayed within this many px of where it began. */
export const CLICK_PX = 4
export const isClick = (dx: number, dy: number): boolean => Math.hypot(dx, dy) <= CLICK_PX

/** A click's new selection in the orbit view: `hit` is the picked layer id; Shift or Ctrl toggles it, an empty plain click clears. */
export function clickSelection(hit: string | null, additive: boolean): { id: string | null; additive: boolean } | null {
  if (hit === null) return additive ? null : { id: null, additive: false }
  return { id: hit, additive }
}
