import { z } from 'zod'
import { CommandError } from '../errors'
import type { IdGenerator } from '../ids'
import { defineCommand } from '../registry'
import type { Layer, Project } from '../schema'
import {
  CATEGORY_PALETTE,
  categoryTarget,
  DuckRuleSchema,
  DuckSourceInputSchema,
  SOUND_CHARACTERS,
  type DuckRule,
  type SoundCategory,
  SoundCategorySchema,
} from '../soundMix'

// Sound categories (buses): list, create, update, delete. AtomCut's tool
// shape (sound_category with an action); the mix itself is mixPlan.ts.

/** Every layer of the project, in every comp. */
function* allLayers(project: Project): Generator<Layer> {
  for (const comp of project.comps) for (const track of comp.tracks) yield* track.layers
}

/** Finds a category by id or by name (any case). */
export function findCategory(project: Project, ref: string): SoundCategory {
  const wanted = ref.trim().toLowerCase()
  const found = project.soundCategories.find((c) => c.id === ref) ?? project.soundCategories.find((c) => c.name.toLowerCase() === wanted)
  if (!found) {
    throw new CommandError(`No sound category "${ref}".`, 'Categories: ' + project.soundCategories.map((c) => `${c.id} (${c.name})`).join(', ') + '. sound.category create makes another.')
  }
  return found
}

/** Throws when a duck rule listens to something that does not exist, or a bus to itself. */
function checkRule(project: Project, rule: DuckRule, ownBus: string | null): void {
  if (rule.under.kind === 'bus') {
    if (!project.soundCategories.some((c) => c.id === rule.under.id)) {
      throw new CommandError(`A duck rule listens to the category "${rule.under.id}", which does not exist.`, 'Categories: ' + project.soundCategories.map((c) => c.id).join(', ') + '.')
    }
    if (rule.under.id === ownBus) throw new CommandError(`A category cannot duck under itself ("${ownBus}").`, 'Pick another category to listen to.')
    return
  }
  for (const layer of allLayers(project)) if (layer.id === rule.under.id) return
  throw new CommandError(`A duck rule listens to the layer "${rule.under.id}", which does not exist.`, 'Give a layer id from layers.list, or {kind: "bus", id} for a category.')
}

/** Throws when a layer names a category or duck source that does not exist. */
export function checkSoundRefs(project: Project, layer: Layer): void {
  if (layer.soundBus !== undefined && !project.soundCategories.some((c) => c.id === layer.soundBus)) {
    throw new CommandError(`No sound category "${layer.soundBus}".`, 'Categories: ' + project.soundCategories.map((c) => c.id).join(', ') + '. Remove soundBus to send it straight to master.')
  }
  for (const rule of layer.ducking ?? []) checkRule(project, rule, null)
}

const RuleInputSchema = z.strictObject({
  id: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  under: DuckSourceInputSchema.describe('A category id ("voice"), or {kind: "bus" | "clip", id}'),
  depthDb: z.number().min(0).max(60).optional(),
  attackMs: z.number().min(0).max(5000).optional(),
  releaseMs: z.number().min(0).max(10000).optional(),
})

/** Duck rules from input, with ids and defaults filled in. */
export function duckRules(input: readonly z.output<typeof RuleInputSchema>[], ids: IdGenerator): DuckRule[] {
  return input.map((rule) => DuckRuleSchema.parse({ ...Object.fromEntries(Object.entries(rule).filter(([, v]) => v !== undefined)), id: rule.id ?? ids('duck') }))
}

/** A category as reported: its fields, its effective target and how many layers it holds. */
function report(project: Project, category: SoundCategory) {
  let layers = 0
  for (const layer of allLayers(project)) if (layer.soundBus === category.id) layers++
  return { ...category, target: categoryTarget(category), layers }
}

export const soundCategory = defineCommand({
  name: 'sound.category',
  summary: 'Create, update or delete a sound category (bus): name, kind, fader, mute/solo, loudness target, ducking. Lists them when called with no action.',
  details:
    'Layers join a category with layer.patch {op: "set", path: "soundBus", value: "<id>"}; untagged media goes straight to master, untagged fired sounds (packs, text sounds) to sfx. Built-ins: voice (Dialogue, −16 LUFS), music (−20), sfx (Effects, −19), ambience (−28); they cannot be deleted. ducking replaces the rules: [{under: "voice", depthDb: 10, attackMs: 150, releaseMs: 500}] ducks this category while voice sounds. Deleting a category untags its layers and drops the rules that listen to it. The frame\'s leveler, master and limiter: frame.update soundMix.',
  effect: 'write',
  input: z.strictObject({
    action: z.enum(['list', 'create', 'update', 'delete']).default('list'),
    id: z.string().min(1).optional().describe('The category (update/delete), by id or name. Built-ins: voice, music, sfx, ambience'),
    name: z.string().min(1).optional(),
    character: z.enum(SOUND_CHARACTERS).optional().describe('How the leveler hears it: voice, music, sfx, ambience'),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    volume: z.number().min(0).max(4).optional().describe('Linear fader, 1 = 0 dB'),
    muted: z.boolean().optional(),
    solo: z.boolean().optional(),
    targetLufs: z.number().min(-40).max(-6).nullable().optional(),
    ducking: z.array(RuleInputSchema).optional().describe('Replaces its ducking rules'),
  }),
  run: (input, ctx) => {
    const { action, id, ducking, ...fields } = input
    const given = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Partial<SoundCategory>
    const project = ctx.project

    if (action === 'list') return { categories: project.soundCategories.map((c) => report(project, c)) }

    if (action === 'create') {
      const newId = ctx.ids('cat')
      const custom = project.soundCategories.filter((c) => !c.builtIn).length
      const category = SoundCategorySchema.parse({
        name: `Category ${custom + 1}`,
        color: CATEGORY_PALETTE[custom % CATEGORY_PALETTE.length],
        ...given,
        id: newId,
        ducking: [],
        builtIn: false,
      })
      const rules = duckRules(ducking ?? [], ctx.ids)
      const next = { ...project, soundCategories: [...project.soundCategories, category] }
      for (const rule of rules) checkRule(next, rule, newId)
      category.ducking = rules
      ctx.write('New sound category', (draft) => {
        draft.soundCategories.push(category)
      })
      return { created: report({ ...project, soundCategories: [...project.soundCategories, category] }, category) }
    }

    if (id === undefined) throw new CommandError(`${action} needs the category's id.`, 'sound.category {} lists them.')
    const category = findCategory(project, id)

    if (action === 'delete') {
      if (category.builtIn) throw new CommandError(`"${category.name}" is built in and cannot be deleted.`, 'Mute it, or turn its fader down, instead.')
      let untagged = 0
      for (const layer of allLayers(project)) if (layer.soundBus === category.id) untagged++
      ctx.write('Delete sound category', (draft) => {
        draft.soundCategories = draft.soundCategories.filter((c) => c.id !== category.id)
        const keep = (rule: DuckRule) => !(rule.under.kind === 'bus' && rule.under.id === category.id)
        for (const c of draft.soundCategories) c.ducking = c.ducking.filter(keep)
        for (const comp of draft.comps) {
          for (const track of comp.tracks) {
            for (const layer of track.layers) {
              if (layer.soundBus === category.id) delete layer.soundBus
              if (layer.ducking) layer.ducking = layer.ducking.filter(keep)
            }
          }
        }
      })
      return { deleted: category.id, untagged }
    }

    const rules = ducking === undefined ? category.ducking : duckRules(ducking, ctx.ids)
    for (const rule of rules) checkRule(project, rule, category.id)
    const updated = SoundCategorySchema.parse({ ...category, ...given, ducking: rules })
    ctx.write('Edit sound category', (draft) => {
      const index = draft.soundCategories.findIndex((c) => c.id === category.id)
      draft.soundCategories[index] = updated
    })
    return { updated: report(project, updated) }
  },
})
