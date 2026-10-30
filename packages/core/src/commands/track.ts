import { z } from 'zod'
import { findComp, locateTrack, newTrack } from '../doc'
import { CommandError } from '../errors'
import { groupAtInsert } from '../groups'
import { defineCommand } from '../registry'
import { IdSchema } from '../schema'

export const trackCreate = defineCommand({
  name: 'track.create',
  summary: 'Add an empty track (lane) to a comp.',
  details: 'index counts from the front: 0 (the default) puts the track in front of every other track. A track inserted in front of a lane of a group joins that group.',
  effect: 'write',
  input: z.strictObject({
    compId: IdSchema.optional(),
    index: z.number().int().min(0).default(0),
    name: z.string().min(1).optional(),
  }),
  run: ({ compId, index, name }, ctx) => {
    const comp = findComp(ctx.project, compId)
    const at = Math.min(index, comp.tracks.length)
    const track = newTrack(ctx.ids('track'), [], name, groupAtInsert(comp, at))
    ctx.write('Create track', (draft) => {
      findComp(draft, comp.id).tracks.splice(at, 0, track)
    })
    return { id: track.id, compId: comp.id, index: at }
  },
})

export const trackDelete = defineCommand({
  name: 'track.delete',
  summary: 'Delete an empty track.',
  effect: 'write',
  input: z.strictObject({ id: IdSchema }),
  run: ({ id }, ctx) => {
    const { comp, track } = locateTrack(ctx.project, id)
    if (track.layers.length > 0) {
      throw new CommandError(
        `Track "${track.id}" still has ${track.layers.length} layer${track.layers.length === 1 ? '' : 's'}.`,
        'Move them with timeline.move or delete them with layers.delete first.',
      )
    }
    ctx.write('Delete track', (draft) => {
      const target = findComp(draft, comp.id)
      target.tracks = target.tracks.filter((t) => t.id !== track.id)
    })
    return { deleted: track.id }
  },
})

export const trackUpdate = defineCommand({
  name: 'track.update',
  summary: 'Rename a track, or hide, mute or lock it.',
  details:
    'hidden hides every layer on the track and muted silences it, in the preview and in exports. locked stops edits by hand in the editor; commands still apply.',
  effect: 'write',
  input: z.strictObject({
    id: IdSchema,
    name: z.string().min(1).optional(),
    hidden: z.boolean().optional(),
    muted: z.boolean().optional(),
    locked: z.boolean().optional(),
  }),
  run: ({ id, ...changes }, ctx) => {
    const { comp, track } = locateTrack(ctx.project, id)
    if (Object.values(changes).every((v) => v === undefined)) {
      throw new CommandError('Nothing to change.', 'Pass name, hidden, muted or locked.')
    }
    ctx.write('Edit track', (draft) => {
      const target = findComp(draft, comp.id).tracks.find((t) => t.id === track.id)
      if (!target) return
      for (const [key, value] of Object.entries(changes)) if (value !== undefined) Object.assign(target, { [key]: value })
    })
    return { id: track.id }
  },
})
