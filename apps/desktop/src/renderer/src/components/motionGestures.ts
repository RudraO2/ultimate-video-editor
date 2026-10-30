import { type MotionKey, motionKeysOf, type Vec2 } from '@uve/core'
import type { MotionHit, ScreenPoint } from '@uve/engine'
import { activeComp, beginGesture, findLayer, run, useEditor } from '../store'
import {
  DRAG_LATCH_PX,
  effectiveMode,
  HANDLE_REMOVE_PX,
  type PairMode,
  pairMode,
  parentFromComp,
  partnerValue,
  snapAngle,
  snapPoint,
} from './motionGestureMath'
import { type MotionDrawable, motionDrawableOf } from './motionPaths'

// Editing a motion path by hand on the viewport. Every edit is `motion.edit`;
// a drag is one gesture (one undo step) that starts once the pointer has moved
// DRAG_LATCH_PX from the press. Points are CSS px from the artboard's top-left.

type Found = { layerId: string; hit: MotionHit }

/** How close (screen px) a dragged point comes to another point's x or y, or the comp's centre and edges, before it snaps. */
const POINT_SNAP_PX = 6
/** A bend grabs the segment no closer than this to either end (AtomCut's clamp). */
const BEND_U = { min: 0.1, max: 0.9 } as const

const LABELS = {
  move: 'Move motion point',
  pull: 'Pull out motion handles',
  handle: 'Drag motion handle',
  bend: 'Bend motion path',
} as const

/** Everything a gesture needs about the point or segment under the press. */
interface Target {
  drawable: MotionDrawable
  id: string
  rows: MotionKey[]
  /** The key the hit belongs to (for a segment, its first key). */
  index: number
  row: MotionKey
  /** Comp time of that key, the `atMs` of `motion.edit`. */
  atMs: number
  /** A screen point in the layer's parent space. */
  toParent: (point: ScreenPoint) => Vec2
}

function targetOf(found: Found): Target | null {
  const drawable = motionDrawableOf(found.layerId)
  const layer = findLayer(useEditor.getState().project, found.layerId)
  if (!drawable || drawable.locked || !layer) return null
  const rows = motionKeysOf(layer)
  const index = found.hit.kind === 'segment' ? found.hit.index : found.hit.key
  const row = rows[index]
  const key = drawable.overlay.keys[index]
  if (!row || !key) return null
  const fromComp = parentFromComp(drawable.above)
  const toParent = (point: ScreenPoint): Vec2 => {
    const [x, y] = drawable.fromScreen(point)
    return fromComp(x, y)
  }
  return { drawable, id: layer.id, rows, index, row, atMs: key.timeMs, toParent }
}

/** Screen px per unit of the layer's parent space (the group chain's scale times the view's). */
function pxPerUnit(d: MotionDrawable): number {
  const [ax, ay] = d.toScreen(0, 0)
  const [bx, by] = d.toScreen(1, 0)
  return Math.hypot(bx - ax, by - ay) || 1
}

/** Where a moved point lands: whole px, or on a nearby target unless Ctrl is held or snapping is off. */
function movedPoint(target: Target, value: Vec2, free: boolean): Vec2 {
  const rounded: Vec2 = [Math.round(value[0]), Math.round(value[1])]
  if (free || !useEditor.getState().snapping) return rounded
  const others = target.rows.filter((_, i) => i !== target.index)
  const xs = others.map((r) => r.x)
  const ys = others.map((r) => r.y)
  // The comp's centre and edges only mean something when the parent space is the comp.
  if (!target.drawable.above) {
    const comp = activeComp(useEditor.getState())
    xs.push(0, -comp.width / 2, comp.width / 2)
    ys.push(0, -comp.height / 2, comp.height / 2)
  }
  const snapped = snapPoint(value, { xs, ys }, POINT_SNAP_PX / pxPerUnit(target.drawable))
  return [snapped.snappedX ?? rounded[0], snapped.snappedY ?? rounded[1]]
}

const minus = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]]

/** The `motion.edit` calls that set a handle and its partner while one is dragged. */
function handleCalls(target: Target, side: 'in' | 'out', value: Vec2 | null, mode: PairMode, alt: boolean): unknown[] {
  const other = side === 'in' ? 'out' : 'in'
  const partner = target.row[other]
  const faces = other === 'in' ? target.index > 0 : target.index < target.rows.length - 1
  const base = { id: target.id, atMs: target.atMs, op: 'handle' }
  const calls: unknown[] = [{ ...base, side, value }]
  if (faces) {
    // The partner follows a mirrored or collinear pair, and otherwise keeps what it had when the drag began.
    const follows = value ? partnerValue(value, partner, effectiveMode(mode, alt)) : undefined
    calls.push({ ...base, side: other, value: follows ?? partner })
  }
  return calls
}

const asBatch = (calls: unknown[]): [string, unknown] =>
  calls.length === 1 ? ['motion.edit', calls[0]] : ['api.batch', { calls: calls.map((input) => ({ command: 'motion.edit', input })) }]

/**
 * Starts a drag on part of a motion path: a key moves its point (Alt pulls out
 * symmetric handles), a handle reshapes the curve, a segment bends. `local`
 * turns a pointer event into artboard px; `element` takes the pointer's
 * events until it is let go. Returns false when the hit is not editable, so
 * the press can fall through to the layer under it.
 */
export function startMotionDrag(e: PointerEvent, found: Found, local: (ev: PointerEvent) => ScreenPoint, element: HTMLElement): boolean {
  const target = targetOf(found)
  if (!target) return false
  const { hit } = found
  const kind: keyof typeof LABELS = hit.kind === 'key' ? (e.altKey ? 'pull' : 'move') : hit.kind === 'segment' ? 'bend' : 'handle'
  const origin = local(e)
  const originParent = target.toParent(origin)
  const keyPoint: Vec2 = [target.row.x, target.row.y]
  const handleSide = hit.kind === 'handle' ? hit.side : 'out'
  const mode = pairMode(target.row[handleSide], target.row[handleSide === 'in' ? 'out' : 'in'])
  const u = hit.kind === 'segment' ? Math.min(BEND_U.max, Math.max(BEND_U.min, hit.u)) : 0.5
  let gesture: ReturnType<typeof beginGesture> | null = null

  const plan = (ev: PointerEvent, point: ScreenPoint): [string, unknown] => {
    const at = target.toParent(point)
    const { id, atMs } = target
    if (kind === 'move') {
      const value = movedPoint(target, [keyPoint[0] + at[0] - originParent[0], keyPoint[1] + at[1] - originParent[1]], ev.ctrlKey)
      return ['motion.edit', { id, atMs, op: 'move', value }]
    }
    if (kind === 'bend') {
      const seg = target.drawable.overlay.segments.find((s) => s.index === target.index)
      return ['motion.edit', { id, atMs: seg?.fromMs ?? atMs, op: 'bend', u, point: at }]
    }
    const v = ev.shiftKey ? snapAngle(minus(at, keyPoint)) : minus(at, keyPoint)
    if (kind === 'pull') {
      // The handle that leans toward the pointer is out, except on the last key, which only has in.
      const lastKey = target.index === target.rows.length - 1
      return ['motion.edit', { id, atMs, op: 'handle', side: lastKey ? 'in' : 'out', value: v, mirror: !lastKey }]
    }
    return asBatch(handleCalls(target, handleSide, v, mode, ev.altKey))
  }

  const move = (ev: PointerEvent) => {
    const point = local(ev)
    if (!gesture) {
      if (Math.hypot(point[0] - origin[0], point[1] - origin[1]) < DRAG_LATCH_PX) return
      gesture = beginGesture(LABELS[kind])
    }
    const [name, input] = plan(ev, point)
    gesture.request(name, input)
  }
  const finish = (ev: Event) => {
    element.removeEventListener('pointermove', move)
    element.removeEventListener('pointerup', finish)
    element.removeEventListener('pointercancel', finish)
    element.removeEventListener('lostpointercapture', finish)
    if (element.hasPointerCapture(e.pointerId)) element.releasePointerCapture(e.pointerId)
    if (gesture && kind === 'handle' && ev.type === 'pointerup') {
      // Let go on the key itself: the handle goes.
      const key = target.drawable.overlay.keys[target.index]
      const [x, y] = local(ev as PointerEvent)
      if (key && Math.hypot(x - key.x, y - key.y) < HANDLE_REMOVE_PX) {
        const [name, input] = asBatch(handleCalls(target, handleSide, null, mode, false))
        gesture.request(name, input)
      }
    }
    void gesture?.end()
    gesture = null
  }
  try {
    element.setPointerCapture(e.pointerId)
  } catch {
    // The pointer is already gone (or synthetic); events sent to the element still work.
  }
  element.addEventListener('pointermove', move)
  element.addEventListener('pointerup', finish)
  element.addEventListener('pointercancel', finish)
  element.addEventListener('lostpointercapture', finish)
  return true
}

/** Double-click: on a segment, a new point there; on a point, smooth to corner or back. Returns whether it handled the click. */
export function motionDoubleClick(found: Found | null): boolean {
  if (!found || found.hit.kind === 'handle') return false
  const target = targetOf(found)
  if (!target) return false
  if (found.hit.kind === 'segment') {
    // Whole ms keep the timeline tidy, unless that lands on a key.
    const timeMs = found.hit.timeMs
    const seg = target.drawable.overlay.segments.find((s) => s.index === target.index)
    const rounded = Math.round(timeMs)
    const atMs = seg && rounded > seg.fromMs && rounded < seg.toMs ? rounded : timeMs
    void run('motion.edit', { id: target.id, atMs, op: 'insert' })
    return true
  }
  void setMotionPoint(target.id, target.atMs, isSmooth(target.row) ? 'corner' : 'smooth')
  return true
}

/** A point with any handle is smooth: it is drawn filled, and double-click or "Make corner" takes its handles off. */
export function isSmooth(row: Pick<MotionKey, 'in' | 'out'>): boolean {
  return row.in !== null || row.out !== null
}

/** Right-click on a point opens its menu; returns whether it did. */
export function openMotionMenu(found: Found | null, client: { x: number; y: number }): boolean {
  if (!found || found.hit.kind !== 'key') return false
  const target = targetOf(found)
  if (!target) return false
  useEditor.setState({ motionMenu: { ...client, layerId: target.id, atMs: target.atMs }, motionHover: null })
  return true
}

/** The menu's and double-click's edits of one point. */
export function setMotionPoint(id: string, atMs: number, op: 'smooth' | 'corner' | 'delete') {
  return run('motion.edit', { id, atMs, op })
}
