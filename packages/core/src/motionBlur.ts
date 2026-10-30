import { z } from 'zod'

// Motion blur: a shutter that stays open for part of each frame. A comp has
// the master settings (`motionBlur`, on by default as in AtomCut); each layer
// can switch it off or override the shutter. Settings, ranges, defaults and
// the presets follow AtomCut's (preset data); the sampling is ours.

export const MOTION_BLUR_WEIGHTINGS = ['box', 'ease', 'trail', 'lead'] as const
export const MOTION_BLUR_SAMPLINGS = ['velocity', 'transform', 'content'] as const
export const MOTION_BLUR_COMBINES = ['average', 'add', 'screen', 'max'] as const

export const MotionBlurSettingsSchema = z.strictObject({
  shutterAngle: z.number().min(0).max(720).default(180).describe('How long the shutter stays open, in degrees of a frame: 180 is half a frame, 360 a whole one'),
  shutterPhase: z.number().min(-360).max(360).default(-90).describe('When it opens, in degrees from the frame time: -90 centres a 180° shutter on it'),
  weighting: z
    .enum(MOTION_BLUR_WEIGHTINGS)
    .default('box')
    .describe('How the moments in the shutter count: box evenly, ease most in the middle, trail the latest most (a tail behind), lead the earliest most (a smear ahead)'),
  sampling: z
    .enum(MOTION_BLUR_SAMPLINGS)
    .default('transform')
    .describe('velocity: one straight smear along the motion (fast); transform: the layer placed at each moment (exact for arcs and spins); content: the layer drawn anew at each moment, so changes inside it blur too'),
  combine: z.enum(MOTION_BLUR_COMBINES).default('average').describe('How the moments are mixed: average, add (light trails), screen, max'),
  strength: z.number().min(0).max(1).default(1).describe('Mix of the blurred picture over the sharp one'),
  amount: z.number().min(0).max(4).default(1).describe('Stretches the shutter beyond the physical, for exaggerated smears'),
  maxSamples: z.number().int().min(2).max(64).default(16).describe('Most moments drawn per frame; fewer are used for slow motion'),
})

export const CompMotionBlurSchema = MotionBlurSettingsSchema.extend({
  enabled: z.boolean().default(true).describe('The master switch for every layer in the comp'),
})

export const LayerMotionBlurSchema = z.strictObject({
  enabled: z.boolean().default(true).describe("Blur this layer when it moves (and the comp's master switch is on)"),
  override: MotionBlurSettingsSchema.nullable().default(null).describe("This layer's own shutter; null uses the comp's"),
})

export type MotionBlurSettings = z.infer<typeof MotionBlurSettingsSchema>
export type CompMotionBlur = z.infer<typeof CompMotionBlurSchema>
export type LayerMotionBlur = z.infer<typeof LayerMotionBlurSchema>

export const DEFAULT_MOTION_BLUR: MotionBlurSettings = MotionBlurSettingsSchema.parse({})

export interface MotionBlurPreset {
  id: string
  label: string
  tagline: string
  settings: Partial<MotionBlurSettings>
}

/** AtomCut's shutter presets. */
export const MOTION_BLUR_PRESETS: readonly MotionBlurPreset[] = [
  { id: 'film', label: 'Film 180°', tagline: 'The standard cinema shutter', settings: {} },
  { id: 'crisp', label: 'Crisp 90°', tagline: 'Half the exposure — sharper, snappier', settings: { shutterAngle: 90, shutterPhase: -45 } },
  {
    id: 'long',
    label: 'Long exposure',
    tagline: 'A full frame of light, added rather than averaged',
    settings: { shutterAngle: 360, shutterPhase: -180, combine: 'add', weighting: 'ease' },
  },
  {
    id: 'comet',
    label: 'Comet trail',
    tagline: 'Weighted into the past — the layer drags a tail',
    settings: { shutterAngle: 540, shutterPhase: -540, weighting: 'trail', combine: 'screen', strength: 0.85 },
  },
  {
    id: 'anticipate',
    label: 'Anticipation',
    tagline: 'Weighted ahead — the smear arrives before the layer',
    settings: { shutterAngle: 360, shutterPhase: 0, weighting: 'lead', strength: 0.8 },
  },
  {
    id: 'whip',
    label: 'Whip pan',
    tagline: 'Exaggerated far past physical, for fast cuts',
    settings: { shutterAngle: 720, shutterPhase: -360, amount: 2, weighting: 'ease', maxSamples: 32 },
  },
  {
    id: 'ghost',
    label: 'Ghosting',
    tagline: 'Deliberately under-sampled — discrete echoes, not a smear',
    settings: { shutterAngle: 360, shutterPhase: -180, maxSamples: 5, combine: 'screen', strength: 0.9 },
  },
]

/** A preset's full settings. */
export function motionBlurPreset(id: string): MotionBlurSettings | undefined {
  const preset = MOTION_BLUR_PRESETS.find((p) => p.id === id)
  return preset ? { ...DEFAULT_MOTION_BLUR, ...preset.settings } : undefined
}

/** The comp times the shutter is open for the frame at `timeMs`: [open, close]. */
export function shutterWindow(settings: MotionBlurSettings, timeMs: number, fps: number): [open: number, close: number] {
  const frameMs = 1000 / fps
  const open = timeMs + (settings.shutterPhase / 360) * frameMs * settings.amount
  return [open, open + (settings.shutterAngle / 360) * frameMs * settings.amount]
}

/** How much the moment at `u` (0 the shutter opening, 1 its closing) counts. */
export function shutterWeight(weighting: MotionBlurSettings['weighting'], u: number): number {
  switch (weighting) {
    case 'ease':
      return 0.1 + Math.sin(Math.PI * u)
    case 'trail':
      return 0.1 + u
    case 'lead':
      return 1.1 - u
    default:
      return 1
  }
}

/** `count` moments evenly through the shutter, with their weights (summing to 1). */
export function shutterSamples(settings: MotionBlurSettings, timeMs: number, fps: number, count: number): { timeMs: number; weight: number }[] {
  const [open, close] = shutterWindow(settings, timeMs, fps)
  const n = Math.max(2, count)
  const raw = Array.from({ length: n }, (_, k) => {
    const u = k / (n - 1)
    return { timeMs: open + u * (close - open), weight: shutterWeight(settings.weighting, u) }
  })
  const total = raw.reduce((sum, s) => sum + s.weight, 0)
  return raw.map((s) => ({ timeMs: s.timeMs, weight: s.weight / total }))
}
