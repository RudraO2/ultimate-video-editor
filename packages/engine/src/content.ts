import {
  type CaptionLook,
  type Comp,
  compsInside,
  type DrawOn,
  drawFillOpacity,
  drawPieceProgress,
  drawTrim,
  type GlyphPoses,
  type Pose,
  StrokeSchema,
  type Project,
  flattenSvgPath,
  type Highlight,
  type MediaAsset,
  type Paint,
  parseSvgPath,
  type ShapeGeometry,
  type Stroke,
  svgPathBounds,
  type TextRange,
  type TextStyle,
} from '@uve/core'
import { drawTextEffect, textEffectsReach } from './effects'
import { type ResolvedLayer, sourceTimeMs } from './evaluate'
import { polygonPoints, shapeOutline } from './outline'
import { applyMix, applyStrokeStyle, drawIsolated, type PaintBox, type PieceTrim, paintStyle, pixelScale, strokeOutline, strokeReach } from './paint'
import { FONT_PROBE_TEXT, scriptFontsOf } from './scripts'

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

/**
 * Supplies decoded media pictures: the frame of `media` at `sourceTimeMs`
 * for the layer `layerId` (images ignore the time). Returning null draws a
 * placeholder, for example while a file loads.
 */
export interface FrameProvider {
  frame(media: MediaAsset, sourceTimeMs: number, layerId: string): CanvasImageSource | null
}

export interface Box {
  width: number
  height: number
}

/** A layer's picture: its size, and how to draw it centred on the origin. */
export interface Content {
  /** The layer's box: what its pivot, outline and bounds refer to. */
  box: Box
  /** How far the picture may reach past the box on every side (strokes), px. */
  bleed?: number
  draw(ctx: Ctx2D): void
}

const requestedFonts = new Set<string>()

/** Starts loading a web font the first time it is used; the app re-renders when fonts finish loading. */
function ensureFont(font: string, text?: string): void {
  if (typeof document === 'undefined' || requestedFonts.has(font)) return
  requestedFonts.add(font)
  // With the text, a web font split by script (Google's are) loads the parts that have its letters.
  if (!document.fonts.check(font, text)) void document.fonts.load(font, text).catch(() => undefined)
}

/** The paints of a shape, path, text or group layer. */
export interface Paints {
  fills: readonly Paint[]
  strokes: readonly Stroke[]
}

/** A run's look: the layer's style with the range's fields on top, plus the range's own extras. */
export interface RunStyle extends TextStyle {
  /** Set when the range gives its own colour: it replaces the layer's fills there. */
  ownColor: boolean
  opacity: number
  /** Families of the scripts in the text (Devanagari, Tamil…) the font falls back to, quoted and comma-separated; '' for none. */
  fallback?: string
}

/** Whether the grapheme at `g` starts a word, for title case: after a space, a dash, a slash or an opening bracket or quote (not an apostrophe inside a word). */
function startsWord(units: readonly string[], g: number): boolean {
  const before = units[g - 1]
  if (before === undefined) return true
  if (/^[\s\-‐-―/([{"“‘«]/.test(before)) return true
  if (before === "'" || before === '’') {
    const earlier = units[g - 2]
    return earlier === undefined || !/\p{L}/u.test(earlier)
  }
  return false
}

/** A grapheme as displayed under a text case (the stored text never changes, so the indices of ranges and cues hold). */
function displayed(unit: string, textCase: TextStyle['textCase'], first: boolean): string {
  if (textCase === 'upper') return unit.toUpperCase()
  if (textCase === 'lower') return unit.toLowerCase()
  if (textCase === 'title' && first) return unit.toUpperCase()
  return unit
}

function fontString(style: TextStyle & { fallback?: string }): string {
  const family = style.fontFamily.replace(/["\\]/g, '')
  return `${style.italic ? 'italic ' : ''}${style.fontWeight} ${style.fontSize}px "${family}", ${style.fallback ?? ''}system-ui, sans-serif`
}

/** The fallback families for the scripts in a text, as fontString wants them. */
function fallbackFor(text: string): string {
  return scriptFontsOf(text)
    .map((s) => `"${s.family}", `)
    .join('')
}

/** The style of each range of a text layer, merged over the layer's. */
function rangeStyles(style: TextStyle, ranges: readonly TextRange[]): RunStyle[] {
  return ranges.map((r) => ({
    ...style,
    ...Object.fromEntries(Object.entries(r.style).filter(([k, v]) => v !== undefined && k !== 'opacity')),
    ownColor: r.style.color !== undefined,
    opacity: r.style.opacity ?? 1,
  }))
}

/** The CSS fonts a comp's text layers use (styled ranges, and the comps it nests, included), so an export can load them before its first frame. */
export function fontsOf(comp: Comp, comps: readonly Comp[] = []): string[] {
  const fonts = new Set<string>()
  const inside = compsInside({ comps } as Project, comp.id)
  for (const track of [comp, ...comps.filter((c) => inside.has(c.id))].flatMap((c) => c.tracks)) {
    for (const layer of track.layers) {
      if (layer.kind !== 'text') continue
      const fallback = fallbackFor(layer.text)
      fonts.add(fontString({ ...layer.style, fallback }))
      for (const style of rangeStyles(layer.style, layer.ranges)) fonts.add(fontString({ ...style, fallback }))
    }
  }
  return [...fonts]
}

function applyFont(ctx: Ctx2D | TextMeasurer, style: TextStyle): void {
  ctx.font = fontString(style)
  ctx.letterSpacing = `${style.letterSpacing}px`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
}

/** What text layout needs from a canvas context: the font to measure in, and string widths. */
export interface TextMeasurer {
  font: string
  letterSpacing: string
  textAlign: CanvasTextAlign
  textBaseline: CanvasTextBaseline
  measureText(text: string): { width: number }
}

/** A text layer's box settings: wrap width, fixed height and where the lines sit in it. */
export interface TextBoxSpec {
  maxWidth: number | null
  maxHeight: number | null
  verticalAlign: 'top' | 'middle' | 'bottom'
}

/** A piece of a line in one style. */
export interface TextFragment {
  text: string
  /** Left edge, from the box centre. */
  x: number
  width: number
  style: RunStyle
  /** Index of its first grapheme in the layer's text. */
  start: number
}

export interface TextLine {
  text: string
  width: number
  /** Left edge of the line, from the box centre. */
  x: number
  /** Top of the line box, from the box centre. */
  top: number
  /** Height of the line box: its largest font size times the line height. */
  height: number
  /** Its largest font size, which sets its baseline. */
  size: number
  fragments: TextFragment[]
}

export interface TextLayout {
  box: Box
  lines: TextLine[]
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const isSpace = (s: string) => /^\s+$/.test(s)

/** A word or a run of spaces, cut where the style changes. */
interface Token {
  space: boolean
  pieces: { text: string; style: RunStyle; width: number; start: number }[]
  width: number
}

/**
 * Lays out text in its box. Auto width (no maxWidth): one line per paragraph
 * and the box hugs the widest. Auto height (maxWidth): lines wrap between
 * words at the box width and the box is as tall as they are. Fixed (both):
 * the box keeps its size and verticalAlign places the lines in it. Styled
 * ranges change the font, size and look of their characters; a line is as
 * tall as its largest font.
 */
export function layoutText(measure: TextMeasurer, text: string, style: TextStyle, spec: TextBoxSpec, ranges: readonly TextRange[] = []): TextLayout {
  const fallback = fallbackFor(text)
  const base: RunStyle = { ...style, ownColor: false, opacity: 1, fallback }
  const styles = rangeStyles(style, ranges).map((s) => ({ ...s, fallback }))
  const styleAt = (g: number): RunStyle => {
    const i = ranges.findIndex((r) => g >= r.start && g < r.end)
    return i >= 0 ? (styles[i] as RunStyle) : base
  }
  const width = (s: string, st: RunStyle) => {
    applyFont(measure, st)
    return measure.measureText(s).width
  }

  // Paragraphs of tokens; each token's pieces keep one style.
  const units = Array.from(segmenter.segment(text), (s) => s.segment)
  const paragraphs: Token[][] = [[]]
  units.forEach((unit, g) => {
    if (unit === '\n' || unit === '\r\n') {
      paragraphs.push([])
      return
    }
    const tokens = paragraphs[paragraphs.length - 1] as Token[]
    const st = styleAt(g)
    const space = isSpace(unit)
    const shown = displayed(unit, st.textCase, startsWord(units, g))
    let token = tokens[tokens.length - 1]
    if (!token || token.space !== space) {
      token = { space, pieces: [], width: 0 }
      tokens.push(token)
    }
    const piece = token.pieces[token.pieces.length - 1]
    if (piece && piece.style === st) piece.text += shown
    else token.pieces.push({ text: shown, style: st, width: 0, start: g })
  })
  for (const tokens of paragraphs) {
    for (const token of tokens) {
      for (const piece of token.pieces) piece.width = width(piece.text, piece.style)
      token.width = token.pieces.reduce((sum, p) => sum + p.width, 0)
    }
  }

  // Lines: tokens wrapped between words; trailing spaces do not count.
  const rows: { tokens: Token[]; last: boolean }[] = []
  for (const tokens of paragraphs) {
    let row: Token[] = []
    let used = 0
    let wrapped = false
    const flush = (last: boolean) => {
      while (row.length > 0 && row[row.length - 1]?.space) row.pop()
      rows.push({ tokens: row, last })
      row = []
      used = 0
    }
    for (const token of tokens) {
      // A word that does not fit starts the next line; one longer than the box overflows on its own line.
      if (!token.space && spec.maxWidth !== null && row.some((t) => !t.space) && used + token.width > spec.maxWidth) {
        flush(false)
        wrapped = true
      }
      // Spaces at the start of a wrapped line are dropped.
      if (token.space && row.length === 0 && wrapped) continue
      row.push(token)
      used += token.width
    }
    flush(true)
  }

  const measured = rows.map((row) => {
    const size = Math.max(0, ...row.tokens.flatMap((t) => t.pieces.map((p) => p.style.fontSize)))
    return { ...row, size: size || style.fontSize, width: row.tokens.reduce((sum, t) => sum + t.width, 0) }
  })
  const contentWidth = Math.max(0, ...measured.map((r) => r.width))
  const contentHeight = measured.reduce((sum, r) => sum + r.size * style.lineHeight, 0)
  const box = { width: Math.max(1, spec.maxWidth ?? contentWidth), height: Math.max(1, spec.maxHeight ?? contentHeight) }
  let top =
    spec.maxHeight === null || spec.verticalAlign === 'top'
      ? -box.height / 2
      : spec.verticalAlign === 'bottom'
        ? box.height / 2 - contentHeight
        : -contentHeight / 2

  const lines = measured.map((row): TextLine => {
    const height = row.size * style.lineHeight
    const left = -box.width / 2
    const gaps = row.tokens.filter((t) => t.space).length
    const justify = style.align === 'justify' && !row.last && gaps > 0
    const x = style.align === 'right' ? box.width / 2 - row.width : style.align === 'center' ? -row.width / 2 : left
    const extra = justify ? (box.width - row.width) / gaps : 0
    const fragments: TextFragment[] = []
    let at = x
    for (const token of row.tokens) {
      for (const piece of token.pieces) {
        if (!token.space) fragments.push({ text: piece.text, x: at, width: piece.width, style: piece.style, start: piece.start })
        else if (piece.style.highlight || piece.style.decoration !== 'none') {
          fragments.push({ text: piece.text, x: at, width: piece.width + (justify ? extra : 0), style: piece.style, start: piece.start })
        }
        at += piece.width
      }
      if (token.space) at += extra
    }
    const line: TextLine = {
      text: row.tokens.map((t) => t.pieces.map((p) => p.text).join('')).join(''),
      width: justify ? box.width : row.width,
      x,
      top,
      height,
      size: row.size,
      fragments,
    }
    top += height
    return line
  })
  return { box, lines }
}

/** Highlight pills of a line: touching fragments with the same highlight join into one. */
function highlightPills(line: TextLine): { x: number; width: number; size: number; highlight: Highlight }[] {
  const pills: { x: number; width: number; size: number; highlight: Highlight; key: string }[] = []
  for (const f of line.fragments) {
    const h = f.style.highlight
    if (!h) continue
    const key = JSON.stringify(h)
    const last = pills[pills.length - 1]
    // Touching pieces (a highlighted phrase, spaces included) make one pill.
    if (last && last.key === key && Math.abs(last.x + last.width - f.x) < 0.5) {
      last.width = f.x + f.width - last.x
      last.size = Math.max(last.size, f.style.fontSize)
    } else pills.push({ x: f.x, width: f.width, size: f.style.fontSize, highlight: h, key })
  }
  return pills
}

/** Text drawn in one go: a fragment, or (while its units animate) part of one, with its unit's pose. */
interface GlyphRun {
  text: string
  /** Left and right edges, from the box centre. */
  x: number
  right: number
  /** Baseline. */
  y: number
  line: number
  style: RunStyle
  pose: Pose | null
  /** The centre of its unit on this line: what it turns and scales around (with the baseline). */
  pivotX: number
}

const samePose = (a: Pose, b: Pose) =>
  a === b || (a.opacity === b.opacity && a.dx === b.dx && a.dy === b.dy && a.scale === b.scale && a.rotation === b.rotation && a.blur === b.blur)

/**
 * What to draw: each fragment as it is, or, while units animate, cut where
 * the unit or its pose changes, each piece with its unit's pose.
 */
function glyphRuns(measure: Ctx2D, layout: TextLayout, baselineOf: (line: TextLine) => number, glyphs: GlyphPoses | undefined): GlyphRun[] {
  const runs: GlyphRun[] = []
  layout.lines.forEach((line, lineIndex) => {
    const y = baselineOf(line)
    // Spaces make runs only to carry a decoration across them; they have no ink.
    if (!glyphs) {
      for (const f of line.fragments) {
        if (!isSpace(f.text) || f.style.decoration !== 'none') {
          runs.push({ text: f.text, x: f.x, right: f.x + f.width, y, line: lineIndex, style: f.style, pose: null, pivotX: 0 })
        }
      }
      return
    }
    const pieces: (GlyphRun & { unit: number; last: number })[] = []
    for (const f of line.fragments) {
      if (isSpace(f.text) && f.style.decoration === 'none') continue
      applyFont(measure, f.style)
      let prefix = ''
      let left = 0
      Array.from(segmenter.segment(f.text), (s) => s.segment).forEach((char, k) => {
        const g = f.start + k
        prefix += char
        const right = measure.measureText(prefix).width
        const x = f.x + left
        left = right
        if (isSpace(char) && f.style.decoration === 'none') return
        const pose = glyphs.poses[g] ?? null
        const unit = glyphs.units[g] ?? -1
        const piece = pieces[pieces.length - 1]
        if (piece && piece.unit === unit && piece.last === g - 1 && piece.style === f.style && piece.pose && pose && samePose(piece.pose, pose)) {
          piece.text += char
          piece.right = f.x + right
          piece.last = g
        } else pieces.push({ text: char, x, right: f.x + right, y, line: lineIndex, style: f.style, pose, pivotX: 0, unit, last: g })
      })
    }
    // Each unit turns and scales around its own centre on the line.
    const extent = new Map<number, [number, number]>()
    for (const p of pieces) {
      const e = extent.get(p.unit)
      extent.set(p.unit, e ? [Math.min(e[0], p.x), Math.max(e[1], p.right)] : [p.x, p.right])
    }
    for (const { unit, last, ...p } of pieces) {
      const [a, b] = extent.get(unit) as [number, number]
      runs.push({ ...p, pivotX: (a + b) / 2 })
    }
  })
  return runs
}

/** The bar of a run's underline or strikethrough: its left edge, top, width and thickness, in the run's own space. */
function decorationBar(target: Ctx2D, run: GlyphRun): { x: number; y: number; width: number; height: number } | null {
  const { decoration, fontSize: size, fauxBold } = run.style
  if (decoration === 'none') return null
  const height = Math.max(1, size * 0.06) + size * fauxBold * 2
  const xHeight = target.measureText('x').actualBoundingBoxAscent || size * 0.5
  const centre = decoration === 'underline' ? run.y + size * 0.1 + height / 2 : run.y - xHeight / 2
  return { x: run.x, y: centre - height / 2, width: run.right - run.x, height }
}

/** Fills a run's glyphs in one paint; with fauxBold, a same-coloured outline thickens every edge. */
function inkText(target: Ctx2D, run: GlyphRun, ink: string | CanvasGradient | CanvasPattern): void {
  target.fillStyle = ink
  target.fillText(run.text, run.x, run.y)
  if (run.style.fauxBold > 0) {
    target.strokeStyle = ink
    target.lineWidth = run.style.fontSize * run.style.fauxBold * 2
    target.lineJoin = 'round'
    target.strokeText(run.text, run.x, run.y)
  }
}

/** Moves the context to a run's pose; false when the run is not visible. */
function placeRun(target: Ctx2D, run: GlyphRun): boolean {
  const pose = run.pose
  if (!pose) return true
  if (pose.opacity <= 0.001) return false
  target.globalAlpha *= Math.min(1, pose.opacity)
  // The blur is in layer pixels, measured before the unit's own scale.
  if (pose.blur > 0.05) target.filter = `blur(${(pose.blur * pixelScale(target)).toFixed(2)}px)`
  if (pose.dx !== 0 || pose.dy !== 0 || pose.rotation !== 0 || pose.scale !== 1) {
    target.translate(run.pivotX + pose.dx, run.y + pose.dy)
    if (pose.rotation !== 0) target.rotate((pose.rotation * Math.PI) / 180)
    if (pose.scale !== 1) target.scale(pose.scale, pose.scale)
    target.translate(-run.pivotX, -run.y)
  }
  return true
}

function textContent(
  measure: Ctx2D,
  text: string,
  style: TextStyle,
  spec: TextBoxSpec,
  clip: boolean,
  paints: Paints,
  ranges: readonly TextRange[],
  glyphs?: GlyphPoses,
  captionPill?: CaptionLook['pill'],
): Content {
  const fallback = fallbackFor(text)
  const letters = fallback ? FONT_PROBE_TEXT : undefined
  ensureFont(fontString({ ...style, fallback }), letters)
  for (const s of rangeStyles(style, ranges)) ensureFont(fontString({ ...s, fallback }), letters)
  const layout = layoutText(measure, text, style, spec, ranges)
  applyFont(measure, style)
  const probe = measure.measureText('Hg')
  // Ascent and descent as fractions of the size, from the layer's font, for every size on a line.
  const ascentRatio = (probe.fontBoundingBoxAscent || style.fontSize * 0.8) / style.fontSize
  const descentRatio = (probe.fontBoundingBoxDescent || style.fontSize * 0.2) / style.fontSize
  const baselineOf = (line: TextLine) => line.top + (line.height - line.size * (ascentRatio + descentRatio)) / 2 + line.size * ascentRatio
  const { box } = layout
  const paintBox: PaintBox = { x: -box.width / 2, y: -box.height / 2, width: box.width, height: box.height }
  const fills = paints.fills.filter((f) => f.enabled)
  const strokes = paints.strokes.filter((s) => s.enabled && s.width > 0)
  const runs = glyphRuns(measure, layout, baselineOf, glyphs)
  // Runs of spaces only carry a decoration across a gap; they have no ink unless asked for.
  const glyphsOf = (target: Ctx2D, paint: (target: Ctx2D, run: GlyphRun) => void, spaces = false) => {
    for (const run of runs) {
      if (!spaces && isSpace(run.text)) continue
      applyFont(target, run.style)
      target.save()
      target.globalAlpha *= run.style.opacity
      if (placeRun(target, run)) paint(target, run)
      target.restore()
    }
  }
  // While units animate, a pill shows as much as the most visible character on it.
  const pillOpacity = (line: number, left: number, right: number) =>
    glyphs ? Math.max(0, ...runs.filter((r) => r.line === line && r.x < right && r.right > left).map((r) => Math.min(1, r.pose?.opacity ?? 1))) : 1
  const maxSize = Math.max(style.fontSize, ...layout.lines.map((l) => l.size))
  // Units that move, grow or blur may leave the box.
  const reach = Math.max(0, ...(glyphs?.poses ?? []).map((p) => Math.max(Math.abs(p.dx), Math.abs(p.dy)) + Math.max(0, p.scale - 1) * maxSize + p.blur * 3))

  // A caption's gliding pill: the boxes of the cue it leaves and the cue it reaches, on their first line.
  const spanBox = ([a, b]: [number, number]) => {
    for (const line of layout.lines) {
      let left = Number.POSITIVE_INFINITY
      let right = Number.NEGATIVE_INFINITY
      for (const f of line.fragments) {
        const chars = Array.from(segmenter.segment(f.text), (x) => x.segment)
        const from = Math.max(a, f.start)
        const to = Math.min(b, f.start + chars.length)
        if (from >= to) continue
        applyFont(measure, f.style)
        const width = (n: number) => measure.measureText(chars.slice(0, n).join('')).width
        left = Math.min(left, f.x + width(from - f.start))
        right = Math.max(right, f.x + width(to - f.start))
      }
      if (right > left) {
        const y = baselineOf(line)
        return { x: left, width: right - left, top: y - line.size * ascentRatio, height: line.size * (ascentRatio + descentRatio) }
      }
    }
    return null
  }
  const pillFrom = captionPill?.from ? spanBox(captionPill.from) : null
  const pillTo = captionPill ? spanBox(captionPill.to) : null
  const textEffects = style.textEffects.filter((e) => e.enabled)
  // A glyph's own colour for effects that take it: its range's, else the first solid fill, else the ink.
  const firstSolid = fills.find((f) => f.type === 'solid')
  const inkOf = (run: GlyphRun) => (run.style.ownColor || !firstSolid || firstSolid.type !== 'solid' ? run.style.color : firstSolid.color)

  return {
    box,
    bleed: Math.max(0, ...strokes.map(strokeReach)) + maxSize * 0.25 + reach + textEffectsReach(textEffects),
    draw(ctx) {
      ctx.save()
      if (clip) {
        ctx.beginPath()
        ctx.rect(paintBox.x, paintBox.y, paintBox.width, paintBox.height)
        ctx.clip()
      }
      // Pills behind the text: the layer's behind each line, a range's behind its characters.
      layout.lines.forEach((line, lineIndex) => {
        const y = baselineOf(line)
        const pills = highlightPills(line)
        if (style.highlight && line.fragments.length > 0) {
          const first = line.fragments[0] as TextFragment
          const last = line.fragments[line.fragments.length - 1] as TextFragment
          pills.unshift({ x: first.x, width: last.x + last.width - first.x, size: line.size, highlight: style.highlight })
        }
        for (const pill of pills) {
          const alpha = pillOpacity(lineIndex, pill.x, pill.x + pill.width)
          if (alpha <= 0) continue
          const h = pill.highlight
          const top = y - pill.size * ascentRatio - h.paddingY
          const height = pill.size * (ascentRatio + descentRatio) + h.paddingY * 2
          ctx.save()
          ctx.globalAlpha *= alpha
          ctx.beginPath()
          ctx.roundRect(pill.x - h.paddingX, top, pill.width + h.paddingX * 2, height, Math.min(h.radius, height / 2))
          ctx.fillStyle = h.color
          ctx.fill()
          ctx.restore()
        }
      })
      if (captionPill && pillTo) {
        const k = pillFrom ? captionPill.t : 1
        const lerp = (x: number, y: number) => x + (y - x) * k
        const from = pillFrom ?? pillTo
        const h = captionPill.highlight
        const x = lerp(from.x, pillTo.x) - h.paddingX
        const top = lerp(from.top, pillTo.top) - h.paddingY
        const width = lerp(from.width, pillTo.width) + h.paddingX * 2
        const height = lerp(from.height, pillTo.height) + h.paddingY * 2
        ctx.save()
        ctx.beginPath()
        ctx.roundRect(x, top, width, height, Math.min(h.radius, height / 2))
        ctx.fillStyle = h.color
        ctx.fill()
        ctx.restore()
      }
      // Text effects under the glyphs, first card at the bottom; each moves with its glyph's pose.
      for (const effect of textEffects) {
        glyphsOf(ctx, (target, run) => {
          const color = effect.source === 'text' ? inkOf(run) : String(effect.color)
          drawTextEffect(target, effect, color, (dx, dy) => target.fillText(run.text, run.x + dx, run.y + dy))
        })
      }
      // The glyphs: a range's own colour, or the layer's fills (its ink colour when it has none).
      glyphsOf(ctx, (target, run) => {
        if (run.style.ownColor || fills.length === 0) {
          inkText(target, run, run.style.color)
          return
        }
        for (const fill of fills) {
          target.save()
          applyMix(target, fill.opacity, fill.blendMode)
          inkText(target, run, paintStyle(target, fill, paintBox))
          target.restore()
        }
      })
      // Underlines and strikethroughs, inked like the glyphs they belong to.
      glyphsOf(
        ctx,
        (target, run) => {
          const bar = decorationBar(target, run)
          if (!bar) return
          if (run.style.ownColor || fills.length === 0) {
            target.fillStyle = run.style.color
            target.fillRect(bar.x, bar.y, bar.width, bar.height)
            return
          }
          for (const fill of fills) {
            target.save()
            applyMix(target, fill.opacity, fill.blendMode)
            target.fillStyle = paintStyle(target, fill, paintBox)
            target.fillRect(bar.x, bar.y, bar.width, bar.height)
            target.restore()
          }
        },
        true,
      )
      for (const stroke of strokes) {
        if (stroke.align === 'center') {
          ctx.save()
          applyMix(ctx, stroke.opacity * stroke.paint.opacity, stroke.blendMode)
          glyphsOf(ctx, (target, run) => {
            applyStrokeStyle(target, stroke, paintBox)
            target.strokeText(run.text, run.x, run.y)
          })
          ctx.restore()
          continue
        }
        // Inside and outside: a stroke twice as wide, then the glyphs cut away (outside) or kept (inside).
        drawIsolated(
          ctx,
          (scratch) => {
            glyphsOf(scratch, (target, run) => {
              applyStrokeStyle(target, stroke, paintBox)
              target.strokeText(run.text, run.x, run.y)
            })
            scratch.globalCompositeOperation = stroke.align === 'outside' ? 'destination-out' : 'destination-in'
            glyphsOf(scratch, (target, run) => {
              target.fillStyle = '#000000'
              target.fillText(run.text, run.x, run.y)
            })
          },
          stroke.opacity * stroke.paint.opacity,
          stroke.blendMode,
        )
      }
      ctx.restore()
    },
  }
}

/**
 * A shape's or path's paints while it draws on: the fill fades as the
 * preset says, a layer with no stroke is inked with a pen in its fill's
 * colour, and each piece of the outline gets its own trim.
 */
function drawOnPaints(paints: Paints, draw: DrawOn | undefined): { paints: Paints; pieceTrim?: PieceTrim } {
  if (!draw) return { paints }
  const fillOpacity = drawFillOpacity(draw)
  const fills = paints.fills.map((f) => ({ ...f, opacity: f.opacity * fillOpacity }))
  let strokes = paints.strokes.filter((s) => s.enabled && s.width > 0)
  if (strokes.length === 0 && draw.pen > 0) {
    const first = paints.fills.find((f) => f.enabled)
    const color = !first ? '#ffffff' : first.type === 'solid' ? first.color : (first.stops[0]?.color ?? '#ffffff')
    strokes = [StrokeSchema.parse({ id: 'draw-pen', paint: { id: 'draw-pen', type: 'solid', color }, width: draw.pen, cap: 'round', join: 'round' })]
  }
  return { paints: { fills, strokes }, pieceTrim: (i, count) => drawTrim(draw, drawPieceProgress(draw, i, count)) }
}

function shapePath(shape: ShapeGeometry): Path2D {
  const { width, height } = shape
  const path = new Path2D()
  if (shape.type === 'ellipse') path.ellipse(0, 0, width / 2, height / 2, 0, 0, Math.PI * 2)
  else if (shape.type === 'polygon' || shape.type === 'star') {
    polygonPoints(shape).forEach(([x, y], i) => (i === 0 ? path.moveTo(x, y) : path.lineTo(x, y)))
    path.closePath()
  } else path.roundRect(-width / 2, -height / 2, width, height, Math.min(shape.cornerRadius, width / 2, height / 2))
  return path
}

function shapeContent(shape: ShapeGeometry, given: Paints, draw?: DrawOn): Content {
  const { width, height } = shape
  const { paints, pieceTrim } = drawOnPaints(given, draw)
  const paintBox: PaintBox = { x: -width / 2, y: -height / 2, width, height }
  return {
    box: { width, height },
    bleed: Math.max(0, ...paints.strokes.map(strokeReach)),
    draw(ctx) {
      const path = shapePath(shape)
      for (const fill of paints.fills) {
        if (!fill.enabled) continue
        ctx.save()
        applyMix(ctx, fill.opacity, fill.blendMode)
        ctx.fillStyle = paintStyle(ctx, fill, paintBox)
        ctx.fill(path)
        ctx.restore()
      }
      for (const stroke of paints.strokes) strokeOutline(ctx, stroke, path, (ppu) => [shapeOutline(shape, ppu)], paintBox, pieceTrim)
    },
  }
}

function placeholder(box: Box, label: string): Content {
  return {
    box,
    draw(ctx) {
      ctx.fillStyle = '#1d1d24'
      ctx.fillRect(-box.width / 2, -box.height / 2, box.width, box.height)
      ctx.strokeStyle = '#3a3a46'
      ctx.lineWidth = 2
      ctx.strokeRect(-box.width / 2, -box.height / 2, box.width, box.height)
      ctx.fillStyle = '#8d8d99'
      ctx.font = `${Math.max(12, Math.round(box.height / 12))}px system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(label, 0, 0, box.width * 0.9)
    },
  }
}

/** Builds the picture of a visual layer at a comp time; returns null for layers without one (audio). */
export function layerContent(
  measure: Ctx2D,
  resolved: ResolvedLayer,
  media: MediaAsset | undefined,
  timeMs: number,
  frames?: FrameProvider,
): Content | null {
  const { layer } = resolved
  switch (layer.kind) {
    case 'text':
      return textContent(
        measure,
        layer.text,
        resolved.style ?? layer.style,
        { ...(resolved.textBox ?? { maxWidth: layer.maxWidth, maxHeight: layer.maxHeight }), verticalAlign: layer.verticalAlign },
        layer.clipContent,
        { fills: resolved.fills ?? layer.fills, strokes: resolved.strokes ?? layer.strokes },
        resolved.ranges ?? layer.ranges,
        resolved.glyphs,
        resolved.captionPill,
      )
    case 'shape':
      return shapeContent(resolved.shape ?? layer.shape, { fills: resolved.fills ?? layer.fills, strokes: resolved.strokes ?? layer.strokes }, resolved.drawOn)
    case 'image':
    case 'video': {
      const box = { width: media?.width ?? 640, height: media?.height ?? 360 }
      const frame = media && frames ? frames.frame(media, sourceTimeMs(layer, timeMs), layer.id) : null
      if (!frame) return placeholder(box, media?.name ?? layer.name)
      return {
        box,
        draw(ctx) {
          ctx.drawImage(frame, -box.width / 2, -box.height / 2, box.width, box.height)
        },
      }
    }
    case 'path':
      return pathContent(resolved.geometry ?? layer.geometry, layer.geometry, layer.fillRule, {
        fills: resolved.fills ?? layer.fills,
        strokes: resolved.strokes ?? layer.strokes,
      }, resolved.drawOn)
    case 'group':
    case 'nested':
    case 'audio':
      // Groups and nested comps are drawn by the scene (see scene.ts): their members, and their container.
      return null
    case 'camera':
    case 'light':
    case 'empty':
    case 'mesh':
      // Draw nothing in 2D; worlds render these from A7d.
      return null
  }
}

/**
 * A path layer: `geometry` (maybe a morph in progress) drawn so that the box
 * around the resting outline, `base`, is centred on the origin.
 */
function pathContent(geometry: string, base: string, fillRule: CanvasFillRule, given: Paints, draw?: DrawOn): Content {
  const { paints, pieceTrim } = drawOnPaints(given, draw)
  const bounds = svgPathBounds(parseSvgPath(base))
  const cx = bounds.left + bounds.width / 2
  const cy = bounds.top + bounds.height / 2
  const paintBox: PaintBox = { x: bounds.left, y: bounds.top, width: Math.max(1, bounds.width), height: Math.max(1, bounds.height) }
  const commands = parseSvgPath(geometry)
  return {
    box: { width: Math.max(1, bounds.width), height: Math.max(1, bounds.height) },
    bleed: Math.max(0, ...paints.strokes.map(strokeReach)),
    draw(ctx) {
      const path = new Path2D(geometry)
      ctx.save()
      ctx.translate(-cx, -cy)
      for (const fill of paints.fills) {
        if (!fill.enabled) continue
        ctx.save()
        applyMix(ctx, fill.opacity, fill.blendMode)
        ctx.fillStyle = paintStyle(ctx, fill, paintBox)
        ctx.fill(path, fillRule)
        ctx.restore()
      }
      const outline = (ppu: number) => flattenSvgPath(commands, Math.max(8, Math.min(64, Math.round(ppu * 24))))
      for (const stroke of paints.strokes) strokeOutline(ctx, stroke, path, outline, paintBox, pieceTrim)
      ctx.restore()
    },
  }
}

/** A group's container: a rectangle of the layout's size with the group's paints. */
export function containerContent(width: number, height: number, cornerRadius: number, paints: Paints): Content {
  return shapeContent({ type: 'rect', width: Math.max(1, width), height: Math.max(1, height), cornerRadius, pointCount: 4, innerRatio: 1 }, paints)
}
