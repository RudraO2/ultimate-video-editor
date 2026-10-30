import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ipcMain } from 'electron'
import { slugOf, type Sticker, wordsOf } from '../shared/stickers'
import { grantKnown } from './media'

// The sticker library: free pictures mirrored into ~/uve-assets (Fluent Emoji,
// Open Peeps, Open Doodles), scanned once per run into one index. Every file
// found is granted, so the editor can show and place them. A missing mirror
// is skipped; the library is then smaller, never broken.

/** The mirrors' folder: UVE_STICKER_ROOT, else ~/uve-assets. */
const root = () => process.env.UVE_STICKER_ROOT || join(homedir(), 'uve-assets')

type Json = Record<string, unknown>
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [])

const unique = (words: Iterable<string>) => [...new Set(words)]

/** The first file with an extension in a folder, or null. */
async function firstFile(dir: string, ext: string): Promise<string | null> {
  const names = await fs.readdir(dir).catch(() => [] as string[])
  const name = names.sort().find((n) => n.toLowerCase().endsWith(ext))
  return name ? join(dir, name) : null
}

/**
 * Fluent Emoji: one folder per emoji with metadata.json (name, group,
 * keywords) and a 3D PNG and a colour SVG, under `Default/` for emoji with
 * skin tones. Each emoji gives a 3D sticker and a flat one.
 */
async function fluentEmoji(): Promise<Sticker[]> {
  const assets = join(root(), 'fluent-emoji', 'assets')
  const folders = await fs.readdir(assets).catch(() => [] as string[])
  const stickers: Sticker[] = []
  await Promise.all(
    folders.map(async (folder) => {
      const dir = join(assets, folder)
      let meta: Json
      try {
        meta = JSON.parse(await fs.readFile(join(dir, 'metadata.json'), 'utf8')) as Json
      } catch {
        return
      }
      const name = typeof meta.cldr === 'string' && meta.cldr ? meta.cldr : folder.toLowerCase()
      const slug = slugOf(name)
      if (!slug) return
      const words = unique([
        ...wordsOf(name),
        ...strings(meta.keywords).flatMap(wordsOf),
        ...wordsOf(typeof meta.group === 'string' ? meta.group : ''),
        'emoji',
      ])
      const glyph = typeof meta.glyph === 'string' ? meta.glyph : undefined
      for (const [style, sub, ext] of [
        ['3d', '3D', '.png'],
        ['flat', 'Color', '.svg'],
      ] as const) {
        const path = (await firstFile(join(dir, sub), ext)) ?? (await firstFile(join(dir, 'Default', sub), ext))
        if (!path) continue
        stickers.push({
          id: `fluent-emoji/${style}/${slug}`,
          name,
          source: 'fluent-emoji',
          style,
          tags: unique([...words, style]),
          ...(glyph ? { glyph } : {}),
          path,
        })
      }
    }),
  )
  return stickers
}

/** A folder of hand-drawn SVGs, named by file. */
async function drawn(source: 'open-peeps' | 'open-doodles', tags: string[], nameOf: (base: string) => string): Promise<Sticker[]> {
  const dir = join(root(), source)
  const names = await fs.readdir(dir).catch(() => [] as string[])
  return names
    .filter((n) => n.toLowerCase().endsWith('.svg'))
    .map((file) => {
      const name = nameOf(file.slice(0, -4))
      return {
        id: `${source}/drawn/${slugOf(name)}`,
        name,
        source,
        style: 'drawn' as const,
        tags: unique([...wordsOf(name), ...tags, 'drawn']),
        path: join(dir, file),
      }
    })
    .filter((s) => slugOf(s.name) !== '')
}

let scan: Promise<Sticker[]> | null = null

/** Every sticker of the mirrors, scanned once per run and granted; sorted by id. */
export function stickerIndex(): Promise<Sticker[]> {
  scan ??= Promise.all([
    fluentEmoji(),
    drawn('open-peeps', ['peep', 'person', 'people', 'character', 'illustration'], (base) => base.replace(/^peep-/i, 'peep ')),
    drawn('open-doodles', ['doodle', 'illustration', 'scene', 'character'], (base) => base.toLowerCase().replace(/[-_]+/g, ' ')),
  ]).then((lists) => {
    const byId = new Map<string, Sticker>()
    for (const sticker of lists.flat()) if (!byId.has(sticker.id)) byId.set(sticker.id, sticker)
    const stickers = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
    grantKnown(stickers.map((s) => s.path))
    return stickers
  })
  return scan
}

export function handleStickerLibrary(): void {
  ipcMain.handle('stickers:index', () => stickerIndex())
}
