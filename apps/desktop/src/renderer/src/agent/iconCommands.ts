import { CommandError, defineCommand } from '@uve/core'
import { z } from 'zod'
import { type IconSet, iconIdParts, iconStyleOf, iconTitle } from '../../../shared/icons'
import { iconPictures, iconPlacement, iconSets } from '../library/icons'

// Icons for agents: find one by what it shows (icons.list), place it as vector
// layers (icons.use). The sets and pictures are the main process's, kept on disk.

const credit = (set: IconSet, name: string) =>
  'Credit: the "' + name + '" icon is from ' + set.name + (set.author ? ' by ' + set.author : '') + ', licence ' + set.licenseTitle + '.'

/** A set by prefix, else by name (any case, a part of it); null when none or several match. */
function findSet(sets: readonly IconSet[], ref: string): IconSet | null {
  const wanted = ref.trim().toLowerCase()
  const exact = sets.find((s) => s.prefix === wanted || s.name.toLowerCase() === wanted)
  if (exact) return exact
  const partial = sets.filter((s) => s.name.toLowerCase().includes(wanted) || s.prefix.includes(wanted))
  return partial.length === 1 ? (partial[0] ?? null) : null
}

export const iconsList = defineCommand({
  name: 'icons.list',
  summary: 'Find an icon: 235 open-source icon sets (about 410,000 icons), searched by what the icon shows, in every set or one. Without a query, the sets.',
  details:
    'query is words that appear in an icon name ("arrow right", "heart", "camera"). set (a prefix such as lucide, mdi, tabler, or part of a set name) searches one set, or with no query lists its first icons. style is line (drawn with strokes), solid (filled shapes) or color (own colours: logos, emoji, flags). Each icon id is set:name; icons.use {id} places it as vector layers that draw on. Sets under copyleft or non-commercial licences are not offered. Icons are fetched once and kept on this computer.',
  effect: 'read',
  input: z.strictObject({
    query: z.string().optional(),
    set: z.string().optional().describe('A set prefix or part of its name'),
    style: z.enum(['line', 'solid', 'color']).optional(),
    limit: z.number().int().min(1).max(200).default(40),
  }),
  run: async ({ query, set, style, limit }) => {
    const sets = await iconSets()
    let only: IconSet | null = null
    if (set !== undefined) {
      only = findSet(sets, set)
      if (!only) {
        const near = sets.filter((s) => s.name.toLowerCase().includes(set.toLowerCase()) || s.prefix.includes(set.toLowerCase())).slice(0, 8)
        throw new CommandError(
          near.length > 1 ? 'More than one set matches "' + set + '".' : 'No icon set "' + set + '".',
          near.length > 0 ? 'Did you mean: ' + near.map((s) => s.prefix).join(', ') + '?' : 'icons.list {} lists the sets.',
        )
      }
    }
    if (query === undefined && only === null) {
      return {
        count: sets.length,
        sets: sets.slice(0, limit).map((s) => ({ set: s.prefix, name: s.name, icons: s.total, license: s.license, category: s.category, ...(s.palette ? { style: 'color' } : {}), ...(s.needsCredit ? { credit: 'required' } : {}) })),
        use: 'icons.list {query: "arrow"} searches every set; add set: "lucide" for one set. icons.use {id: "lucide:arrow-right"} places an icon.',
      }
    }
    const byId = new Map(sets.map((s) => [s.prefix, s]))
    let ids: string[]
    let total: number
    if (query === undefined && only) {
      const all = await window.uve.icons.names(only.prefix)
      total = all.length
      ids = all.map((n) => only.prefix + ':' + n)
    } else {
      // Colour icons live in colour sets only: search just those, so the answer reaches deep into them.
      const colour = sets.filter((s) => s.palette).map((s) => s.prefix)
      ids = await window.uve.icons.search(query ?? '', only ? [only.prefix] : style === 'color' ? colour : null, style ? 999 : limit * 2)
      total = ids.length
    }
    const owner = (id: string) => byId.get(iconIdParts(id)?.prefix ?? '')
    // Colour sets are colour by their nature; line and solid are told apart by the icons themselves.
    let candidates = ids
    if (style === 'color') candidates = ids.filter((id) => owner(id)?.palette)
    else if (style) candidates = ids.filter((id) => owner(id)?.palette === false)
    const look = candidates.slice(0, style === 'line' || style === 'solid' ? Math.max(limit * 6, 150) : limit)
    const pictures = style === 'line' || style === 'solid' || look.length <= 60 ? await iconPictures(look) : {}
    const icons: { id: string; name: string; set: string; style?: string }[] = []
    for (const id of look) {
      const parts = iconIdParts(id)
      const set = owner(id)
      if (!parts || !set) continue
      const picture = pictures[id]
      const kind = set.palette ? 'color' : picture ? iconStyleOf(picture.body, false) : undefined
      if ((style === 'line' || style === 'solid') && kind !== style) continue
      icons.push({ id, name: iconTitle(parts.name), set: set.name, ...(kind ? { style: kind } : {}) })
      if (icons.length >= limit) break
    }
    return {
      count: total,
      showing: icons.length,
      icons,
      use: 'icons.use {id} places one as vector layers (size, color, animIn "draw").',
      ...(icons.length === 0 ? { note: 'Nothing found. Try one simple word, or another set.' } : {}),
    }
  },
})

export const iconsUse = defineCommand({
  name: 'icons.use',
  summary: 'Place an icon from icons.list as vector layers: a path layer (several, grouped, when the icon has parts painted differently), with its credit kept on the layers.',
  details:
    'id is set:name (lucide:arrow-right). size is its longer side in px (default 128); x, y place its centre in comp space (default the centre of the picture); color replaces currentColor (default #F4F2ED; icons in their own colours keep them). strokeWidth overrides a line icon\'s width, in the icon\'s own units (2 on a 24 grid). animIn "draw" draws the lines on, and works on solid icons too (a pen follows the outline); any animation preset (fade-up, pop-in…) animates the icon as one piece; animOut the same for an exit. The result names the layers; when the licence asks for credit it says what to credit. One undo step.',
  effect: 'write',
  input: z.strictObject({
    id: z.string().min(3).describe('An icon id from icons.list: set:name'),
    x: z.number().optional(),
    y: z.number().optional(),
    size: z.number().positive().max(16384).default(128),
    color: z.string().optional().describe('A colour (#rrggbb): what currentColor stands for'),
    strokeWidth: z.number().min(0).optional(),
    animIn: z.string().min(1).nullable().optional().describe('An entrance preset, such as "draw"'),
    animOut: z.string().min(1).nullable().optional(),
    name: z.string().min(1).optional(),
    compId: z.string().optional(),
    startMs: z.number().min(0).optional(),
    durationMs: z.number().positive().optional(),
  }),
  run: async ({ id, ...options }, ctx) => {
    let placement: Record<string, unknown>
    try {
      placement = await iconPlacement(id, options)
    } catch (error) {
      throw new CommandError(error instanceof Error ? error.message : String(error), 'icons.list {"query": "..."} finds icon ids.')
    }
    const placed = await ctx.call('svg.place', placement)
    if (!placed.ok) throw new CommandError(placed.error, placed.hint)
    const parts = iconIdParts(id)
    const set = parts ? (await iconSets()).find((s) => s.prefix === parts.prefix) : undefined
    return { ...(placed.value as object), icon: id, ...(set?.needsCredit && parts ? { credit: credit(set, iconTitle(parts.name)) } : {}) }
  },
})
