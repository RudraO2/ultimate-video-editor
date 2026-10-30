import type { Comp, InstalledFont, Project } from '@uve/core'
import { registerOutlineFont, SCRIPT_FONTS, scriptFontsOf } from '@uve/engine'
import { firstFontFileIn, fontCssUrl } from '../../../shared/fonts'
import { mediaUrl } from '../../../shared/media'
import { TEXT_LOOKS } from './catalog'

// Google Fonts, loaded on first use. The text looks use 68 families (all under
// the SIL Open Font License or Apache 2.0). The main process keeps every font
// fetched from Google on disk, so a family used once works offline; the looks'
// families are fetched ahead of use at startup (see `prefetchLookFonts`).

const BUNDLED = new Set(['Inter', 'JetBrains Mono'])
const requested = new Map<string, Promise<void>>()

// Fonts the user installed into the project load from their files, by their
// own family name, like a Google family.
const installed = new Map<string, InstalledFont[]>()
const faces = new Map<string, Promise<void>>()
const outlines = new Map<string, Promise<void>>()

/** Load a face for extrusion as well as for canvas text. */
function loadOutline(family: string, weight: number, italic: boolean): Promise<void> {
  const key = `${family}:${weight}:${italic}`
  let pending = outlines.get(key)
  if (!pending) {
    pending = (async () => {
      try {
        const own = installed.get(family)
        const face = own?.filter((f) => f.italic === italic).sort((a, b) => Math.abs(a.weight - weight) - Math.abs(b.weight - weight))[0] ?? own?.[0]
        const bytes = face ? new Uint8Array(await (await fetch(mediaUrl(face.path))).arrayBuffer()) : await window.uve.fonts.outline(family, weight, italic)
        const data = new Uint8Array(bytes).buffer
        if (!registerOutlineFont(family, weight, italic, data)) throw new Error('Unsupported outline font format')
        window.dispatchEvent(new Event('uve-outline-font-ready'))
      } catch (error) {
        console.warn('Could not load glyph outlines for ' + family, error)
      }
    })()
    outlines.set(key, pending)
  }
  return pending
}

/** Loads an installed font file as a face of its family, so canvas text and the page can use it. */
export function loadInstalledFont(font: InstalledFont): Promise<void> {
  let pending = faces.get(font.path)
  if (!pending) {
    const weight = font.variable ? Math.round(font.variable.min) + ' ' + Math.round(font.variable.max) : String(font.weight)
    const face = new FontFace(font.family, 'url("' + mediaUrl(font.path) + '")', { weight, style: font.italic ? 'italic' : 'normal' })
    // Added before it loads, so the set's loading events tell the viewport to draw again.
    document.fonts.add(face)
    pending = face.load().then(
      () => undefined,
      (error: unknown) => {
        // Kept as tried, so a font that cannot load is reported once, not at every change of the project.
        document.fonts.delete(face)
        console.warn('Could not load the installed font ' + font.name, error)
      },
    )
    faces.set(font.path, pending)
  }
  return pending
}

/** Tells the loader which families the project installed (they load from their files, not from Google), and starts loading them. */
export function syncInstalledFonts(fonts: readonly InstalledFont[]): void {
  installed.clear()
  outlines.clear()
  for (const font of fonts) {
    installed.set(font.family, [...(installed.get(font.family) ?? []), font])
    void loadInstalledFont(font)
  }
}

const previews = new Map<string, Promise<string | null>>()

/**
 * A Google family in a face of its own, with only the glyphs of `text` (a tiny
 * file), for browsing fonts. The face has its own name, so previews never
 * change how a project's text draws. Resolves with the family name to use in
 * CSS, or null when the family (or that weight) cannot be loaded.
 */
export function previewFamily(family: string, weight: number, text: string): Promise<string | null> {
  const key = family + ':' + weight + ':' + text
  let pending = previews.get(key)
  if (!pending) {
    pending = (async () => {
      for (const w of [weight, undefined]) {
        try {
          const file = firstFontFileIn(await window.uve.fonts.css(fontCssUrl(family, w, text)))
          if (!file) continue
          const alias = 'uvp ' + previews.size + ' ' + family
          const face = new FontFace(alias, 'url("' + file + '")', { weight: w === undefined ? 'normal' : String(w) })
          document.fonts.add(face)
          await face.load()
          return alias
        } catch {
          // This weight does not exist, or offline: try the plain family.
        }
      }
      return null
    })()
    previews.set(key, pending)
  }
  return pending
}

function addStylesheet(href: string): Promise<boolean> {
  return new Promise((resolve) => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = href
    link.onload = () => resolve(true)
    link.onerror = () => {
      link.remove()
      resolve(false)
    }
    document.head.append(link)
  })
}

/** Loads a Google Fonts family at a weight (falling back to its regular style), so canvas text can use it. */
export function loadFont(family: string, weight = 400): Promise<void> {
  if (BUNDLED.has(family)) return Promise.resolve()
  const own = installed.get(family)
  if (own) return Promise.all(own.map(loadInstalledFont)).then(() => undefined)
  const key = `${family}:${weight}`
  let pending = requested.get(key)
  if (!pending) {
    pending = (async () => {
      // Not every family has every weight; the plain family is the fallback.
      const ok = await addStylesheet(fontCssUrl(family, weight))
      if (!ok) await addStylesheet(fontCssUrl(family))
      // A script's family (Noto Sans Tamil) is split by script: load the part with its letters.
      const sample = SCRIPT_FONTS.find((s) => s.family === family)?.sample
      await document.fonts.load(`${weight} 48px "${family}"`, sample).catch(() => undefined)
    })()
    requested.set(key, pending)
  }
  return pending
}

/** Loads every font the text layers of `comps` use, so they draw (and export) in their own type. */
export function loadFontsOf(comps: readonly Comp[]): Promise<void> {
  const wanted = new Map<string, [string, number]>()
  const outlineFaces = new Map<string, [string, number, boolean]>()
  for (const comp of comps) {
    for (const track of comp.tracks) {
      for (const layer of track.layers) {
        if (layer.kind !== 'text') continue
        wanted.set(`${layer.style.fontFamily}:${layer.style.fontWeight}`, [layer.style.fontFamily, layer.style.fontWeight])
        // Letters of Indian scripts fall back to the script's own family (engine scripts.ts).
        for (const script of scriptFontsOf(layer.text)) wanted.set(`${script.family}:${layer.style.fontWeight}`, [script.family, layer.style.fontWeight])
        if (layer.extrude) outlineFaces.set(`${layer.style.fontFamily}:${layer.style.fontWeight}:${layer.style.italic}`, [layer.style.fontFamily, layer.style.fontWeight, layer.style.italic])
        // Styled ranges may use another family or weight.
        for (const range of layer.ranges) {
          const family = range.style.fontFamily ?? layer.style.fontFamily
          const weight = range.style.fontWeight ?? layer.style.fontWeight
          wanted.set(`${family}:${weight}`, [family, weight])
          const italic = range.style.italic ?? layer.style.italic
          if (layer.extrude) outlineFaces.set(`${family}:${weight}:${italic}`, [family, weight, italic])
        }
      }
    }
  }
  return Promise.all([...wanted.values()].map(([family, weight]) => loadFont(family, weight)).concat([...outlineFaces.values()].map(([family, weight, italic]) => loadOutline(family, weight, italic)))).then(() => undefined)
}

/** Keeps the open project's fonts loaded as text layers are added or changed. */
export function followProjectFonts(subscribe: (listener: () => void) => void, project: () => Project): void {
  let last: Project | null = null
  subscribe(() => {
    const next = project()
    if (next === last) return
    if (next.fonts !== last?.fonts) syncInstalledFonts(next.fonts)
    last = next
    void loadFontsOf(next.comps)
  })
}

/** Fetches the text looks' fonts into the disk cache (Latin subsets), once per launch, in the background. */
export async function prefetchLookFonts(): Promise<void> {
  const urls = new Set<string>()
  for (const look of TEXT_LOOKS) {
    const weight = Math.min(900, Math.max(100, Math.round((look.style.fontWeight ?? 400) / 100) * 100))
    if (BUNDLED.has(look.style.fontFamily)) continue
    urls.add(fontCssUrl(look.style.fontFamily, weight))
    urls.add(fontCssUrl(look.style.fontFamily))
  }
  try {
    const result = await window.uve.fonts.prefetch([...urls])
    if (result.failed > 0) console.warn(`Font cache: ${result.failed} font requests failed (offline?).`, result)
  } catch (error) {
    console.warn('Font cache prefetch failed', error)
  }
}
