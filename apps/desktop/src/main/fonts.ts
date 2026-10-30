import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { app, ipcMain, net, protocol } from 'electron'
import { FONT_HOSTS, type FontPrefetchResult, fontFilesIn, isFontCssUrl, PREFETCH_SUBSETS } from '../shared/fonts'

// Google Fonts are kept on disk. Every https request the window makes to the
// font hosts is answered from the cache when it can be, and stored when it is
// fetched, so a font used once works offline from then on. Other https
// requests pass through untouched. At startup the renderer asks for the text
// looks' fonts ahead of use (Latin subsets), so they are there before the
// first time the editor is offline.

const cacheDir = () => join(app.getPath('userData'), 'font-cache')
const keyOf = (url: string) => createHash('sha256').update(url).digest('hex').slice(0, 40)

interface Entry {
  url: string
  type: string
  savedAt: number
}

const isFontUrl = (url: string) => {
  try {
    const { protocol: scheme, hostname } = new URL(url)
    return scheme === 'https:' && FONT_HOSTS.includes(hostname)
  } catch {
    return false
  }
}

function respond(body: Uint8Array, type: string): Response {
  // Font files are loaded across origins, so they need CORS, as Google sends it.
  return new Response(new Uint8Array(body), { status: 200, headers: { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' } })
}

async function readCached(url: string): Promise<{ body: Uint8Array; type: string } | null> {
  const key = keyOf(url)
  try {
    const [meta, body] = await Promise.all([fs.readFile(join(cacheDir(), `${key}.json`), 'utf8'), fs.readFile(join(cacheDir(), `${key}.bin`))])
    const entry = JSON.parse(meta) as Entry
    return entry.url === url ? { body, type: entry.type } : null
  } catch {
    return null
  }
}

async function store(url: string, body: Uint8Array, type: string): Promise<void> {
  const key = keyOf(url)
  await fs.mkdir(cacheDir(), { recursive: true })
  // The body first: an entry is only valid once its metadata exists.
  await fs.writeFile(join(cacheDir(), `${key}.bin`), body)
  await fs.writeFile(join(cacheDir(), `${key}.json`), JSON.stringify({ url, type, savedAt: Date.now() } satisfies Entry))
}

/** A font host response, from disk when cached; fetched and stored otherwise. */
export async function cachedFetch(url: string): Promise<{ response: Response; cached: boolean }> {
  const hit = await readCached(url)
  if (hit) return { response: respond(hit.body, hit.type), cached: true }
  let fetched: Response
  try {
    fetched = await net.fetch(url, { bypassCustomProtocolHandlers: true })
  } catch {
    return { response: new Response(null, { status: 504 }), cached: false }
  }
  if (!fetched.ok) return { response: new Response(null, { status: fetched.status }), cached: false }
  const body = new Uint8Array(await fetched.arrayBuffer())
  const type = fetched.headers.get('Content-Type') ?? 'application/octet-stream'
  await store(url, body, type).catch(() => undefined)
  return { response: respond(body, type), cached: false }
}

/** Fetches stylesheets and their Latin font files into the cache, a few at a time. */
async function prefetch(urls: unknown): Promise<FontPrefetchResult> {
  const result: FontPrefetchResult = { stylesheets: 0, files: 0, cached: 0, failed: 0 }
  if (!Array.isArray(urls)) return result
  const sheets = urls.filter((u): u is string => typeof u === 'string' && isFontUrl(u))
  const files = new Set<string>()
  const each = async <T>(items: readonly T[], job: (item: T) => Promise<void>) => {
    let next = 0
    const worker = async () => {
      while (next < items.length) await job(items[next++] as T)
    }
    await Promise.all(Array.from({ length: 4 }, worker))
  }
  await each(sheets, async (url) => {
    const { response } = await cachedFetch(url)
    if (!response.ok) {
      result.failed++
      return
    }
    result.stylesheets++
    for (const file of fontFilesIn(await response.text(), PREFETCH_SUBSETS)) files.add(file)
  })
  await each([...files], async (url) => {
    const { response, cached } = await cachedFetch(url)
    if (!response.ok) result.failed++
    else if (cached) result.cached++
    else result.files++
  })
  return result
}

/** Must run once the app is ready: answers the font hosts from the disk cache. */
export function handleFontRequests(): void {
  protocol.handle('https', (request) => {
    if (request.method !== 'GET' || !isFontUrl(request.url)) return net.fetch(request, { bypassCustomProtocolHandlers: true })
    return cachedFetch(request.url).then((r) => r.response)
  })
  ipcMain.handle('fonts:prefetch', (_event, urls: unknown) => prefetch(urls))
  // A stylesheet's text, for a preview that loads one file by hand (the renderer may not fetch from the font hosts itself).
  ipcMain.handle('fonts:css', async (_event, url: unknown) => {
    if (typeof url !== 'string' || !isFontCssUrl(url)) throw new Error('Not a Google Fonts stylesheet address.')
    const { response } = await cachedFetch(url)
    if (!response.ok) throw new Error('Google Fonts answered ' + response.status + '.')
    return response.text()
  })
  // Ask Google for a TrueType face (the older user agent avoids WOFF2, which
  // opentype.js cannot parse). Keep it in the same offline cache as fonts.
  ipcMain.handle('fonts:outline', async (_event, family: unknown, weight: unknown, italic: unknown) => {
    if (typeof family !== 'string' || family.length > 200 || typeof weight !== 'number' || !Number.isFinite(weight) || typeof italic !== 'boolean') throw new Error('Invalid font face.')
    const name = encodeURIComponent(family).replace(/%20/g, '+')
    const w = Math.min(900, Math.max(100, Math.round(weight / 100) * 100))
    const url = `https://fonts.googleapis.com/css2?family=${name}:${italic ? `ital,wght@1,${w}` : `wght@${w}`}&display=block`
    const cacheKey = url + '#outline-ttf'
    const cached = await readCached(cacheKey)
    if (cached) return cached.body
    const css = await net.fetch(url, { bypassCustomProtocolHandlers: true, headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!css.ok) throw new Error('Could not load font outline.')
    const file = /url\((https:\/\/fonts\.gstatic\.com\/[^)\s]+)\)/.exec(await css.text())?.[1]
    if (!file) throw new Error('No font outline available.')
    const fetched = await cachedFetch(file)
    if (!fetched.response.ok) throw new Error('Could not load font file.')
    const bytes = new Uint8Array(await fetched.response.arrayBuffer())
    await store(cacheKey, bytes, 'font/ttf').catch(() => undefined)
    return bytes
  })
}
