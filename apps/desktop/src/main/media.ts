import { createReadStream, promises as fs } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { BrowserWindow, dialog, ipcMain, type OpenDialogOptions, protocol } from 'electron'
import { fontMimeOf } from '../shared/fontFile'
import { gltfReferences } from '../shared/model'
import {
  type GrantedFile,
  MEDIA_EXTENSIONS,
  MEDIA_SCHEME,
  mediaPathFromUrl,
  mediaTypeOf,
  parseByteRange,
} from '../shared/media'

// Media files stay where they are on disk; projects store their paths. The
// renderer loads them through `uve-media://` URLs, and this module serves only
// exact paths the user has handed over by dropping or picking files.
const granted = new Set<string>()

// Frames drawn from media must stay readable (for export), so responses allow
// CORS and expose the range headers that streaming readers need.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range',
}

/** Must run before the app is ready: media URLs need a privileged scheme to stream and to be fetched. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
    },
  ])
}

/** The biggest .gltf (JSON) whose references are looked up. */
const MAX_GLTF_BYTES = 64 * 1024 * 1024

/**
 * Grants the files a .gltf refers to (its .bin buffers and textures) beside it,
 * whatever their extension: only relative paths inside the .gltf's folder, and
 * only those that exist. They are not imported as media; the model loads them.
 */
export async function grantGltfReferences(gltfPath: string): Promise<void> {
  try {
    const stat = await fs.stat(gltfPath)
    if (stat.size > MAX_GLTF_BYTES) return
    const json: unknown = JSON.parse(await fs.readFile(gltfPath, 'utf8'))
    const folder = dirname(gltfPath)
    for (const ref of gltfReferences(json)) {
      const path = resolve(folder, ref)
      const inside = relative(folder, path)
      if (inside === '' || /^\.\.(?:[\\/]|$)/.test(inside) || isAbsolute(inside)) continue
      try {
        if ((await fs.stat(path)).isFile()) granted.add(path)
      } catch {
        // Missing: the model reports it when it loads.
      }
    }
  } catch {
    // Not valid JSON (a mislabelled file): the model probe reports it.
  }
}

/** Whether a path was handed over (dropped, picked, fetched or listed in an opened project). */
export const isGranted = (path: string): boolean => granted.has(resolve(path))

/** Grants the media and font files among `paths` that exist; everything else is left out. */
export async function grant(paths: unknown): Promise<GrantedFile[]> {
  if (!Array.isArray(paths)) return []
  const files: GrantedFile[] = []
  for (const raw of paths) {
    if (typeof raw !== 'string' || !isAbsolute(raw)) continue
    const path = resolve(raw)
    if (!mediaTypeOf(path) && !fontMimeOf(path)) continue
    try {
      const stat = await fs.stat(path)
      if (!stat.isFile()) continue
      granted.add(path)
      files.push({ path, name: basename(path), size: stat.size })
      if (path.toLowerCase().endsWith('.gltf')) await grantGltfReferences(path)
    } catch {
      // Missing or unreadable: leave it out.
    }
  }
  return files
}

/** Grants media files the main process found itself (the sticker library's mirrors), without asking the disk again. */
export function grantKnown(paths: readonly string[]): void {
  for (const path of paths) if (isAbsolute(path) && mediaTypeOf(path)) granted.add(resolve(path))
}

async function serve(request: Request): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...CORS_HEADERS, 'Access-Control-Allow-Methods': 'GET, HEAD' } })
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: CORS_HEADERS })

  const path = mediaPathFromUrl(request.url)
  if (path === null || !granted.has(path)) return new Response(null, { status: 404, headers: CORS_HEADERS })
  let size: number
  try {
    const stat = await fs.stat(path)
    if (!stat.isFile()) throw new Error('Not a file')
    size = stat.size
  } catch {
    return new Response(null, { status: 404, headers: CORS_HEADERS })
  }

  const range = parseByteRange(request.headers.get('Range'), size)
  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { ...CORS_HEADERS, 'Content-Range': `bytes */${size}` } })
  }
  const { start, end } = range ?? { start: 0, end: size - 1 }
  const length = size === 0 ? 0 : end - start + 1
  const headers: Record<string, string> = {
    ...CORS_HEADERS,
    'Accept-Ranges': 'bytes',
    'Content-Type': mediaTypeOf(path)?.mime ?? fontMimeOf(path) ?? 'application/octet-stream',
    'Content-Length': String(length),
  }
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  const body =
    request.method === 'HEAD' || length === 0
      ? null
      : (Readable.toWeb(createReadStream(path, { start, end })) as unknown as ReadableStream<Uint8Array>)
  return new Response(body, { status: range ? 206 : 200, headers })
}

const PICK_OPTIONS: OpenDialogOptions = {
  title: 'Import media',
  properties: ['openFile', 'multiSelections'],
  filters: [
    { name: 'Video, images, audio and 3D models', extensions: [...MEDIA_EXTENSIONS] },
    { name: 'All files', extensions: ['*'] },
  ],
}

/**
 * Serves granted files and answers the renderer's media requests. Paths reach
 * `media:grant` only from the preload, which takes them from dropped File
 * objects. With remote debugging on, `media:grant-debug` also grants paths
 * typed by hand, so automated checks can import files; a debugging session
 * already has full control of the window.
 */
export function handleMediaRequests(options: { debug: boolean }): void {
  protocol.handle(MEDIA_SCHEME, serve)
  ipcMain.handle('media:grant', (_event, paths: unknown) => grant(paths))
  ipcMain.handle('media:pick', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = win ? await dialog.showOpenDialog(win, PICK_OPTIONS) : await dialog.showOpenDialog(PICK_OPTIONS)
    return result.canceled ? [] : grant(result.filePaths)
  })
  if (options.debug) ipcMain.handle('media:grant-debug', (_event, paths: unknown) => grant(paths))
}
