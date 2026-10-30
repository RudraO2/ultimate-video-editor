// Icons: what the main process (which fetches them from an Iconify API and
// keeps them on disk) and the renderer exchange. Plain TypeScript only: no
// Node or DOM APIs.

/** The Iconify API hosts asked, in order: AtomCut's mirror, then the public one. */
export const ICON_API_HOSTS: readonly string[] = ['https://icons.atomcut.net', 'https://api.iconify.design']

/** A set of icons, as the catalogue lists it. */
export interface IconSet {
  prefix: string
  name: string
  total: number
  author: string
  /** The licence as an SPDX id when it has one (MIT, Apache-2.0, CC-BY-4.0…), else its title. */
  license: string
  licenseTitle: string
  licenseUrl: string
  /** Iconify's category, such as "UI 24px", "Emoji", "Logos". */
  category: string
  /** Icons in their own colours (logos, emoji, flags) rather than one ink. */
  palette: boolean
  /** The icon names of a few of its icons, for a preview. */
  samples: string[]
  /** An unmaintained or archived set: listed last. */
  hidden: boolean
  /** The licence asks for credit (Creative Commons Attribution). */
  needsCredit: boolean
}

/** One icon, with its own size and box, ready to be drawn. */
export interface IconData {
  /** SVG elements, inside a box of left, top, width, height. */
  body: string
  width: number
  height: number
  left: number
  top: number
}

/** Set prefixes and icon names: lowercase words joined by dashes (icon names may also use underscores). */
export const SET_PREFIX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const ICON_NAME = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/

/** An icon id: set:name. */
export function iconIdParts(id: string): { prefix: string; name: string } | null {
  const colon = id.indexOf(':')
  if (colon <= 0) return null
  const prefix = id.slice(0, colon)
  const name = id.slice(colon + 1)
  return SET_PREFIX.test(prefix) && ICON_NAME.test(name) ? { prefix, name } : null
}

/** Sets under a copyleft or non-commercial licence are not offered: their terms cannot be met by everything made in the editor. */
export function isUsableLicense(spdx: string): boolean {
  const s = spdx.toUpperCase()
  return !(s.startsWith('GPL') || s.startsWith('AGPL') || s.startsWith('LGPL') || s.includes('-NC') || s.includes('NONCOMMERCIAL') || s.includes('NON-COMMERCIAL'))
}

/** Whether the licence asks for credit in what is made with the icon. */
export function needsCredit(spdx: string): boolean {
  return spdx.toUpperCase().startsWith('CC-BY')
}

/** The sets, grouped as the window lists them: Iconify's categories folded into a few groups. */
export function iconGroup(category: string): string {
  if (category.startsWith('UI')) return 'Interface'
  if (category === 'Material') return 'Material'
  if (category === 'Emoji') return 'Emoji'
  if (category === 'Logos') return 'Logos'
  if (category === 'Programming') return 'Programming'
  if (category.startsWith('Flags')) return 'Flags and maps'
  if (category === 'Thematic') return 'Thematic'
  if (category.startsWith('Archive')) return 'Archive'
  return 'Other'
}

export const ICON_GROUPS: readonly string[] = ['Interface', 'Material', 'Emoji', 'Logos', 'Programming', 'Flags and maps', 'Thematic', 'Other', 'Archive']

/** How an icon is drawn: with lines, with solid shapes, or in its own colours. */
export type IconStyle = 'line' | 'solid' | 'color'

/** The style of an icon from its SVG body (and whether its set is a colour one). */
export function iconStyleOf(body: string, palette: boolean): IconStyle {
  if (palette) return 'color'
  const stroked = /stroke="(?!none)/.test(body) || /stroke:(?!none)/.test(body)
  const filled = /fill="(?!none)/.test(body) || /fill:(?!none)/.test(body)
  // Paths with no paint attributes are filled, like Material's.
  if (stroked && !filled) return 'line'
  if (!stroked && /fill="none"/.test(body)) return 'line'
  return 'solid'
}

/** A standalone SVG picture of an icon: its box as the viewBox, `currentColor` replaced by `color`, drawn `size` px on its longer side. */
export function iconSvg(data: IconData, options: { size?: number; color?: string } = {}): string {
  const size = options.size ?? 24
  const scale = size / Math.max(data.width, data.height)
  const body = options.color ? data.body.replace(/currentColor/gi, options.color) : data.body
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + data.left + ' ' + data.top + ' ' + data.width + ' ' + data.height +
    '" width="' + Math.round(data.width * scale * 100) / 100 + '" height="' + Math.round(data.height * scale * 100) / 100 + '">' + body + '</svg>'
  )
}

/** A readable name for an icon: "arrow-right" is "Arrow right". */
export function iconTitle(name: string): string {
  const words = name.replace(/[-_]+/g, ' ').trim()
  return words === '' ? name : words[0]?.toUpperCase() + words.slice(1)
}
