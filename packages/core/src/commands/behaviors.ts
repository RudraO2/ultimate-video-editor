import { z } from 'zod'
import { findBone, findUnder } from '../characters'
import { locateLayer } from '../doc'
import { CommandError, parseOrThrow } from '../errors'
import { defineCommand } from '../registry'
import type { CommandContext } from '../registry'
import { BEHAVIOR_TYPES, type Behavior, BehaviorSchema, type Comp, type GroupLayer, IdSchema } from '../schema'
import { groupRef } from './switch'

// Behaviours: life on a group, computed live every frame (blink, breathe,
// sway, nod, glance, talk), no keys written. The commands store and check
// them; core/engine turn them into motion.

const FieldsSchema = z.record(z.string(), z.unknown()).describe('The behaviour\'s fields: behaviors.inspect {types: true} lists them with defaults')

function groupOf(ctx: CommandContext, ref: string) {
  const { comp, group } = groupRef(ctx, ref, 'Behaviours live on a group: layers.group makes one.')
  return { comp, group }
}

/** Fields as the schema wants them: AtomCut's `target: {layer, bone}` flattened, one layer where a list goes, layers by name turned into ids, bones by name into ids. */
function normalise(type: string, raw: Record<string, unknown>, comp: Comp, group: GroupLayer): Record<string, unknown> {
  const fields: Record<string, unknown> = { ...raw }
  const target = fields.target
  if (target !== undefined) {
    if (typeof target !== 'object' || target === null || Array.isArray(target)) throw new CommandError('target is {layer, bone}: one of the two.')
    delete fields.target
    for (const [k, v] of Object.entries(target as Record<string, unknown>)) {
      if (k !== 'layer' && k !== 'bone') throw new CommandError(`target has no field "${k}".`, 'target is {layer, bone}.')
      if (fields[k] === undefined) fields[k] = v
    }
  }
  const layerId = (value: unknown, what: string): string => {
    if (typeof value !== 'string') throw new CommandError(`${what} must be a layer id or name.`)
    // The group itself is a fair target (a whole character breathes, or nods, as one).
    if (value === group.id) return group.id
    return findUnder(comp, group, value).id
  }
  const layerList = (value: unknown, what: string): string[] => (Array.isArray(value) ? value : [value]).map((v) => layerId(v, what))
  if (type === 'blink' && fields.eyes !== undefined) fields.eyes = layerList(fields.eyes, 'eyes')
  if (type === 'glance' && fields.layers !== undefined) fields.layers = layerList(fields.layers, 'layers')
  if (type === 'talk' && fields.mouth !== undefined) fields.mouth = layerId(fields.mouth, 'mouth')
  if ((type === 'breathe' || type === 'sway' || type === 'nod') && fields.layer !== undefined) fields.layer = layerId(fields.layer, 'layer')
  if (fields.bone !== undefined) {
    if (typeof fields.bone !== 'string') throw new CommandError('bone must be a bone id or name.')
    if (!group.rig) throw new CommandError(`"${group.name}" has no rig, so there are no bones to name.`, 'rig.create makes the group a rig first.')
    fields.bone = findBone(group.rig.bones, fields.bone).id
  }
  if (typeof fields.voice === 'string') {
    const ref = fields.voice
    const inComp = comp.tracks.flatMap((t) => t.layers)
    const voice = inComp.find((l) => l.id === ref) ?? inComp.find((l) => l.name === ref)
    if (!voice) throw new CommandError(`The voice "${ref}" is not a layer of this comp.`, 'voice is an audio or video layer of the same comp, or null for any.')
    if (voice.kind !== 'audio' && voice.kind !== 'video') throw new CommandError(`voice "${voice.name}" is a ${voice.kind} layer: it must be an audio or video layer.`)
    fields.voice = voice.id
  }
  return fields
}

/** Checks what the schema cannot: the target pairs, the mouth being a switch, the voice being in the comp. */
function check(b: Behavior, comp: Comp, group: GroupLayer): void {
  if (b.type === 'breathe' || b.type === 'sway' || b.type === 'nod') {
    if ((b.layer === undefined) === (b.bone === undefined)) {
      throw new CommandError(`${b.type} needs exactly one target: layer or bone.`, 'layer: a layer of the group; bone: a bone of its rig.')
    }
  }
  if (b.type === 'blink' && b.eyes.length === 0) throw new CommandError('blink needs eyes: the layers that close.', 'eyes: ["Eyes"] (layers of the group).')
  if (b.type === 'glance' && b.layers.length === 0) throw new CommandError('glance needs layers: the pupils or eyes that look about.')
  if (b.type === 'talk') {
    const mouth = findUnder(comp, group, b.mouth)
    if (mouth.kind !== 'group' || mouth.switch === null) throw new CommandError(`The mouth "${mouth.name}" is not a switch.`, 'switch.create makes a group of mouth shapes into a switch first.')
  }
  if ('voice' in b && b.voice !== null) {
    const voice = comp.tracks.flatMap((t) => t.layers).find((l) => l.id === b.voice)
    if (!voice) throw new CommandError(`The voice "${b.voice}" is not a layer of this comp.`, 'voice is an audio or video layer of the same comp, or null for any.')
    if (voice.kind !== 'audio' && voice.kind !== 'video') throw new CommandError(`The voice "${voice.name}" is a ${voice.kind} layer.`, 'It must be an audio or video layer.')
  }
  if ('bone' in b && b.bone !== undefined && !group.rig?.bones.some((x) => x.id === b.bone)) {
    throw new CommandError(`"${group.name}" has no bone "${b.bone}".`, 'rig.inspect lists the bones.')
  }
  const layers = b.type === 'blink' ? b.eyes : b.type === 'glance' ? b.layers : 'layer' in b && b.layer !== undefined ? [b.layer] : []
  for (const id of layers) if (id !== group.id) findUnder(comp, group, id)
}

const nameOf = (b: Behavior) => `${b.type} behaviour`

export const behaviorsAdd = defineCommand({
  name: 'behaviors.add',
  summary: 'Give a group life: blink, breathe, sway, nod, glance or talk, computed live every frame (no keys written).',
  details:
    'groupId is the group (a character); fields are those of the type (behaviors.inspect {types: true} lists them with defaults); layers may be given by name or id, and any depth under the group is fine. blink {eyes, every s, closedMs, variance %, doubles %, closedScale}: a switch group of eyes shows its member named closed/shut (else its last member), anything else squashes. breathe {layer|bone, amount %, rate per minute, phase %, keepBottom}. sway {layer|bone, amount degrees, speed Hz, pivot}. nod {layer|bone, amount degrees at full loudness, voice, pivot}: follows the voice\'s loudness envelope. glance {layers, rangeX, rangeY px, hold s, moveMs, centre %}. talk {mouth: a switch group, voice, lead ms, map}: shows mouth shapes from the voice\'s loudness. voice is an audio or video layer, null for any one playing. Same inputs, same frames. index places it in the stack (default last). Returns {groupId, behavior}.',
  effect: 'write',
  input: z.strictObject({
    groupId: IdSchema.describe('The group (character) to bring to life'),
    type: z.enum(BEHAVIOR_TYPES),
    fields: FieldsSchema.optional(),
    index: z.number().int().min(0).optional().describe('Place in the stack; default last'),
  }),
  run: ({ groupId, type, fields, index }, ctx) => {
    const { comp, group } = groupOf(ctx, groupId)
    const made = parseOrThrow(BehaviorSchema, { id: ctx.ids('bhv'), type, ...normalise(type, fields ?? {}, comp, group) }, `The ${type} behaviour`)
    check(made, comp, group)
    ctx.write(`Add ${type}`, (draft) => {
      const target = locateLayer(draft, group.id).layer
      if (target.kind !== 'group') return
      target.behaviors.splice(index === undefined ? target.behaviors.length : Math.min(index, target.behaviors.length), 0, made)
    })
    return { groupId: group.id, behavior: made }
  },
})

export const behaviorsUpdate = defineCommand({
  name: 'behaviors.update',
  summary: "Change a behaviour's fields, switch it on or off, or move it in the stack. A field set to null goes back to its default.",
  details: 'fields merge over the behaviour (its type does not change); null clears a field to its default. enabled turns it on or off without losing it. index moves it. Returns {groupId, behavior}.',
  effect: 'write',
  input: z.strictObject({
    groupId: IdSchema,
    id: IdSchema.describe('The behaviour id (behaviors.inspect lists them)'),
    fields: FieldsSchema.optional(),
    enabled: z.boolean().optional(),
    index: z.number().int().min(0).optional(),
  }),
  run: ({ groupId, id, fields, enabled, index }, ctx) => {
    const { comp, group } = groupOf(ctx, groupId)
    const at = group.behaviors.findIndex((b) => b.id === id)
    const old = group.behaviors[at]
    if (!old) {
      throw new CommandError(`"${group.name}" has no behaviour "${id}".`, group.behaviors.length > 0 ? `Its behaviours: ${group.behaviors.map((b) => `${b.id} (${b.type})`).join(', ')}.` : 'It has none: behaviors.add makes one.')
    }
    if (fields === undefined && enabled === undefined && index === undefined) throw new CommandError('Nothing to change.', 'Pass fields, enabled or index.')
    if (fields && 'type' in fields && fields.type !== old.type) throw new CommandError('A behaviour keeps its type.', 'Remove it and add another.')
    const { type: _type, ...rest } = fields ?? {}
    const merged: Record<string, unknown> = { ...old, ...normalise(old.type, Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== null)), comp, group) }
    for (const [key, value] of Object.entries(rest)) if (value === null) delete merged[key]
    if (enabled !== undefined) merged.enabled = enabled
    merged.id = old.id
    // A null voice is a real value (any voice), so it stays unless the caller cleared it to the default, which is the same.
    const next = parseOrThrow(BehaviorSchema, merged, `The ${nameOf(old)}`)
    check(next, comp, group)
    const to = index === undefined ? at : Math.min(index, group.behaviors.length - 1)
    ctx.write(`Edit ${old.type}`, (draft) => {
      const target = locateLayer(draft, group.id).layer
      if (target.kind !== 'group') return
      target.behaviors.splice(at, 1)
      target.behaviors.splice(to, 0, next)
    })
    return { groupId: group.id, behavior: next, index: to }
  },
})

export const behaviorsRemove = defineCommand({
  name: 'behaviors.remove',
  summary: 'Remove a behaviour from a group.',
  effect: 'write',
  input: z.strictObject({ groupId: IdSchema, id: IdSchema.describe('The behaviour id') }),
  run: ({ groupId, id }, ctx) => {
    const { group } = groupOf(ctx, groupId)
    const old = group.behaviors.find((b) => b.id === id)
    if (!old) throw new CommandError(`"${group.name}" has no behaviour "${id}".`, group.behaviors.length > 0 ? `Its behaviours: ${group.behaviors.map((b) => `${b.id} (${b.type})`).join(', ')}.` : 'It has none.')
    ctx.write(`Remove ${old.type}`, (draft) => {
      const target = locateLayer(draft, group.id).layer
      if (target.kind === 'group') target.behaviors = target.behaviors.filter((b) => b.id !== id)
    })
    return { groupId: group.id, removed: id }
  },
})

type JsonField = { description?: string; default?: unknown }

export const behaviorsInspect = defineCommand({
  name: 'behaviors.inspect',
  summary: "List a group's behaviours, or every group's in the open comp; types true lists the kinds with their fields and defaults.",
  details: 'groupId limits it to one group; without it, every group of every comp that has behaviours. types true adds {types: [{type, fields: {name: {description, default, required}}}]}. Returns {groups: [{groupId, name, behaviors}]}.',
  effect: 'read',
  input: z.strictObject({
    groupId: IdSchema.optional(),
    types: z.boolean().optional().describe('Also list every behaviour type with its fields and defaults'),
  }),
  run: ({ groupId, types }, ctx) => {
    const groups: { groupId: string; name: string; behaviors: Behavior[] }[] = []
    if (groupId !== undefined) {
      const { group } = groupOf(ctx, groupId)
      groups.push({ groupId: group.id, name: group.name, behaviors: group.behaviors })
    } else {
      for (const comp of ctx.project.comps) {
        for (const track of comp.tracks) {
          for (const layer of track.layers) if (layer.kind === 'group' && layer.behaviors.length > 0) groups.push({ groupId: layer.id, name: layer.name, behaviors: layer.behaviors })
        }
      }
    }
    if (!types) return { groups }
    const kinds = BehaviorSchema.options.map((option) => {
      const json = z.toJSONSchema(option, { io: 'input' }) as { properties?: Record<string, JsonField>; required?: string[] }
      const fields = Object.fromEntries(
        Object.entries(json.properties ?? {})
          .filter(([key]) => key !== 'id' && key !== 'type')
          .map(([key, spec]) => [key, { ...(spec.description ? { description: spec.description } : {}), ...(spec.default !== undefined ? { default: spec.default } : {}), required: (json.required ?? []).includes(key) }]),
      )
      return { type: option.shape.type.value, fields }
    })
    return { groups, types: kinds }
  },
})
