import { type Comp, ease, evaluateProperty, isCurved, type Layer, type MotionKey, motionKeysOf, resolveProperty } from '@uve/core'
import { type Mat4, transformPoint } from './math'
import type { SceneNode } from './scene'

// Pure geometry for drawing and picking a layer's motion path on the viewport:
// everything is in screen pixels, and nothing here touches a canvas.

export type ScreenPoint = [x: number, y: number]

/** A sample of the path in screen px, with the comp time it is reached at. */
export interface PathPoint {
  x: number
  y: number
  timeMs: number
}

export interface MotionOverlay {
  layerId: string
  /**
   * One polyline per pair of neighbouring motion keys, screen px; each sample carries its comp time.
   * `fromMs`/`toMs` are the comp times of the two keys and `ease` is the first key's easing, which
   * together turn a time on the segment into the curve parameter.
   */
  segments: { index: number; curved: boolean; fromMs: number; toMs: number; ease: MotionKey['ease']; points: PathPoint[] }[]
  /** Direction marks along the motion, one per comp frame (at most 240), none within half a frame of a key. angle = radians in screen space (atan2 of the travel direction). */
  chevrons: { x: number; y: number; angle: number; timeMs: number }[]
  /** One per motion key; smooth = it has an in or out handle. timeMs is comp time. */
  keys: { index: number; timeMs: number; x: number; y: number; smooth: boolean }[]
  /** Stored (non-null) handles only: the dot and the key it hangs from. */
  handles: { key: number; side: 'in' | 'out'; x: number; y: number; fromX: number; fromY: number }[]
  /** The layer's position at the playhead, when one is given and it is within the keys' span (inclusive). */
  playhead?: { x: number; y: number }
}

export interface MotionOverlayOptions {
  /** Parent space to comp space (the scene node's `above`); identity when absent. */
  above?: Mat4
  /** Comp time of the playhead. */
  playheadMs?: number
}

/** Samples per segment polyline (the polyline has one more point). */
const SEGMENT_STEPS = 32
/** The most chevrons one path shows. */
const MAX_CHEVRONS = 240

/**
 * The overlay of a layer's motion path, or null when it has fewer than two
 * motion keys. Positions are the layer's own (parent space), so a straight
 * segment whose x and y ease differently is drawn as it really moves.
 */
export function motionOverlay(
  layer: Layer,
  comp: Comp,
  toScreen: (x: number, y: number) => ScreenPoint,
  options: MotionOverlayOptions = {},
): MotionOverlay | null {
  const rows = motionKeysOf(layer)
  if (rows.length < 2) return null
  const first = rows[0] as MotionKey
  const last = rows[rows.length - 1] as MotionKey
  const xSpec = resolveProperty(layer, 'transform.x')[0]
  const ySpec = resolveProperty(layer, 'transform.y')[0]
  if (!xSpec || !ySpec) return null
  const above = options.above
  const startMs = layer.startMs

  const screen = (x: number, y: number): ScreenPoint => {
    if (!above) return toScreen(x, y)
    const p = transformPoint(above, x, y, 0)
    return toScreen(p[0], p[1])
  }
  // The layer's position at layer time `t`, on screen.
  const at = (t: number): ScreenPoint => {
    const x = evaluateProperty(layer, xSpec, t)
    const y = evaluateProperty(layer, ySpec, t)
    return screen(typeof x === 'number' ? x : 0, typeof y === 'number' ? y : 0)
  }

  const segments: MotionOverlay['segments'] = []
  for (let i = 0; i + 1 < rows.length; i++) {
    const a = rows[i] as MotionKey
    const b = rows[i + 1] as MotionKey
    const points: PathPoint[] = []
    for (let j = 0; j <= SEGMENT_STEPS; j++) {
      const t = j === SEGMENT_STEPS ? b.t : a.t + ((b.t - a.t) * j) / SEGMENT_STEPS
      const [x, y] = at(t)
      points.push({ x, y, timeMs: startMs + t })
    }
    segments.push({ index: i, curved: isCurved(a, b), fromMs: startMs + a.t, toMs: startMs + b.t, ease: a.ease, points })
  }

  const keys: MotionOverlay['keys'] = []
  const handles: MotionOverlay['handles'] = []
  rows.forEach((k, index) => {
    const [x, y] = screen(k.x, k.y)
    keys.push({ index, timeMs: startMs + k.t, x, y, smooth: k.in !== null || k.out !== null })
    for (const side of ['in', 'out'] as const) {
      const v = k[side]
      if (!v) continue
      const [hx, hy] = screen(k.x + v[0], k.y + v[1])
      handles.push({ key: index, side, x: hx, y: hy, fromX: x, fromY: y })
    }
  })

  const chevrons = chevronsOf(rows, comp.fps, startMs, at)
  const overlay: MotionOverlay = { layerId: layer.id, segments, chevrons, keys, handles }
  const playheadT = options.playheadMs === undefined ? undefined : options.playheadMs - startMs
  if (playheadT !== undefined && playheadT >= first.t && playheadT <= last.t) {
    const [x, y] = at(playheadT)
    overlay.playhead = { x, y }
  }
  return overlay
}

/** One mark per comp frame inside the span, away from the keys, thinned to the cap. */
function chevronsOf(rows: readonly MotionKey[], fps: number, startMs: number, at: (t: number) => ScreenPoint): MotionOverlay['chevrons'] {
  const first = (rows[0] as MotionKey).t
  const last = (rows[rows.length - 1] as MotionKey).t
  const frameMs = 1000 / fps
  const half = frameMs / 2
  const times: number[] = []
  const eps = 1e-6
  for (let k = Math.ceil((startMs + first) / frameMs - eps); k * frameMs <= startMs + last + eps; k++) {
    const compMs = k * frameMs
    const t = Math.min(last, Math.max(first, compMs - startMs))
    if (rows.some((r) => Math.abs(r.t - t) < half - eps)) continue
    times.push(t)
  }
  let picked = times
  if (times.length > MAX_CHEVRONS) {
    picked = []
    for (let i = 0; i < MAX_CHEVRONS; i++) picked.push(times[Math.floor(((i + 0.5) * times.length) / MAX_CHEVRONS)] as number)
  }
  const out: MotionOverlay['chevrons'] = []
  for (const t of picked) {
    const a = at(Math.max(first, t - 0.5))
    const b = at(Math.min(last, t + 0.5))
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    if (dx === 0 && dy === 0) continue
    const [x, y] = at(t)
    out.push({ x, y, angle: Math.atan2(dy, dx), timeMs: startMs + t })
  }
  return out
}

/** How far from the pointer, in screen px, each part of the overlay still counts as hit. */
export const MOTION_HIT_RADIUS = { handle: 8, key: 9, segment: 7 } as const

export type MotionHit =
  | { kind: 'handle'; key: number; side: 'in' | 'out' }
  | { kind: 'key'; key: number; timeMs: number }
  | { kind: 'segment'; index: number; timeMs: number; u: number }

/** What is under a point: a handle first, then a key, then a segment; null when nothing is near. */
export function hitMotion(overlay: MotionOverlay, point: ScreenPoint): MotionHit | null {
  const [px, py] = point
  let handle: MotionOverlay['handles'][number] | undefined
  let best: number = MOTION_HIT_RADIUS.handle
  for (const h of overlay.handles) {
    const d = Math.hypot(h.x - px, h.y - py)
    if (d <= best) {
      best = d
      handle = h
    }
  }
  if (handle) return { kind: 'handle', key: handle.key, side: handle.side }

  let key: MotionOverlay['keys'][number] | undefined
  best = MOTION_HIT_RADIUS.key
  for (const k of overlay.keys) {
    const d = Math.hypot(k.x - px, k.y - py)
    if (d <= best) {
      best = d
      key = k
    }
  }
  if (key) return { kind: 'key', key: key.index, timeMs: key.timeMs }

  let hit: MotionHit | null = null
  best = MOTION_HIT_RADIUS.segment
  for (const seg of overlay.segments) {
    for (let i = 0; i + 1 < seg.points.length; i++) {
      const a = seg.points[i] as PathPoint
      const b = seg.points[i + 1] as PathPoint
      const vx = b.x - a.x
      const vy = b.y - a.y
      const len2 = vx * vx + vy * vy
      const s = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - a.x) * vx + (py - a.y) * vy) / len2))
      const d = Math.hypot(a.x + vx * s - px, a.y + vy * s - py)
      if (d > best) continue
      best = d
      const timeMs = a.timeMs + (b.timeMs - a.timeMs) * s
      const span = seg.toMs - seg.fromMs
      hit = { kind: 'segment', index: seg.index, timeMs, u: span > 0 ? ease(seg.ease, (timeMs - seg.fromMs) / span) : 0 }
    }
  }
  return hit
}

/** The scene node's `above` for a layer, found depth first through groups; undefined when the layer is not in the scene (or only inside a nested comp). */
export function parentMatrixOf(scene: readonly SceneNode[], layerId: string): Mat4 | undefined {
  for (const node of scene) {
    if (node.layer.id === layerId) return node.above
    if (node.kind === 'group') {
      const found = parentMatrixOf(node.children, layerId)
      if (found) return found
    }
  }
  return undefined
}
