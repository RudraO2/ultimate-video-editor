import { z } from 'zod'
import { findMember, memberInfos } from '../characters'
import { idList } from '../compat'
import { locateLayer } from '../doc'
import { CommandError } from '../errors'
import { upsertKey } from '../keys'
import { defineCommand } from '../registry'
import type { CommandContext } from '../registry'
import { type GroupLayer, IdSchema } from '../schema'

// Switches: a group that shows one of its members (a drawing swap: mouths,
// eyes, hands). The value is the member's index from the top, keyable with
// hold keys; the commands take a member's name or its index.

const ShowSchema = z.union([z.string().min(1), z.number().int().min(0)]).describe("A member's name (case and punctuation ignored) or its index from the top")

/** A group by id or name; anything else is refused with `what` to do instead. */
export function groupRef(ctx: CommandContext, ref: string, what: string) {
  const found = locateLayer(ctx.project, ref)
  if (found.layer.kind !== 'group') throw new CommandError(`"${found.layer.name}" is a ${found.layer.kind} layer, not a group.`, what)
  return { comp: found.comp, group: found.layer as GroupLayer }
}

/**
 * The group a command works on: the one group named, or a new group made of
 * the layers named (layers.group, in the same step). `created` says which.
 */
export async function groupOrWrap(ctx: CommandContext, refs: string[], name: string | undefined, then: string): Promise<{ groupId: string; created: boolean }> {
  const only = refs.length === 1 ? locateLayer(ctx.project, refs[0] as string).layer : undefined
  if (only?.kind === 'group') {
    if (name !== undefined && name !== only.name) {
      // Naming an existing group renames it.
      const id = only.id
      ctx.write('Rename group', (draft) => {
        locateLayer(draft, id).layer.name = name
      })
    }
    return { groupId: only.id, created: false }
  }
  const grouped = await ctx.call('layers.group', { ids: refs, ...(name !== undefined ? { name } : {}) })
  if (!grouped.ok) throw new CommandError(grouped.error, grouped.hint ?? then)
  return { groupId: (grouped.value as { groupId: string }).groupId, created: true }
}

export const switchCreate = defineCommand({
  name: 'switch.create',
  summary: 'Make a switch: a group that shows one of its members (mouth shapes, eyes, hands), picked by name or index and keyable.',
  details:
    'ids are the layers to group as the switch\'s members (front first; the front-most is member 0), or one existing group to make into a switch. name names the group. show is the member shown to begin with (name or index; default 0, the top). Each member is one drawing: key which one shows with switch.show {key: true}, or key the "switch" property (keys hold). The group\'s box stays the union of all members, so its pivot never jumps. Returns {switchId, members: [{index, id, name}], show}.',
  effect: 'write',
  input: z.strictObject({
    ids: z.union([IdSchema, z.array(IdSchema).min(1)]).optional().describe('The layers to group as members, or one existing group'),
    id: IdSchema.optional().describe('Same as ids, for one layer or group'),
    name: z.string().min(1).optional().describe('The group\'s name, e.g. "Mouth"'),
    show: ShowSchema.optional().describe('The member shown to begin with; default 0'),
  }),
  run: async ({ ids, id, name, show }, ctx) => {
    const refs = idList(id, ids)
    const { groupId } = await groupOrWrap(ctx, refs, name, 'layers.list shows layer ids.')
    const { comp, group } = groupRef(ctx, groupId, 'switch.create takes layers or a group.')
    const member = findMember(comp, group, show ?? 0)
    ctx.write('Make switch', (draft) => {
      const target = locateLayer(draft, groupId).layer
      if (target.kind === 'group') target.switch = member.index
    })
    return { switchId: groupId, members: memberInfos(comp, group), show: member.index }
  },
})

export const switchShow = defineCommand({
  name: 'switch.show',
  summary: 'Pick which member a switch shows, now or keyed at a time (a hold key), or turn the switch off (a plain group again).',
  details:
    'show is a member\'s name (case and punctuation ignored) or index from the top; an unknown name lists the members. With key true, or atMs given, or when the switch is already keyed, it writes a hold key on "switch" at atMs (comp ms; default the playhead): the drawing changes there and stays until the next key. Otherwise it sets the resting value (refused while the switch has keys, which would hide it). off true removes the switch (and its keys): the group shows all its members again. Returns {id, member, keyed}.',
  effect: 'write',
  input: z.strictObject({
    id: IdSchema.describe('The switch group'),
    show: ShowSchema.optional(),
    off: z.boolean().optional().describe('Make it a plain group again'),
    atMs: z.number().optional().describe('Comp time of the key, ms; default the playhead'),
    key: z.boolean().optional().describe('Write a hold key at atMs; default true when atMs is given or the switch is already keyed'),
  }),
  run: ({ id, show, off, atMs, key }, ctx) => {
    const { comp, group } = groupRef(ctx, id, 'switch.show works on a group made by switch.create.')
    if (off) {
      if (show !== undefined || key || atMs !== undefined) throw new CommandError('off makes the group plain; it takes no show, key or atMs.')
      if (group.switch === null) return { id: group.id, member: null, keyed: false }
      ctx.write('Switch off', (draft) => {
        const target = locateLayer(draft, group.id).layer
        if (target.kind !== 'group') return
        target.switch = null
        delete target.animations.switch
      })
      return { id: group.id, member: null, keyed: false }
    }
    if (group.switch === null) throw new CommandError(`"${group.name}" is not a switch.`, 'switch.create {ids: "<group>"} makes a group a switch.')
    if (show === undefined) throw new CommandError('Say which member to show.', `show: a name or an index; the members, from the top: ${memberInfos(comp, group).map((m) => `${m.index} ${m.name}`).join(', ')}.`)
    const member = findMember(comp, group, show)
    const keyed = (group.animations.switch?.length ?? 0) > 0
    const keying = key ?? (atMs !== undefined || keyed)
    if (keying) {
      const time = atMs ?? ctx.view.playheadMs
      if (time === undefined) throw new CommandError('A key needs a time.', 'Pass atMs (comp ms).')
      const local = time - group.startMs
      if (local < 0) throw new CommandError(`atMs ${time} is before "${group.name}" starts (${group.startMs} ms).`, 'Key inside the group\'s time span, or move the group earlier.')
      ctx.write('Key switch', (draft) => {
        const target = locateLayer(draft, group.id).layer
        const keys = target.animations.switch ?? []
        upsertKey(keys, { t: local, v: member.index, ease: 'hold' }, false)
        target.animations.switch = keys
      })
      return { id: group.id, member, keyed: true, atMs: time }
    }
    if (keyed) {
      throw new CommandError(`"${group.name}" has keys on its switch, so a resting value would be hidden by them.`, 'Pass key: true (with atMs) to key it there, or keyframes.clear the "switch" property first.')
    }
    ctx.write('Show member', (draft) => {
      const target = locateLayer(draft, group.id).layer
      if (target.kind === 'group') target.switch = member.index
    })
    return { id: group.id, member, keyed: false }
  },
})
