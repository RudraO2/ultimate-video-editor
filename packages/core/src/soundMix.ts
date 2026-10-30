import { z } from 'zod'

// The mix: sound categories (buses) every sounding layer can be routed to,
// duck rules, and a frame's leveler, master fader and limiter. The shapes and
// defaults follow AtomCut's (see docs/research/atomcut-inspiration.md ▸ "The
// mix"); the engine turns them into gains (mixPlan.ts).

export const SOUND_CHARACTERS = ['voice', 'music', 'sfx', 'ambience'] as const
export type SoundCharacter = (typeof SOUND_CHARACTERS)[number]

/** What a duck rule listens to: every layer on a bus, or one layer (and what is nested inside it). */
export const DuckSourceSchema = z.strictObject({
  kind: z.enum(['bus', 'clip']).default('bus'),
  id: z.string().min(1).describe('A category id (kind bus) or a layer id (kind clip)'),
})

export const DuckRuleSchema = z.strictObject({
  id: z.string().min(1),
  enabled: z.boolean().default(true),
  under: DuckSourceSchema.describe('Ducks while this sounds'),
  depthDb: z.number().min(0).max(60).default(12).describe('How far it dips, dB'),
  attackMs: z.number().min(0).max(5000).default(150).describe('How long the dip takes; it starts this early, so the first word is already ducked'),
  releaseMs: z.number().min(0).max(10000).default(500).describe('How long it takes to come back'),
})

export const SoundCategorySchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  character: z.enum(SOUND_CHARACTERS).default('sfx').describe('How the leveler hears it: voice, music, sfx, ambience'),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#ffb86c'),
  volume: z.number().min(0).max(4).default(1).describe('Linear fader, 1 = 0 dB'),
  muted: z.boolean().default(false),
  solo: z.boolean().default(false),
  ducking: z.array(DuckRuleSchema).default([]),
  targetLufs: z.number().min(-40).max(-6).nullable().default(null).describe("The leveler's target; null: the character's (voice −16, music −20, sfx −19, ambience −28)"),
  builtIn: z.boolean().default(false),
})

export const LevelerSchema = z.strictObject({
  enabled: z.boolean().default(true),
  mode: z.enum(['category', 'all']).default('category').describe("category: each bus to its own target; all: everything to −18 LUFS"),
  strength: z.number().min(0).max(1).default(0.8),
  tameLoud: z.boolean().default(true).describe('Turn down sounds above their target'),
  liftQuiet: z.boolean().default(false).describe('Turn up sounds below their target'),
  evenSpeech: z.boolean().default(true).describe('A gentle compressor on speech buses'),
})

export const LimiterSchema = z.strictObject({
  enabled: z.boolean().default(true),
  ceilingDb: z.number().min(-12).max(0).default(-1).describe('No sample of the mix goes above this, dBFS'),
})

export const LoudnessSchema = z.strictObject({
  enabled: z.boolean().default(true).describe('Measure the whole mix and set one master trim so it lands on the target (never more than the limiter can hold)'),
  targetLufs: z.number().min(-30).max(-6).default(-14).describe('Integrated loudness the mix is brought to, LUFS (−14 streaming, −16 podcast)'),
})

export const SoundMixSchema = z.strictObject({
  volume: z.number().min(0).max(4).default(1).describe('Master fader, 1 = 0 dB'),
  leveler: LevelerSchema.prefault({}),
  loudness: LoudnessSchema.prefault({}),
  limiter: LimiterSchema.prefault({}),
})

export type DuckRule = z.infer<typeof DuckRuleSchema>
export type DuckSource = z.infer<typeof DuckSourceSchema>
export type SoundCategory = z.infer<typeof SoundCategorySchema>
export type SoundMix = z.infer<typeof SoundMixSchema>

/** The leveler's target per character, LUFS, when a bus names none. */
export const CHARACTER_TARGET_LUFS: Readonly<Record<SoundCharacter, number>> = { voice: -16, music: -20, sfx: -19, ambience: -28 }
/** The target of everything in leveler mode "all", and of unrouted sound. */
export const ALL_TARGET_LUFS = -18

/** Colours of new custom categories, in turn. */
export const CATEGORY_PALETTE = ['#ff6b8b', '#f1fa8c', '#8be9fd', '#ff9e64', '#bd93f9', '#50fa7b', '#e0af68', '#7dcfff'] as const

/** The four categories every project has; they cannot be deleted. New projects duck music under dialogue. */
export function builtInCategories(): SoundCategory[] {
  const bus = (id: string, name: string, character: SoundCharacter, color: string, ducking: DuckRule[] = []): SoundCategory =>
    SoundCategorySchema.parse({ id, name, character, color, ducking, builtIn: true })
  return [
    bus('voice', 'Dialogue', 'voice', '#7aa2ff'),
    bus('music', 'Music', 'music', '#c792ea', [DuckRuleSchema.parse({ id: 'duck_music_voice', under: { kind: 'bus', id: 'voice' }, depthDb: 10, attackMs: 150, releaseMs: 500 })]),
    bus('sfx', 'Effects', 'sfx', '#ffb86c'),
    bus('ambience', 'Ambience', 'ambience', '#5fd3a6'),
  ]
}

export const BUILT_IN_CATEGORY_IDS = ['voice', 'music', 'sfx', 'ambience'] as const

/** `categories` with any missing built-in added (in built-in order, before the custom ones). */
export function withBuiltIns(categories: readonly SoundCategory[]): SoundCategory[] {
  const missing = builtInCategories().filter((b) => !categories.some((c) => c.id === b.id))
  if (missing.length === 0) return [...categories]
  return [...missing, ...categories]
}

/** The leveler's target for a bus. */
export function categoryTarget(category: Pick<SoundCategory, 'character' | 'targetLufs'>): number {
  return category.targetLufs ?? CHARACTER_TARGET_LUFS[category.character]
}

/** The category a media file is tagged with on import, from its name (AtomCut's patterns); null when nothing matches. */
export function categoryForFileName(name: string): string | null {
  const base = name.toLowerCase().replace(/^.*[\\/]/, '')
  if (/voice|(^|[\W_])vo([\W_]|$)|narrat|speech|dialog/.test(base)) return 'voice'
  if (/music|song|bgm|beat/.test(base)) return 'music'
  if (/ambien|atmos|rain/.test(base)) return 'ambience'
  if (/sfx|whoosh|click|hit|impact/.test(base)) return 'sfx'
  return null
}

/** Reads a duck source given as a bus id string or as `{kind, id}` (AtomCut accepts both). */
export const DuckSourceInputSchema = z.union([z.string().min(1).transform((id) => ({ kind: 'bus' as const, id })), DuckSourceSchema])
