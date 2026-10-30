import { z } from 'zod'
import { idList } from '../compat'
import { locateLayer } from '../doc'
import { CommandError } from '../errors'
import { findLook, lookAnimationInput, lookCaptionFocus, lookLayerInput, lookSound, lookStyle, type TextLook } from '../looks'
import { defineCommand } from '../registry'
import type { Layer } from '../schema'
import { toEffect } from './effects'

type TextLayer = Extract<Layer, { kind: 'text' }>

/** The text layers `ids` name; a layer of another kind is an error that says which. */
function textLayers(project: Parameters<typeof locateLayer>[0], ids: string[]): TextLayer[] {
  return ids.map((ref) => {
    const { layer } = locateLayer(project, ref)
    if (layer.kind !== 'text') throw new CommandError(`"${layer.name}" is a ${layer.kind} layer: a text template gives type, so it needs a text layer.`)
    return layer
  })
}

export const templateApply = defineCommand({
  name: 'template.apply',
  summary: 'Give text layers a finished look from catalog text-templates: type, effects, entrance and typing sound.',
  details:
    "Replaces the layers' type style, text effects and layer effects with the look's, and gives them its entrance. Kept: the words and their styled ranges, position, the box, timing, an exit, alignment and line height (unless the look sets them) and keys on properties the look does not replace. A look with a typing sound replaces the layer's text-triggered sound. On a caption layer, a caption look also sets how the spoken word looks. keepSize keeps the layer's font size. Find ids with catalog.list text-templates; catalog.get shows one in full.",
  effect: 'write',
  input: z.strictObject({
    ids: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).describe('A text layer id, or several'),
    templateId: z.string().min(1).describe('A text template id or name (catalog.list text-templates)'),
    keepSize: z.boolean().default(false).describe("Keep each layer's font size instead of the look's"),
  }),
  run: async ({ ids, templateId, keepSize }, ctx) => {
    const look = findLook(templateId)
    if (!look) throw new CommandError(`No text template "${templateId}".`, 'catalog.list {"catalog": "text-templates"} lists them.')
    const layers = textLayers(ctx.project, idList(undefined, ids))
    const applied: { id: string; name: string; captionFocus?: boolean }[] = []
    const dropped: string[] = []
    for (const layer of layers) {
      const ops = opsFor(look, layer, keepSize, ctx.ids)
      const patched = await ctx.call('layer.patch', { id: layer.id, ops })
      if (!patched.ok) throw new CommandError(`${layer.name}: ${patched.error}`, patched.hint)
      const value = patched.value as { droppedKeys?: string[] }
      dropped.push(...(value.droppedKeys ?? []))
      const entrance = lookAnimationInput(look, layer.id)
      if (entrance) {
        const animated = await ctx.call('animation.set', entrance)
        if (!animated.ok) throw new CommandError(`${layer.name}: ${animated.error}`, animated.hint)
      }
      applied.push({ id: layer.id, name: layer.name, ...(layer.caption && lookCaptionFocus(look) ? { captionFocus: true } : {}) })
    }
    return { template: look.id, applied, ...(dropped.length > 0 ? { droppedKeys: [...new Set(dropped)] } : {}) }
  },
})

/** The layer.patch operations that make `layer` wear `look`. */
function opsFor(look: TextLook, layer: TextLayer, keepSize: boolean, ids: Parameters<typeof toEffect>[2]) {
  const fromLook = lookLayerInput(look)
  const loose = (lookStyle(look).textEffects ?? []) as Record<string, unknown>[]
  // Alignment and line height are layout choices: they stay unless the look sets them.
  const style: Record<string, unknown> = {
    align: layer.style.align,
    lineHeight: layer.style.lineHeight,
    ...lookStyle(look),
    ...(keepSize ? { fontSize: layer.style.fontSize } : {}),
    textEffects: loose.map((card) => toEffect('text', card, ids)),
  }
  const ops: Record<string, unknown>[] = [
    { op: 'set', path: 'style', value: style },
    { op: 'set', path: 'effects', value: (fromLook.effects ?? []).map((card) => toEffect('layer', card, ids)) },
  ]
  if (fromLook.transform) ops.push({ op: 'set', path: 'transform.opacity', value: fromLook.transform.opacity })
  const sound = lookSound(look)
  if (sound) {
    const kept = layer.sounds.filter((voice) => voice.trigger.kind !== 'text')
    ops.push({ op: 'set', path: 'sounds', value: [...kept, { ...sound, id: ids('sound') }] })
  }
  const focus = layer.caption ? lookCaptionFocus(look) : null
  if (focus) ops.push({ op: 'set', path: 'caption.states.focus', value: focus })
  return ops
}
