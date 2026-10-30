import { parseSoundQuery, scoreSound, type SoundQuery } from './soundSearch'

// The sticker library: free, permissively licensed pictures with transparent
// grounds, mirrored into ~/uve-assets (see docs/HANDOFF.md ▸ "Q5 progress").
// The main process scans the mirrors into one index; the editor and agents
// search it by the sounds' rule (every word must match, `#tag` is required).

/** Where a sticker comes from; each source has one licence. */
export type StickerSourceId = 'fluent-emoji' | 'open-peeps' | 'open-doodles'

/** How a sticker looks: a 3D render, a flat colour vector, or a hand-drawn line illustration. */
export type StickerStyle = '3d' | 'flat' | 'drawn'

export interface StickerSource {
  id: StickerSourceId
  title: string
  license: string
  attribution: string
  url: string
}

export const STICKER_SOURCES: Readonly<Record<StickerSourceId, StickerSource>> = {
  'fluent-emoji': {
    id: 'fluent-emoji',
    title: 'Fluent Emoji',
    license: 'MIT',
    attribution: 'Fluent Emoji by Microsoft (MIT)',
    url: 'https://github.com/microsoft/fluentui-emoji',
  },
  'open-peeps': {
    id: 'open-peeps',
    title: 'Open Peeps',
    license: 'CC0-1.0',
    attribution: 'Open Peeps by Pablo Stanley (CC0)',
    url: 'https://www.openpeeps.com/',
  },
  'open-doodles': {
    id: 'open-doodles',
    title: 'Open Doodles',
    license: 'CC0-1.0',
    attribution: 'Open Doodles by Pablo Stanley (CC0)',
    url: 'https://www.opendoodles.com/',
  },
}

export const STICKER_STYLES = ['3d', 'flat', 'drawn'] as const satisfies readonly StickerStyle[]

/** One sticker of the index. `path` is absolute; the main process has granted it. */
export interface Sticker {
  /** `<source>/<style>/<slug>`, stable across scans. */
  id: string
  name: string
  source: StickerSourceId
  style: StickerStyle
  tags: string[]
  /** The emoji character, for emoji. */
  glyph?: string
  path: string
}

/** A sticker id: lowercase words, digits and dashes in three parts. */
export const STICKER_ID = /^(fluent-emoji|open-peeps|open-doodles)\/(3d|flat|drawn)\/[a-z0-9-]+$/

/** Lowercase dashed words of a name ("Red heart" → "red-heart"). */
export const slugOf = (name: string): string =>
  name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

/** Search words of a phrase: lowercase, split on anything that is not a letter or digit. */
export const wordsOf = (text: string): string[] => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)

export interface StickerFilter {
  query?: string
  source?: StickerSourceId
  style?: StickerStyle
}

/** Ties go 3D first (they read best in motion), then flat, then drawn, then by name. */
const STYLE_ORDER: Record<StickerStyle, number> = { '3d': 0, flat: 1, drawn: 2 }

/**
 * The stickers matching a filter, best first. An empty query keeps every
 * sticker (in style, then name order); otherwise the sounds' scoring applies:
 * every word must match the name or a tag, and every `#tag` must be a tag.
 */
export function searchStickers(stickers: readonly Sticker[], filter: StickerFilter = {}): Sticker[] {
  const query: SoundQuery = parseSoundQuery(filter.query)
  return stickers
    .filter((s) => (!filter.source || s.source === filter.source) && (!filter.style || s.style === filter.style))
    .map((sticker) => ({ sticker, score: scoreSound(sticker, query) }))
    .filter((r) => r.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        STYLE_ORDER[a.sticker.style] - STYLE_ORDER[b.sticker.style] ||
        a.sticker.name.localeCompare(b.sticker.name),
    )
    .map((r) => r.sticker)
}
