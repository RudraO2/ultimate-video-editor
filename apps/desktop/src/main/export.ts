import { randomUUID } from 'node:crypto'
import { type FileHandle, mkdir, open, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, type SaveDialogOptions, shell, type WebContents } from 'electron'
import {
  EXPORT_EXTENSIONS,
  type ExportExtension,
  type ExportFile,
  exportFileName,
  exportFolderName,
  isExportExtension,
  numberedFolder,
  numberedPath,
  SEQUENCE_FILE,
  withExtension,
} from '../shared/export'

// Exports are written straight to a file the user picked in the save dialog.
// The renderer gets an id for the open file and can only write into it, at
// any position: the MP4 index is filled in at the start once the media is in.

/** What the save dialog offers for each file type. */
const FILTER_NAMES: Record<ExportExtension, string> = {
  mp4: 'MP4 video',
  mov: 'QuickTime movie (lossless)',
  webm: 'WebM video',
  wav: 'WAV audio',
  gif: 'Animated GIF',
  png: 'PNG image',
  jpg: 'JPEG image',
  webp: 'WebP image',
}

/** One file, written at any position. */
interface OpenFile {
  kind: 'file'
  handle: FileHandle
  path: string
}

/** A folder of frames, written file by file. `created` is true when this export made the folder. */
interface OpenFolder {
  kind: 'folder'
  path: string
  created: boolean
  /** The names written so far, so a cancelled export can remove them. */
  written: string[]
}

type OpenExport = OpenFile | OpenFolder

const openExports = new Map<string, OpenExport>()
/** Finished exports; only these can be shown in the file manager. */
const finished = new Set<string>()

/**
 * Closes an open export; unless it is kept, the partial file is deleted. For a
 * folder, the files it wrote are deleted, and the folder too when this export
 * made it and it is now empty.
 */
async function close(id: string, keep: boolean): Promise<void> {
  const file = openExports.get(id)
  if (!file) return
  openExports.delete(id)
  if (file.kind === 'folder') {
    if (keep) {
      finished.add(file.path)
      return
    }
    for (const name of file.written) await rm(join(file.path, name), { force: true })
    if (file.created) await rmdir(file.path).catch(() => undefined)
    return
  }
  try {
    await file.handle.close()
  } finally {
    if (keep) finished.add(file.path)
    else await rm(file.path, { force: true })
  }
}

async function openExport(path: string, owner: WebContents): Promise<ExportFile> {
  const handle = await open(path, 'w')
  const id = randomUUID()
  openExports.set(id, { kind: 'file', handle, path })
  // A window that goes away mid-export leaves no half-written file behind.
  owner.once('destroyed', () => void close(id, false))
  return { id, path, name: basename(path) }
}

async function write(id: unknown, position: unknown, data: unknown): Promise<void> {
  const file = typeof id === 'string' ? openExports.get(id) : undefined
  if (!file) throw new Error('This export is not open.')
  if (file.kind === 'folder') throw new Error('This export is a folder: write its files by name.')
  if (typeof position !== 'number' || !Number.isSafeInteger(position) || position < 0 || !(data instanceof Uint8Array)) {
    throw new Error('An export write needs a byte position and bytes.')
  }
  let done = 0
  while (done < data.byteLength) {
    const { bytesWritten } = await file.handle.write(data, done, data.byteLength - done, position + done)
    done += bytesWritten
  }
}

const exists = (path: string) => stat(path).then(() => true, () => false)

/**
 * Opens an export without a dialog, for agents. With a path: an absolute one
 * (the file type's extension is added when missing) in a folder that exists,
 * never replacing a file unless `overwrite`. Without one: the comp's name in
 * the Videos folder, numbered when the name is taken.
 */
async function openExportAt(
  owner: WebContents,
  rawPath: unknown,
  compName: unknown,
  overwrite: unknown,
  extension: unknown,
): Promise<ExportFile> {
  if (!isExportExtension(extension)) throw new Error('Unknown export file type.')
  if (rawPath === null || rawPath === undefined) {
    const first = join(app.getPath('videos'), exportFileName(typeof compName === 'string' ? compName : '', extension))
    let path = first
    for (let n = 2; await exists(path); n++) path = numberedPath(first, n)
    return openExport(path, owner)
  }
  if (typeof rawPath !== 'string' || !isAbsolute(rawPath)) throw new Error('Give the export file as an absolute path.')
  const path = resolve(withExtension(rawPath, extension))
  const folder = await stat(dirname(path)).catch(() => null)
  if (!folder?.isDirectory()) throw new Error(`The folder ${dirname(path)} does not exist.`)
  if (overwrite !== true && (await exists(path))) {
    throw new Error(`${path} already exists. Pass overwrite: true to replace it, or another path.`)
  }
  return openExport(path, owner)
}

/** Registers an open folder export and returns it. */
function openFolder(path: string, created: boolean, owner: WebContents): ExportFile {
  const id = randomUUID()
  openExports.set(id, { kind: 'folder', path, created, written: [] })
  // A window that goes away mid-export leaves no half-written frames behind.
  owner.once('destroyed', () => void close(id, false))
  return { id, path, name: basename(path) }
}

/**
 * Opens a folder export without a dialog, for a PNG sequence. With a path: an
 * absolute one in a folder that exists; the folder is made, or, when it is
 * there already, only reused with `overwrite` (its old frames are deleted,
 * other files are left). Without one: the comp's name plus "-png-seq" in the
 * Videos folder, numbered when the name is taken.
 */
async function openFolderAt(owner: WebContents, rawPath: unknown, compName: unknown, overwrite: unknown): Promise<ExportFile> {
  if (rawPath === null || rawPath === undefined) {
    const first = join(app.getPath('videos'), exportFolderName(typeof compName === 'string' ? compName : ''))
    let path = first
    for (let n = 2; await exists(path); n++) path = numberedFolder(first, n)
    await mkdir(path)
    return openFolder(path, true, owner)
  }
  if (typeof rawPath !== 'string' || !isAbsolute(rawPath)) throw new Error('Give the export folder as an absolute path.')
  const path = resolve(rawPath)
  const parent = await stat(dirname(path)).catch(() => null)
  if (!parent?.isDirectory()) throw new Error(`The folder ${dirname(path)} does not exist.`)
  const there = await stat(path).catch(() => null)
  if (!there) {
    await mkdir(path)
    return openFolder(path, true, owner)
  }
  if (!there.isDirectory()) throw new Error(`${path} is a file, not a folder.`)
  if (overwrite !== true) {
    throw new Error(`${path} already exists. Pass overwrite: true to replace its frames, or another path.`)
  }
  for (const name of await readdir(path)) {
    if (SEQUENCE_FILE.test(name)) await rm(join(path, name), { force: true })
  }
  return openFolder(path, false, owner)
}

/** Writes one named file into an open folder export, replacing it if it is there. */
async function writeNamed(id: unknown, name: unknown, data: unknown): Promise<void> {
  const folder = typeof id === 'string' ? openExports.get(id) : undefined
  if (!folder) throw new Error('This export is not open.')
  if (folder.kind !== 'folder') throw new Error('This export is a single file.')
  if (typeof name !== 'string' || !SEQUENCE_FILE.test(name) || !(data instanceof Uint8Array)) {
    throw new Error('A folder export write needs a frame file name (frame-000.png) and bytes.')
  }
  await writeFile(join(folder.path, name), data)
  if (!folder.written.includes(name)) folder.written.push(name)
}

/**
 * Opens export files and writes the renderer's bytes into them. With remote
 * debugging on, `export:begin-debug` also opens a path given by hand, so
 * automated checks can export without the dialog.
 */
export function handleExportRequests(options: { debug: boolean }): void {
  ipcMain.handle('export:begin', async (event, compName: unknown, requested: unknown) => {
    const extension: ExportExtension = isExportExtension(requested) ? requested : 'mp4'
    const dialogOptions: SaveDialogOptions = {
      title: extension === 'wav' ? 'Export audio' : ['png', 'jpg', 'webp'].includes(extension) ? 'Export image' : 'Export video',
      defaultPath: join(app.getPath('videos'), exportFileName(typeof compName === 'string' ? compName : '', extension)),
      filters: [{ name: FILTER_NAMES[extension], extensions: [extension] }],
    }
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = win ? await dialog.showSaveDialog(win, dialogOptions) : await dialog.showSaveDialog(dialogOptions)
    if (result.canceled || !result.filePath) return null
    // The file holds this format's data whatever name was typed.
    return openExport(withExtension(result.filePath, extension), event.sender)
  })
  ipcMain.handle('export:begin-at', (event, path: unknown, compName: unknown, overwrite: unknown, extension: unknown) =>
    openExportAt(event.sender, path, compName, overwrite, extension),
  )
  ipcMain.handle('export:begin-folder-at', (event, path: unknown, compName: unknown, overwrite: unknown) =>
    openFolderAt(event.sender, path, compName, overwrite),
  )
  ipcMain.handle('export:begin-folder', async (event, compName: unknown) => {
    // The save dialog names the folder to make; one picked that is there already has its old frames replaced.
    const dialogOptions: SaveDialogOptions = {
      title: 'Export PNG sequence',
      buttonLabel: 'Export',
      defaultPath: join(app.getPath('videos'), exportFolderName(typeof compName === 'string' ? compName : '')),
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    }
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = win ? await dialog.showSaveDialog(win, dialogOptions) : await dialog.showSaveDialog(dialogOptions)
    if (result.canceled || !result.filePath) return null
    return openFolderAt(event.sender, result.filePath, compName, true)
  })
  ipcMain.handle('export:write', (_event, id: unknown, position: unknown, data: unknown) => write(id, position, data))
  ipcMain.handle('export:write-file', (_event, id: unknown, name: unknown, data: unknown) => writeNamed(id, name, data))
  ipcMain.handle('export:end', (_event, id: unknown, keep: unknown) =>
    typeof id === 'string' ? close(id, keep === true) : undefined,
  )
  ipcMain.handle('export:reveal', (_event, path: unknown) => {
    if (typeof path === 'string' && finished.has(path)) shell.showItemInFolder(path)
  })
  if (options.debug) {
    ipcMain.handle('export:begin-debug', (event, path: unknown) => {
      const ends = typeof path === 'string' && (EXPORT_EXTENSIONS as readonly string[]).includes(extname(path).slice(1).toLowerCase())
      if (typeof path !== 'string' || !isAbsolute(path) || !ends) {
        throw new Error(`Give an absolute path that ends in ${EXPORT_EXTENSIONS.map((e) => `.${e}`).join(', ')}.`)
      }
      return openExport(resolve(path), event.sender)
    })
  }
}
