import type { CallOptions, CommandResult } from '@uve/core'
import { type IconData, type IconSet, iconIdParts, iconSvg, iconTitle } from '../../../shared/icons'
import { session } from '../store'

// Icons for the renderer: the sets, searches and pictures the main process
// keeps on disk, and placing one in a comp as vector layers.

let setsPromise: Promise<IconSet[]> | null = null

/** Every set that may be offered (cached by the main process). A failure is not remembered. */
export function iconSets(): Promise<IconSet[]> {
  setsPromise ??= window.uve.icons.sets().catch((error: unknown) => {
    setsPromise = null
    throw error
  })
  return setsPromise
}

const pictures = new Map<string, IconData | null>()

/** The pictures of icons by id (set:name), asking the main process only for the ones not seen yet. */
export async function iconPictures(ids: readonly string[]): Promise<Record<string, IconData | null>> {
  const unknown = ids.filter((id) => !pictures.has(id))
  if (unknown.length > 0) {
    const fetched = await window.uve.icons.data(unknown)
    for (const id of unknown) {
      // An icon that came back empty may be offline: ask again next time rather than keep the miss.
      const picture = fetched[id] ?? null
      if (picture) pictures.set(id, picture)
    }
  }
  return Object.fromEntries(ids.map((id) => [id, pictures.get(id) ?? null]))
}

export interface PlaceIconOptions {
  x?: number
  y?: number
  /** The longer side of the icon, px. */
  size?: number
  color?: string
  /** Replaces the set's line width, in the icon's own units. */
  strokeWidth?: number
  animIn?: string | null
  animOut?: string | null
  name?: string
  compId?: string
  startMs?: number
  durationMs?: number
}

export const DEFAULT_ICON_COLOR = '#F4F2ED'

/** The svg.place input that places an icon with its credit. Throws a message fit for the user when the icon is unknown or cannot be fetched. */
export async function iconPlacement(id: string, options: PlaceIconOptions = {}): Promise<Record<string, unknown>> {
  const parts = iconIdParts(id)
  if (!parts) throw new Error('"' + id + '" is not an icon id: use set:name, such as lucide:arrow-right.')
  const [sets, pictureOf] = await Promise.all([iconSets(), iconPictures([id])])
  const set = sets.find((s) => s.prefix === parts.prefix)
  if (!set) throw new Error('The icon set "' + parts.prefix + '" is not offered here; icons.list {} lists the sets.')
  const picture = pictureOf[id]
  if (!picture) throw new Error('The icon "' + id + '" could not be fetched: it may not exist in the set, or the icon server is out of reach and it was never fetched before.')
  return {
    svg: iconSvg(picture, { size: 24 }),
    name: options.name ?? iconTitle(parts.name),
    size: options.size ?? 128,
    color: options.color ?? DEFAULT_ICON_COLOR,
    ...(options.x === undefined ? {} : { x: options.x }),
    ...(options.y === undefined ? {} : { y: options.y }),
    ...(options.strokeWidth === undefined ? {} : { strokeWidth: options.strokeWidth }),
    ...(options.animIn === undefined ? {} : { animIn: options.animIn }),
    ...(options.animOut === undefined ? {} : { animOut: options.animOut }),
    ...(options.compId === undefined ? {} : { compId: options.compId }),
    ...(options.startMs === undefined ? {} : { startMs: options.startMs }),
    ...(options.durationMs === undefined ? {} : { durationMs: options.durationMs }),
    origin: { kind: 'icon', id, license: set.license, author: set.author },
  }
}

/** Places an icon in the open comp (or `compId`) as vector layers: one undo step. Throws a message fit for the user. */
export async function placeIcon(id: string, options: PlaceIconOptions = {}, call: CallOptions = {}): Promise<CommandResult> {
  return session.call('svg.place', await iconPlacement(id, options), call)
}
