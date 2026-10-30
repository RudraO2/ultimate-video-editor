import { z } from 'zod'
import { deepClone } from '../clone'
import { assertLaneFree, findComp, findMedia, findTrack, isSpatialKind, layerEnd, locateLayer, newTrack, sortLane } from '../doc'
import { idList } from '../compat'
import { LooseEffectSchema, mintEffectIds, toEffect } from './effects'
import { dropCharacterRefs } from '../characters'
import { removeJointsTo } from './physics'
import { remapCues } from './caption'
import { pruneTransitions } from './transition'
import { assertPaintsSupported, type MintId, mintPaintIds, type PaintInput, PaintInputSchema, type StrokeInput, StrokeInputSchema, toPaint, toStroke } from '../paint'
import { CommandError, parseOrThrow } from '../errors'
import { groupBlock, groupDescendants, groupLaneIndex } from '../groups'
import { findLook, lookAnimationInput, lookLayerInput, lookSound, lookStyle } from '../looks'
import { upsertKey } from '../keys'
import { applyPatchOps } from '../paths'
import { nestingLoops, orphanedEmbeddedComps } from '../nest'
import { normalizeSvgPath } from '../svgPath'
import { remapRanges } from '../textRanges'
import { checkValue, propertiesOf, resolveProperty, spreadValue, writeProperty } from '../properties'
import { defineCommand } from '../registry'
import { assertModelMesh, defaultModelAnimation, findModelAsset, MESH_DEFAULT_COLOR, meshGeometryInput, modelName } from '../meshes'
import { findPrimitive } from '../primitives'
import { isWorld } from '../world'
import { closedPath } from './worldExtrude'
import { checkSoundRefs, findCategory } from './sound'
import { categoryForFileName } from '../soundMix'
import {
  CameraSchema,
  ColorSchema,
  type Comp,
  EmptySchema,
  IdSchema,
  LAYER_KINDS,
  type LayerKind,
  LayerOriginSchema,
  LayerSchema,
  LightSchema,
  type MediaAsset,
  MESH_SHADING,
  type ModelAnimation,
  ModelAnimationSchema,
  optionalFields,
  type Paint,
  type Project,
  type ShapeGeometry,
  ShapeGeometrySchema,
  SPATIAL_KINDS,
  type Stroke,
  TextStyleSchema,
  type Transform,
  TransformSchema,
} from '../schema'

function mediaFor(kind: LayerKind, mediaId: string | undefined, project: Project): MediaAsset | undefined {
  if (kind === 'text' || kind === 'shape' || kind === 'path' || kind === 'group' || kind === 'nested' || isSpatialKind(kind)) {
    if (mediaId !== undefined) throw new CommandError(`A ${kind} layer does not use media.`)
    return undefined
  }
  if (mediaId === undefined) {
    throw new CommandError(`A ${kind} layer needs mediaId.`, 'Register the file with media.add, then pass its id.')
  }
  const media = findMedia(project, mediaId)
  const fits = media.kind === kind || (kind === 'audio' && media.kind === 'video' && media.hasAudio !== false)
  if (!fits) throw new CommandError(`"${media.name}" is ${media.kind} media and cannot be a ${kind} layer.`)
  return media
}

/** Pictures larger than the comp start scaled down to fit inside it, unless the caller sets a scale. */
function fitScale(
  kind: LayerKind,
  media: MediaAsset | undefined,
  comp: Comp,
  transform: Partial<Transform> | undefined,
): Partial<Transform> {
  if ((kind !== 'image' && kind !== 'video') || !media?.width || !media.height) return {}
  if (transform?.scaleX !== undefined || transform?.scaleY !== undefined) return {}
  const fit = Math.min(1, comp.width / media.width, comp.height / media.height)
  return fit < 1 ? { scaleX: fit, scaleY: fit } : {}
}

/** Shape geometry as layer.create takes it: the geometry, plus fill, strokeColor and strokeWidth as shorthand for paints. */
const ShapeCreateSchema = optionalFields(ShapeGeometrySchema).extend({
  fill: ColorSchema.optional().describe('Shorthand for one solid fill'),
  strokeColor: ColorSchema.optional().describe('Shorthand for one solid stroke (4 px unless strokeWidth)'),
  strokeWidth: z.number().min(0).optional().describe('Shorthand: the width of that stroke'),
})

/** The fields of a camera, light or controller as layer.create takes them: any subset. */
const CameraCreateSchema = optionalFields(CameraSchema)
const LightCreateSchema = optionalFields(LightSchema)
const EmptyCreateSchema = optionalFields(EmptySchema)
/** A mesh as layer.create takes it: the primitive and its params (checked by meshGeometryInput), and the shading fields. */
const MeshCreateSchema = z.strictObject({
  assetId: IdSchema.optional().describe('A 3D model in the project media (kind model) instead of a primitive'),
  primitive: z.string().optional().describe('A primitive id (catalog.list primitives); default cube'),
  params: z.record(z.string(), z.unknown()).optional().describe("The primitive's params by key; the rest take their defaults"),
  shading: z.enum(MESH_SHADING).optional(),
  smoothAngle: z.number().min(0).max(180).optional(),
  castShadow: z.boolean().optional(),
  receiveShadow: z.boolean().optional(),
})

/** A mesh layer's own fields from layer.create's `mesh`: the checked geometry and the shading fields given. */
function meshFields(mesh: z.infer<typeof MeshCreateSchema> | undefined, project: Project) {
  const { primitive, params, assetId, ...rest } = mesh ?? {}
  if (assetId !== undefined) {
    if (primitive !== undefined || params !== undefined) throw new CommandError('A mesh is a primitive or a model, not both.', 'Give primitive and params, or assetId.')
    const animation = defaultModelAnimation(findModelAsset(project, assetId))
    return { geometry: { type: 'asset' as const, assetId }, ...(animation ? { animation } : {}), ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) }
  }
  return { geometry: meshGeometryInput(primitive, params), ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) }
}

type CreateInput = {
  kind: LayerKind | 'media' | 'comp'
  shape?: z.infer<typeof ShapeCreateSchema> | 'rect' | 'ellipse' | 'polygon' | 'star'
  width?: number
  height?: number
  cornerRadius?: number
  pointCount?: number
  innerRatio?: number
  fill?: PaintInput | null
  stroke?: StrokeInput | null
  fills?: PaintInput[]
  strokes?: StrokeInput[]
  mediaId?: string
  assetId?: string
  x?: number
  y?: number
  transform?: Partial<Transform>
  camera?: z.infer<typeof CameraCreateSchema>
  light?: z.infer<typeof LightCreateSchema>
  empty?: z.infer<typeof EmptyCreateSchema>
  mesh?: z.infer<typeof MeshCreateSchema>
}

type Folded<T> = Omit<T, 'kind' | 'shape' | 'fill' | 'stroke' | 'fills' | 'strokes'> & {
  kind: LayerKind
  shape?: Partial<ShapeGeometry>
  fills?: Paint[]
  strokes?: Stroke[]
}

/**
 * Folds AtomCut's layer.create fields (kind "media", assetId, top-level x, y,
 * shape fields, fill and stroke) and the shape shorthand into ours: geometry
 * in `shape`, paints in `fills` and `strokes`.
 */
function atomcutCreateInput<T extends CreateInput>(raw: T, project: Project, ids: MintId): Folded<T> {
  if (raw.mediaId !== undefined && raw.assetId !== undefined && raw.mediaId !== raw.assetId) {
    throw new CommandError('mediaId and assetId disagree.', 'Give one of them.')
  }
  const mediaId = raw.mediaId ?? raw.assetId
  let kind: LayerKind
  // A model file becomes a mesh that reads it.
  let model = false
  if (raw.kind === 'media') {
    if (mediaId === undefined) throw new CommandError('A media layer needs assetId (or mediaId).', 'media.list lists the media in the project.')
    const found = findMedia(project, mediaId).kind
    if (found === 'model') {
      model = true
      kind = 'mesh'
    } else kind = found
  } else kind = raw.kind === 'comp' ? 'nested' : raw.kind

  const geometry = Object.entries({
    width: raw.width,
    height: raw.height,
    cornerRadius: raw.cornerRadius,
    pointCount: raw.pointCount,
    innerRatio: raw.innerRatio,
  }).filter(([, v]) => v !== undefined)
  if (kind !== 'shape' && geometry.length > 0) throw new CommandError(`${geometry.map(([k]) => k).join(', ')} only apply to shape layers.`)
  const paintFields = (['fill', 'stroke', 'fills', 'strokes'] as const).filter((k) => raw[k] !== undefined)
  if (kind !== 'shape' && kind !== 'text' && kind !== 'path' && kind !== 'mesh' && paintFields.length > 0) {
    throw new CommandError(`${paintFields.join(', ')} only apply to shape, path, text and mesh layers.`)
  }
  if (kind === 'mesh' && (raw.stroke !== undefined || raw.strokes !== undefined)) {
    throw new CommandError('A mesh has fills but no strokes.', 'Its colour is its first solid fill.')
  }

  let shape: Partial<ShapeGeometry> | undefined
  let shorthand: { fill?: string; strokeColor?: string; strokeWidth?: number } = {}
  if (typeof raw.shape === 'string') {
    shape = { type: raw.shape }
  } else if (raw.shape !== undefined) {
    const { fill, strokeColor, strokeWidth, ...rest } = raw.shape
    shape = rest
    shorthand = { fill, strokeColor, strokeWidth }
  }
  if (geometry.length > 0) shape = { ...shape, ...Object.fromEntries(geometry) }

  const clash = (a: string, b: string) => new CommandError(`${a} and ${b} both set the paints.`, 'Give one of them.')
  if (raw.fill !== undefined && raw.fills !== undefined) throw clash('fill', 'fills')
  if (shorthand.fill !== undefined && (raw.fill !== undefined || raw.fills !== undefined)) throw clash('shape.fill', raw.fill !== undefined ? 'fill' : 'fills')
  if (raw.stroke !== undefined && raw.strokes !== undefined) throw clash('stroke', 'strokes')
  const strokeShorthand = shorthand.strokeColor !== undefined || shorthand.strokeWidth !== undefined
  if (strokeShorthand && (raw.stroke !== undefined || raw.strokes !== undefined)) throw clash('shape.strokeColor', raw.stroke !== undefined ? 'stroke' : 'strokes')

  let fills: Paint[] | undefined
  if (raw.fills !== undefined) fills = raw.fills.map((f) => toPaint(f, ids))
  else if (raw.fill !== undefined) fills = raw.fill === null ? [] : [toPaint(raw.fill, ids)]
  else if (shorthand.fill !== undefined) fills = [toPaint(shorthand.fill, ids)]
  else if (kind === 'shape') fills = [toPaint(DEFAULT_SHAPE_FILL, ids)]
  else if (kind === 'path') fills = []
  else if (kind === 'mesh') fills = model || raw.mesh?.assetId !== undefined ? [] : [toPaint(MESH_DEFAULT_COLOR, ids)]

  let strokes: Stroke[] | undefined
  if (raw.strokes !== undefined) strokes = raw.strokes.map((s) => toStroke(s, ids))
  else if (raw.stroke !== undefined) strokes = raw.stroke === null ? [] : [toStroke(raw.stroke, ids)]
  else if (strokeShorthand && shorthand.strokeWidth !== 0) {
    strokes = [toStroke({ color: shorthand.strokeColor ?? '#ffffff', width: shorthand.strokeWidth ?? 4 }, ids)]
  } else if (kind === 'path' && (fills?.length ?? 0) === 0) {
    // A bare path gets a light line, so it can be seen.
    strokes = [toStroke({ color: '#e8e8ee', width: 4 }, ids)]
  }

  for (const axis of ['x', 'y'] as const) {
    if (raw[axis] !== undefined && raw.transform?.[axis] !== undefined && raw[axis] !== raw.transform[axis]) {
      throw new CommandError(`${axis} and transform.${axis} disagree.`, 'Give one of them.')
    }
  }
  const place = Object.fromEntries((['x', 'y'] as const).filter((a) => raw[a] !== undefined).map((a) => [a, raw[a]]))
  const transform = raw.transform === undefined && Object.keys(place).length === 0 ? undefined : { ...raw.transform, ...place }
  const { fill: _fill, stroke: _stroke, fills: _fills, strokes: _strokes, ...rest } = raw
  return { ...rest, kind, shape, mediaId: model ? undefined : mediaId, ...(model ? { mesh: { ...raw.mesh, assetId: mediaId } } : {}), transform, fills, strokes } as unknown as Folded<T>
}

/** A new shape's fill when none is given. */
const DEFAULT_SHAPE_FILL = '#7c5cff'

export const layerCreate = defineCommand({
  name: 'layer.create',
  summary: 'Create a text, shape (rect, ellipse, polygon, star), path, nested comp, image, video or audio layer in a comp.',
  details:
    'template (text layers) starts from a finished look in catalog text-templates: its type, effects, entrance and typing sound, with its sample text when you give none; anything you give wins. A nested layer (kind nested, or AtomCut\'s "comp") shows another comp, sourceCompId, as one layer the size of that comp: a link, so editing that comp changes every place it shows (layers.makeUnique gives one its own copy); it lasts as long as the comp unless durationMs says otherwise. A path takes SVG path data in d, written in any space: the layer is centred on the outline\'s box, so place it with x and y. A path with a fill and no stroke has no outline; a bare one gets a 4 px light line. Groups are made with layers.group. Text grows on one line per paragraph unless maxWidth sets a wrap width (add maxHeight for a fixed box). Without trackId the layer gets a new track: visual layers go to the front, audio to the back. Video, image and audio layers need mediaId from media.add; video and audio default to the media length, everything else to the rest of the comp. Images and videos larger than the comp start scaled down to fit inside it, unless transform sets a scale. transform, style (text only) and shape (shape only) take any subset of their fields. In a 3D world, kind camera, light, empty (a controller) or mesh makes that object from the camera, light, empty or mesh fields (a mesh: primitive, params, and fill for its colour); world.add is the shorthand that also aims it.',
  effect: 'write',
  input: z.strictObject({
    compId: IdSchema.optional().describe('Default the comp open in the editor'),
    kind: z
      .enum([...LAYER_KINDS, ...SPATIAL_KINDS, 'media', 'comp'])
      .describe('"media" takes its kind from the media (AtomCut\'s shape); "comp" is nested; groups come from layers.group; camera, light, empty (a controller) and mesh only in a 3D world'),
    sourceCompId: IdSchema.optional().describe('The comp a nested layer shows (AtomCut: sourceFrameId)'),
    name: z.string().min(1).optional(),
    startMs: z.number().min(0).default(0),
    durationMs: z.number().positive().optional(),
    trackId: IdSchema.optional(),
    groupId: IdSchema.optional().describe('Create it in this group, on a new lane at the front of its members'),
    text: z.string().optional(),
    origin: LayerOriginSchema.nullable().optional().describe('Where the layer came from, for credit: {kind: "icon", id, license, author}'),
    soundBus: z.string().min(1).optional().describe('Its sound category (sound.category list). Audio and video are tagged from the file name when not given (voice, music, ambience, sfx)'),
    template: z
      .string()
      .min(1)
      .optional()
      .describe('Text layers: a template from catalog text-templates (its id or name). Gives the type, effects, entrance and typing sound; the text, style, effects and sounds you give win over it'),
    style: optionalFields(TextStyleSchema)
      .extend({ textEffects: z.array(LooseEffectSchema).optional().describe('Per-glyph effects: [{type: "shadow" | "glow" | "extrude" | "echo", ...fields}]') })
      .optional(),
    maxWidth: z.number().positive().optional().describe('Text box width in px: lines wrap at it. Omitted: one line per paragraph'),
    maxHeight: z.number().positive().optional().describe('Text box height in px, with maxWidth: a fixed box'),
    shape: z
      .union([ShapeCreateSchema, z.enum(['rect', 'ellipse', 'polygon', 'star'])])
      .optional()
      .describe('Geometry fields, or just the shape type'),
    width: z.number().positive().optional().describe('Shape width (same as shape.width)'),
    height: z.number().positive().optional().describe('Shape height (same as shape.height)'),
    cornerRadius: z.number().min(0).optional().describe('Shape corner radius'),
    pointCount: z.number().int().min(3).max(100).optional().describe('Polygon sides or star points'),
    innerRatio: z.number().min(0.01).max(1).optional().describe("A star's inner radius as a fraction of its outer one"),
    d: z.string().min(1).optional().describe('SVG path data for a path layer, e.g. "M0 0 C 40 -60 120 -60 160 0"'),
    fillRule: z.enum(['nonzero', 'evenodd']).optional().describe('A path\'s fill rule; evenodd makes overlaps holes'),
    fill: PaintInputSchema.nullable()
      .optional()
      .describe('One fill: a colour, or a paint ({type: "linear" | "radial" | "angular", stops: [{offset, color}], start, end}); null for none. Shapes default to one solid fill'),
    stroke: StrokeInputSchema.nullable()
      .optional()
      .describe('One stroke: a colour (4 px, centred), {color, width}, or a full stroke {paint, width, align, cap, join, dash, trim}'),
    fills: z.array(PaintInputSchema).optional().describe('Several fills, bottom to top (instead of fill)'),
    strokes: z.array(StrokeInputSchema).optional().describe('Several strokes, bottom to top (instead of stroke)'),
    mediaId: IdSchema.optional(),
    assetId: IdSchema.optional().describe('Same as mediaId (AtomCut\'s name)'),
    x: z.number().optional().describe('Same as transform.x'),
    y: z.number().optional().describe('Same as transform.y'),
    transform: optionalFields(TransformSchema).optional(),
    camera: CameraCreateSchema.optional().describe('A camera layer: lens and focus fields (world.add is the shorthand)'),
    light: LightCreateSchema.optional().describe('A light layer: type, colour, intensity and the rest (world.add is the shorthand)'),
    empty: EmptyCreateSchema.optional().describe('A controller layer: how it shows in the editor'),
    mesh: MeshCreateSchema.optional().describe('A mesh layer: its primitive and params (world.add is the shorthand); its colour is its first solid fill (fill or fills)'),
    sounds: z
      .array(z.record(z.string(), z.unknown()))
      .optional()
      .describe('Sounds fired by its motion: [{pack: "pop", volume: 0.3, trigger: {kind: "text"}, phase: "in"}] (api.describe SoundVoice)'),
    effects: z
      .array(LooseEffectSchema)
      .optional()
      .describe('Layer effects, first applied first: [{type: "shadow" | "glow" | "stroke" | …, ...fields}] (catalog.list layer-effects)'),
    set: z
      .record(z.string(), z.union([z.number(), z.string(), z.array(z.number())]))
      .optional()
      .describe('Property values to apply right away, as in layer.set: {"opacity": 0.8, "rotation": -4}'),
  }),
  run: async (raw, ctx) => {
    const input = atomcutCreateInput(raw, ctx.project, ctx.ids)
    const { kind } = input
    if (kind !== 'text' && (input.text !== undefined || input.style !== undefined || input.maxWidth !== undefined || input.maxHeight !== undefined)) {
      throw new CommandError('text, style, maxWidth and maxHeight only apply to text layers.')
    }
    if (kind !== 'shape' && input.shape !== undefined) throw new CommandError('shape only applies to shape layers.')
    if (kind === 'group') throw new CommandError('Groups are made from layers.', 'layers.group {ids, layout?} groups existing layers.')
    for (const spatial of SPATIAL_KINDS) {
      if (kind !== spatial && input[spatial] !== undefined) throw new CommandError(`${spatial} only applies to ${spatial} layers.`)
    }
    if (kind !== 'path' && (input.d !== undefined || input.fillRule !== undefined)) throw new CommandError('d and fillRule only apply to path layers.')
    if (kind !== 'nested' && input.sourceCompId !== undefined) throw new CommandError('sourceCompId only applies to nested layers.')
    if (kind === 'nested' && input.sourceCompId === undefined) throw new CommandError('A nested layer needs sourceCompId, the comp it shows.', 'doc.overview lists the comps.')
    if (kind === 'path' && input.d === undefined) throw new CommandError('A path layer needs d, its SVG path data.', 'For example d: "M0 0 L200 0 L100 160 Z".')
    const geometry = input.d === undefined ? undefined : normalizeSvgPath(input.d)
    const look = input.template === undefined ? undefined : findLook(input.template)
    if (input.template !== undefined) {
      if (kind !== 'text') throw new CommandError('template only applies to text layers.')
      if (!look) throw new CommandError(`No text template "${input.template}".`, 'catalog.list {"catalog": "text-templates"} lists them.')
    }

    const comp = findComp(ctx.project, input.compId ?? ctx.view.compId)
    if (input.mesh?.assetId !== undefined && !isWorld(comp)) {
      throw new CommandError('A model goes into a 3D world.', `"${comp.name}" is a flat comp. Make a world with world_create (or open one), then add the model with world_import_model.`)
    }
    if (isSpatialKind(kind) && !isWorld(comp)) {
      throw new CommandError(`"${comp.name}" is a flat comp, not a 3D world.`, 'Cameras, lights, controllers and meshes live in 3D worlds: make one with world_create.')
    }
    const media = mediaFor(kind, input.mediaId, ctx.project)
    const source = input.sourceCompId === undefined ? undefined : findComp(ctx.project, input.sourceCompId)
    if (source && nestingLoops(ctx.project, comp.id, source.id)) {
      throw new CommandError(`Comp "${source.name}" ${source.id === comp.id ? 'is this comp' : `shows comp "${comp.name}"`}; a comp cannot show itself.`)
    }
    const mediaLength = kind === 'video' || kind === 'audio' ? media?.durationMs : source?.durationMs
    // A layer in a static frame spans it: there is no timing to manage.
    const fixed = comp.mode === 'static'
    const startMs = fixed ? 0 : input.startMs
    const durationMs = fixed ? comp.durationMs : (input.durationMs ?? mediaLength ?? Math.max(1, comp.durationMs - input.startMs))
    const text = input.text ?? look?.sampleText
    const firstLine = (text ?? '').trim().split('\n')[0]?.slice(0, 32)
    const defaultName =
      kind === 'text'
        ? firstLine || 'Text'
        : kind === 'shape'
          ? { rect: 'Rectangle', ellipse: 'Ellipse', polygon: 'Polygon', star: 'Star' }[input.shape?.type ?? 'rect']
          : kind === 'path'
            ? 'Path'
            : kind === 'empty'
              ? 'Controller'
              : kind === 'mesh'
                ? input.mesh?.assetId !== undefined
                  ? modelName(findModelAsset(ctx.project, input.mesh.assetId))
                  : (findPrimitive(input.mesh?.primitive ?? 'cube')?.label ?? 'Mesh')
              : (media?.name ?? source?.name ?? kind.replace(/^./, (c) => c.toUpperCase()))

    // Media is tagged from its file name, as on import in AtomCut; a name given by the caller must exist.
    const tagged = (kind === 'audio' || kind === 'video') && media ? (categoryForFileName(media.name) ?? categoryForFileName(media.path)) : null
    const soundBus = input.soundBus !== undefined ? findCategory(ctx.project, input.soundBus).id : (tagged ?? undefined)
    if ((kind === 'audio' || (isSpatialKind(kind) && kind !== 'mesh')) && input.effects !== undefined) throw new CommandError(`${kind === 'audio' ? 'Audio' : 'Cameras, lights and controllers'} have no pixels for effects.`)
    // A template gives the starting point; what the caller says wins.
    const fromLook = look ? lookLayerInput(look) : undefined
    const lookSounds = look && lookSound(look) ? [lookSound(look) as Record<string, unknown>] : undefined
    const base = {
      id: ctx.ids('layer'),
      name: input.name ?? defaultName,
      startMs,
      durationMs,
      transform: { ...fitScale(kind, media, comp, input.transform), ...fromLook?.transform, ...input.transform },
      effects: (input.effects ?? fromLook?.effects ?? []).map((e) => toEffect('layer', e, ctx.ids)),
      sounds: (input.sounds ?? lookSounds ?? []).map((v) => ({ ...v, id: typeof v.id === 'string' ? v.id : ctx.ids('sound') })),
      origin: input.origin ?? null,
      ...(soundBus !== undefined ? { soundBus } : {}),
    }
    const mergedStyle = look ? { ...lookStyle(look), ...input.style } : input.style
    const loose = mergedStyle?.textEffects as Record<string, unknown>[] | undefined
    const style = loose ? { ...mergedStyle, textEffects: loose.map((e) => toEffect('text', e, ctx.ids)) } : mergedStyle
    const candidate =
      kind === 'text'
        ? {
            ...base,
            kind,
            text: text ?? 'Text',
            maxWidth: input.maxWidth,
            maxHeight: input.maxHeight,
            style: style ?? {},
            fills: input.fills,
            strokes: input.strokes,
          }
        : kind === 'shape'
          ? { ...base, kind, shape: input.shape ?? {}, fills: input.fills, strokes: input.strokes }
          : kind === 'path'
            ? { ...base, kind, geometry, fillRule: input.fillRule, fills: input.fills, strokes: input.strokes }
            : kind === 'nested'
              ? { ...base, kind, sourceCompId: source?.id }
              : kind === 'camera'
                ? { ...base, kind, camera: input.camera }
                : kind === 'light'
                  ? { ...base, kind, light: input.light }
                  : kind === 'empty'
                    ? { ...base, kind, empty: input.empty }
                    : kind === 'mesh'
                      ? { ...base, kind, ...meshFields(input.mesh, ctx.project), fills: input.fills }
                    : { ...base, kind, mediaId: media?.id }
    const layer = parseOrThrow(LayerSchema, candidate, 'The new layer')
    assertPaintsSupported(layer)

    let trackId = input.trackId
    let groupLane = -1
    if (input.groupId !== undefined) {
      if (trackId !== undefined) throw new CommandError('Give trackId or groupId, not both.')
      const group = locateLayer(ctx.project, input.groupId).layer
      if (group.kind !== 'group') throw new CommandError(`"${group.name}" is not a group.`)
      if (kind === 'audio') throw new CommandError('Audio layers cannot be in a group.')
      groupLane = groupLaneIndex(comp, group.id)
      if (groupLane < 0) throw new CommandError(`"${group.name}" is not in comp "${comp.name}".`)
    }
    ctx.write('Create layer', (draft) => {
      const target = findComp(draft, comp.id)
      if (groupLane >= 0 && input.groupId !== undefined) {
        const track = newTrack(ctx.ids('track'), [layer], undefined, input.groupId)
        trackId = track.id
        target.tracks.splice(groupLane + 1, 0, track)
      } else if (trackId !== undefined) {
        const track = findTrack(target, trackId)
        assertLaneFree(track, layer.startMs, layerEnd(layer))
        track.layers.push(layer)
        sortLane(track)
      } else {
        const track = newTrack(ctx.ids('track'), [layer])
        trackId = track.id
        if (layer.kind === 'audio') target.tracks.push(track)
        else target.tracks.unshift(track)
      }
    })
    if (look) {
      const entrance = lookAnimationInput(look, layer.id)
      if (entrance) {
        const animated = await ctx.call('animation.set', entrance)
        if (!animated.ok) throw new CommandError(`template ${look.id}: ${animated.error}`, animated.hint)
      }
    }
    if (raw.set !== undefined && Object.keys(raw.set).length > 0) {
      const applied = await ctx.call('layer.set', { id: layer.id, values: raw.set, mode: 'base' })
      if (!applied.ok) throw new CommandError(`set: ${applied.error}`, applied.hint)
    }
    return { id: layer.id, trackId, compId: comp.id }
  },
})

export const layerSet = defineCommand({
  name: 'layer.set',
  summary: 'Set animatable properties by name, e.g. {"values": {"x": 120, "opacity": 0.5, "fill": "#ff8800"}}.',
  details:
    'Names are aliases (x, y, z, scale, position, rotation, opacity, fontSize, color, fill, width…) or paths (transform.x); layer.properties lists them. position takes [x, y]; scale one value or [sx, sy]. mode "auto" (default) keys a property that already has keys (at atMs, comp time, default the playhead) and sets the resting value of one that has none; "keyframe" always keys; "base" always sets the resting value (a keyed property keeps playing its keys). ids (one id or a list) sets several layers at once. Use layer.patch for fields that are not animatable.',
  effect: 'write',
  input: z.strictObject({
    id: IdSchema.optional(),
    ids: z.union([IdSchema, z.array(IdSchema).min(1)]).optional().describe('One layer or several (instead of id)'),
    values: z.record(z.string(), z.union([z.number(), z.string(), z.boolean(), z.array(z.number())])).optional(),
    animation: optionalFields(ModelAnimationSchema).optional().describe("A model mesh's own clip: {clip (a name from world.inspect model.clips, or null for rest), speed, loop}; only the fields given change"),
    atMs: z.number().optional().describe('Comp time at which to key; default the playhead'),
    mode: z.enum(['auto', 'base', 'keyframe']).default('auto'),
  }),
  run: ({ id, ids, values: given, animation, atMs, mode }, ctx) => {
    const values = given ?? {}
    if (Object.keys(values).length === 0 && animation === undefined) throw new CommandError('Give at least one property.', 'values: {"opacity": 0.5}, or animation for a model mesh.')
    const time = atMs ?? ctx.view.playheadMs
    // Check everything, on every layer, before writing anything.
    const plans = idList(id, ids).map((ref) => {
      const { layer } = locateLayer(ctx.project, ref)
      const writes = Object.entries(values).flatMap(([name, value]) => {
        const specs = resolveProperty(layer, name)
        const spread = spreadValue(specs, name, value)
        return specs.map((spec, i) => {
          const keyed = (layer.animations[spec.path]?.length ?? 0) > 0
          return { name, spec, value: checkValue(spec, spread[i]), key: mode === 'keyframe' || (mode === 'auto' && keyed) }
        })
      })
      const keying = writes.find((w) => w.key)
      if (keying && time === undefined) {
        throw new CommandError(
          `"${keying.name}" ${mode === 'keyframe' ? 'is to be keyed' : 'is animated'}, so setting it needs atMs.`,
          'Pass atMs (comp time) to key it there, mode "base" to set its resting value, or keyframes.clear to make it static again.',
        )
      }
      let played: ModelAnimation | undefined
      if (animation !== undefined) {
        if (layer.kind !== 'mesh') throw new CommandError(`animation only applies to model meshes; "${layer.name}" is a ${layer.kind} layer.`)
        played = { clip: null, speed: 1, loop: true, ...layer.animation, ...Object.fromEntries(Object.entries(animation).filter(([, v]) => v !== undefined)) }
        assertModelMesh({ ...layer, animation: played }, ctx.project)
      }
      return { layer, writes, played }
    })
    ctx.write('Set properties', (draft) => {
      for (const { layer, writes, played } of plans) {
        const target = locateLayer(draft, layer.id).layer
        if (played && target.kind === 'mesh') target.animation = played
        for (const w of writes) {
          if (w.key && time !== undefined) {
            const keys = target.animations[w.spec.path] ?? []
            upsertKey(keys, { t: time - target.startMs, v: w.value, ease: w.spec.path === 'switch' ? 'hold' : 'ease-in-out' })
            target.animations[w.spec.path] = keys
          } else {
            writeProperty(target, w.spec, w.value)
          }
        }
      }
    })
    const keyed = [...new Set(plans.flatMap((p) => p.writes.filter((w) => w.key).map((w) => w.spec.path)))]
    return {
      updated: plans.map((p) => p.layer.id),
      properties: [...new Set([...plans.flatMap((p) => p.writes.map((w) => w.spec.path)), ...(animation !== undefined ? ['animation'] : [])])],
      ...(keyed.length > 0 ? { keyed, atMs: time } : {}),
    }
  },
})

export const PatchOpSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('set'), path: z.string().min(1), value: z.unknown() }),
  z.strictObject({ op: z.literal('merge'), path: z.string().min(1), value: z.record(z.string(), z.unknown()) }),
  z.strictObject({ op: z.literal('insert'), path: z.string().min(1), value: z.unknown() }),
  z.strictObject({ op: z.literal('remove'), path: z.string().min(1) }),
  z.strictObject({ op: z.literal('move'), path: z.string().min(1), to: z.number().int().min(0) }),
])

/** Fields with dedicated commands, and where to go instead. */
const GUARDED_FIELDS: Readonly<Record<string, string>> = {
  id: 'Ids never change.',
  kind: 'A layer keeps its kind; create a new layer of the other kind instead.',
  startMs: 'Use timeline.move to shift a layer in time.',
  durationMs: 'Use timeline.trim to change where a layer starts or ends.',
  animations: 'Use keyframes.set and keyframes.clear for keys.',
  sourceCompId: 'A nested layer keeps the comp it shows: create another nested layer for another comp, or layers.makeUnique to give it its own copy.',
}

export const layerPatch = defineCommand({
  name: 'layer.patch',
  summary: "Edit any part of a layer's data by path: set, merge, insert, remove or move. The result is validated.",
  details:
    'For fields layer.set does not cover: the name, modes, options and lists. Paths are dotted with list steps: style.align, shape.type, fills[0], fills[id=paint_1].stops, strokes[-] (append). Inserted paints, strokes and gradient stops get ids when they have none; keys of a removed paint are dropped (droppedKeys). Example: {"op": "merge", "path": "style", "value": {"align": "left"}}. The whole layer is validated afterwards; if any operation makes it invalid, nothing changes and the error names the field.',
  effect: 'write',
  input: z.strictObject({ id: IdSchema, ops: z.array(PatchOpSchema).min(1) }),
  run: ({ id, ops }, ctx) => {
    for (const op of ops) {
      const field = op.path.split(/[.[]/, 1)[0] ?? ''
      if (Object.hasOwn(GUARDED_FIELDS, field)) {
        throw new CommandError(`layer.patch cannot change "${field}".`, GUARDED_FIELDS[field])
      }
    }
    const { layer } = locateLayer(ctx.project, id)
    const copy = deepClone(layer) as unknown as Record<string, unknown>
    applyPatchOps(copy, ops)
    mintPaintIds(copy, ctx.ids)
    mintEffectIds(copy, ctx.ids)
    if (layer.kind === 'text' && typeof copy.text === 'string' && copy.text !== layer.text && JSON.stringify(copy.ranges) === JSON.stringify(layer.ranges)) {
      copy.ranges = remapRanges(layer.ranges, layer.text, copy.text)
      if (layer.caption && JSON.stringify(copy.caption) === JSON.stringify(layer.caption)) copy.caption = remapCues(layer, copy.text)
    }
    const next = parseOrThrow(LayerSchema, copy, 'The patched layer')
    assertPaintsSupported(next)
    if (next.kind === 'mesh') assertModelMesh(next, ctx.project)
    checkSoundRefs(ctx.project, next)
    if (next.kind === 'path' && next.extrude && !closedPath(next.geometry)) {
      throw new CommandError('An extruded path cannot be open.', 'Close every contour with Z, or remove extrude first.')
    }
    // Keys of paints that are gone would animate nothing: drop them, and say so.
    const live = new Set(propertiesOf(next).map((spec) => spec.path))
    const droppedKeys = Object.keys(next.animations).filter((path) => !live.has(path))
    for (const path of droppedKeys) delete next.animations[path]
    ctx.write('Edit layer', (draft) => {
      const location = locateLayer(draft, layer.id)
      location.track.layers[location.layerIndex] = next
    })
    return droppedKeys.length > 0 ? { updated: layer.id, droppedKeys } : { updated: layer.id }
  },
})

export const layersDelete = defineCommand({
  name: 'layers.delete',
  summary: 'Delete layers. Their tracks stay, even when they become empty; a group goes with everything in it and its lanes.',
  effect: 'write',
  input: z.strictObject({ ids: z.array(IdSchema).min(1) }),
  run: ({ ids }, ctx) => {
    const unique = [...new Set(ids.map((ref) => locateLayer(ctx.project, ref).layer.id))]
    const inside: string[] = []
    for (const id of unique) {
      const { comp, layer } = locateLayer(ctx.project, id)
      if (layer.kind === 'group') inside.push(...groupDescendants(comp, layer.id).map((l) => l.id))
    }
    ctx.write('Delete layers', (draft) => {
      for (const id of unique) {
        if (inside.includes(id)) continue
        const location = locateLayer(draft, id)
        if (location.layer.kind === 'group') {
          // The group's lane and every lane in it go too.
          const [, end] = groupBlock(location.comp, id)
          location.comp.tracks.splice(location.trackIndex, end - location.trackIndex)
        } else {
          location.track.layers.splice(location.layerIndex, 1)
        }
      }
      pruneTransitions(draft as Project)
      // Joints that held a body to a layer that is gone go too.
      removeJointsTo(draft as Project, [...unique, ...inside])
      // Behaviours that pointed at a deleted layer lose it (or go, when it was all they had).
      dropCharacterRefs(draft as Project, [...unique, ...inside])
      // An embedded comp goes with the nested layer that owned it (and so do the ones inside it).
      for (let orphans = orphanedEmbeddedComps(draft as Project); orphans.length > 0; orphans = orphanedEmbeddedComps(draft as Project)) {
        const gone = new Set(orphans.map((c) => c.id))
        draft.comps = draft.comps.filter((c) => !gone.has(c.id))
      }
    })
    const alsoDeleted = inside.filter((id) => !unique.includes(id))
    return alsoDeleted.length > 0 ? { deleted: unique, alsoDeleted } : { deleted: unique }
  },
})
