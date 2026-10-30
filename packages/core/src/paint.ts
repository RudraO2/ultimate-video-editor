import { z } from 'zod'
import { CommandError } from './errors'
import {
  BlendModeSchema,
  BoxPointSchema,
  ColorSchema,
  IdSchema,
  type Layer,
  optionalFields,
  type Paint,
  type Stroke,
  StrokeSchema,
  StrokeTrimSchema,
} from './schema'

// Paints as callers write them: a colour alone, or a paint object whose ids
// (and gradient ends) may be left out. They are completed here, so the
// document always holds full paints with ids.

const StopInputSchema = z.strictObject({
  id: IdSchema.optional(),
  offset: z.number().min(0).max(1),
  color: ColorSchema,
})

const paintInputBase = {
  id: IdSchema.optional(),
  enabled: z.boolean().optional(),
  opacity: z.number().min(0).max(1).optional(),
  blendMode: BlendModeSchema.optional(),
}

const gradientInput = {
  stops: z.array(StopInputSchema).min(2),
  start: BoxPointSchema.optional(),
  end: BoxPointSchema.optional(),
}

export const PaintInputSchema = z.union([
  ColorSchema,
  z.discriminatedUnion('type', [
    z.strictObject({ ...paintInputBase, type: z.literal('solid'), color: ColorSchema }),
    z.strictObject({ ...paintInputBase, type: z.literal('linear'), ...gradientInput }),
    z.strictObject({ ...paintInputBase, type: z.literal('radial'), ...gradientInput }),
    z.strictObject({ ...paintInputBase, type: z.literal('angular'), ...gradientInput }),
  ]),
])

export type PaintInput = z.infer<typeof PaintInputSchema>

export const StrokeInputSchema = z.union([
  ColorSchema.describe('A colour: a 4 px centred stroke'),
  z.strictObject({ color: ColorSchema, width: z.number().min(0).default(4) }),
  z.strictObject({
    ...paintInputBase,
    paint: PaintInputSchema,
    width: z.number().min(0).default(2),
    align: StrokeSchema.shape.align.optional(),
    cap: StrokeSchema.shape.cap.optional(),
    join: StrokeSchema.shape.join.optional(),
    dash: z.array(z.number().min(0)).optional(),
    dashOffset: z.number().optional(),
    trim: optionalFields(StrokeTrimSchema).optional(),
  }),
])

export type StrokeInput = z.infer<typeof StrokeInputSchema>

export type MintId = (prefix: string) => string

/** A full paint from any accepted shape, with ids minted where missing. */
export function toPaint(input: PaintInput, ids: MintId): Paint {
  const id = typeof input === 'string' ? undefined : input.id
  const base = {
    id: id ?? ids('paint'),
    enabled: typeof input === 'string' ? true : (input.enabled ?? true),
    opacity: typeof input === 'string' ? 1 : (input.opacity ?? 1),
    blendMode: typeof input === 'string' ? ('normal' as const) : (input.blendMode ?? 'normal'),
  }
  if (typeof input === 'string') return { ...base, type: 'solid', color: input }
  if (input.type === 'solid') return { ...base, type: 'solid', color: input.color }
  return {
    ...base,
    type: input.type,
    stops: input.stops.map((stop) => ({ id: stop.id ?? ids('stop'), offset: stop.offset, color: stop.color })),
    start: input.start ?? (input.type === 'linear' ? { x: 0, y: 0.5 } : { x: 0.5, y: 0.5 }),
    end: input.end ?? { x: 1, y: 0.5 },
  }
}

/** A full stroke from any accepted shape, with ids minted where missing. */
export function toStroke(input: StrokeInput, ids: MintId): Stroke {
  const defaults = { enabled: true, opacity: 1, blendMode: 'normal' as const, align: 'center' as const, cap: 'butt' as const, join: 'miter' as const }
  const trim = { start: 0, end: 1, offset: 0 }
  if (typeof input === 'string') {
    return { id: ids('stroke'), ...defaults, paint: toPaint(input, ids), width: 4, dash: [], dashOffset: 0, trim }
  }
  if (!('paint' in input)) {
    return { id: ids('stroke'), ...defaults, paint: toPaint(input.color, ids), width: input.width, dash: [], dashOffset: 0, trim }
  }
  return {
    id: input.id ?? ids('stroke'),
    enabled: input.enabled ?? true,
    opacity: input.opacity ?? 1,
    blendMode: input.blendMode ?? 'normal',
    paint: toPaint(input.paint, ids),
    width: input.width,
    align: input.align ?? 'center',
    cap: input.cap ?? 'butt',
    join: input.join ?? 'miter',
    dash: input.dash ?? [],
    dashOffset: input.dashOffset ?? 0,
    trim: { ...trim, ...input.trim },
  }
}

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Mints the ids a layer's paints are missing, in place, before the layer is
 * validated (so `layer.patch` can insert `{type: "solid", color}`). Returns
 * nothing; validation reports anything else that is wrong.
 */
export function mintPaintIds(layer: Json, ids: MintId): void {
  const mintPaint = (paint: unknown) => {
    if (!isObject(paint)) return
    if (paint.id === undefined) paint.id = ids('paint')
    if (Array.isArray(paint.stops)) for (const stop of paint.stops) if (isObject(stop) && stop.id === undefined) stop.id = ids('stop')
  }
  if (Array.isArray(layer.fills)) for (const fill of layer.fills) mintPaint(fill)
  if (Array.isArray(layer.strokes)) {
    for (const stroke of layer.strokes) {
      if (!isObject(stroke)) continue
      if (stroke.id === undefined) stroke.id = ids('stroke')
      if (typeof stroke.paint === 'string') stroke.paint = { type: 'solid', color: stroke.paint }
      mintPaint(stroke.paint)
    }
  }
}

/** Refuses what a layer's paints cannot do yet: a trimmed stroke on text, which has no outline to follow. */
export function assertPaintsSupported(layer: Layer): void {
  if (layer.kind !== 'text') return
  const trimmed = layer.strokes.find((s) => s.trim.start !== 0 || s.trim.end !== 1 || s.trim.offset !== 0)
  if (trimmed) {
    throw new CommandError(
      `Stroke "${trimmed.id}" is trimmed, but trim draws along an outline and text has none to follow yet.`,
      'Trim strokes on shapes (and, later, paths). For text, reveal it with opacity or scale keys, or an outside stroke.',
    )
  }
}
