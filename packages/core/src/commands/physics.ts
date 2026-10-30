import { z } from 'zod'
import { deepClone } from '../clone'
import { idList } from '../compat'
import { findComp, locateLayer, newTrack } from '../doc'
import { CommandError, parseOrThrow } from '../errors'
import { type CommandContext, defineCommand } from '../registry'
import {
  type Comp,
  type Force,
  ForceSchema,
  IdSchema,
  type Joint,
  JointSchema,
  type Layer,
  LayerSchema,
  optionalFields,
  type PhysicsBody,
  PhysicsBodySchema,
  type PhysicsScene,
  PhysicsSceneSchema,
  type Project,
} from '../schema'
import { isWorld } from '../world'
import { IdsSchema } from './arrange'

// Physics data and its editing commands. The simulation itself is elsewhere:
// these only store settings on comps (`physics`), bodies (`physics`), force
// cards (`forces`) and joints (`joints`).

/** Units agents need in every description. */
const UNITS = '1 px = 1 cm, so gravity 981 is Earth; +y is down. Angles are degrees, clockwise.'

const WORLD_HINT = 'Physics in 3D worlds comes later; use a flat comp for now.'

/** A point or vector given as [x, y] or [x, y, z]; stored as three numbers. */
const VecInputSchema = z.union([z.tuple([z.number(), z.number()]), z.tuple([z.number(), z.number(), z.number()])])
type VecInput = z.infer<typeof VecInputSchema>
const vec3 = (v: VecInput): [number, number, number] => [v[0], v[1], v.length === 3 ? v[2] : 0]

/** The fields of an object whose value is given. */
function given<T extends Record<string, unknown>>(fields: T): Partial<T> {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Partial<T>
}

function flatComp(ctx: CommandContext, compId?: string): Comp {
  const comp = findComp(ctx.project, compId ?? ctx.view.compId)
  if (isWorld(comp)) throw new CommandError(`"${comp.name}" is a 3D world.`, WORLD_HINT)
  return comp
}

/** Removes joints that hold a body to any of these layers, in every comp of the draft. */
export function removeJointsTo(project: Project, layerIds: Iterable<string>): void {
  const gone = new Set(layerIds)
  if (gone.size === 0) return
  for (const comp of project.comps) {
    for (const track of comp.tracks) {
      for (const layer of track.layers) {
        if (!layer.joints) continue
        const kept = layer.joints.filter((j) => j.target === null || !gone.has(j.target))
        if (kept.length === layer.joints.length) continue
        if (kept.length > 0) layer.joints = kept
        else delete layer.joints
      }
    }
  }
}

export const physicsScene = defineCommand({
  name: 'physics.scene',
  summary: "Set a comp's physics: gravity, when it starts, the floor, the walls and the speed. Only the fields you give change.",
  details: `Physics settings live on the comp; layers join with physics.body. ${UNITS} gravity 0 makes things float. startMs is where the simulation begins: bodies sit as laid out until then. floor is a solid floor at the comp's bottom edge, or at floorAt (y in comp space, + is down). walls makes the left, right and top edges solid. timeScale 0.05..4 slows or speeds the simulation (1 is real time). Returns the comp's full settings. 3D worlds are refused for now.`,
  effect: 'write',
  input: optionalFields(PhysicsSceneSchema).extend({
    compId: IdSchema.optional().describe('Default the comp open in the editor (AtomCut: frameId)'),
  }),
  run: ({ compId, ...fields }, ctx) => {
    const comp = flatComp(ctx, compId)
    const changes = given(fields)
    const merged = parseOrThrow(PhysicsSceneSchema, { ...comp.physics, ...changes }, 'The physics settings')
    if (Object.keys(changes).length > 0) {
      ctx.write('Physics scene', (draft) => {
        findComp(draft, comp.id).physics = merged
      })
    }
    return { compId: comp.id, physics: merged as PhysicsScene }
  },
})

/** Layers that cannot be bodies, with the reason. */
function bodyProblem(project: Project, id: string): string | null {
  const { comp, track, layer } = locateLayer(project, id)
  if (isWorld(comp)) return `"${layer.name}" is in the 3D world "${comp.name}". ${WORLD_HINT}`
  if (layer.kind === 'audio' || layer.kind === 'camera' || layer.kind === 'light') return `"${layer.name}" is a ${layer.kind} layer; it has no body to simulate.`
  if (track.groupId !== null) return `"${layer.name}" is inside a group. Make the whole group the body (physics_body on the group), or ungroup first.`
  return null
}

export const physicsBody = defineCommand({
  name: 'physics.body',
  summary: 'Make layers physics bodies, change their settings, or remove them (type null).',
  details: `type: active falls and collides, passive is fixed and others hit it (floors, ramps), animated follows its own keys and pushes others. A layer with no body gets one (active); an existing body only changes the fields you give. type null removes the body, its own joints, and joints on other bodies that hold on to it. ${UNITS} velocity is px/s, spin degrees/s (a flat comp reads z, + clockwise). mass is relative, bounce 0..1 (0 lands dead), friction 0..1, damping 0..1 is air resistance, shape picks the collision shape (auto, box, sphere, hull, outline). Refused: audio, camera and light layers, layers inside a group (make the group the body), layers in a 3D world. ids is one layer or several (id or exact name). Returns each body's settings.`,
  effect: 'write',
  input: optionalFields(PhysicsBodySchema).extend({
    ids: IdsSchema,
    type: z.enum(['active', 'passive', 'animated']).nullable().optional().describe('active, passive or animated; null removes the body'),
    velocity: VecInputSchema.optional().describe('Starting velocity [x, y] or [x, y, z] in px/s (+y is down)'),
    spin: VecInputSchema.optional().describe('Starting spin [x, y, z] in degrees/s; a flat comp reads z, + is clockwise'),
  }),
  run: async ({ ids, type, velocity, spin, ...rest }, ctx) => {
    const refs = idList(undefined, ids)
    const targets = [...new Set(refs.map((ref) => locateLayer(ctx.project, ref).layer.id))]
    const fields = given({ ...rest, velocity: velocity && vec3(velocity), spin: spin && vec3(spin) })

    if (type === null) {
      if (Object.keys(fields).length > 0) throw new CommandError('type null removes the body; it takes no other fields.')
      const bodies = targets.map((id) => locateLayer(ctx.project, id).layer).filter((l) => l.physics || l.joints)
      ctx.write('Remove physics', (draft) => {
        for (const layer of bodies) {
          const target = locateLayer(draft, layer.id).layer
          delete target.physics
          delete target.joints
        }
        removeJointsTo(draft as Project, targets)
      })
      return { bodies: targets.map((id) => ({ id, name: locateLayer(ctx.project, id).layer.name, physics: null })) }
    }

    for (const id of targets) {
      const problem = bodyProblem(ctx.project, id)
      if (problem) throw new CommandError(problem, problem.includes('inside a group') ? undefined : 'Bodies are pictures, text, shapes, paths, nested comps and groups of a flat comp.')
    }
    const plans = targets.map((id) => {
      const layer = locateLayer(ctx.project, id).layer
      const next = parseOrThrow(PhysicsBodySchema, { ...layer.physics, ...fields, ...(type !== undefined ? { type } : {}) }, `The body of "${layer.name}"`)
      return { layer, next }
    })
    const changed = plans.filter(({ layer, next }) => JSON.stringify(layer.physics) !== JSON.stringify(next))
    // Pictures imported before silhouettes were traced get theirs now, in the same step, so they collide on their outline.
    const traced = new Map<string, [number, number][][]>()
    if (ctx.silhouette) {
      for (const { layer } of changed) {
        if (layer.kind !== 'image' || traced.has(layer.mediaId)) continue
        const media = ctx.project.media.find((m) => m.id === layer.mediaId)
        if (!media || media.silhouette) continue
        const outline = await ctx.silhouette(media)
        if (outline && outline.length > 0) traced.set(media.id, outline)
      }
    }
    if (changed.length > 0) {
      ctx.write(changed.every(({ layer }) => layer.physics) ? 'Edit physics body' : 'Add physics body', (draft) => {
        for (const { layer, next } of changed) locateLayer(draft, layer.id).layer.physics = next
        for (const media of draft.media) {
          const outline = traced.get(media.id)
          if (outline) media.silhouette = outline
        }
      })
    }
    return { bodies: plans.map(({ layer, next }): { id: string; name: string; physics: PhysicsBody } => ({ id: layer.id, name: layer.name, physics: next })) }
  },
})

const capitalised = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

export const physicsForce = defineCommand({
  name: 'physics.force',
  summary: 'Add a force (wind, vortex, point, turbulence, drag) to a layer, or make a new invisible layer that carries one.',
  details: `With id, the force card goes on that layer; without it, a new layer named after the type is made in the comp (it draws nothing, spans the whole comp) at position (default 0, 0). Where the layer is and how it turns places the force: wind blows along its rotation (0 blows right, + clockwise), a vortex swirls and a point pulls around its position. strength is acceleration in px/s² (drag: % of speed lost per second; negative reverses a point or vortex), radius is how far it reaches in px (0 reaches everywhere), falloff none, linear or smooth fades it toward the radius, scale and seed shape turbulence. ${UNITS} Forces add up, so their order never changes the result. A gust is two keys on force.<forceId>.strength (keyframes.set); radius and scale key too. Edit or remove a card with effects.update using its forceId. Returns {layerId, forceId, force}.`,
  effect: 'write',
  input: z.strictObject({
    compId: IdSchema.optional().describe('For a new carrier layer; default the comp open in the editor (AtomCut: frameId)'),
    id: IdSchema.optional().describe('Put the force on this layer; omitted, a new carrier layer is made'),
    type: z.enum(['wind', 'vortex', 'point', 'turbulence', 'drag']).optional().describe('Default wind'),
    strength: z.number().optional().describe('Acceleration in px/s² (drag: % of speed lost per second). Default 600'),
    radius: z.number().min(0).optional().describe('How far it reaches in px; 0 (default) reaches everywhere'),
    falloff: z.enum(['none', 'linear', 'smooth']).optional().describe('Default smooth'),
    scale: z.number().positive().optional().describe('Turbulence cell size in px. Default 240'),
    seed: z.number().int().optional().describe('Turbulence pattern. Default 0'),
    position: VecInputSchema.optional().describe("Where the force sits: [x, y] or [x, y, z] comp px from the centre (default 0, 0 for a new layer; with id, moves that layer)"),
    rotation: z.number().optional().describe('Degrees clockwise: 0 blows right, 90 blows down (with id, turns that layer)'),
    name: z.string().min(1).optional().describe('Names the new layer (with id: the card). Default the type, e.g. "Wind"'),
  }),
  run: (input, ctx) => {
    const type = input.type ?? 'wind'
    const card = (name?: string): Force =>
      parseOrThrow(ForceSchema, { id: ctx.ids('force'), ...given({ type, strength: input.strength, radius: input.radius, falloff: input.falloff, scale: input.scale, seed: input.seed, name }) }, 'The force')
    const position = input.position && vec3(input.position)

    if (input.id !== undefined) {
      const { comp, layer } = locateLayer(ctx.project, input.id)
      if (isWorld(comp)) throw new CommandError(`"${layer.name}" is in the 3D world "${comp.name}".`, WORLD_HINT)
      if (layer.kind === 'audio') throw new CommandError(`"${layer.name}" is an audio layer; a force needs a place in the picture.`, 'Leave id out to make a new layer for the force.')
      const force = card(input.name)
      const keyed = (path: string) => (layer.animations[path]?.length ?? 0) > 0
      if (position && (keyed('transform.x') || keyed('transform.y'))) throw new CommandError(`"${layer.name}" has keys on its position, so position would be hidden by them.`)
      if (input.rotation !== undefined && keyed('transform.rotation')) throw new CommandError(`"${layer.name}" has keys on its rotation, so rotation would be hidden by them.`)
      ctx.write(`Add ${type} force`, (draft) => {
        const target = locateLayer(draft, layer.id).layer
        target.forces = [...(target.forces ?? []), force]
        if (position) {
          target.transform.x = position[0]
          target.transform.y = position[1]
          if ((input.position as VecInput).length === 3) target.transform.z = position[2]
        }
        if (input.rotation !== undefined) target.transform.rotation = input.rotation
      })
      return { layerId: layer.id, forceId: force.id, force }
    }

    const comp = flatComp(ctx, input.compId)
    const force = card()
    const [x, y, z] = position ?? [0, 0, 0]
    // A shape with no fill and no stroke draws nothing, and works in a flat comp (an empty is a 3D controller).
    const layer = parseOrThrow(
      LayerSchema,
      {
        id: ctx.ids('layer'),
        kind: 'shape',
        name: input.name ?? capitalised(type),
        startMs: 0,
        durationMs: comp.durationMs,
        transform: { x, y, ...(z !== 0 ? { z } : {}), rotation: input.rotation ?? 0 },
        shape: { type: 'rect', width: 100, height: 100 },
        fills: [],
        strokes: [],
        forces: [force],
      },
      'The force layer',
    ) as Layer
    ctx.write(`Add ${type} force`, (draft) => {
      // At the back, so its empty box never gets in the way of picking what is in front.
      findComp(draft, comp.id).tracks.push(newTrack(ctx.ids('track'), [layer]) as never)
    })
    return { layerId: layer.id, forceId: force.id, force }
  },
})

const JointFieldsSchema = z.strictObject({
  type: z.enum(['pin', 'weld', 'rope', 'spring']).optional().describe('pin: a hinge; weld: rigid; rope: keeps within its length; spring: pulls back to its length. Default pin'),
  target: z.string().min(1).nullable().optional().describe("Another body's layer id or exact name; null holds the body to the comp"),
  anchor: VecInputSchema.optional().describe("The point on this body, px from its pivot in its own axes: [x, y] or [x, y, z] (default 0, 0)"),
  targetAnchor: VecInputSchema.nullable().optional().describe('The point on the target in its own px (a comp point when target is null); null is where the anchor is at the start'),
  stiffness: z.number().min(0).optional().describe('Spring: how hard it pulls back (default 40)'),
  damping: z.number().min(0).optional().describe('Spring: how fast it stops swinging (default 2)'),
  length: z.number().min(0).nullable().optional().describe('Rope and spring: length in px; null is the distance at the start'),
  enabled: z.boolean().optional(),
})

export const physicsJoint = defineCommand({
  name: 'physics.joint',
  summary: 'Add, edit or remove joints on a physics body: pins, welds, ropes and springs to another body or to the comp.',
  details: `id is the body (physics.body first). add takes joints {type, target, anchor, targetAnchor, length, stiffness, damping, enabled}; target is another body of the same comp (id or exact name), or null for the comp itself. anchor is a point of this body in px from its pivot, targetAnchor a point of the target in its own px (a point of the comp when target is null); anchors take [x, y] or [x, y, z]. Left out, targetAnchor is where the anchor is at the start and length the distance then. edit takes [{joint: <joint id>, ...fields}], remove takes joint ids. ${UNITS} Returns every joint now on the body.`,
  effect: 'write',
  input: z.strictObject({
    id: IdSchema.describe('The body (a layer with physics)'),
    add: z.array(JointFieldsSchema).optional(),
    edit: z.array(JointFieldsSchema.extend({ joint: IdSchema.describe('The joint id') })).optional(),
    remove: z.array(IdSchema).optional().describe('Joint ids'),
  }),
  run: ({ id, add, edit, remove }, ctx) => {
    const { comp, layer } = locateLayer(ctx.project, id)
    if (!layer.physics) throw new CommandError(`"${layer.name}" is not a physics body.`, 'physics.body {ids, type} makes it one first.')
    const current = layer.joints ?? []
    if (!add && !edit && !remove) return { joints: current }

    const targetId = (ref: string | null): string | null => {
      if (ref === null) return null
      const found = locateLayer(ctx.project, ref)
      if (found.layer.id === layer.id) throw new CommandError('A joint cannot hold a body to itself.', 'Name another body, or null for the comp.')
      if (found.comp.id !== comp.id) throw new CommandError(`"${found.layer.name}" is in another comp.`, 'A joint holds a body to a body of its own comp.')
      if (!found.layer.physics) throw new CommandError(`"${found.layer.name}" is not a physics body, so a joint cannot hold on to it.`, 'physics.body {ids, type: "passive"} makes it a fixed body.')
      return found.layer.id
    }
    const fields = (item: z.infer<typeof JointFieldsSchema>) =>
      given({
        type: item.type,
        target: item.target === undefined ? undefined : targetId(item.target),
        anchor: item.anchor && vec3(item.anchor),
        targetAnchor: item.targetAnchor === undefined ? undefined : item.targetAnchor && vec3(item.targetAnchor),
        stiffness: item.stiffness,
        damping: item.damping,
        length: item.length,
        enabled: item.enabled,
      })
    const have = (jointId: string) => {
      const found = current.find((j) => j.id === jointId)
      if (!found) throw new CommandError(`"${layer.name}" has no joint "${jointId}".`, current.length > 0 ? `Its joints: ${current.map((j) => `${j.id} (${j.type})`).join(', ')}.` : 'It has no joints yet: add makes one.')
      return found
    }

    const removing = new Set((remove ?? []).map((jointId) => have(jointId).id))
    for (const item of edit ?? []) {
      if (removing.has(have(item.joint).id)) throw new CommandError(`Joint "${item.joint}" is both edited and removed.`)
    }
    const editing = new Map((edit ?? []).map((item) => [item.joint, item]))
    const joints: Joint[] = current
      .filter((j) => !removing.has(j.id))
      .map((j) => {
        const item = editing.get(j.id)
        if (!item) return deepClone(j) as Joint
        const { joint: _joint, ...rest } = item
        return parseOrThrow(JointSchema, { ...j, ...fields(rest) }, `Joint "${j.id}"`)
      })
    for (const item of add ?? []) joints.push(parseOrThrow(JointSchema, { id: ctx.ids('joint'), ...fields(item) }, 'The new joint'))

    ctx.write('Edit joints', (draft) => {
      const target = locateLayer(draft, layer.id).layer
      if (joints.length > 0) target.joints = joints
      else delete target.joints
    })
    return { joints }
  },
})

/** The ways effects.update changes a force card (values merge, enabled, index, remove). */
export interface ForceUpdate {
  values?: Record<string, unknown>
  enabled?: boolean
  index?: number
  remove?: boolean
}

const FORCE_FIELDS = ['type', 'name', 'strength', 'radius', 'falloff', 'scale', 'seed', 'enabled'] as const
const FORCE_KEYED = ['strength', 'radius', 'scale'] as const

/** effects.update on a force card of a layer: the same four ways as on an effect card. */
export function updateForce(layer: Layer, forceId: string, input: ForceUpdate, ctx: CommandContext): unknown {
  const stack = layer.forces ?? []
  const index = stack.findIndex((f) => f.id === forceId)
  const card = stack[index] as Force
  const prefix = `force.${card.id}.`
  const label = `${card.name ?? card.type} force`

  if (input.remove) {
    if (input.values !== undefined || input.enabled !== undefined || input.index !== undefined) {
      throw new CommandError('remove deletes the card; it cannot be combined with values, enabled or index.')
    }
    const droppedKeys = Object.keys(layer.animations).filter((path) => path.startsWith(prefix))
    ctx.write(`Remove ${label}`, (draft) => {
      const target = locateLayer(draft, layer.id).layer
      const forces = (target.forces ?? []).filter((f) => f.id !== card.id)
      if (forces.length > 0) target.forces = forces
      else delete target.forces
      for (const path of droppedKeys) delete target.animations[path]
    })
    return { id: layer.id, effectId: card.id, removed: true, ...(droppedKeys.length > 0 ? { droppedKeys } : {}) }
  }

  const values = input.values ?? {}
  for (const key of Object.keys(values)) {
    if (!(FORCE_FIELDS as readonly string[]).includes(key)) {
      throw new CommandError(`A force has no field "${key}".`, `Its fields: ${FORCE_FIELDS.join(', ')}.`)
    }
  }
  const keyed = FORCE_KEYED.filter((key) => key in values && (layer.animations[prefix + key]?.length ?? 0) > 0)
  if (keyed.length > 0) {
    throw new CommandError(
      `${keyed.map((k) => prefix + k).join(', ')} ${keyed.length > 1 ? 'are' : 'is'} animated, so a plain value would be hidden by the keys.`,
      `Key it at a time with layer.set {values: {"${prefix}${keyed[0]}": …}, atMs}, or keyframes.clear it first.`,
    )
  }
  if (Object.keys(values).length === 0 && input.enabled === undefined && input.index === undefined) {
    throw new CommandError('Nothing to change.', 'Pass values, enabled, index or remove.')
  }
  const next = parseOrThrow(ForceSchema, { ...card, ...values, ...(input.enabled !== undefined ? { enabled: input.enabled } : {}), id: card.id }, label)
  const to = input.index === undefined ? index : Math.min(input.index, stack.length - 1)
  ctx.write(`Edit ${label}`, (draft) => {
    const forces = (locateLayer(draft, layer.id).layer.forces ?? []) as Force[]
    forces.splice(index, 1)
    forces.splice(to, 0, next)
  })
  return { id: layer.id, effectId: card.id, index: to, force: next }
}
