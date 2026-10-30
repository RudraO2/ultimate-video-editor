import type { BlendMode, Paint, Stroke } from '@uve/core'
import type { Ctx2D } from './content'
import { type Polyline, trimOutline } from './outline'

/** A rectangle in layer space that gradient points (0–1) are measured in. */
export interface PaintBox {
  x: number
  y: number
  width: number
  height: number
}

const COMPOSITE: Record<BlendMode, GlobalCompositeOperation> = {
  normal: 'source-over',
  darken: 'darken',
  multiply: 'multiply',
  'color-burn': 'color-burn',
  lighten: 'lighten',
  screen: 'screen',
  'color-dodge': 'color-dodge',
  overlay: 'overlay',
  'soft-light': 'soft-light',
  'hard-light': 'hard-light',
  difference: 'difference',
  exclusion: 'exclusion',
  hue: 'hue',
  saturation: 'saturation',
  color: 'color',
  luminosity: 'luminosity',
}

/** What a paint fills or strokes with: a colour, or a gradient laid over `box`. */
export function paintStyle(ctx: Ctx2D, paint: Paint, box: PaintBox): string | CanvasGradient {
  if (paint.type === 'solid') return paint.color
  const x0 = box.x + paint.start.x * box.width
  const y0 = box.y + paint.start.y * box.height
  const x1 = box.x + paint.end.x * box.width
  const y1 = box.y + paint.end.y * box.height
  const gradient =
    paint.type === 'linear'
      ? ctx.createLinearGradient(x0, y0, x1, y1)
      : paint.type === 'radial'
        ? ctx.createRadialGradient(x0, y0, 0, x0, y0, Math.max(0.001, Math.hypot(x1 - x0, y1 - y0)))
        : ctx.createConicGradient(Math.atan2(y1 - y0, x1 - x0), x0, y0)
  for (const stop of [...paint.stops].sort((a, b) => a.offset - b.offset)) gradient.addColorStop(stop.offset, stop.color)
  return gradient
}

/** Applies a paint's opacity (on top of the layer's) and blend mode to the context. */
export function applyMix(ctx: Ctx2D, opacity: number, blend: BlendMode): void {
  ctx.globalAlpha *= opacity
  ctx.globalCompositeOperation = COMPOSITE[blend]
}

/** How far a stroke reaches past the outline it follows, in px. */
export function strokeReach(stroke: Stroke): number {
  if (!stroke.enabled || stroke.width <= 0 || stroke.align === 'inside') return 0
  const reach = stroke.align === 'outside' ? stroke.width : stroke.width / 2
  // A mitred corner sticks out further than the stroke is wide (up to √2 on a right angle).
  return stroke.join === 'miter' ? reach * Math.SQRT2 : reach
}

/** Sets a stroke's width, ends, corners and dashes; inside and outside strokes draw at twice the width and are clipped. */
export function applyStrokeStyle(ctx: Ctx2D, stroke: Stroke, box: PaintBox): void {
  ctx.lineWidth = stroke.align === 'center' ? stroke.width : stroke.width * 2
  ctx.lineCap = stroke.cap
  ctx.lineJoin = stroke.join
  ctx.setLineDash(stroke.dash)
  ctx.lineDashOffset = stroke.dashOffset
  ctx.strokeStyle = paintStyle(ctx, stroke.paint, box)
}

/** Output pixels per layer pixel under the context's current transform. */
export function pixelScale(ctx: Ctx2D): number {
  const m = ctx.getTransform()
  return Math.max(Math.hypot(m.a, m.b), Math.hypot(m.c, m.d))
}

/** Whether a stroke draws all of its outline. */
export function untrimmed(stroke: Stroke): boolean {
  return Math.abs(stroke.trim.end - stroke.trim.start) >= 1 || (stroke.trim.start === 0 && stroke.trim.end === 1)
}

/**
 * Strokes the outline `path` (Path2D, for exact curves). A trimmed stroke
 * follows the flattened `outline` pieces instead, drawing only their slices. Inside and
 * outside strokes are clipped to their side of the outline.
 */
/** A trim per piece of an outline (piece `i` of `count`), replacing the stroke's own: a draw-on. */
export type PieceTrim = (i: number, count: number) => { start: number; end: number; offset: number }

export function strokeOutline(
  ctx: Ctx2D,
  stroke: Stroke,
  path: Path2D,
  outline: (pixelsPerUnit: number) => Polyline[],
  box: PaintBox,
  pieceTrim?: PieceTrim,
): void {
  if (!stroke.enabled || stroke.width <= 0) return
  ctx.save()
  applyMix(ctx, stroke.opacity * stroke.paint.opacity, stroke.blendMode)
  applyStrokeStyle(ctx, stroke, box)
  if (stroke.align === 'inside') ctx.clip(path)
  if (stroke.align === 'outside') {
    const outside = new Path2D()
    const far = 1e6
    outside.rect(-far, -far, far * 2, far * 2)
    outside.addPath(path)
    ctx.clip(outside, 'evenodd')
  }
  if (untrimmed(stroke) && !pieceTrim) ctx.stroke(path)
  else {
    // Each piece of a compound outline is trimmed on its own, so they draw on together (or in turn, for a draw-on).
    const lines = outline(pixelScale(ctx))
    const pieces = lines.flatMap((line, i) => {
      const trim = pieceTrim ? pieceTrim(i, lines.length) : stroke.trim
      return trimOutline(line, trim.start, trim.end, trim.offset)
    })
    for (const piece of pieces) {
      const first = piece[0]
      if (!first || piece.length < 2) continue
      const line = new Path2D()
      line.moveTo(first[0], first[1])
      for (const [x, y] of piece.slice(1)) line.lineTo(x, y)
      ctx.stroke(line)
    }
  }
  ctx.restore()
}

/**
 * Draws on a scratch canvas the size of `ctx`'s, with the same transform, then
 * composites the result onto `ctx` with an opacity and a blend mode (or a
 * composite `operation`, for masks and cut-outs). Lets a
 * drawing use composite operations (cut-outs) without touching what is
 * already on `ctx`.
 */
export function drawIsolated(
  ctx: Ctx2D,
  draw: (scratch: OffscreenCanvasRenderingContext2D) => void,
  opacity: number,
  blend: BlendMode,
  operation?: GlobalCompositeOperation,
  /** A CSS filter for the composite, in canvas pixels (a blur). */
  filter?: string,
): void {
  const { width, height } = ctx.canvas
  const canvas = new OffscreenCanvas(Math.max(1, width), Math.max(1, height))
  const scratch = canvas.getContext('2d')
  if (!scratch) return
  scratch.setTransform(ctx.getTransform())
  draw(scratch)
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  applyMix(ctx, opacity, blend)
  if (operation) ctx.globalCompositeOperation = operation
  if (filter) ctx.filter = filter
  ctx.drawImage(canvas, 0, 0)
  ctx.restore()
}
