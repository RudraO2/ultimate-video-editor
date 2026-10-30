import { current } from 'immer'
import { z } from 'zod'
import { pruneTransitions } from './transition'
import { deepClone } from '../clone'
import { assertLaneFree, findMedia, findTrack, layerEnd, locateLayer, newTrack, shiftKeys, sortLane } from '../doc'
import { CommandError } from '../errors'
import { groupDescendants } from '../groups'
import { defineCommand } from '../registry'
import { IdSchema, type Layer, type Track } from '../schema'

/** A looping nested layer's clock starts at its start, so moving the start (a trim or the right part of a split) would change what it shows. */
function assertNestedStartMovable(layer: Extract<Layer, { kind: 'nested' }>): void {
  if (layer.playback.loop !== 'none') {
    throw new CommandError(`"${layer.name}" loops, and its loop starts at its start: cutting or trimming its start would restart the loop.`, 'Trim its end instead, or set playback.loop to "none" first (layer.patch).')
  }
}

export const timelineMove = defineCommand({
  name: 'timeline.move',
  summary: 'Move a layer in time, to another track, or both.',
  details:
    'startMs is comp time. trackId "new" puts the layer on a new track just in front of its current one (in the same group). Moving a group moves everything in it; a group keeps its lane. Moving a layer onto a lane of a group puts it in that group. Layers on one track never overlap, so the move fails when the place is taken.',
  effect: 'write',
  input: z
    .object({ id: IdSchema, startMs: z.number().min(0).optional(), trackId: IdSchema.optional() })
    .refine((v) => v.startMs !== undefined || v.trackId !== undefined, 'Give startMs, trackId or both'),
  run: ({ id, startMs, trackId }, ctx) => {
    const { layer, comp } = locateLayer(ctx.project, id)
    const start = startMs ?? layer.startMs
    if (layer.kind === 'group') {
      if (trackId !== undefined) throw new CommandError('A group keeps its own lane.', 'Move it in time with startMs; to restack it, group or ungroup.')
      const delta = start - layer.startMs
      const inside = groupDescendants(comp, layer.id)
      for (const member of inside) {
        const lane = comp.tracks.find((t) => t.layers.some((l) => l.id === member.id)) as Track
        if (member.startMs + delta < 0) throw new CommandError(`That would move "${member.name}" before 0 ms.`)
        assertLaneFree(lane, member.startMs + delta, layerEnd(member) + delta, member.id)
      }
      ctx.write('Move group', (draft) => {
        for (const ref of [layer, ...inside]) locateLayer(draft, ref.id).layer.startMs += delta
      })
      return { id: layer.id, startMs: start, moved: inside.length }
    }
    let landedOn = ''
    ctx.write('Move layer', (draft) => {
      const location = locateLayer(draft, layer.id)
      let target = location.track
      if (trackId === 'new') {
        const fresh = newTrack(ctx.ids('track'), [], undefined, location.track.groupId)
        location.comp.tracks.splice(location.trackIndex, 0, fresh)
        target = fresh
      } else if (trackId !== undefined) {
        target = findTrack(location.comp, trackId)
      }
      assertLaneFree(target, start, start + layer.durationMs, layer.id)
      const moved: Layer = { ...current(location.layer), startMs: start }
      location.track.layers.splice(location.layerIndex, 1)
      target.layers.push(moved)
      sortLane(target)
      landedOn = target.id
      // A transition stays with its lane: off it, the layer leaves the transitions it had.
      if (target !== location.track) pruneTransitions(draft)
    })
    return { id: layer.id, startMs: start, trackId: landedOn }
  },
})

export const timelineTrim = defineCommand({
  name: 'timeline.trim',
  summary: 'Change where a layer starts and/or ends in comp time, keeping its content in place.',
  details:
    'Trimming the start of a video or audio layer also moves its source in point, so the picture stays put in comp time, and keys stay at the same comp times. A media layer cannot reach past either end of its source.',
  effect: 'write',
  input: z
    .object({ id: IdSchema, startMs: z.number().min(0).optional(), endMs: z.number().positive().optional() })
    .refine((v) => v.startMs !== undefined || v.endMs !== undefined, 'Give startMs, endMs or both'),
  run: ({ id, startMs, endMs }, ctx) => {
    const { layer, track } = locateLayer(ctx.project, id)
    const start = startMs ?? layer.startMs
    const end = endMs ?? layerEnd(layer)
    if (end <= start) throw new CommandError(`The end (${end} ms) must come after the start (${start} ms).`)
    const delta = start - layer.startMs

    let sourceStart: number | undefined
    if (layer.kind === 'video' || layer.kind === 'audio') {
      const rate = layer.playbackRate
      sourceStart = layer.sourceStartMs + delta * rate
      if (sourceStart < -0.5) {
        throw new CommandError(
          'The source media does not reach back that far.',
          `The earliest start is ${layer.startMs - layer.sourceStartMs / rate} ms.`,
        )
      }
      sourceStart = Math.max(0, sourceStart)
      const media = findMedia(ctx.project, layer.mediaId)
      if (media.durationMs !== undefined && sourceStart + (end - start) * rate > media.durationMs + 0.5) {
        throw new CommandError(
          'The source media ends before that.',
          `The latest end is ${start + (media.durationMs - sourceStart) / rate} ms.`,
        )
      }
    }
    if (layer.kind === 'nested' && delta !== 0) assertNestedStartMovable(layer)
    if (layer.kind === 'nested' && layer.trimInMs + delta * layer.playback.speed < -0.5) {
      throw new CommandError('The nested comp does not reach back that far.', `The earliest start is ${layer.startMs - layer.trimInMs / layer.playback.speed} ms.`)
    }
    assertLaneFree(track, start, end, layer.id)

    ctx.write('Trim layer', (draft) => {
      const location = locateLayer(draft, layer.id)
      const target = location.layer
      target.startMs = start
      target.durationMs = end - start
      if ((target.kind === 'video' || target.kind === 'audio') && sourceStart !== undefined) {
        target.sourceStartMs = sourceStart
      }
      if (target.kind === 'nested') target.trimInMs = Math.max(0, target.trimInMs + delta * target.playback.speed)
      shiftKeys(target, -delta)
      sortLane(location.track)
    })
    return { id: layer.id, startMs: start, endMs: end }
  },
})

export const timelineSplit = defineCommand({
  name: 'timeline.split',
  summary: 'Cut a layer in two at a comp time. The left part keeps the id.',
  effect: 'write',
  input: z.strictObject({ id: IdSchema, atMs: z.number() }),
  run: ({ id, atMs }, ctx) => {
    const { layer } = locateLayer(ctx.project, id)
    if (layer.kind === 'group') throw new CommandError('A group cannot be split.', 'Split the layers in it, or trim the group to show part of them.')
    if (atMs <= layer.startMs || atMs >= layerEnd(layer)) {
      throw new CommandError(`${atMs} ms is not inside "${layer.name}" (${layer.startMs}–${layerEnd(layer)} ms).`)
    }
    const offset = atMs - layer.startMs
    const right = deepClone(layer) as Layer
    right.id = ctx.ids('layer')
    right.startMs = atMs
    right.durationMs = layerEnd(layer) - atMs
    if (right.kind === 'video' || right.kind === 'audio') right.sourceStartMs += offset * right.playbackRate
    if (right.kind === 'nested') {
      assertNestedStartMovable(right)
      right.trimInMs += offset * right.playback.speed
    }
    shiftKeys(right, -offset)
    ctx.write('Split layer', (draft) => {
      const location = locateLayer(draft, layer.id)
      location.layer.durationMs = offset
      location.track.layers.splice(location.layerIndex + 1, 0, right)
      // The tail's transition (into the next layer) now belongs to the right half.
      for (const t of location.track.transitions) if (t.aLayerId === layer.id) t.aLayerId = right.id
    })
    return { left: layer.id, right: right.id }
  },
})
