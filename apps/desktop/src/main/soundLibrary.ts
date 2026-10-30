import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, ipcMain, net } from 'electron'
import {
  BLOB_PATH,
  type FetchedSound,
  LIBRARY_ID,
  type LibraryPack,
  type LibraryPackManifest,
  SOUND_LIBRARY_ORIGIN,
} from '../shared/soundLibrary'
import { grant } from './media'

// The CC0 sound library, kept on disk: the index (refreshed at most once a
// day), each pack's manifest, and every sound fetched (checked against its
// SHA-256). A local mirror of the whole library (the server's own layout:
// index.json, packs/<id>.json, blobs/<sha256>.<ext>) is read first, so the
// library works offline; the server is asked only for what the mirror lacks.
// Only library.atomcut.net is asked, and only for ids and blob paths of the
// expected form, so the renderer cannot steer the fetches.

const dir = () => join(app.getPath('userData'), 'sound-library')
/** The mirror: UVE_SOUND_MIRROR, else ~/uve-assets/atomcut-sound-library. */
const mirror = () => process.env.UVE_SOUND_MIRROR || join(homedir(), 'uve-assets', 'atomcut-sound-library')
const DAY_MS = 24 * 60 * 60 * 1000

type Json = Record<string, unknown>
const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

async function download(path: string): Promise<Uint8Array> {
  const response = await net.fetch(SOUND_LIBRARY_ORIGIN + path)
  if (!response.ok) throw new Error(`The sound library answered ${response.status} for ${path}.`)
  return new Uint8Array(await response.arrayBuffer())
}

/** A JSON file of the library: from the mirror, else from disk when fresh enough (or when offline), else fetched and stored. */
async function json(path: string, file: string, maxAgeMs: number): Promise<Json> {
  const mirrored = await fs.readFile(join(mirror(), path), 'utf8').catch(() => null)
  if (mirrored !== null) {
    try {
      return JSON.parse(mirrored) as Json
    } catch {
      // A broken mirror file: the cache or the server instead.
    }
  }
  const local = join(dir(), file)
  const stat = await fs.stat(local).catch(() => null)
  if (stat && Date.now() - stat.mtimeMs < maxAgeMs) return JSON.parse(await fs.readFile(local, 'utf8')) as Json
  try {
    const body = await download(path)
    const parsed = JSON.parse(new TextDecoder().decode(body)) as Json
    await fs.mkdir(dir(), { recursive: true })
    await fs.writeFile(local, body)
    return parsed
  } catch (error) {
    if (stat) return JSON.parse(await fs.readFile(local, 'utf8')) as Json
    throw error
  }
}

async function index(): Promise<LibraryPack[]> {
  const data = await json('index.json', 'index.json', DAY_MS)
  const packs = Array.isArray(data.packs) ? (data.packs as Json[]) : []
  return packs
    .filter((p) => str(p.kind, 'sound') === 'sound' && LIBRARY_ID.test(str(p.id)))
    .map((p) => ({
      id: str(p.id),
      title: str(p.title),
      blurb: str(p.blurb),
      publisher: str((p.publisher as Json | undefined)?.name),
      itemCount: num(p.itemCount),
      bytes: num(p.bytes),
      terms: Array.isArray(p.terms) ? (p.terms as unknown[]).filter((t): t is string => typeof t === 'string') : [],
      tags: p.tagCounts && typeof p.tagCounts === 'object' ? Object.keys(p.tagCounts as Json) : [],
    }))
}

/** A pack's raw manifest (entries with their blobs). */
async function rawPack(id: unknown): Promise<Json> {
  if (typeof id !== 'string' || !LIBRARY_ID.test(id)) throw new Error('Not a sound library pack id.')
  // Manifests change rarely: a week on disk.
  return json(`packs/${id}.json`, `pack-${id}.json`, 7 * DAY_MS)
}

async function pack(id: unknown): Promise<LibraryPackManifest> {
  const data = await rawPack(id)
  const entries = Array.isArray(data.entries) ? (data.entries as Json[]) : []
  return {
    id: str(data.id),
    title: str(data.title),
    license: str(data.license),
    attribution: str(data.attribution),
    sounds: entries
      .filter((e) => str(e.kind, 'sound') === 'sound' && LIBRARY_ID.test(str(e.id)))
      .map((e) => ({
        id: str(e.id),
        name: str(e.name),
        tags: Array.isArray(e.tags) ? (e.tags as unknown[]).filter((t): t is string => typeof t === 'string') : [],
        blurb: str(e.blurb),
        bytes: num((e.blob as Json | undefined)?.bytes),
        peaks: Array.isArray((e.preview as Json | undefined)?.peaks) ? ((e.preview as Json).peaks as unknown[]).map(num) : [],
        ...measured(e),
      })),
  }
}

/** What the library measured of a sound (its hit point, length, loudness), when it did. */
function measured(entry: Json): { hitMs?: number; durationMs?: number; loudnessDb?: number } {
  const payload = (entry.payload ?? {}) as Json
  const preview = (entry.preview ?? {}) as Json
  const out: { hitMs?: number; durationMs?: number; loudnessDb?: number } = {}
  for (const key of ['hitMs', 'durationMs', 'loudnessDb'] as const) {
    const value = payload[key] ?? preview[key]
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
  }
  return out
}

/** A blob's bytes from the mirror, when it has them and they match their SHA-256. */
async function mirroredBlob(sha: string, ext: string): Promise<string | null> {
  const path = join(mirror(), 'blobs', `${sha}.${ext}`)
  const body = await fs.readFile(path).catch(() => null)
  if (!body || createHash('sha256').update(body).digest('hex') !== sha) return null
  return path
}

/** Fetches one sound to disk (once, from the mirror when it has it), checks it, and grants it to the window. */
async function fetchSound(packId: unknown, soundId: unknown): Promise<FetchedSound> {
  const data = await rawPack(packId)
  const entries = Array.isArray(data.entries) ? (data.entries as Json[]) : []
  const entry = entries.find((e) => e.id === soundId)
  if (!entry) throw new Error(`The pack "${String(packId)}" has no sound "${String(soundId)}".`)
  const blob = (entry.blob ?? {}) as Json
  const match = BLOB_PATH.exec(str(blob.path))
  if (!match) throw new Error('The sound library gave an unexpected file path.')
  const [, sha, ext] = match
  const blobs = join(dir(), 'blobs')
  // A readable file name for the media library, made only of safe characters; the hash keeps it unique.
  const safe = str(entry.name, 'sound').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'sound'
  const path = join(blobs, `${safe} ${(sha as string).slice(0, 8)}.${ext}`)
  const known = await fs.stat(path).catch(() => null)
  const fromMirror = known ? null : await mirroredBlob(sha as string, ext as string)
  if (fromMirror) {
    await fs.mkdir(blobs, { recursive: true })
    // A hard link costs no disk; a copy where links are not possible (another drive).
    await fs.link(fromMirror, path).catch(() => fs.copyFile(fromMirror, path))
  } else if (!known) {
    const body = await download(str(blob.path))
    const digest = createHash('sha256').update(body).digest('hex')
    if (digest !== sha) throw new Error('A sound from the library did not match its checksum; it was not kept.')
    await fs.mkdir(blobs, { recursive: true })
    await fs.writeFile(path, body)
  }
  const [file] = await grant([path])
  if (!file) throw new Error('The fetched sound could not be opened.')
  const preview = (entry.preview ?? {}) as Json
  return {
    path: file.path,
    name: str(entry.name, file.name),
    size: file.size,
    license: str(data.license),
    attribution: str(data.attribution),
    peaks: Array.isArray(preview.peaks) ? (preview.peaks as unknown[]).map(num) : [],
    ...(measured(entry).hitMs !== undefined ? { hitMs: measured(entry).hitMs } : {}),
  }
}

export function handleSoundLibrary(): void {
  ipcMain.handle('library:index', () => index())
  ipcMain.handle('library:pack', (_event, id: unknown) => pack(id))
  ipcMain.handle('library:fetch', (_event, packId: unknown, soundId: unknown) => fetchSound(packId, soundId))
}
