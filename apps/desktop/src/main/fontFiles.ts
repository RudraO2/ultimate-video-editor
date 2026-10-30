import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { brotliDecompressSync, inflateSync } from 'node:zlib'
import { app, BrowserWindow, dialog, ipcMain, net, type OpenDialogOptions } from 'electron'
import {
  FONT_EXTENSIONS,
  type FontInfo,
  fontFormatOf,
  fontInfoFromTables,
  type SfntTables,
  sfntTables,
  woff2Directory,
  woffDirectory,
} from '../shared/fontFile'
import { type InspectedFont, MAX_FONT_BYTES } from '../shared/fonts'
import { grant, isGranted } from './media'

// Font files the user installs: a file picked, dropped, named by an agent, or
// downloaded from an address. The file stays where it is (a download is kept
// in user data); the editor reads what it says about itself, and the renderer
// loads it through the granted-media scheme like any other file.

/** What a font file says about itself, whatever its container; null when it is not a font. */
export function fontInfoOf(bytes: Uint8Array): FontInfo | null {
  const format = fontFormatOf(bytes)
  if (!format) return null
  try {
    if (format === 'woff') {
      const directory = woffDirectory(bytes)
      if (!directory) return null
      const tables: SfntTables = new Map()
      for (const t of directory) {
        const stored = bytes.subarray(t.offset, t.offset + t.storedLength)
        tables.set(t.tag, t.storedLength < t.length ? new Uint8Array(inflateSync(stored)) : stored)
      }
      return fontInfoFromTables(tables, format)
    }
    if (format === 'woff2') {
      const packed = woff2Directory(bytes)
      if (!packed) return null
      const stream = new Uint8Array(brotliDecompressSync(bytes.subarray(packed.streamAt, packed.streamAt + packed.streamLength)))
      const tables: SfntTables = new Map()
      let at = 0
      for (const t of packed.tables) {
        tables.set(t.tag, stream.subarray(at, at + t.length))
        at += t.length
      }
      return fontInfoFromTables(tables, format)
    }
    const tables = sfntTables(bytes)
    return tables ? fontInfoFromTables(tables, format) : null
  } catch {
    return null
  }
}

function inspected(path: string, size: number, info: FontInfo): InspectedFont {
  return {
    path,
    name: basename(path),
    size,
    family: info.family,
    subfamily: info.subfamily,
    weight: info.weight,
    italic: info.italic,
    variable: info.variable,
    format: info.format,
  }
}

/** Reads a font file on disk, grants it, and says what it is. Throws a message fit for the user. */
export async function inspectFontFile(raw: string): Promise<InspectedFont> {
  if (!isAbsolute(raw)) throw new Error('A font file is given by its absolute path.')
  const path = resolve(raw)
  const stat = await fs.stat(path).catch(() => null)
  if (!stat?.isFile()) throw new Error('No file at ' + path + '.')
  if (stat.size > MAX_FONT_BYTES) throw new Error(basename(path) + ' is larger than ' + MAX_FONT_BYTES / 1024 / 1024 + ' MB: too big for a font.')
  const info = fontInfoOf(await fs.readFile(path))
  if (!info) throw new Error(basename(path) + ' is not a font the editor can read (TrueType, OpenType, WOFF or WOFF2).')
  const [file] = await grant([path])
  if (!file) throw new Error(basename(path) + ' could not be opened.')
  return inspected(file.path, file.size, info)
}

/** Downloads a font from an https address into user data (once), then inspects it. */
export async function downloadFont(address: string): Promise<InspectedFont> {
  let url: URL
  try {
    url = new URL(address)
  } catch {
    throw new Error('"' + address + '" is not an address.')
  }
  if (url.protocol !== 'https:') throw new Error('A font is downloaded over https only.')
  const response = await net.fetch(url.href)
  if (!response.ok) throw new Error(url.host + ' answered ' + response.status + '.')
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > MAX_FONT_BYTES) throw new Error('That file is too big for a font.')
  const body = new Uint8Array(await response.arrayBuffer())
  if (body.length > MAX_FONT_BYTES) throw new Error('That file is too big for a font.')
  const info = fontInfoOf(body)
  if (!info) throw new Error(url.host + url.pathname + ' is not a font file the editor can read.')
  const dir = join(app.getPath('userData'), 'fonts')
  await fs.mkdir(dir, { recursive: true })
  const name = createHash('sha256').update(body).digest('hex').slice(0, 16) + '.' + info.format
  const path = join(dir, name)
  await fs.writeFile(path, body)
  const [file] = await grant([path])
  if (!file) throw new Error('The downloaded font could not be opened.')
  return { ...inspected(file.path, file.size, info), name: basename(url.pathname) || name }
}

const PICK_OPTIONS: OpenDialogOptions = {
  title: 'Install fonts',
  properties: ['openFile', 'multiSelections'],
  filters: [{ name: 'Fonts', extensions: [...FONT_EXTENSIONS] }],
}

/** The fonts among `paths` that can be read; files that cannot are left out. */
async function readable(paths: string[]): Promise<InspectedFont[]> {
  const fonts: InspectedFont[] = []
  for (const path of paths) {
    try {
      fonts.push(await inspectFontFile(path))
    } catch {
      // Not a readable font: left out.
    }
  }
  return fonts
}

/** Font installs from the Fonts window: picking files, and reading files already granted (dropped). */
export function handleFontFiles(): void {
  ipcMain.handle('fonts:pick', async (event): Promise<InspectedFont[]> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = win ? await dialog.showOpenDialog(win, PICK_OPTIONS) : await dialog.showOpenDialog(PICK_OPTIONS)
    return result.canceled ? [] : readable(result.filePaths)
  })
  // Only files handed over already (dropped on the window, listed in an opened project) are read.
  ipcMain.handle('fonts:inspect', async (_event, paths: unknown): Promise<InspectedFont[]> => {
    const list = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string' && FONT_EXTENSIONS.includes(extname(p).slice(1).toLowerCase())) : []
    return readable(list.filter(isGranted))
  })
}
