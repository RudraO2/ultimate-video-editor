import { CommandError, locateLayer, type MediaAsset, mediaToComp, compToMedia, type MediaTiming } from '@uve/core'
import { z } from 'zod'
import type { McpToolResult } from '../../../shared/agent'
import { mediaStills } from '../media/footageFrames'
import { session } from '../store'
import { contactSheet, DETAIL_PX, type Detail, encodePicture } from './view'

// media_inspect: the agent looks at footage with its own eyes. With no shot or
// range it shows one tile per shot (the whole file at a glance); with a shot
// or range, frames spread inside it. The words spoken there come as text, so
// an agent whose model cannot see still learns what the footage holds.

/** Tiles in one sheet at most. */
const MAX_TILES = 16

export const MediaInspectInput = z.strictObject({
  id: z.string().min(1).optional().describe('A video or audio layer (times in comp ms) or a media id (ms in the file)'),
  assetId: z.string().min(1).optional().describe("Same as id (AtomCut's name)"),
  shot: z.number().int().min(0).optional().describe('One shot (index from media_analyze): frames spread inside it'),
  fromMs: z.number().min(0).optional(),
  toMs: z.number().min(0).optional(),
  frames: z.number().int().min(0).max(MAX_TILES).default(8).describe('Tiles in the sheet; 0 answers in text only (shots and words)'),
  detail: z.enum(['glance', 'look', 'inspect']).default('look'),
})

type Timing = MediaTiming & { id: string }

function targetOf(id: string): { media: MediaAsset; layer: Timing | null } {
  const media = session.project.media.find((m) => m.id === id)
  if (media) return { media, layer: null }
  const { layer } = locateLayer(session.project, id)
  const mediaId = 'mediaId' in layer && typeof layer.mediaId === 'string' ? layer.mediaId : null
  const found = mediaId ? session.project.media.find((m) => m.id === mediaId) : undefined
  if (!found || 'sourceStartMs' in layer === false) throw new CommandError(`"${layer.name}" shows no footage.`, 'Give a video or audio layer, or a media id (media_list).')
  const l = layer as unknown as Timing
  return { media: found, layer: { id: l.id, startMs: l.startMs, durationMs: l.durationMs, sourceStartMs: l.sourceStartMs, playbackRate: l.playbackRate } }
}

export async function mediaInspect(args: z.output<typeof MediaInspectInput>): Promise<McpToolResult> {
  const ref = args.id ?? args.assetId
  if (!ref) throw new CommandError('Give id: a video or audio layer, or a media id.')
  const { media, layer } = targetOf(ref)
  if (media.kind !== 'video' && media.kind !== 'audio') throw new CommandError(`${media.name} is not footage.`, 'media_inspect looks at video and audio.')
  const duration = media.durationMs ?? 0
  const toFile = (t: number) => (layer ? compToMedia(layer, t) : t)
  const toShown = (t: number) => Math.round(layer ? mediaToComp(layer, t) : t)
  const shots = media.footage?.shots ?? [{ startMs: 0, endMs: duration, score: 0, description: null }]
  if (args.shot !== undefined && args.shot >= shots.length) throw new CommandError(`${media.name} has ${shots.length} shots; there is no shot ${args.shot}.`, 'Run media_analyze to find the shots.')
  // The stretch of the file to look at.
  let from = 0
  let to = duration
  if (args.shot !== undefined) {
    from = shots[args.shot]!.startMs
    to = shots[args.shot]!.endMs
  } else if (args.fromMs !== undefined || args.toMs !== undefined) {
    from = Math.max(0, toFile(args.fromMs ?? (layer ? layer.startMs : 0)))
    to = Math.min(duration, toFile(args.toMs ?? (layer ? layer.startMs + layer.durationMs : duration)))
  } else if (layer) {
    from = layer.sourceStartMs
    to = Math.min(duration, layer.sourceStartMs + layer.durationMs * layer.playbackRate)
  }
  if (to <= from) throw new CommandError('That stretch is empty.', `${media.name} runs 0–${Math.round(duration)} ms in the file.`)
  const inside = shots.map((s, index) => ({ ...s, index })).filter((s) => s.endMs > from && s.startMs < to)
  const words = (media.speech?.words ?? []).filter((w) => w.endMs > from && w.startMs < to)
  const info = {
    mediaId: media.id,
    name: media.name,
    times: layer ? `comp ms, through layer ${layer.id}` : 'ms from the start of the file',
    fromMs: toShown(from),
    toMs: toShown(to),
    shots: inside.map((s) => ({ index: s.index, startMs: toShown(s.startMs), endMs: toShown(s.endMs), description: s.description ?? null })),
    said: words.map((w) => w.text).join(' ') || null,
    ...(media.footage ? {} : { note: 'Not analysed yet: media_analyze finds the shots and words.' }),
  }
  if (media.kind === 'audio' || args.frames === 0) return { content: [{ type: 'text', text: JSON.stringify(info) }] }
  // One tile per shot (its middle) for an overview; frames spread inside one shot or a range.
  const overview = args.shot === undefined && args.fromMs === undefined && args.toMs === undefined && inside.length > 1
  let picks: { t: number; label: string }[]
  if (overview) {
    const step = Math.max(1, Math.ceil(inside.length / Math.min(args.frames, MAX_TILES)))
    picks = inside
      .filter((_, i) => i % step === 0)
      .map((s) => {
        const t = (Math.max(s.startMs, from) + Math.min(s.endMs, to)) / 2
        return { t, label: `shot ${s.index} · ${(toShown(t) / 1000).toFixed(1)} s` }
      })
  } else {
    const n = Math.max(1, args.frames)
    picks = Array.from({ length: n }, (_, i) => {
      const t = from + ((to - from) * (i + 0.5)) / n
      return { t, label: `${(toShown(t) / 1000).toFixed(2)} s` }
    })
  }
  const longSide = DETAIL_PX[args.detail as Detail]
  const columns = Math.ceil(Math.sqrt(picks.length))
  const stills = await mediaStills(media.path, picks.map((p) => p.t), Math.max(160, longSide / columns))
  const picture = await encodePicture(
    contactSheet(
      stills,
      picks.map((p) => toShown(p.t)),
      longSide,
      picks.map((p) => p.label),
    ),
  )
  return {
    content: [
      { type: 'image', data: picture.data, mimeType: picture.mimeType },
      { type: 'text', text: JSON.stringify({ ...info, tiles: picks.map((p) => p.label) }) },
    ],
  }
}
