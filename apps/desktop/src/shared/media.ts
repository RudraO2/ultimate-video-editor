import type { MediaKind } from '@uve/core'

// Shared by the main process, which serves media files, and the renderer, which
// loads them. Plain TypeScript only: no Node or DOM APIs.

/** The privileged scheme granted media files are loaded from. */
export const MEDIA_SCHEME = 'uve-media'

const URL_PREFIX = `${MEDIA_SCHEME}://file/`

/** A file the user handed to the editor, as the main process reports it. */
export interface GrantedFile {
  /** Absolute, normalized path; the key for loading the file. */
  path: string
  name: string
  size: number
}

/** The file types the editor imports, by lower-case extension. */
const MEDIA_TYPES: Readonly<Record<string, { kind: MediaKind; mime: string }>> = {
  png: { kind: 'image', mime: 'image/png' },
  jpg: { kind: 'image', mime: 'image/jpeg' },
  jpeg: { kind: 'image', mime: 'image/jpeg' },
  webp: { kind: 'image', mime: 'image/webp' },
  gif: { kind: 'image', mime: 'image/gif' },
  avif: { kind: 'image', mime: 'image/avif' },
  bmp: { kind: 'image', mime: 'image/bmp' },
  svg: { kind: 'image', mime: 'image/svg+xml' },
  mp4: { kind: 'video', mime: 'video/mp4' },
  m4v: { kind: 'video', mime: 'video/mp4' },
  mov: { kind: 'video', mime: 'video/quicktime' },
  webm: { kind: 'video', mime: 'video/webm' },
  mp3: { kind: 'audio', mime: 'audio/mpeg' },
  wav: { kind: 'audio', mime: 'audio/wav' },
  ogg: { kind: 'audio', mime: 'audio/ogg' },
  opus: { kind: 'audio', mime: 'audio/ogg' },
  m4a: { kind: 'audio', mime: 'audio/mp4' },
  aac: { kind: 'audio', mime: 'audio/aac' },
  flac: { kind: 'audio', mime: 'audio/flac' },
  glb: { kind: 'model', mime: 'model/gltf-binary' },
  gltf: { kind: 'model', mime: 'model/gltf+json' },
  obj: { kind: 'model', mime: 'model/obj' },
  stl: { kind: 'model', mime: 'model/stl' },
  ply: { kind: 'model', mime: 'model/ply' },
}

export const MEDIA_EXTENSIONS: readonly string[] = Object.keys(MEDIA_TYPES)

/** The kind and MIME type of a file, from its name; null for files the editor does not import. */
export function mediaTypeOf(name: string): { kind: MediaKind; mime: string } | null {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return null
  const ext = name.slice(dot + 1).toLowerCase()
  return Object.hasOwn(MEDIA_TYPES, ext) ? (MEDIA_TYPES[ext] ?? null) : null
}

/** The last part of a Windows or POSIX path. */
export function baseName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

/** The URL a granted file is loaded from: its absolute path, percent-encoded as one path segment. */
export function mediaUrl(path: string): string {
  return URL_PREFIX + encodeURIComponent(path)
}

/** The absolute path inside a media URL, or null when the URL is not a media URL. */
export function mediaPathFromUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${MEDIA_SCHEME}:` || parsed.host !== 'file') return null
  try {
    const path = decodeURIComponent(parsed.pathname.slice(1))
    return path === '' ? null : path
  } catch {
    return null
  }
}

/** A byte range with an inclusive end, as HTTP counts it. */
export interface ByteRange {
  start: number
  end: number
}

/**
 * Reads a `Range` header for a file of `size` bytes. Returns null when the
 * whole file should be sent (no header, several ranges or another unit) and
 * "unsatisfiable" when the range lies outside the file.
 */
export function parseByteRange(header: string | null, size: number): ByteRange | 'unsatisfiable' | null {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null
  if (!match) return null
  const [, from = '', to = ''] = match
  if (from === '' && to === '') return null
  if (from === '') {
    // "bytes=-500" asks for the last 500 bytes.
    const suffix = Number(to)
    return suffix === 0 || size === 0 ? 'unsatisfiable' : { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(from)
  const end = to === '' ? size - 1 : Math.min(Number(to), size - 1)
  return start >= size || start > end ? 'unsatisfiable' : { start, end }
}
