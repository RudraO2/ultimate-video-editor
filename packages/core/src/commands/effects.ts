import { z } from 'zod'
import { locateLayer } from '../doc'
import {
  type Effect,
  EFFECT_DOMAINS,
  EFFECT_PREFIX,
  type EffectDef,
  type EffectDomain,
  effectDefs,
  findEffectDef,
  LATER_EFFECTS,
  laterDomain,
  newEffect,
  valuesSchema,
} from '../effects'
import { CommandError, parseOrThrow } from '../errors'
import { effectStack } from '../properties'
import { defineCommand } from '../registry'
import { updateForce } from './physics'
import { IdSchema, type Layer } from '../schema'

/** Refuses a domain this editor lacks, naming the step that brings it. */
function domainOf(domain: string): EffectDomain {
  if ((EFFECT_DOMAINS as readonly string[]).includes(domain)) return domain as EffectDomain
  const later = laterDomain(domain)
  if (later) throw new CommandError(`The ${domain} effect domain is not in this editor yet; it comes in ${later}.`, 'Domains now: layer (whole-layer pixels) and text (per glyph).')
  throw new CommandError(`No effect domain "${domain}".`, 'Use layer (whole-layer pixels) or text (per glyph, text layers).')
}

function defOf(domain: EffectDomain, type: string): EffectDef {
  const def = findEffectDef(domain, type)
  if (def) return def
  const types = effectDefs(domain).map((d) => d.type)
  if (domain === 'layer' && Object.hasOwn(LATER_EFFECTS, type)) {
    throw new CommandError(`The ${type} effect is not in this editor yet; it comes in ${LATER_EFFECTS[type]}.`, `Layer effects now: ${types.join(', ')}.`)
  }
  const other: EffectDomain = domain === 'layer' ? 'text' : 'layer'
  if (findEffectDef(other, type)) {
    throw new CommandError(`"${type}" is a ${other} effect, not a ${domain} one.`, `Pass domain "${other}"${other === 'text' ? ' (text layers only)' : ''}. ${domain} effects: ${types.join(', ')}.`)
  }
  throw new CommandError(`No ${domain} effect "${type}".`, `${domain} effects: ${types.join(', ')} (catalog.list ${domain}-effects).`)
}

/** Checks values for a card: every key a field of it, every value in range. */
function checkValues(def: EffectDef, values: Record<string, unknown>): Record<string, unknown> {
  const fields = Object.keys(def.fields)
  for (const key of Object.keys(values)) {
    if (!fields.includes(key)) {
      throw new CommandError(`${def.type} has no field "${key}".`, `Its fields: ${fields.join(', ')} (catalog.get ${def.domain}-effects ${def.type} gives ranges).`)
    }
  }
  return parseOrThrow(valuesSchema(def), values, `${def.type} values`) as Record<string, unknown>
}

function stackOrThrow(layer: Layer, domain: EffectDomain): Effect[] {
  if (layer.kind === 'audio') throw new CommandError(`"${layer.name}" is an audio layer: it has no pixels for effects.`, 'Audio effects come in phase D.')
  const stack = effectStack(layer, domain)
  if (!stack) throw new CommandError(`Text effects draw under each glyph; "${layer.name}" is a ${layer.kind} layer.`, 'Use domain "layer" for a whole-layer shadow, glow or outline.')
  return stack
}

type MintId = (prefix: string) => string

/** A card as layer.create takes it: {type, ...fields}, the id optional. */
export const LooseEffectSchema = z.record(z.string(), z.unknown())

/** A loose card ({type, ...fields}, id optional) as a full one of the domain: layer.create and layer.patch take these. */
export function toEffect(domain: EffectDomain, raw: Record<string, unknown>, ids: MintId): Effect {
  const { type, id, enabled, ...values } = raw
  if (typeof type !== 'string') throw new CommandError(`A ${domain} effect needs a type.`, `${domain} effects: ${effectDefs(domain).map((d) => d.type).join(', ')}.`)
  const def = defOf(domain, type)
  const card = newEffect(def, typeof id === 'string' && id.length > 0 ? id : ids('fx'), checkValues(def, values))
  if (typeof enabled === 'boolean') card.enabled = enabled
  return card
}

/** Mints the ids of a layer's effect cards (and sound voices) that lack one, in place, before the layer is validated. */
export function mintEffectIds(layer: Record<string, unknown>, ids: MintId): void {
  const mint = (list: unknown) => {
    if (!Array.isArray(list)) return
    for (const card of list) if (typeof card === 'object' && card !== null && (card as Record<string, unknown>).id === undefined) (card as Record<string, unknown>).id = ids('fx')
  }
  mint(layer.effects)
  const mintWith = (list: unknown, prefix: string) => {
    if (!Array.isArray(list)) return
    for (const card of list) if (typeof card === 'object' && card !== null && (card as Record<string, unknown>).id === undefined) (card as Record<string, unknown>).id = ids(prefix)
  }
  mintWith(layer.forces, 'force')
  mintWith(layer.joints, 'joint')
  if (Array.isArray(layer.sounds)) for (const voice of layer.sounds) if (typeof voice === 'object' && voice !== null && (voice as Record<string, unknown>).id === undefined) (voice as Record<string, unknown>).id = ids('sound')
  const style = layer.style
  if (typeof style === 'object' && style !== null) mint((style as Record<string, unknown>).textEffects)
}

/** The keyable paths of one card. */
function keyablePaths(domain: EffectDomain, def: EffectDef, effectId: string): string[] {
  return Object.entries(def.fields)
    .filter(([, f]) => f.kind === 'number' || f.kind === 'color')
    .map(([key]) => `${EFFECT_PREFIX[domain]}.${effectId}.${key}`)
}

function draftStack(draft: unknown, layerId: string, domain: EffectDomain): Effect[] {
  const layer = locateLayer(draft as Parameters<typeof locateLayer>[0], layerId).layer
  return effectStack(layer, domain) as Effect[]
}

export const effectsAdd = defineCommand({
  name: 'effects.add',
  summary: "Add an effect card to a layer's stack: drop shadow, glow, outline, blur, long shadow, shine, colour adjust… or a per-glyph text effect.",
  details:
    "domain layer (default) works on the layer's drawn pixels, the same on text, shapes, images, video, groups and nested comps; text draws under each glyph of a text layer and moves with its animation. Stack order is render order: the first card applies first. values sets fields now (catalog.get layer-effects <type> lists them with ranges). Returns the effect id: its number and colour fields animate at lfx.<effectId>.<field> (tfx. for text effects) through keyframes.set or layer.set. Offsets and sizes are in layer px and turn and scale with the layer.",
  effect: 'write',
  input: z.strictObject({
    id: IdSchema.describe('The layer'),
    domain: z.string().default('layer').describe('layer or text'),
    type: z.string().min(1).describe('The effect type (catalog.list layer-effects / text-effects)'),
    index: z.number().int().min(0).optional().describe('Position in the stack; omitted adds it at the end'),
    values: z.record(z.string(), z.unknown()).default({}).describe('Fields to set now'),
  }),
  run: (input, ctx) => {
    const domain = domainOf(input.domain)
    const { layer } = locateLayer(ctx.project, input.id)
    const stack = stackOrThrow(layer, domain)
    const def = defOf(domain, input.type)
    const values = checkValues(def, input.values)
    const index = Math.min(input.index ?? stack.length, stack.length)
    const effect = newEffect(def, ctx.ids('fx'), values)
    ctx.write(`Add ${def.label}`, (draft) => {
      draftStack(draft, layer.id, domain).splice(index, 0, effect)
    })
    return { id: layer.id, effectId: effect.id, domain, type: def.type, index, effect, keyable: keyablePaths(domain, def, effect.id) }
  },
})

/** A card on a layer, in either stack. */
function findCard(layer: Layer, effectId: string): { domain: EffectDomain; stack: Effect[]; index: number } {
  for (const domain of EFFECT_DOMAINS) {
    const stack = effectStack(layer, domain)
    const index = stack?.findIndex((e) => e.id === effectId) ?? -1
    if (stack && index >= 0) return { domain, stack, index }
  }
  const all = [...EFFECT_DOMAINS.flatMap((d) => (effectStack(layer, d) ?? []).map((e) => `${e.id} (${e.type})`)), ...(layer.forces ?? []).map((f) => `${f.id} (${f.type} force)`)]
  throw new CommandError(`"${layer.name}" has no effect "${effectId}".`, all.length > 0 ? `Its effects: ${all.join(', ')}.` : 'It has no effects yet: effects.add makes one.')
}

export const effectsUpdate = defineCommand({
  name: 'effects.update',
  summary: "Change an effect card's fields, switch it on or off, move it in the stack, or remove it.",
  details:
    'values merge into the card (unknown fields are refused by name). A field that has keys is set with layer.set {values: {"lfx.<effectId>.<field>": v}, atMs} instead. remove deletes the card and its keys. index moves it (0 is applied first). effectId may also be a physics force card (the forceId physics.force returned): values then are its fields (type, name, strength, radius, falloff, scale, seed), keyed at force.<forceId>.<field>.',
  effect: 'write',
  input: z.strictObject({
    id: IdSchema.describe('The layer'),
    effectId: IdSchema,
    values: z.record(z.string(), z.unknown()).optional(),
    enabled: z.boolean().optional(),
    index: z.number().int().min(0).optional(),
    remove: z.boolean().optional(),
  }),
  run: (input, ctx) => {
    const { layer } = locateLayer(ctx.project, input.id)
    // A physics force card (physics.force) is edited the same way.
    if (layer.forces?.some((f) => f.id === input.effectId)) return updateForce(layer, input.effectId, input, ctx)
    const { domain, stack, index } = findCard(layer, input.effectId)
    const card = stack[index] as Effect
    const def = defOf(domain, card.type)
    const prefix = `${EFFECT_PREFIX[domain]}.${card.id}.`

    if (input.remove) {
      if (input.values !== undefined || input.enabled !== undefined || input.index !== undefined) {
        throw new CommandError('remove deletes the card; it cannot be combined with values, enabled or index.')
      }
      const droppedKeys = Object.keys(layer.animations).filter((path) => path.startsWith(prefix))
      ctx.write(`Remove ${def.label}`, (draft) => {
        const target = locateLayer(draft, layer.id).layer
        draftStack(draft, layer.id, domain).splice(index, 1)
        for (const path of droppedKeys) delete target.animations[path]
      })
      return { id: layer.id, effectId: card.id, removed: true, ...(droppedKeys.length > 0 ? { droppedKeys } : {}) }
    }

    const values = checkValues(def, input.values ?? {})
    const keyed = Object.keys(values).filter((key) => (layer.animations[prefix + key]?.length ?? 0) > 0)
    if (keyed.length > 0) {
      throw new CommandError(
        `${keyed.map((k) => prefix + k).join(', ')} ${keyed.length > 1 ? 'are' : 'is'} animated, so a plain value would be hidden by the keys.`,
        `Key it at a time with layer.set {values: {"${prefix}${keyed[0]}": …}, atMs}, or keyframes.clear it first.`,
      )
    }
    if (Object.keys(values).length === 0 && input.enabled === undefined && input.index === undefined) {
      throw new CommandError('Nothing to change.', 'Pass values, enabled, index or remove.')
    }
    const to = input.index === undefined ? index : Math.min(input.index, stack.length - 1)
    const next = { ...card, ...values, ...(input.enabled !== undefined ? { enabled: input.enabled } : {}) } as Effect
    ctx.write(`Edit ${def.label}`, (draft) => {
      const target = draftStack(draft, layer.id, domain)
      target.splice(index, 1)
      target.splice(to, 0, next)
    })
    return { id: layer.id, effectId: card.id, domain, index: to, effect: next }
  },
})
