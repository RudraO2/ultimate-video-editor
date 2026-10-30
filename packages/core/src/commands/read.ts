import { z } from 'zod'
import { MotionBlurSettingsSchema } from '../motionBlur'
import { SoundVoiceSchema } from '../soundVoice'
import { slotAnimation } from '../animation'
import type { Layer } from '../schema'
import { creditLine, creditsOf } from '../credits'
import { compsOnPage, findComp, layerEnd, locateLayer, pageOf } from '../doc'
import { CommandError } from '../errors'
import { nestedInside } from '../nest'
import { evaluateProperty, propertiesOf } from '../properties'
import { defineCommand } from '../registry'
import {
  AudioLayerSchema,
  CompSchema,
  EasingSchema,
  GroupLayerSchema,
  IdSchema,
  ImageLayerSchema,
  InstalledFontSchema,
  KeyframeSchema,
  LayerSchema,
  LayoutItemSchema,
  LayoutSchema,
  MediaAssetSchema,
  NestedLayerSchema,
  NestedPlaybackSchema,
  PaintSchema,
  ProjectSchema,
  ShapeGeometrySchema,
  ShapeLayerSchema,
  StrokeSchema,
  TextLayerSchema,
  TextStyleSchema,
  TrackSchema,
  TransitionSchema,
  TransformSchema,
  VideoLayerSchema,
} from '../schema'

export const docOverview = defineCommand({
  name: 'doc.overview',
  summary: 'The project at a glance: comps, sizes, layer counts and media. Call this first.',
  details:
    'Comp space has its origin at the comp centre with +y down: a 1920×1080 comp spans x −960…960 and y −540…540. Times are milliseconds. Keyframe times are relative to the layer start unless a command says otherwise.',
  effect: 'read',
  input: z.strictObject({}),
  run: (_input, ctx) => {
    const project = ctx.project
    return {
      project: { id: project.id, name: project.name },
      pages: project.pages.map((page) => ({ id: page.id, name: page.name, frames: compsOnPage(project, page).map((c) => c.id) })),
      comps: project.comps.map((comp) => ({
        id: comp.id,
        name: comp.name,
        width: comp.width,
        height: comp.height,
        fps: comp.fps,
        durationMs: comp.durationMs,
        mode: comp.mode,
        ...(comp.mode === 'static' ? { stillMs: comp.stillMs } : {}),
        ...(comp.embedded ? { embedded: true } : { pageId: pageOf(project, comp)?.id }),
        tracks: comp.tracks.length,
        layers: comp.tracks.reduce((count, track) => count + track.layers.length, 0),
      })),
      media: project.media.map((m) => ({ id: m.id, kind: m.kind, name: m.name })),
      fonts: [...new Set(project.fonts.map((f) => f.family))],
      credits: creditsOf(project).map((c) => ({ ...c, line: creditLine(c) })),
    }
  },
})

/** A layer's entrance and exit presets, briefly ("fade-up per word"), for listings. */
function animationSummary(layer: Layer): { animations?: Record<string, string> } {
  const out: Record<string, string> = {}
  for (const target of ['layer', 'text'] as const) {
    for (const slot of ['in', 'out'] as const) {
      const spec = slotAnimation(layer, target, slot)
      if (spec) out[`${target === 'layer' ? 'layer' : 'text'} ${slot}`] = target === 'text' ? `${spec.preset} per ${spec.unit}` : spec.preset
    }
  }
  return Object.keys(out).length > 0 ? { animations: out } : {}
}

export const layersList = defineCommand({
  name: 'layers.list',
  summary: "A comp's tracks from front to back, with each layer's id, name, kind and time span (and, in the editor, the bounds it covers). A track in a group names it (groupId); a group's own track comes just before its members'.",
  effect: 'read',
  input: z.strictObject({ compId: IdSchema.optional().describe('Default the comp open in the editor') }),
  run: ({ compId }, ctx) => {
    const comp = findComp(ctx.project, compId ?? ctx.view.compId)
    return {
      compId: comp.id,
      tracks: comp.tracks.map((track, index) => ({
        id: track.id,
        index,
        ...(track.groupId ? { groupId: track.groupId } : {}),
        layers: track.layers.map((l) => ({
          id: l.id,
          name: l.name,
          kind: l.kind,
          startMs: l.startMs,
          endMs: layerEnd(l),
          ...(l.kind === 'nested' ? { sourceCompId: l.sourceCompId, inside: nestedInside(ctx.project, l) } : {}),
          ...(l.kind === 'group' && l.layout ? { layout: { flow: l.layout.flow, gap: l.layout.gap, width: l.layout.width, height: l.layout.height } } : {}),
          ...animationSummary(l),
        })),
        ...(track.transitions.length > 0
          ? { transitions: track.transitions.map((t) => ({ id: t.id, preset: t.preset, aLayerId: t.aLayerId, bLayerId: t.bLayerId, durationMs: t.durationMs })) }
          : {}),
      })),
    }
  },
})

export const layerGet = defineCommand({
  name: 'layer.get',
  summary: "A layer's full data, plus the comp and track it is on.",
  effect: 'read',
  input: z.strictObject({ id: IdSchema.describe('Layer id, or a name only one layer has') }),
  run: ({ id }, ctx) => {
    const { comp, track, layer } = locateLayer(ctx.project, id)
    return { compId: comp.id, trackId: track.id, layer }
  },
})

export const layerProperties = defineCommand({
  name: 'layer.properties',
  summary: 'Every animatable property of a layer: name, path, value, range and number of keys.',
  details: 'Pass atMs (comp time) to read animated values at that moment; by default values are read at the layer start.',
  effect: 'read',
  input: z.strictObject({ id: IdSchema, atMs: z.number().optional() }),
  run: ({ id, atMs }, ctx) => {
    const { layer } = locateLayer(ctx.project, id)
    const layerTime = (atMs ?? layer.startMs) - layer.startMs
    return propertiesOf(layer).map((spec) => ({
      alias: spec.alias,
      path: spec.path,
      type: spec.type,
      ...(spec.min !== undefined ? { min: spec.min } : {}),
      ...(spec.max !== undefined ? { max: spec.max } : {}),
      value: evaluateProperty(layer, spec, layerTime),
      keys: layer.animations[spec.path]?.length ?? 0,
      description: spec.description,
    }))
  },
})

const TYPES = {
  project: ProjectSchema,
  comp: CompSchema,
  track: TrackSchema,
  layer: LayerSchema,
  text: TextLayerSchema,
  shape: ShapeLayerSchema,
  group: GroupLayerSchema,
  nested: NestedLayerSchema,
  playback: NestedPlaybackSchema,
  image: ImageLayerSchema,
  video: VideoLayerSchema,
  audio: AudioLayerSchema,
  transform: TransformSchema,
  textStyle: TextStyleSchema,
  shapeGeometry: ShapeGeometrySchema,
  paint: PaintSchema,
  stroke: StrokeSchema,
  layout: LayoutSchema,
  layoutItem: LayoutItemSchema,
  keyframe: KeyframeSchema,
  easing: EasingSchema,
  media: MediaAssetSchema,
  font: InstalledFontSchema,
  sound: SoundVoiceSchema,
  transition: TransitionSchema,
  motionBlur: MotionBlurSettingsSchema,
} as const

type TypeName = keyof typeof TYPES
const TYPE_NAMES = Object.keys(TYPES) as [TypeName, ...TypeName[]]

export const apiDescribe = defineCommand({
  name: 'api.describe',
  summary: 'The exact shape of a document type or of a command input, read from the live schema.',
  details:
    'Pass type (a document type) or command (a command name). With neither, lists the types and every command. Check the shape before writing a field you have not written before.',
  effect: 'read',
  input: z.strictObject({ type: z.enum(TYPE_NAMES).optional(), command: z.string().optional() }),
  run: ({ type, command }, ctx) => {
    if (command !== undefined) {
      const def = ctx.registry.get(command)
      if (!def) throw new CommandError(`Unknown command "${command}".`, 'api.describe with no arguments lists every command.')
      return {
        command: def.name,
        summary: def.summary,
        details: def.details ?? null,
        effect: def.effect,
        input: ctx.registry.inputSchema(def.name),
      }
    }
    if (type !== undefined) return { type, schema: z.toJSONSchema(TYPES[type], { io: 'input' }) }
    return {
      types: TYPE_NAMES,
      commands: ctx.registry.list().map((d) => ({ name: d.name, summary: d.summary, effect: d.effect })),
    }
  },
})
