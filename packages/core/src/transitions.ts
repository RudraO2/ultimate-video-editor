import type { Easing, EasingPreset, Layer, Track, Transition } from './schema'
import { ease } from './easing'

// Transitions on cuts: between two abutting layers on a lane (a seam), or on
// a lone layer's head or tail. The presets (ids, labels, categories, default
// durations and easings, knobs) follow AtomCut's 23 (preset data); how each
// one moves and mixes the two sides is ours.

/** How one side of a cut is shown at a moment of a transition. */
export interface TransitionPose {
  opacity: number
  /** Offset as fractions of the comp's width and height. */
  dx: number
  dy: number
  scale: number
  /** Degrees, clockwise. */
  rotation: number
  /** Blur, px. */
  blur: number
}

/** A shape that reveals the incoming side: inside it B shows, outside A. Coordinates are fractions of the pair's box. */
export type TransitionWipe =
  | { kind: 'linear'; angleDeg: number; progress: number; softness: number }
  | { kind: 'circle'; cx: number; cy: number; progress: number; softness: number; invert?: boolean }
  | { kind: 'clock'; cx: number; cy: number; startDeg: number; progress: number; softness: number; blades: 1 | 2 }
  | { kind: 'barn'; angleDeg: number; progress: number; softness: number }

export interface TransitionMix {
  a: TransitionPose
  b: TransitionPose
  wipe: TransitionWipe | null
  /** The transition's colour laid over both sides, 0 to 1 (dips and flashes). */
  veil: number
  /** Sideways tears and knocks: band shifts in fractions of the width (glitch), or a shake offset. */
  tear?: { amount: number; seed: number }
}

export interface TransitionParam {
  key: string
  label: string
  min: number
  max: number
  step: number
  defaultValue: number
}

export type TransitionAudio = 'equal-power' | 'dip' | 'linear'

export interface TransitionPreset {
  id: string
  label: string
  tagline: string
  category: 'dissolve' | 'wipe' | 'motion' | 'stylize'
  audio: TransitionAudio
  /** Uses the transition's colour (dips and flashes). */
  usesColor?: boolean
  defaultColor?: string
  /** On a lone head or tail the colour does the work: the side dips from it (head) or into it (tail). */
  splitAtCut?: boolean
  defaultDurationMs: number
  defaultEasing: EasingPreset
  params: readonly TransitionParam[]
  mix(p: number, params: Readonly<Record<string, number>>): TransitionMix
}

export const REST: TransitionPose = { opacity: 1, dx: 0, dy: 0, scale: 1, rotation: 0, blur: 0 }
const pose = (fields: Partial<TransitionPose>): TransitionPose => ({ ...REST, ...fields })
const both = (a: Partial<TransitionPose>, b: Partial<TransitionPose>): TransitionMix => ({ a: pose(a), b: pose(b), wipe: null, veil: 0 })
const wiped = (wipe: TransitionWipe): TransitionMix => ({ a: REST, b: REST, wipe, veil: 0 })
/** 0 at both ends of the transition, 1 in its middle. */
const peak = (p: number) => 1 - Math.abs(2 * p - 1)
const toward = (deg: number) => ({ x: Math.cos((deg * Math.PI) / 180), y: Math.sin((deg * Math.PI) / 180) })

const angle = (defaultValue = 180, label = 'Direction'): TransitionParam => ({ key: 'angle', label, min: 0, max: 360, step: 1, defaultValue })
const softness = (defaultValue = 12): TransitionParam => ({ key: 'softness', label: 'Softness', min: 0, max: 100, step: 1, defaultValue })
const travel = (defaultValue = 100): TransitionParam => ({ key: 'distance', label: 'Travel %', min: 0, max: 200, step: 1, defaultValue })
const centre = (key: 'cx' | 'cy', label: string): TransitionParam => ({ key, label, min: 0, max: 100, step: 1, defaultValue: 50 })
const knob = (key: string, label: string, min: number, max: number, defaultValue: number, step = 1): TransitionParam => ({ key, label, min, max, step, defaultValue })

/** A knob's value, or its default. */
const get = (params: Readonly<Record<string, number>>, key: string, fallback: number) => (typeof params[key] === 'number' ? (params[key] as number) : fallback)

export const TRANSITION_PRESETS: readonly TransitionPreset[] = [
  {
    id: 'cross-dissolve',
    label: 'Cross Dissolve',
    tagline: 'Both frames mixed through the cut',
    category: 'dissolve',
    audio: 'equal-power',
    defaultDurationMs: 600,
    defaultEasing: 'linear',
    params: [],
    mix: (p) => both({}, { opacity: p }),
  },
  {
    id: 'fade',
    label: 'Fade',
    tagline: 'A leaves before B arrives',
    category: 'dissolve',
    audio: 'equal-power',
    defaultDurationMs: 500,
    defaultEasing: 'ease-in-out',
    params: [],
    mix: (p) => both({ opacity: Math.max(0, 1 - p * 2) }, { opacity: Math.max(0, p * 2 - 1) }),
  },
  {
    id: 'dip-to-color',
    label: 'Dip to Colour',
    tagline: 'Through black (or any colour)',
    category: 'dissolve',
    audio: 'dip',
    usesColor: true,
    defaultColor: '#000000',
    splitAtCut: true,
    defaultDurationMs: 700,
    defaultEasing: 'ease-in-out',
    params: [],
    mix: (p) => ({ ...both({ opacity: p < 0.5 ? 1 : 0 }, { opacity: p < 0.5 ? 0 : 1 }), veil: peak(p) }),
  },
  {
    id: 'blur-dissolve',
    label: 'Blur Dissolve',
    tagline: 'Defocus through the mix',
    category: 'dissolve',
    audio: 'equal-power',
    defaultDurationMs: 700,
    defaultEasing: 'ease-in-out',
    params: [knob('blur', 'Blur', 0, 80, 24)],
    mix: (p, k) => both({ blur: p * get(k, 'blur', 24) }, { opacity: p, blur: (1 - p) * get(k, 'blur', 24) }),
  },
  {
    id: 'additive-dissolve',
    label: 'Additive Dissolve',
    tagline: 'Blooms bright through the middle',
    category: 'dissolve',
    audio: 'equal-power',
    defaultDurationMs: 700,
    defaultEasing: 'linear',
    params: [knob('bloom', 'Bloom', 0, 100, 55)],
    mix: (p, k) => {
      const bloom = (get(k, 'bloom', 55) / 100) * peak(p)
      return both({ opacity: Math.min(1, 1 - p + bloom) }, { opacity: Math.min(1, p + bloom) })
    },
  },
  {
    id: 'soft-dissolve',
    label: 'Soft Dissolve',
    tagline: 'Defocuses only as it hands over',
    category: 'dissolve',
    audio: 'equal-power',
    defaultDurationMs: 800,
    defaultEasing: 'ease-in-out',
    params: [knob('blur', 'Softness', 0, 60, 14)],
    mix: (p, k) => {
      const blur = get(k, 'blur', 14) * peak(p)
      return both({ opacity: 1 - p, blur }, { opacity: p, blur })
    },
  },
  {
    id: 'linear-wipe',
    label: 'Wipe',
    tagline: 'A straight edge sweeps B in',
    category: 'wipe',
    audio: 'equal-power',
    defaultDurationMs: 600,
    defaultEasing: 'ease-in-out',
    params: [angle(), softness()],
    mix: (p, k) => wiped({ kind: 'linear', angleDeg: get(k, 'angle', 180), progress: p, softness: get(k, 'softness', 12) }),
  },
  {
    id: 'iris',
    label: 'Iris',
    tagline: 'Circle opens onto the next shot',
    category: 'wipe',
    audio: 'equal-power',
    defaultDurationMs: 650,
    defaultEasing: 'ease-in-out',
    params: [centre('cx', 'Centre X'), centre('cy', 'Centre Y'), softness()],
    mix: (p, k) => wiped({ kind: 'circle', cx: get(k, 'cx', 50) / 100, cy: get(k, 'cy', 50) / 100, progress: p, softness: get(k, 'softness', 12) }),
  },
  {
    id: 'clock-wipe',
    label: 'Clock Wipe',
    tagline: 'Radial sweep around the centre',
    category: 'wipe',
    audio: 'equal-power',
    defaultDurationMs: 700,
    defaultEasing: 'linear',
    params: [angle(270, 'Start'), softness(2)],
    mix: (p, k) => wiped({ kind: 'clock', cx: 0.5, cy: 0.5, startDeg: get(k, 'angle', 270), progress: p, softness: get(k, 'softness', 2), blades: 1 }),
  },
  {
    id: 'barn-door',
    label: 'Barn Door',
    tagline: 'Splits open from the middle',
    category: 'wipe',
    audio: 'equal-power',
    defaultDurationMs: 650,
    defaultEasing: 'ease-in-out',
    params: [angle(), softness()],
    mix: (p, k) => wiped({ kind: 'barn', angleDeg: get(k, 'angle', 180), progress: p, softness: get(k, 'softness', 12) }),
  },
  {
    id: 'iris-close',
    label: 'Iris Close',
    tagline: 'Circle shuts down onto the next shot',
    category: 'wipe',
    audio: 'equal-power',
    defaultDurationMs: 650,
    defaultEasing: 'ease-in-out',
    params: [centre('cx', 'Centre X'), centre('cy', 'Centre Y'), softness()],
    // A circle of A closing over B: B shows outside it.
    mix: (p, k) => wiped({ kind: 'circle', cx: get(k, 'cx', 50) / 100, cy: get(k, 'cy', 50) / 100, progress: 1 - p, softness: get(k, 'softness', 12), invert: true }),
  },
  {
    id: 'wedge-wipe',
    label: 'Wedge',
    tagline: 'Two blades sweep round from the centre',
    category: 'wipe',
    audio: 'equal-power',
    defaultDurationMs: 750,
    defaultEasing: 'linear',
    params: [angle(270, 'Start'), softness(2)],
    mix: (p, k) => wiped({ kind: 'clock', cx: 0.5, cy: 0.5, startDeg: get(k, 'angle', 270), progress: p, softness: get(k, 'softness', 2), blades: 2 }),
  },
  {
    id: 'push',
    label: 'Push',
    tagline: 'B shoves A off the frame',
    category: 'motion',
    audio: 'equal-power',
    defaultDurationMs: 550,
    defaultEasing: 'ease-in-out',
    params: [angle(), travel()],
    mix: (p, k) => {
      const d = toward(get(k, 'angle', 180))
      const far = get(k, 'distance', 100) / 100
      return both({ dx: -d.x * p * far, dy: -d.y * p * far }, { dx: d.x * (1 - p) * far, dy: d.y * (1 - p) * far })
    },
  },
  {
    id: 'slide',
    label: 'Slide Over',
    tagline: 'B slides across a static A',
    category: 'motion',
    audio: 'equal-power',
    defaultDurationMs: 550,
    defaultEasing: 'ease-out-expo',
    params: [angle(), travel()],
    mix: (p, k) => {
      const d = toward(get(k, 'angle', 180))
      const far = get(k, 'distance', 100) / 100
      return both({}, { dx: d.x * (1 - p) * far, dy: d.y * (1 - p) * far })
    },
  },
  {
    id: 'slide-apart',
    label: 'Slide Apart',
    tagline: 'A exits, B enters behind it',
    category: 'motion',
    audio: 'equal-power',
    defaultDurationMs: 600,
    defaultEasing: 'ease-in-out',
    params: [angle(), travel(60)],
    mix: (p, k) => {
      const d = toward(get(k, 'angle', 180))
      const far = get(k, 'distance', 60) / 100
      return both(
        { opacity: Math.max(0, 1 - p * 2), dx: -d.x * p * far, dy: -d.y * p * far },
        { opacity: Math.max(0, p * 2 - 1), dx: d.x * (1 - p) * far, dy: d.y * (1 - p) * far },
      )
    },
  },
  {
    id: 'whip-pan',
    label: 'Whip Pan',
    tagline: 'Fast push with directional smear',
    category: 'motion',
    audio: 'equal-power',
    defaultDurationMs: 420,
    defaultEasing: 'ease-in-out',
    params: [angle(), knob('blur', 'Smear', 0, 120, 48)],
    // The smear itself comes from motion blur: the push is fast enough that the shutter streaks it.
    mix: (p, k) => {
      const d = toward(get(k, 'angle', 180))
      const blur = get(k, 'blur', 48) * peak(p) * 0.25
      return both({ dx: -d.x * p, dy: -d.y * p, blur }, { dx: d.x * (1 - p), dy: d.y * (1 - p), blur })
    },
  },
  {
    id: 'zoom',
    label: 'Zoom',
    tagline: 'Punch through into the next shot',
    category: 'motion',
    audio: 'equal-power',
    defaultDurationMs: 500,
    defaultEasing: 'ease-in-out',
    params: [knob('amount', 'Amount', 0, 200, 60), knob('blur', 'Blur', 0, 80, 18)],
    mix: (p, k) => {
      const amount = get(k, 'amount', 60) / 100
      const blur = get(k, 'blur', 18) * peak(p)
      return both({ scale: 1 + amount * p, blur }, { opacity: p, scale: 1 - amount * (1 - p), blur })
    },
  },
  {
    id: 'roll',
    label: 'Roll',
    tagline: 'Tumbles over into the next shot',
    category: 'motion',
    audio: 'equal-power',
    defaultDurationMs: 620,
    defaultEasing: 'ease-in-out',
    params: [angle(), knob('turns', 'Rotation', 15, 360, 75, 5)],
    mix: (p, k) => {
      const d = toward(get(k, 'angle', 180))
      const turn = get(k, 'turns', 75)
      return both(
        { dx: -d.x * p, dy: -d.y * p, rotation: turn * p, scale: 1 - 0.15 * p },
        { dx: d.x * (1 - p), dy: d.y * (1 - p), rotation: -turn * (1 - p), scale: 1 - 0.15 * (1 - p) },
      )
    },
  },
  {
    id: 'pop',
    label: 'Pop',
    tagline: 'A shrinks away, B springs in',
    category: 'stylize',
    audio: 'equal-power',
    defaultDurationMs: 550,
    defaultEasing: 'ease-in-out',
    params: [knob('amount', 'Amount', 0, 100, 55)],
    mix: (p, k) => {
      const amount = get(k, 'amount', 55) / 100
      return both({ opacity: Math.max(0, 1 - p * 2), scale: 1 - amount * p }, { opacity: Math.max(0, p * 2 - 1), scale: 1 - amount * (1 - p) })
    },
  },
  {
    id: 'spin',
    label: 'Spin',
    tagline: 'Rotates out and back in',
    category: 'stylize',
    audio: 'equal-power',
    defaultDurationMs: 650,
    defaultEasing: 'ease-in-out',
    params: [knob('turns', 'Rotation', 15, 720, 90, 5)],
    mix: (p, k) => {
      const turn = get(k, 'turns', 90)
      return both(
        { opacity: Math.max(0, 1 - p * 2), rotation: turn * p, scale: 1 - 0.35 * p },
        { opacity: Math.max(0, p * 2 - 1), rotation: -turn * (1 - p), scale: 1 - 0.35 * (1 - p) },
      )
    },
  },
  {
    id: 'dip-to-white',
    label: 'Flash',
    tagline: 'Blows out to white and back',
    category: 'stylize',
    audio: 'equal-power',
    usesColor: true,
    defaultColor: '#ffffff',
    splitAtCut: true,
    defaultDurationMs: 380,
    defaultEasing: 'ease-out',
    params: [],
    mix: (p) => ({ ...both({}, { opacity: p }), veil: peak(p) ** 0.6 }),
  },
  {
    id: 'glitch-cut',
    label: 'Glitch',
    tagline: 'Tears sideways through the join',
    category: 'stylize',
    audio: 'equal-power',
    defaultDurationMs: 340,
    defaultEasing: 'linear',
    params: [knob('amount', 'Displace', 0, 100, 45)],
    // B cuts in at the middle; around it bands tear sideways, most at the join.
    mix: (p, k) => ({
      ...both({ opacity: p < 0.5 ? 1 : 0 }, { opacity: p < 0.5 ? 0 : 1 }),
      tear: { amount: (get(k, 'amount', 45) / 100) * peak(p) * 0.25, seed: Math.floor(p * 12) },
    }),
  },
  {
    id: 'shake-cut',
    label: 'Shake',
    tagline: 'Knocks the frame across the cut',
    category: 'stylize',
    audio: 'equal-power',
    defaultDurationMs: 420,
    defaultEasing: 'linear',
    params: [knob('amount', 'Travel', 0, 100, 30), knob('cycles', 'Cycles', 1, 12, 5)],
    mix: (p, k) => {
      // A damped knock: strongest at the cut, side to side `cycles` times.
      const amount = (get(k, 'amount', 30) / 100) * 0.12 * peak(p)
      const swing = Math.sin(p * Math.PI * 2 * get(k, 'cycles', 5)) * amount
      const knock = { dx: swing, dy: swing * 0.35 }
      return both({ ...knock, opacity: p < 0.5 ? 1 : 0 }, { ...knock, opacity: p < 0.5 ? 0 : 1 })
    },
  },
]

export function findTransitionPreset(id: string): TransitionPreset | undefined {
  return TRANSITION_PRESETS.find((p) => p.id === id)
}

/** A preset's knobs at their defaults. */
export function defaultTransitionParams(preset: TransitionPreset): Record<string, number> {
  return Object.fromEntries(preset.params.map((p) => [p.key, p.defaultValue]))
}

/** Gains of the outgoing and incoming sound at progress p through a transition. */
export function transitionGains(audio: TransitionAudio, p: number): { a: number; b: number } {
  const t = Math.min(1, Math.max(0, p))
  if (audio === 'linear') return { a: 1 - t, b: t }
  if (audio === 'dip') return { a: Math.max(0, 1 - 2 * t), b: Math.max(0, 2 * t - 1) }
  return { a: Math.cos((t * Math.PI) / 2), b: Math.sin((t * Math.PI) / 2) }
}

/** Where a transition's cut is, and its window of comp time: [cut − split, cut + duration − split]. */
export interface TransitionWindow {
  transition: Transition
  preset: TransitionPreset
  a: Layer | null
  b: Layer | null
  cutMs: number
  startMs: number
  endMs: number
}

/** Layers whose edges meet within this many ms abut. */
export const CUT_TOLERANCE_MS = 1

const layerEndMs = (layer: Layer) => layer.startMs + layer.durationMs

/** A track's transitions that still fit their layers (a seam's layers must still abut), with their windows. */
export function transitionWindows(track: Track): TransitionWindow[] {
  const byId = new Map(track.layers.map((l) => [l.id, l]))
  const windows: TransitionWindow[] = []
  for (const transition of track.transitions) {
    const preset = findTransitionPreset(transition.preset)
    const a = transition.aLayerId ? (byId.get(transition.aLayerId) ?? null) : null
    const b = transition.bLayerId ? (byId.get(transition.bLayerId) ?? null) : null
    if (!preset || (!a && !b) || (transition.aLayerId && !a) || (transition.bLayerId && !b)) continue
    if (a && b && Math.abs(layerEndMs(a) - b.startMs) > CUT_TOLERANCE_MS) continue
    const cutMs = a ? layerEndMs(a) : (b as Layer).startMs
    const split = Math.min(transition.splitMs, transition.durationMs)
    windows.push({ transition, preset, a, b, cutMs, startMs: cutMs - split, endMs: cutMs + transition.durationMs - split })
  }
  return windows
}

/** One side of a transition at a moment: how it is posed, and the time it is drawn at (frozen past its own span). */
export interface TransitionSide {
  window: TransitionWindow
  role: 'a' | 'b'
  /** Eased progress through the transition, 0 to 1. */
  progress: number
  mix: TransitionMix
  pose: TransitionPose
  /** The comp time to draw the layer at: its own, or its last (A) or first (B) moment while it is shown past its span. */
  drawAtMs: number
  color: string
}

/** The mix of a window at eased progress p; a lone side of a colour dip uses half the dip (into it, or out of it). */
export function windowMix(window: TransitionWindow, p: number): TransitionMix {
  const { preset, transition, a, b } = window
  if (!preset.splitAtCut || (a && b)) return preset.mix(p, transition.params)
  const half = preset.mix(a ? p / 2 : 0.5 + p / 2, transition.params)
  return { ...half, a: { ...half.a, opacity: 1 }, b: { ...half.b, opacity: 1 } }
}

/** Eases linear progress through a transition. */
export function transitionProgress(easing: Easing, linear: number): number {
  return ease(easing, Math.min(1, Math.max(0, linear)))
}

/** The sides of transitions on a track at a comp time, by layer id. */
export function transitionSides(track: Track, timeMs: number): Map<string, TransitionSide> {
  const sides = new Map<string, TransitionSide>()
  for (const window of transitionWindows(track)) {
    if (timeMs < window.startMs || timeMs >= window.endMs) continue
    const span = window.endMs - window.startMs
    const progress = transitionProgress(window.transition.easing, span > 0 ? (timeMs - window.startMs) / span : 1)
    const mix = windowMix(window, progress)
    const color = window.transition.color ?? window.preset.defaultColor ?? '#000000'
    if (window.a) {
      const drawAtMs = Math.min(timeMs, layerEndMs(window.a) - CUT_TOLERANCE_MS)
      sides.set(window.a.id, { window, role: 'a', progress, mix, pose: mix.a, drawAtMs, color })
    }
    if (window.b) {
      const drawAtMs = Math.max(timeMs, window.b.startMs)
      sides.set(window.b.id, { window, role: 'b', progress, mix, pose: mix.b, drawAtMs, color })
    }
  }
  return sides
}
