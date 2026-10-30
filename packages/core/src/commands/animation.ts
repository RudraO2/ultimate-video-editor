import { z } from 'zod'
import { type AnimationSlot, type AnimationTarget, animationSpanMs, animationWindow, slotAnimation, slotField, textUnits, unitCount } from '../animation'
import { ANIMATION_PRESETS, type AnimationPreset, defaultParams, findAnimationPreset } from '../animationPresets'
import { EasingInputSchema, toEasing } from '../compat'
import { locateLayer } from '../doc'
import { CommandError } from '../errors'
import { defineCommand } from '../registry'
import { ANIMATION_UNITS, IdSchema, type Layer, type LayerAnimation, type Project } from '../schema'

/** Preset ids that look like `wanted`, for an error's hint. */
function similarPresets(wanted: string): string[] {
  const w = wanted.toLowerCase().replace(/[\s_]+/g, '-')
  const distance = (a: string, b: string) => {
    let row = Array.from({ length: b.length + 1 }, (_, j) => j)
    for (let i = 1; i <= a.length; i++) {
      const next = [i]
      for (let j = 1; j <= b.length; j++) next[j] = Math.min((row[j] as number) + 1, (next[j - 1] as number) + 1, (row[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1))
      row = next
    }
    return row[b.length] as number
  }
  const scored = ANIMATION_PRESETS.map((p) => ({ id: p.id, d: p.id.includes(w) || w.includes(p.id) ? 0 : Math.min(distance(w, p.id), distance(w, p.label.toLowerCase())) }))
  const close = scored.filter((s) => s.d <= Math.max(2, Math.floor(w.length / 3))).sort((a, b) => a.d - b.d)
  return (close.length > 0 ? close.map((s) => s.id) : ['fade-up', 'pop-in', 'typewriter', 'unblur-up', 'slide-up']).slice(0, 6)
}

function checkParams(preset: AnimationPreset, params: Record<string, number>): void {
  for (const [key, value] of Object.entries(params)) {
    const spec = preset.params.find((p) => p.key === key)
    if (!spec) {
      const known = preset.params.map((p) => p.key)
      throw new CommandError(
        `"${preset.id}" has no knob "${key}".`,
        known.length > 0 ? `Its knobs: ${known.join(', ')}.` : `"${preset.id}" has no knobs; leave params out.`,
      )
    }
    if (!Number.isFinite(value) || value < spec.min || value > spec.max) {
      throw new CommandError(`${preset.id} ${key} ${value} is out of range.`, `${spec.label} runs from ${spec.min} to ${spec.max}.`)
    }
    if (spec.options && !spec.options.some((o) => o.value === value)) {
      throw new CommandError(`${preset.id} ${key} must be one of its options.`, spec.options.map((o) => `${o.value} ${o.label}`).join(', '))
    }
  }
}

/** Fields that only mean something for text units. */
const TEXT_ONLY = ['unit', 'staggerMs', 'delayMs', 'jitterMs', 'scatterPx', 'scatterDeg'] as const

export const animationSet = defineCommand({
  name: 'animation.set',
  summary: "Give a layer an entrance or exit from the animation presets (fade, slide, pop, typewriter, draw-on…), per letter, word or line on text, or remove one.",
  details:
    'slot "in" plays from the layer\'s start, "out" ends at the layer\'s end. target "text" animates a text layer per unit (unit, staggerMs, delayMs, jitterMs, scatterPx, scatterDeg apply); "layer" animates the whole layer as one piece (any visual layer; it has no delay: start the layer where its entrance should begin). A text layer has both kinds of slot, so a title can pop in as a whole and have its words rise. "auto" (default) is text for text layers when the preset can, layer otherwise. preset null removes the slot (auto: the text one when set, else the layer one). When swapping presets, fields left out keep their current values and knobs keep the values the new preset shares; a new slot starts from the preset\'s defaults. An exit without a pose of its own plays the entrance backwards. "draw" draws strokes on (shape and path layers). catalog.list animations lists the presets, catalog.get animations <id> their knobs.',
  effect: 'write',
  input: z.strictObject({
    id: IdSchema,
    slot: z.enum(['in', 'out']),
    preset: z.string().min(1).nullable().describe('A preset id, or null to remove the slot'),
    target: z.enum(['auto', 'text', 'layer']).default('auto'),
    unit: z.enum(ANIMATION_UNITS).optional().describe('Text only'),
    durationMs: z.number().min(0).max(60000).optional().describe("Each unit's own animation (the whole layer's, for target layer)"),
    staggerMs: z.number().min(0).max(10000).optional().describe('Text only: the gap between units starting'),
    delayMs: z.number().min(0).max(60000).optional().describe('Text only: wait before the first unit (in), or end this long before the layer (out)'),
    easing: EasingInputSchema.optional(),
    jitterMs: z.number().min(0).max(5000).optional().describe('Text only: humanised timing'),
    scatterPx: z.number().min(0).max(2000).optional().describe('Text only: random offset per unit'),
    scatterDeg: z.number().min(0).max(720).optional().describe('Text only: random turn per unit'),
    params: z.record(z.string(), z.number()).optional().describe('Preset knobs (catalog.get animations <id>)'),
  }),
  run: (input, ctx) => {
    const { layer } = locateLayer(ctx.project, input.id)
    const slot: AnimationSlot = input.slot
    if (layer.kind === 'audio') throw new CommandError(`"${layer.name}" is an audio layer: it has nothing to animate.`)
    const write = (field: string, value: LayerAnimation | null) => (draft: Project) => {
      ;(locateLayer(draft, layer.id).layer as Record<string, unknown>)[field] = value
    }

    if (input.preset === null) {
      // auto removes a text layer's per-unit slot when it has one, else the whole-layer one.
      const target: AnimationTarget = input.target === 'auto' ? (slotAnimation(layer, 'text', slot) ? 'text' : 'layer') : input.target
      if (target === 'text' && layer.kind !== 'text') throw new CommandError(`"${layer.name}" is a ${layer.kind} layer: it has no text animation.`)
      const current = slotAnimation(layer, target, slot)
      if (current) ctx.write(`Remove ${slot === 'in' ? 'entrance' : 'exit'}`, write(slotField(target, slot), null))
      return { id: layer.id, slot, target, removed: current?.preset ?? null }
    }

    const preset = findAnimationPreset(input.preset)
    if (!preset) throw new CommandError(`No animation preset "${input.preset}".`, `Close ones: ${similarPresets(input.preset).join(', ')}. catalog.list animations lists all ${ANIMATION_PRESETS.length}.`)
    const target = resolveTarget(layer, preset, input.target)
    if (target === 'layer') {
      const given = TEXT_ONLY.filter((k) => input[k] !== undefined)
      if (given.length > 0) {
        throw new CommandError(
          `${given.join(', ')} ${given.length > 1 ? 'are' : 'is'} for text units; a whole-layer animation plays from the layer's start${slot === 'out' ? ' and ends at its end' : ''}.`,
          slot === 'in' ? 'To enter later, move the layer (timeline.move) or trim its start.' : 'Leave them out, or use target "text" on a text layer.',
        )
      }
    }
    if (preset.drawOn && layer.kind !== 'shape' && layer.kind !== 'path') {
      throw new CommandError(
        `"draw" draws outlines on; "${layer.name}" is a ${layer.kind} layer.`,
        layer.kind === 'group' ? 'Put it on the shape and path layers inside the group.' : layer.kind === 'text' ? 'Text cannot draw on yet: use typewriter, trace or a fade on text.' : 'Use it on shape and path layers.',
      )
    }

    // Swapping presets keeps the slot's timing and the knobs the presets share; a new slot starts from the defaults.
    const field = slotField(target, slot)
    const keep = slotAnimation(layer, target, slot)
    const params = { ...defaultParams(preset), ...(keep ? Object.fromEntries(Object.entries(keep.params).filter(([k]) => preset.params.some((p) => p.key === k))) : {}) }
    if (input.params) {
      checkParams(preset, input.params)
      Object.assign(params, input.params)
    }
    const spec: LayerAnimation = {
      preset: preset.id,
      unit: input.unit ?? keep?.unit ?? preset.defaultUnit,
      durationMs: input.durationMs ?? keep?.durationMs ?? preset.defaultDurationMs,
      staggerMs: input.staggerMs ?? keep?.staggerMs ?? preset.defaultStaggerMs,
      delayMs: input.delayMs ?? keep?.delayMs ?? 0,
      easing: input.easing !== undefined ? toEasing(input.easing) : (keep?.easing ?? preset.defaultEasing),
      jitterMs: input.jitterMs ?? keep?.jitterMs ?? preset.defaultJitterMs ?? 0,
      scatterPx: input.scatterPx ?? keep?.scatterPx ?? 0,
      scatterDeg: input.scatterDeg ?? keep?.scatterDeg ?? 0,
      params,
    }
    if (target === 'layer') Object.assign(spec, { unit: preset.defaultUnit, staggerMs: 0, delayMs: 0, jitterMs: 0, scatterPx: 0, scatterDeg: 0 })

    ctx.write(`${preset.label} ${slot === 'in' ? 'entrance' : 'exit'}`, write(field, spec))

    const after = { ...layer, [field]: spec } as Layer
    const window = animationWindow(after, target, slot)
    const units = target === 'text' && layer.kind === 'text' ? unitCount(textUnits(layer.text), spec.unit) : undefined
    const warnings: string[] = []
    const runs = units !== undefined ? spec.delayMs + animationSpanMs(spec, units) + spec.jitterMs : spec.durationMs
    if (runs > layer.durationMs) {
      warnings.push(
        `It runs ${Math.round(runs)} ms but the layer lasts ${layer.durationMs} ms, so it is cut short.`,
        units !== undefined ? 'Shorten staggerMs or durationMs, or lengthen the layer.' : 'Shorten durationMs or lengthen the layer.',
      )
    }
    const otherWindow = animationWindow(after, target, slot === 'in' ? 'out' : 'in')
    if (window && otherWindow && (slot === 'in' ? window.endMs > otherWindow.startMs : otherWindow.endMs > window.startMs)) {
      warnings.push('The entrance and exit overlap in time; they play together where they do.')
    }
    return {
      id: layer.id,
      slot,
      target,
      animation: spec,
      ...(units !== undefined ? { units } : {}),
      ...(window ? { compMs: { startMs: layer.startMs + window.startMs, endMs: layer.startMs + window.endMs } } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    }
  },
})

function resolveTarget(layer: Layer, preset: AnimationPreset, wanted: 'auto' | 'text' | 'layer'): 'text' | 'layer' {
  if (wanted === 'text' || (wanted === 'auto' && layer.kind === 'text' && preset.scope !== 'layer')) {
    if (layer.kind !== 'text') throw new CommandError(`target "text" animates text per unit; "${layer.name}" is a ${layer.kind} layer.`, 'Use target "layer" (or "auto").')
    if (preset.scope === 'layer') throw new CommandError(`"${preset.id}" animates whole layers only.`, 'Use target "layer", or a text preset such as fade-up, typewriter or unblur-up.')
    return 'text'
  }
  if (preset.scope === 'text') {
    throw new CommandError(
      `"${preset.id}" animates text per unit; it cannot move a whole layer.`,
      layer.kind === 'text' ? 'Use target "text" (or "auto").' : 'On this layer use a whole-layer preset such as fade-up, pop-in or slide-up.',
    )
  }
  return 'layer'
}
