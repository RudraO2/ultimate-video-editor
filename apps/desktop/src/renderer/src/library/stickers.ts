import { type CommandResult, CommandError, findComp, type MediaAsset } from '@uve/core'
import { STICKER_SOURCES, type Sticker, type StickerFilter, searchStickers } from '../../../shared/stickers'
import { mediaInput } from '../media/import'
import { probeMedia } from '../media/probe'
import { run, session, useEditor } from '../store'

// The sticker library on the renderer side: the main process's index (asked
// once per run), search, and making a sticker project media and a layer.

let index: Promise<Sticker[]> | null = null

/** Every sticker of the library, asked once; a failed ask is retried next time. */
export function stickerIndex(): Promise<Sticker[]> {
  index ??= window.uve.stickers.index().catch((error: unknown) => {
    index = null
    throw error
  })
  return index
}

/** The stickers matching a filter, best first, and how many matched. */
export async function findStickers(filter: StickerFilter, limit: number, offset = 0): Promise<{ count: number; results: Sticker[] }> {
  const found = searchStickers(await stickerIndex(), filter)
  return { count: found.length, results: found.slice(offset, offset + limit) }
}

type Call = (name: string, input: unknown) => Promise<CommandResult>

/** Where a sticker goes: the comp, start and length, centre, and its long side in px. */
export interface StickerPlace {
  compId?: string
  startMs?: number
  durationMs?: number
  x?: number
  y?: number
  size?: number
}

/** How long a sticker stays when no length is given. */
export const STICKER_DURATION_MS = 3000

/** The long side, in px, a sticker gets when placed by hand: 3D ones are 256 px pictures, the vectors can be larger. */
export const stickerSize = (style: string): number => (style === '3d' ? 240 : 360)

/**
 * Places a sticker by hand (click or drop) as one undo step and selects its
 * layer; a failure is shown as a notice. The style is read from the id.
 */
export async function placeSticker(id: string, place: StickerPlace = {}): Promise<string | null> {
  const style = id.split('/')[1] ?? ''
  const result = await run('stickers.use', { id, place: { size: stickerSize(style), ...place } })
  const { select, notify } = useEditor.getState()
  if (!result.ok) {
    notify(result.error)
    return null
  }
  const layerId = (result.value as { layerId?: string }).layerId
  if (layerId) select(layerId)
  return layerId ?? null
}

function value<T>(result: CommandResult): T {
  if (!result.ok) throw new CommandError(result.error, result.hint)
  return result.value as T
}

/**
 * Makes a sticker project media (once: a file already in the project is
 * reused) with its source's credit and, with a place, puts it on the timeline.
 * Returns the media id and, when placed, the layer id.
 */
export async function useSticker(
  id: string,
  options: { name?: string; place?: StickerPlace },
  media: readonly MediaAsset[],
  call: Call,
): Promise<{ mediaId: string; layerId?: string; width: number; height: number; credit: string }> {
  const sticker = (await stickerIndex()).find((s) => s.id === id)
  if (!sticker) throw new CommandError(`No sticker "${id}".`, 'Use an id from stickers.list.')
  const source = STICKER_SOURCES[sticker.source]
  let asset = media.find((m) => m.path === sticker.path)
  if (!asset) {
    const probed = await probeMedia({ path: sticker.path, name: sticker.path.split(/[\\/]/).pop() ?? sticker.name, size: 0 })
    const thumbnail = probed.thumbnail
    if (thumbnail) useEditor.setState((s) => ({ thumbnails: { ...s.thumbnails, [probed.path]: thumbnail } }))
    const added = value<{ id: string }>(
      await call('media.add', {
        ...mediaInput(probed),
        name: options.name ?? sticker.name,
        credit: { source: `${source.title} ▸ ${sticker.name}`, license: source.license, attribution: source.attribution },
      }),
    )
    asset = { ...(mediaInput(probed) as MediaAsset), id: added.id }
  }
  const width = asset.width ?? 512
  const height = asset.height ?? 512
  const out = { mediaId: asset.id, width, height, credit: source.attribution }
  const place = options.place
  if (!place) return out
  const compId = place.compId ?? useEditor.getState().activeCompId
  const comp = findComp(session.project, compId)
  const scale = place.size !== undefined ? place.size / Math.max(width, height) : 1
  const created = value<{ id: string }>(
    await call('layer.create', {
      compId: comp.id,
      kind: 'image',
      mediaId: asset.id,
      name: options.name ?? sticker.name,
      startMs: place.startMs ?? useEditor.getState().timeMs,
      durationMs: place.durationMs ?? STICKER_DURATION_MS,
      transform: { x: place.x ?? 0, y: place.y ?? 0, ...(scale !== 1 ? { scaleX: scale, scaleY: scale } : {}) },
    }),
  )
  return { ...out, layerId: created.id }
}
