import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { app, ipcMain } from 'electron'
import type { GrantedFile } from '../shared/media'
import { grant } from './media'

// Pictures the editor makes (a background removed) are kept as PNG files in
// the app's data folder, named by their source and content, and granted, so
// projects refer to them like any other media file.

const dir = () => join(app.getPath('userData'), 'cutouts')
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const MAX_BYTES = 256 * 1024 * 1024

async function writeCutout(name: unknown, data: unknown): Promise<GrantedFile> {
  if (!(data instanceof Uint8Array) || data.byteLength > MAX_BYTES || !PNG_SIGNATURE.every((b, i) => data[i] === b)) {
    throw new Error('Only PNG pictures are kept as cut-outs.')
  }
  // A readable name made only of safe characters; the hash keeps it unique.
  const safe = (typeof name === 'string' ? name : 'cutout').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'cutout'
  const sha = createHash('sha256').update(data).digest('hex').slice(0, 8)
  const path = join(dir(), `${safe} ${sha}.png`)
  await fs.mkdir(dir(), { recursive: true })
  if (!(await fs.stat(path).catch(() => null))) await fs.writeFile(path, data)
  const [file] = await grant([path])
  if (!file) throw new Error('The cut-out could not be opened.')
  return file
}

export function handleCutouts(): void {
  ipcMain.handle('media:write-cutout', (_event, name: unknown, data: unknown) => writeCutout(name, data))
}
