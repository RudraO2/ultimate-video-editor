import { z } from 'zod'
import { textUnits, unitCount, unitIndex } from '../animation'
import { EasingInputSchema, toEasing } from '../compat'
import { locateLayer } from '../doc'
import { CommandError, parseOrThrow } from '../errors'
import { defineCommand } from '../registry'
import { type Caption, type CaptionCue, CaptionSchema, CaptionStateSchema, IdSchema, type Layer, type Project } from '../schema'
import { graphemes } from '../textRanges'

const WordSchema = z.strictObject({
  text: z.string().min(1).optional().describe('The word (or words) as written in the layer; omitted: the next word'),
  startMs: z.number().min(0),
  endMs: z.number().min(0),
})

const StateInput = z.union([CaptionStateSchema, z.record(z.string(), z.unknown())])

/** The graphemes of a text, lowercased for matching. */
const lowered = (text: string) => graphemes(text).map((g) => g.toLowerCase())

/** Finds `needle` in the text's graphemes at or after `from`; returns [start, end) or null. */
function findFrom(hay: string[], needle: string[], from: number): [number, number] | null {
  outer: for (let i = from; i + needle.length <= hay.length; i++) {
    for (let k = 0; k < needle.length; k++) if (hay[i + k] !== needle[k]) continue outer
    return [i, i + needle.length]
  }
  return null
}

/** Each unit's grapheme span (spaces left out), in order. */
function unitSpans(text: string, unit: 'letter' | 'word' | 'line'): [number, number][] {
  const units = textUnits(text)
  const spans: [number, number][] = Array.from({ length: unitCount(units, unit) }, () => [Number.POSITIVE_INFINITY, -1])
  units.graphemes.forEach((g, i) => {
    if (/^\s+$/.test(g)) return
    const span = spans[unitIndex(units, i, unit)]
    if (!span) return
    span[0] = Math.min(span[0], i)
    span[1] = Math.max(span[1], i + 1)
  })
  return spans.filter(([a, b]) => b > a)
}

export const captionSet = defineCommand({
  name: 'caption.set',
  summary: "Make a text layer a word-synced caption, or change one: its cues (words with times), how unread, focus and read words look, and how they change.",
  details:
    'Cues, one of: words [{text?, startMs, endMs}] matched in order in the text (text omitted takes the next word); cues [{start, end, startMs, endMs}] by grapheme index; or even {unit, fromMs?, toMs?} to spread the words (letters, lines) evenly. Times are layer time unless timesIn is "comp". states merges into unread, focus and read ({style: {color, opacity, fontWeight, highlight}, scale}; AtomCut\'s {overlay: {props}} works too). motion: {durationMs, easing, travel} (travel: one pill glides from word to word). remove: true makes it plain text again. Defaults: unread words at 45 % opacity, the focus word dark on an amber pill at 108 %, read words full.',
  effect: 'write',
  input: z.strictObject({
    id: IdSchema,
    words: z.array(WordSchema).optional(),
    cues: z.array(z.strictObject({ start: z.number().int().min(0), end: z.number().int().min(1), startMs: z.number().min(0), endMs: z.number().min(0) })).optional(),
    even: z
      .strictObject({ unit: z.enum(['letter', 'word', 'line']).default('word'), fromMs: z.number().min(0).optional(), toMs: z.number().min(0).optional() })
      .optional(),
    timesIn: z.enum(['layer', 'comp']).default('layer'),
    states: z.strictObject({ unread: StateInput.optional(), focus: StateInput.optional(), read: StateInput.optional() }).optional(),
    motion: z.strictObject({ durationMs: z.number().min(0).max(4000).optional(), easing: EasingInputSchema.optional(), travel: z.boolean().optional() }).optional(),
    remove: z.boolean().optional(),
  }),
  run: (input, ctx) => {
    const { layer } = locateLayer(ctx.project, input.id)
    if (layer.kind !== 'text') throw new CommandError(`"${layer.name}" is a ${layer.kind} layer; captions are text.`)
    const write = (value: Caption | null, label: string) =>
      ctx.write(label, (draft: Project) => {
        const target = locateLayer(draft, layer.id).layer
        if (target.kind === 'text') target.caption = value
      })
    if (input.remove) {
      if (input.words || input.cues || input.even || input.states || input.motion) throw new CommandError('remove takes the caption off; it cannot be combined with other fields.')
      write(null, 'Remove caption')
      return { id: layer.id, removed: true }
    }
    const given = [input.words, input.cues, input.even].filter((v) => v !== undefined).length
    if (given > 1) throw new CommandError('Give one of words, cues or even.')
    const shift = input.timesIn === 'comp' ? layer.startMs : 0
    const local = (ms: number) => Math.max(0, ms - shift)
    const count = graphemes(layer.text).length
    let cues: CaptionCue[] | undefined
    if (input.words) {
      const hay = lowered(layer.text)
      const words = unitSpans(layer.text, 'word')
      let cursor = 0
      cues = input.words.map((w, i) => {
        let span: [number, number] | null
        if (w.text !== undefined) {
          span = findFrom(hay, lowered(w.text), cursor)
          if (!span) throw new CommandError(`Word ${i + 1} "${w.text}" is not in the text after the words before it.`, `The text is "${layer.text}". Words are matched in order, case-insensitively.`)
        } else {
          span = words.find(([a]) => a >= cursor) ?? null
          if (!span) throw new CommandError(`Word ${i + 1} has no text, and the text has no word left.`, 'Give the word\'s text, or fewer words.')
        }
        cursor = span[1]
        return { id: ctx.ids('cue'), start: span[0], end: span[1], startMs: local(w.startMs), endMs: local(w.endMs) }
      })
    } else if (input.cues) {
      cues = input.cues.map((c) => {
        if (c.end > count || c.start >= c.end) throw new CommandError(`Cue ${c.start}–${c.end} is outside the text (${count} characters) or empty.`)
        return { id: ctx.ids('cue'), start: c.start, end: c.end, startMs: local(c.startMs), endMs: local(c.endMs) }
      })
    } else if (input.even) {
      const spans = unitSpans(layer.text, input.even.unit)
      const from = input.even.fromMs !== undefined ? local(input.even.fromMs) : 0
      const to = input.even.toMs !== undefined ? local(input.even.toMs) : layer.durationMs
      if (to <= from) throw new CommandError('even needs toMs after fromMs.')
      const each = (to - from) / Math.max(1, spans.length)
      cues = spans.map(([a, b], i) => ({ id: ctx.ids('cue'), start: a, end: b, startMs: from + i * each, endMs: from + (i + 1) * each }))
    }
    for (const cue of cues ?? []) if (cue.endMs <= cue.startMs) throw new CommandError(`A cue ends (${cue.endMs} ms) before it starts (${cue.startMs} ms).`)
    const base = layer.caption ?? parseOrThrow(CaptionSchema, {}, 'The caption')
    const states = { ...base.states }
    for (const name of ['unread', 'focus', 'read'] as const) {
      const change = input.states?.[name]
      if (change === undefined) continue
      const parsed = parseOrThrow(CaptionStateSchema, change, `The ${name} state`)
      // Merged: fields left out keep their values.
      const raw = (change as { style?: object; overlay?: object }).style ?? (change as { overlay?: object }).overlay
      states[name] = { style: { ...base.states[name].style, ...(raw ? parsed.style : {}) }, scale: 'scale' in (change as object) ? parsed.scale : base.states[name].scale }
    }
    const motion = {
      ...base.motion,
      ...(input.motion?.durationMs !== undefined ? { durationMs: input.motion.durationMs } : {}),
      ...(input.motion?.easing !== undefined ? { easing: toEasing(input.motion.easing) } : {}),
      ...(input.motion?.travel !== undefined ? { travel: input.motion.travel } : {}),
    }
    const caption: Caption = { cues: cues ?? base.cues, states, motion }
    if (caption.cues.length === 0) throw new CommandError('A caption needs cues.', 'Give words, cues or even (even {unit: "word"} spreads the words over the layer).')
    write(caption, layer.caption ? 'Edit caption' : 'Make caption')
    const last = Math.max(...caption.cues.map((c) => c.endMs))
    return {
      id: layer.id,
      cues: caption.cues.length,
      lastCueEndsMs: last,
      ...(last > layer.durationMs ? { warnings: [`The last cue ends at ${Math.round(last)} ms, after the layer (${layer.durationMs} ms).`] } : {}),
    }
  },
})

/**
 * Moves a caption's cues with an edit of its text: cues before the change
 * stay, cues after it shift, a cue the change runs into takes the new words
 * (an insertion right at a cue's start shifts it). Cues left empty go.
 */
export function remapCues(layer: Extract<Layer, { kind: 'text' }>, nextText: string): Caption | null {
  if (!layer.caption) return null
  const a = graphemes(layer.text)
  const b = graphemes(nextText)
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++
  const oldEnd = a.length - suffix
  const newEnd = b.length - suffix
  const delta = b.length - a.length
  const cues = layer.caption.cues.flatMap((c) => {
    if (c.end <= prefix) return [c]
    if (c.start >= oldEnd) return [{ ...c, start: c.start + delta, end: c.end + delta }]
    const start = Math.min(c.start, prefix)
    const end = c.end > oldEnd ? c.end + delta : newEnd
    return end > start ? [{ ...c, start, end }] : []
  })
  return { ...layer.caption, cues }
}
