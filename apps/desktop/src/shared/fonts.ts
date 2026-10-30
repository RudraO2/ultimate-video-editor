// Shared by the main process, which caches Google Fonts on disk, and the
// renderer, which asks for them. Plain TypeScript only: no Node or DOM APIs.

/** The hosts whose responses are kept on disk, so fonts work offline once fetched. */
export const FONT_HOSTS: readonly string[] = ['fonts.googleapis.com', 'fonts.gstatic.com']

/** The subsets fetched ahead of use: enough for Latin-script text. Others load when text needs them, while online. */
export const PREFETCH_SUBSETS: readonly string[] = ['latin', 'latin-ext']

/** The Google Fonts stylesheet of a family at a weight, or the plain family without one. With `text`, only the glyphs of those characters are served (a tiny file, for previews). */
export function fontCssUrl(family: string, weight?: number, text?: string): string {
  const name = encodeURIComponent(family).replace(/%20/g, '+')
  return `https://fonts.googleapis.com/css2?family=${name}${weight === undefined ? '' : `:wght@${weight}`}${text === undefined ? '' : `&text=${encodeURIComponent(text)}`}&display=block`
}

/** Whether a URL is a Google Fonts stylesheet request the editor makes (the CSS API, nothing else). */
export function isFontCssUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.hostname === 'fonts.googleapis.com' && parsed.pathname === '/css2'
  } catch {
    return false
  }
}

/** The first font file a stylesheet lists, whatever its subset: what a preview loads. */
export function firstFontFileIn(css: string): string | null {
  return /url\((https:\/\/fonts\.gstatic\.com\/[^)\s]+)\)/.exec(css)?.[1] ?? null
}

/**
 * The font files a Google Fonts stylesheet lists for the given subsets. Each
 * `@font-face` block follows a comment naming its subset, such as `/* latin *\/`.
 */
export function fontFilesIn(css: string, subsets: readonly string[]): string[] {
  const files: string[] = []
  const blocks = css.split(/\/\*\s*([\w-]+)\s*\*\//)
  // split with a capture group: [before, subset, block, subset, block, ...]
  for (let i = 1; i + 1 < blocks.length; i += 2) {
    if (!subsets.includes(blocks[i] ?? '')) continue
    for (const match of (blocks[i + 1] ?? '').matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)\s]+)\)/g)) {
      if (match[1] && !files.includes(match[1])) files.push(match[1])
    }
  }
  return files
}

/** What a prefetch did. */
export interface FontPrefetchResult {
  stylesheets: number
  files: number
  /** Files that were already on disk. */
  cached: number
  failed: number
}

/** A font file the user picked or handed over: granted to the editor, with what the file says about itself. */
export interface InspectedFont {
  path: string
  name: string
  size: number
  family: string
  subfamily: string
  weight: number
  italic: boolean
  variable: { min: number; max: number } | null
  format: 'ttf' | 'otf' | 'ttc' | 'woff' | 'woff2'
}

/** The largest font file installed: far beyond any real family file. */
export const MAX_FONT_BYTES = 48 * 1024 * 1024
