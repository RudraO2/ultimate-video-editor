// The CC0 sound library (AtomCut's, served from library.atomcut.net): what
// main and renderer exchange about it.

export const SOUND_LIBRARY_ORIGIN = 'https://library.atomcut.net/v1/'

/** A pack in the library's index. */
export interface LibraryPack {
  id: string
  title: string
  blurb: string
  publisher: string
  itemCount: number
  bytes: number
  /** Words the pack's sounds are found by (names, tags, blurbs). */
  terms: string[]
  tags: string[]
}

/** One sound of a pack's manifest. */
export interface LibrarySound {
  id: string
  name: string
  tags: string[]
  blurb: string
  bytes: number
  /** Loudness over the sound, 0 to 1, evenly spaced. */
  peaks: number[]
  /** Where the sound's hit lands, ms from its start (measured by the library), when known. */
  hitMs?: number
  durationMs?: number
  /** Its loudness, dB, when known. */
  loudnessDb?: number
}

export interface LibraryPackManifest {
  id: string
  title: string
  license: string
  attribution: string
  sounds: LibrarySound[]
}

/** A sound fetched to disk and granted, with its credit. */
export interface FetchedSound {
  path: string
  name: string
  size: number
  license: string
  attribution: string
  peaks: number[]
  hitMs?: number
}

/** Pack and sound ids: lowercase words joined by dashes or underscores. */
export const LIBRARY_ID = /^[a-z0-9][a-z0-9_-]{0,80}$/
/** A content-addressed blob path. */
export const BLOB_PATH = /^blobs\/([0-9a-f]{64})\.(wav|mp3|ogg|flac|m4a)$/
