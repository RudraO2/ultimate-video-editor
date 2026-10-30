import { current, type Draft } from 'immer'
import { z } from 'zod'
import { deepClone } from '../clone'
import { findComp, layerEnd, locateLayer, shiftKeys } from '../doc'
import { CommandError } from '../errors'
import { groupBlock, groupDescendants, groupOnLane, groupStructureProblem } from '../groups'
import type { IdGenerator } from '../ids'
import { defineCommand } from '../registry'
import { type Comp, IdSchema, type Layer, type Track } from '../schema'

// Ripple edits: closing gaps, tidying lanes, and taking stretches of time out
// of a comp. They work on the draft directly, lane by lane, so a cut and its
// ripple are one undo step.

/** Times closer than this are the same moment. */
const EPS = 0.5

type DComp = Draft<Comp>
type DTrack = Draft<Track>
type DLayer = Draft<Layer>

const laneOf = (comp: DComp, id: string) => comp.tracks.find((t) => t.layers.some((l) => l.id === id)) as DTrack | undefined
const layerById = (comp: DComp, id: string) => comp.tracks.flatMap((t) => t.layers).find((l) => l.id === id)

/** Moves a layer in time; a group takes everything in it along. */
function moveBy(comp: DComp, layer: DLayer, delta: number): void {
  if (Math.abs(delta) < 1e-9) return
  layer.startMs += delta
  if (layer.kind === 'group') for (const member of groupDescendants(comp as Comp, layer.id)) (layerById(comp, member.id) as DLayer).startMs += delta
}

/** Moves a layer's start to `t`, keeping what it shows where it is in comp time (its source, its keys). */
function trimStartTo(layer: DLayer, t: number): void {
  const delta = t - layer.startMs
  if (layer.kind === 'video' || layer.kind === 'audio') layer.sourceStartMs = Math.max(0, layer.sourceStartMs + delta * layer.playbackRate)
  if (layer.kind === 'nested') layer.trimInMs = Math.max(0, layer.trimInMs + delta * layer.playback.speed)
  shiftKeys(layer as Layer, -delta)
  layer.startMs = t
  layer.durationMs -= delta
}

/** Cuts a layer in two at comp time `t`; the right part, with a new id, goes on the same lane. */
function splitAt(comp: DComp, layer: DLayer, t: number, ids: IdGenerator): DLayer {
  const lane = laneOf(comp, layer.id) as DTrack
  const right = deepClone(current(layer)) as DLayer
  right.id = ids('layer')
  trimStartTo(right, t)
  layer.durationMs = t - layer.startMs
  lane.layers.splice(lane.layers.indexOf(layer) + 1, 0, right)
  return right
}

/** Deletes a layer; a group goes with everything in it and its lanes. */
function remove(comp: DComp, layer: DLayer): void {
  if (layer.kind === 'group') {
    const lane = comp.tracks.findIndex((t) => t.layers.some((l) => l.id === layer.id))
    const [, end] = groupBlock(comp as Comp, layer.id)
    comp.tracks.splice(lane, end - lane)
    return
  }
  const lane = laneOf(comp, layer.id)
  if (lane) lane.layers.splice(lane.layers.indexOf(layer), 1)
}

/**
 * Moves a lane's layers, front to back in time: `place` gets each layer and
 * the end of the ones before it, and returns where it goes (or null to leave
 * it). Locked layers stay and still block.
 */
function rippleLane(comp: DComp, lane: DTrack, place: (layer: DLayer, cursor: number) => number | null): boolean {
  let cursor = 0
  let moved = false
  for (const layer of [...lane.layers].sort((a, b) => a.startMs - b.startMs)) {
    const to = layer.locked ? null : place(layer, cursor)
    if (to !== null && Math.abs(to - layer.startMs) > EPS) {
      moveBy(comp, layer, to - layer.startMs)
      moved = true
    }
    cursor = Math.max(cursor, layerEnd(layer))
  }
  lane.layers.sort((a, b) => a.startMs - b.startMs)
  return moved
}

export const timelineCloseGaps = defineCommand({
  name: 'timeline.close_gaps',
  summary: 'Ripple the lanes of these layers so every gap closes: what you do after cutting pieces out.',
  details:
    'Pass any layer on each lane to close. Every layer on those lanes moves back to the end of the one before it (the first to 0); locked layers stay where they are and the next ones close up to them. A group moves with everything in it; keys move with their layers.',
  effect: 'write',
  input: z.strictObject({ ids: z.union([IdSchema, z.array(IdSchema).min(1)]).describe('Layers whose lanes close up') }),
  run: ({ ids }, ctx) => {
    const refs = typeof ids === 'string' ? [ids] : ids
    const lanes = new Map<string, string>()
    for (const ref of refs) {
      const { comp, track } = locateLayer(ctx.project, ref)
      lanes.set(track.id, comp.id)
    }
    let closed = 0
    ctx.write('Close gaps', (draft) => {
      for (const [laneId, compId] of lanes) {
        const comp = findComp(draft, compId)
        const lane = comp.tracks.find((t) => t.id === laneId) as DTrack
        if (rippleLane(comp, lane, (layer, cursor) => (layer.startMs > cursor + EPS ? cursor : null))) closed++
      }
    })
    return { lanesClosed: closed, lanes: lanes.size }
  },
})

/** Whether layers may move onto or off a lane when tidying: not locked, hidden or muted, and not a group's own lane. */
const movable = (lane: Track) => !lane.locked && !lane.hidden && !lane.muted && !groupOnLane(lane)

export const timelineCompact = defineCommand({
  name: 'timeline.compact',
  summary: "Tidy a comp's lanes: drop empty lanes and let layers fall into free lanes behind them, without changing what covers what.",
  details:
    'A layer only shares a lane with layers it never plays at the same time as, and never drops behind anything it overlaps, so every frame looks as before. It works level by level (the top level, then inside each group). Locked, hidden and muted lanes, and group lanes, stay put and nothing crosses them. Returns the lane count before and after.',
  effect: 'write',
  input: z.strictObject({ compId: IdSchema.optional().describe('Default the comp open in the editor (AtomCut: frameId)') }),
  run: ({ compId }, ctx) => {
    const comp = findComp(ctx.project, compId ?? ctx.view.compId)
    const before = comp.tracks.length
    let moved = 0
    ctx.write('Compact lanes', (draft) => {
      const target = findComp(draft, comp.id)
      const levels = [null, ...target.tracks.flatMap((t) => (groupOnLane(t as Track) ? [(groupOnLane(t as Track) as Layer).id] : []))]
      for (const level of levels) {
        // Runs of lanes at this level that layers may move between, front to back.
        const runs: DTrack[][] = [[]]
        for (const lane of target.tracks.filter((t) => t.groupId === level)) {
          if (movable(lane as Track)) (runs.at(-1) as DTrack[]).push(lane)
          else runs.push([])
        }
        for (const run of runs) moved += compactRun(run)
      }
      target.tracks = target.tracks.filter((t) => t.layers.length > 0)
      const problem = groupStructureProblem(target as Comp)
      if (problem) throw new CommandError(`Compacting would break the comp's groups: ${problem}.`)
    })
    const after = findComp(ctx.project, comp.id).tracks.length
    return { lanesBefore: before, lanesAfter: after, moved }
  },
})

/**
 * Lets a run's layers fall back: from the back lane forward, each layer goes
 * to the lane just in front of the front-most layer (from another lane) that
 * it overlaps in time, so its order against everything it meets is kept.
 */
function compactRun(run: DTrack[]): number {
  if (run.length < 2) return 0
  const placed: { layer: DLayer; from: DTrack; level: number }[] = []
  for (let i = run.length - 1; i >= 0; i--) {
    const from = run[i] as DTrack
    for (const layer of from.layers) {
      let level = 0
      for (const other of placed) {
        if (other.from !== from && layer.startMs < layerEnd(other.layer) - EPS && other.layer.startMs < layerEnd(layer) - EPS) level = Math.max(level, other.level + 1)
      }
      placed.push({ layer, from, level })
    }
  }
  let moved = 0
  for (const { layer, from, level } of placed) {
    const to = run[run.length - 1 - level] as DTrack
    if (to === from) continue
    from.layers.splice(from.layers.indexOf(layer), 1)
    to.layers.push(layer)
    moved++
  }
  for (const lane of run) lane.layers.sort((a, b) => a.startMs - b.startMs)
  return moved
}

const RangeSchema = z.strictObject({ startMs: z.number(), endMs: z.number() })

/** Ranges clipped to [from, to), without slivers, sorted, and merged where they touch. */
function cleanRanges(ranges: readonly { startMs: number; endMs: number }[], from: number, to: number) {
  const clipped = ranges
    .map((r) => ({ startMs: Math.max(from, Math.min(r.startMs, r.endMs)), endMs: Math.min(to, Math.max(r.startMs, r.endMs)) }))
    .filter((r) => r.endMs - r.startMs >= 1)
    .sort((a, b) => a.startMs - b.startMs)
  const merged: { startMs: number; endMs: number }[] = []
  for (const r of clipped) {
    const last = merged.at(-1)
    if (last && r.startMs <= last.endMs + EPS) last.endMs = Math.max(last.endMs, r.endMs)
    else merged.push({ ...r })
  }
  return merged
}

export const timelineCutRanges = defineCommand({
  name: 'timeline.cut_ranges',
  summary: 'Take stretches of comp time out of a layer (pauses, ums, dead air) and ripple what follows back, as one undo step.',
  details:
    'Ranges are comp ms; they are clipped to the layer and merged. ripple "sync" (the default) keeps the comp in sync like an editor\'s sync lock: on every unlocked lane at the layer\'s level, what lies inside a cut goes, what spans it is shortened by its length, what overlaps an edge is trimmed to it, and everything after slides back (captions and titles stay with their words; a music bed under the cut is shortened). "lane" closes only this layer\'s lane; "none" leaves holes (for B-roll). Returns the time removed and the pieces left of the layer.',
  effect: 'write',
  input: z.strictObject({
    id: IdSchema,
    ranges: z.array(RangeSchema).min(1).max(500),
    ripple: z.enum(['sync', 'lane', 'none']).default('sync'),
  }),
  run: ({ id, ranges, ripple }, ctx) => {
    const { comp, layer, track } = locateLayer(ctx.project, id)
    if (layer.kind === 'group') throw new CommandError('A group cannot be cut.', 'Cut the layers in it, or nest them first (layers.nest) and cut the nested layer.')
    if (layer.kind === 'nested' && layer.playback.loop !== 'none') {
      throw new CommandError(`"${layer.name}" loops, and its loop starts at its start: cutting it would restart the loop.`, 'Set playback.loop to "none" first (layer.patch).')
    }
    const cuts = cleanRanges(ranges, layer.startMs, layerEnd(layer))
    if (cuts.length === 0) throw new CommandError('None of those ranges fall inside the layer.', `Ranges are comp ms; "${layer.name}" spans ${layer.startMs}–${layerEnd(layer)} ms.`)
    const level = track.groupId
    let pieces: string[] = []
    ctx.write('Cut ranges', (draft) => {
      const target = findComp(draft, comp.id)
      const ours = new Set([layer.id])
      for (const cut of [...cuts].reverse()) {
        const length = cut.endMs - cut.startMs
        // Razor the layer: keep what is after the cut, drop what is in it.
        const touched = new Set<DTrack>()
        for (const pieceId of [...ours]) {
          const piece = layerById(target, pieceId)
          if (!piece || layerEnd(piece) <= cut.startMs + EPS || piece.startMs >= cut.endMs - EPS) continue
          touched.add(laneOf(target, pieceId) as DTrack)
          if (layerEnd(piece) > cut.endMs + EPS) ours.add(splitAt(target, piece, cut.endMs, ctx.ids).id)
          if (piece.startMs < cut.startMs - EPS) remove(target, splitAt(target, piece, cut.startMs, ctx.ids))
          else {
            remove(target, piece)
            ours.delete(pieceId)
          }
        }
        if (ripple === 'sync') {
          for (const lane of target.tracks.filter((t) => t.groupId === level && !t.locked)) {
            touched.add(lane)
            for (const other of [...lane.layers]) {
              if (ours.has(other.id) || other.locked) continue
              const start = other.startMs
              const end = layerEnd(other)
              if (end <= cut.startMs + EPS || start >= cut.endMs - EPS) continue
              if (start >= cut.startMs - EPS && end <= cut.endMs + EPS) remove(target, other)
              else if (start < cut.startMs && end > cut.endMs) other.durationMs -= length
              else if (start < cut.startMs) other.durationMs = cut.startMs - start
              else trimStartTo(other, cut.endMs)
            }
          }
        }
        if (ripple !== 'none') {
          for (const lane of touched) {
            if (!target.tracks.includes(lane)) continue
            const later = lane.layers.filter((l) => l.startMs >= cut.endMs - EPS)
            if (later.length === 0 || later.some((l) => l.locked)) continue
            rippleLane(target, lane, (l) => (l.startMs >= cut.endMs - EPS ? Math.max(0, l.startMs - length) : null))
          }
        }
      }
      const problem = groupStructureProblem(target as Comp)
      if (problem) throw new CommandError(`That cut would break the comp's groups: ${problem}.`)
      pieces = target.tracks
        .flatMap((t) => t.layers)
        .filter((l) => ours.has(l.id))
        .sort((a, b) => a.startMs - b.startMs)
        .map((l) => l.id)
    })
    return { removedMs: Math.round(cuts.reduce((sum, c) => sum + c.endMs - c.startMs, 0)), cuts: cuts.length, pieces }
  },
})
