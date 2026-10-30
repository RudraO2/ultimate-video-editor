import { z } from 'zod'

// A voice of a layer's sounds stack (see sounds.ts for when it fires).

/** The built-in packs: AtomCut's six, synthesised (no files), and `keys`, recorded keypresses. */
export const SOUND_PACK_IDS = ['mechanical', 'soft', 'vintage', 'thock', 'digital', 'pop', 'keys'] as const
export type SoundPackId = (typeof SOUND_PACK_IDS)[number]

export const SOUND_TRIGGERS = ['text', 'layer', 'transition'] as const

export const SoundVoiceSchema = z
  .strictObject({
    id: z.string().min(1),
    enabled: z.boolean().default(true),
    pack: z
      .enum(SOUND_PACK_IDS)
      .nullable()
      .default(null)
      .describe('A built-in pack: synthesised mechanical, soft, vintage, thock, digital, pop (each at its own level: mechanical and digital are quiet ticks, thock and pop loud), or keys (recorded keypresses)'),
    custom: z
      .strictObject({
        assetId: z.string().min(1).describe('A media asset with sound'),
        hitMs: z.number().min(0).default(0).describe("Where the file's hit is, ms from its start: lined up with the moment"),
      })
      .nullable()
      .default(null)
      .describe('Any other sound: a media asset (sounds.use returns this)'),
    volume: z.number().min(0).max(1).default(0.32),
    pitch: z.number().min(0.5).max(2).default(1),
    randomness: z
      .number()
      .min(0)
      .max(1)
      .default(0.6)
      .describe('Varies each hit, so repeats do not sound stamped: volume down by up to 65 % and pitch by up to ±17.5 %, times this; never the timing'),
    phase: z.enum(['in', 'out']).default('in').describe('The entrance or the exit'),
    trigger: z
      .strictObject({ kind: z.enum(SOUND_TRIGGERS) })
      .prefault({ kind: 'text' })
      .describe('text: every unit of the text animation; layer: the whole-layer animation; transition: the transition on its cut'),
    anchor: z.enum(['start', 'peak', 'end']).default('start').describe("Which moment of each unit's motion the hit lands on"),
    offsetMs: z.number().min(-2000).max(2000).default(0).describe('Moves every hit earlier (negative) or later'),
  })
  .refine((v) => (v.pack === null) !== (v.custom === null), { message: 'A sound needs either pack or custom (not both)' })

export type SoundVoice = z.infer<typeof SoundVoiceSchema>
