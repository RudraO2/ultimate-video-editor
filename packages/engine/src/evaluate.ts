import {
  type Bone,
  type CaptionLook,
  captionLook,
  overlayRanges,
  scaleGlyphs,
  type DrawOn,
  drawOnAt,
  type Effect,
  type Force,
  type LayerMotionBlur,
  evaluateProperty,
  type GlyphPoses,
  glyphPoses,
  layerPose,
  type Layer,
  type Paint,
  type PropertySpec,
  propertiesOf,
  type ShapeGeometry,
  type Stroke,
  type TextRange,
  type TextStyle,
  type Transform,
  writeProperty,
} from '@uve/core'
import { compose, degToRad, type Mat4, rotateX, rotateY, rotateZ, scale, translate } from './math'

/** A layer with every animated property sampled at one moment. */
export interface ResolvedLayer {
  layer: Layer
  transform: Transform
  style?: TextStyle
  /** A text layer's box (wrap width and fixed height, null when automatic). */
  textBox?: { maxWidth: number | null; maxHeight: number | null }
  shape?: ShapeGeometry
  fills?: Paint[]
  strokes?: Stroke[]
  /** A text layer's styled ranges at this moment. */
  ranges?: TextRange[]
  /** A path's outline at this moment (a morph in progress). */
  geometry?: string
  volume?: number
  /** Blur of the whole layer from its entrance or exit, in layer px. */
  blur?: number
  /** A text layer's per-unit entrance or exit at this moment. */
  glyphs?: GlyphPoses
  /** A draw-on in progress. */
  drawOn?: DrawOn
  /** A caption's gliding focus pill at this moment. */
  captionPill?: CaptionLook['pill']
  /** The layer's enabled effect cards with their keyed fields at this moment. */
  effects?: Effect[]
  /** Time since the layer's start, ms. */
  layerTimeMs: number
  /** The layer's motion blur switch and shutter at this moment (keyed fields sampled). */
  motionBlur: LayerMotionBlur
  /** The layer's enabled physics forces with their keyed fields at this moment. */
  forces?: Force[]
  /** A group's switch value (the index of the member shown) at this moment; null for a plain group. */
  switch?: number | null
  /** A rig group's bones with their keyed pose channels sampled at this moment. */
  bones?: Bone[]
}

/**
 * How far past the exact source time a media frame is looked up, in ms. Float
 * error, and container timestamps rounded to the millisecond, could otherwise
 * pick the frame before. The preview and exports both use it.
 */
export const FRAME_LOOKUP_EPSILON_MS = 1

/** The loudest volume a layer can have (4 is 400 %). */
export const MAX_VOLUME = 4

/** Whether a layer shows at a comp time: enabled and inside [start, end). */
export function isActiveAt(layer: Layer, timeMs: number): boolean {
  return layer.enabled && timeMs >= layer.startMs && timeMs < layer.startMs + layer.durationMs
}

/** The time in a video or audio layer's source file that plays at a comp time; 0 for other layers. */
export function sourceTimeMs(layer: Layer, timeMs: number): number {
  if (layer.kind !== 'video' && layer.kind !== 'audio') return 0
  return layer.sourceStartMs + (timeMs - layer.startMs) * layer.playbackRate
}

/** Keeps a sampled value inside its property's range: overshooting easings (back, elastic) can leave it. */
function clampToSpec(spec: PropertySpec, value: unknown) {
  if (typeof value !== 'number') return value
  return Math.min(spec.max ?? Number.POSITIVE_INFINITY, Math.max(spec.min ?? Number.NEGATIVE_INFINITY, value))
}

/** Samples every animated property of a layer at a comp time. Static values are copied as they are. */
export function resolveLayer(layer: Layer, timeMs: number): ResolvedLayer {
  const layerTime = timeMs - layer.startMs
  const keyed = propertiesOf(layer).filter((spec) => (layer.animations[spec.path]?.length ?? 0) > 0)
  // Animated values are written into a copy, so every kind of property (paints by id too) resolves the same way.
  const now: Layer = keyed.length > 0 ? structuredClone(layer) : layer
  for (const spec of keyed) {
    const value = evaluateProperty(layer, spec, layerTime)
    if (value !== undefined) writeProperty(now, spec, clampToSpec(spec, value) as typeof value)
  }
  const resolved: ResolvedLayer = { layer, transform: { ...now.transform }, layerTimeMs: layerTime, motionBlur: now.motionBlur }
  const effects = now.effects.filter((e) => e.enabled)
  if (effects.length > 0) resolved.effects = effects
  const forces = now.forces?.filter((f) => f.enabled)
  if (forces && forces.length > 0) resolved.forces = forces
  // Whole-layer entrances and exits move the layer from where its keys put it.
  const pose = layerPose(layer, layerTime)
  if (pose) {
    const t = resolved.transform
    t.x += pose.dx
    t.y += pose.dy
    t.scaleX *= pose.scale
    t.scaleY *= pose.scale
    t.rotation += pose.rotation
    t.opacity = Math.max(0, Math.min(1, t.opacity * pose.opacity))
    if (pose.blur > 0) resolved.blur = pose.blur
  }
  const draw = drawOnAt(layer, layerTime)
  if (draw) resolved.drawOn = draw
  if (now.kind === 'text') {
    resolved.style = now.style
    resolved.textBox = { maxWidth: now.maxWidth, maxHeight: now.maxHeight }
    resolved.ranges = now.ranges
    let glyphs = glyphPoses(layer, now.text, layerTime)
    if (now.caption) {
      // A caption's states: styled spans over the layer's ranges, scaled cues, and the gliding pill.
      const look = captionLook(now.caption, layerTime, now.style.color)
      resolved.ranges = overlayRanges(now.text, now.ranges, look.spans)
      glyphs = scaleGlyphs(now.text, glyphs, look.scales)
      if (look.pill) resolved.captionPill = look.pill
    }
    if (glyphs) resolved.glyphs = glyphs
  }
  if (now.kind === 'shape') resolved.shape = now.shape
  if (now.kind === 'text' || now.kind === 'shape') {
    resolved.fills = now.fills
    resolved.strokes = now.strokes
  }
  if (now.kind === 'path') resolved.geometry = now.geometry
  if (now.kind === 'mesh') resolved.fills = now.fills
  if ('fills' in now && 'strokes' in now && now.kind !== 'text' && now.kind !== 'shape') {
    resolved.fills = now.fills
    resolved.strokes = now.strokes
  }
  if (now.kind === 'video' || now.kind === 'audio') resolved.volume = now.volume
  if (now.kind === 'group') {
    resolved.switch = now.switch
    if (now.rig) resolved.bones = now.rig.bones
  }
  return resolved
}

/** Layers with depth or tilt need perspective; everything else is drawn flat. */
export function needsProjection(t: Transform): boolean {
  return t.z !== 0 || t.rotationX !== 0 || t.rotationY !== 0
}

/** Where the pivot sits in layer-local space (origin at the box centre): anchors are fractions of the box. */
export function pivotOffset(t: Transform, box: { width: number; height: number }): [x: number, y: number] {
  return [(t.anchorX - 0.5) * box.width, (t.anchorY - 0.5) * box.height]
}

/**
 * Maps layer-local points (origin at the box centre) to comp space: around
 * the pivot, scale, then tilt (X), turn (Y) and rotate (Z), then move to x, y, z.
 */
export function layerMatrix(t: Transform, box: { width: number; height: number }): Mat4 {
  const [px, py] = pivotOffset(t, box)
  return compose(
    translate(t.x, t.y, t.z),
    rotateZ(degToRad(t.rotation)),
    rotateY(degToRad(t.rotationY)),
    rotateX(degToRad(t.rotationX)),
    scale(t.scaleX, t.scaleY, 1),
    translate(-px, -py, 0),
  )
}
