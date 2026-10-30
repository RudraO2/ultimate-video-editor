import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { app, net } from 'electron'
import { type GrantedFile, mediaTypeOf } from '../shared/media'
import { gltfReferences } from '../shared/model'
import { grant } from './media'

// 3D model files an agent names by address. The download is kept in user data
// (once per address); a .gltf also brings the files it refers to beside it.

/** The most a model download may take, files beside a .gltf included. */
export const MAX_MODEL_BYTES = 256 * 1024 * 1024

/** The bytes at an address, failing as soon as they pass `limit`. */
async function fetchCapped(address: string, limit: number): Promise<Uint8Array> {
  const response = await net.fetch(address)
  if (!response.ok) throw new Error(`${new URL(address).host} answered ${response.status}.`)
  const tooBig = () => new Error(`That model is bigger than ${MAX_MODEL_BYTES / 1024 / 1024} MB.`)
  if (Number(response.headers.get('content-length') ?? 0) > limit) throw tooBig()
  if (!response.body) return new Uint8Array(await response.arrayBuffer())
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > limit) {
      void reader.cancel()
      throw tooBig()
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.length
  }
  return bytes
}

/** The file name an address ends in, safe to write. */
function nameOf(url: URL): string {
  let name = url.pathname.split('/').pop() ?? ''
  try {
    name = decodeURIComponent(name)
  } catch {
    // Keep the raw name.
  }
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
}

/**
 * Downloads a model from an https address into user data (once), together
 * with the files a .gltf refers to, then grants it. Returns the granted file.
 */
export async function downloadModel(address: string): Promise<GrantedFile> {
  let url: URL
  try {
    url = new URL(address)
  } catch {
    throw new Error(`"${address}" is not an address.`)
  }
  if (url.protocol !== 'https:') throw new Error('A model is downloaded over https only.')
  const name = nameOf(url)
  if (mediaTypeOf(name)?.kind !== 'model') throw new Error(`"${name || url.href}" is not a model file (glb, gltf, obj, stl or ply).`)
  const folder = join(app.getPath('userData'), 'model-cache', createHash('sha256').update(url.href).digest('hex').slice(0, 16))
  const path = join(folder, name)

  const cached = await fs.stat(path).then((s) => s.isFile(), () => false)
  if (!cached) {
    let budget = MAX_MODEL_BYTES
    const main = await fetchCapped(url.href, budget)
    budget -= main.length
    const files: [string, Uint8Array][] = []
    if (name.toLowerCase().endsWith('.gltf')) {
      let json: unknown
      try {
        json = JSON.parse(new TextDecoder().decode(main))
      } catch {
        throw new Error(`${url.host}${url.pathname} is not a glTF file.`)
      }
      for (const ref of gltfReferences(json)) {
        const bytes = await fetchCapped(new URL(ref.split('/').map(encodeURIComponent).join('/'), url).href, budget)
        budget -= bytes.length
        files.push([join(folder, ...ref.split('/')), bytes])
      }
    }
    // The model itself goes last: it being there means the download finished.
    for (const [file, bytes] of [...files, [path, main] as [string, Uint8Array]]) {
      await fs.mkdir(dirname(file), { recursive: true })
      await fs.writeFile(file, bytes)
    }
  }
  const [file] = await grant([path])
  if (!file) throw new Error(`${basename(path)} could not be opened.`)
  return file
}
