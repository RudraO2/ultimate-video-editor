import { z } from 'zod'
import { EasingInputSchema, toEasing } from '../compat'
import { locateLayer } from '../doc'
import { CommandError } from '../errors'
import { defineCommand } from '../registry'
import { ColorSchema, IdSchema, type Layer, type Project, type Track, type Transition } from '../schema'
import { CUT_TOLERANCE_MS, defaultTransitionParams, findTransitionPreset, TRANSITION_PRESETS, type TransitionPreset } from '../transitions'

const end = (layer: Layer) => layer.startMs + layer.durationMs

/** The cuts a layer has on its lane: its head (from the layer before, if it abuts) and its tail (into the next). */
function slotsOf(track: Track, layer: Layer, edge: 'in' | 'out' | 'any'): { a: Layer | null; b: Layer | null }[] {
  const slots: { a: Layer | null; b: Layer | null }[] = []
  if (edge !== 'out') {
    const before = track.layers.find((l) => l.id !== layer.id && Math.abs(end(l) - layer.startMs) <= CUT_TOLERANCE_MS) ?? null
    slots.push({ a: before, b: layer })
  }
  if (edge !== 'in') {
    const after = track.layers.find((l) => l.id !== layer.id && Math.abs(l.startMs - end(layer)) <= CUT_TOLERANCE_MS) ?? null
    slots.push({ a: layer, b: after })
  }
  return slots
}

function checkParams(preset: TransitionPreset, params: Record<string, number>): void {
  for (const [key, value] of Object.entries(params)) {
    const spec = preset.params.find((p) => p.key === key)
    if (!spec) {
      throw new CommandError(
        `"${preset.id}" has no knob "${key}".`,
        preset.params.length > 0 ? `Its knobs: ${preset.params.map((p) => p.key).join(', ')}.` : `"${preset.id}" has no knobs; leave params out.`,
      )
    }
    if (!Number.isFinite(value) || value < spec.min || value > spec.max) throw new CommandError(`${preset.id} ${key} ${value} is out of range.`, `${spec.label} runs from ${spec.min} to ${spec.max}.`)
  }
}

/**
 * Fits a transition to its layers: before the cut A plays (so that part is at
 * most A's length), after it B plays (at most B's length); a lone head or
 * tail is at most its layer's length. Returns the duration and split.
 */
function fit(a: Layer | null, b: Layer | null, durationMs: number): { durationMs: number; splitMs: number } {
  if (a && b) {
    const half = durationMs / 2
    const scale = Math.min(1, a.durationMs / half, b.durationMs / half)
    return { durationMs: durationMs * scale, splitMs: half * scale }
  }
  if (b) {
    const d = Math.min(durationMs, b.durationMs)
    return { durationMs: d, splitMs: 0 }
  }
  const d = Math.min(durationMs, (a as Layer).durationMs)
  return { durationMs: d, splitMs: d }
}

export const transitionAdd = defineCommand({
  name: 'transition.add',
  summary: 'Put a transition on the cuts of layers: between two abutting layers on a lane, or on a lone layer\'s head or tail.',
  details:
    'edge "in" is a layer\'s start, "out" its end, "any" both. Two layers that touch on one lane share one cut, and get one transition. Between layers it is centred on the cut (half before, half after; the outgoing layer holds its last frame past its end and the incoming one its first before its start); on a lone head it plays from the start (the layer arrives), on a tail up to the end (it leaves). Adding on a cut that has one replaces it. durationMs is shortened to fit the layers, with a warning. catalog.list transitions lists the presets; catalog.get gives their knobs (params). color is for dip-to-color and dip-to-white.',
  effect: 'write',
  input: z.strictObject({
    ids: z.array(IdSchema).min(1).describe('Layers whose cuts get the transition'),
    preset: z.string().min(1),
    edge: z.enum(['in', 'out', 'any']).default('any'),
    durationMs: z.number().positive().max(60000).optional(),
    easing: EasingInputSchema.optional(),
    params: z.record(z.string(), z.number()).optional(),
    color: ColorSchema.optional(),
  }),
  run: (input, ctx) => {
    const preset = findTransitionPreset(input.preset)
    if (!preset) throw new CommandError(`No transition preset "${input.preset}".`, `Presets: ${TRANSITION_PRESETS.map((p) => p.id).join(', ')}.`)
    if (input.color !== undefined && !preset.usesColor) {
      throw new CommandError(`"${preset.id}" does not use a colour.`, 'color is for dip-to-color and dip-to-white.')
    }
    const params = { ...defaultTransitionParams(preset), ...(input.params ?? {}) }
    if (input.params) checkParams(preset, input.params)
    const easing = input.easing !== undefined ? toEasing(input.easing) : preset.defaultEasing
    const wanted = input.durationMs ?? preset.defaultDurationMs
    // Every slot, checked before anything is written; a shared cut once.
    const plans = new Map<string, { trackId: string; compId: string; a: Layer | null; b: Layer | null }>()
    for (const ref of input.ids) {
      const { comp, track, layer } = locateLayer(ctx.project, ref)
      for (const slot of slotsOf(track, layer, input.edge)) {
        plans.set(`${track.id}|${slot.a?.id ?? ''}|${slot.b?.id ?? ''}`, { trackId: track.id, compId: comp.id, ...slot })
      }
    }
    const warnings: string[] = []
    const made: (Transition & { trackId: string; kind: 'seam' | 'head' | 'tail'; startMs: number; endMs: number })[] = []
    const writes: { compId: string; trackId: string; transition: Transition }[] = []
    for (const { trackId, compId, a, b } of plans.values()) {
      const comp = ctx.project.comps.find((c) => c.id === compId)
      const track = comp?.tracks.find((t) => t.id === trackId)
      if (!track) continue
      const { durationMs, splitMs } = fit(a, b, wanted)
      if (durationMs < wanted - 0.5) warnings.push(`Shortened to ${Math.round(durationMs)} ms to fit ${a && b ? `"${a.name}" and "${b.name}"` : `"${(a ?? b)?.name}"`}.`)
      const existing = track.transitions.find((t) => t.aLayerId === (a?.id ?? null) && t.bLayerId === (b?.id ?? null))
      const transition: Transition = {
        id: existing?.id ?? ctx.ids('tr'),
        preset: preset.id,
        aLayerId: a?.id ?? null,
        bLayerId: b?.id ?? null,
        durationMs,
        splitMs,
        easing,
        params,
        color: input.color ?? null,
      }
      const cut = a ? end(a) : (b as Layer).startMs
      writes.push({ compId, trackId, transition })
      made.push({ ...transition, trackId, kind: a && b ? 'seam' : a ? 'tail' : 'head', startMs: cut - splitMs, endMs: cut + durationMs - splitMs })
    }
    ctx.write(`${preset.label} transition`, (draft: Project) => {
      for (const { compId, trackId, transition } of writes) {
        const track = draft.comps.find((c) => c.id === compId)?.tracks.find((t) => t.id === trackId)
        if (!track) continue
        const at = track.transitions.findIndex((t) => t.id === transition.id)
        if (at >= 0) track.transitions[at] = transition
        else track.transitions.push(transition)
      }
    })
    return { transitions: made, ...(warnings.length > 0 ? { warnings } : {}) }
  },
})

export const transitionRemove = defineCommand({
  name: 'transition.remove',
  summary: 'Remove a transition by id (layers.list lists each lane\'s transitions).',
  effect: 'write',
  input: z.strictObject({ transitionId: IdSchema }),
  run: ({ transitionId }, ctx) => {
    for (const comp of ctx.project.comps) {
      for (const track of comp.tracks) {
        if (!track.transitions.some((t) => t.id === transitionId)) continue
        ctx.write('Remove transition', (draft) => {
          const target = draft.comps.find((c) => c.id === comp.id)?.tracks.find((t) => t.id === track.id)
          if (target) target.transitions = target.transitions.filter((t) => t.id !== transitionId)
        })
        return { removed: transitionId }
      }
    }
    throw new CommandError(`No transition "${transitionId}".`, 'layers.list lists each lane\'s transitions.')
  },
})

/** Drops transitions whose layers are gone from their lane (after a delete or a move to another lane). */
export function pruneTransitions(project: Project): void {
  for (const comp of project.comps) {
    for (const track of comp.tracks) {
      if (track.transitions.length === 0) continue
      const here = new Set(track.layers.map((l) => l.id))
      track.transitions = track.transitions.filter((t) => (t.aLayerId === null || here.has(t.aLayerId)) && (t.bLayerId === null || here.has(t.bLayerId)))
    }
  }
}
