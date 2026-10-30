import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { app, ipcMain, net } from 'electron'
import {
  ICON_API_HOSTS,
  ICON_NAME,
  type IconData,
  type IconSet,
  iconIdParts,
  isUsableLicense,
  needsCredit,
  SET_PREFIX,
} from '../shared/icons'

// Icons come from an Iconify API (AtomCut's mirror first, then the public
// one) and are kept on disk: the catalogue of sets, the icon names of each set
// opened, every icon fetched, and every search answered. Whatever has been
// seen works offline. Only these hosts are asked, and only for set prefixes
// and icon names of the expected form, so the renderer cannot steer the
// fetches. Sets under a copyleft or non-commercial licence are not offered.

const dir = () => join(app.getPath('userData'), 'icon-cache')
const DAY_MS = 24 * 60 * 60 * 1000

type Json = Record<string, unknown>
const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback)
const num = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The first host that answers the path with JSON. */
async function fetchFromHosts(path: string): Promise<unknown> {
  let lastError: unknown = new Error('No icon server answered.')
  for (const host of ICON_API_HOSTS) {
    try {
      const response = await net.fetch(host + path)
      if (!response.ok) throw new Error(host + ' answered ' + response.status + '.')
      return await response.json()
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

/** A JSON answer kept in a file: used while fresh, refetched when stale, and used stale when offline. */
async function cached(file: string, path: string, maxAgeMs: number): Promise<unknown> {
  const local = join(dir(), file)
  const stat = await fs.stat(local).catch(() => null)
  if (stat && Date.now() - stat.mtimeMs < maxAgeMs) return JSON.parse(await fs.readFile(local, 'utf8')) as unknown
  try {
    const body = await fetchFromHosts(path)
    await fs.mkdir(dir(), { recursive: true })
    await fs.writeFile(local, JSON.stringify(body))
    return body
  } catch (error) {
    if (stat) return JSON.parse(await fs.readFile(local, 'utf8')) as unknown
    throw error
  }
}

let setsCache: Promise<IconSet[]> | null = null

/** Every set that may be offered, most useful first: maintained sets before archived ones, then by size. */
function sets(): Promise<IconSet[]> {
  setsCache ??= (async () => {
    const data = await cached('collections.json', '/collections', 7 * DAY_MS)
    const list: IconSet[] = []
    if (isRecord(data)) {
      for (const [prefix, raw] of Object.entries(data)) {
        if (!SET_PREFIX.test(prefix) || !isRecord(raw)) continue
        const license = isRecord(raw.license) ? raw.license : {}
        const spdx = str(license.spdx) || str(license.title)
        if (spdx === '' || !isUsableLicense(spdx)) continue
        list.push({
          prefix,
          name: str(raw.name, prefix),
          total: num(raw.total),
          author: isRecord(raw.author) ? str(raw.author.name) : '',
          license: spdx,
          licenseTitle: str(license.title, spdx),
          licenseUrl: str(license.url),
          category: str(raw.category, 'Other'),
          palette: raw.palette === true,
          samples: Array.isArray(raw.samples) ? (raw.samples as unknown[]).filter((s): s is string => typeof s === 'string' && ICON_NAME.test(s)).slice(0, 6) : [],
          hidden: raw.hidden === true || str(raw.category).startsWith('Archive'),
          needsCredit: needsCredit(spdx),
        })
      }
    }
    return list.sort((a, b) => Number(a.hidden) - Number(b.hidden) || b.total - a.total)
  })().catch((error) => {
    // Try again next time rather than keep the failure.
    setsCache = null
    throw error
  })
  return setsCache
}

async function usable(prefix: unknown): Promise<string> {
  if (typeof prefix !== 'string' || !SET_PREFIX.test(prefix)) throw new Error('Not an icon set prefix.')
  if (!(await sets()).some((s) => s.prefix === prefix)) throw new Error('The icon set "' + prefix + '" is not offered.')
  return prefix
}

/** The icon names of a set (deprecated ones left out), from the set's own listing. */
function namesIn(data: unknown): string[] {
  if (!isRecord(data)) return []
  const found = new Set<string>()
  const add = (list: unknown) => {
    if (Array.isArray(list)) for (const n of list) if (typeof n === 'string' && ICON_NAME.test(n)) found.add(n)
  }
  add(data.uncategorized)
  if (isRecord(data.categories)) for (const list of Object.values(data.categories)) add(list)
  if (Array.isArray(data.hidden)) for (const n of data.hidden) found.delete(n as string)
  return [...found].sort()
}

async function names(prefix: unknown): Promise<string[]> {
  const set = await usable(prefix)
  return namesIn(await cached('names-' + set + '.json', '/collection?prefix=' + set, 30 * DAY_MS))
}

/**
 * A search over every offered set, or only the sets in `prefixes`: ids as
 * set:name. The server answers with at most about 128 icons spread across the
 * sets it searched, so searching fewer sets reaches deeper into each. Offline,
 * the sets whose names were seen are searched by name.
 */
async function search(query: unknown, prefixes: unknown, limit: unknown): Promise<string[]> {
  const q = str(query).trim().toLowerCase().slice(0, 80)
  if (q === '') return []
  const count = Math.max(1, Math.min(999, Math.round(num(limit, 200))))
  const all = await sets()
  const allowed = new Set(all.map((s) => s.prefix))
  const wanted = Array.isArray(prefixes) ? prefixes.filter((p): p is string => typeof p === 'string' && allowed.has(p)).slice(0, 80) : typeof prefixes === 'string' && allowed.has(prefixes) ? [prefixes] : []
  const only = wanted.length > 0 ? wanted : null
  const key = createHash('sha256').update(q + '|' + (only ?? []).join(',') + '|' + count).digest('hex').slice(0, 24)
  const path = '/search?query=' + encodeURIComponent(q) + '&limit=' + count + (only ? '&prefixes=' + only.join(',') : '')
  try {
    const data = await cached('search-' + key + '.json', path, 3 * DAY_MS)
    const found = isRecord(data) && Array.isArray(data.icons) ? (data.icons as unknown[]) : []
    return found.filter((id): id is string => typeof id === 'string' && allowed.has(iconIdParts(id)?.prefix ?? '')).slice(0, count)
  } catch {
    const results: string[] = []
    const words = q.split(/\s+/).filter(Boolean)
    for (const set of only ? all.filter((s) => only.includes(s.prefix)) : all) {
      const file = await fs.readFile(join(dir(), 'names-' + set.prefix + '.json'), 'utf8').catch(() => null)
      if (!file) continue
      for (const n of namesIn(JSON.parse(file) as unknown)) if (words.every((w) => n.includes(w))) results.push(set.prefix + ':' + n)
      if (results.length >= count) break
    }
    return results.slice(0, count)
  }
}

// ---- Icon data -----------------------------------------------------------

interface StoredSet {
  width: number
  height: number
  icons: Record<string, Json>
  aliases: Record<string, Json>
}

const stores = new Map<string, Promise<StoredSet>>()
const writing = new Map<string, NodeJS.Timeout>()

async function storeOf(prefix: string): Promise<StoredSet> {
  let store = stores.get(prefix)
  if (!store) {
    store = fs
      .readFile(join(dir(), 'icons-' + prefix + '.json'), 'utf8')
      .then((text) => {
        const data = JSON.parse(text) as Partial<StoredSet>
        return { width: num(data.width, 16), height: num(data.height, 16), icons: isRecord(data.icons) ? data.icons : {}, aliases: isRecord(data.aliases) ? data.aliases : {} }
      })
      .catch(() => ({ width: 16, height: 16, icons: {}, aliases: {} }))
    stores.set(prefix, store)
  }
  return store
}

/** Writes a set's store to disk soon, once for a burst of fetches. */
function saveSoon(prefix: string, store: StoredSet): void {
  clearTimeout(writing.get(prefix))
  writing.set(
    prefix,
    setTimeout(() => {
      writing.delete(prefix)
      void fs
        .mkdir(dir(), { recursive: true })
        .then(() => fs.writeFile(join(dir(), 'icons-' + prefix + '.json'), JSON.stringify(store)))
        .catch(() => undefined)
    }, 600),
  )
}

/** An icon from the store, with its set's size where it has none and an alias's flips applied; null when unknown. */
function resolve(store: StoredSet, name: string, depth = 0): IconData | null {
  const own = store.icons[name]
  if (own && typeof own.body === 'string') {
    const [width, height] = [num(own.width, store.width), num(own.height, store.height)]
    let body = own.body
    const transforms: string[] = []
    const [left, top] = [num(own.left), num(own.top)]
    if (own.hFlip === true) transforms.push('translate(' + (width + 2 * left) + ' 0) scale(-1 1)')
    if (own.vFlip === true) transforms.push('translate(0 ' + (height + 2 * top) + ') scale(1 -1)')
    const rotate = num(own.rotate) % 4
    if (rotate === 1) transforms.push('rotate(90 ' + (left + width / 2) + ' ' + (top + height / 2) + ')')
    else if (rotate === 2) transforms.push('rotate(180 ' + (left + width / 2) + ' ' + (top + height / 2) + ')')
    else if (rotate === 3) transforms.push('rotate(270 ' + (left + width / 2) + ' ' + (top + height / 2) + ')')
    if (transforms.length > 0) body = '<g transform="' + transforms.join(' ') + '">' + body + '</g>'
    return { body, width, height, left, top }
  }
  const alias = store.aliases[name]
  if (alias && typeof alias.parent === 'string' && depth < 4) {
    const parent = resolve(store, alias.parent, depth + 1)
    if (!parent) return null
    if (alias.hFlip === true || alias.vFlip === true || alias.rotate) {
      store.icons[name] = { ...store.icons[alias.parent], hFlip: alias.hFlip, vFlip: alias.vFlip, rotate: alias.rotate }
      return resolve(store, name, depth + 1)
    }
    return parent
  }
  return null
}

/** Icons by id (set:name), fetched in batches per set and kept; unknown or unavailable ones are null. */
async function data(ids: unknown): Promise<Record<string, IconData | null>> {
  const wanted = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string').slice(0, 400) : []
  const bySet = new Map<string, string[]>()
  for (const id of wanted) {
    const parts = iconIdParts(id)
    if (parts) bySet.set(parts.prefix, [...(bySet.get(parts.prefix) ?? []), parts.name])
  }
  const result: Record<string, IconData | null> = {}
  for (const id of wanted) result[id] = null
  for (const [prefix, list] of bySet) {
    try {
      await usable(prefix)
    } catch {
      continue
    }
    const store = await storeOf(prefix)
    const missing = list.filter((name) => resolve(store, name) === null)
    for (let i = 0; i < missing.length; i += 60) {
      const batch = missing.slice(i, i + 60)
      try {
        const body = await fetchFromHosts('/' + prefix + '.json?icons=' + batch.join(','))
        if (!isRecord(body)) continue
        if (typeof body.width === 'number') store.width = body.width
        if (typeof body.height === 'number') store.height = body.height
        if (isRecord(body.icons)) for (const [name, icon] of Object.entries(body.icons)) if (ICON_NAME.test(name) && isRecord(icon) && typeof icon.body === 'string' && icon.body.length < 200_000) store.icons[name] = icon
        if (isRecord(body.aliases)) for (const [name, alias] of Object.entries(body.aliases)) if (ICON_NAME.test(name) && isRecord(alias)) store.aliases[name] = alias
        saveSoon(prefix, store)
      } catch {
        // Offline: what was fetched before still answers.
      }
    }
    for (const name of list) result[prefix + ':' + name] = resolve(store, name)
  }
  return result
}

export function handleIcons(): void {
  ipcMain.handle('icons:sets', () => sets())
  ipcMain.handle('icons:names', (_event, prefix: unknown) => names(prefix))
  ipcMain.handle('icons:search', (_event, query: unknown, prefix: unknown, limit: unknown) => search(query, prefix, limit))
  ipcMain.handle('icons:data', (_event, ids: unknown) => data(ids))
}
