import { type CommandResult, CommandError, defineCommand } from '@uve/core'
import { z } from 'zod'
import { mediaUrl } from '../../../shared/media'
import { STICKER_SOURCES, STICKER_STYLES, type StickerSourceId } from '../../../shared/stickers'
import { findStickers, STICKER_DURATION_MS, type StickerPlace, stickerIndex, stickerSize, useSticker } from '../library/stickers'

// Stickers for agents: find a picture by what it shows (stickers.list), make it
// project media and place it (stickers.use). The pictures are free libraries
// mirrored on this computer; see shared/stickers.ts.

const SOURCE_IDS = Object.keys(STICKER_SOURCES) as [StickerSourceId, ...StickerSourceId[]]

export const stickersList = defineCommand({
  name: 'stickers.list',
  summary:
    'Find a sticker: free transparent pictures on this computer (Fluent Emoji in 3D and flat, about 1,600 each: faces, hands, hearts, food, animals, objects, symbols; Open Peeps people and Open Doodles scenes, hand-drawn), searched by what they show.',
  details:
    'query: words that must all match the name or a tag ("heart", "thumbs up", "rocket", "party popper"); #word requires a tag ("#3d", "#drawn"). style: 3d (soft rendered, reads best in motion), flat (colour vector, sharp at any size) or drawn (black-line illustrations). 3D stickers are 256 px pictures: keep them at most about 300 px on screen; flat and drawn ones are vectors and stay sharp at any size. Each result has an id for stickers.use, its name, style and tags. count is how many matched; page with offset.',
  effect: 'read',
  input: z.strictObject({
    query: z.string().optional(),
    style: z.enum(STICKER_STYLES).optional(),
    source: z.enum(SOURCE_IDS).optional(),
    limit: z.number().int().min(1).max(100).default(30),
    offset: z.number().int().min(0).default(0),
  }),
  run: async ({ query, style, source, limit, offset }) => {
    const { count, results } = await findStickers({ query, style, source }, limit, offset)
    return {
      count,
      showing: results.length,
      stickers: results.map((s) => ({ id: s.id, name: s.name, style: s.style, ...(s.glyph ? { glyph: s.glyph } : {}), tags: s.tags.slice(0, 8) })),
      ...(count === 0 ? { note: 'Nothing matches. Use fewer words, or a plainer one ("heart", "hand", "star").' } : {}),
    }
  },
})

export const stickersUse = defineCommand({
  name: 'stickers.use',
  summary: 'Make a sticker from stickers.list project media (with its credit) and, with place, put it on the timeline as an image layer.',
  details: `Without place it is only added to the media library (layer_create {kind: "media", assetId} places it later). place: compId (default the open comp), startMs (default the playhead), durationMs (default ${STICKER_DURATION_MS}), x and y (comp space, centre origin), size (its long side in px). The same sticker used twice is one media item. Returns mediaId, layerId when placed, the picture's width and height, and the credit. layers: true (flat or drawn stickers) places the SVG as nested named groups of path layers instead of an image (an Open Peeps person: body, head, face, accessories; Fluent Emoji: its parts); the result has ids, groupId, tree. Give it an entrance: animation_set {slot: "in", preset: "pop-in"} and a pop on its sounds stack.`,
  effect: 'write',
  input: z.strictObject({
    id: z.string().min(1).describe('An id from stickers.list'),
    name: z.string().min(1).optional().describe('The layer and media name; default the sticker name'),
    place: z
      .strictObject({
        compId: z.string().optional(),
        startMs: z.number().min(0).optional(),
        durationMs: z.number().positive().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        size: z.number().positive().optional().describe('Long side in px'),
      })
      .optional(),
    layers: z
      .boolean()
      .default(false)
      .describe('Flat or drawn stickers only: place the SVG as separate named layers, one group per part (Open Peeps: body, head, face, accessories), instead of one picture. Always places; place is optional'),
  }),
  run: async ({ id, name, place, layers }, ctx) => {
    const call = (cmd: string, input: unknown) => ctx.call(cmd, input)
    if (!layers) return useSticker(id, { ...(name ? { name } : {}), ...(place ? { place } : {}) }, ctx.project.media, call)
    return placeStickerLayers(id, name, place ?? {}, call)
  },
})

/** A sticker's SVG as separate layers (svg.place with groups): the parts of a drawn character become named groups. */
async function placeStickerLayers(id: string, name: string | undefined, place: StickerPlace, call: (cmd: string, input: unknown) => Promise<CommandResult>) {
  const sticker = (await stickerIndex()).find((s) => s.id === id)
  if (!sticker) throw new CommandError(`No sticker "${id}".`, 'Use an id from stickers.list.')
  if (sticker.style === '3d' || !/\.svg$/i.test(sticker.path)) {
    throw new CommandError(`"${sticker.name}" is a 3D sticker, a picture that has no parts.`, '3D stickers are pictures; use a flat or drawn one (stickers.list {style: "flat"} or {style: "drawn"}).')
  }
  const response = await fetch(mediaUrl(sticker.path)).catch(() => null)
  if (!response?.ok) throw new CommandError(`The picture of "${sticker.name}" could not be read.`, 'The sticker library may have moved; stickers.list shows what is available.')
  const source = STICKER_SOURCES[sticker.source]
  const author = /\bby (.+?) \(/.exec(source.attribution)?.[1] ?? source.title
  const placed = await call('svg.place', {
    svg: await response.text(),
    groups: true,
    name: name ?? sticker.name,
    x: place.x ?? 0,
    y: place.y ?? 0,
    size: place.size ?? stickerSize(sticker.style),
    ...(place.compId ? { compId: place.compId } : {}),
    ...(place.startMs === undefined ? {} : { startMs: place.startMs }),
    durationMs: place.durationMs ?? STICKER_DURATION_MS,
    origin: { kind: 'icon', id: `${sticker.source}:${sticker.id.split('/').pop()}`, license: source.license, author },
  })
  if (!placed.ok) throw new CommandError(placed.error, placed.hint)
  const result = placed.value as { ids: string[]; groupId: string | null }
  return { ...result, layerId: result.groupId ?? result.ids[0], credit: source.attribution }
}
