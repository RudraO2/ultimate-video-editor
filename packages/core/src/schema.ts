import { z } from 'zod'
import { findAnimationPreset } from './animationPresets'
import { LayerEffectSchema, TextEffectSchema } from './effects'
import { PRIMITIVE_IDS } from './primitives'
import { CompMotionBlurSchema, LayerMotionBlurSchema } from './motionBlur'
import { DuckRuleSchema, SoundCategorySchema, SoundMixSchema, builtInCategories } from './soundMix'
import { SoundVoiceSchema } from './soundVoice'
import { findTransitionPreset } from './transitions'

// The document model. Every object is strict: unknown fields are rejected, so a
// typo in a patch is reported instead of silently dropped.
//
// Conventions: comp space has its origin at the comp centre with +y down; all
// times are milliseconds; keyframe times are relative to the layer's start.

export const IdSchema = z.string().min(1)

export const ColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, 'Use a hex colour such as #ff8800 or #ff880080')

export const EASING_PRESETS = [
  'linear',
  'hold',
  'ease-in',
  'ease-out',
  'ease-in-out',
  'ease-in-back',
  'ease-out-back',
  'ease-out-quart',
  'ease-out-expo',
  'ease-in-out-back',
  'ease-out-elastic',
] as const

export const EasingSchema = z.union([
  z.enum(EASING_PRESETS),
  z.strictObject({
    type: z.literal('bezier'),
    x1: z.number().min(0).max(1),
    y1: z.number(),
    x2: z.number().min(0).max(1),
    y2: z.number(),
  }),
])

export const KeyValueSchema = z.union([z.number(), z.array(z.number()), z.string(), z.boolean()])

/** A motion-path handle: px relative to its key, or null for none. */
export const HandleSchema = z.tuple([z.number(), z.number()]).nullable()

/**
 * The handles of a motion path, on a `transform.x` key that has a
 * `transform.y` key at the same time (AtomCut's shape). `out` leaves the key
 * toward the next one, `in` arrives from the previous one.
 */
export const SpatialSchema = z.strictObject({
  in: HandleSchema.default(null).describe('[dx, dy] px from the key toward the previous one, or null'),
  out: HandleSchema.default(null).describe('[dx, dy] px from the key toward the next one, or null'),
})

export const KeyframeSchema = z.strictObject({
  t: z.number().describe('Time in ms, relative to the layer start'),
  v: KeyValueSchema,
  ease: EasingSchema.default('ease-in-out').describe('Easing from this key to the next one'),
  spatial: SpatialSchema.optional().describe('Motion-path handles; transform.x keys only, with a transform.y key at the same time'),
})

export const TransformSchema = z.strictObject({
  x: z.number().default(0),
  y: z.number().default(0),
  z: z.number().default(0),
  rotation: z.number().default(0),
  rotationX: z.number().default(0),
  rotationY: z.number().default(0),
  scaleX: z.number().default(1),
  scaleY: z.number().default(1),
  scaleZ: z.number().default(1).describe('Depth scale in a 3D world (a picture plane reads its world scale as scaleX, scaleZ, scaleY)'),
  anchorX: z.number().default(0.5).describe("Pivot across the layer's box: 0 left edge, 0.5 centre, 1 right edge"),
  anchorY: z.number().default(0.5).describe("Pivot down the layer's box: 0 top edge, 0.5 centre, 1 bottom edge"),
  opacity: z.number().min(0).max(1).default(1),
})

/** How a member of an auto layout group is sized and placed (ignored outside one). */
export const LayoutItemSchema = z.strictObject({
  fillX: z.boolean().default(false).describe("Stretch across the layout's width (rows: share the free space)"),
  fillY: z.boolean().default(false).describe("Stretch across the layout's height (columns: share the free space)"),
  absolute: z.boolean().default(false).describe('Opt out of the layout and keep its own position (a badge on a corner)'),
  minWidth: z.number().min(0).nullable().default(null),
  maxWidth: z.number().positive().nullable().default(null),
  minHeight: z.number().min(0).nullable().default(null),
  maxHeight: z.number().positive().nullable().default(null),
})

export const ANIMATION_UNITS = ['letter', 'word', 'line'] as const

/**
 * An entrance or exit from the animation presets (animation.set). On a
 * layer's `animIn` and `animOut` it moves the whole layer as one piece, from
 * its start (in) or up to its end (out); the unit fields are unused there. On
 * a text layer's `textIn` and `textOut` it moves each letter, word or line,
 * each unit starting `staggerMs` after the one before.
 */
export const LayerAnimationSchema = z.strictObject({
  preset: z
    .string()
    .refine((id) => findAnimationPreset(id) !== undefined, { message: 'Not an animation preset id (catalog.list animations lists them)' })
    .describe('An animation preset id (catalog.list animations)'),
  unit: z.enum(ANIMATION_UNITS).default('word').describe('Text: what moves as one: a letter, a word, or a line (between line breaks)'),
  durationMs: z.number().min(0).describe("Each unit's own animation, ms"),
  staggerMs: z.number().min(0).default(0).describe('Text: the gap between one unit starting and the next'),
  delayMs: z.number().min(0).default(0).describe("Text: wait after the layer's start (in) or end before its end (out)"),
  easing: EasingSchema.default('ease-out'),
  jitterMs: z.number().min(0).default(0).describe('Text: random extra wait per unit, up to this (a human typing rhythm)'),
  scatterPx: z.number().min(0).default(0).describe('Text: random offset per unit at the far end of the animation, px'),
  scatterDeg: z.number().min(0).default(0).describe('Text: random turn per unit at the far end of the animation, degrees'),
  params: z.record(z.string(), z.number()).default({}).describe("The preset's knobs (catalog.get animations <id>)"),
})

/** Where an asset layer came from, kept for its credit: an icon's id, set licence and author. */
export const LayerOriginSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('icon'),
    id: z.string().min(1).describe('The icon, as set:name, e.g. lucide:arrow-right'),
    license: z.string().nullable().default(null).describe('An SPDX id such as MIT or CC-BY-4.0'),
    author: z.string().default(''),
  }),
])

export const MATERIAL_MODELS = ['pbr', 'toon', 'unlit'] as const

/**
 * How a picture plane (and, later, a mesh) takes light in a 3D world (AtomCut's
 * fields and defaults). Without a material a layer is an unlit picture. `color`
 * tints the picture (null is white); the rest follows physically based shading
 * (pbr), stepped toon shading or no lighting at all (unlit).
 */
export const MaterialSchema = z.strictObject({
  model: z.enum(MATERIAL_MODELS).default('pbr'),
  color: ColorSchema.nullable().default(null).describe('A tint multiplied into the picture; null leaves it as it is'),
  roughness: z.number().min(0).max(1).default(0.5),
  metalness: z.number().min(0).max(1).default(0),
  emission: ColorSchema.default('#000000').describe('The colour it glows with'),
  emissionStrength: z.number().min(0).max(100).default(1),
  transmission: z.number().min(0).max(1).default(0).describe('1 lets light through like glass'),
  ior: z.number().min(1).max(2.333).default(1.45).describe('Index of refraction'),
  thickness: z.number().min(0).default(0).describe('Transmission: how thick the volume is, px'),
  clearcoat: z.number().min(0).max(1).default(0),
  clearcoatRoughness: z.number().min(0).max(1).default(0.1),
  sheen: z.number().min(0).max(1).default(0),
  iridescence: z.number().min(0).max(1).default(0),
  toonSteps: z.number().int().min(2).max(16).default(3).describe('Toon: how many bands of light'),
  doubleSided: z.boolean().default(false),
  source: z.enum(['file', 'custom']).default('custom').describe('file keeps the materials of an imported model; custom uses these fields'),
  preset: z.string().nullable().default(null).describe('The preset these values started from (world.material)'),
})

/** Thickness of a picture in a 3D world. Zero depth draws the flat picture. */
export const ExtrudeSchema = z.strictObject({
  depth: z.number().min(0).default(40),
  bevel: z.number().min(0).default(0),
  bevelSegments: z.number().int().min(1).max(8).default(3),
  sideColor: ColorSchema.nullable().default(null),
  fit: z.enum(['outline', 'box']).default('outline'),
})

const constraintBase = {
  id: IdSchema,
  targetId: IdSchema.nullable().default(null).describe('The layer it reads; none makes the constraint do nothing'),
  enabled: z.boolean().default(true),
  influence: z.number().min(0).max(1).default(1).describe('0 leaves the layer where it is, 1 gives the whole effect'),
}

/**
 * A rule that places a layer from another one in a 3D world (world.track).
 * lookAt keeps aiming at the target; follow adds the target's position (and
 * its turns) to the layer's own; childOf makes the layer ride the target's
 * move, turn and scale, from the moment `inverse` was taken.
 */
export const ConstraintSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...constraintBase, type: z.literal('lookAt') }),
  z.strictObject({ ...constraintBase, type: z.literal('follow'), rotation: z.boolean().default(false).describe('Turn with the target too') }),
  z.strictObject({
    ...constraintBase,
    type: z.literal('childOf'),
    inverse: z.array(z.number()).length(16).nullable().default(null).describe("The target's matrix inverted when the layer was bound: it keeps the layer where it was then"),
  }),
])
export type Constraint = z.infer<typeof ConstraintSchema>

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()])

export const PHYSICS_BODY_TYPES = ['active', 'passive', 'animated'] as const
export const PHYSICS_SHAPES = ['auto', 'box', 'sphere', 'hull', 'outline'] as const
export const FORCE_TYPES = ['wind', 'vortex', 'point', 'turbulence', 'drag'] as const
export const FORCE_FALLOFFS = ['none', 'linear', 'smooth'] as const
export const JOINT_TYPES = ['pin', 'weld', 'rope', 'spring'] as const

/**
 * Physics of a comp (physics.scene). Units: 1 px = 1 cm, so gravity 981 px/s²
 * is Earth's; +y is down. The simulation reads these; the document only stores them.
 */
export const PhysicsSceneSchema = z.strictObject({
  gravity: z.number().default(981).describe('Gravity in px/s², pulling down (+y); 981 is Earth (1 px = 1 cm), 0 floats'),
  startMs: z.number().min(0).default(0).describe('Comp time where the simulation starts, ms: bodies sit as laid out until then'),
  floor: z.boolean().default(true).describe('A solid floor under the scene'),
  floorAt: z.number().nullable().default(null).describe("A flat comp's floor height, y in comp space (+ is down); null is the comp's bottom edge"),
  walls: z.boolean().default(false).describe('The left, right and top edges of the comp are solid'),
  timeScale: z.number().min(0.05).max(4).default(1).describe('Simulation speed: 1 is real time, 0.5 slow motion'),
})

/** How one layer takes part in the simulation (physics.body). */
export const PhysicsBodySchema = z.strictObject({
  type: z.enum(PHYSICS_BODY_TYPES).default('active').describe('active: falls and collides; passive: fixed, others hit it; animated: follows its own keys and pushes others'),
  shape: z.enum(PHYSICS_SHAPES).default('auto').describe('Its collision shape: auto picks from the layer, box and sphere fit its bounds, hull wraps its outline, outline follows it exactly (passive only)'),
  mass: z.number().positive().default(1).describe('Relative mass: heavier bodies push lighter ones'),
  bounce: z.number().min(0).max(1).default(0.3).describe('Restitution: 0 lands dead, 1 keeps all its speed'),
  friction: z.number().min(0).max(1).default(0.5).describe('Grip against what it touches: 0 slides, 1 grips'),
  velocity: Vec3Schema.default([0, 0, 0]).describe('Starting velocity [x, y, z] in px/s (+y is down)'),
  spin: Vec3Schema.default([0, 0, 0]).describe('Starting spin [x, y, z] in degrees/s; a flat comp reads z, + is clockwise'),
  damping: z.number().min(0).max(1).default(0.01).describe('Air resistance: the share of its speed lost per second'),
  follow: z.number().min(0).max(1).default(0).describe('How strongly an animated body drags along the ones it touches: 0 not at all, 1 fully'),
})

/** A force a layer applies to bodies near it (physics.force). Forces add up, so their order never changes the result. */
export const ForceSchema = z.strictObject({
  id: IdSchema,
  type: z.enum(FORCE_TYPES).default('wind').describe('wind: pushes along the layer\'s rotation; vortex: swirls around it; point: pulls toward it (negative pushes away); turbulence: random gusts; drag: slows what moves'),
  name: z.string().optional(),
  strength: z.number().default(600).describe('Acceleration in px/s²; for drag, the % of speed lost per second'),
  radius: z.number().min(0).default(0).describe('How far it reaches, px; 0 reaches everywhere'),
  falloff: z.enum(FORCE_FALLOFFS).default('smooth').describe('How it fades toward the edge of its radius'),
  scale: z.number().positive().default(240).describe('Turbulence: the size of its gusts, px'),
  seed: z.number().int().default(0).describe('Turbulence: another seed is another pattern'),
  enabled: z.boolean().default(true),
})

/** A link holding a body to another body or to the comp (physics.joint). */
export const JointSchema = z.strictObject({
  id: IdSchema,
  type: z.enum(JOINT_TYPES).default('pin').describe('pin: a hinge; weld: rigid; rope: keeps within its length; spring: pulls back to its length'),
  target: IdSchema.nullable().default(null).describe("Another body's layer id; null pins to the comp"),
  anchor: Vec3Schema.default([0, 0, 0]).describe("The joint's point on this body, px from its pivot, in its own axes"),
  targetAnchor: Vec3Schema.nullable().default(null).describe("The point on the target in its own px (a point of the comp when target is null); null is where the anchor is at the start"),
  stiffness: z.number().min(0).default(40).describe('Spring: how hard it pulls back'),
  damping: z.number().min(0).default(2).describe('Spring: how fast it stops swinging'),
  length: z.number().min(0).nullable().default(null).describe('Rope and spring: its length, px; null is the distance at the start'),
  enabled: z.boolean().default(true),
})

const Vec2Schema = z.tuple([z.number(), z.number()])
const RangeSchema = z.tuple([z.number(), z.number()])

export const BIND_MODES = ['auto', 'rigid', 'none'] as const
export const BONE_CHANNELS = ['rotation', 'x', 'y', 'scale'] as const
export const BEHAVIOR_TYPES = ['blink', 'breathe', 'sway', 'nod', 'glance', 'talk'] as const

/** What a bone may do: each channel's allowed range of the pose (deltas from rest; scale is the stretch). */
export const BoneLimitsSchema = z.strictObject({
  rotation: RangeSchema.optional().describe('Degrees clockwise, [min, max]'),
  x: RangeSchema.optional().describe('px, [min, max]'),
  y: RangeSchema.optional().describe('px, [min, max]'),
  scale: RangeSchema.optional().describe('Stretch along the bone, [min, max]; 1 is rest'),
})

/** Makes a bone chase a target bone (two-bone or one-bone inverse kinematics). */
export const BoneIkSchema = z.strictObject({
  target: IdSchema.describe('The bone whose head the chain reaches for'),
  chain: z.union([z.literal(1), z.literal(2)]).default(2).describe('How many bones turn: this one and its parent (2), or this one alone (1)'),
  flip: z.boolean().default(false).describe('Bend the other way'),
  mix: z.number().min(0).max(1).default(1).describe('How much IK takes over from the plain pose: 0 none, 1 all'),
})

/** A bone's pose: deltas from rest. Keyable on the rig group at bone.<id>.rotation|x|y|scale. */
export const BonePoseSchema = z.strictObject({
  rotation: z.number().default(0).describe('Degrees clockwise'),
  x: z.number().default(0).describe('px'),
  y: z.number().default(0).describe('px'),
  scale: z.number().default(1).describe('Stretch along the bone; 1 is rest'),
})

/** One bone of a rig. head and tail are comp px in the group's own space, before its transform. */
export const BoneSchema = z.strictObject({
  id: IdSchema,
  name: z.string().min(1),
  head: Vec2Schema.describe('Where the bone starts (its joint), comp px'),
  tail: Vec2Schema.describe('Where the bone ends, comp px'),
  parent: IdSchema.nullable().default(null).describe('The bone it hangs from; null is a root'),
  deform: z.boolean().default(true).describe('false makes it a control: it moves other bones but no piece rides it'),
  limits: BoneLimitsSchema.optional(),
  ik: BoneIkSchema.nullable().optional(),
  pose: BonePoseSchema.prefault({}).describe('Its resting pose (deltas from rest); keys at bone.<id>.<channel> replace it over time'),
})

/** A skeleton of bones on a group: its members ride the bones. */
export const RigSchema = z.strictObject({ bones: z.array(BoneSchema).default([]) })

/** Which bone a direct member of a rig rides. */
export const BindSchema = z.strictObject({
  mode: z.enum(BIND_MODES).default('auto').describe('auto: the deform bone running furthest through the piece; rigid: the bone named; none: stays put'),
  bone: IdSchema.optional().describe('The bone, for rigid'),
})

const behaviorBase = {
  id: IdSchema,
  enabled: z.boolean().default(true),
  seed: z.number().int().default(1).describe('Another seed is another pattern of timing'),
}
const pivotField = Vec2Schema.optional().describe("The point a layer target turns about, comp px; default the engine's choice (the bottom centre of the layer)")

/** A life behaviour of a group: computed live every frame, no keys written (behaviors.add). */
export const BehaviorSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...behaviorBase,
    type: z.literal('blink'),
    eyes: z.array(IdSchema).describe('Eye layers: a switch group shows its member named closed or shut (else its last member); anything else squashes vertically'),
    every: z.number().min(0.5).max(30).default(4).describe('Seconds between blinks, on average'),
    closedMs: z.number().min(40).max(800).default(120).describe('How long the eyes stay shut, ms'),
    variance: z.number().min(0).max(100).default(40).describe('How much the gap between blinks varies, % of every'),
    doubles: z.number().min(0).max(100).default(17).describe('Chance of a quick second blink, %'),
    closedScale: z.number().min(0).max(1).default(0.1).describe('Vertical scale of a squashed eye when shut'),
  }),
  z.strictObject({
    ...behaviorBase,
    type: z.literal('breathe'),
    layer: IdSchema.optional().describe('The layer that breathes (give this or bone)'),
    bone: IdSchema.optional().describe('The bone that breathes (give this or layer)'),
    amount: z.number().min(0).max(20).default(1.2).describe('How much it swells, percent of its height (or of the bone)'),
    rate: z.number().min(2).max(60).default(16).describe('Breaths per minute'),
    phase: z.number().min(0).max(100).default(0).describe('Where in the breath it starts, %'),
    keepBottom: z.boolean().default(true).describe('Swell upward from the bottom of the layer, so its base stays put'),
  }),
  z.strictObject({
    ...behaviorBase,
    type: z.literal('sway'),
    layer: IdSchema.optional().describe('The layer that sways (give this or bone)'),
    bone: IdSchema.optional().describe('The bone that sways (give this or layer)'),
    amount: z.number().min(0).max(30).default(2).describe('How far it leans each way, degrees'),
    speed: z.number().min(0.01).max(5).default(0.25).describe('Sways per second (Hz)'),
    pivot: pivotField,
  }),
  z.strictObject({
    ...behaviorBase,
    type: z.literal('nod'),
    layer: IdSchema.optional().describe('The layer that nods (give this or bone)'),
    bone: IdSchema.optional().describe('The bone that nods (give this or layer)'),
    amount: z.number().min(-90).max(90).default(1.5).describe('Turn at full loudness, degrees'),
    voice: IdSchema.nullable().default(null).describe('The audio or video layer it follows; null is any one playing with a loudness envelope'),
    pivot: pivotField,
  }),
  z.strictObject({
    ...behaviorBase,
    type: z.literal('glance'),
    layers: z.array(IdSchema).describe('Pupils or eyes that look about'),
    rangeX: z.number().min(0).default(24).describe('How far they move sideways, px'),
    rangeY: z.number().min(0).default(10).describe('How far they move up and down, px'),
    hold: z.number().min(0).default(1.6).describe('Seconds each look is held, on average'),
    moveMs: z.number().min(0).default(90).describe('How long a glance takes, ms'),
    centre: z.number().min(0).max(100).default(40).describe('Chance of looking back to the centre, %'),
  }),
  z.strictObject({
    ...behaviorBase,
    type: z.literal('talk'),
    mouth: IdSchema.describe('A switch group of mouth shapes'),
    voice: IdSchema.nullable().default(null).describe('The audio or video layer it follows; null is any one playing with a loudness envelope'),
    lead: z.number().min(-200).max(200).default(60).describe('How early the mouth moves before the sound, ms'),
    map: z.record(z.string(), z.string()).optional().describe("Mouth shape to member name, e.g. {open: 'AH'}; overrides the default names"),
  }),
])
export type Behavior = z.infer<typeof BehaviorSchema>
export type Bone = z.infer<typeof BoneSchema>
export type Rig = z.infer<typeof RigSchema>
export type Bind = z.infer<typeof BindSchema>

const layerBase = {
  id: IdSchema,
  name: z.string().min(1),
  startMs: z.number().min(0).describe('Comp time where the layer starts, ms'),
  durationMs: z.number().positive(),
  enabled: z.boolean().default(true),
  locked: z.boolean().default(false),
  transform: TransformSchema.prefault({}),
  animations: z
    .record(z.string(), z.array(KeyframeSchema))
    .default({})
    .describe('Keyframe tracks keyed by property path, e.g. "transform.x"'),
  layoutItem: LayoutItemSchema.prefault({}),
  isStencil: z.boolean().default(false).describe("In a group whose mode cuts or masks, this layer is the cutter (it is not drawn itself)"),
  animIn: LayerAnimationSchema.nullable().default(null).describe('Entrance of the whole layer (animation.set slot "in", target "layer")'),
  animOut: LayerAnimationSchema.nullable().default(null).describe('Exit of the whole layer (animation.set slot "out", target "layer")'),
  effects: z
    .array(LayerEffectSchema)
    .default([])
    .describe("Layer effects on the layer's drawn pixels, first applied first (effects.add; fields keyable at lfx.<id>.<field>)"),
  motionBlur: LayerMotionBlurSchema.prefault({}).describe("Motion blur when the layer moves; its shutter keys at mblur.<field>"),
  sounds: z.array(SoundVoiceSchema).default([]).describe('Sounds fired by its own motion: text units, its entrance or exit, its transitions (layer.patch)'),
  soundBus: z
    .string()
    .min(1)
    .optional()
    .describe('The sound category its sound goes to (sound.category list); a nested layer passes it to the layers inside that have none. Absent: media goes straight to master, fired sounds to sfx'),
  ducking: z.array(DuckRuleSchema).optional().describe("This layer's own duck rules, on top of its category's"),
  origin: LayerOriginSchema.nullable().default(null).describe('Where the layer came from, for credit (icons)'),
  material: MaterialSchema.optional().describe('3D worlds only (world.material): the layer takes light; without it a plane is an unlit picture'),
  extrude: ExtrudeSchema.optional().describe('3D worlds only (world.extrude): thickness of a picture'),
  constraints: z.array(ConstraintSchema).optional().describe('3D worlds only (world.track): rules that aim, follow or parent the layer to another one'),
  physics: PhysicsBodySchema.optional().describe('Present when the layer is a physics body (physics.body)'),
  forces: z.array(ForceSchema).optional().describe('Forces the layer applies to bodies (physics.force); number fields keyable at force.<id>.<field>'),
  joints: z.array(JointSchema).optional().describe('Joints holding this body to another body or the comp (physics.joint)'),
  bind: BindSchema.optional().describe('A direct member of a rig: which bone it rides (rig.bind)'),
}

/** A pill behind text: the whole layer's, or a styled range's. */
export const HighlightSchema = z.strictObject({
  color: ColorSchema,
  radius: z.number().min(0).default(8),
  paddingX: z.number().min(0).default(10),
  paddingY: z.number().min(0).default(4),
})

export const TEXT_DECORATIONS = ['none', 'underline', 'strikethrough'] as const
export const TEXT_CASES = ['none', 'upper', 'lower', 'title'] as const

export const TextStyleSchema = z.strictObject({
  fontFamily: z.string().min(1).default('Inter'),
  fontSize: z.number().positive().default(96),
  fontWeight: z.number().int().min(100).max(900).default(700),
  fauxBold: z
    .number()
    .min(0)
    .max(0.25)
    .default(0)
    .describe('Extra thickness on top of the weight, a fraction of the size per edge: 0.03 reads as bold. For a family with no heavier face'),
  italic: z.boolean().default(false),
  decoration: z.enum(TEXT_DECORATIONS).default('none').describe('A line under the text (underline) or through it (strikethrough)'),
  textCase: z.enum(TEXT_CASES).default('none').describe('Display only, the text stays as typed: upper, lower, or title (the first letter of each word)'),
  color: ColorSchema.default('#ffffff').describe('Ink colour, used while the layer has no fills'),
  align: z.enum(['left', 'center', 'right', 'justify']).default('center').describe('How lines sit in the box; justify stretches every line but the last of a paragraph'),
  lineHeight: z.number().positive().default(1.15),
  letterSpacing: z.number().default(0),
  highlight: HighlightSchema.nullable().default(null).describe('A pill behind each line of text'),
  textEffects: z
    .array(TextEffectSchema)
    .default([])
    .describe('Effects drawn under each glyph and moving with it, first drawn first (effects.add domain "text"; keyable at tfx.<id>.<field>)'),
})

/** What a styled range may change; anything left out comes from the layer's style. */
export const TextRangeStyleSchema = z.strictObject({
  fontFamily: z.string().min(1).optional(),
  fontSize: z.number().positive().optional(),
  fontWeight: z.number().int().min(100).max(900).optional(),
  fauxBold: z.number().min(0).max(0.25).optional(),
  italic: z.boolean().optional(),
  decoration: z.enum(TEXT_DECORATIONS).optional(),
  textCase: z.enum(TEXT_CASES).optional(),
  color: ColorSchema.optional().describe('Replaces the layer\'s fills for these characters'),
  letterSpacing: z.number().optional(),
  opacity: z.number().min(0).max(1).optional(),
  highlight: HighlightSchema.nullable().optional().describe('A pill behind these characters (null: none, even if the layer has one)'),
})

/** Part of a text with its own style: characters (graphemes) [start, end). */
export const TextRangeSchema = z.strictObject({
  id: IdSchema,
  start: z.number().int().min(0),
  end: z.number().int().min(0),
  style: TextRangeStyleSchema,
})

/** A caption cue: characters (graphemes) [start, end) of the text, spoken from startMs to endMs (layer time). */
export const CaptionCueSchema = z.strictObject({
  id: IdSchema,
  start: z.number().int().min(0),
  end: z.number().int().min(0),
  startMs: z.number().min(0),
  endMs: z.number().min(0),
})

/** How the words of one state look: changes from the layer's style, and a scale. */
export const CaptionStateSchema = z.preprocess(
  (raw) => {
    // AtomCut's shape: {overlay: {props: {color, opacity, "highlight.color", …}}, animation, scale}.
    if (!raw || typeof raw !== 'object' || !('overlay' in raw)) return raw
    const { overlay, animation: _animation, ...rest } = raw as Record<string, unknown>
    const props = ((overlay as { props?: Record<string, unknown> } | undefined)?.props ?? {}) as Record<string, unknown>
    const style: Record<string, unknown> = {}
    const highlight: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(props)) {
      if (key.startsWith('highlight.')) highlight[key.slice(10)] = value
      else style[key] = value
    }
    if (Object.keys(highlight).length > 0) style.highlight = highlight
    return { ...rest, style }
  },
  z.strictObject({
    style: z
      .strictObject({
        color: ColorSchema.optional(),
        opacity: z.number().min(0).max(1).optional(),
        fontWeight: z.number().int().min(100).max(900).optional(),
        highlight: HighlightSchema.nullable().optional().describe('A pill behind the words in this state'),
      })
      .prefault({}),
    scale: z.number().positive().default(1),
  }),
)

export const CaptionSchema = z.strictObject({
  cues: z.array(CaptionCueSchema).default([]).describe('Spans of the text with the times they are spoken, in order'),
  states: z
    .strictObject({
      unread: CaptionStateSchema.prefault({ style: { opacity: 0.45 } }).describe('Words not spoken yet'),
      focus: CaptionStateSchema.prefault({
        style: { color: '#0F0E0C', opacity: 1, highlight: { color: '#F5B843', radius: 10, paddingX: 10, paddingY: 4 } },
        scale: 1.08,
      }).describe('The words being spoken'),
      read: CaptionStateSchema.prefault({ style: { opacity: 1 } }).describe('Words already spoken'),
    })
    .prefault({}),
  motion: z
    .strictObject({
      durationMs: z.number().min(0).max(4000).default(160).describe('How long a cue takes to change state'),
      easing: EasingSchema.default('ease-out'),
      travel: z.boolean().default(false).describe('The focus pill glides from word to word instead of each word getting its own'),
    })
    .prefault({}),
})

export const ShapeGeometrySchema = z.strictObject({
  type: z.enum(['rect', 'ellipse', 'polygon', 'star']).default('rect'),
  width: z.number().positive().default(400),
  height: z.number().positive().default(400),
  cornerRadius: z.number().min(0).default(0).describe('Rectangles only'),
  pointCount: z.number().int().min(3).max(100).default(5).describe('Sides of a polygon, points of a star'),
  innerRatio: z.number().min(0.01).max(1).default(0.5).describe("A star's inner radius as a fraction of its outer radius"),
})

// Paints, Figma-style: a layer's `fills` and `strokes` are drawn in order,
// first to last (bottom to top), fills before strokes.

export const BLEND_MODES = [
  'normal',
  'darken',
  'multiply',
  'color-burn',
  'lighten',
  'screen',
  'color-dodge',
  'overlay',
  'soft-light',
  'hard-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
] as const

export const BlendModeSchema = z.enum(BLEND_MODES)

/** A point in a layer's own box: 0,0 the top-left corner, 1,1 the bottom-right. */
export const BoxPointSchema = z.strictObject({ x: z.number(), y: z.number() })

export const GradientStopSchema = z.strictObject({
  id: IdSchema,
  offset: z.number().min(0).max(1).describe('Where along the gradient, 0 to 1'),
  color: ColorSchema,
})

const paintBase = {
  id: IdSchema,
  enabled: z.boolean().default(true),
  opacity: z.number().min(0).max(1).default(1),
  blendMode: BlendModeSchema.default('normal').describe('How the paint mixes with what is under it'),
}

const gradient = (start: { x: number; y: number }) => ({
  stops: z.array(GradientStopSchema).min(2),
  start: BoxPointSchema.default(start).describe('Linear: where offset 0 lies; radial and angular: the centre'),
  end: BoxPointSchema.default({ x: 1, y: 0.5 }).describe(
    'Linear: where offset 1 lies; radial: a point on the outer circle; angular: the direction of offset 0',
  ),
})

export const PaintSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...paintBase, type: z.literal('solid'), color: ColorSchema }),
  z.strictObject({ ...paintBase, type: z.literal('linear'), ...gradient({ x: 0, y: 0.5 }) }),
  z.strictObject({ ...paintBase, type: z.literal('radial'), ...gradient({ x: 0.5, y: 0.5 }) }),
  z.strictObject({ ...paintBase, type: z.literal('angular'), ...gradient({ x: 0.5, y: 0.5 }) }),
])

export const PAINT_TYPES = ['solid', 'linear', 'radial', 'angular'] as const

export const StrokeTrimSchema = z.strictObject({
  start: z.number().min(0).max(1).default(0),
  end: z.number().min(0).max(1).default(1),
  offset: z.number().default(0).describe('Shifts the drawn slice along the outline, in laps'),
})

export const StrokeSchema = z.strictObject({
  ...paintBase,
  paint: PaintSchema,
  width: z.number().min(0),
  align: z.enum(['center', 'inside', 'outside']).default('center'),
  cap: z.enum(['butt', 'round', 'square']).default('butt'),
  join: z.enum(['miter', 'round', 'bevel']).default('miter'),
  dash: z.array(z.number().min(0)).default([]).describe('Dash and gap lengths in px; empty for a solid line'),
  dashOffset: z.number().default(0),
  trim: StrokeTrimSchema.prefault({}).describe('Draws only a slice of the outline; key end 0 → 1 to draw it on'),
})

const paints = {
  fills: z.array(PaintSchema).default([]).describe('Fills, bottom to top'),
  strokes: z.array(StrokeSchema).default([]).describe('Strokes, bottom to top, drawn over the fills'),
}

export const PaddingSchema = z.strictObject({
  top: z.number().min(0).default(0),
  right: z.number().min(0).default(0),
  bottom: z.number().min(0).default(0),
  left: z.number().min(0).default(0),
})

/** An auto layout: a group that arranges its members like a CSS flexbox or grid. */
export const LayoutSchema = z.strictObject({
  flow: z.enum(['row', 'column', 'wrap', 'grid']).default('column').describe('row and column: one line; wrap: rows that break at the width; grid: columns'),
  columns: z.number().int().min(1).default(2).describe('Grid columns'),
  gap: z.number().min(0).default(16).describe('Space between members along the flow, px'),
  lineGap: z.number().min(0).default(16).describe('Space between rows of wrap and grid, px'),
  spaceBetween: z.boolean().default(false).describe('Spread members to the ends of a fixed size instead of packing them'),
  padding: PaddingSchema.prefault({}),
  alignX: z.enum(['start', 'center', 'end']).default('start'),
  alignY: z.enum(['start', 'center', 'end']).default('start'),
  width: z.number().positive().nullable().default(null).describe('Fixed width in px; null hugs the members'),
  height: z.number().positive().nullable().default(null).describe('Fixed height in px; null hugs the members'),
  minWidth: z.number().min(0).nullable().default(null),
  maxWidth: z.number().positive().nullable().default(null),
  minHeight: z.number().min(0).nullable().default(null),
  maxHeight: z.number().positive().nullable().default(null),
  x: z.number().default(0).describe("The box's left edge, comp space"),
  y: z.number().default(0).describe("The box's top edge, comp space"),
  clipContent: z.boolean().default(false).describe('Hide what spills out of the box'),
})

const mediaPlayback = {
  mediaId: IdSchema,
  sourceStartMs: z.number().min(0).default(0).describe('Where in the source media this layer starts, ms'),
  playbackRate: z.number().positive().default(1),
  volume: z.number().min(0).max(4).default(1),
  muted: z.boolean().default(false),
}

export const TextLayerSchema = z.strictObject({
  ...layerBase,
  kind: z.literal('text'),
  text: z.string(),
  // The box: auto width (both null) grows on one line per paragraph, auto
  // height (maxWidth only) wraps at a fixed width, and a fixed box has both.
  maxWidth: z.number().positive().nullable().default(null).describe('Box width in px; lines wrap at it. null: one line per paragraph'),
  maxHeight: z.number().positive().nullable().default(null).describe('Box height in px (a fixed box, with maxWidth). null: as tall as the lines'),
  verticalAlign: z.enum(['top', 'middle', 'bottom']).default('top').describe('Where the lines sit in a fixed box'),
  clipContent: z.boolean().default(false).describe('Hide what spills out of the box'),
  style: TextStyleSchema.prefault({}),
  ranges: z.array(TextRangeSchema).default([]).describe('Styled parts of the text, in order and not overlapping (text.style makes them)'),
  textIn: LayerAnimationSchema.nullable().default(null).describe('Per-unit entrance preset (animation.set slot "in", target "text")'),
  textOut: LayerAnimationSchema.nullable().default(null).describe('Per-unit exit preset (animation.set slot "out", target "text")'),
  caption: CaptionSchema.nullable().default(null).describe('Word-synced caption: cues, and how unread, focus and read words look (caption.set)'),
  ...paints,
})

export const ShapeLayerSchema = z.strictObject({
  ...layerBase,
  kind: z.literal('shape'),
  shape: ShapeGeometrySchema.prefault({}),
  ...paints,
})

export const GROUP_MODES = ['pass', 'union', 'mask', 'subtract', 'intersect', 'exclude'] as const

/**
 * A path: any vector outline, from SVG path data. The layer's box is the box
 * around its resting outline, and the outline is drawn centred in it, so
 * coordinates can be written in any space; morphing keys keep that box.
 */
export const PathLayerSchema = z.strictObject({
  ...layerBase,
  kind: z.literal('path'),
  geometry: z.string().min(1).describe('SVG path data, stored normalised (absolute M, L, C, Q and Z)'),
  fillRule: z.enum(['nonzero', 'evenodd']).default('nonzero').describe('evenodd makes overlapping pieces holes'),
  ...paints,
})

/**
 * A group: its members are the layers on the lanes that name it as their
 * `groupId`, which follow its own lane. Its transform moves, turns and scales
 * them as one (a change from where they are; at rest it does nothing), its
 * opacity fades them as one, and its time span is a window on them. With a
 * `layout` it arranges them, and its fills and strokes draw the container.
 */
export const GroupLayerSchema = z.strictObject({
  ...layerBase,
  kind: z.literal('group'),
  mode: z
    .enum(GROUP_MODES)
    .default('pass')
    .describe(
      'How the members combine: pass draws each as it is; union draws them as one picture; mask shows the rest only inside the stencils; subtract cuts the stencils out; intersect keeps only where both are; exclude keeps where only one is. Stencils are members with isStencil (the front-most member when none is marked).',
    ),
  layout: LayoutSchema.nullable().default(null),
  cornerRadius: z.number().min(0).default(0).describe("The container's corner radius (with a layout)"),
  switch: z
    .number()
    .int()
    .min(0)
    .nullable()
    .default(null)
    .describe('A switch: the index of the one member shown, counted from the top (front); null is a plain group. Keyable at "switch" (keys hold)'),
  rig: RigSchema.nullable().default(null).describe('A skeleton: bones that the direct members ride (rig.create); bone pose keys at bone.<id>.<channel>'),
  behaviors: z.array(BehaviorSchema).default([]).describe('Life behaviours computed live every frame: blink, breathe, sway, nod, glance, talk (behaviors.add)'),
  ...paints,
})

export const ImageLayerSchema = z.strictObject({ ...layerBase, kind: z.literal('image'), mediaId: IdSchema })

export const VideoLayerSchema = z.strictObject({ ...layerBase, kind: z.literal('video'), ...mediaPlayback })

export const AudioLayerSchema = z.strictObject({ ...layerBase, kind: z.literal('audio'), ...mediaPlayback })

/** How a nested comp's time runs inside its layer. */
export const NestedPlaybackSchema = z.strictObject({
  speed: z.number().positive().default(1).describe('How fast the inside plays: 2 is double speed, 0.5 slow motion'),
  loop: z.enum(['none', 'loop', 'pingpong']).default('none').describe('none plays once (nothing shows past the end of the source); loop repeats; pingpong plays forward then back'),
  loopLengthMs: z.number().positive().nullable().default(null).describe('The cycle in source ms; null: the source from trimInMs to its end'),
})

/**
 * A comp inside a comp: its own timeline, drawn as one layer whose box is
 * the source comp's size. The source is embedded (made for this layer by
 * layers.nest, `embedded` on the comp) or linked (any other comp; editing it
 * changes every place it shows).
 */
export const NestedLayerSchema = z.strictObject({
  ...layerBase,
  kind: z.literal('nested'),
  sourceCompId: IdSchema.describe('The comp shown inside (AtomCut: sourceFrameId)'),
  trimInMs: z.number().min(0).default(0).describe("The source time shown at the layer's start, ms"),
  playback: NestedPlaybackSchema.prefault({}),
  clipContent: z
    .boolean()
    .nullable()
    .default(null)
    .describe("Crop the inside to the comp's box: true crops, false lets it spill, null (auto) crops a comp with a visible background and lets a transparent one spill"),
  volume: z.number().min(0).max(4).default(1).describe('Loudness of the sound inside'),
  muted: z.boolean().default(false),
})

/** A camera in a 3D world. The sensor spans the comp's longer side; no field of view is stored. */
export const CameraSchema = z.strictObject({
  projection: z.enum(['perspective', 'orthographic']).default('perspective'),
  focalLength: z.number().min(1).max(5000).default(50).describe('Lens focal length, mm'),
  sensorWidth: z.number().min(1).max(200).default(36).describe("Sensor size along the comp's longer side, mm"),
  orthoScale: z.number().positive().default(1000).describe("Orthographic: the world span of the comp's longer side, px"),
  clipStart: z.number().positive().default(1).describe('Near clip distance, px'),
  clipEnd: z.number().positive().default(100_000).describe('Far clip distance, px'),
  shiftX: z.number().default(0).describe('Lens shift across, as a fraction of the frame'),
  shiftY: z.number().default(0).describe('Lens shift up, as a fraction of the frame'),
  dof: z
    .strictObject({
      enabled: z.boolean().default(false),
      focusDistance: z.number().min(0).default(1000).describe('px from the camera'),
      fStop: z.number().min(0.1).max(128).default(2.8),
      focusObjectId: IdSchema.nullable().default(null).describe('A layer to keep in focus (overrides focusDistance)'),
    })
    .prefault({}),
})

export const LIGHT_TYPES = ['point', 'sun', 'spot', 'area', 'environment', 'hemisphere'] as const
export const ENVIRONMENT_PRESETS = ['studio', 'soft', 'sunset', 'dawn', 'night', 'overcast'] as const

/** A light in a 3D world. Point, spot and area intensities are watts; sun, environment and hemisphere are strengths. */
export const LightSchema = z.strictObject({
  type: z.enum(LIGHT_TYPES).default('point'),
  color: ColorSchema.default('#ffffff'),
  intensity: z.number().min(0).default(1000),
  range: z.number().min(0).default(0).describe('Point and spot: the distance where the light ends, px; 0 is endless'),
  spotAngle: z.number().min(1).max(180).default(45).describe('Spot: cone angle, degrees'),
  spotBlend: z.number().min(0).max(1).default(0.15).describe('Spot: softness of the cone edge'),
  width: z.number().positive().default(100).describe('Area: width, px'),
  height: z.number().positive().default(100).describe('Area: height, px'),
  groundColor: ColorSchema.default('#2b2a28').describe('Hemisphere: the colour from below'),
  castShadow: z.boolean().default(true),
  shadowSoftness: z.number().min(0).max(20).default(2),
  environment: z.enum(ENVIRONMENT_PRESETS).default('studio').describe('Environment: the surroundings that light the scene'),
  showBackground: z.boolean().default(false).describe('Environment: show the surroundings behind the scene'),
})

export const EMPTY_DISPLAYS = ['axes', 'cube', 'sphere', 'arrows'] as const

/** A controller (AtomCut's "empty"): a point in a 3D world that others follow or aim at. It never renders. */
export const EmptySchema = z.strictObject({
  display: z.enum(EMPTY_DISPLAYS).default('axes'),
  size: z.number().positive().default(80).describe('Size of its marker in the editor, px'),
})

export const CameraLayerSchema = z.strictObject({ ...layerBase, kind: z.literal('camera'), camera: CameraSchema.prefault({}) })

export const LightLayerSchema = z.strictObject({ ...layerBase, kind: z.literal('light'), light: LightSchema.prefault({}) })

export const EmptyLayerSchema = z.strictObject({ ...layerBase, kind: z.literal('empty'), empty: EmptySchema.prefault({}) })

export const MESH_SHADING = ['smooth', 'flat', 'auto'] as const

/** What a mesh is made of: a primitive with its (sparse) params, or an imported model (a project media asset of kind model). */
export const MeshGeometrySchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('primitive'),
    primitive: z.enum(PRIMITIVE_IDS),
    params: z.record(z.string(), z.number()).default({}).describe("The primitive's params by key; those left out take their defaults (catalog.get primitives <id> lists them)"),
  }),
  z.strictObject({
    type: z.literal('asset'),
    assetId: IdSchema.describe('The model in the project media (world_import_model adds it)'),
  }),
])

/**
 * How a model's own animation clip plays (ours; AtomCut ignores a file's
 * clips). The clip runs on the layer's local time, so a frame always shows
 * the same pose.
 */
export const ModelAnimationSchema = z.strictObject({
  clip: z.string().nullable().default(null).describe("The clip's name in the file; null holds the model at rest"),
  speed: z.number().min(0).max(16).default(1).describe('1 plays at the speed of the file'),
  loop: z.boolean().default(true).describe('Repeat the clip; off holds its last pose'),
})

/**
 * A mesh: a solid shape in a 3D world (cube, sphere, torus, …). Its colour is
 * its first solid fill; the optional `material` makes it shine, glow or go
 * glassy. Round primitives stand along Z and flat ones lie in XY.
 */
export const MeshLayerSchema = z.strictObject({
  ...layerBase,
  kind: z.literal('mesh'),
  fills: z.array(PaintSchema).default([]).describe("Fills, bottom to top; the mesh's colour is its first solid fill"),
  geometry: MeshGeometrySchema,
  shading: z.enum(MESH_SHADING).default('auto').describe('smooth blends normals across faces, flat keeps every face crisp, auto smooths edges below smoothAngle'),
  smoothAngle: z.number().min(0).max(180).default(30).describe('Auto shading: edges flatter than this angle (degrees) are smoothed'),
  castShadow: z.boolean().default(true),
  receiveShadow: z.boolean().default(true),
  animation: ModelAnimationSchema.optional().describe("A model's own animation clip (geometry type asset only)"),
})

export const LayerSchema = z.discriminatedUnion('kind', [
  TextLayerSchema,
  ShapeLayerSchema,
  PathLayerSchema,
  GroupLayerSchema,
  NestedLayerSchema,
  ImageLayerSchema,
  VideoLayerSchema,
  AudioLayerSchema,
  CameraLayerSchema,
  LightLayerSchema,
  EmptyLayerSchema,
  MeshLayerSchema,
])

/** The 2D kinds: any comp may hold them (in a 3D world they stand as picture planes). */
export const LAYER_KINDS = ['text', 'shape', 'path', 'group', 'nested', 'image', 'video', 'audio'] as const
/** Kinds that exist only in 3D worlds. */
export const SPATIAL_KINDS = ['camera', 'light', 'empty', 'mesh'] as const

/**
 * A transition on a cut of a lane: between two abutting layers (a seam: A
 * ends where B starts), or on a lone layer's head (only B) or tail (only A).
 * It runs from `splitMs` before the cut to the rest of `durationMs` after it;
 * meanwhile A shows past its end and B before its start, held still.
 */
export const TransitionSchema = z.strictObject({
  id: IdSchema,
  preset: z
    .string()
    .refine((id) => findTransitionPreset(id) !== undefined, { message: 'Not a transition preset id (catalog.list transitions lists them)' })
    .describe('A transition preset id'),
  aLayerId: IdSchema.nullable().describe('The outgoing layer (null on a head)'),
  bLayerId: IdSchema.nullable().describe('The incoming layer (null on a tail)'),
  durationMs: z.number().positive(),
  splitMs: z.number().min(0).describe('How much of it runs before the cut'),
  easing: EasingSchema.default('linear'),
  params: z.record(z.string(), z.number()).default({}).describe("The preset's knobs"),
  color: ColorSchema.nullable().default(null).describe("The colour of a dip or flash; null uses the preset's"),
})

export const TrackSchema = z.strictObject({
  id: IdSchema,
  name: z.string().optional(),
  hidden: z.boolean().default(false).describe('Hides every layer on this lane, in the preview and in exports'),
  muted: z.boolean().default(false).describe('Silences every layer on this lane'),
  locked: z.boolean().default(false).describe('Protects the lane from edits by hand in the editor; commands still apply'),
  groupId: IdSchema.nullable()
    .default(null)
    .describe("The group whose members this lane holds; a group's lanes follow the lane of the group itself"),
  layers: z.array(LayerSchema).default([]).describe('Layers on this lane, sorted by startMs and never overlapping'),
  transitions: z.array(TransitionSchema).default([]).describe('Transitions on the cuts of this lane (transition.add)'),
})

export const COMP_MODES = ['timeline', 'static'] as const

/** A page keeps frames (comps) together: scenes on one, deliverables on another. */
export const PageSchema = z.strictObject({ id: IdSchema, name: z.string().min(1) })

export const TONE_MAPPINGS = ['agx', 'aces', 'neutral', 'none'] as const
export const SHADOW_QUALITIES = ['low', 'medium', 'high'] as const
export const FLOOR_MODES = ['none', 'shadow', 'solid', 'mirror'] as const

/** How a 3D world is rendered (AtomCut's defaults). */
export const WorldRenderSchema = z.strictObject({
  toneMapping: z.enum(TONE_MAPPINGS).default('agx'),
  exposure: z.number().min(-10).max(10).default(0).describe('Stops'),
  shadows: z.boolean().default(true),
  shadowQuality: z.enum(SHADOW_QUALITIES).default('medium').describe('Shadow maps of 512, 1024 or 2048 px'),
  bloom: z
    .strictObject({
      enabled: z.boolean().default(false),
      strength: z.number().min(0).max(3).default(0.8),
      radius: z.number().min(0).max(1).default(0.5),
      threshold: z.number().min(0).max(1).default(0.75),
      source: z.enum(['bright', 'emission']).default('bright'),
    })
    .prefault({}),
  ao: z
    .strictObject({
      enabled: z.boolean().default(false),
      radius: z.number().min(1).max(5000).default(60).describe('px'),
      strength: z.number().min(0).max(2).default(1),
    })
    .prefault({}),
  floor: z
    .strictObject({
      mode: z.enum(FLOOR_MODES).default('none'),
      color: ColorSchema.default('#202024'),
      opacity: z.number().min(0).max(1).default(0.45),
      z: z.number().default(0).describe('Height of the floor, px'),
    })
    .prefault({}),
})

/** Linear fog (AtomCut's tool calls it mist). */
export const WorldFogSchema = z.strictObject({
  enabled: z.boolean().default(false),
  color: ColorSchema.default('#9aa3ad'),
  start: z.number().min(0).default(1000).describe('px from the camera'),
  end: z.number().min(0).default(20_000).describe('px from the camera'),
})

/**
 * A comp is a 3D world when it has this. Space: Z up, X right, Y away from
 * the front view, 1 unit = 1 px. 2D layers stand in it as picture planes.
 */
export const WorldSchema = z.strictObject({
  render: WorldRenderSchema.prefault({}),
  fog: WorldFogSchema.prefault({}),
})

export const CompSchema = z.strictObject({
  id: IdSchema,
  name: z.string().min(1),
  width: z.number().int().min(16).max(8192),
  height: z.number().int().min(16).max(8192),
  fps: z.number().min(1).max(240),
  durationMs: z.number().positive(),
  background: ColorSchema.default('#000000'),
  mode: z
    .enum(COMP_MODES)
    .default('timeline')
    .describe('timeline: layers move over time. static: one picture that shows its still (stillMs) whatever time is asked; shown nested it holds, exported it is an image, and it is silent'),
  stillMs: z.number().min(0).default(0).describe('The comp time a static comp shows'),
  overflow: z
    .number()
    .min(0)
    .max(1)
    .nullable()
    .default(null)
    .describe('Content past the comp box when it is shown nested: 0 crops it, 1 never crops it; null lets the nested layer decide (a visible background crops, a transparent comp spills)'),
  pageId: IdSchema.nullable().default(null).describe('The page the comp is on; null is the first page. Comps embedded in a nested layer are on none'),
  tracks: z.array(TrackSchema).default([]).describe('Lanes from front (index 0) to back'),
  motionBlur: CompMotionBlurSchema.prefault({}).describe('The master motion blur: on by default, a 180° film shutter'),
  embedded: z.boolean().default(false).describe('Made by layers.nest for one nested layer, which owns it: it is reached by entering that layer and goes when the layer does'),
  world: WorldSchema.optional().describe('Present on a 3D world (world.create): its render settings and fog'),
  soundMix: SoundMixSchema.prefault({}).describe("The frame's mix: master fader, leveler (loudness per category) and limiter (frame.update soundMix)"),
  physics: PhysicsSceneSchema.optional().describe('Physics of the comp: gravity, floor, walls, speed (physics.scene); absent until set'),
})

export const MEDIA_KINDS = ['video', 'image', 'audio', 'model'] as const

/** 3D model files a world can import (AtomCut's list without fbx). */
export const MODEL_FORMATS = ['glb', 'gltf', 'obj', 'stl', 'ply'] as const

/** What the editor read from a model file when it was imported. */
export const ModelInfoSchema = z.strictObject({
  format: z.enum(MODEL_FORMATS),
  clips: z
    .array(z.strictObject({ name: z.string(), durationMs: z.number().min(0) }))
    .default([])
    .describe('The animation clips in the file (glTF only)'),
  size: z.tuple([z.number(), z.number(), z.number()]).optional().describe('Its size in a world once placed (x, y, z px): glTF at 1 m = 100 px, other formats fitted to 200 px'),
})

/** A word of a voice take and when it is spoken, in ms from the start of the file. */
export const SpeechWordSchema = z.strictObject({
  text: z.string().min(1),
  startMs: z.number().min(0),
  endMs: z.number().min(0),
})

/** What a voice take says: kept on its media so captions, translations and re-takes follow the words, not guesses. */
export const SpeechInfoSchema = z.strictObject({
  text: z.string().min(1).describe('The script of the take'),
  language: z.string().min(2).describe('BCP-47 code, e.g. hi-IN'),
  voice: z.string().nullable().default(null).describe('The voice (speaker) that read it; null when not known'),
  provider: z.string().nullable().default(null).describe('Who made or heard it, e.g. "sarvam:bulbul:v3"; null for a recording'),
  pace: z.number().positive().optional().describe('The pace it was generated at (1 is normal)'),
  startMs: z.number().min(0).describe('Where the voice starts in the file (the silence before it is left out)'),
  endMs: z.number().min(0).describe('Where the voice ends in the file'),
  words: z.array(SpeechWordSchema).default([]).describe('Each word and when it is spoken (aligned to the audio)'),
  source: z.string().nullable().default(null).describe('The media id of the take this one translates, if any'),
})

export const MediaAssetSchema = z.strictObject({
  id: IdSchema,
  kind: z.enum(MEDIA_KINDS),
  name: z.string().min(1),
  path: z.string().min(1).describe('Absolute file path or URL'),
  mime: z.string().optional(),
  durationMs: z.number().positive().optional(),
  width: z.number().int().positive().optional().describe('Display width in px, after rotation'),
  height: z.number().int().positive().optional().describe('Display height in px, after rotation'),
  fps: z.number().positive().optional().describe('Average frame rate of a video'),
  hasAudio: z.boolean().optional(),
  model: ModelInfoSchema.optional().describe('Set on a 3D model (kind model)'),
  envelope: z
    .strictObject({
      rate: z.number().positive().default(50).describe('Samples per second (50 is one per 20 ms)'),
      values: z.array(z.number().min(0).max(1)).describe('Loudness 0..1, one per step from the start of the file'),
    })
    .optional()
    .describe("A voice's loudness over time, traced from its audio, so talk and nod are pure functions of the document"),
  speech: SpeechInfoSchema.optional().describe('What a voice take says and when (generate_speech, media_transcribe): its script, language, voice and word times'),
  silhouette: z
    .array(z.array(z.tuple([z.number(), z.number()])))
    .optional()
    .describe("A picture's outline traced from its alpha: polygons in fractions of its width and height (0..1, y down), for physics"),
  credit: z
    .strictObject({
      source: z.string().min(1).describe('Where it came from, e.g. "AtomCut sound library ▸ Impacts & Risers"'),
      license: z.string().min(1).describe('An SPDX id such as CC0-1.0'),
      attribution: z.string().default(''),
    })
    .optional()
    .describe('Licence and credit of a file taken from a library'),
})

export const FONT_FORMATS = ['ttf', 'otf', 'ttc', 'woff', 'woff2'] as const

/** A font file the user installed into the project: text layers use its family by name, like a Google family. */
export const InstalledFontSchema = z.strictObject({
  id: IdSchema,
  family: z.string().min(1).describe('The family name text layers use as fontFamily'),
  path: z.string().min(1).describe('Absolute file path; the file stays where it is, like media'),
  name: z.string().min(1).describe('The file name'),
  weight: z.number().int().min(100).max(900).default(400).describe('The weight of a static font'),
  italic: z.boolean().default(false),
  variable: z
    .strictObject({ min: z.number(), max: z.number() })
    .nullable()
    .default(null)
    .describe('The weight range of a variable font; null for a static one'),
  format: z.enum(FONT_FORMATS).default('ttf'),
})

export const SCRIPT_RUN_MODES = ['replace', 'append'] as const

/** A saved script: its source, how a re-run treats its earlier output, and what its last run made. */
export const ScriptFileSchema = z.strictObject({
  id: IdSchema,
  path: z.string().min(1).describe('Like `intro/title.js`; unique in the project'),
  source: z.string(),
  onRun: z.enum(SCRIPT_RUN_MODES).default('replace').describe('replace: a run first removes what the last run made. append: every run adds'),
  output: z
    .strictObject({ layerIds: z.array(IdSchema).default([]), compIds: z.array(IdSchema).default([]) })
    .prefault({})
    .describe('The layers and comps its runs made (replace mode removes them before the next run)'),
})

export const PROJECT_VERSION = 1

export const ProjectSchema = z.strictObject({
  version: z.literal(PROJECT_VERSION),
  id: IdSchema,
  name: z.string().min(1),
  comps: z.array(CompSchema).min(1),
  pages: z.array(PageSchema).min(1).default(() => [{ id: 'page_1', name: 'Page 1' }]).describe('Pages of frames; the first is where a frame with no page is'),
  media: z.array(MediaAssetSchema).default([]),
  fonts: z.array(InstalledFontSchema).default([]).describe('Font files installed into the project (font_install)'),
  soundCategories: z.array(SoundCategorySchema).default(builtInCategories).describe('Sound categories (buses) layers route their sound to (sound.category); the four built-ins are always there'),
  scripts: z.array(ScriptFileSchema).default([]).describe('Saved scripts (script.save), run with script.run {script}'),
})

export type Easing = z.infer<typeof EasingSchema>
export type EasingPreset = (typeof EASING_PRESETS)[number]
export type KeyValue = z.infer<typeof KeyValueSchema>
export type Keyframe = z.infer<typeof KeyframeSchema>
export type Transform = z.infer<typeof TransformSchema>
export type TextStyle = z.infer<typeof TextStyleSchema>
export type TextRange = z.infer<typeof TextRangeSchema>
export type TextRangeStyle = z.infer<typeof TextRangeStyleSchema>
export type Highlight = z.infer<typeof HighlightSchema>
export type InstalledFont = z.infer<typeof InstalledFontSchema>
export type Page = z.infer<typeof PageSchema>
export type CompMode = (typeof COMP_MODES)[number]
export type LayerOrigin = z.infer<typeof LayerOriginSchema>
export type LayerAnimation = z.infer<typeof LayerAnimationSchema>
export type AnimationUnit = (typeof ANIMATION_UNITS)[number]
export type ShapeGeometry = z.infer<typeof ShapeGeometrySchema>
export type BlendMode = z.infer<typeof BlendModeSchema>
export type GradientStop = z.infer<typeof GradientStopSchema>
export type Paint = z.infer<typeof PaintSchema>
export type Stroke = z.infer<typeof StrokeSchema>
export type Layer = z.infer<typeof LayerSchema>
export type GroupLayer = z.infer<typeof GroupLayerSchema>
export type PathLayer = z.infer<typeof PathLayerSchema>
export type NestedLayer = z.infer<typeof NestedLayerSchema>
export type NestedPlayback = z.infer<typeof NestedPlaybackSchema>
export type GroupMode = (typeof GROUP_MODES)[number]
export type Layout = z.infer<typeof LayoutSchema>
export type LayoutItem = z.infer<typeof LayoutItemSchema>
export type LayerKind = Layer['kind']
export type SpatialKind = (typeof SPATIAL_KINDS)[number]
export type CameraLayer = z.infer<typeof CameraLayerSchema>
export type LightLayer = z.infer<typeof LightLayerSchema>
export type EmptyLayer = z.infer<typeof EmptyLayerSchema>
export type MeshLayer = z.infer<typeof MeshLayerSchema>
export type MeshGeometrySpec = z.infer<typeof MeshGeometrySchema>
export type ModelAnimation = z.infer<typeof ModelAnimationSchema>
export type ModelInfo = z.infer<typeof ModelInfoSchema>
export type ModelFormat = (typeof MODEL_FORMATS)[number]
export type MeshShading = (typeof MESH_SHADING)[number]
export type CameraSpec = z.infer<typeof CameraSchema>
export type LightSpec = z.infer<typeof LightSchema>
export type MaterialSpec = z.infer<typeof MaterialSchema>
export type MaterialModel = (typeof MATERIAL_MODELS)[number]
export type LightType = (typeof LIGHT_TYPES)[number]
export type EnvironmentPreset = (typeof ENVIRONMENT_PRESETS)[number]
export type World = z.infer<typeof WorldSchema>
export type Track = z.infer<typeof TrackSchema>
export type Caption = z.infer<typeof CaptionSchema>
export type CaptionCue = z.infer<typeof CaptionCueSchema>
export type CaptionState = z.infer<typeof CaptionStateSchema>
export type Transition = z.infer<typeof TransitionSchema>
export type PhysicsScene = z.infer<typeof PhysicsSceneSchema>
export type PhysicsBody = z.infer<typeof PhysicsBodySchema>
export type Force = z.infer<typeof ForceSchema>
export type Joint = z.infer<typeof JointSchema>
export type ForceType = (typeof FORCE_TYPES)[number]
export type JointType = (typeof JOINT_TYPES)[number]
export type Comp = z.infer<typeof CompSchema>
export type ScriptFile = z.infer<typeof ScriptFileSchema>
export type MediaAsset = z.infer<typeof MediaAssetSchema>
export type SpeechInfo = z.infer<typeof SpeechInfoSchema>
export type SpeechWord = z.infer<typeof SpeechWordSchema>
export type MediaKind = MediaAsset['kind']
export type Project = z.infer<typeof ProjectSchema>

/**
 * An object schema with every field optional and no defaults, for inputs whose
 * fields merge into existing values: zod's `.partial()` keeps the defaults, so
 * a field the caller left out would be filled in and overwrite the old value.
 */
export function optionalFields<T extends z.ZodObject>(schema: T): ReturnType<T['partial']> {
  const shape: Record<string, z.ZodType> = {}
  for (const [key, field] of Object.entries(schema.shape as Record<string, z.ZodType>)) {
    let inner: z.ZodType = field
    while (inner instanceof z.ZodDefault || inner instanceof z.ZodPrefault) inner = inner.unwrap() as z.ZodType
    shape[key] = field.description ? inner.optional().describe(field.description) : inner.optional()
  }
  return z.strictObject(shape) as unknown as ReturnType<T['partial']>
}
