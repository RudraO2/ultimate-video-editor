import { z } from 'zod'

// The effect stack: ordered cards on a layer, the first applied first.
// Layer effects (`effects`, keyed at `lfx.<id>.<field>`) work on the layer's
// drawn pixels; text effects (`style.textEffects`, `tfx.<id>.<field>`) are
// drawn under each glyph and move with it. The types, fields, ranges and
// defaults follow AtomCut's (preset data); what each card draws is ours.

export type EffectDomain = 'layer' | 'text'

export type EffectField =
  | { kind: 'number'; default: number; min?: number; max?: number; int?: boolean; description: string }
  | { kind: 'color'; default: string; description: string }
  | { kind: 'enum'; options: readonly string[]; default: string; description: string }
  | { kind: 'boolean'; default: boolean; description: string }

export interface EffectDef {
  type: string
  domain: EffectDomain
  label: string
  family: string
  tagline: string
  fields: Readonly<Record<string, EffectField>>
}

/** A card in a stack: its type, id, switch and fields. */
export type Effect = { id: string; type: string; enabled: boolean } & Record<string, number | string | boolean>

const num = (value: number, description: string, range: { min?: number; max?: number; int?: boolean } = {}): EffectField => ({
  kind: 'number',
  default: value,
  description,
  ...range,
})
const color = (value: string, description: string): EffectField => ({ kind: 'color', default: value, description })
const choice = (options: readonly string[], value: string, description: string): EffectField => ({ kind: 'enum', options, default: value, description })
const flag = (value: boolean, description: string): EffectField => ({ kind: 'boolean', default: value, description })

/** Composite modes a light card can mix with (canvas names, as AtomCut's). */
export const EFFECT_BLENDS = ['source-over', 'multiply', 'screen', 'overlay', 'soft-light', 'hard-light', 'color-dodge', 'color-burn', 'difference', 'lighter'] as const

/**
 * The seeded clock of cards that re-roll on their own: `animate` off holds
 * one look for the whole clip (keys still play).
 */
const clock = (moving: boolean) => ({
  animate: flag(moving, 'Re-roll on its own clock; off holds one look'),
  seed: num(1, 'Picks the take of the look', { min: 0, max: 99999, int: true }),
  rate: num(24, 'Re-rolls per second', { min: 0.1, max: 120 }),
  jitter: num(0, 'Unevenness of the re-roll timing', { min: 0, max: 1 }),
  stutter: num(0, 'Odds of holding a look for an extra step', { min: 0, max: 1 }),
})

const centre = {
  centerX: num(0, "Centre across the layer's box: -1 left edge, 0 middle, 1 right edge", { min: -1, max: 1 }),
  centerY: num(0, "Centre down the layer's box: -1 top edge, 0 middle, 1 bottom edge", { min: -1, max: 1 }),
}

export const LAYER_EFFECTS: readonly EffectDef[] = [
  {
    type: 'shadow',
    domain: 'layer',
    label: 'Drop shadow',
    family: 'Shadow & Glow',
    tagline: 'A shadow that follows the real silhouette — a star casts a star.',
    fields: {
      color: color('#00000080', 'Shadow colour; its alpha is the strength'),
      x: num(0, 'Offset right, layer px'),
      y: num(12, 'Offset down, layer px'),
      blur: num(24, 'Softness, layer px', { min: 0 }),
    },
  },
  {
    type: 'innerShadow',
    domain: 'layer',
    label: 'Inner shadow',
    family: 'Shadow & Glow',
    tagline: 'A shadow cast inside the shape — recessed, letterpress.',
    fields: {
      color: color('#00000099', 'Shadow colour; its alpha is the strength'),
      x: num(0, 'Offset right, layer px'),
      y: num(6, 'Offset down, layer px'),
      blur: num(12, 'Softness, layer px', { min: 0 }),
    },
  },
  {
    type: 'glow',
    domain: 'layer',
    label: 'Glow',
    family: 'Shadow & Glow',
    tagline: 'Light leaving the layer — in its own colours by default.',
    fields: {
      mode: choice(['auto', 'solid'], 'auto', "auto glows in the layer's own colours; solid in one colour"),
      color: color('#4cc3e0', 'Glow colour (solid mode)'),
      size: num(24, 'How far the light spreads, layer px', { min: 0 }),
      intensity: num(0.8, 'Strength; above 1 burns brighter', { min: 0, max: 3 }),
      saturation: num(1.6, "Colour boost of an auto glow", { min: 0, max: 4 }),
      brightness: num(1.1, 'Brightness of an auto glow', { min: 0, max: 4 }),
      inner: flag(false, 'Glow inward from the edges instead of outward'),
    },
  },
  {
    type: 'blur',
    domain: 'layer',
    label: 'Layer blur',
    family: 'Blur & Sharpen',
    tagline: 'Softens the whole layer, evenly.',
    fields: { radius: num(8, 'Blur radius, layer px', { min: 0 }) },
  },
  {
    type: 'stroke',
    domain: 'layer',
    label: 'Stroke',
    family: 'Stylize',
    tagline: "An outline traced around the layer's silhouette.",
    fields: {
      color: color('#000000', 'Outline colour'),
      width: num(4, 'Width, layer px', { min: 0, max: 200 }),
      placement: choice(['outside', 'center', 'inside'], 'outside', 'Where the outline sits on the edge'),
      softness: num(0, 'Feather of the outline edge, 0 sharp to 1 soft', { min: 0, max: 1 }),
    },
  },
  {
    type: 'longShadow',
    domain: 'layer',
    label: 'Long shadow',
    family: 'Shadow & Glow',
    tagline: 'A solid trail cast off the silhouette, flat-poster style.',
    fields: {
      color: color('#00000055', 'Shadow colour'),
      angle: num(45, 'Direction, degrees: 0 right, 90 down', { min: -180, max: 180 }),
      length: num(120, 'Length, layer px', { min: 0, max: 2000 }),
      fade: num(0.35, 'How much it fades toward its end, 0 to 1', { min: 0, max: 1 }),
    },
  },
  {
    type: 'rgbSplit',
    domain: 'layer',
    label: 'RGB split',
    family: 'Distort',
    tagline: 'Pulls the red and blue channels apart — lens fringe, glitch.',
    fields: {
      angle: num(0, 'Direction of the split, degrees', { min: -180, max: 180 }),
      distance: num(6, 'How far each channel moves, layer px', { min: 0, max: 200 }),
    },
  },
  {
    type: 'adjust',
    domain: 'layer',
    label: 'Adjust',
    family: 'Color',
    tagline: 'The quick filter block: brightness, contrast, saturation, hue.',
    fields: {
      brightness: num(1, '1 unchanged, 0 black', { min: 0 }),
      contrast: num(1, '1 unchanged, 0 flat grey', { min: 0 }),
      saturate: num(1, '1 unchanged, 0 greyscale', { min: 0 }),
      hueDeg: num(0, 'Hue rotation, degrees'),
      grayscale: num(0, '0 to 1', { min: 0, max: 1 }),
      sepia: num(0, '0 to 1', { min: 0, max: 1 }),
    },
  },
  {
    type: 'vignette',
    domain: 'layer',
    label: 'Vignette',
    family: 'Color',
    tagline: 'Darkens the corners — the photographic edge falloff.',
    fields: {
      amount: num(0.4, 'Strength: positive darkens toward the colour, negative lightens', { min: -1, max: 1 }),
      softness: num(0.5, 'How gradual the falloff is', { min: 0, max: 1 }),
      roundness: num(0.5, "0 follows the box's shape, 1 a circle", { min: 0, max: 1 }),
      color: color('#000000', 'Edge colour'),
    },
  },
  {
    type: 'sharpen',
    domain: 'layer',
    label: 'Sharpen',
    family: 'Blur & Sharpen',
    tagline: 'Unsharp mask — brings detail back after a scale or a blur.',
    fields: {
      amount: num(1, 'Strength', { min: 0, max: 4 }),
      radius: num(2, 'Edge width, layer px', { min: 0.3, max: 12 }),
    },
  },
  {
    type: 'directionalBlur',
    domain: 'layer',
    label: 'Directional blur',
    family: 'Blur & Sharpen',
    tagline: 'Smears the layer along one angle — speed and motion.',
    fields: {
      angle: num(0, 'Direction, degrees', { min: -180, max: 180 }),
      distance: num(20, 'Streak length, layer px', { min: 0, max: 200 }),
    },
  },
  {
    type: 'zoomBlur',
    domain: 'layer',
    label: 'Zoom blur',
    family: 'Blur & Sharpen',
    tagline: 'Radial streaks out of a point — a dolly-in, a punch.',
    fields: { strength: num(0.3, 'How far the zoom streaks reach, 0 to 1', { min: 0, max: 1 }), ...centre },
  },
  {
    type: 'spinBlur',
    domain: 'layer',
    label: 'Spin blur',
    family: 'Blur & Sharpen',
    tagline: 'Smears around a centre instead of out from it.',
    fields: { angle: num(12, 'Arc of the spin, degrees', { min: 0, max: 180 }), ...centre },
  },
  {
    type: 'shine',
    domain: 'layer',
    label: 'Shine',
    family: 'Light & Optics',
    tagline: 'A band of light that travels across the layer.',
    fields: {
      position: num(0.5, 'Where the band is: 0 before the layer, 1 past it; each pass adds 0 to 1. Key it with duration 0 to drive it by hand', {
        min: -1,
        max: 2,
      }),
      duration: num(1.6, 'Seconds per pass; 0 holds the band at position', { min: 0, max: 120 }),
      delay: num(0, 'Seconds of stillness before each pass', { min: 0, max: 120 }),
      loop: flag(true, 'Repeat the pass; off sweeps once'),
      angle: num(-20, 'Tilt of the band, degrees', { min: -180, max: 180 }),
      width: num(140, 'Band width, layer px', { min: 0, max: 3000 }),
      softness: num(0.6, 'Softness of the band edges', { min: 0, max: 1 }),
      count: num(1, 'Bands per pass', { min: 1, max: 6, int: true }),
      gap: num(0.18, 'Space between bands, as a fraction of the sweep', { min: 0.01, max: 1 }),
      falloff: num(0.55, 'How much fainter each further band is', { min: 0, max: 1 }),
      color: color('#ffffff', 'Light colour'),
      intensity: num(1, 'Brightness', { min: 0, max: 3 }),
      bloom: num(14, 'Glow around the band, layer px', { min: 0, max: 300 }),
      blend: choice(EFFECT_BLENDS, 'screen', 'How the light mixes with the layer'),
      inside: flag(true, 'Only on the layer itself; off also lights the empty part of its box'),
    },
  },
  {
    type: 'grain',
    domain: 'layer',
    label: 'Film grain',
    family: 'Film & Video',
    tagline: 'Emulsion noise on a seeded clock — it re-rolls, and it exports the same.',
    fields: {
      ...clock(false),
      amount: num(0.25, 'Strength', { min: 0, max: 1 }),
      size: num(1, 'Grain size, layer px', { min: 0.25, max: 8 }),
      aspect: num(1, 'Grain width over height', { min: 0.1, max: 10 }),
      softness: num(0, 'Blur of the grain, px', { min: 0, max: 8 }),
      chroma: num(0, 'Colour in the grain, 0 grey to 1 full colour', { min: 0, max: 1 }),
      blend: choice(EFFECT_BLENDS, 'overlay', 'How the grain mixes with the layer'),
    },
  },
  {
    type: 'filmDamage',
    domain: 'layer',
    label: 'Film damage',
    family: 'Film & Video',
    tagline: 'Dust, scratches, hairs, flicker and gate weave — a worn print.',
    fields: {
      ...clock(true),
      mix: num(1, 'Strength of the whole card', { min: 0, max: 1 }),
      dust: num(0.35, 'How much dust', { min: 0, max: 1 }),
      dustSize: num(4, 'Dust speck size, px', { min: 0.5, max: 40 }),
      dustBias: num(0.4, 'Dark dust (positive) or light dust (negative)', { min: -1, max: 1 }),
      dustSoftness: num(0.15, 'Softness of the specks', { min: 0, max: 1 }),
      scratches: num(3, 'Scratches at once', { min: 0, max: 40 }),
      scratchWidth: num(1.4, 'Scratch width, px', { min: 0.2, max: 20 }),
      scratchLength: num(0.9, 'Scratch length, a fraction of the height', { min: 0.05, max: 1 }),
      scratchSoftness: num(0.25, 'Softness of the scratches', { min: 0, max: 1 }),
      scratchDrift: num(20, 'How far scratches wander, px per second', { min: 0, max: 400 }),
      scratchOpacity: num(0.5, 'Scratch strength', { min: 0, max: 1 }),
      scratchColor: color('#ffffff', 'Scratch colour'),
      scratchAngle: num(0, 'Scratch tilt, degrees', { min: -45, max: 45 }),
      hairs: num(0, 'Hairs at once', { min: 0, max: 12 }),
      hairWidth: num(1.6, 'Hair width, px', { min: 0.2, max: 10 }),
      hairSize: num(0.25, 'Hair length, a fraction of the height', { min: 0.02, max: 1 }),
      hairOpacity: num(0.6, 'Hair strength', { min: 0, max: 1 }),
      flicker: num(0.15, 'Brightness flicker', { min: 0, max: 1 }),
      flickerSmooth: num(0.4, 'How gently the flicker changes', { min: 0, max: 1 }),
      weaveX: num(2, 'Gate weave across, px', { min: 0, max: 200 }),
      weaveY: num(3, 'Gate weave down, px', { min: 0, max: 200 }),
      weaveRotate: num(0.15, 'Gate weave turn, degrees', { min: 0, max: 10 }),
      weaveSmooth: num(0.5, 'How gently the weave moves', { min: 0, max: 1 }),
      splices: flag(false, 'Frame slips at splices (the print jumping a frame); leave off unless the reel is meant to be broken'),
      jump: num(0, 'Odds of a frame slip', { min: 0, max: 1 }),
      jumpAmount: num(0.3, 'How far a slip jumps, a fraction of the height', { min: 0, max: 1 }),
      splice: num(0.5, 'Strength of the splice bar', { min: 0, max: 1 }),
      inside: flag(true, 'Only on the layer itself'),
    },
  },
  {
    type: 'scanlines',
    domain: 'layer',
    label: 'Scanlines',
    family: 'Film & Video',
    tagline: 'A CRT mask: lines, dot triads, phosphor bleed, tube curve.',
    fields: {
      ...clock(true),
      mix: num(1, 'Strength of the whole card', { min: 0, max: 1 }),
      shape: choice(['line', 'dot', 'slot', 'grille'], 'line', 'line: plain scanlines; dot, slot, grille: colour phosphor masks'),
      angle: num(0, 'Tilt of the lines, degrees', { min: -180, max: 180 }),
      pitch: num(4, 'Line spacing, px', { min: 1, max: 200 }),
      thickness: num(0.5, 'How much of each period is dark', { min: 0.02, max: 0.98 }),
      softness: num(0.6, 'Softness of the line edges', { min: 0, max: 1 }),
      offset: num(0, 'Shifts the lines, px', { min: -500, max: 500 }),
      aspect: num(1, 'Mask cell width over height', { min: 0.1, max: 10 }),
      amount: num(0.5, 'How dark the lines are', { min: 0, max: 1 }),
      color: color('#000000', 'Line colour'),
      blend: choice(EFFECT_BLENDS, 'multiply', 'How the lines mix with the layer'),
      bleed: num(0, 'Phosphor glow of the bright parts, px', { min: 0, max: 60 }),
      boost: num(0, 'Brightens the layer to make up for the dark lines', { min: 0, max: 2 }),
      roll: num(0, 'Scrolls the lines, px per second', { min: -2000, max: 2000 }),
      flicker: num(0, 'Brightness flicker', { min: 0, max: 1 }),
      interlace: num(0, 'Alternate lines shift every frame', { min: 0, max: 1 }),
      curvature: num(0, 'Bulge of the tube', { min: 0, max: 1 }),
      inside: flag(true, 'Only on the layer itself'),
    },
  },
  {
    type: 'noise',
    domain: 'layer',
    label: 'Noise',
    family: 'Film & Video',
    tagline: 'A procedural field — overlay it, or let it warp the layer.',
    fields: {
      ...clock(false),
      mix: num(1, 'Strength of the whole card', { min: 0, max: 1 }),
      shape: choice(['value', 'fractal', 'turbulence', 'ridged'], 'fractal', 'value: soft blobs; fractal: clouds; turbulence: billows; ridged: veins'),
      scale: num(64, 'Size of the features, px', { min: 1, max: 2000 }),
      aspect: num(1, 'Feature width over height', { min: 0.1, max: 10 }),
      octaves: num(4, 'Layers of detail', { min: 1, max: 8, int: true }),
      roughness: num(0.5, 'How strong each finer layer is', { min: 0.05, max: 0.95 }),
      lacunarity: num(2, 'How much finer each layer is', { min: 1.05, max: 4 }),
      contrast: num(1, 'Contrast of the field', { min: 0, max: 4 }),
      brightness: num(0, 'Brightness of the field', { min: -1, max: 1 }),
      evolve: num(1, 'How fast the field changes, per second (animate on)', { min: 0, max: 20 }),
      driftX: num(0, 'Drift across, px per second', { min: -2000, max: 2000 }),
      driftY: num(0, 'Drift down, px per second', { min: -2000, max: 2000 }),
      amount: num(0.4, 'How strongly the field is laid over the layer', { min: 0, max: 1 }),
      blend: choice(EFFECT_BLENDS, 'overlay', 'How the field mixes with the layer'),
      chroma: num(0, 'Colour in the field', { min: 0, max: 1 }),
      lowColor: color('#000000', 'Colour of the field low points'),
      highColor: color('#ffffff', 'Colour of the field high points'),
      displace: num(0, 'Warps the layer along the field, px', { min: 0, max: 400 }),
      inside: flag(true, 'Only on the layer itself'),
    },
  },
  {
    type: 'bulge',
    domain: 'layer',
    label: 'Bulge',
    family: 'Distort',
    tagline: 'A lens you can move over the layer — magnify or pinch.',
    fields: {
      centerX: num(0, "Centre across the layer's box: -1 left edge, 1 right edge", { min: -2, max: 2 }),
      centerY: num(0, "Centre down the layer's box: -1 top edge, 1 bottom edge", { min: -2, max: 2 }),
      radius: num(0.35, "Lens size, a fraction of the box's longer side", { min: 0.01, max: 2 }),
      strength: num(0.55, 'Positive magnifies, negative pinches', { min: -1, max: 1 }),
      softness: num(0.5, 'How gently the lens fades into the rest', { min: 0, max: 1 }),
      aspect: num(1, 'Lens width over height', { min: 0.1, max: 10 }),
      refract: num(0.25, 'Colour fringing at the lens rim', { min: 0, max: 1 }),
    },
  },
  {
    type: 'wave',
    domain: 'layer',
    label: 'Wave warp',
    family: 'Distort',
    tagline: 'A travelling wave folded into the layer — flags, jelly, heat.',
    fields: {
      animate: flag(true, 'Let the wave travel at its speed; off holds it'),
      shape: choice(['sine', 'triangle', 'square', 'noise'], 'sine', 'Wave shape'),
      angle: num(0, 'Direction the wave runs along, degrees', { min: -180, max: 180 }),
      wavelength: num(200, 'Wavelength, layer px', { min: 2, max: 4000 }),
      amplitude: num(26, 'How far pixels move, layer px', { min: 0, max: 1000 }),
      phase: num(0, 'Where in its cycle the wave starts, degrees', { min: -3600, max: 3600 }),
      speed: num(0.5, 'Cycles per second', { min: -8, max: 8 }),
      cross: num(0, '0 moves pixels across the wave (a flag), 1 along it (a pulse)', { min: 0, max: 1 }),
      anchor: num(0, 'Pins the start edge: the wave grows from it (1 a flag on a pole)', { min: 0, max: 1 }),
    },
  },
  {
    type: 'twirl',
    domain: 'layer',
    label: 'Twirl',
    family: 'Distort',
    tagline: 'Spins the middle and leaves the edge alone.',
    fields: {
      centerX: num(0, "Centre across the layer's box: -1 left edge, 1 right edge", { min: -2, max: 2 }),
      centerY: num(0, "Centre down the layer's box: -1 top edge, 1 bottom edge", { min: -2, max: 2 }),
      radius: num(0.5, "Reach, a fraction of the box's longer side", { min: 0.01, max: 2 }),
      angle: num(180, 'Turn at the centre, degrees', { min: -2000, max: 2000 }),
      softness: num(0.7, 'How gently the turn fades toward the rim', { min: 0, max: 1 }),
    },
  },
  {
    type: 'lensDistort',
    domain: 'layer',
    label: 'Lens distortion',
    family: 'Distort',
    tagline: 'Barrel and pincushion, with the fringing that comes with them.',
    fields: {
      amount: num(0.3, 'Positive bows lines out (barrel), negative in (pincushion)', { min: -1, max: 1 }),
      cubic: num(0, 'More bend toward the edges', { min: -1, max: 1 }),
      chroma: num(0.18, 'Colour fringing that grows toward the edges', { min: 0, max: 1 }),
      scale: num(1, 'Zoom to fill the frame again', { min: 0.25, max: 4 }),
      centerX: num(0, "Centre across the layer's box: -1 left edge, 1 right edge", { min: -2, max: 2 }),
      centerY: num(0, "Centre down the layer's box: -1 top edge, 1 bottom edge", { min: -2, max: 2 }),
    },
  },
  {
    type: 'goo',
    domain: 'layer',
    label: 'Goo',
    family: 'Distort',
    tagline: 'Shapes swell toward each other and fuse where they meet.',
    fields: {
      blur: num(20, 'Reach: how far apart shapes still fuse, layer px', { min: 0, max: 400 }),
      threshold: num(0.5, 'How tight the merged outline is', { min: 0.05, max: 0.95 }),
      softness: num(0.04, 'Softness of the merged edge', { min: 0, max: 0.5 }),
      mix: num(1, 'Strength of the whole card', { min: 0, max: 1 }),
    },
  },
  {
    type: 'roughenEdges',
    domain: 'layer',
    label: 'Roughen edges',
    family: 'Distort',
    tagline: "Chews the layer's outline — torn, burnt, chalky, rusted.",
    fields: {
      ...clock(false),
      style: choice(['rough', 'spiky', 'torn', 'melt', 'rusty'], 'rough', 'rough: chalky; spiky: thorns; torn: paper; melt: drips down; rusty: eaten and tinted'),
      amount: num(20, 'How far the edge is pushed, layer px', { min: 0, max: 600 }),
      scale: num(48, 'Size of the bites, layer px', { min: 1, max: 1000 }),
      complexity: num(3, 'Layers of detail', { min: 1, max: 6, int: true }),
      sharpness: num(0.65, 'Crisp bites (1) or soft (0)', { min: 0, max: 1 }),
      evolve: num(0, 'How fast the edge crawls, per second (animate on)', { min: 0, max: 20 }),
      color: color('#8a5a2a', 'Edge tint (rusty)'),
      tint: num(0.6, 'Strength of the edge tint (rusty)', { min: 0, max: 1 }),
    },
  },
  {
    type: 'boil',
    domain: 'layer',
    label: 'Line boil',
    family: 'Distort',
    tagline: 'Hand-drawn life — lines redraw themselves on their own frame rate, like cel animation.',
    fields: {
      ...clock(true),
      style: choice(['boil', 'wobble', 'jitter'], 'boil', 'boil: fine shimmer; wobble: soft jelly; jitter: scratchy chalk'),
      amount: num(2.5, 'How far lines wander, layer px (1–3 gentle, 6+ falling apart)', { min: 0, max: 200 }),
      scale: num(22, 'Size of the wiggles, layer px', { min: 2, max: 800 }),
      complexity: num(2, 'Layers of detail', { min: 1, max: 4, int: true }),
      variants: num(3, 'Drawings in the loop (0 never repeats)', { min: 0, max: 24, int: true }),
      shake: num(0, 'The whole drawing shifting, layer px', { min: 0, max: 100 }),
      rotate: num(0, 'The whole drawing turning, degrees', { min: 0, max: 30 }),
      mix: num(1, 'Strength of the whole card', { min: 0, max: 1 }),
    },
  },
  {
    type: 'glitch',
    domain: 'layer',
    label: 'Glitch',
    family: 'Distort',
    tagline: 'The signal failing — bands tear, channels split, blocks swap.',
    fields: {
      ...clock(true),
      mix: num(1, 'Strength of the whole card', { min: 0, max: 1 }),
      amount: num(0.5, 'How much of the picture tears', { min: 0, max: 1 }),
      blocks: num(14, 'Bands the picture is cut into', { min: 1, max: 120, int: true }),
      displace: num(48, 'How far a torn band slides, layer px', { min: 0, max: 1000 }),
      chroma: num(10, 'Channel split inside torn bands, layer px', { min: 0, max: 300 }),
      scramble: num(0.15, 'Odds a band shows another part of the picture', { min: 0, max: 1 }),
      colorShift: num(0.3, 'Odds a band changes colour', { min: 0, max: 1 }),
      direction: choice(['horizontal', 'vertical', 'both'], 'horizontal', 'Which way bands tear'),
      inside: flag(true, 'Only on the layer itself'),
    },
  },
  {
    type: 'colorGrade',
    domain: 'layer',
    label: 'Color grade',
    family: 'Color',
    tagline: 'A full grading node: wheels, balance, exposure, looks.',
    fields: {
      temperature: num(0, 'Cooler (negative) or warmer (positive)', { min: -100, max: 100 }),
      tint: num(0, 'Greener (negative) or more magenta (positive)', { min: -100, max: 100 }),
      exposure: num(0, 'Stops of light: +1 doubles it', { min: -4, max: 4 }),
      contrast: num(1, 'Contrast around mid grey', { min: 0, max: 2 }),
      saturation: num(1, 'Saturation', { min: 0, max: 2 }),
      vibrance: num(0, 'Saturation that spares colours already strong', { min: -1, max: 1 }),
      hueDeg: num(0, 'Hue rotation, degrees', { min: -180, max: 180 }),
      intensity: num(1, 'Strength of the whole grade', { min: 0, max: 1 }),
      liftR: num(0, 'Shadows: red', { min: -1, max: 1 }),
      liftG: num(0, 'Shadows: green', { min: -1, max: 1 }),
      liftB: num(0, 'Shadows: blue', { min: -1, max: 1 }),
      liftM: num(0, 'Shadows: all channels', { min: -1, max: 1 }),
      gammaR: num(0, 'Midtones: red', { min: -1, max: 1 }),
      gammaG: num(0, 'Midtones: green', { min: -1, max: 1 }),
      gammaB: num(0, 'Midtones: blue', { min: -1, max: 1 }),
      gammaM: num(0, 'Midtones: all channels', { min: -1, max: 1 }),
      gainR: num(0, 'Highlights: red', { min: -1, max: 1 }),
      gainG: num(0, 'Highlights: green', { min: -1, max: 1 }),
      gainB: num(0, 'Highlights: blue', { min: -1, max: 1 }),
      gainM: num(0, 'Highlights: all channels', { min: -1, max: 1 }),
    },
  },
  {
    type: 'gradientMap',
    domain: 'layer',
    label: 'Gradient map',
    family: 'Color',
    tagline: 'Remaps brightness onto a three-colour ramp — duotone, any look.',
    fields: {
      shadowColor: color('#12162e', 'Colour of the darks'),
      midColor: color('#7a4fd0', 'Colour of the mid tones'),
      highColor: color('#ffd28a', 'Colour of the lights'),
      midpoint: num(0.5, 'Where the mid colour sits', { min: 0.02, max: 0.98 }),
      contrast: num(1, 'Contrast before mapping', { min: 0, max: 4 }),
      brightness: num(0, 'Brightness before mapping', { min: -1, max: 1 }),
      mix: num(1, 'Strength of the whole card', { min: 0, max: 1 }),
      invert: flag(false, 'Map lights to darks'),
    },
  },
  {
    type: 'posterize',
    domain: 'layer',
    label: 'Posterize',
    family: 'Color',
    tagline: 'Quantises the layer to a few levels, with a dither that saves it.',
    fields: {
      levels: num(6, 'Levels per channel', { min: 2, max: 64, int: true }),
      dither: num(0, 'Ordered dither that hides the banding', { min: 0, max: 1 }),
      gamma: num(1, 'Where the levels fall: above 1 more in the darks', { min: 0.2, max: 4 }),
      mix: num(1, 'Strength of the whole card', { min: 0, max: 1 }),
      luminanceOnly: flag(false, 'Quantise brightness only, keeping the hues'),
    },
  },
  {
    type: 'overlay',
    domain: 'layer',
    label: 'Fill & gradient',
    family: 'Color',
    tagline: "Paints a colour or a ramp inside the layer's own shape.",
    fields: {
      mode: choice(['solid', 'linear', 'radial', 'conic'], 'linear', 'solid: colour A; linear, radial, conic: A to B'),
      colorA: color('#ffd166', 'First colour'),
      colorB: color('#ef476f', 'Second colour'),
      angle: num(90, 'Direction of a linear ramp, degrees (90 top to bottom)', { min: -180, max: 180 }),
      scale: num(1, 'Length of the ramp, in boxes', { min: 0.05, max: 8 }),
      offsetX: num(0, "Shifts the ramp across the box (box widths)", { min: -2, max: 2 }),
      offsetY: num(0, 'Shifts the ramp down the box (box heights)', { min: -2, max: 2 }),
      midpoint: num(0.5, 'Where the two colours meet half way', { min: 0.02, max: 0.98 }),
      repeat: num(1, 'Bands of the ramp', { min: 1, max: 16 }),
      opacity: num(1, 'Opacity of the paint', { min: 0, max: 1 }),
      blend: choice(EFFECT_BLENDS, 'source-over', 'How the paint mixes with the layer'),
      mirror: flag(false, 'Each repeat runs back again'),
      inside: flag(true, 'Only on the layer itself; off fills the whole box'),
    },
  },
  {
    type: 'chromaKey',
    domain: 'layer',
    label: 'Chroma key',
    family: 'Color',
    tagline: 'Keys out a flat backdrop — green screen, blue screen, studio white.',
    fields: {
      color: color('#00b140', 'The backdrop colour to remove'),
      tolerance: num(28, 'How far from the colour still keys out', { min: 0, max: 100 }),
      softness: num(14, 'Width of the soft edge past the tolerance', { min: 0, max: 100 }),
      spill: num(40, "Removes the backdrop's colour cast from the edges", { min: 0, max: 100 }),
      feather: num(0, 'Blur of the matte edge, px', { min: 0, max: 40 }),
      choke: num(0, 'Shrinks (positive) or grows (negative) the matte, px', { min: -20, max: 20 }),
      edgesOnly: flag(false, 'Show only the matte edges (a check)'),
      invert: flag(false, 'Keep the backdrop instead'),
    },
  },
  {
    type: 'halftone',
    domain: 'layer',
    label: 'Halftone',
    family: 'Stylize',
    tagline: 'Redraws the layer as ink on a grid — and lets the ink scatter.',
    fields: {
      shape: choice(['dot', 'line', 'square', 'cross', 'diamond'], 'dot', 'Ink shape'),
      size: num(12, 'Screen cell size, layer px', { min: 1, max: 400 }),
      angle: num(45, 'Screen angle, degrees', { min: -180, max: 180 }),
      softness: num(0.1, 'Softness of the ink edges', { min: 0, max: 1 }),
      contrast: num(1, 'Contrast before screening', { min: 0, max: 4 }),
      mode: choice(['mono', 'duotone', 'color', 'cmyk'], 'color', 'mono: ink on paper; duotone: ink colour; color: each cell its colour; cmyk: four screens'),
      inkColor: color('#101010', 'Ink colour (mono, duotone)'),
      paperColor: color('#f4f0e6', 'Paper colour (mono, duotone)'),
      jitter: num(0, 'Random shift of each cell, px', { min: 0, max: 400 }),
      spread: num(0, 'Ink scattering out of the cells, px', { min: 0, max: 2000 }),
      mix: num(1, 'Strength of the whole card', { min: 0, max: 1 }),
      invert: flag(false, 'Ink the lights instead of the darks'),
      inside: flag(true, 'Only on the layer itself'),
    },
  },
  {
    type: 'pixelate',
    domain: 'layer',
    label: 'Pixelate',
    family: 'Stylize',
    tagline: 'Resamples onto a coarse grid — mosaic, or an LED sign.',
    fields: {
      size: num(18, 'Cell size, layer px', { min: 1, max: 600 }),
      aspect: num(1, 'Cell width over height', { min: 0.1, max: 10 }),
      shape: choice(['square', 'dot', 'diamond', 'cross'], 'square', 'Cell shape (dot: an LED sign)'),
      gap: num(0, 'Space between cells, a fraction of the cell', { min: 0, max: 0.9 }),
      softness: num(0, 'Softness of the cell edges', { min: 0, max: 1 }),
      mix: num(1, 'Strength of the whole card', { min: 0, max: 1 }),
    },
  },
  {
    type: 'bevel',
    domain: 'layer',
    label: 'Bevel & emboss',
    family: 'Stylize',
    tagline: "Lights the layer's own edge as a slope — chisel, pillow, stamp.",
    fields: {
      style: choice(['inner', 'outer', 'pillow', 'emboss'], 'inner', 'inner: the edge rises inward; outer: outward; pillow: sinks at the rim; emboss: both'),
      depth: num(14, 'Width of the slope, layer px', { min: 0, max: 400 }),
      strength: num(1, 'Strength of the light and shade', { min: 0, max: 3 }),
      angle: num(-55, 'Direction the light comes from, degrees', { min: -180, max: 180 }),
      elevation: num(45, 'Height of the light, degrees', { min: 0, max: 90 }),
      softness: num(0.4, 'Rounds the slope', { min: 0, max: 1 }),
      highlightColor: color('#ffffff', 'Light colour'),
      highlightOpacity: num(0.8, 'Light strength', { min: 0, max: 1 }),
      shadowColor: color('#000000', 'Shade colour'),
      shadowOpacity: num(0.6, 'Shade strength', { min: 0, max: 1 }),
      highlightBlend: choice(EFFECT_BLENDS, 'screen', 'How the light mixes'),
      shadowBlend: choice(EFFECT_BLENDS, 'multiply', 'How the shade mixes'),
    },
  },
  {
    type: 'lightRays',
    domain: 'layer',
    label: 'Light rays',
    family: 'Light & Optics',
    tagline: "Volumetric shafts thrown off the layer's own bright areas.",
    fields: {
      centerX: num(0, "Where the rays come from, across the box: -1 left edge, 1 right edge", { min: -2, max: 2 }),
      centerY: num(0, 'Where the rays come from, down the box: -1 top edge, 1 bottom edge', { min: -2, max: 2 }),
      length: num(0.45, 'How far the rays reach, a fraction of the distance to the centre', { min: 0, max: 1 }),
      intensity: num(1, 'Brightness', { min: 0, max: 3 }),
      decay: num(1.1, 'How fast the rays fade along their length', { min: 0.1, max: 4 }),
      threshold: num(0.5, 'How bright a part must be to throw rays', { min: 0, max: 1 }),
      mode: choice(['auto', 'solid'], 'auto', "auto: the layer's own colours; solid: one colour"),
      color: color('#ffe9a8', 'Ray colour (solid)'),
      saturation: num(1.3, 'Colour boost of auto rays', { min: 0, max: 4 }),
      samples: num(28, 'Steps along each ray (more is smoother and slower)', { min: 4, max: 96, int: true }),
      blend: choice(EFFECT_BLENDS, 'lighter', 'How the rays mix'),
      behind: flag(false, 'Put the rays behind the layer'),
    },
  },
  {
    type: 'lensFlare',
    domain: 'layer',
    label: 'Lens flare',
    family: 'Light & Optics',
    tagline: "The camera's own answer to a bright point — streak, halo, ghosts.",
    fields: {
      centerX: num(-0.4, "The light's place across the box: -1 left edge, 1 right edge", { min: -3, max: 3 }),
      centerY: num(-0.3, "The light's place down the box: -1 top edge, 1 bottom edge", { min: -3, max: 3 }),
      brightness: num(1, 'Brightness', { min: 0, max: 3 }),
      size: num(280, 'Size of the glow, layer px', { min: 0, max: 4000 }),
      color: color('#ffe9c0', 'Light colour'),
      streak: num(0.7, 'Strength of the anamorphic streak', { min: 0, max: 1 }),
      streakColor: color('#6fb6ff', 'Streak colour'),
      streakAngle: num(0, 'Streak angle, degrees', { min: -180, max: 180 }),
      halo: num(0.45, 'Strength of the halo ring', { min: 0, max: 1 }),
      ghosts: num(5, 'Ghost discs along the axis', { min: 0, max: 12, int: true }),
      ghostSpread: num(0.75, 'How far the ghosts spread along the axis (negative: the other way)', { min: -2, max: 2 }),
      ghostChroma: num(0.6, 'Colour in the ghosts', { min: 0, max: 1 }),
      blend: choice(EFFECT_BLENDS, 'lighter', 'How the flare mixes'),
      inside: flag(false, 'Only on the layer itself'),
    },
  },
  {
    type: 'lightning',
    domain: 'layer',
    label: 'Lightning',
    family: 'Light & Optics',
    tagline: 'A live electric arc — between two points, along a path, or across a shape.',
    fields: {
      ...clock(true),
      position: num(0.5, 'Where a sweep of the arc is (with duration)', { min: -1, max: 2 }),
      duration: num(1.6, 'Seconds per sweep along the arc; 0 shows it whole', { min: 0, max: 120 }),
      delay: num(0, 'Seconds before each sweep', { min: 0, max: 120 }),
      loop: flag(true, 'Repeat the sweep'),
      mode: choice(['bolt', 'outline', 'fill', 'burst'], 'bolt', 'bolt: between two points; outline: crawling along the edge; fill: arcs inside the shape; burst: out from a centre'),
      ax: num(-0.8, 'Start (or burst centre) across the box', { min: -2, max: 2 }),
      ay: num(-0.6, 'Start (or burst centre) down the box', { min: -2, max: 2 }),
      bx: num(0.8, 'End across the box', { min: -2, max: 2 }),
      by: num(0.6, 'End down the box', { min: -2, max: 2 }),
      count: num(1, 'Arcs at once', { min: 1, max: 24, int: true }),
      span: num(1, 'How much of each arc shows at once', { min: 0.02, max: 1 }),
      offset: num(0, 'Shifts the shown part along the arc', { min: -2, max: 2 }),
      drift: num(0, 'How fast the shown part travels, arcs per second', { min: -4, max: 4 }),
      chaos: num(0.5, 'How jagged the arc is', { min: 0, max: 1 }),
      detail: num(6, 'Levels of jag', { min: 1, max: 9, int: true }),
      branches: num(5, 'Side branches', { min: 0, max: 24, int: true }),
      branchLength: num(0.4, 'Length of a branch, a fraction of the arc', { min: 0, max: 1 }),
      width: num(3, 'Core width, layer px', { min: 0, max: 60 }),
      taper: num(0.6, 'How thin the arc gets toward its end', { min: 0, max: 1 }),
      flicker: num(0.25, 'Brightness flicker', { min: 0, max: 1 }),
      coreColor: color('#ffffff', 'Colour of the hot core'),
      color: color('#8fc4ff', 'Colour of the glow'),
      glow: num(22, 'Glow around the arc, layer px', { min: 0, max: 300 }),
      intensity: num(1, 'Brightness', { min: 0, max: 3 }),
      blend: choice(EFFECT_BLENDS, 'lighter', 'How the arc mixes'),
      inside: flag(false, 'Only on the layer itself'),
    },
  },
  {
    type: 'glass',
    domain: 'layer',
    label: 'Liquid glass',
    family: 'Material',
    tagline: 'Refracts what is behind the layer — a real glass material.',
    fields: {
      refraction: num(0.8, 'How strongly the glass bends what is behind it', { min: 0, max: 1 }),
      depth: num(36, 'Width of the curved rim, layer px', { min: 0, max: 600 }),
      dispersion: num(0.35, 'Colour split in the bend', { min: 0, max: 1 }),
      frost: num(6, 'Blur of what is seen through, layer px', { min: 0, max: 200 }),
      lightAngle: num(-45, 'Direction of the rim light, degrees', { min: -180, max: 180 }),
      light: num(0.8, 'Strength of the rim light', { min: 0, max: 2 }),
      splay: num(0.35, 'How wide the rim light spreads', { min: 0, max: 1 }),
      lightColor: color('#ffffff', 'Rim light colour'),
      profile: choice(['squircle', 'circle', 'lip', 'concave'], 'squircle', 'Shape of the rim: squircle, circle, a raised lip, or concave'),
      ior: num(1.5, 'Index of refraction', { min: 1, max: 2.5 }),
      inset: num(0, 'Moves the glass edge in (positive) or out, layer px', { min: -200, max: 200 }),
      coverage: num(0.1, 'Least rim width, a fraction of the shorter side', { min: 0.02, max: 1 }),
      mix: num(1, 'Strength of the whole card', { min: 0, max: 1 }),
      paint: num(0.2, "How much of the layer's own colour shows in the glass", { min: 0, max: 1 }),
      tintColor: color('#ffffff', 'Tint colour'),
      tint: num(0, 'Strength of the tint', { min: 0, max: 1 }),
      saturation: num(1.08, 'Saturation of what is seen through', { min: 0, max: 3 }),
      brightness: num(1, 'Brightness of what is seen through', { min: 0, max: 3 }),
      noise: num(0, 'Uneven surface', { min: 0, max: 1 }),
      noiseScale: num(1, 'Size of the unevenness', { min: 0.1, max: 16 }),
      ripple: num(0, 'Ripples on the surface', { min: 0, max: 1 }),
      rippleScale: num(2, 'Size of the ripples', { min: 0.1, max: 16 }),
      ripplePhase: num(0, 'Where the ripples are in their cycle, degrees'),
      rippleSpeed: num(0, 'Ripple cycles per second', { min: -8, max: 8 }),
      quality: num(1, 'Resolution of the refraction (lower is faster)', { min: 0.25, max: 1 }),
      edgeOnly: flag(false, 'Bend only at the rim; the middle is flat'),
    },
  },
]

const textSource = {
  source: choice(['text', 'custom'], 'custom', "text takes each glyph's own colour; custom uses color"),
  color: color('#000000', 'Colour (source custom)'),
  opacity: num(1, '0 to 1', { min: 0, max: 1 }),
}

export const TEXT_EFFECTS: readonly EffectDef[] = [
  {
    type: 'shadow',
    domain: 'text',
    label: 'Shadow',
    family: 'Shadow & Glow',
    tagline: 'A cast shadow under every letter — offset and softened.',
    fields: { ...textSource, x: num(0, 'Offset right, px'), y: num(4, 'Offset down, px'), blur: num(8, 'Softness, px', { min: 0 }) },
  },
  {
    type: 'glow',
    domain: 'text',
    label: 'Glow',
    family: 'Shadow & Glow',
    tagline: "A halo around every letter — in the text's own colour by default.",
    fields: {
      ...textSource,
      source: choice(['text', 'custom'], 'text', "text takes each glyph's own colour; custom uses color"),
      radius: num(14, 'Spread, px', { min: 0 }),
      intensity: num(1, 'Strength', { min: 0.1, max: 4 }),
    },
  },
  {
    type: 'extrude',
    domain: 'text',
    label: 'Extrude',
    family: 'Depth & Trails',
    tagline: 'A solid face behind each letter — stepped copies, for 3D type.',
    fields: { ...textSource, angle: num(45, 'Direction of the depth, degrees: 0 right, 90 down'), length: num(20, 'Depth, px', { min: 0 }) },
  },
  {
    type: 'echo',
    domain: 'text',
    label: 'Echo',
    family: 'Depth & Trails',
    tagline: 'Fading copies trailing off each letter — motion, stacked, ghosted.',
    fields: {
      ...textSource,
      count: num(4, 'Copies', { min: 1, max: 12, int: true }),
      distance: num(8, 'Space between copies, px', { min: 0 }),
      angle: num(45, 'Direction of the trail, degrees'),
      fade: num(0.6, 'How much the far copies fade, 0 to 1', { min: 0, max: 1 }),
    },
  },
]

/**
 * AtomCut's card types this editor cannot draw yet, and the step that brings
 * them; asked for, they are refused with this instead of a bare "unknown".
 */
export const LATER_EFFECTS: Readonly<Record<string, string>> = Object.fromEntries([
  ['grade', 'phase E (colour grading: the node graph)'],
])

/** The families in the order the effect pickers list them. */
export const EFFECT_FAMILIES = ['Material', 'Film & Video', 'Shadow & Glow', 'Depth & Trails', 'Light & Optics', 'Blur & Sharpen', 'Color', 'Stylize', 'Distort'] as const

export const EFFECT_DOMAINS = ['layer', 'text'] as const

const LATER_DOMAINS: Readonly<Record<string, string>> = {
  audio: 'phase D (the audio chain)',
  geometry: 'A7 (3D worlds)',
  force: 'phase E (physics)',
}

export function effectDefs(domain: EffectDomain): readonly EffectDef[] {
  return domain === 'layer' ? LAYER_EFFECTS : TEXT_EFFECTS
}

export function findEffectDef(domain: EffectDomain, type: string): EffectDef | undefined {
  return effectDefs(domain).find((d) => d.type === type)
}

/** The step that brings a domain this editor lacks, or undefined. */
export function laterDomain(domain: string): string | undefined {
  return Object.hasOwn(LATER_DOMAINS, domain) ? LATER_DOMAINS[domain] : undefined
}

const HEX = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

/** One field's schema; `withDefault` false for inputs that merge into a card. */
export function fieldSchema(field: EffectField, withDefault = true): z.ZodType {
  let schema: z.ZodType
  switch (field.kind) {
    case 'number': {
      let n = field.int ? z.number().int() : z.number()
      if (field.min !== undefined) n = n.min(field.min)
      if (field.max !== undefined) n = n.max(field.max)
      schema = n
      break
    }
    case 'color':
      schema = z.string().regex(HEX, 'Use a hex colour such as #ff8800 or #ff880080')
      break
    case 'enum':
      schema = z.enum(field.options as [string, ...string[]])
      break
    case 'boolean':
      schema = z.boolean()
      break
  }
  schema = schema.describe(field.description)
  return withDefault ? (schema as z.ZodType<unknown>).default(field.default as never) : schema
}

function cardSchema(def: EffectDef) {
  return z.strictObject({
    id: z.string().min(1),
    enabled: z.boolean().default(true),
    type: z.literal(def.type),
    ...Object.fromEntries(Object.entries(def.fields).map(([key, field]) => [key, fieldSchema(field)])),
  })
}

function stackSchema(defs: readonly EffectDef[]) {
  const [first, ...rest] = defs.map(cardSchema)
  return z.discriminatedUnion('type', [first as ReturnType<typeof cardSchema>, ...rest]) as unknown as z.ZodType<Effect, Record<string, unknown>>
}

export const LayerEffectSchema = stackSchema(LAYER_EFFECTS)
export const TextEffectSchema = stackSchema(TEXT_EFFECTS)

/** A card's fields as a strict input with nothing required, for values that merge into it. */
export function valuesSchema(def: EffectDef) {
  return z.strictObject(Object.fromEntries(Object.entries(def.fields).map(([key, field]) => [key, fieldSchema(field, false).optional()])))
}

/** A new card of `def` with its defaults, then `values`. */
export function newEffect(def: EffectDef, id: string, values: Record<string, unknown> = {}): Effect {
  const card: Record<string, unknown> = { id, type: def.type, enabled: true }
  for (const [key, field] of Object.entries(def.fields)) card[key] = field.default
  return Object.assign(card, values) as Effect
}

/** The path prefix of a domain's keyable fields. */
export const EFFECT_PREFIX: Readonly<Record<EffectDomain, string>> = { layer: 'lfx', text: 'tfx' }

/** A number field of a card (0 when it is not a number). */
export function effectNumber(effect: Effect, key: string): number {
  const value = effect[key]
  return typeof value === 'number' ? value : 0
}
