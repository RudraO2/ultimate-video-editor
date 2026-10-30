import { CommandError } from './errors'
import type { TextRange, TextRangeStyle } from './schema'

// Styled ranges of a text, by grapheme index (what a reader counts as one
// character: an emoji with its modifiers is one). Ranges never overlap and are
// kept in order; styling part of a range splits it.

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** A text's graphemes, in order. */
export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (s) => s.segment)
}

/**
 * The grapheme spans a `text_style` call targets: `match` (a substring) with
 * `occurrence` (1 = the first, or "all"), or `start` and `end` indices.
 */
export function targetSpans(
  text: string,
  target: { match?: string; occurrence?: number | 'all'; start?: number; end?: number },
): [start: number, end: number][] {
  const units = graphemes(text)
  if (target.match === undefined) {
    const start = target.start ?? 0
    const end = Math.min(target.end ?? units.length, units.length)
    if (end <= start) throw new CommandError(`The range ${start}…${end} is empty (the text has ${units.length} characters).`)
    return [[start, end]]
  }
  if (target.match === '') throw new CommandError('match is empty.')
  // Grapheme index of each string offset where one starts.
  const at = new Map<number, number>()
  let offset = 0
  units.forEach((u, i) => {
    at.set(offset, i)
    offset += u.length
  })
  at.set(text.length, units.length)
  const spans: [number, number][] = []
  for (let from = text.indexOf(target.match); from >= 0; from = text.indexOf(target.match, from + Math.max(1, target.match.length))) {
    const s = at.get(from)
    const e = at.get(from + target.match.length)
    if (s !== undefined && e !== undefined) spans.push([s, e])
  }
  if (spans.length === 0) throw new CommandError(`"${target.match}" does not appear in the text.`, `The text is "${text.slice(0, 80)}".`)
  const occurrence = target.occurrence ?? 1
  if (occurrence === 'all') return spans
  const chosen = spans[occurrence - 1]
  if (!chosen) throw new CommandError(`"${target.match}" appears only ${spans.length} time${spans.length === 1 ? '' : 's'}.`)
  return [chosen]
}

/** Two run styles as one: `over` wins field by field. */
const merged = (under: TextRangeStyle, over: TextRangeStyle): TextRangeStyle => ({ ...under, ...over })

const sameStyle = (a: TextRangeStyle, b: TextRangeStyle) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Adds `style` to the graphemes [start, end): ranges it crosses are split, the
 * part inside takes the new fields on top of its own, and neighbours left
 * with the same style are joined. New pieces get ids from `newId`.
 */
export function styleRange(ranges: readonly TextRange[], start: number, end: number, style: TextRangeStyle, newId: () => string): TextRange[] {
  // Cut every range at start and end, then style what lies inside, then fill the gaps inside with new ranges.
  const pieces: TextRange[] = []
  for (const r of ranges) {
    const cuts = [r.start, ...[start, end].filter((c) => c > r.start && c < r.end), r.end]
    for (let i = 0; i < cuts.length - 1; i++) {
      const s = cuts[i] as number
      const e = cuts[i + 1] as number
      pieces.push({ id: i === 0 ? r.id : newId(), start: s, end: e, style: { ...r.style } })
    }
  }
  const styled = pieces.map((p) => (p.start >= start && p.end <= end ? { ...p, style: merged(p.style, style) } : p))
  // Gaps inside [start, end) that no range covered.
  const inside = styled.filter((p) => p.start < end && p.end > start).sort((a, b) => a.start - b.start)
  let at = start
  for (const p of inside) {
    if (p.start > at) styled.push({ id: newId(), start: at, end: p.start, style: { ...style } })
    at = Math.max(at, p.end)
  }
  if (at < end) styled.push({ id: newId(), start: at, end, style: { ...style } })
  styled.sort((a, b) => a.start - b.start)
  // Join touching neighbours with the same style.
  const out: TextRange[] = []
  for (const p of styled) {
    const last = out[out.length - 1]
    if (last && last.end === p.start && sameStyle(last.style, p.style)) last.end = p.end
    else out.push(p)
  }
  return out.filter((p) => p.end > p.start && Object.keys(p.style).length > 0)
}

/** Removes some fields (or all, with no `fields`) from the ranges over [start, end). */
export function unstyleRange(ranges: readonly TextRange[], start: number, end: number, fields: readonly (keyof TextRangeStyle)[] | null, newId: () => string): TextRange[] {
  const split = styleRange(ranges, start, end, {}, newId)
  return split
    .map((r) => {
      if (r.start < start || r.end > end) return r
      if (fields === null) return { ...r, style: {} }
      const style = { ...r.style }
      for (const f of fields) delete style[f]
      return { ...r, style }
    })
    .filter((r) => Object.keys(r.style).length > 0)
}

/**
 * Moves ranges to follow their words through an edit from `before` to
 * `after`: the changed stretch is found from the common start and end, text
 * before it keeps its ranges, text after it shifts, and a range over the
 * changed stretch stretches or shrinks with it.
 */
export function remapRanges(ranges: readonly TextRange[], before: string, after: string): TextRange[] {
  const a = graphemes(before)
  const b = graphemes(after)
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++
  const removed = a.length - prefix - suffix
  const inserted = b.length - prefix - suffix
  const map = (i: number, isEnd: boolean) => {
    if (i < prefix || (i === prefix && !isEnd)) return i
    if (i >= prefix + removed) return i - removed + inserted
    // Inside the changed stretch: a start goes to its beginning, an end to its new end.
    return isEnd ? prefix + inserted : prefix
  }
  return ranges
    .map((r) => ({ ...r, start: map(r.start, false), end: map(r.end, true) }))
    .filter((r) => r.end > r.start)
}

/**
 * Makes [start, end) one range of its own, for keys on part of a text: ranges
 * it crosses are cut at its edges (not joined back), and characters no range
 * styles get a new range with `fill`. Returns the range's id, or throws when
 * the stretch holds several differently styled parts.
 */
export function isolateRange(
  ranges: readonly TextRange[],
  start: number,
  end: number,
  fill: TextRangeStyle,
  newId: () => string,
): { ranges: TextRange[]; id: string } {
  const pieces: TextRange[] = []
  for (const r of ranges) {
    const cuts = [r.start, ...[start, end].filter((c) => c > r.start && c < r.end), r.end]
    for (let i = 0; i < cuts.length - 1; i++) {
      pieces.push({ id: i === 0 ? r.id : newId(), start: cuts[i] as number, end: cuts[i + 1] as number, style: { ...r.style } })
    }
  }
  const inside = pieces.filter((p) => p.start < end && p.end > start)
  if (inside.length === 1 && inside[0]?.start === start && inside[0]?.end === end) return { ranges: pieces, id: inside[0].id }
  if (inside.length > 0) {
    throw new CommandError(
      `Characters ${start}…${end} hold several differently styled parts, so they cannot be keyed as one.`,
      'Key each styled part (layer.properties lists the range.<id> paths), or clear their styles with text.style first.',
    )
  }
  const id = newId()
  pieces.push({ id, start, end, style: { ...fill } })
  pieces.sort((a, b) => a.start - b.start)
  return { ranges: pieces, id }
}
