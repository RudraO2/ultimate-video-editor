import { CommandError, type CommandResult, type MediaAsset, type SoundVoice } from '@uve/core'
import type { LibraryPack, LibraryPackManifest } from '../../../shared/soundLibrary'
import soundNotes from '../../../shared/soundNotes.json'
import { packQuality, type SoundQuality } from '../../../shared/soundQuality'
import { isEmptyQuery, noteTermsByPack, packMayMatch, parseSoundQuery, rankSounds } from '../../../shared/soundSearch'
import { probeMedia } from '../media/probe'
import { SOUND_PACKS } from './sounds'

// Finding sounds for the sounds stack: the synthesised packs, the project's
// own sounds, and AtomCut's CC0 sound library (91 packs, about 4,500 sounds),
// searched by name and tag. A library sound is fetched on first use, kept on
// disk by the main process, and added to the project with its credit.

export interface SoundResult {
  /** `pack:<id>`, `asset:<mediaId>` or `library:<packId>/<soundId>`. */
  id: string
  name: string
  source: 'pack' | 'project' | 'library'
  tags: string[]
  blurb?: string
  /** Our note on what it suits and how it lands (shared/soundNotes.json). */
  use?: string
  /** For library sounds: where its hit lands (ms from its start) and its length. */
  hitMs?: number
  durationMs?: number
  /** How finished it sounds: `motion` (made for motion), `foley` (clean recordings), `game`, `retro` (chiptune), `voice`. */
  quality?: SoundQuality
  /** For library sounds: the pack, its publisher and licence. */
  pack?: string
  license?: string
}

/** Our usage note of a library sound, when it has one. */
const noteOf = (packId: string, soundId: string): string | undefined => (soundNotes.notes as Record<string, string>)[`${packId}/${soundId}`]
const noteTerms = noteTermsByPack(soundNotes.notes)

let indexCache: Promise<LibraryPack[]> | null = null
const manifests = new Map<string, Promise<LibraryPackManifest>>()

function libraryIndex(): Promise<LibraryPack[]> {
  indexCache ??= window.uve.library.index().catch((error: unknown) => {
    indexCache = null
    throw error
  })
  return indexCache
}

function manifest(id: string): Promise<LibraryPackManifest> {
  let found = manifests.get(id)
  if (!found) {
    found = window.uve.library.pack(id).catch((error: unknown) => {
      manifests.delete(id)
      throw error
    })
    manifests.set(id, found)
  }
  return found
}

/**
 * Sounds that match a query, by AtomCut's rule (shared/soundSearch.ts): every
 * word must match the name, a tag or the blurb, and each `#tag` must be a
 * tag. The synthesised packs, the project's sounds and the library's (only
 * packs whose search terms can match are opened) are ranked together: best
 * score first, then packs, project, library, then by name. Without a query:
 * the packs, the project's sounds and the library's packs.
 */
export async function searchSounds(
  text: string | undefined,
  media: readonly MediaAsset[],
  limit = 30,
): Promise<{ results: SoundResult[]; count?: number; libraryPacks?: { id: string; title: string; sounds: number }[]; offline?: string }> {
  const query = parseSoundQuery(text)
  const local: SoundResult[] = [
    ...SOUND_PACKS.map((p) => ({ id: `pack:${p.id}`, name: p.name, source: 'pack' as const, tags: [p.id === 'keys' ? 'recorded' : 'synth', 'typing', 'keyboard', p.id], blurb: p.tagline })),
    ...media.filter((m) => m.kind === 'audio' || (m.kind === 'video' && m.hasAudio !== false)).map((m) => ({ id: `asset:${m.id}`, name: m.name, source: 'project' as const, tags: [m.kind] })),
  ]
  let packs: LibraryPack[]
  try {
    packs = await libraryIndex()
  } catch (error) {
    const offline = `The sound library could not be reached (${error instanceof Error ? error.message : String(error)}).`
    return { results: isEmptyQuery(query) ? local : rankSounds(local, query).slice(0, limit), offline }
  }
  if (isEmptyQuery(query)) return { results: local, libraryPacks: packs.map((p) => ({ id: p.id, title: p.title, sounds: p.itemCount })) }
  const opened = await Promise.all(packs.filter((p) => packMayMatch({ terms: [...p.terms, ...(noteTerms.get(p.id) ?? [])], tags: p.tags }, query)).map(async (pack) => ({ pack, list: await manifest(pack.id).catch(() => null) })))
  const library: SoundResult[] = []
  for (const { pack, list } of opened) {
    if (!list) continue
    for (const sound of list.sounds) {
      const use = noteOf(pack.id, sound.id)
      library.push({
        id: `library:${pack.id}/${sound.id}`,
        name: sound.name,
        source: 'library',
        quality: packQuality(pack.id),
        tags: sound.tags,
        ...(sound.blurb ? { blurb: sound.blurb } : {}),
        ...(use ? { use } : {}),
        ...(sound.hitMs !== undefined ? { hitMs: Math.round(sound.hitMs) } : {}),
        ...(sound.durationMs !== undefined ? { durationMs: Math.round(sound.durationMs) } : {}),
        pack: `${pack.title} (${pack.publisher})`,
        license: list.license,
      })
    }
  }
  const ranked = rankSounds([...local, ...library], query)
  return { results: ranked.slice(0, limit), count: ranked.length }
}

type Call = (name: string, input: unknown) => Promise<CommandResult>

/** Where a sound's hit is: its loudest peak, as ms into a file `durationMs` long. */
function hitOf(peaks: readonly number[], durationMs: number): number {
  if (peaks.length === 0 || !(durationMs > 0)) return 0
  let best = 0
  peaks.forEach((v, i) => {
    if (v > (peaks[best] ?? 0)) best = i
  })
  return Math.round((best / peaks.length) * durationMs)
}

/**
 * Makes a sound playable in the project and returns the value for a sounds
 * stack: `{pack}` for a synthesised one, `{custom: {assetId, hitMs}}` for the
 * rest (a library sound is fetched, probed and added as media with its credit).
 */
export async function useSound(id: string, media: readonly MediaAsset[], call: Call): Promise<{ value: Pick<SoundVoice, 'pack' | 'custom'>; name: string; credit?: MediaAsset['credit'] }> {
  const [kind, rest = ''] = id.split(/:(.*)/s)
  if (kind === 'pack') {
    const pack = SOUND_PACKS.find((p) => p.id === rest)
    if (!pack) throw new CommandError(`No sound pack "${rest}".`, `Packs: ${SOUND_PACKS.map((p) => p.id).join(', ')}.`)
    return { value: { pack: pack.id, custom: null }, name: pack.name }
  }
  if (kind === 'asset') {
    const asset = media.find((m) => m.id === rest)
    if (!asset || (asset.kind === 'image' || (asset.kind === 'video' && asset.hasAudio === false))) throw new CommandError(`No sound "${rest}" in this project.`, 'sounds.list lists them.')
    return { value: { pack: null, custom: { assetId: asset.id, hitMs: 0 } }, name: asset.name }
  }
  if (kind !== 'library') throw new CommandError(`"${id}" is not a sound id.`, 'Use an id from sounds.list: pack:…, asset:… or library:….')
  const [packId = '', soundId = ''] = rest.split('/')
  const fetched = await window.uve.library.fetch(packId, soundId).catch((error: unknown) => {
    throw new CommandError(`Could not fetch the sound: ${error instanceof Error ? error.message : String(error)}`, 'Check the connection; sounds fetched once work offline afterwards.')
  })
  // The probe reads the type from the file's own name (its extension).
  const probed = await probeMedia({ path: fetched.path, name: fetched.path.split(/[\\/]/).pop() ?? fetched.name, size: fetched.size })
  const pack = (await manifest(packId).catch(() => null))?.title ?? packId
  const credit = { source: `AtomCut sound library ▸ ${pack}`, license: fetched.license || 'CC0-1.0', attribution: fetched.attribution }
  const added = await call('media.add', {
    kind: 'audio',
    name: fetched.name,
    path: probed.path,
    ...(probed.mime ? { mime: probed.mime } : {}),
    ...(probed.durationMs ? { durationMs: probed.durationMs } : {}),
    credit,
  })
  if (!added.ok) throw new CommandError(added.error, added.hint)
  const assetId = (added.value as { id: string }).id
  // The library's own measured hit point; the loudest peak when it has none.
  const hitMs = fetched.hitMs !== undefined ? Math.round(fetched.hitMs) : hitOf(fetched.peaks, probed.durationMs ?? 0)
  return { value: { pack: null, custom: { assetId, hitMs } }, name: fetched.name, credit }
}
