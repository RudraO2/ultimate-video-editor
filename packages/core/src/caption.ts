import { type GlyphPoses } from './animation'
import { REST_POSE, type Pose } from './animationPresets'
import { ease } from './easing'
import { formatColor, parseColor } from './interpolate'
import type { Caption, CaptionCue, CaptionState, Highlight, TextRange, TextRangeStyle } from './schema'
import { graphemes } from './textRanges'

// Captions: each cue (a span of the text with the times it is spoken) is
// unread before its start, in focus while it is spoken and read after; each
// state has its own look, blended over `motion.durationMs` as a cue changes
// state. Our resolution of AtomCut's caption model: the looks become styled
// ranges laid over the layer's own, the scales become glyph poses, and with
// `travel` one focus pill glides from cue to cue.

export type CaptionStateName = 'unread' | 'focus' | 'read'

/** A cue's state at layer time `t`. */
export function cueState(cue: CaptionCue, t: number): CaptionStateName {
  return t < cue.startMs ? 'unread' : t >= cue.endMs ? 'read' : 'focus'
}

/** The cue in focus at layer time `t` (the last one, if cues overlap), or -1. */
export function focusCue(caption: Caption, t: number): number {
  for (let i = caption.cues.length - 1; i >= 0; i--) {
    const cue = caption.cues[i] as CaptionCue
    if (t >= cue.startMs && t < cue.endMs) return i
  }
  return -1
}

type Look = { color?: string; opacity: number; fontWeight?: number; highlight: Highlight | null; scale: number }

const lookOf = (state: CaptionState): Look => ({
  ...(state.style.color !== undefined ? { color: state.style.color } : {}),
  ...(state.style.fontWeight !== undefined ? { fontWeight: state.style.fontWeight } : {}),
  opacity: state.style.opacity ?? 1,
  highlight: state.style.highlight ?? null,
  scale: state.scale,
})

/** A colour with its alpha scaled. */
function fade(color: string, k: number): string {
  const rgba = parseColor(color)
  return rgba ? formatColor([rgba[0], rgba[1], rgba[2], rgba[3] * k]) : color
}

function mixColor(a: string, b: string, k: number): string {
  const x = parseColor(a)
  const y = parseColor(b)
  if (!x || !y) return k < 0.5 ? a : b
  return formatColor([0, 1, 2, 3].map((i) => (x[i] as number) + ((y[i] as number) - (x[i] as number)) * k) as [number, number, number, number])
}

/** A look part way (k) from one state to another; `ink` stands for a state that keeps the layer's colour. */
function blend(a: Look, b: Look, k: number, ink: string): Look {
  const highlight =
    a.highlight && b.highlight
      ? {
          color: mixColor(a.highlight.color, b.highlight.color, k),
          radius: a.highlight.radius + (b.highlight.radius - a.highlight.radius) * k,
          paddingX: a.highlight.paddingX + (b.highlight.paddingX - a.highlight.paddingX) * k,
          paddingY: a.highlight.paddingY + (b.highlight.paddingY - a.highlight.paddingY) * k,
        }
      : b.highlight
        ? { ...b.highlight, color: fade(b.highlight.color, k) }
        : a.highlight
          ? { ...a.highlight, color: fade(a.highlight.color, 1 - k) }
          : null
  const color = a.color === undefined && b.color === undefined ? undefined : mixColor(a.color ?? ink, b.color ?? ink, k)
  const fontWeight = k < 0.5 ? a.fontWeight : b.fontWeight
  return {
    ...(color !== undefined ? { color } : {}),
    ...(fontWeight !== undefined ? { fontWeight } : {}),
    opacity: a.opacity + (b.opacity - a.opacity) * k,
    highlight,
    scale: a.scale + (b.scale - a.scale) * k,
  }
}

/** The state a cue came from when it entered `state`, and when it did. */
const ENTERED: Record<CaptionStateName, { from: CaptionStateName | null; at: (cue: CaptionCue) => number }> = {
  unread: { from: null, at: () => 0 },
  focus: { from: 'unread', at: (cue) => cue.startMs },
  read: { from: 'focus', at: (cue) => cue.endMs },
}

/** How a cue looks at layer time `t`. */
function cueLook(caption: Caption, cue: CaptionCue, t: number, ink: string): Look {
  const state = cueState(cue, t)
  const look = lookOf(caption.states[state])
  const { from, at } = ENTERED[state]
  const d = caption.motion.durationMs
  if (!from || d <= 0 || t - at(cue) >= d) return look
  return blend(lookOf(caption.states[from]), look, ease(caption.motion.easing, Math.max(0, (t - at(cue)) / d)), ink)
}

export interface CaptionLook {
  /** Styles per grapheme span, ready to lay over the layer's own ranges. */
  spans: { start: number; end: number; style: TextRangeStyle }[]
  /** Scale per grapheme span (each cue scales about its own centre). */
  scales: { start: number; end: number; scale: number; cue: number }[]
  /** The gliding focus pill (travel): from one cue's span to another's, t 0 to 1. */
  pill: { from: [number, number] | null; to: [number, number]; t: number; highlight: Highlight } | null
}

/** A caption's look at layer time `t`. `ink` is the layer's own text colour, which states that change no colour keep. */
export function captionLook(caption: Caption, t: number, ink: string): CaptionLook {
  const spans: CaptionLook['spans'] = []
  const scales: CaptionLook['scales'] = []
  const travel = caption.motion.travel
  caption.cues.forEach((cue, i) => {
    if (cue.end <= cue.start) return
    const look = cueLook(caption, cue, t, ink)
    const style: TextRangeStyle = {
      ...(look.color !== undefined ? { color: look.color } : {}),
      ...(look.fontWeight !== undefined ? { fontWeight: look.fontWeight } : {}),
      ...(look.opacity !== 1 ? { opacity: Math.min(1, Math.max(0, look.opacity)) } : {}),
      // With travel the pill is drawn once, gliding; the words themselves get none.
      ...(travel ? { highlight: null } : look.highlight ? { highlight: look.highlight } : {}),
    }
    if (Object.keys(style).length > 0) spans.push({ start: cue.start, end: cue.end, style })
    if (Math.abs(look.scale - 1) > 1e-4) scales.push({ start: cue.start, end: cue.end, scale: look.scale, cue: i })
  })
  let pill: CaptionLook['pill'] = null
  const highlight = caption.states.focus.style.highlight
  if (travel && highlight) {
    const i = focusCue(caption, t)
    const cue = caption.cues[i]
    if (cue) {
      const before = caption.cues[i - 1]
      const d = caption.motion.durationMs
      // It glides from the cue before when that one just ended; otherwise it fades in where it is.
      const glides = before !== undefined && cue.startMs - before.endMs <= Math.max(d, 50)
      const k = d > 0 ? ease(caption.motion.easing, Math.min(1, (t - cue.startMs) / d)) : 1
      pill = {
        from: glides ? [before.start, before.end] : null,
        to: [cue.start, cue.end],
        t: k,
        highlight: glides ? highlight : { ...highlight, color: fade(highlight.color, k) },
      }
    }
  }
  return { spans, scales, pill }
}

/**
 * Lays styled spans over a text's ranges: every grapheme gets the range's
 * style and then the span's on top, and runs of equal styles become the
 * new, non-overlapping ranges (ids `cap-<n>`).
 */
export function overlayRanges(text: string, ranges: readonly TextRange[], spans: CaptionLook['spans']): TextRange[] {
  if (spans.length === 0) return [...ranges]
  const count = graphemes(text).length
  const styles: (TextRangeStyle | null)[] = Array.from({ length: count }, () => null)
  for (const r of ranges) for (let g = Math.max(0, r.start); g < Math.min(count, r.end); g++) styles[g] = { ...r.style }
  for (const s of spans) for (let g = Math.max(0, s.start); g < Math.min(count, s.end); g++) styles[g] = { ...(styles[g] ?? {}), ...s.style }
  const out: TextRange[] = []
  let g = 0
  while (g < count) {
    const style = styles[g]
    if (!style) {
      g++
      continue
    }
    const key = JSON.stringify(style)
    let end = g + 1
    while (end < count && styles[end] && JSON.stringify(styles[end]) === key) end++
    out.push({ id: `cap-${out.length}`, start: g, end, style })
    g = end
  }
  return out
}

/** Glyph poses with each scaled cue's scale, laid over the animation's (or the rest pose). */
export function scaleGlyphs(text: string, glyphs: GlyphPoses | null, scales: CaptionLook['scales']): GlyphPoses | null {
  if (scales.length === 0) return glyphs
  const count = graphemes(text).length
  const poses: Pose[] = glyphs ? [...glyphs.poses] : Array.from({ length: count }, () => REST_POSE)
  // A scaled cue turns about its own centre: its graphemes share a unit of their own.
  const units: number[] = glyphs ? [...glyphs.units] : Array.from({ length: count }, (_, g) => -1 - g)
  for (const s of scales) {
    for (let g = Math.max(0, s.start); g < Math.min(count, s.end); g++) {
      const pose = poses[g] ?? REST_POSE
      poses[g] = { ...pose, scale: pose.scale * s.scale }
      units[g] = 100000 + s.cue
    }
  }
  return { poses, units }
}
