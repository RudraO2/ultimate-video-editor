import { z } from 'zod'
import { idList } from '../compat'
import { findComp, isSpatialKind, newTrack } from '../doc'
import { CommandError, parseOrThrow } from '../errors'
import { groupDescendants, groupOnLane } from '../groups'
import { convertToWorld, type GroupBox, membersMove } from '../moveInto'
import { defineCommand, type Measure } from '../registry'
import { type Comp, CompSchema, type Layer, LayerSchema } from '../schema'
import { isWorld } from '../world'
import { IdsSchema, resolveUnits, unitLanes } from './arrange'
import { measureTime, nestLayers } from './nest'

// Moving 2D layers into a 3D world: the ordinary full-frame nest, with a world
// on the new comp, and every layer converted by the change of axes so the
// picture does not move (moveInto.ts).

const REFUSAL = 'Nothing to move: pick 2D layers in a flat comp (audio, adjustments and 3D objects stay).'

/** What a group needs to be converted: its measured box and when it was measured. */
interface Bake {
  box: GroupBox | null
  atMs: number
  boxMoves: boolean
}

/** Measures the groups among the units (before anything moves), one comp time at a time. */
function measureGroups(comp: Comp, units: readonly Layer[], playheadMs: number | undefined, measure: Measure | undefined): Map<string, Bake> {
  const bakes = new Map<string, Bake>()
  const cache = new Map<number, ReturnType<Measure>>()
  for (const unit of units) {
    if (unit.kind !== 'group') continue
    const inside = unitLanes(comp, unit).flatMap((t) => t.layers)
    for (const group of inside.filter((l) => l.kind === 'group')) {
      const at = measureTime(group, playheadMs)
      if (measure && !cache.has(at)) cache.set(at, measure(comp, at))
      const box = cache.get(at)?.get(group.id)?.box ?? null
      bakes.set(group.id, { box, atMs: at - group.startMs, boxMoves: membersMove(groupDescendants(comp, group.id)) })
    }
  }
  return bakes
}

export const worldMoveInto = defineCommand({
  name: 'world.move_into',
  summary: 'Move 2D layers into a new 3D world, or make a whole frame 3D. The picture stays exactly as it was; depth is added.',
  details:
    "Give ids (2D layers of one flat comp; audio, adjustments and cameras, lights or controllers stay) or compId (make this whole frame 3D, AtomCut: frameId). The layers are nested full frame, like layers.nest {fullFrame: true}, into a new world comp with a clear background and no camera, so the default front camera shows exactly the flat picture; add a camera to move around. A frame's top-level 2D layers go into a world nested inside it and the frame stays as the wrapper; an empty frame gets an empty world named \"<name> · 3D\". Positions and turns are converted by the change of axes: world x = x, world y (depth) = flat z, world z (up) = -flat y, and the key tracks are renamed the same way. Keyed turns are swapped, which is exact while rotation or rotationY is 0; layers where both turn, and groups whose pivot or members move, come back in approximate (ids). Returns nestedId (the layer in the flat comp), frameId (the new world) and approximate when it is not empty.",
  effect: 'write',
  input: z.strictObject({
    ids: IdsSchema.optional().describe('2D layers (and groups) of one flat comp to move into a new world'),
    compId: z.string().min(1).optional().describe('Make this whole frame 3D (AtomCut: frameId)'),
    name: z.string().min(1).optional().describe('The world comp\'s name; default "<front layer name> · 3D" (an empty frame: "<frame name> · 3D")'),
  }),
  run: ({ ids, compId, name }, ctx) => {
    if ((ids === undefined) === (compId === undefined)) {
      throw new CommandError(
        ids === undefined ? 'Say what to move: ids or compId.' : 'Give ids or compId, not both.',
        'ids moves those layers into a new world; compId (AtomCut: frameId) makes the whole frame 3D.',
      )
    }
    const label = 'Move into 3D world'
    const refuse = (comp: Comp): never => {
      throw new CommandError(isWorld(comp) ? `"${comp.name}" is already a 3D world. ${REFUSAL}` : REFUSAL, 'world_create makes a world; world_move_into takes 2D layers of a flat comp.')
    }

    // The units to move, from the named layers or from the frame's top-level lanes.
    let comp: Comp
    let layers: Layer[]
    if (ids !== undefined) {
      const found = resolveUnits(ctx.project, idList(undefined, ids), 'Move')
      comp = found.comp
      if (isWorld(comp)) refuse(comp)
      layers = found.layers.filter((l) => l.kind !== 'audio' && !isSpatialKind(l.kind))
    } else {
      comp = findComp(ctx.project, compId)
      if (isWorld(comp)) refuse(comp)
      layers = comp.tracks.flatMap((t) => {
        if (t.groupId !== null) return []
        const group = groupOnLane(t)
        return group ? [group] : t.layers.filter((l) => l.kind !== 'audio' && !isSpatialKind(l.kind))
      })
    }
    if (layers.length === 0 && ids !== undefined) refuse(comp)

    // A frame with nothing to move gets an empty world over its whole length.
    if (layers.length === 0) {
      const worldName = name ?? `${comp.name} · 3D`
      const worldId = ctx.ids('comp')
      const nested = parseOrThrow(
        LayerSchema,
        { id: ctx.ids('layer'), name: worldName, kind: 'nested', sourceCompId: worldId, startMs: 0, durationMs: comp.durationMs },
        'The nested layer',
      )
      const inside = parseOrThrow(
        CompSchema,
        { id: worldId, name: worldName, width: comp.width, height: comp.height, fps: comp.fps, durationMs: comp.durationMs, background: '#00000000', tracks: [], embedded: true, world: {} },
        'The world',
      )
      const lane = ctx.ids('track')
      ctx.write(label, (draft) => {
        draft.comps.push(inside as never)
        findComp(draft, comp.id).tracks.unshift(newTrack(lane, [nested]) as never)
      })
      return { nestedId: nested.id, frameId: worldId }
    }

    const bakes = measureGroups(comp, layers, ctx.view.playheadMs, ctx.measure)
    const approximate: string[] = []
    const nested = nestLayers(ctx, comp, layers, {
      fullFrame: true,
      label,
      world: true,
      name: name ?? ((front) => `${front.name} · 3D`),
      convert: (inside) => {
        for (const lane of inside.tracks) {
          for (const layer of lane.layers) {
            if (layer.kind === 'audio') continue
            if (convertToWorld(layer, bakes.get(layer.id) ?? {}).approximate) approximate.push(layer.id)
          }
        }
      },
    })
    return { nestedId: nested.id, frameId: nested.sourceCompId, ...(approximate.length > 0 ? { approximate } : {}) }
  },
})
