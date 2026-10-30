import { z } from 'zod'
import { CommandError } from './errors'
import { EASING_PRESETS, type Easing, EasingSchema, HandleSchema, KeyValueSchema, SpatialSchema } from './schema'

// AtomCut's input shapes, accepted next to ours so an agent that learned
// AtomCut's tools works here unchanged. Each shape is listed in the schema as
// an alternative and turned into ours before a command writes anything.

const CSS_BEZIER = /^cubic-bezier\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)$/

/** An easing as ours (`"ease-out"`, `{type: "bezier", …}`) or AtomCut's (`"cubic-bezier(…)"`, `{kind: …}`). */
export const EasingInputSchema = z.union([
  EasingSchema,
  z.string().regex(CSS_BEZIER, 'Use a preset name or "cubic-bezier(x1, y1, x2, y2)"'),
  z.strictObject({ kind: z.literal('linear') }),
  z.strictObject({ kind: z.literal('preset'), name: z.enum(EASING_PRESETS) }),
  z.strictObject({ kind: z.literal('bezier'), values: z.tuple([z.number(), z.number(), z.number(), z.number()]) }),
])

export type EasingInput = z.infer<typeof EasingInputSchema>

function bezier(x1: number, y1: number, x2: number, y2: number): Easing {
  if (![x1, y1, x2, y2].every(Number.isFinite) || x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) {
    throw new CommandError(`cubic-bezier(${x1}, ${y1}, ${x2}, ${y2}) is not a timing curve.`, 'x1 and x2 must lie between 0 and 1.')
  }
  return { type: 'bezier', x1, y1, x2, y2 }
}

/** Turns any accepted easing shape into ours. */
export function toEasing(input: EasingInput): Easing {
  if (typeof input === 'string') {
    const css = CSS_BEZIER.exec(input)
    if (css) return bezier(Number(css[1]), Number(css[2]), Number(css[3]), Number(css[4]))
    return input as Easing
  }
  if ('type' in input) return input
  if (input.kind === 'linear') return 'linear'
  if (input.kind === 'preset') return input.name
  return bezier(...input.values)
}

/** A motion-path handle: px relative to its key. */
export type Handle = [number, number]

const ArcSchema = z
  .number()
  .nullable()
  .optional()
  .describe('position only: the segment leaving this key is a thrown arc peaking this many px above the higher end (negative: sags below). Easing defaults to linear = gravity.')
const InSchema = HandleSchema.optional().describe('position only: the curve handle arriving at this key, px relative to it.')
const OutSchema = HandleSchema.optional().describe('position only: the curve handle leaving this key, px relative to it.')

/**
 * A key as ours (`{t, v, ease, spatial}`) or AtomCut's (`{at, value, easing}`);
 * both take AtomCut's motion-path fields `arc`, `in` and `out`.
 */
export const KeyInputSchema = z.union([
  z.strictObject({
    t: z.number(),
    v: KeyValueSchema,
    ease: EasingInputSchema.optional(),
    spatial: SpatialSchema.optional().describe('Position only: the motion-path handles on this key, replacing its old ones ({in, out}, px relative to the key; null for none)'),
    arc: ArcSchema,
    in: InSchema,
    out: OutSchema,
  }),
  z.strictObject({
    at: z.number(),
    value: KeyValueSchema,
    easing: EasingInputSchema.optional(),
    arc: ArcSchema,
    in: InSchema,
    out: OutSchema,
  }),
])

export type KeyInput = z.infer<typeof KeyInputSchema>

/**
 * A key in our shape: time, value and, when given, the easing. `arc`, `in` and
 * `out` are position-only motion-path input: `undefined` is not given, `null`
 * clears that handle. Our `spatial` gives both `in` and `out` at once.
 */
export interface ParsedKey {
  t: number
  v: z.infer<typeof KeyValueSchema>
  ease?: Easing
  arc?: number
  in?: Handle | null
  out?: Handle | null
}

export function toKey(input: KeyInput): ParsedKey {
  const key: ParsedKey = 't' in input ? { t: input.t, v: input.v } : { t: input.at, v: input.value }
  const ease = 't' in input ? input.ease : input.easing
  if (ease !== undefined) key.ease = toEasing(ease)
  if ('t' in input && input.spatial) {
    if (input.in !== undefined || input.out !== undefined) {
      throw new CommandError('A key takes spatial or in/out, not both.', 'spatial is {in, out} in one field; give the handles one way.')
    }
    key.in = input.spatial.in
    key.out = input.spatial.out
  }
  if (input.arc !== undefined && input.arc !== null) key.arc = input.arc
  if (input.in !== undefined) key.in = input.in
  if (input.out !== undefined) key.out = input.out
  return key
}

/** One id or a list (AtomCut's `ids`), as a list without duplicates. */
export function idList(id: string | undefined, ids: string | string[] | undefined): string[] {
  if (id !== undefined && ids !== undefined) throw new CommandError('Give id or ids, not both.')
  const list = id !== undefined ? [id] : typeof ids === 'string' ? [ids] : (ids ?? [])
  if (list.length === 0) throw new CommandError('Say which layer: id, or ids for several.')
  return [...new Set(list)]
}

/**
 * Input fields that name the same thing under AtomCut's name. The registry
 * renames them before validation when the command has the field under our
 * name and the caller did not also give it.
 */
export const FIELD_ALIASES: Readonly<Record<string, string>> = {
  frameId: 'compId',
  openFrameId: 'compId',
  toFrameId: 'toCompId',
  sourceFrameId: 'sourceCompId',
}
