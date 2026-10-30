import type { AnimationUnit, Easing } from './schema'

// The 44 animation presets of AtomCut's library: ids, labels, defaults and
// knobs are AtomCut's preset data (ported with permission); the pose of each
// is our own formula, written to move as AtomCut's does.

/** How one unit (or a whole layer) sits relative to its rest, at one moment. */
export interface Pose {
  opacity: number
  /** Offset, px (a text unit: in the layer's own space; a whole layer: in its parent's). */
  dx: number
  dy: number
  scale: number
  /** Degrees, clockwise. */
  rotation: number
  /** Gaussian blur radius, px. */
  blur: number
}

export const REST_POSE: Readonly<Pose> = Object.freeze({ opacity: 1, dx: 0, dy: 0, scale: 1, rotation: 0, blur: 0 })

export const ANIMATION_CATEGORIES = ['fade', 'slide', 'scale', 'spin', 'bounce', 'type', 'draw', 'stylize'] as const
export type AnimationCategory = (typeof ANIMATION_CATEGORIES)[number]

export interface AnimationParam {
  key: string
  label: string
  min: number
  max: number
  step: number
  defaultValue: number
  /** A choice: the value of each option. */
  options?: { value: number; label: string }[]
  unit?: string
  hint?: string
}

export interface AnimationPreset {
  id: string
  category: AnimationCategory
  /** What it can animate: text per unit, a whole layer, or both. */
  scope: 'text' | 'layer' | 'both'
  label: string
  tagline: string
  defaultUnit: AnimationUnit
  defaultDurationMs: number
  defaultStaggerMs: number
  defaultJitterMs?: number
  defaultEasing: Easing
  params: AnimationParam[]
  /** The pose at eased progress `p` (0 hidden or far, 1 at rest) of an entrance. */
  pose(p: number, params: Readonly<Record<string, number>>): Pose
  /** An exit of its own at eased progress `p` (0 at rest, 1 gone); without it an exit plays the entrance backwards. */
  poseOut?(p: number, params: Readonly<Record<string, number>>): Pose
  /** Draws strokes on instead of moving (needs an outline). */
  drawOn?: true
}

const posed = (fields: Partial<Pose>): Pose => ({ ...REST_POSE, ...fields })
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
/** Fades in faster than the move: fully visible once `rate * p` reaches 1. */
const fadeBy = (p: number, rate: number) => Math.min(1, rate * p)
/** A scale that grows from `fromPercent` to 1. */
const grow = (fromPercent: number, p: number) => fromPercent / 100 + (1 - fromPercent / 100) * p
/** A wobble that dies out: `cycles` half-turns, damped by `decay`, gone at p = 1. */
const wobble = (p: number, cycles: number, decay: number) => Math.sin(p * Math.PI * cycles) * Math.exp(-decay * p) * (1 - p)
/** A damped swing that starts at full amplitude (cosine), gone at p = 1. */
const swingOut = (p: number, damping: number) => Math.exp(-damping * p) * Math.cos(p * Math.PI * 3) * (1 - p)

/** A repeatable pseudo-random number in [0, 1) for step `n` of a stream. */
function noise(n: number, stream: number): number {
  let h = Math.imul(n + 1, 0x27d4eb2d) ^ Math.imul(stream + 7, 0x165667b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca77)
  h ^= h >>> 13
  return (h >>> 0) / 4294967296
}

/** A light that stutters on: about a third of its steps dark, steady from 86 %. */
function flicker(p: number, steps: number): number {
  if (p > 0.86) return 1
  const step = Math.floor(p * steps)
  return noise(step, 1) < 1 / 3 ? 0 : Math.min(1, 1.4 * p)
}

/** A jolt in [-1, 1) that holds for each of `steps` steps. */
const jolt = (p: number, steps: number, stream: number) => noise(Math.floor(p * steps), stream) * 2 - 1

/** A fall that lands at 0.4 and bounces three times, each lower (height 1 = the drop). */
function bounceFall(p: number): number {
  if (p < 0.4) return 1 - (p / 0.4) ** 2
  const hop = (from: number, length: number, height: number) => height * Math.sin(((p - from) / length) * Math.PI)
  if (p < 0.72) return hop(0.4, 0.32, 0.28)
  if (p < 0.92) return hop(0.72, 0.2, 0.1)
  return hop(0.92, 0.08, 0.03)
}

const param = (key: string, label: string, min: number, max: number, defaultValue: number, step = 1): AnimationParam => ({ key, label, min, max, step, defaultValue })
const get = (params: Readonly<Record<string, number>>, key: string, fallback: number) => params[key] ?? fallback

export const ANIMATION_PRESETS: readonly AnimationPreset[] = [
  {
    id: 'typewriter',
    category: 'type',
    scope: 'text',
    label: 'Typewriter',
    tagline: 'Instant per-character reveal',
    defaultUnit: 'letter',
    defaultDurationMs: 1,
    defaultStaggerMs: 60,
    defaultJitterMs: 55,
    defaultEasing: 'linear',
    params: [],
    pose: (p) => posed({ opacity: p > 0 ? 1 : 0 }),
    poseOut: (p) => posed({ opacity: p >= 1 ? 0 : 1 }),
  },
  {
    id: 'fade-up',
    category: 'fade',
    scope: 'both',
    label: 'Fade Up',
    tagline: 'Soft rise with fade',
    defaultUnit: 'word',
    defaultDurationMs: 450,
    defaultStaggerMs: 90,
    defaultEasing: 'ease-out-quart',
    params: [param('distance', 'Distance', 0, 200, 36)],
    pose: (p, k) => posed({ opacity: p, dy: (1 - p) * get(k, 'distance', 36) }),
  },
  {
    id: 'blur-in',
    category: 'fade',
    scope: 'both',
    label: 'Blur In',
    tagline: 'Focus pull into place',
    defaultUnit: 'word',
    defaultDurationMs: 550,
    defaultStaggerMs: 110,
    defaultEasing: 'ease-out',
    params: [param('blur', 'Blur', 0, 60, 18)],
    pose: (p, k) => posed({ opacity: p, blur: (1 - p) * get(k, 'blur', 18) }),
  },
  {
    id: 'slide-down',
    category: 'slide',
    scope: 'both',
    label: 'Slide Down',
    tagline: 'Drop in from above',
    defaultUnit: 'letter',
    defaultDurationMs: 400,
    defaultStaggerMs: 40,
    defaultEasing: 'ease-out-expo',
    params: [param('distance', 'Distance', 0, 300, 60)],
    pose: (p, k) => posed({ opacity: fadeBy(p, 2), dy: -(1 - p) * get(k, 'distance', 60) }),
  },
  {
    id: 'pop-in',
    category: 'scale',
    scope: 'both',
    label: 'Pop In',
    tagline: 'Scale up with overshoot',
    defaultUnit: 'word',
    defaultDurationMs: 500,
    defaultStaggerMs: 100,
    defaultEasing: 'ease-out-back',
    params: [param('from', 'Start scale %', 0, 100, 40)],
    pose: (p, k) => posed({ opacity: fadeBy(p, 2.5), scale: grow(get(k, 'from', 40), p) }),
  },
  {
    id: 'bounce-in',
    category: 'bounce',
    scope: 'both',
    label: 'Bounce In',
    tagline: 'Springy rise',
    defaultUnit: 'letter',
    defaultDurationMs: 600,
    defaultStaggerMs: 50,
    defaultEasing: 'ease-out-elastic',
    params: [param('distance', 'Distance', 0, 200, 44)],
    pose: (p, k) => posed({ opacity: fadeBy(p, 3), dy: (1 - p) * get(k, 'distance', 44) }),
  },
  {
    id: 'wave',
    category: 'type',
    scope: 'text',
    label: 'Wave',
    tagline: 'Letters ripple up',
    defaultUnit: 'letter',
    defaultDurationMs: 500,
    defaultStaggerMs: 35,
    defaultEasing: 'ease-in-out',
    params: [param('height', 'Height', 0, 120, 28)],
    pose: (p, k) => posed({ opacity: p, dy: -Math.sin(Math.min(p, 1) * Math.PI) * get(k, 'height', 28) * (1 - p) }),
  },
  {
    id: 'flip-up',
    category: 'spin',
    scope: 'both',
    label: 'Flip Up',
    tagline: 'Tilt up into place',
    defaultUnit: 'letter',
    defaultDurationMs: 450,
    defaultStaggerMs: 45,
    defaultEasing: 'ease-out-back',
    params: [param('angle', 'Angle', 0, 180, 70)],
    pose: (p, k) => posed({ opacity: fadeBy(p, 2), rotation: (1 - p) * get(k, 'angle', 70), scale: 0.7 + 0.3 * p }),
  },
  {
    id: 'fade',
    category: 'fade',
    scope: 'both',
    label: 'Fade',
    tagline: 'Simple opacity fade',
    defaultUnit: 'word',
    defaultDurationMs: 400,
    defaultStaggerMs: 80,
    defaultEasing: 'ease-in-out',
    params: [],
    pose: (p) => posed({ opacity: p }),
  },
  {
    id: 'slide-left',
    category: 'slide',
    scope: 'both',
    label: 'Slide Left',
    tagline: 'Enter from the right',
    defaultUnit: 'word',
    defaultDurationMs: 450,
    defaultStaggerMs: 80,
    defaultEasing: 'ease-out-expo',
    params: [param('distance', 'Distance', 0, 300, 60)],
    pose: (p, k) => posed({ opacity: fadeBy(p, 2), dx: (1 - p) * get(k, 'distance', 60) }),
  },
  {
    id: 'slide-right',
    category: 'slide',
    scope: 'both',
    label: 'Slide Right',
    tagline: 'Enter from the left',
    defaultUnit: 'word',
    defaultDurationMs: 450,
    defaultStaggerMs: 80,
    defaultEasing: 'ease-out-expo',
    params: [param('distance', 'Distance', 0, 300, 60)],
    pose: (p, k) => posed({ opacity: fadeBy(p, 2), dx: -(1 - p) * get(k, 'distance', 60) }),
  },
  {
    id: 'zoom-out',
    category: 'scale',
    scope: 'both',
    label: 'Zoom Out',
    tagline: 'Shrink down from large',
    defaultUnit: 'word',
    defaultDurationMs: 500,
    defaultStaggerMs: 90,
    defaultEasing: 'ease-out-quart',
    params: [param('from', 'Start scale %', 100, 400, 170)],
    pose: (p, k) => posed({ opacity: p, scale: grow(get(k, 'from', 170), p) }),
  },
  {
    id: 'spin-in',
    category: 'spin',
    scope: 'both',
    label: 'Spin In',
    tagline: 'Rotate into place',
    defaultUnit: 'word',
    defaultDurationMs: 550,
    defaultStaggerMs: 90,
    defaultEasing: 'ease-out-back',
    params: [param('turns', 'Rotation', 0, 720, 120)],
    pose: (p, k) => posed({ opacity: fadeBy(p, 2), rotation: -(1 - p) * get(k, 'turns', 120), scale: 0.5 + 0.5 * p }),
  },
  {
    id: 'whip',
    category: 'stylize',
    scope: 'both',
    label: 'Whip',
    tagline: 'Fast streak in with blur',
    defaultUnit: 'word',
    defaultDurationMs: 350,
    defaultStaggerMs: 60,
    defaultEasing: 'ease-out-expo',
    params: [param('distance', 'Distance', 0, 400, 120), param('blur', 'Blur', 0, 40, 12)],
    pose: (p, k) => posed({ opacity: fadeBy(p, 3), dx: (1 - p) * get(k, 'distance', 120), blur: (1 - p) * get(k, 'blur', 12) }),
  },
  {
    id: 'drift',
    category: 'slide',
    scope: 'layer',
    label: 'Drift',
    tagline: 'Slow cinematic settle',
    defaultUnit: 'line',
    defaultDurationMs: 1200,
    defaultStaggerMs: 0,
    defaultEasing: 'ease-in-out',
    params: [param('distance', 'Distance', 0, 200, 28), param('zoom', 'Start scale %', 100, 140, 106)],
    pose: (p, k) => posed({ opacity: p, dy: (1 - p) * get(k, 'distance', 28), scale: grow(get(k, 'zoom', 106), p) }),
  },
  {
    id: 'fade-down',
    category: 'fade',
    scope: 'both',
    label: 'Fade Down',
    tagline: 'Soft drop with fade',
    defaultUnit: 'word',
    defaultDurationMs: 450,
    defaultStaggerMs: 90,
    defaultEasing: 'ease-out-quart',
    params: [param('distance', 'Distance', 0, 200, 36)],
    pose: (p, k) => posed({ opacity: p, dy: -(1 - p) * get(k, 'distance', 36) }),
  },
  {
    id: 'soft-focus',
    category: 'fade',
    scope: 'both',
    label: 'Soft Focus',
    tagline: 'Dreamy blur and settle',
    defaultUnit: 'line',
    defaultDurationMs: 900,
    defaultStaggerMs: 0,
    defaultEasing: 'ease-in-out',
    params: [param('blur', 'Blur', 0, 80, 26), param('from', 'Start scale %', 100, 140, 108)],
    pose: (p, k) => posed({ opacity: fadeBy(p, 1.6), blur: (1 - p) * get(k, 'blur', 26), scale: grow(get(k, 'from', 108), p) }),
  },
  {
    id: 'slide-up',
    category: 'slide',
    scope: 'both',
    label: 'Slide Up',
    tagline: 'Rise in from below',
    defaultUnit: 'letter',
    defaultDurationMs: 400,
    defaultStaggerMs: 40,
    defaultEasing: 'ease-out-expo',
    params: [param('distance', 'Distance', 0, 300, 60)],
    pose: (p, k) => posed({ opacity: fadeBy(p, 2), dy: (1 - p) * get(k, 'distance', 60) }),
  },
  {
    id: 'fly-in',
    category: 'slide',
    scope: 'both',
    label: 'Fly In',
    tagline: 'Diagonal swoop',
    defaultUnit: 'word',
    defaultDurationMs: 550,
    defaultStaggerMs: 70,
    defaultEasing: 'ease-out-expo',
    params: [param('x', 'From X', -400, 400, -160), param('y', 'From Y', -400, 400, 120)],
    pose: (p, k) => posed({ opacity: fadeBy(p, 2), dx: (1 - p) * get(k, 'x', -160), dy: (1 - p) * get(k, 'y', 120) }),
  },
  {
    id: 'nudge',
    category: 'slide',
    scope: 'both',
    label: 'Nudge',
    tagline: 'Subtle UI rise',
    defaultUnit: 'line',
    defaultDurationMs: 260,
    defaultStaggerMs: 40,
    defaultEasing: 'ease-out-quart',
    params: [param('distance', 'Distance', 0, 40, 10)],
    pose: (p, k) => posed({ opacity: fadeBy(p, 2.5), dy: (1 - p) * get(k, 'distance', 10) }),
  },
  {
    id: 'slide-through',
    category: 'slide',
    scope: 'both',
    label: 'Slide Through',
    tagline: 'In from the right, out to the left',
    defaultUnit: 'word',
    defaultDurationMs: 500,
    defaultStaggerMs: 70,
    defaultEasing: 'ease-in-out',
    params: [param('distance', 'Distance', 0, 400, 140)],
    pose: (p, k) => posed({ opacity: fadeBy(p, 2), dx: (1 - p) * get(k, 'distance', 140) }),
    poseOut: (p, k) => posed({ opacity: Math.max(0, 1 - 1.6 * p), dx: -p * get(k, 'distance', 140) }),
  },
  {
    id: 'scale-in',
    category: 'scale',
    scope: 'both',
    label: 'Scale In',
    tagline: 'Grow from nothing',
    defaultUnit: 'letter',
    defaultDurationMs: 420,
    defaultStaggerMs: 40,
    defaultEasing: 'ease-out-quart',
    params: [param('from', 'Start scale %', 0, 100, 0)],
    pose: (p, k) => posed({ opacity: fadeBy(p, 3), scale: grow(get(k, 'from', 0), p) }),
  },
  {
    id: 'punch',
    category: 'scale',
    scope: 'both',
    label: 'Punch',
    tagline: 'Slam down from big',
    defaultUnit: 'word',
    defaultDurationMs: 320,
    defaultStaggerMs: 50,
    defaultEasing: 'ease-out-expo',
    params: [param('from', 'Start scale %', 100, 400, 190), param('blur', 'Blur', 0, 40, 14)],
    pose: (p, k) => posed({ opacity: fadeBy(p, 3), scale: grow(get(k, 'from', 190), p), blur: (1 - p) * get(k, 'blur', 14) }),
  },
  {
    id: 'grow',
    category: 'scale',
    scope: 'both',
    label: 'Grow',
    tagline: 'Gentle scale up',
    defaultUnit: 'line',
    defaultDurationMs: 700,
    defaultStaggerMs: 60,
    defaultEasing: 'ease-in-out',
    params: [param('from', 'Start scale %', 50, 100, 92)],
    pose: (p, k) => posed({ opacity: p, scale: grow(get(k, 'from', 92), p) }),
  },
  {
    id: 'roll-in',
    category: 'spin',
    scope: 'both',
    label: 'Roll In',
    tagline: 'Rolls in from the side',
    defaultUnit: 'word',
    defaultDurationMs: 700,
    defaultStaggerMs: 80,
    defaultEasing: 'ease-out-quart',
    params: [param('distance', 'Distance', 0, 600, 180), param('turns', 'Rotation', 0, 1080, 360)],
    pose: (p, k) => posed({ opacity: fadeBy(p, 3), dx: -(1 - p) * get(k, 'distance', 180), rotation: -(1 - p) * get(k, 'turns', 360) }),
  },
  {
    id: 'swing',
    category: 'spin',
    scope: 'both',
    label: 'Swing',
    tagline: 'Rocks back and forth to rest',
    defaultUnit: 'word',
    defaultDurationMs: 900,
    defaultStaggerMs: 90,
    defaultEasing: 'linear',
    params: [param('angle', 'Angle', 0, 90, 24)],
    pose: (p, k) => posed({ opacity: fadeBy(p, 4), rotation: wobble(p, 3, 2.2) * get(k, 'angle', 24) }),
  },
  {
    id: 'flip-down',
    category: 'spin',
    scope: 'both',
    label: 'Flip Down',
    tagline: 'Tilt down into place',
    defaultUnit: 'letter',
    defaultDurationMs: 450,
    defaultStaggerMs: 45,
    defaultEasing: 'ease-out-back',
    params: [param('angle', 'Angle', 0, 180, 70)],
    pose: (p, k) => posed({ opacity: fadeBy(p, 2), rotation: -(1 - p) * get(k, 'angle', 70), scale: 0.7 + 0.3 * p }),
  },
  {
    id: 'drop',
    category: 'bounce',
    scope: 'both',
    label: 'Drop',
    tagline: 'Falls and bounces',
    defaultUnit: 'letter',
    defaultDurationMs: 800,
    defaultStaggerMs: 55,
    defaultEasing: 'linear',
    params: [param('distance', 'Distance', 0, 400, 120)],
    pose: (p, k) => posed({ opacity: fadeBy(p, 5), dy: -bounceFall(p) * get(k, 'distance', 120) }),
  },
  {
    id: 'rubber',
    category: 'bounce',
    scope: 'both',
    label: 'Rubber',
    tagline: 'Elastic scale wobble',
    defaultUnit: 'word',
    defaultDurationMs: 750,
    defaultStaggerMs: 70,
    defaultEasing: 'linear',
    params: [param('amount', 'Amount %', 0, 80, 26)],
    pose: (p, k) => posed({ opacity: fadeBy(p, 5), scale: 1 + wobble(p, 3, 2.6) * (get(k, 'amount', 26) / 100) }),
  },
  {
    id: 'cascade',
    category: 'type',
    scope: 'text',
    label: 'Cascade',
    tagline: 'Letters tumble down',
    defaultUnit: 'letter',
    defaultDurationMs: 520,
    defaultStaggerMs: 45,
    defaultEasing: 'ease-out-back',
    params: [param('distance', 'Distance', 0, 300, 80), param('tilt', 'Tilt', 0, 90, 20)],
    pose: (p, k) => posed({ opacity: fadeBy(p, 2.5), dy: -(1 - p) * get(k, 'distance', 80), rotation: (1 - p) * get(k, 'tilt', 20) }),
  },
  {
    id: 'ripple',
    category: 'type',
    scope: 'text',
    label: 'Ripple',
    tagline: 'A swell runs through',
    defaultUnit: 'letter',
    defaultDurationMs: 600,
    defaultStaggerMs: 30,
    defaultEasing: 'ease-in-out',
    params: [param('amount', 'Swell %', 0, 120, 45)],
    pose: (p, k) => posed({ opacity: fadeBy(p, 3), scale: 1 + Math.sin(Math.min(p, 1) * Math.PI) * (get(k, 'amount', 45) / 100) * (1 - p) }),
  },
  {
    id: 'flicker-on',
    category: 'stylize',
    scope: 'both',
    label: 'Flicker On',
    tagline: 'Neon stutter',
    defaultUnit: 'letter',
    defaultDurationMs: 700,
    defaultStaggerMs: 40,
    defaultEasing: 'linear',
    params: [param('steps', 'Flickers', 4, 30, 14)],
    pose: (p, k) => posed({ opacity: flicker(p, Math.round(get(k, 'steps', 14))) }),
  },
  {
    id: 'glitch',
    category: 'stylize',
    scope: 'both',
    label: 'Glitch',
    tagline: 'Digital jitter in',
    defaultUnit: 'letter',
    defaultDurationMs: 550,
    defaultStaggerMs: 30,
    defaultEasing: 'linear',
    params: [param('distance', 'Distance', 0, 120, 44), param('steps', 'Steps', 4, 30, 12)],
    pose: (p, k) => {
      const steps = Math.round(get(k, 'steps', 12))
      const distance = get(k, 'distance', 44)
      return posed({ opacity: flicker(p, steps), dx: jolt(p, steps, 2) * distance * (1 - p), dy: jolt(p, steps, 3) * distance * 0.25 * (1 - p) })
    },
  },
  {
    id: 'strobe',
    category: 'stylize',
    scope: 'both',
    label: 'Strobe',
    tagline: 'Hard blinks to on',
    defaultUnit: 'word',
    defaultDurationMs: 600,
    defaultStaggerMs: 60,
    defaultEasing: 'linear',
    params: [param('pulses', 'Pulses', 2, 12, 5)],
    pose: (p, k) => {
      const pulses = Math.max(1, Math.round(get(k, 'pulses', 5)))
      // Each pulse is lit for a longer part of itself as the strobe settles.
      return posed({ opacity: (p * pulses) % 1 < 0.35 + 0.65 * p ? fadeBy(p, 1.5) : 0 })
    },
  },
  {
    id: 'smear',
    category: 'stylize',
    scope: 'both',
    label: 'Smear',
    tagline: 'Motion-blurred slide',
    defaultUnit: 'line',
    defaultDurationMs: 600,
    defaultStaggerMs: 0,
    defaultEasing: 'ease-out-expo',
    params: [param('blur', 'Blur', 0, 80, 40), param('distance', 'Distance', 0, 200, 30)],
    pose: (p, k) => posed({ opacity: fadeBy(p, 2), blur: (1 - p) * get(k, 'blur', 40), dx: (1 - p) * get(k, 'distance', 30) }),
  },
  {
    id: 'unblur-up',
    category: 'fade',
    scope: 'both',
    label: 'Unblur Up',
    tagline: 'Rise out of focus',
    defaultUnit: 'line',
    defaultDurationMs: 620,
    defaultStaggerMs: 70,
    defaultEasing: 'ease-out-quart',
    params: [param('distance', 'Distance', 0, 200, 44), param('blur', 'Blur', 0, 40, 12)],
    pose: (p, k) => posed({ opacity: fadeBy(p, 2), dy: (1 - p) * get(k, 'distance', 44), blur: (1 - p) ** 3 * get(k, 'blur', 12) }),
  },
  {
    id: 'fade-through',
    category: 'fade',
    scope: 'both',
    label: 'Fade Through',
    tagline: 'Hold dark, then fade in',
    defaultUnit: 'word',
    defaultDurationMs: 520,
    defaultStaggerMs: 40,
    defaultEasing: 'ease-in-out',
    params: [param('hold', 'Hold %', 0, 90, 25)],
    pose: (p, k) => {
      const from = 0.5 + get(k, 'hold', 25) / 200
      return posed({ opacity: p < from ? 0 : (p - from) / (1 - from) })
    },
  },
  {
    id: 'slide-stagger',
    category: 'slide',
    scope: 'both',
    label: 'Slide Stagger',
    tagline: 'Long slide with a tilt',
    defaultUnit: 'word',
    defaultDurationMs: 480,
    defaultStaggerMs: 110,
    defaultEasing: 'ease-out-expo',
    params: [param('distance', 'Distance', 0, 600, 220), param('tilt', 'Tilt', 0, 45, 8)],
    pose: (p, k) => posed({ opacity: fadeBy(p, 2.5), dx: -(1 - p) * get(k, 'distance', 220), rotation: -(1 - p) * get(k, 'tilt', 8) }),
  },
  {
    id: 'settle',
    category: 'bounce',
    scope: 'both',
    label: 'Settle',
    tagline: 'Drops and settles with a spring',
    defaultUnit: 'word',
    defaultDurationMs: 720,
    defaultStaggerMs: 60,
    defaultEasing: 'linear',
    params: [param('distance', 'Distance', 0, 300, 90), param('damping', 'Damping', 1, 12, 5, 0.5)],
    pose: (p, k) => posed({ opacity: fadeBy(p, 4), dy: swingOut(p, get(k, 'damping', 5)) * get(k, 'distance', 90) }),
  },
  {
    id: 'breathe',
    category: 'scale',
    scope: 'both',
    label: 'Breathe',
    tagline: 'Soft swell into place',
    defaultUnit: 'line',
    defaultDurationMs: 900,
    defaultStaggerMs: 90,
    defaultEasing: 'ease-out-quart',
    params: [param('from', 'Start scale %', 50, 100, 82)],
    pose: (p, k) => posed({ opacity: fadeBy(p, 1.6), scale: grow(get(k, 'from', 82), p) }),
  },
  {
    id: 'pendulum',
    category: 'spin',
    scope: 'both',
    label: 'Pendulum',
    tagline: 'Swings in and settles',
    defaultUnit: 'word',
    defaultDurationMs: 820,
    defaultStaggerMs: 70,
    defaultEasing: 'linear',
    params: [param('angle', 'Angle', 0, 90, 35), param('damping', 'Damping', 1, 12, 4, 0.5)],
    pose: (p, k) => posed({ opacity: fadeBy(p, 4), rotation: swingOut(p, get(k, 'damping', 4)) * get(k, 'angle', 35) }),
  },
  {
    id: 'shutter',
    category: 'stylize',
    scope: 'both',
    label: 'Shutter',
    tagline: 'Opacity in hard steps',
    defaultUnit: 'word',
    defaultDurationMs: 420,
    defaultStaggerMs: 50,
    defaultEasing: 'linear',
    params: [param('steps', 'Steps', 2, 12, 5)],
    pose: (p, k) => {
      const steps = Math.max(2, Math.round(get(k, 'steps', 5)))
      return posed({ opacity: Math.ceil(p * steps) / steps })
    },
  },
  {
    id: 'trace',
    category: 'type',
    scope: 'text',
    label: 'Trace',
    tagline: 'Quick rise, letter by letter',
    defaultUnit: 'letter',
    defaultDurationMs: 260,
    defaultStaggerMs: 34,
    defaultEasing: 'ease-out',
    params: [param('rise', 'Rise', 0, 60, 10)],
    pose: (p, k) => posed({ opacity: p, dy: (1 - p) * get(k, 'rise', 10) }),
  },
  {
    id: 'draw',
    category: 'draw',
    scope: 'layer',
    label: 'Draw',
    tagline: 'Strokes draw themselves on',
    defaultUnit: 'line',
    defaultDurationMs: 900,
    defaultStaggerMs: 0,
    defaultEasing: 'ease-in-out',
    params: [
      {
        ...param('order', 'Order', 0, 2, 1),
        options: [
          { value: 0, label: 'Together' },
          { value: 1, label: 'One by one' },
          { value: 2, label: 'Staggered' },
        ],
      },
      { ...param('stagger', 'Stagger', 0, 1, 0.5, 0.05), hint: 'Staggered: how much of each piece waits for the one before' },
      {
        ...param('topFirst', 'Pieces', 0, 1, 0),
        options: [
          { value: 0, label: 'Bottom first' },
          { value: 1, label: 'Top first' },
        ],
      },
      { ...param('origin', 'Start point', 0, 1, 0, 0.01), hint: 'Where along each outline the line starts (0 to 1)' },
      {
        ...param('direction', 'Direction', 0, 2, 0),
        options: [
          { value: 0, label: 'Forward' },
          { value: 1, label: 'Backward' },
          { value: 2, label: 'Both ways' },
        ],
      },
      {
        ...param('fill', 'Fill', 0, 2, 2),
        options: [
          { value: 0, label: 'Keep' },
          { value: 1, label: 'Fade along' },
          { value: 2, label: 'Fade late' },
        ],
      },
      {
        ...param('pen', 'Pen width', 0, 12, 2, 0.5),
        unit: 'px',
        hint: 'For a layer with no stroke of its own: its silhouette is inked at this width while it draws.',
      },
    ],
    pose: () => ({ ...REST_POSE }),
    drawOn: true,
  },
]

const BY_ID = new Map(ANIMATION_PRESETS.map((p) => [p.id, p]))

export function findAnimationPreset(id: string): AnimationPreset | undefined {
  return BY_ID.get(id)
}

/** A preset's knobs at their defaults. */
export function defaultParams(preset: AnimationPreset): Record<string, number> {
  return Object.fromEntries(preset.params.map((p) => [p.key, p.defaultValue]))
}

export { clamp01 }
