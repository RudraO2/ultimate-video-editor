// Searching sounds by AtomCut's rule (see docs/research/atomcut-inspiration.md
// ▸ "How the library is searched"): `#word` is a required tag, every other
// word must match too, and each word scores by where it matches. The code is
// ours; the weights are AtomCut's. On top (Q10): a quality per pack
// (shared/soundQuality.ts) scales the score, chiptune and voices stay out
// unless asked for, our usage notes count like a tag, and a word also matches
// in its plain form (`drops` finds drop, `landing` finds land).

import { HIDDEN_QUALITIES, QUALITY_WEIGHT, QUALITY_WORDS, type SoundQuality } from './soundQuality'

/** A query split into words that must match and tags that must be present. */
export interface SoundQuery {
  terms: string[]
  tags: string[]
  /** Hidden qualities the query asks for (`retro`, `voice`). */
  allow: SoundQuality[]
}

/** What a sound is searched by. */
export interface Searchable {
  name: string
  tags: readonly string[]
  blurb?: string | null
  /** Our usage note (shared/soundNotes.json), searched like a tag. */
  use?: string
  /** How finished it sounds (library packs; synthesised packs and the project's sounds count as `motion`). */
  quality?: SoundQuality
}

/** The order sources come in when scores tie: built-in packs, the project, then the library. */
export const SOURCE_ORDER = { pack: 0, project: 1, library: 3 } as const

const TAG = /#([\p{L}\p{N}_-]+)/gu

/** A word's plain form: `drops` → drop, `whooshes` → whoosh, `landing` → land, `stamped` → stamp. */
export function plain(word: string): string {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3)
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2)
  if (word.length > 4 && /(sh|ch|x|ss)es$/.test(word)) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

const QUALITY_FILTERS = new Set(Object.values(QUALITY_WORDS).flatMap((w) => w.filter))

export function parseSoundQuery(text: string | undefined): SoundQuery {
  const lower = (text ?? '').toLowerCase()
  const tags = new Set<string>()
  for (const match of lower.matchAll(TAG)) tags.add(match[1] as string)
  const words = lower
    .replace(TAG, ' ')
    .split(/\s+/)
    .filter(Boolean)
  // Words that ask for chiptune or voices let them in; the filter words only choose.
  const allow = new Set<SoundQuality>()
  for (const word of [...words, ...tags]) {
    for (const [quality, { filter, keep }] of Object.entries(QUALITY_WORDS)) {
      if (filter.includes(word) || keep.includes(word) || keep.includes(plain(word))) allow.add(quality as SoundQuality)
    }
  }
  return {
    terms: words.filter((w) => !QUALITY_FILTERS.has(w)),
    tags: [...tags].filter((t) => !QUALITY_FILTERS.has(t)),
    allow: [...allow],
  }
}

export const isEmptyQuery = (query: SoundQuery) => query.terms.length === 0 && query.tags.length === 0

/**
 * A sound's score for a query, 0 when it does not match: each word scores
 * 100 when it is the name, 60 when the name starts with it, 40 when the name
 * holds it, 30 when it is a tag or our usage note holds it, 18 when a tag
 * holds it, 8 when the blurb holds it; a word that scores nothing is tried in
 * its plain form, and if that scores nothing either, the sound is dropped, as
 * it is for a missing `#tag`. A query of tags only scores 1.
 */
export function scoreSound(sound: Searchable, query: SoundQuery): number {
  const name = sound.name.toLowerCase()
  const tags = sound.tags.map((t) => t.toLowerCase())
  if (!query.tags.every((t) => tags.includes(t))) return 0
  if (query.terms.length === 0) return 1
  const use = (sound.use ?? '').toLowerCase()
  const blurb = (sound.blurb ?? '').toLowerCase()
  const one = (term: string) =>
    name === term ? 100
    : name.startsWith(term) ? 60
    : name.includes(term) ? 40
    : tags.includes(term) || use.includes(term) ? 30
    : tags.some((t) => t.includes(term)) ? 18
    : blurb.includes(term) ? 8
    : 0
  let total = 0
  for (const term of query.terms) {
    const score = one(term) || (plain(term) !== term ? one(plain(term)) : 0)
    if (score === 0) return 0
    total += score
  }
  return total
}

/** What a sound with a usage note gains in ranking: a sound we have listened to beats a name we have not. */
export const NOTED_BONUS = 40

/** A match's rank: its score scaled by its quality, plus the bonus for a usage note; 0 when hidden or not matching. */
export function rankScore(sound: Searchable, query: SoundQuery): number {
  const quality = sound.quality ?? 'motion'
  if (HIDDEN_QUALITIES.includes(quality) && !query.allow.includes(quality)) return 0
  const score = scoreSound(sound, query)
  if (score === 0) return 0
  return score * QUALITY_WEIGHT[quality] + (sound.use ? NOTED_BONUS : 0)
}

/** Whether a library pack can hold a match: it has every `#tag`, and every word (or its plain form) is inside one of its search terms. */
export function packMayMatch(pack: { terms: readonly string[]; tags: readonly string[] }, query: SoundQuery): boolean {
  const tags = new Set(pack.tags.map((t) => t.toLowerCase()))
  if (!query.tags.every((t) => tags.has(t))) return false
  return query.terms.every((term) => pack.terms.some((t) => t.includes(term) || t.includes(plain(term))))
}

/** Matches by rank (rankScore), best first; ties go by source, then name. */
export function rankSounds<T extends Searchable & { source: keyof typeof SOURCE_ORDER }>(sounds: readonly T[], query: SoundQuery): T[] {
  return sounds
    .map((sound) => ({ sound, score: rankScore(sound, query) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || SOURCE_ORDER[a.sound.source] - SOURCE_ORDER[b.sound.source] || a.sound.name.localeCompare(b.sound.name))
    .map((r) => r.sound)
}

/** The words of our usage notes (keyed `<pack>/<sound>`) per pack, so packMayMatch opens a pack for a word only its notes hold. */
export function noteTermsByPack(notes: Readonly<Record<string, string>>): Map<string, string[]> {
  const byPack = new Map<string, Set<string>>()
  for (const [key, note] of Object.entries(notes)) {
    const pack = key.slice(0, key.indexOf('/'))
    const words = byPack.get(pack) ?? new Set<string>()
    for (const word of note.toLowerCase().split(/[^\p{L}\p{N}-]+/u)) if (word) words.add(word)
    byPack.set(pack, words)
  }
  return new Map([...byPack].map(([pack, words]) => [pack, [...words]]))
}
