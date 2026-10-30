// How finished each pack of the CC0 sound library sounds, so search ranks
// sounds made for motion and clean recordings above game sounds, and keeps
// chiptune and voices out unless a query asks for them. Sorted by listening
// and by measuring every file (docs/research/atomcut-inspiration.md ▸ "Why the
// Q9 launch film's effects sounded cheap").

/**
 * `motion`: made for motion design (AtomCut's own packs, our synthesised ones).
 * `foley`: clean recordings of real things and plain interface sounds.
 * `game`: designed for games (fantasy, RPG, sci-fi, lasers, jingles): fine for a playful piece, cheap in a polished one.
 * `retro`: chiptune, 8- and 16-bit. `voice`: people, creatures and monsters.
 */
export type SoundQuality = 'motion' | 'foley' | 'game' | 'retro' | 'voice'

/** How much each quality multiplies a match's score. */
export const QUALITY_WEIGHT: Record<SoundQuality, number> = { motion: 1.6, foley: 1.3, game: 0.8, retro: 0.3, voice: 0.3 }

/** Qualities left out of results unless the query asks for them (see `QUALITY_WORDS`). */
export const HIDDEN_QUALITIES: readonly SoundQuality[] = ['retro', 'voice']

/**
 * Words that ask for a hidden quality. Words in `filter` only choose the
 * quality (no name holds them) and are dropped from the query; the others
 * stay words to match too.
 */
export const QUALITY_WORDS: Record<'retro' | 'voice', { filter: readonly string[]; keep: readonly string[] }> = {
  retro: { filter: ['retro', 'chiptune', 'chip', '8bit', '8-bit', '16bit', '16-bit', 'arcade', 'nes'], keep: [] },
  voice: { filter: [], keep: ['voice', 'vocal', 'grunt', 'scream', 'yell', 'shout', 'laugh', 'creature', 'monster', 'zombie', 'goblin', 'alien', 'beast', 'hurt', 'taunt', 'dialog', 'moan', 'roar', 'growl'] },
}

const MOTION = ['motion-essentials', 'ui-clicks', 'impacts-risers']
const FOLEY = [
  'kenney-casino-audio',
  'kenney-impact-sounds',
  'kenney-interface-sounds',
  'kenney-ui-audio',
  'opengameart-100-cc0-metal-and-wood-sfx',
  'opengameart-100-cc0-sfx',
  'opengameart-100-cc0-sfx-2',
  'opengameart-16-button-clicks',
  'opengameart-2-dice-roll-29-throws',
  'opengameart-20-rustles-dry-leaves',
  'opengameart-202-more-sound-effects',
  'opengameart-25-cc0-bang-firework-sfx',
  'opengameart-25-cc0-mud-sfx',
  'opengameart-30-cc0-sfx-loops',
  'opengameart-35-wooden-crackshitsdestructions',
  'opengameart-37-hitspunches',
  'opengameart-40-cc0-water-splash-slime-sfx',
  'opengameart-42-snow-and-gravel-footsteps',
  'opengameart-51-ui-sound-effects-buttons-switches-and-clicks',
  'opengameart-75-cc0-breaking-falling-hit-sfx',
  'opengameart-8-wet-squish-slurp-impacts',
  'opengameart-87-clickety-clips',
  'opengameart-9-wet-snow-steps',
  'opengameart-atmospheric-interaction-sound-pack',
  'opengameart-book-flip-sounds',
  'opengameart-card-game-sounds',
  'opengameart-click-sounds6',
  'opengameart-different-steps-on-wood-stone-leaves-gravel-and-mud',
  'opengameart-door-open-door-close',
  'opengameart-door-open-door-close-set',
  'opengameart-fantasy-accessory-sfx-library',
  'opengameart-fantasy-sound-effects-tinysized-sfx',
  'opengameart-fantozzis-footsteps-grasssand-stone',
  'opengameart-footsteps-leather-cloth-armor',
  'opengameart-gui-sound-effects',
  'opengameart-keyboard-soundpack-1-typing-and-single-keystrokes',
  'opengameart-swamp-environment-audio',
  'opengameart-swish-bamboo-stick-weapon-swhoshes',
  'opengameart-swishes-sound-pack',
  'opengameart-wood-and-metal-sound-effects-volume-2',
]
const RETRO = [
  'opengameart-10-8bit-coin-sounds',
  'opengameart-50-cc0-retro-synth-sfx',
  'opengameart-512-sound-effects-8-bit-style',
  'opengameart-8-bit-jump-1',
  'opengameart-8-bit-sound-effect-pack-vol-001',
  'opengameart-nes-8-bit-sound-effects',
  'opengameart-nes-sounds',
  'opengameart-sfx-the-ultimate-2017-16-bit-mini-pack',
  'opengameart-sfx-the-ultimate-2017-8-bit-mini-pack',
  'opengameart-sound-effects-mini-pack15',
  'opengameart-sound-effects-pack-2',
]
const VOICE = [
  'kenney-voiceover-pack',
  'opengameart-15-vocal-male-strainhurtpainjump-sounds',
  'opengameart-5-hit-sounds-dying',
  'opengameart-80-cc0-creature-sfx',
  'opengameart-80-cc0-creture-sfx-2',
  'opengameart-alien-sounds',
  'opengameart-dialog-vocal-samples',
  'opengameart-female-rpg-voice-starter-pack',
  'opengameart-goblins-sound-pack',
  'opengameart-hurt-death-sound-effect-for-character',
  'opengameart-male-gruntyelling-sounds',
  'opengameart-monster-sound-effects-2',
  'opengameart-monster-sound-effects-pack',
  'opengameart-monster-sound-pack-volume-1',
  'opengameart-voiceover-pack-fighter-40-taunts',
  'opengameart-zombies-sound-pack',
]

const BY_PACK = new Map<string, SoundQuality>([
  ...MOTION.map((p) => [p, 'motion'] as const),
  ...FOLEY.map((p) => [p, 'foley'] as const),
  ...RETRO.map((p) => [p, 'retro'] as const),
  ...VOICE.map((p) => [p, 'voice'] as const),
])

/** A library pack's quality; packs not sorted yet (and new ones) count as `game`. */
export const packQuality = (packId: string): SoundQuality => BY_PACK.get(packId) ?? 'game'
