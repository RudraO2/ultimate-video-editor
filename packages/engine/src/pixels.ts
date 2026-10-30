import { parseColor } from '@uve/core'

// Small helpers shared by the effect cards: scratch canvases the size of a
// layer's region, and lengths and directions through the layer's transform.

export type Point = [x: number, y: number]

export interface EffectEnv {
  /** Output px per layer px, as a 2×2 matrix (canvas a, b, c, d): layer (x, y) → (a·x + c·y, b·x + d·y). */
  linear: [a: number, b: number, c: number, d: number]
  /** The layer's box corners in region px: top-left, top-right, bottom-right, bottom-left. */
  box: [Point, Point, Point, Point]
  /** Time since the layer's start, ms (cards that move on their own). */
  timeMs: number
  /** What is already drawn under the layer's region (for glass), made on first use. */
  backdrop?: () => OffscreenCanvas
}

/** Output px per layer px, averaged over the two axes. */
export function unit(env: EffectEnv): number {
  const [a, b, c, d] = env.linear
  return Math.sqrt(Math.abs(a * d - b * c)) || Math.hypot(a, b) || 1
}

/** A layer-space vector in output px. */
export function vec(env: EffectEnv, x: number, y: number): Point {
  const [a, b, c, d] = env.linear
  return [a * x + c * y, b * x + d * y]
}

/** A layer-space direction (degrees, 0 right, 90 down) as a unit vector in output px. */
export function direction(env: EffectEnv, degrees: number): Point {
  const r = (degrees * Math.PI) / 180
  const [x, y] = vec(env, Math.cos(r), Math.sin(r))
  const length = Math.hypot(x, y) || 1
  return [x / length, y / length]
}

export function canvasLike(source: OffscreenCanvas): [OffscreenCanvas, OffscreenCanvasRenderingContext2D] {
  const canvas = new OffscreenCanvas(source.width, source.height)
  return [canvas, context(canvas)]
}

export function context(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D is not available')
  return ctx
}

export const blurOf = (px: number) => (px >= 0.2 ? `blur(${px.toFixed(2)}px)` : 'none')

/** A colour with its alpha split off: the opaque colour and the alpha, 0 to 1. */
export function splitAlpha(color: string): [opaque: string, alpha: number] {
  const rgba = parseColor(color)
  if (!rgba) return [color, 1]
  return [`rgb(${rgba[0]}, ${rgba[1]}, ${rgba[2]})`, rgba[3] / 255]
}
