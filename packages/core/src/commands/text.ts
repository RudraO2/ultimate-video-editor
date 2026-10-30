import { z } from 'zod'
import { locateLayer } from '../doc'
import { CommandError } from '../errors'
import { defineCommand } from '../registry'
import { IdSchema, type Layer, TextRangeStyleSchema } from '../schema'
import { remapCues } from './caption'
import { graphemes, remapRanges, styleRange, targetSpans, unstyleRange } from '../textRanges'

function textLayer(layer: Layer): Extract<Layer, { kind: 'text' }> {
  if (layer.kind !== 'text') throw new CommandError(`"${layer.name}" is a ${layer.kind} layer, not text.`)
  return layer
}

export const textSet = defineCommand({
  name: 'text.set',
  summary: "Replace a text layer's words, keeping its styled ranges on the words they style.",
  details: 'The edit is found from what the old and new text share at the start and the end: ranges before it stay, ranges after it move with their words, and a range over the changed words takes the new ones.',
  effect: 'write',
  input: z.strictObject({ id: IdSchema, text: z.string().min(1) }),
  run: ({ id, text }, ctx) => {
    const layer = textLayer(locateLayer(ctx.project, id).layer)
    const ranges = remapRanges(layer.ranges, layer.text, text)
    const caption = remapCues(layer, text)
    ctx.write('Edit text', (draft) => {
      const target = locateLayer(draft, layer.id).layer
      if (target.kind !== 'text') return
      target.text = text
      target.ranges = ranges
      if (caption) target.caption = caption
    })
    return { updated: layer.id, ranges: ranges.length }
  },
})

const StyleTargetSchema = {
  id: IdSchema,
  match: z.string().optional().describe('A substring to style; occurrence picks which'),
  occurrence: z.union([z.literal('all'), z.number().int().min(1)]).default(1).describe('1 is the first match; "all" styles every one'),
  start: z.number().int().min(0).optional().describe('First character (grapheme index), instead of match'),
  end: z.number().int().min(1).optional().describe('One past the last character'),
}

export const textStyle = defineCommand({
  name: 'text.style',
  summary: 'Style part of a text (a word, a phrase or a character range) without touching the rest.',
  details:
    'Target with match (a substring; occurrence picks which, or "all") or start and end (character indices, emoji counted as one). style is any of fontFamily, fontSize, fontWeight, fauxBold, italic, decoration (underline or strikethrough), textCase (upper, lower or title), color, letterSpacing, opacity and highlight ({color, radius, paddingX, paddingY}, a pill behind the characters); it is added to what the characters already have. A colour replaces the layer\'s fills there. clear: true (or a list of fields) removes range styling instead. To style the whole layer, use layer.set or layer.patch on style. Keys: range.<id>.color, .opacity and .fontSize (layer.properties lists the ids).',
  effect: 'write',
  input: z.strictObject({
    ...StyleTargetSchema,
    style: TextRangeStyleSchema.optional(),
    clear: z.union([z.literal(true), z.array(TextRangeStyleSchema.keyof()).min(1)]).optional().describe('Remove range styling: true for all of it, or some fields'),
  }),
  run: ({ id, match, occurrence, start, end, style, clear }, ctx) => {
    const layer = textLayer(locateLayer(ctx.project, id).layer)
    if ((style === undefined) === (clear === undefined)) throw new CommandError('Give style, or clear to remove styling (not both).')
    if (style && Object.keys(style).length === 0) throw new CommandError('style is empty.', 'For example {"color": "#FFD60A", "fontWeight": 900}.')
    const spans = targetSpans(layer.text, { match, occurrence, start, end })
    let ranges = layer.ranges
    for (const [s, e] of spans) {
      ranges = style ? styleRange(ranges, s, e, style, () => ctx.ids('range')) : unstyleRange(ranges, s, e, clear === true ? null : (clear ?? []), () => ctx.ids('range'))
    }
    // Keys of ranges that were joined into a neighbour or cleared would animate nothing: drop them, and say so.
    const live = new Set(ranges.map((r) => r.id))
    const droppedKeys = Object.keys(layer.animations).filter((p) => p.startsWith('range.') && !live.has(p.split('.')[1] ?? ''))
    ctx.write(style ? 'Style text' : 'Clear text style', (draft) => {
      const target = locateLayer(draft, layer.id).layer
      if (target.kind !== 'text') return
      target.ranges = ranges
      for (const p of droppedKeys) delete target.animations[p]
    })
    const units = graphemes(layer.text)
    return {
      styled: spans.map(([s, e]) => ({ start: s, end: e, text: units.slice(s, e).join('') })),
      ranges: ranges.map((r) => ({ id: r.id, start: r.start, end: r.end, text: units.slice(r.start, r.end).join('') })),
      ...(droppedKeys.length > 0 ? { droppedKeys } : {}),
    }
  },
})
