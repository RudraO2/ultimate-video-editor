import { type AnimationPreset, clamp01, findAnimationPreset, type Pose, REST_POSE } from './animationPresets'
import { ease } from './easing'
import type { AnimationUnit, Layer, LayerAnimation } from './schema'
import { graphemes } from './textRanges'

// Entrance and exit presets in time: when each unit of a text (or a whole
// layer) starts, and the pose it has at a moment. Unit timing follows
// AtomCut's: unit i of n enters at delay + i·stagger (+ jitter) after the
// layer's start, and leaves so that the last unit is gone `delay` before the
// layer's end.

export type AnimationSlot = 'in' | 'out'

/** A text cut into units: each grapheme's word and line (between line breaks). */
export interface TextUnits {
  graphemes: string[]
  word: number[]
  line: number[]
  wordCount: number
  lineCount: number
}

const isSpace = (s: string) => /^\s+$/.test(s)

export function textUnits(text: string): TextUnits {
  const chars = graphemes(text)
  const word: number[] = []
  const line: number[] = []
  let words = -1
  let lines = 0
  let afterSpace = true
  for (const char of chars) {
    if (char === '\n' || char === '\r\n') {
      // The break belongs to the line it ends; the next word starts fresh.
      word.push(Math.max(words, 0))
      line.push(lines)
      lines += 1
      afterSpace = true
      continue
    }
    const space = isSpace(char)
    if (!space && afterSpace) words += 1
    afterSpace = space
    word.push(Math.max(words, 0))
    line.push(lines)
  }
  return { graphemes: chars, word, line, wordCount: Math.max(words + 1, chars.length > 0 ? 1 : 0), lineCount: chars.length > 0 ? lines + 1 : 0 }
}

/** The unit grapheme `g` belongs to (letters count every grapheme, spaces too). */
export function unitIndex(units: TextUnits, g: number, unit: AnimationUnit): number {
  return unit === 'letter' ? g : unit === 'word' ? (units.word[g] ?? 0) : (units.line[g] ?? 0)
}

export function unitCount(units: TextUnits, unit: AnimationUnit): number {
  return unit === 'letter' ? units.graphemes.length : unit === 'word' ? units.wordCount : units.lineCount
}

/** From the first unit starting to the last one finishing, ms. */
export function animationSpanMs(spec: LayerAnimation, count: number): number {
  return count <= 0 ? 0 : (count - 1) * spec.staggerMs + spec.durationMs
}

/** A repeatable number in [0, 1) for a layer, slot, unit and stream. */
export function unitSeed(layerId: string, slot: AnimationSlot, index: number, stream = 0): number {
  let h = 0x811c9dc5 ^ (slot === 'in' ? 0x9e37 : 0x7f4a) ^ Math.imul(index + 1, 0x2c1b3c6d) ^ Math.imul(stream + 1, 0x297a2d39)
  for (let i = 0; i < layerId.length; i++) h = Math.imul(h ^ layerId.charCodeAt(i), 0x01000193)
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  return (h >>> 0) / 4294967296
}

/** When unit `index` of `count` starts its animation, in layer time. */
export function unitStartMs(spec: LayerAnimation, slot: AnimationSlot, index: number, count: number, layer: Pick<Layer, 'id' | 'durationMs'>): number {
  const jitter = spec.jitterMs > 0 ? unitSeed(layer.id, slot, index) * spec.jitterMs : 0
  return slot === 'in'
    ? spec.delayMs + index * spec.staggerMs + jitter
    : layer.durationMs - spec.delayMs - animationSpanMs(spec, count) + index * spec.staggerMs - jitter
}

/** How far a unit that starts at `startMs` is through its animation at layer time `t`, 0 to 1. */
function progressAt(spec: LayerAnimation, startMs: number, t: number): number {
  if (spec.durationMs <= 0) return t >= startMs ? 1 : 0
  return clamp01((t - startMs) / spec.durationMs)
}

/** The pose of one unit of a slot at linear progress `u`. */
function slotPose(preset: AnimationPreset, spec: LayerAnimation, slot: AnimationSlot, u: number): Pose {
  const p = ease(spec.easing, u)
  if (slot === 'in') return preset.pose(p, spec.params)
  // An exit without its own pose plays the entrance backwards.
  return preset.poseOut ? preset.poseOut(p, spec.params) : preset.pose(ease(spec.easing, 1 - u), spec.params)
}

/** Random offset and turn per unit, largest at the far end of the animation. */
function scatter(pose: Pose, spec: LayerAnimation, slot: AnimationSlot, u: number, layerId: string, index: number): Pose {
  if (spec.scatterPx <= 0 && spec.scatterDeg <= 0) return pose
  const amount = slot === 'in' ? 1 - ease(spec.easing, u) : ease(spec.easing, u)
  const signed = (stream: number) => unitSeed(layerId, slot, index, stream) * 2 - 1
  return {
    ...pose,
    dx: pose.dx + signed(1) * spec.scatterPx * amount,
    dy: pose.dy + signed(2) * spec.scatterPx * amount,
    rotation: pose.rotation + signed(3) * spec.scatterDeg * amount,
  }
}

/** Two poses at once (an entrance still running while the exit starts). */
export function combinePoses(a: Pose, b: Pose): Pose {
  return { opacity: a.opacity * b.opacity, dx: a.dx + b.dx, dy: a.dy + b.dy, scale: a.scale * b.scale, rotation: a.rotation + b.rotation, blur: a.blur + b.blur }
}

/** What an animation moves: the whole layer, or a text layer's units. */
export type AnimationTarget = 'layer' | 'text'

/** The layer field that holds a slot: animIn and animOut for the whole layer, textIn and textOut for text units. */
export function slotField(target: AnimationTarget, slot: AnimationSlot): 'animIn' | 'animOut' | 'textIn' | 'textOut' {
  return target === 'layer' ? (slot === 'in' ? 'animIn' : 'animOut') : slot === 'in' ? 'textIn' : 'textOut'
}

/** The animation in a slot, or null. */
export function slotAnimation(layer: Layer, target: AnimationTarget, slot: AnimationSlot): LayerAnimation | null {
  if (target === 'text') return layer.kind === 'text' ? (slot === 'in' ? layer.textIn : layer.textOut) : null
  return slot === 'in' ? layer.animIn : layer.animOut
}

const slots = (layer: Layer, target: AnimationTarget) =>
  (['in', 'out'] as const).flatMap((slot) => {
    const spec = slotAnimation(layer, target, slot)
    const preset = spec ? findAnimationPreset(spec.preset) : undefined
    return spec && preset ? [{ slot: slot as AnimationSlot, spec, preset }] : []
  })

/** The pose of a whole-layer animation at layer time `t`, or null when the layer has none (or only a draw-on). */
export function layerPose(layer: Layer, t: number): Pose | null {
  let pose: Pose | null = null
  for (const { slot, spec, preset } of slots(layer, 'layer')) {
    if (preset.drawOn) continue
    const start = slot === 'in' ? 0 : Math.max(0, layer.durationMs - spec.durationMs)
    pose = combinePoses(pose ?? REST_POSE, slotPose(preset, spec, slot, progressAt(spec, start, t)))
  }
  return pose
}

/** Each grapheme's pose, and the unit it turns and scales with (its pivot is that unit's centre). */
export interface GlyphPoses {
  poses: Pose[]
  units: number[]
}

/** Each grapheme's pose from the layer's per-unit animations at layer time `t`, or null when it has none. */
export function glyphPoses(layer: Layer, text: string, t: number): GlyphPoses | null {
  const active = slots(layer, 'text').filter(({ preset }) => !preset.drawOn)
  if (active.length === 0) return null
  const units = textUnits(text)
  const first = (active[0] as (typeof active)[number]).spec.unit
  const poses: Pose[] = units.graphemes.map(() => REST_POSE)
  for (const { slot, spec, preset } of active) {
    const count = unitCount(units, spec.unit)
    const byUnit = new Map<number, Pose>()
    units.graphemes.forEach((_, g) => {
      const index = unitIndex(units, g, spec.unit)
      let pose = byUnit.get(index)
      if (!pose) {
        const u = progressAt(spec, unitStartMs(spec, slot, index, count, layer), t)
        pose = scatter(slotPose(preset, spec, slot, u), spec, slot, u, layer.id, index)
        byUnit.set(index, pose)
      }
      poses[g] = combinePoses(poses[g] as Pose, pose)
    })
  }
  return { poses, units: units.graphemes.map((_, g) => unitIndex(units, g, first)) }
}

/** How a draw-on stands at layer time `t`: drawn fraction (0 to 1) and the preset's knobs; null when none is running. */
export interface DrawOn {
  progress: number
  order: 'together' | 'one-by-one' | 'staggered'
  stagger: number
  topFirst: boolean
  origin: number
  direction: 'forward' | 'backward' | 'both'
  fill: 'keep' | 'along' | 'late'
  pen: number
}

export function drawOnAt(layer: Layer, t: number): DrawOn | null {
  for (const { slot, spec, preset } of slots(layer, 'layer')) {
    if (!preset.drawOn) continue
    const length = Math.max(1, spec.durationMs)
    const u = clamp01((t - (slot === 'in' ? 0 : Math.max(0, layer.durationMs - length))) / length)
    // Finished entrances and exits not yet begun draw the layer as it is.
    if ((slot === 'in' && u >= 1) || (slot === 'out' && u <= 0)) continue
    const k = spec.params
    const pick = <T>(key: string, choices: readonly T[], fallback: number) => choices[Math.round(k[key] ?? fallback)] ?? (choices[fallback] as T)
    return {
      progress: ease(spec.easing, slot === 'in' ? u : 1 - u),
      order: pick('order', ['together', 'one-by-one', 'staggered'] as const, 1),
      stagger: clamp01(k.stagger ?? 0.5),
      topFirst: (k.topFirst ?? 0) >= 0.5,
      origin: k.origin ?? 0,
      direction: pick('direction', ['forward', 'backward', 'both'] as const, 0),
      fill: pick('fill', ['keep', 'along', 'late'] as const, 2),
      pen: Math.max(0, k.pen ?? 2),
    }
  }
  return null
}

/** How far piece `i` of `count` of a draw-on has drawn. */
export function drawPieceProgress(draw: DrawOn, i: number, count: number): number {
  const index = draw.topFirst ? count - 1 - i : i
  if (draw.order === 'together' || count <= 1) return draw.progress
  if (draw.order === 'one-by-one') return clamp01(draw.progress * count - index)
  // Staggered: each piece waits `stagger` of a piece's length for the one before.
  const length = 1 / (1 + (count - 1) * draw.stagger)
  return clamp01((draw.progress - index * draw.stagger * length) / length)
}

/** The stroke trim that shows a drawn fraction `p` of an outline. */
export function drawTrim(draw: DrawOn, p: number): { start: number; end: number; offset: number } {
  if (draw.direction === 'backward') return { start: 0, end: p, offset: draw.origin - p }
  if (draw.direction === 'both') return { start: 0, end: p, offset: draw.origin - p / 2 }
  return { start: 0, end: p, offset: draw.origin }
}

/** How opaque the fill is while it draws on. */
export function drawFillOpacity(draw: DrawOn): number {
  return draw.fill === 'keep' ? 1 : draw.fill === 'along' ? draw.progress : clamp01((draw.progress - 0.7) / 0.3)
}

/** Where an animation runs in layer time: from its first unit starting to its last finishing. */
export function animationWindow(layer: Layer, target: AnimationTarget, slot: AnimationSlot): { startMs: number; endMs: number } | null {
  const spec = slotAnimation(layer, target, slot)
  if (!spec) return null
  if (target === 'layer') {
    const start = slot === 'in' ? 0 : Math.max(0, layer.durationMs - spec.durationMs)
    return { startMs: start, endMs: Math.min(layer.durationMs, start + spec.durationMs) }
  }
  const text = layer.kind === 'text' ? layer.text : ''
  const count = unitCount(textUnits(text), spec.unit)
  const starts = Array.from({ length: count }, (_, i) => unitStartMs(spec, slot, i, count, layer))
  if (starts.length === 0) return { startMs: 0, endMs: 0 }
  return { startMs: Math.max(0, Math.min(...starts)), endMs: Math.min(layer.durationMs, Math.max(...starts) + spec.durationMs) }
}
