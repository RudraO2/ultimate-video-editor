import type { Draft } from 'immer'
import { z } from 'zod'
import { deepClone } from '../clone'
import { remapBehavior } from '../characters'
import { idList } from '../compat'
import { findComp, locateLayer, newTrack, worldStructureProblem } from '../doc'
import { CommandError } from '../errors'
import { ancestorGroups, groupBlock, groupDescendants, groupLaneIndex, groupStructureProblem } from '../groups'
import type { IdGenerator } from '../ids'
import { stripMaterial } from '../materials'
import { defineCommand } from '../registry'
import { type Comp, IdSchema, type Layer, type Project, type Track } from '../schema'

export const IdsSchema = z.union([IdSchema, z.array(IdSchema).min(1)]).describe('One layer or several')

/**
 * The named layers, resolved and without repeats, less those inside a named
 * group (they come with it). All must be in one comp.
 */
export function resolveUnits(project: Project, refs: string[], what: string): { comp: Comp; layers: Layer[] } {
  const located = [...new Set(refs.map((ref) => locateLayer(project, ref).layer.id))].map((id) => locateLayer(project, id))
  const comp = located[0]?.comp as Comp
  const stray = located.find((l) => l.comp.id !== comp.id)
  if (stray) throw new CommandError(`${what} layers of one comp at a time.`, `"${stray.layer.name}" is in comp "${stray.comp.name}".`)
  const inside = new Set(located.flatMap((l) => (l.layer.kind === 'group' ? groupDescendants(comp, l.layer.id).map((m) => m.id) : [])))
  return { comp, layers: located.map((l) => l.layer).filter((l) => !inside.has(l.id)) }
}

/** The lanes a layer takes along when it moves as a unit: a group's lane and its block, else its own lane. */
export function unitLanes(comp: Comp, layer: Layer): Track[] {
  const lane = comp.tracks.findIndex((t) => t.layers.some((l) => l.id === layer.id))
  if (layer.kind !== 'group') return [comp.tracks[lane] as Track]
  const [, end] = groupBlock(comp, layer.id)
  return comp.tracks.slice(lane, end)
}

/**
 * Copies of lanes with fresh ids for the lanes and every layer on them. Lanes
 * that were in a group among the copied ones follow the copy of that group;
 * the others keep their group. `only` keeps just those layers of a lane.
 */
export function copyLanes(lanes: Track[], ids: IdGenerator, renamed: Map<string, string>, only?: ReadonlySet<string>): Track[] {
  for (const track of lanes) for (const layer of track.layers) if (!only || only.has(layer.id)) renamed.set(layer.id, ids('layer'))
  return lanes.map((track) => {
    const layers = track.layers
      .filter((l) => !only || only.has(l.id))
      .map((layer) => {
        const copy = { ...deepClone(layer), id: renamed.get(layer.id) as string } as Layer
        // A joint to a body that was copied along follows the copy; to one left behind, it keeps the original.
        if (copy.joints) copy.joints = copy.joints.map((j) => (j.target !== null && renamed.has(j.target) ? { ...j, target: renamed.get(j.target) as string } : j))
        // A behaviour of a copied group follows the copies of the layers it points at.
        if (copy.kind === 'group' && copy.behaviors.length > 0) copy.behaviors = copy.behaviors.map((b) => remapBehavior(b, renamed))
        return copy
      })
    const group = track.groupId === null ? null : (renamed.get(track.groupId) ?? track.groupId)
    return { ...newTrack(ids('track'), layers, track.name === undefined ? undefined : `${track.name} copy`, group) }
  })
}

/** Throws when moving lanes broke a comp's groups; the write is then dropped. */
function assertStructure(comp: Comp): void {
  const problem = groupStructureProblem(comp)
  if (problem) throw new CommandError(`That would break the comp's groups: ${problem}.`)
}

export const layersDuplicate = defineCommand({
  name: 'layers.duplicate',
  summary: 'Duplicate layers in place: each copy lands on a new lane just in front of its source, in the same group. Returns the new ids.',
  details:
    'A group is duplicated with everything in it. Copies keep the name, timing, values and keys of their source. ids is one id or a list; the result lists the copies in the same order.',
  effect: 'write',
  input: z.strictObject({ ids: IdsSchema }),
  run: ({ ids }, ctx) => {
    const { comp, layers } = resolveUnits(ctx.project, idList(undefined, ids), 'Duplicate')
    const renamed = new Map<string, string>()
    // Back to front, so the lane indices still to be used stay valid.
    const plans = layers
      .map((layer) => {
        const lanes = unitLanes(comp, layer)
        const top = comp.tracks.indexOf(lanes[0] as Track)
        return { layer, top, lanes: copyLanes(lanes, ctx.ids, renamed, layer.kind === 'group' ? undefined : new Set([layer.id])) }
      })
      .sort((a, b) => b.top - a.top)
    ctx.write('Duplicate', (draft) => {
      const target = findComp(draft, comp.id)
      for (const plan of plans) target.tracks.splice(plan.top, 0, ...(plan.lanes as Draft<Track>[]))
    })
    const named = layers.map((l) => renamed.get(l.id) as string)
    const all = [...renamed.values()]
    return all.length > named.length ? { ids: named, alsoCopied: all.length - named.length } : { ids: named }
  },
})

export const layersCopy = defineCommand({
  name: 'layers.copy',
  summary: 'Copy layers into another comp (or the same one), keeping their positions and timing. Returns the new ids of the layers named.',
  details:
    'A group copies with everything in it. The copies land at the top level, in front of everything in the target comp, stacked as their sources were (layers that shared a lane share one). atMs moves the copies\' earliest start there; omitted, each keeps its own start. Positions are comp space (the centre is 0, 0), so in a comp of another size they keep their distance from its centre.',
  effect: 'write',
  input: z.strictObject({
    ids: IdsSchema,
    toCompId: IdSchema.optional().describe('The comp to copy into (AtomCut: toFrameId); default the comp open in the editor'),
    atMs: z.number().min(0).optional().describe("Where the copies' earliest start lands, comp ms"),
  }),
  run: ({ ids, toCompId, atMs }, ctx) => {
    const { comp, layers } = resolveUnits(ctx.project, idList(undefined, ids), 'Copy')
    const target = findComp(ctx.project, toCompId ?? ctx.view.compId)
    const chosen = new Set(layers.map((l) => l.id))
    // One unit per source lane (layers sharing a lane stay together), or per group with its block, in lane order.
    const units: { lanes: Track[]; only?: Set<string> }[] = []
    for (const track of comp.tracks) {
      const group = track.layers.find((l) => l.kind === 'group' && chosen.has(l.id))
      if (group) units.push({ lanes: unitLanes(comp, group) })
      else {
        const picked = track.layers.filter((l) => l.kind !== 'group' && chosen.has(l.id))
        if (picked.length > 0) units.push({ lanes: [track], only: new Set(picked.map((l) => l.id)) })
      }
    }
    const renamed = new Map<string, string>()
    const lanes = units.flatMap((u) => copyLanes(u.lanes, ctx.ids, renamed, u.only))
    // A picture that leaves its world loses its material (only worlds light things).
    if (!target.world) for (const lane of lanes) for (const layer of lane.layers) {
      stripMaterial(layer)
      delete layer.extrude
      for (const path of Object.keys(layer.animations)) if (path.startsWith('extrude.')) delete layer.animations[path]
    }
    const copiedGroups = new Set([...renamed.values()])
    // Joints hold bodies of one comp: those to a body left behind go, and a world has no physics yet.
    for (const lane of lanes) for (const layer of lane.layers) {
      if (target.world) {
        delete layer.physics
        delete layer.forces
        delete layer.joints
      } else if (layer.joints && target.id !== comp.id) {
        const kept = layer.joints.filter((j) => j.target === null || copiedGroups.has(j.target))
        if (kept.length > 0) layer.joints = kept
        else delete layer.joints
      }
    }
    // Copies leave their groups, unless their group came along.
    for (const lane of lanes) if (lane.groupId !== null && !copiedGroups.has(lane.groupId)) lane.groupId = null
    const earliest = Math.min(...lanes.flatMap((t) => t.layers.map((l) => l.startMs)))
    const shift = atMs === undefined ? 0 : atMs - earliest
    for (const lane of lanes) for (const layer of lane.layers) layer.startMs += shift
    ctx.write('Copy layers', (draft) => {
      const into = findComp(draft, target.id)
      into.tracks.unshift(...(lanes as Draft<Track>[]))
      if (worldStructureProblem(into as Comp)) {
        throw new CommandError(`"${target.name}" is a flat comp, so it cannot hold a camera, light or controller.`, 'Cameras, lights and controllers stay in their 3D world.')
      }
    })
    const named = layers.map((l) => renamed.get(l.id) as string)
    const all = [...renamed.values()]
    return {
      ids: named,
      compId: target.id,
      ...(all.length > named.length ? { alsoCopied: all.length - named.length } : {}),
      ...(shift !== 0 ? { shiftedMs: shift } : {}),
    }
  },
})

const RestackTargetSchema = z
  .union([z.enum(['front', 'back']), z.strictObject({ above: IdSchema }), z.strictObject({ below: IdSchema })])
  .describe('"front" or "back" of their group (or of the comp), or {above: id} / {below: id} to sit right in front of or behind a layer, in its group')

export const layersRestack = defineCommand({
  name: 'layers.restack',
  summary: 'Change the stacking order: bring layers to the front or send them to the back of their group, or place them right above or below a layer.',
  details:
    'Stacking is lane order: the front lane draws on top. A layer alone on its lane moves with its lane; one that shares a lane gets a new one. A group moves with everything in it. The named layers keep their order, the first in front. above and below put them in the target\'s group; front and back keep them in the group of the first one named. Audio cannot go into a group.',
  effect: 'write',
  input: z.strictObject({ ids: IdsSchema, to: RestackTargetSchema }),
  run: ({ ids, to }, ctx) => {
    const { comp, layers } = resolveUnits(ctx.project, idList(undefined, ids), 'Restack')
    const moving = new Set(layers.map((l) => l.id))
    const laneOf = (id: string) => comp.tracks.find((t) => t.layers.some((l) => l.id === id)) as Track
    let parent: string | null
    let anchor: Layer | undefined
    if (typeof to === 'string') {
      parent = laneOf((layers[0] as Layer).id).groupId
    } else {
      const ref = 'above' in to ? to.above : to.below
      const located = locateLayer(ctx.project, ref)
      if (located.comp.id !== comp.id) throw new CommandError(`"${located.layer.name}" is in another comp.`, 'layers.copy copies layers into another comp.')
      anchor = located.layer
      if (moving.has(anchor.id)) throw new CommandError(`"${anchor.name}" is one of the layers being moved.`, 'Place them above or below another layer.')
      const inMoving = ancestorGroups(comp, anchor.id).find((g) => moving.has(g.id))
      if (inMoving) throw new CommandError(`"${anchor.name}" is inside "${inMoving.name}", which is being moved.`)
      parent = located.track.groupId
    }
    if (parent !== null) {
      const audio = layers.find((l) => l.kind === 'audio')
      if (audio) throw new CommandError(`"${audio.name}" is audio and cannot go into a group.`)
      const loop = layers.find((l) => l.id === parent || ancestorGroups(comp, parent as string).some((g) => g.id === l.id))
      if (loop) throw new CommandError(`"${loop.name}" cannot go inside itself.`)
    }
    const fresh = layers.map(() => ctx.ids('track'))
    ctx.write('Restack', (draft) => {
      const target = findComp(draft, comp.id)
      // Take the units out: whole lanes, or the layer alone on a new lane.
      const units: Draft<Track>[][] = layers.map((layer, i) => {
        const lanes = unitLanes(comp, layer).map((t) => target.tracks.find((d) => d.id === t.id) as Draft<Track>)
        const own = lanes[0] as Draft<Track>
        if (layer.kind === 'group' || own.layers.length === 1) return lanes
        const index = own.layers.findIndex((l) => l.id === layer.id)
        const [taken] = own.layers.splice(index, 1)
        return [newTrack(fresh[i] as string, [taken as Layer], undefined, own.groupId) as Draft<Track>]
      })
      const leaving = new Set(units.flat())
      target.tracks = target.tracks.filter((t) => !leaving.has(t))
      // Where they go, among the lanes left.
      let at: number
      const lanes = target.tracks
      if (anchor) {
        const anchorLane = lanes.findIndex((t) => t.layers.some((l) => l.id === anchor.id))
        at = 'above' in (to as object) ? anchorLane : anchor.kind === 'group' ? groupBlock(target as Comp, anchor.id)[1] : anchorLane + 1
      } else if (parent === null) {
        at = to === 'front' ? 0 : lanes.length
      } else {
        at = to === 'front' ? groupLaneIndex(target as Comp, parent) + 1 : groupBlock(target as Comp, parent)[1]
      }
      for (const unit of units) (unit[0] as Draft<Track>).groupId = parent
      lanes.splice(at, 0, ...units.flat())
      assertStructure(target as Comp)
    })
    return { restacked: layers.map((l) => l.id), ...(parent !== null ? { groupId: parent } : {}) }
  },
})

