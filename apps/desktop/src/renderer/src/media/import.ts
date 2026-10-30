import { type CommandResult, findComp, isWorld, laneIsFree, type MediaAsset } from '@uve/core'
import type { GrantedFile } from '../../../shared/media'
import { run, session, useEditor } from '../store'
import { ProbeError, type ProbedMedia, probeMedia } from './probe'

/** Where imported files go on the timeline. Without one they are only added to the library. */
export interface Placement {
  compId: string
  startMs: number
  /** The track for the first file, when it has room there; otherwise each file gets a new track. */
  trackId?: string
  /** Where pictures are centred, in comp space. */
  x?: number
  y?: number
}

/** How long a still image stays on screen when it is dropped onto a comp. */
export const IMAGE_DURATION_MS = 5000

export type MediaInput = Pick<MediaAsset, 'kind' | 'name' | 'path' | 'durationMs'> & Partial<MediaAsset>

/** The fields media.add takes, leaving out the ones that are not known. */
export function mediaInput(media: ProbedMedia | MediaAsset): MediaInput {
  const { kind, name, path, mime, durationMs, width, height, fps, hasAudio, model, silhouette } = media
  const fields = { kind, name, path, mime, durationMs, width, height, fps, hasAudio, model, silhouette }
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as unknown as MediaInput
}

function value<T>(result: CommandResult): T {
  if (!result.ok) throw new Error(result.error)
  return result.value as T
}

/** The layer.create input that puts media on the timeline at `startMs`, and how long the layer will be. */
export function layerInput(media: MediaInput, mediaId: string, placement: Placement, startMs: number, trackId?: string) {
  const durationMs = media.kind === 'image' ? IMAGE_DURATION_MS : undefined
  const span = durationMs ?? media.durationMs ?? IMAGE_DURATION_MS
  const track = trackId === undefined ? undefined : findComp(session.project, placement.compId).tracks.find((t) => t.id === trackId)
  const centred = media.kind !== 'audio' && (placement.x !== undefined || placement.y !== undefined)
  // A model is placed as a mesh (kind media reads the asset); a flat comp refuses it.
  const model = media.kind === 'model'
  const input = {
    compId: placement.compId,
    ...(model ? { kind: 'media', assetId: mediaId } : { kind: media.kind, mediaId }),
    startMs,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(track && laneIsFree(track, startMs, startMs + span) ? { trackId: track.id } : {}),
    ...(centred ? { transform: { x: placement.x ?? 0, y: placement.y ?? 0 } } : {}),
  }
  return { input, span }
}

/** Puts a library item on the timeline as one undo step, and selects the new layer. */
export async function placeMedia(media: MediaAsset, placement: Placement): Promise<string | null> {
  const { input } = layerInput(media, media.id, placement, placement.startMs, placement.trackId)
  const result = await run('layer.create', input)
  if (!result.ok) return null
  const { id } = result.value as { id: string }
  useEditor.getState().select(id)
  return id
}

/**
 * Imports granted files: reads each one, registers it with media.add and, with
 * a placement, puts it on the timeline. Files are placed one after another,
 * each starting where the previous one ends. The whole import is one undo
 * step. Returns the ids of the new layers.
 */
export async function importFiles(files: readonly GrantedFile[], placement?: Placement): Promise<string[]> {
  const { notify } = useEditor.getState()
  const known = new Map(session.project.media.map((m) => [m.path, m]))
  const ready: MediaInput[] = []
  const problems: string[] = []
  for (const file of files) {
    const existing = known.get(file.path)
    if (existing) {
      ready.push(mediaInput(existing))
      continue
    }
    try {
      const probed = await probeMedia(file)
      if (probed.thumbnail) {
        const thumbnail = probed.thumbnail
        useEditor.setState((s) => ({ thumbnails: { ...s.thumbnails, [probed.path]: thumbnail } }))
      }
      ready.push(mediaInput(probed))
    } catch (error) {
      problems.push(error instanceof ProbeError ? error.message : `Could not read "${file.name}".`)
      if (!(error instanceof ProbeError)) console.error(error)
    }
  }
  if (ready.length === 0) {
    if (problems.length > 0) notify(problems.join(' '), 'error')
    return []
  }

  const models: string[] = []
  const label = ready.length === 1 ? `Import ${ready[0]?.name}` : `Import ${ready.length} files`
  const layerIds: string[] = []
  try {
    await session.transact(label, async (call) => {
      let cursor = placement?.startMs ?? 0
      let trackId = placement?.trackId
      for (const media of ready) {
        const { id: mediaId } = value<{ id: string }>(await call('media.add', media))
        if (media.kind === 'model') {
          // A model goes into the open world at the origin; a flat comp only gets it in the library.
          const state = useEditor.getState()
          const comp = findComp(session.project, placement?.compId ?? state.activeCompId)
          if (!isWorld(comp)) {
            models.push(media.name)
            continue
          }
          const added = value<{ id: string }>(await call('world.add', { compId: comp.id, kind: 'mesh', assetId: mediaId, startMs: placement?.startMs ?? state.timeMs }))
          layerIds.push(added.id)
          continue
        }
        if (!placement) continue
        const { input, span } = layerInput(media, mediaId, placement, cursor, trackId)
        const created = value<{ id: string; trackId: string }>(await call('layer.create', input))
        layerIds.push(created.id)
        trackId = created.trackId
        cursor += span
      }
    })
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error), 'error')
    return []
  }

  const last = layerIds.at(-1)
  if (last) useEditor.getState().select(last)
  const what = placement ? `Placed ${ready.length} file${ready.length === 1 ? '' : 's'}` : `Added ${ready.length} file${ready.length === 1 ? '' : 's'} to the library`
  const flat = models.length > 0 ? ` ${models.join(', ')} goes into a 3D world: open one (File ▸ New 3D world) and place it from the library.` : ''
  notify(problems.length > 0 ? `${what}. ${problems.join(' ')}${flat}` : `${what}.${flat}`, problems.length > 0 ? 'error' : 'info')
  return layerIds
}

/** Grants the files of an OS drop and imports them. Files that are not media are reported, not imported. */
export async function importDrop(dataTransfer: DataTransfer, placement?: Placement): Promise<string[]> {
  const files = [...dataTransfer.files]
  if (files.length === 0) return []
  const granted = await window.uve.media.grantFiles(files)
  const skipped = files.length - granted.length
  if (skipped > 0 && granted.length === 0) {
    useEditor.getState().notify('Those files are not video, images, audio or 3D models this editor imports.', 'error')
    return []
  }
  if (skipped > 0) useEditor.getState().notify(`Skipped ${skipped} file${skipped === 1 ? '' : 's'} that are not media.`)
  return importFiles(granted, placement)
}

/** Whether a drag carries files from the operating system. */
export function dragHasFiles(dataTransfer: DataTransfer | null): boolean {
  return dataTransfer?.types.includes('Files') ?? false
}

/** The drag type the library uses for its media items; the data is the media id. */
export const MEDIA_DRAG_TYPE = 'application/x-uve-media'

/** The drag type of the library's stickers; the data is the sticker id. */
export const STICKER_DRAG_TYPE = 'application/x-uve-sticker'
