import { z } from 'zod'
import { boneCycle, clampToLimits, findBone, limitsProblem, looseName } from '../characters'
import { idList } from '../compat'
import { locateLayer } from '../doc'
import { CommandError, parseOrThrow } from '../errors'
import { groupMembers } from '../groups'
import { upsertKey } from '../keys'
import { evaluateProperty, resolveProperty } from '../properties'
import { defineCommand } from '../registry'
import type { CommandContext } from '../registry'
import { BIND_MODES, BONE_CHANNELS, type Bone, BoneIkSchema, BoneLimitsSchema, BoneSchema, IdSchema, type Layer, RigSchema } from '../schema'
import { groupOrWrap, groupRef } from './switch'

// Rigs: bones on a group that its direct members ride. The commands only
// store bones, poses and binds; the engine turns them into motion.

const Vec2Input = z.tuple([z.number(), z.number()])

const IkInputSchema = z.strictObject({
  target: z.string().min(1).describe('The bone to reach for (name or id)'),
  chain: z.union([z.literal(1), z.literal(2)]).optional().describe('Bones that turn: 2 (default) this one and its parent, 1 this one alone'),
  flip: z.boolean().optional().describe('Bend the other way'),
  mix: z.number().min(0).max(1).optional().describe('0 none … 1 (default) all'),
})

const BoneFields = {
  head: Vec2Input.describe('Where the bone starts, comp px [x, y]'),
  tail: Vec2Input.describe('Where the bone ends, comp px [x, y]'),
  name: z.string().min(1).optional().describe('Default "Bone 1", "Bone 2"…'),
  parent: z.string().min(1).nullable().optional().describe('The parent bone (name or id); null for a root; left out, the bone before it in the list'),
  deform: z.boolean().optional().describe('false makes it a control no piece rides; default true'),
  limits: BoneLimitsSchema.optional().describe('Allowed pose range per channel: {rotation, x, y, scale: [min, max]}'),
  ik: IkInputSchema.nullable().optional(),
}

const BoneInputSchema = z.strictObject(BoneFields)
type BoneInput = z.infer<typeof BoneInputSchema>

const BoneEditSchema = z.strictObject({
  bone: z.string().min(1).describe('The bone to change (name or id)'),
  head: BoneFields.head.optional(),
  tail: BoneFields.tail.optional(),
  name: BoneFields.name,
  parent: BoneFields.parent,
  deform: BoneFields.deform,
  limits: BoneLimitsSchema.nullable().optional().describe('New limits; null frees the bone'),
  ik: BoneFields.ik,
})

/** The rig group a command works on, with its bones. */
function rigOf(ctx: CommandContext, ref: string) {
  const { comp, group } = groupRef(ctx, ref, 'rig.create makes a group a rig.')
  if (!group.rig) throw new CommandError(`"${group.name}" is not a rig.`, 'rig.create {ids: "<group>", bones: […]} makes it one.')
  return { comp, group, rig: group.rig }
}

const summary = (bones: readonly Bone[]) => bones.map((b) => ({ id: b.id, name: b.name, parent: b.parent }))

/** A bone's mutable draft fields from input, ik targets resolved against `bones`. */
function ikFrom(ik: z.infer<typeof IkInputSchema>, bones: readonly Bone[], self: string, previous?: Bone['ik']): NonNullable<Bone['ik']> {
  const target = findBone(bones, ik.target)
  if (target.id === self) throw new CommandError('A bone cannot reach for itself.', 'Name another bone as the target.')
  const { target: _target, ...rest } = ik
  return parseOrThrow(BoneIkSchema, { ...(previous ?? {}), ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)), target: target.id }, `The IK of "${self}"`)
}

/** Fresh bones from input, parents and IK targets resolved against `known` plus themselves (so a bone may name one later in the list). */
function newBones(inputs: BoneInput[], known: readonly Bone[], ctx: CommandContext): Bone[] {
  const made: Bone[] = inputs.map((input, i) => {
    if (input.head[0] === input.tail[0] && input.head[1] === input.tail[1]) throw new CommandError(`Bone ${i + 1} has its head and tail at the same point.`, 'A bone needs a length: head and tail differ.')
    const problem = limitsProblem(input.limits)
    if (problem) throw new CommandError(`Bone ${i + 1}: ${problem}`)
    return parseOrThrow(
      BoneSchema,
      { id: ctx.ids('bone'), name: input.name ?? `Bone ${known.length + i + 1}`, head: input.head, tail: input.tail, parent: null, ...(input.deform !== undefined ? { deform: input.deform } : {}), ...(input.limits ? { limits: input.limits } : {}) },
      `Bone ${i + 1}`,
    )
  })
  const all = [...known, ...made]
  made.forEach((bone, i) => {
    const input = inputs[i] as BoneInput
    if (input.parent === undefined) bone.parent = i > 0 ? (made[i - 1] as Bone).id : null
    else bone.parent = input.parent === null ? null : findBone(all, input.parent).id
    if (input.ik) bone.ik = ikFrom(input.ik, all, bone.id)
  })
  return made
}

/** Throws when two bones share a name (names are how agents point at bones). */
function checkNames(bones: readonly Bone[]): void {
  const seen = new Map<string, Bone>()
  for (const bone of bones) {
    const key = looseName(bone.name)
    const other = seen.get(key)
    if (other) throw new CommandError(`Two bones are called "${bone.name}" (${other.id} and ${bone.id}).`, 'Give each bone its own name.')
    seen.set(key, bone)
  }
}

export const rigCreate = defineCommand({
  name: 'rig.create',
  summary: 'Make a group a rig with bones that its members ride: FK, two-bone IK, limits. Pieces follow their bone whole.',
  details:
    'ids are the layers to group as the rig (they are wrapped with layers.group), or one existing group. bones is a list of {name, head: [x, y], tail: [x, y], parent, deform, limits, ik}: comp px in the group\'s own space (its transform not counted). parent is a name or id, null for a root, left out the bone before it in the list (so a chain is just the bones in order). deform false makes a control bone that no piece rides. limits {rotation, x, y, scale: [min, max]} hold the pose. ik {target, chain 1|2, flip, mix} makes the bone reach for the target bone\'s head. Pose bones with rig.pose or by keying bone.<id>.rotation|x|y|scale; bind pieces with rig.bind (default: the bone running furthest through a piece rides it). Returns {rigId, bones: [{id, name, parent}]}.',
  effect: 'write',
  input: z.strictObject({
    ids: z.union([IdSchema, z.array(IdSchema).min(1)]).optional().describe('The layers to group as the rig, or one existing group'),
    id: IdSchema.optional().describe('Same as ids, for one layer or group'),
    name: z.string().min(1).optional().describe('The group\'s name, e.g. "Mia"'),
    bones: z.array(BoneInputSchema).optional(),
  }),
  run: async ({ ids, id, name, bones }, ctx) => {
    const refs = idList(id, ids)
    const only = refs.length === 1 ? locateLayer(ctx.project, refs[0] as string).layer : undefined
    if (only?.kind === 'group' && only.rig) throw new CommandError(`"${only.name}" is already a rig.`, 'rig.bone {rigId, add: […]} adds bones to it.')
    const made = newBones(bones ?? [], [], ctx)
    checkNames(made)
    const bad = boneCycle(made)
    if (bad) throw new CommandError(`Bone "${bad.name}" is its own ancestor.`, 'A bone\'s parent chain must end at a root.')
    const { groupId } = await groupOrWrap(ctx, refs, name, 'layers.list shows layer ids.')
    const rig = parseOrThrow(RigSchema, { bones: made }, 'The rig')
    ctx.write('Make rig', (draft) => {
      const target = locateLayer(draft, groupId).layer
      if (target.kind === 'group') target.rig = rig
    })
    return { rigId: groupId, bones: summary(made), ...(made.length === 0 ? { hint: 'No bones yet: rig.bone {rigId, add: […]} adds them.' } : {}) }
  },
})

export const rigBone = defineCommand({
  name: 'rig.bone',
  summary: 'Add, edit or remove the bones of a rig.',
  details:
    'add takes bones as rig.create does. edit takes [{bone: name|id, head, tail, name, parent, deform, limits (null frees), ik ({target, chain, flip, mix} or null)}], only the fields given change. remove takes names or ids: a removed bone\'s children move to its parent, and its pose keys (bone.<id>.*), IK that reaches for it, pieces bound to it and behaviours on it are dropped (the result lists them). Returns {rigId, bones: [{id, name, parent}], added, removed}.',
  effect: 'write',
  input: z.strictObject({
    rigId: IdSchema.describe('The rig group'),
    add: z.array(BoneInputSchema).optional(),
    edit: z.array(BoneEditSchema).optional(),
    remove: z.array(z.string().min(1)).optional().describe('Bone names or ids'),
  }),
  run: ({ rigId, add, edit, remove }, ctx) => {
    const { comp, group, rig } = rigOf(ctx, rigId)
    if (!add && !edit && !remove) return { rigId: group.id, bones: summary(rig.bones), added: [], removed: [] }

    const removing = new Set((remove ?? []).map((ref) => findBone(rig.bones, ref).id))
    const edits = (edit ?? []).map((item) => ({ item, bone: findBone(rig.bones, item.bone) }))
    for (const { item, bone } of edits) {
      if (removing.has(bone.id)) throw new CommandError(`Bone "${item.bone}" is both edited and removed.`)
    }
    if (new Set(edits.map((e) => e.bone.id)).size !== edits.length) throw new CommandError('A bone is edited twice in one call.', 'Merge the edits into one entry.')

    // The bones as they will be: copies with the edits applied, then the new ones.
    const next: Bone[] = rig.bones.map((b) => parseOrThrow(BoneSchema, JSON.parse(JSON.stringify(b)), `Bone "${b.name}"`))
    const byId = new Map(next.map((b) => [b.id, b]))
    for (const { item, bone } of edits) {
      const target = byId.get(bone.id) as Bone
      if (item.head) target.head = item.head
      if (item.tail) target.tail = item.tail
      if (target.head[0] === target.tail[0] && target.head[1] === target.tail[1]) throw new CommandError(`"${target.name}" would have its head and tail at the same point.`, 'A bone needs a length.')
      if (item.name !== undefined) target.name = item.name
      if (item.deform !== undefined) target.deform = item.deform
      if (item.limits !== undefined) {
        const problem = limitsProblem(item.limits)
        if (problem) throw new CommandError(`"${target.name}": ${problem}`)
        if (item.limits === null) delete target.limits
        else target.limits = item.limits
      }
    }
    const added = newBones(add ?? [], next, ctx)
    const everyone = [...next, ...added]
    for (const { item, bone } of edits) {
      const target = byId.get(bone.id) as Bone
      if (item.parent !== undefined) {
        const parent = item.parent === null ? null : findBone(everyone, item.parent)
        if (parent && removing.has(parent.id)) throw new CommandError(`Bone "${parent.name}" is being removed, so it cannot be a parent.`)
        target.parent = parent?.id ?? null
      }
      if (item.ik !== undefined) {
        if (item.ik === null) delete target.ik
        else target.ik = ikFrom(item.ik, everyone, target.id, target.ik)
      }
    }
    for (const bone of added) {
      if (bone.parent !== null && removing.has(bone.parent)) throw new CommandError(`Bone "${bone.name}" hangs from a bone that is being removed.`)
    }
    // Removal: children move up to the removed bone's parent; IK that reached for it stops.
    const parentOf = new Map(everyone.map((b) => [b.id, b.parent]))
    const upFrom = (parent: string | null): string | null => {
      let at = parent
      while (at !== null && removing.has(at)) at = parentOf.get(at) ?? null
      return at
    }
    const kept = everyone.filter((b) => !removing.has(b.id))
    const droppedIk: string[] = []
    for (const bone of kept) {
      bone.parent = upFrom(bone.parent)
      if (bone.ik && removing.has(bone.ik.target)) {
        delete bone.ik
        droppedIk.push(bone.id)
      }
    }
    checkNames(kept)
    const bad = boneCycle(kept)
    if (bad) throw new CommandError(`Bone "${bad.name}" would be its own ancestor.`, "A bone's parent chain must end at a root.")

    const droppedKeys = Object.keys(group.animations).filter((p) => [...removing].some((id) => p.startsWith(`bone.${id}.`)))
    const members = groupMembers(comp, group.id).filter((m) => m.bind?.bone !== undefined && removing.has(m.bind.bone))
    const behaviors = group.behaviors.filter((b) => 'bone' in b && b.bone !== undefined && removing.has(b.bone))
    const rigNow = parseOrThrow(RigSchema, { bones: kept }, 'The rig')
    ctx.write('Edit bones', (draft) => {
      const target = locateLayer(draft, group.id).layer
      if (target.kind !== 'group') return
      target.rig = rigNow
      for (const path of droppedKeys) delete target.animations[path]
      if (behaviors.length > 0) target.behaviors = target.behaviors.filter((b) => !behaviors.some((x) => x.id === b.id))
      for (const member of members) {
        const m = locateLayer(draft, member.id).layer
        delete m.bind
      }
    })
    return {
      rigId: group.id,
      bones: summary(kept),
      added: added.map((b) => ({ id: b.id, name: b.name })),
      removed: [...removing],
      ...(droppedKeys.length > 0 ? { droppedKeys } : {}),
      ...(droppedIk.length > 0 ? { droppedIk } : {}),
      ...(members.length > 0 ? { unbound: members.map((m) => m.id) } : {}),
      ...(behaviors.length > 0 ? { droppedBehaviors: behaviors.map((b) => b.id) } : {}),
    }
  },
})

const PoseItemSchema = z.strictObject({
  bone: z.string().min(1).describe('The bone (name or id)'),
  rotation: z.number().optional().describe('Degrees clockwise from rest'),
  x: z.number().optional().describe('px from rest'),
  y: z.number().optional().describe('px from rest'),
  scale: z.number().min(0).optional().describe('Stretch along the bone; 1 is rest'),
})

const REST: Record<(typeof BONE_CHANNELS)[number], number> = { rotation: 0, x: 0, y: 0, scale: 1 }

export const rigPose = defineCommand({
  name: 'rig.pose',
  summary: 'Pose bones: set their resting pose, or key it at a time. Values are changes from rest, held to each bone\'s limits.',
  details:
    'poses is [{bone: name|id, rotation (degrees clockwise), x, y (px), scale (stretch along the bone, 1 is rest)}]; channels left out stay. Values beyond a bone\'s limits are held to them (the result says clamped). With key true, or when a channel is already keyed, it writes keys at atMs (comp ms; default 0) through the keyframe machinery (bone.<id>.<channel>, ease-in-out); otherwise it sets the resting value, refused for a keyed channel only when key is false. reset true sets the listed bones (all of them when poses is empty) back to rest. Returns {rigId, atMs, poses: [{bone, name, rotation, x, y, scale, keyed, clamped}]}.',
  effect: 'write',
  input: z.strictObject({
    rigId: IdSchema.describe('The rig group'),
    atMs: z.number().optional().describe('Comp time of the keys, ms; default 0'),
    key: z.boolean().optional().describe('Write keys at atMs; default true for a channel that already has keys'),
    reset: z.boolean().optional().describe('Back to rest (every channel of the listed bones, or of all bones)'),
    poses: z.array(PoseItemSchema).optional(),
  }),
  run: ({ rigId, atMs, key, reset, poses }, ctx) => {
    const { group, rig } = rigOf(ctx, rigId)
    const items = poses ?? []
    if (items.length === 0 && !reset) throw new CommandError('Nothing to pose.', 'poses: [{bone: "Arm", rotation: 20}], or reset: true.')
    const time = atMs ?? 0
    const local = time - group.startMs

    // One entry per bone: what to write on each channel.
    const wanted = new Map<string, Partial<Record<(typeof BONE_CHANNELS)[number], number>>>()
    if (reset) for (const ref of items.length > 0 ? items.map((i) => i.bone) : rig.bones.map((b) => b.id)) wanted.set(findBone(rig.bones, ref).id, { ...REST })
    for (const item of items) {
      const bone = findBone(rig.bones, item.bone)
      const entry = wanted.get(bone.id) ?? {}
      for (const channel of BONE_CHANNELS) if (item[channel] !== undefined && !reset) entry[channel] = item[channel]
      if (reset && BONE_CHANNELS.some((c) => item[c] !== undefined)) throw new CommandError('reset takes bones, not values.', 'Pose after the reset in a second call.')
      wanted.set(bone.id, entry)
    }

    const plan = [...wanted].map(([id, values]) => {
      const bone = rig.bones.find((b) => b.id === id) as Bone
      let clamped = false
      const writes = BONE_CHANNELS.flatMap((channel) => {
        const given = values[channel]
        if (given === undefined) return []
        const value = clampToLimits(bone, channel, given)
        if (value !== given) clamped = true
        const path = `bone.${id}.${channel}`
        const keyed = (group.animations[path]?.length ?? 0) > 0
        return [{ channel, path, value, key: key ?? keyed }]
      })
      return { bone, writes, clamped }
    })
    if (plan.some((p) => p.writes.some((w) => w.key)) && local < 0) {
      throw new CommandError(`atMs ${time} is before "${group.name}" starts (${group.startMs} ms).`, 'Key inside the rig group\'s time span.')
    }
    ctx.write('Pose rig', (draft) => {
      const target = locateLayer(draft, group.id).layer
      if (target.kind !== 'group') return
      for (const { bone, writes } of plan) {
        const live = target.rig?.bones.find((b) => b.id === bone.id)
        for (const w of writes) {
          if (w.key) {
            const keys = target.animations[w.path] ?? []
            upsertKey(keys, { t: local, v: w.value, ease: 'ease-in-out' })
            target.animations[w.path] = keys
          } else if (live) {
            live.pose[w.channel] = w.value
          }
        }
      }
    })
    return {
      rigId: group.id,
      atMs: time,
      poses: plan.map(({ bone, writes, clamped }) => {
        const at = (channel: (typeof BONE_CHANNELS)[number]) => writes.find((w) => w.channel === channel)?.value ?? bone.pose[channel]
        return {
          bone: bone.id,
          name: bone.name,
          rotation: at('rotation'),
          x: at('x'),
          y: at('y'),
          scale: at('scale'),
          keyed: writes.filter((w) => w.key).map((w) => w.path),
          ...(clamped ? { clamped: true } : {}),
        }
      }),
    }
  },
})

export const rigBind = defineCommand({
  name: 'rig.bind',
  summary: 'Choose which bone a piece of a rig rides: auto (the engine picks the best bone), rigid (one bone), or none (stays put).',
  details:
    'ids are direct members of one rig group. mode auto (default for a piece with no bind) lets the engine pick the deform bone running furthest through the piece; rigid needs bone (name or id) and the piece follows that bone whole; none leaves it where it is. Returns {rigId, binds: [{id, name, mode, bone}]}.',
  effect: 'write',
  input: z.strictObject({
    ids: z.union([IdSchema, z.array(IdSchema).min(1)]).describe('Direct members of a rig'),
    mode: z.enum(BIND_MODES),
    bone: z.string().min(1).optional().describe('The bone, for rigid (name or id)'),
  }),
  run: ({ ids, mode, bone }, ctx) => {
    const located = idList(undefined, ids).map((ref) => locateLayer(ctx.project, ref))
    const parents = new Set(located.map((l) => l.track.groupId))
    const parentId = located[0]?.track.groupId ?? null
    if (parentId === null || parents.size !== 1) {
      throw new CommandError('The layers must all be direct members of one rig group.', 'rig.create makes a group a rig; its members are the layers in it, one level down.')
    }
    const { group, rig } = rigOf(ctx, parentId)
    if (mode === 'rigid' && bone === undefined) throw new CommandError('rigid needs a bone.', `bone: a name or id; this rig's bones: ${rig.bones.map((b) => b.name).join(', ') || 'none yet'}.`)
    if (mode !== 'rigid' && bone !== undefined) throw new CommandError(`bone only goes with mode rigid, not ${mode}.`)
    const found = bone === undefined ? undefined : findBone(rig.bones, bone)
    const bind = { mode, ...(found ? { bone: found.id } : {}) }
    ctx.write('Bind to bones', (draft) => {
      for (const l of located) locateLayer(draft, l.layer.id).layer.bind = { ...bind }
    })
    return { rigId: group.id, binds: located.map((l) => ({ id: l.layer.id, name: l.layer.name, mode, ...(found ? { bone: found.id } : {}) })) }
  },
})

export const rigInspect = defineCommand({
  name: 'rig.inspect',
  summary: 'Read a rig: its bones (rest head and tail, parent, limits, IK), their pose at a time, and what each piece is bound to.',
  details: 'atMs is comp ms (default the playhead, else 0): keyed pose channels are read at that time. Binds are as stored: a piece with no bind is auto. Returns {rigId, name, bones, members}.',
  effect: 'read',
  input: z.strictObject({
    rigId: IdSchema.describe('The rig group'),
    atMs: z.number().optional().describe('Comp time, ms; default the playhead'),
  }),
  run: ({ rigId, atMs }, ctx) => {
    const { comp, group, rig } = rigOf(ctx, rigId)
    const time = atMs ?? ctx.view.playheadMs ?? 0
    const local = time - group.startMs
    const nameOf = new Map(rig.bones.map((b) => [b.id, b.name]))
    const at = (bone: Bone, channel: (typeof BONE_CHANNELS)[number]): number => {
      const spec = resolveProperty(group as Layer, `bone.${bone.id}.${channel}`)[0]
      return (spec ? (evaluateProperty(group as Layer, spec, local) as number | undefined) : undefined) ?? bone.pose[channel]
    }
    return {
      rigId: group.id,
      name: group.name,
      atMs: time,
      bones: rig.bones.map((b) => ({
        id: b.id,
        name: b.name,
        head: b.head,
        tail: b.tail,
        parent: b.parent,
        ...(b.parent !== null ? { parentName: nameOf.get(b.parent) } : {}),
        deform: b.deform,
        ...(b.limits ? { limits: b.limits } : {}),
        ...(b.ik ? { ik: b.ik } : {}),
        pose: { rotation: at(b, 'rotation'), x: at(b, 'x'), y: at(b, 'y'), scale: at(b, 'scale') },
        keyed: BONE_CHANNELS.filter((c) => (group.animations[`bone.${b.id}.${c}`]?.length ?? 0) > 0),
      })),
      members: groupMembers(comp, group.id).map((m) => ({ id: m.id, name: m.name, bind: m.bind ?? { mode: 'auto' } })),
    }
  },
})
