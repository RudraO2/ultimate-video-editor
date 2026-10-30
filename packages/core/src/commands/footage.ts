import { z } from 'zod'
import { findComp, findMedia } from '../doc'
import { CommandError } from '../errors'
import { defineCommand } from '../registry'
import { FootageInfoSchema, IdSchema, MARKER_KINDS } from '../schema'

// What footage holds (speech gate, speech ranges, shots) is read once by the
// desktop's media.analyze and kept on the media here, so later cuts, searches
// and B-roll reuse it. Markers are review marks on a comp's ruler.

export const mediaFootage = defineCommand({
  name: 'media.footage',
  summary: 'Keep what a piece of footage holds on its media: the speech gate, where the voice is and the shots (media_analyze does this for you).',
  details:
    'footage: {gate: {gateDb, troughDb, peakDb} | null, speech: [{startMs, endMs}], sceneThreshold, shots: [{startMs, endMs, score, description}]}, ms from the start of the file; null clears it.',
  effect: 'write',
  input: z.strictObject({ mediaId: IdSchema, footage: z.union([FootageInfoSchema, z.null()]) }),
  run: ({ mediaId, footage }, ctx) => {
    const media = findMedia(ctx.project, mediaId)
    if (media.kind !== 'audio' && media.kind !== 'video') throw new CommandError(`${media.name} is not footage.`, 'Give a video or audio media id (media.list).')
    if (footage) {
      for (const [name, spans] of [['speech', footage.speech], ['shots', footage.shots]] as const) {
        let last = 0
        for (const [i, span] of spans.entries()) {
          if (span.endMs < span.startMs || span.startMs < last - 1) throw new CommandError(`${name}[${i}] is out of order or ends before it starts.`, 'Spans are in time order and do not overlap.')
          last = span.endMs
        }
      }
    }
    ctx.write(footage ? 'Read footage' : 'Clear footage', (draft) => {
      const target = draft.media.find((m) => m.id === mediaId)
      if (!target) return
      if (footage) target.footage = footage
      else delete target.footage
    })
    return { mediaId, speech: footage?.speech.length ?? 0, shots: footage?.shots.length ?? 0 }
  },
})

export const mediaDescribeShots = defineCommand({
  name: 'media.describe_shots',
  summary: 'Write a one-line description of what each shot of a piece of footage shows, so footage search finds it.',
  details:
    'After looking at the shots (media_inspect shows a contact sheet per shot), give shots: [{index, description}] (index from media_analyze; null clears one). Descriptions say what is seen: who, what, where, any text on screen, the camera ("close-up of hands typing on a laptop, dark room").',
  effect: 'write',
  input: z.strictObject({
    mediaId: IdSchema,
    shots: z
      .array(z.strictObject({ index: z.number().int().min(0), description: z.string().max(300).nullable() }))
      .min(1)
      .max(500),
  }),
  run: ({ mediaId, shots }, ctx) => {
    const media = findMedia(ctx.project, mediaId)
    const count = media.footage?.shots.length ?? 0
    if (count === 0) throw new CommandError(`${media.name} has no shots yet.`, 'Run media_analyze on it first.')
    for (const shot of shots) {
      if (shot.index >= count) throw new CommandError(`${media.name} has ${count} shot${count === 1 ? '' : 's'}; there is no shot ${shot.index}.`, 'Shot indexes start at 0 (media_analyze lists them).')
    }
    ctx.write('Describe shots', (draft) => {
      const target = draft.media.find((m) => m.id === mediaId)?.footage
      if (!target) return
      for (const { index, description } of shots) target.shots[index]!.description = description?.trim() || null
    })
    return { mediaId, described: shots.filter((s) => s.description?.trim()).length }
  },
})

const MarkerInputSchema = z.strictObject({
  startMs: z.number().min(0).describe('Comp ms'),
  endMs: z.number().min(0).optional().describe('Comp ms; leave out for a moment'),
  kind: z.enum(MARKER_KINDS).default('note').describe('cut: a planned cut; flag: for a person to check; note: anything else'),
  label: z.string().max(300).default(''),
})

export const timelineMarkers = defineCommand({
  name: 'timeline.markers',
  summary: "Put review marks on a comp's ruler (planned cuts, flags for a person, notes), remove them, or list them.",
  details:
    'add: [{startMs, endMs?, kind: "cut" | "flag" | "note", label}] in comp ms. remove: marker ids, or "all", or a kind ("cut") to clear that kind. Removing runs before adding, so remove "cut" with new cuts replaces a plan. With neither, lists the markers. media_remove_pauses {markers: true} marks its plan this way.',
  effect: 'write',
  input: z.strictObject({
    compId: IdSchema.optional().describe('Default: the first comp'),
    add: z.array(MarkerInputSchema).max(500).optional(),
    remove: z.union([z.array(IdSchema), z.literal('all'), z.enum(MARKER_KINDS)]).optional(),
  }),
  run: ({ compId, add, remove }, ctx) => {
    const comp = compId ? findComp(ctx.project, compId) : ctx.project.comps[0]
    if (!comp) throw new CommandError('The project has no comp.')
    for (const m of add ?? []) {
      if (m.endMs !== undefined && m.endMs < m.startMs) throw new CommandError(`A marker at ${m.startMs} ms ends before it starts.`)
    }
    if (Array.isArray(remove)) {
      const missing = remove.find((id) => !comp.markers.some((m) => m.id === id))
      if (missing) throw new CommandError(`${comp.name} has no marker ${missing}.`, 'timeline_markers with no add or remove lists them.')
    }
    const added: string[] = []
    if (add || remove) {
      ctx.write(add ? 'Add markers' : 'Remove markers', (draft) => {
        const target = findComp(draft, comp.id)
        if (remove === 'all') target.markers = []
        else if (Array.isArray(remove)) target.markers = target.markers.filter((m) => !remove.includes(m.id))
        else if (remove) target.markers = target.markers.filter((m) => m.kind !== remove)
        for (const m of add ?? []) {
          const id = ctx.ids('marker')
          added.push(id)
          target.markers.push({ id, startMs: Math.round(m.startMs), durationMs: Math.round((m.endMs ?? m.startMs) - m.startMs), kind: m.kind, label: m.label })
        }
        target.markers.sort((a, b) => a.startMs - b.startMs)
      })
    }
    const markers = findComp(ctx.project, comp.id).markers
    return { compId: comp.id, ...(added.length > 0 ? { added } : {}), markers }
  },
})
