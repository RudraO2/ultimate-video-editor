// The Google Fonts catalogue the Fonts window and fonts.list search: 1,946
// families with their category, weights, variable range, scripts, style and
// feeling tags, designer, popularity and year. The data file is loaded the
// first time something needs it (it is a separate chunk). Every family is
// under the SIL Open Font License, the Apache License or the Ubuntu Font
// License (see the credit in google-fonts.json).

export interface GoogleFamily {
  family: string
  /** Sans, Serif, Display, Handwriting or Mono. */
  category: string
  weights: number[]
  italicWeights: number[]
  /** The weight range of a variable family; null when the family has fixed weights. */
  variable: { min: number; max: number } | null
  /** Variable axes besides weight: wdth, opsz, slnt… */
  axes: string[]
  scripts: string[]
  /** Letterform styles: Geometric, Humanist, Didone… */
  styles: string[]
  /** How it feels: Calm, Business, Playful… */
  feelings: string[]
  /** 0 is the most used family. */
  rank: number
  year: number
  designer: string
}

export interface Catalogue {
  families: GoogleFamily[]
  categories: string[]
  scripts: string[]
  styles: string[]
  feelings: string[]
}

/** [family, category, weights, italicWeights, variableMin, variableMax, axes, scripts, styles, feelings, designer, yearAdded, sizeKb]; rows are in popularity order. */
type Row = [string, number, string, string, number, number, string, number[], number[], number[], number, number, number]

interface Raw {
  categories: string[]
  scripts: string[]
  styles: string[]
  feelings: string[]
  designers: string[]
  fonts: Row[]
}

const weightsOf = (digits: string): number[] => [...digits].map((d) => Number(d) * 100).filter((w) => w >= 100 && w <= 900)

function build(raw: Raw): Catalogue {
  const families = raw.fonts.map(
    ([family, category, weights, italics, min, max, axes, scripts, styles, feelings, designer, year], rank): GoogleFamily => ({
      family,
      category: raw.categories[category] ?? 'Sans',
      weights: weightsOf(weights),
      italicWeights: weightsOf(italics),
      variable: min > 0 && max >= min ? { min, max } : null,
      axes: axes === '' ? [] : axes.split(','),
      scripts: scripts.map((i) => raw.scripts[i] ?? ''),
      styles: styles.map((i) => raw.styles[i] ?? ''),
      feelings: feelings.map((i) => raw.feelings[i] ?? ''),
      rank,
      year,
      designer: raw.designers[designer] ?? '',
    }),
  )
  return { families, categories: raw.categories, scripts: raw.scripts, styles: raw.styles, feelings: raw.feelings }
}

let loaded: Promise<Catalogue> | null = null

/** The catalogue, loaded on first use. */
export function googleCatalogue(): Promise<Catalogue> {
  loaded ??= import('./google-fonts.json').then((module) => build(module.default as unknown as Raw))
  return loaded
}

export interface FontFilter {
  /** Words that must each appear in the family name, designer, category or tags. */
  query?: string
  category?: string
  feeling?: string
  style?: string
  script?: string
  variable?: boolean
  italic?: boolean
}

export type FontSort = 'popular' | 'name' | 'newest'

const lower = (s: string) => s.toLowerCase()

/** The families that pass a filter, in the order asked for; a name that starts with the query comes first. */
export function filterFamilies(families: readonly GoogleFamily[], filter: FontFilter, sort: FontSort = 'popular'): GoogleFamily[] {
  const words = lower(filter.query ?? '').split(/\s+/).filter(Boolean)
  const found = families.filter((f) => {
    if (filter.category && lower(f.category) !== lower(filter.category)) return false
    if (filter.feeling && !f.feelings.some((x) => lower(x) === lower(filter.feeling ?? ''))) return false
    if (filter.style && !f.styles.some((x) => lower(x) === lower(filter.style ?? ''))) return false
    if (filter.script && !f.scripts.includes(lower(filter.script))) return false
    if (filter.variable === true && !f.variable) return false
    if (filter.italic === true && f.italicWeights.length === 0) return false
    if (words.length === 0) return true
    const hay = lower([f.family, f.designer, f.category, ...f.styles, ...f.feelings].join(' '))
    return words.every((w) => hay.includes(w))
  })
  const first = words[0]
  const startsWith = (f: GoogleFamily) => (first !== undefined && lower(f.family).startsWith(first) ? 0 : 1)
  const order = (a: GoogleFamily, b: GoogleFamily) =>
    sort === 'name' ? a.family.localeCompare(b.family) : sort === 'newest' ? b.year - a.year || a.rank - b.rank : a.rank - b.rank
  return found.sort((a, b) => startsWith(a) - startsWith(b) || order(a, b))
}

/** A family by its exact name (any case), or undefined. */
export function findFamily(families: readonly GoogleFamily[], name: string): GoogleFamily | undefined {
  const wanted = lower(name.trim())
  return families.find((f) => lower(f.family) === wanted)
}
