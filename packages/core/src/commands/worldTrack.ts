import { z } from 'zod'
import { locateLayer } from '../doc'
import { CommandError } from '../errors'
import { ancestorGroups } from '../groups'
import { defineCommand } from '../registry'
import { type Comp, type Constraint, IdSchema, type Layer } from '../schema'
import { mat4Invert, worldCoresAt } from '../world'
import { findWorld } from './world'

// World constraints: a layer that keeps aiming at another (lookAt), keeps its
// position relative to it (follow) or rides it (childOf). The maths is in
// `solveConstraints` (world.ts); worldObjects applies it, so everything that
// reads a world sees the constrained pose.

const target = IdSchema.nullable().optional()

/** The layers a layer's place depends on: its group and the target of its childOf. */
function dependencies(comp: Comp, id: string): string[] {
  const track = comp.tracks.find((t) => t.layers.some((l) => l.id === id))
  const layer = track?.layers.find((l) => l.id === id)
  const out: string[] = []
  if (track?.groupId) out.push(track.groupId)
  for (const c of layer?.constraints ?? []) if (c.type === 'childOf' && c.enabled && c.targetId !== null) out.push(c.targetId)
  return out
}

/** Whether `from` depends on `goal`, through groups and childOf. */
function dependsOn(comp: Comp, from: string, goal: string): boolean {
  const seen = new Set<string>()
  const stack = [from]
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (id === goal) return true
    if (seen.has(id)) continue
    seen.add(id)
    stack.push(...dependencies(comp, id))
  }
  return false
}

const summary = (c: Constraint) => ({ id: c.id, type: c.type, targetId: c.targetId, influence: c.influence, enabled: c.enabled, ...(c.type === 'follow' ? { rotation: c.rotation } : {}) })

export const worldTrack = defineCommand({
  name: 'world.track',
  summary: 'Make a layer in a 3D world aim at, follow or ride another layer, live: it keeps doing so as either one moves.',
  details:
    'Each field you give replaces that kind of constraint on the layer; null removes it; a field you leave out stays. ' +
    'lookAt: the layer keeps aiming at the target\'s position (a camera or light aims its -Z, anything else its -Y, horizon level). It keeps its own position and scale and gives up its own turns. world.add\'s lookAt is a one-off aim; this one keeps aiming while the target or the layer moves. ' +
    'follow: the layer\'s stored position becomes an OFFSET from the target, so it moves with the target (its own keys still add on top). followRotation also turns the layer with the target. ' +
    'childOf: the layer stays exactly where it is now (at atMs) and from then on follows the target\'s moves, turns and scale, like a child of it. Needs the target on the timeline at atMs. ' +
    'Chains work: a hand childOf an arm childOf a controller. Targets must be in the same world, not the layer itself, and childOf cannot make a loop. A constraint on a group carries its members; a member can have its own too. ' +
    'Tune a constraint afterwards with layer.patch: {"op":"set","path":"constraints[id=<id>].influence","value":0.5} (0 leaves the layer alone, 1 is the full effect) or ".enabled" false to pause it; the ids are returned here and listed by world.inspect. ' +
    'IK (ik) is not in this build: key the joints\' rotation, or use lookAt. Returns the layer\'s constraints.',
  effect: 'write',
  input: z.strictObject({
    id: IdSchema.describe('The layer to constrain (a layer id or an exact, unique name)'),
    lookAt: target.describe('A layer to keep aiming at; null removes the constraint'),
    follow: target.describe('A layer to follow (position as an offset from it); null removes the constraint'),
    followRotation: z.boolean().optional().describe('With follow: also turn with the target (default false)'),
    childOf: target.describe('A layer to ride as its child, keeping the layer where it is at atMs; null removes the constraint'),
    atMs: z.number().min(0).optional().describe('Comp time childOf binds at; default the playhead when the frame is open, else the layer\'s start'),
    ik: z.unknown().optional().describe('Not in this build'),
  }),
  run: (input, ctx) => {
    const found = locateLayer(ctx.project, input.id)
    const comp = findWorld(ctx.project, found.comp.id)
    const layer = found.layer
    if (layer.kind === 'audio') throw new CommandError(`"${layer.name}" is an audio layer: it has no place in 3D space.`, 'Constrain a camera, light, controller, mesh, picture or group.')
    if (input.ik !== undefined && input.ik !== null) throw new CommandError('IK is not in this build yet.', "Key the joints' rotation, or use lookAt to make a part aim at a target.")
    if (input.lookAt === undefined && input.follow === undefined && input.childOf === undefined) {
      throw new CommandError('Nothing to track.', 'Give lookAt, follow or childOf: a target layer id, or null to remove one.')
    }
    if (input.followRotation !== undefined && input.follow === undefined) {
      throw new CommandError('followRotation needs follow.', 'Pass follow with the target, or leave followRotation out.')
    }

    const resolve = (kind: string, ref: string): Layer => {
      const there = locateLayer(ctx.project, ref)
      if (there.layer.id === layer.id) throw new CommandError(`${kind}: a layer cannot track itself.`, 'Pick another layer as the target.')
      if (there.comp.id !== comp.id) {
        throw new CommandError(`${kind}: "${there.layer.name}" is in another comp ("${there.comp.name}"), not in "${comp.name}".`, 'Targets must be in the same 3D world; world.inspect lists its objects.')
      }
      if (there.layer.kind === 'audio') throw new CommandError(`${kind}: "${there.layer.name}" is an audio layer: it has no place in 3D space.`, 'Pick a camera, light, controller, mesh, picture or group.')
      return there.layer
    }
    const targets = {
      lookAt: typeof input.lookAt === 'string' ? resolve('lookAt', input.lookAt) : null,
      follow: typeof input.follow === 'string' ? resolve('follow', input.follow) : null,
      childOf: typeof input.childOf === 'string' ? resolve('childOf', input.childOf) : null,
    }

    let inverse: number[] | null = null
    if (targets.childOf) {
      const parent = targets.childOf
      if (dependsOn(comp, parent.id, layer.id) || ancestorGroups(comp, layer.id).some((g) => g.id === parent.id)) {
        throw new CommandError(
          `childOf: "${parent.name}" cannot be the parent of "${layer.name}": that would make a loop.`,
          ancestorGroups(comp, layer.id).some((g) => g.id === parent.id)
            ? 'A layer inside a group already moves with the group; pick a layer outside it.'
            : `"${parent.name}" already moves with "${layer.name}" (through a group or a childOf). Pick another parent.`,
        )
      }
      const atMs = input.atMs ?? (ctx.view.compId === comp.id ? (ctx.view.playheadMs ?? layer.startMs) : layer.startMs)
      const cores = worldCoresAt(comp, atMs, 'childOf')
      const there = cores.get(parent.id)
      if (!there) {
        throw new CommandError(`childOf: "${parent.name}" is not on the timeline at ${atMs} ms, so there is nothing to bind to.`, 'Pass atMs inside its span, or move or trim it with timeline_move and timeline_trim.')
      }
      inverse = mat4Invert(there)
      if (!inverse) throw new CommandError(`childOf: "${parent.name}" has no size at ${atMs} ms (a scale of 0), so the layer cannot be bound to it.`, 'Give it a scale other than 0, or pass another atMs.')
    }

    const next: Constraint[] = (layer.constraints ?? []).filter((c) => input[c.type] === undefined)
    if (targets.lookAt) next.push({ id: ctx.ids('cns'), type: 'lookAt', targetId: targets.lookAt.id, enabled: true, influence: 1 })
    if (targets.follow) next.push({ id: ctx.ids('cns'), type: 'follow', targetId: targets.follow.id, enabled: true, influence: 1, rotation: input.followRotation ?? false })
    if (targets.childOf) next.push({ id: ctx.ids('cns'), type: 'childOf', targetId: targets.childOf.id, enabled: true, influence: 1, inverse })

    ctx.write('Track', (draft) => {
      const at = locateLayer(draft, layer.id)
      if (next.length > 0) at.layer.constraints = next
      else delete at.layer.constraints
    })
    return { updated: layer.id, constraints: next.map(summary) }
  },
})
