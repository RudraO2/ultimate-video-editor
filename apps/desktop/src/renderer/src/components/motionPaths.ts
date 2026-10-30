import { type Comp, hasMotionPath, hasWorldPath, isWorld, type Layer, type Project, type WorldCamera, worldMotionPath } from '@uve/core'
import {
  type CompRenderer,
  hitMotion,
  type Mat4,
  type MotionHit,
  type MotionOverlay,
  motionOverlay,
  type PathPoint,
  parentMatrixOf,
  type ScreenPoint,
  transformPoint,
} from '@uve/engine'
import type { SelectedKey } from '../store'
import { worldCameraAt } from './worldDrag'

// The motion path of the selected layers, drawn on the viewport's overlay canvas.
// Sizes are CSS px: the canvas is scaled so one unit here is one screen pixel,
// and hit testing uses the same space (px relative to the artboard's top-left).

/**
 * Sizes of the drawing, in CSS px (hit radii are in the engine's `MOTION_HIT_RADIUS`).
 * Measured on AtomCut 4.17.0 (see "Motion paths" in the research notes).
 */
export const MOTION_LOOK = {
  curveWidth: 1.5,
  /** The dark halo around the curve is this much wider, so it reads on any picture. */
  haloExtra: 1.5,
  /** A chevron's arms reach this far back along the travel and this far to each side. */
  chevronBack: 5.1,
  chevronSide: 2.9,
  chevronWidth: 1.5,
  chevronAlpha: 0.6,
  handleLineWidth: 1,
  /** The dark line under a handle's line. */
  handleLineHalo: 2.5,
  handleAlpha: 0.55,
  handleAlphaHover: 0.9,
  handleRadius: 3.5,
  handleRadiusHover: 4.75,
  /** Diamonds and handle dots sit on a dark disc this much larger. */
  markHalo: 1.2,
  markOutline: 1.5,
  keyRadius: 4,
  keyRadiusHover: 5.5,
  /** The soft ring around a hovered key or handle. */
  hoverRing: 11,
  hoverRingFill: 0.16,
  hoverRingStroke: 0.5,
  playheadRadius: 4,
  playheadRing: 1.5,
  badgeRadius: 9,
  badgeRing: 1.5,
  badgeHalo: 10.5,
  plusHalf: 4.1,
  plusWidth: 2,
} as const

/** Fallbacks for the `--color-motion*` tokens in styles.css, in case a stylesheet is missing. */
const FALLBACK_COLORS = { motion: '#8b5cf6', halo: 'rgb(10 10 14 / 62%)', ink: '#ffffff' }

export interface MotionColors {
  motion: string
  halo: string
  ink: string
}

/** The theme's motion colours; read once per draw. */
export function motionColors(): MotionColors {
  const style = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  return {
    motion: read('--color-motion', FALLBACK_COLORS.motion),
    halo: read('--color-motion-halo', FALLBACK_COLORS.halo),
    ink: read('--color-motion-ink', FALLBACK_COLORS.ink),
  }
}

/** What decides whether paths show, and for which layers. */
export interface MotionShowInput {
  motionPaths: boolean
  tool: string
  /** The Pen is drawing a path. */
  penActive: boolean
  comp: Comp
  selectedLayerId: string | null
  alsoSelected: readonly string[]
}

export interface MotionTarget {
  layer: Layer
  /** On a locked track: drawn, but never hovered or hit. */
  locked: boolean
}

/**
 * The layers whose motion path is drawn: the selection that is in the open comp,
 * on a track that is not hidden, with at least two motion keys (in a 3D world: keys on x, y or
 * z at two times). Selected layer first.
 */
export function motionTargets(input: MotionShowInput): MotionTarget[] {
  if (!input.motionPaths || input.tool !== 'move' || input.penActive || input.selectedLayerId === null) return []
  const ids = [input.selectedLayerId, ...input.alsoSelected]
  const { comp } = input
  const hasPath = isWorld(comp) ? (layer: Layer) => hasWorldPath(layer, comp) : hasMotionPath
  const found: MotionTarget[] = []
  for (const id of ids) {
    for (const track of input.comp.tracks) {
      const layer = track.layers.find((l) => l.id === id)
      if (!layer) continue
      if (!track.hidden && hasPath(layer)) found.push({ layer, locked: track.locked })
      break
    }
  }
  return found
}

/** A layer's overlay, in the screen space it was computed for. */
export interface MotionDrawable {
  layer: Layer
  locked: boolean
  overlay: MotionOverlay
  /** Parent space to comp space; absent when the layer's parent is the comp. */
  above?: Mat4
  /** A screen point (CSS px from the artboard's top-left) in comp space. */
  fromScreen: (point: ScreenPoint) => ScreenPoint
  /** A point of the layer's parent space on screen. */
  toScreen: (x: number, y: number) => ScreenPoint
}

/** What the viewport needs from the editor state. */
export interface MotionState extends Omit<MotionShowInput, 'comp' | 'penActive'> {
  project: Project
  timeMs: number
  pen: unknown
  selectedKey: SelectedKey | null
  motionHover: { layerId: string; hit: MotionHit } | null
}

/**
 * The overlay of a layer's motion path in a 3D world, through `camera`: read-only, so no
 * handles, chevrons or smooth keys. `k` is screen px per comp px (the artboard's scale).
 * Each run in front of the camera is a segment; the first x key's easing stands for all.
 */
export function worldOverlay(layer: Layer, comp: Comp, camera: WorldCamera, k: number, playheadMs?: number): MotionOverlay | null {
  const path = worldMotionPath(comp, layer.id, camera, playheadMs === undefined ? {} : { playheadMs })
  if (!path) return null
  const ease = layer.animations['transform.x']?.[0]?.ease ?? 'linear'
  const overlay: MotionOverlay = {
    layerId: layer.id,
    segments: path.runs.map((run, index) => ({
      index,
      curved: false,
      fromMs: run[0]?.timeMs ?? 0,
      toMs: run[run.length - 1]?.timeMs ?? 0,
      ease,
      points: run.map((p) => ({ x: p.x * k, y: p.y * k, timeMs: p.timeMs })),
    })),
    chevrons: [],
    keys: path.keys.map((key) => ({ index: key.index, timeMs: key.timeMs, x: key.x * k, y: key.y * k, smooth: false })),
    handles: [],
  }
  if (path.playhead) overlay.playhead = { x: path.playhead.x * k, y: path.playhead.y * k }
  return overlay
}

/** The overlays of the last draw, for hit testing between draws. */
let current: MotionDrawable[] = []

/**
 * Builds the overlays for the open comp and keeps them for `motionHitAt`.
 * `frameWidth` is the artboard's width in CSS px. The scene is built only when
 * some layer qualifies.
 */
export function updateMotionPaths(renderer: Pick<CompRenderer, 'scene'>, state: MotionState, comp: Comp, frameWidth: number): MotionDrawable[] {
  const targets = frameWidth > 0 ? motionTargets({ ...state, comp, penActive: state.pen !== null }) : []
  if (targets.length === 0) {
    current = []
    return current
  }
  const k = frameWidth / comp.width
  const toScreen = (x: number, y: number): ScreenPoint => [(x + comp.width / 2) * k, (y + comp.height / 2) * k]
  const fromScreen = ([x, y]: ScreenPoint): ScreenPoint => [x / k - comp.width / 2, y / k - comp.height / 2]
  const drawables: MotionDrawable[] = []
  if (isWorld(comp)) {
    // A world's path is seen through the camera at the playhead and is never hit (no editing in 3D yet).
    const camera = worldCameraAt(comp, state.timeMs)
    for (const { layer } of targets) {
      const overlay = worldOverlay(layer, comp, camera, k, state.timeMs)
      if (overlay) drawables.push({ layer, locked: true, overlay, fromScreen, toScreen })
    }
    current = drawables
    return current
  }
  const scene = renderer.scene(comp, state.project, state.timeMs)
  for (const { layer, locked } of targets) {
    // A layer that is not in the scene at this moment (outside its span) has no matrix: its parent space is taken as the comp.
    const above = parentMatrixOf(scene, layer.id)
    const overlay = motionOverlay(layer, comp, toScreen, { ...(above ? { above } : {}), playheadMs: state.timeMs })
    const parentToScreen = (x: number, y: number): ScreenPoint => {
      if (!above) return toScreen(x, y)
      const p = transformPoint(above, x, y, 0)
      return toScreen(p[0], p[1])
    }
    if (overlay) drawables.push({ layer, locked, overlay, ...(above ? { above } : {}), fromScreen, toScreen: parentToScreen })
  }
  current = drawables
  return current
}

/** The overlay of a layer as last drawn, if it is shown. */
export function motionDrawableOf(layerId: string): MotionDrawable | undefined {
  return current.find((d) => d.layer.id === layerId)
}

/** The part of an unlocked overlay under a point (CSS px from the artboard's top-left), or null. */
export function motionHitAt(point: ScreenPoint, drawables: readonly MotionDrawable[] = current): { layerId: string; hit: MotionHit } | null {
  for (const d of drawables) {
    if (d.locked) continue
    const hit = hitMotion(d.overlay, point)
    if (hit) return { layerId: d.layer.id, hit }
  }
  return null
}

type Hover = { layerId: string; hit: MotionHit } | null

/** Whether hover moved: another part, or (for a segment) another moment, which moves the badge. */
export function motionHoverChanged(a: Hover, b: Hover): boolean {
  if (a === b) return false
  if (!a || !b) return true
  if (a.layerId !== b.layerId || a.hit.kind !== b.hit.kind) return true
  const x = a.hit
  const y = b.hit
  if (x.kind === 'handle' && y.kind === 'handle') return x.key !== y.key || x.side !== y.side
  if (x.kind === 'key' && y.kind === 'key') return x.key !== y.key
  if (x.kind === 'segment' && y.kind === 'segment') return x.index !== y.index || x.timeMs !== y.timeMs
  return true
}

/** Whether a hover still points at something drawn (and unlocked). */
export function motionHoverValid(hover: Hover, drawables: readonly Pick<MotionDrawable, 'layer' | 'locked'>[]): boolean {
  return hover === null || drawables.some((d) => !d.locked && d.layer.id === hover.layerId)
}

/** The point of a segment at a comp time, interpolated along its polyline. */
export function pointAtTime(points: readonly PathPoint[], timeMs: number): ScreenPoint | null {
  const first = points[0]
  if (!first) return null
  if (timeMs <= first.timeMs) return [first.x, first.y]
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as PathPoint
    const b = points[i + 1] as PathPoint
    if (timeMs > b.timeMs) continue
    const span = b.timeMs - a.timeMs
    const s = span > 0 ? (timeMs - a.timeMs) / span : 0
    return [a.x + (b.x - a.x) * s, a.y + (b.y - a.y) * s]
  }
  const last = points[points.length - 1] as PathPoint
  return [last.x, last.y]
}

/** Whether a key of the overlay is the one picked in the Keyframes or Curves view (x or y, within half a ms). */
export function isSelectedMotionKey(selected: SelectedKey | null, layer: Layer, keyTimeMs: number): boolean {
  if (!selected || selected.layerId !== layer.id) return false
  if (selected.path !== 'transform.x' && selected.path !== 'transform.y') return false
  return Math.abs(layer.startMs + selected.t - keyTimeMs) <= 0.5
}

function diamond(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x, y - r)
  ctx.lineTo(x + r, y)
  ctx.lineTo(x, y + r)
  ctx.lineTo(x - r, y)
  ctx.closePath()
}

/** Fills and outlines the current path as a key or handle mark: purple on white when on, white on purple when idle. */
function mark(ctx: CanvasRenderingContext2D, on: boolean, colors: MotionColors): void {
  ctx.fillStyle = on ? colors.motion : colors.ink
  ctx.fill()
  ctx.strokeStyle = on ? colors.ink : colors.motion
  ctx.lineWidth = MOTION_LOOK.markOutline
  ctx.stroke()
}

/** The soft purple ring around a hovered key or handle. */
function hoverRing(ctx: CanvasRenderingContext2D, x: number, y: number, colors: MotionColors): void {
  ctx.beginPath()
  ctx.arc(x, y, MOTION_LOOK.hoverRing, 0, Math.PI * 2)
  ctx.fillStyle = colors.motion
  ctx.globalAlpha = MOTION_LOOK.hoverRingFill
  ctx.fill()
  ctx.strokeStyle = colors.motion
  ctx.lineWidth = 1
  ctx.globalAlpha = MOTION_LOOK.hoverRingStroke
  ctx.stroke()
  ctx.globalAlpha = 1
}

/**
 * Draws the overlays. `ctx` is the overlay canvas; `scale` is canvas pixels per
 * CSS px (canvas width over the artboard's client width).
 */
export function drawMotionPaths(
  ctx: CanvasRenderingContext2D,
  drawables: readonly MotionDrawable[],
  options: { scale: number; hover: Hover; selectedKey: SelectedKey | null; colors?: MotionColors },
): void {
  if (drawables.length === 0) return
  const L = MOTION_LOOK
  const colors = options.colors ?? motionColors()
  ctx.save()
  ctx.setTransform(options.scale, 0, 0, options.scale, 0, 0)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  for (const { layer, overlay } of drawables) {
    const hover = options.hover?.layerId === layer.id ? options.hover.hit : null

    // The curves: a dark halo under the purple line.
    for (const seg of overlay.segments) {
      const [first, ...rest] = seg.points
      if (!first) continue
      ctx.beginPath()
      ctx.moveTo(first.x, first.y)
      for (const p of rest) ctx.lineTo(p.x, p.y)
      ctx.strokeStyle = colors.halo
      ctx.lineWidth = L.curveWidth + L.haloExtra
      ctx.stroke()
      ctx.strokeStyle = colors.motion
      ctx.lineWidth = L.curveWidth
      ctx.stroke()
    }

    // Direction marks: an open V per frame, pointing along the travel.
    ctx.globalAlpha = L.chevronAlpha
    ctx.strokeStyle = colors.motion
    ctx.lineWidth = L.chevronWidth
    ctx.beginPath()
    for (const c of overlay.chevrons) {
      const dx = Math.cos(c.angle)
      const dy = Math.sin(c.angle)
      for (const side of [-1, 1]) {
        ctx.moveTo(c.x - dx * L.chevronBack - dy * side * L.chevronSide, c.y - dy * L.chevronBack + dx * side * L.chevronSide)
        ctx.lineTo(c.x, c.y)
      }
    }
    ctx.stroke()
    ctx.globalAlpha = 1

    // Handles: a thin line on a dark one, to a dot on a dark disc.
    for (const h of overlay.handles) {
      const hot = hover?.kind === 'handle' && hover.key === h.key && hover.side === h.side
      ctx.beginPath()
      ctx.moveTo(h.fromX, h.fromY)
      ctx.lineTo(h.x, h.y)
      ctx.strokeStyle = colors.halo
      ctx.lineWidth = L.handleLineHalo
      ctx.stroke()
      ctx.globalAlpha = hot ? L.handleAlphaHover : L.handleAlpha
      ctx.strokeStyle = colors.motion
      ctx.lineWidth = L.handleLineWidth
      ctx.stroke()
      ctx.globalAlpha = 1
      if (hot) hoverRing(ctx, h.x, h.y, colors)
      const r = hot ? L.handleRadiusHover : L.handleRadius
      ctx.beginPath()
      ctx.arc(h.x, h.y, r + L.markHalo, 0, Math.PI * 2)
      ctx.fillStyle = colors.halo
      ctx.fill()
      ctx.beginPath()
      ctx.arc(h.x, h.y, r, 0, Math.PI * 2)
      mark(ctx, hot, colors)
    }

    // Keys: a diamond on a dark one, filled when smooth, hovered or picked in the Keyframes view.
    for (const k of overlay.keys) {
      const hot = hover?.kind === 'key' && hover.key === k.index
      const r = hot ? L.keyRadiusHover : L.keyRadius
      if (hot) hoverRing(ctx, k.x, k.y, colors)
      diamond(ctx, k.x, k.y, r + L.markHalo)
      ctx.fillStyle = colors.halo
      ctx.fill()
      diamond(ctx, k.x, k.y, r)
      mark(ctx, hot || k.smooth || isSelectedMotionKey(options.selectedKey, layer, k.timeMs), colors)
    }

    // Where the layer is now.
    if (overlay.playhead) {
      ctx.beginPath()
      ctx.arc(overlay.playhead.x, overlay.playhead.y, L.playheadRadius, 0, Math.PI * 2)
      ctx.fillStyle = colors.motion
      ctx.fill()
      ctx.strokeStyle = colors.ink
      ctx.lineWidth = L.playheadRing
      ctx.stroke()
    }

    // A "+" badge on the hovered segment, where a key could be added.
    if (hover?.kind === 'segment') {
      const seg = overlay.segments.find((s) => s.index === hover.index)
      const at = seg ? pointAtTime(seg.points, hover.timeMs) : null
      if (at) {
        ctx.beginPath()
        ctx.arc(at[0], at[1], L.badgeHalo, 0, Math.PI * 2)
        ctx.fillStyle = colors.halo
        ctx.fill()
        ctx.beginPath()
        ctx.arc(at[0], at[1], L.badgeRadius, 0, Math.PI * 2)
        ctx.fillStyle = colors.motion
        ctx.fill()
        ctx.strokeStyle = colors.ink
        ctx.lineWidth = L.badgeRing
        ctx.stroke()
        ctx.lineWidth = L.plusWidth
        ctx.beginPath()
        ctx.moveTo(at[0] - L.plusHalf, at[1])
        ctx.lineTo(at[0] + L.plusHalf, at[1])
        ctx.moveTo(at[0], at[1] - L.plusHalf)
        ctx.lineTo(at[0], at[1] + L.plusHalf)
        ctx.stroke()
      }
    }
  }
  ctx.restore()
}
