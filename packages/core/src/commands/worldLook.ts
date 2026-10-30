import { z } from 'zod'
import { idList } from '../compat'
import { locateLayer } from '../doc'
import { CommandError } from '../errors'
import { applyMaterialPreset, findMaterialPreset, MATERIAL_PRESET_IDS, stripMaterial } from '../materials'
import { defineCommand } from '../registry'
import { CameraSchema, ColorSchema, FLOOR_MODES, IdSchema, type Layer, MaterialSchema, optionalFields, SHADOW_QUALITIES, TONE_MAPPINGS, type World, WorldRenderSchema } from '../schema'
import { isSpatialKind } from '../doc'
import { isWorld, liveCamera } from '../world'
import { findWorld } from './world'

// The look of a 3D world: its tone mapping, exposure, shadows, mist, bloom,
// ambient occlusion and floor, the depth of field of a camera, and the
// material of its picture planes.

const IdsSchema = z.union([IdSchema, z.array(IdSchema).min(1)]).describe('One layer or several')

const MaterialValues = optionalFields(MaterialSchema.omit({ preset: true }))

export const worldMaterial = defineCommand({
  name: 'world.material',
  summary: 'Give meshes and picture planes of a 3D world a material (lit by the lights), by preset or by values; preset null takes it off.',
  details: `A plane with no material is an unlit picture. A preset (${MATERIAL_PRESET_IDS.join(', ')}) is merged over the defaults, replacing the old material; its colour tints the picture. values then sets fields on top (source file|custom: a model mesh shows its file's own materials with file, or none; custom uses these fields, and values on a file material turn it custom; model pbr|toon|unlit, roughness, metalness, emission, emissionStrength, transmission, ior, thickness, clearcoat, clearcoatRoughness, sheen, iridescence, toonSteps, doubleSided, color); with values alone, they change the layer's material as it is (or the defaults when it has none). preset null removes the material. roughness, metalness, emissionStrength, emission and transmission key (keyframes.set). Only pictures and meshes of a world take a material: not cameras, lights or controllers. catalog.list materials shows the presets.`,
  effect: 'write',
  input: z.strictObject({
    ids: IdsSchema.describe('The picture layers (AtomCut: ids)'),
    preset: z.union([z.string(), z.null()]).optional().describe(`A material preset id, or null to remove the material`),
    values: MaterialValues.optional().describe('Fields to set after the preset'),
  }),
  run: ({ ids, preset, values }, ctx) => {
    const layers = idList(undefined, ids).map((ref) => locateLayer(ctx.project, ref))
    for (const { comp, layer } of layers) {
      if (!isWorld(comp)) {
        throw new CommandError(`"${layer.name}" is in "${comp.name}", a flat comp, not a 3D world.`, 'Materials light the pictures of a world: world_move_into first.')
      }
      if (isSpatialKind(layer.kind) && layer.kind !== 'mesh') {
        throw new CommandError(`"${layer.name}" is a ${layer.kind === 'empty' ? 'controller' : layer.kind}; it has no surface to give a material.`, 'Pass meshes or picture layers (text, shapes, images, …).')
      }
      if (layer.kind === 'audio') throw new CommandError(`"${layer.name}" is audio; it has no surface to give a material.`)
    }
    if (preset === undefined && (values === undefined || Object.keys(values).length === 0)) {
      throw new CommandError('Say what material to give.', `Pass a preset (${MATERIAL_PRESET_IDS.join(', ')}), or values, or preset null to remove it.`)
    }
    if (typeof preset === 'string' && !findMaterialPreset(preset)) {
      throw new CommandError(`No material preset "${preset}".`, `Presets: ${MATERIAL_PRESET_IDS.join(', ')}.`)
    }
    if (preset === null && values !== undefined && Object.keys(values).length > 0) {
      throw new CommandError('preset null removes the material, so values have nothing to change.', 'Drop values, or name a preset.')
    }
    const made = new Map<string, Layer['material']>()
    for (const { layer } of layers) {
      if (preset === null) {
        made.set(layer.id, undefined)
      } else if (typeof preset === 'string') {
        made.set(layer.id, applyMaterialPreset(preset, values ?? {}))
      } else {
        const base = layer.material ?? MaterialSchema.parse({})
        // Editing a model's file material makes it custom: the fields of a file material do nothing.
        made.set(layer.id, MaterialSchema.parse({ ...base, ...(base.source === 'file' ? { source: 'custom' } : {}), ...values }))
      }
    }
    const removed = layers.filter(({ layer }) => preset === null && layer.material).map(({ layer }) => layer.id)
    ctx.write(preset === null ? 'Remove material' : 'Set material', (draft) => {
      for (const { layer } of layers) {
        const target = locateLayer(draft, layer.id).layer
        const material = made.get(layer.id)
        if (material) target.material = material
        else stripMaterial(target)
      }
    })
    return {
      updated: layers.map(({ layer }) => layer.id),
      ...(preset === null ? { removedFrom: removed } : { material: made.get(layers[0]?.layer.id ?? '') }),
    }
  },
})

const Mist = optionalFields(
  z.strictObject({
    enabled: z.boolean().default(false),
    color: ColorSchema.default('#9aa3ad'),
    start: z.number().min(0).default(1000).describe('px from the camera'),
    end: z.number().min(0).default(20_000).describe('px from the camera'),
  }),
)

const Bloom = optionalFields(WorldRenderSchema.shape.bloom.unwrap())
const Ao = optionalFields(WorldRenderSchema.shape.ao.unwrap())
const Floor = optionalFields(WorldRenderSchema.shape.floor.unwrap())
const Dof = optionalFields(CameraSchema.shape.dof.unwrap()).extend({
  focusOn: IdSchema.nullable().optional().describe("A layer of the world to keep sharp, or null to clear (AtomCut's name for focusObjectId)"),
})

const DEFAULT_CAMERA_HINT = 'world_camera {fromDefault: true} adds a camera at the default view first.'

type CameraLayer = Layer & { kind: 'camera' }

export const worldLook = defineCommand({
  name: 'world.look',
  summary: "Change a 3D world's look: tone mapping, exposure, shadows, mist, bloom, ambient occlusion, floor and a camera's depth of field. Only the fields you give change.",
  details:
    "toneMapping is agx (default), aces, neutral or none; exposure is in stops (0 default, each stop doubles the light); shadows turns every light's shadows off or on and shadowQuality sets the shadow map (low 512, medium 1024, high 2048 px). mist is linear fog {enabled, color, start, end}, start and end in px from the camera. bloom is {enabled, strength 0..3 (0.8), radius 0..1 (0.5), threshold 0..1 (0.75), source bright|emission}: bright glows everything above the threshold, emission only what a material emits; true or false alone turns it on or off, and fields without enabled turn it on. ao (ambient occlusion) is {enabled, radius in px 1..5000 (60), strength 0..2 (1)}, also true or false. floor is {mode, color (#202024), opacity 0..1 (0.45), z (0, the height in px)} or a mode alone: none, shadow (only shadows land on it), solid (a coloured plane), mirror (a plane that reflects the scene). dof sets depth of field on a camera: {enabled, focusDistance (px from the camera, 1000), fStop 0.1..128 (2.8, smaller blurs more), focusOn (a layer id kept sharp, overrides focusDistance; null clears)}. Giving dof turns it on unless enabled is false. cameraId names the camera layer; without it the live camera at the playhead is used, and the default camera (no camera layer) has no dof to set. If focusDistance or fStop is keyed on that camera, the keys win over the value written. Returns the look now in effect, and the camera's dof when given.",
  effect: 'write',
  input: z.strictObject({
    compId: IdSchema.optional().describe('The world; default the frame open in the editor (AtomCut: frameId)'),
    toneMapping: z.enum(TONE_MAPPINGS).optional(),
    exposure: z.number().min(-10).max(10).optional().describe('Stops'),
    shadows: z.boolean().optional(),
    shadowQuality: z.enum(SHADOW_QUALITIES).optional(),
    mist: Mist.optional(),
    bloom: z.union([z.boolean(), Bloom]).optional().describe('Fields to change, or true/false for enabled'),
    ao: z.union([z.boolean(), Ao]).optional().describe('Fields to change, or true/false for enabled'),
    floor: z.union([z.enum(FLOOR_MODES), Floor]).optional().describe('Fields to change, or a mode alone'),
    cameraId: IdSchema.optional().describe('The camera layer for dof; default the live camera at the playhead'),
    dof: Dof.optional().describe('Depth of field of the camera (cameraId, else the live camera)'),
  }),
  run: (input, ctx) => {
    const { toneMapping, exposure, shadows, shadowQuality, mist, bloom, ao, floor, cameraId, dof } = input
    if (cameraId !== undefined && dof === undefined) {
      throw new CommandError('cameraId names the camera for dof, and dof is missing.', 'Pass dof: {enabled, focusDistance, fStop, focusOn} with cameraId.')
    }
    // A camera named without a world means its own world.
    const named = cameraId !== undefined ? locateLayer(ctx.project, cameraId) : null
    const comp = findWorld(ctx.project, input.compId ?? named?.comp.id ?? ctx.view.compId)
    const given = [toneMapping, exposure, shadows, shadowQuality, mist, bloom, ao, floor, dof].some((v) => v !== undefined)
    if (!given) throw new CommandError('Say what to change.', 'Pass toneMapping, exposure, shadows, shadowQuality, mist, bloom, ao, floor or dof.')

    const render = comp.world.render
    const next: World = {
      render: {
        ...render,
        ...(toneMapping !== undefined ? { toneMapping } : {}),
        ...(exposure !== undefined ? { exposure } : {}),
        ...(shadows !== undefined ? { shadows } : {}),
        ...(shadowQuality !== undefined ? { shadowQuality } : {}),
        ...(bloom !== undefined ? { bloom: { ...render.bloom, ...(typeof bloom === 'boolean' ? { enabled: bloom } : { enabled: true, ...bloom }) } } : {}),
        ...(ao !== undefined ? { ao: { ...render.ao, ...(typeof ao === 'boolean' ? { enabled: ao } : { enabled: true, ...ao }) } } : {}),
        ...(floor !== undefined ? { floor: { ...render.floor, ...(typeof floor === 'string' ? { mode: floor } : floor) } } : {}),
      },
      fog: { ...comp.world.fog, ...(mist ?? {}) },
    }
    if (next.fog.end < next.fog.start) {
      throw new CommandError(`The mist ends (${next.fog.end}) before it starts (${next.fog.start}).`, 'end must be at least start.')
    }

    let camera: CameraLayer | undefined
    let nextDof: CameraLayer['camera']['dof'] | undefined
    const keysWin: string[] = []
    if (dof !== undefined) {
      if (named) {
        if (named.comp.id !== comp.id) {
          throw new CommandError(`Camera "${named.layer.name}" is in "${named.comp.name}", not in "${comp.name}".`, 'Pass the camera of this world, or leave compId out.')
        }
        if (named.layer.kind !== 'camera') {
          throw new CommandError(`"${named.layer.name}" is a ${named.layer.kind}, not a camera.`, 'cameraId must be a camera layer; world_inspect lists them.')
        }
        camera = named.layer
      } else {
        const at = ctx.view.compId === comp.id ? (ctx.view.playheadMs ?? 0) : 0
        const live = liveCamera(comp, Math.min(at, comp.durationMs))
        if (!live) throw new CommandError('The world is seen by the default camera, which has no depth of field to set.', DEFAULT_CAMERA_HINT)
        camera = live
      }
      const { focusOn, focusObjectId, ...rest } = dof
      if (focusOn !== undefined && focusObjectId !== undefined && focusOn !== focusObjectId) {
        throw new CommandError('focusOn and focusObjectId name different layers.', 'They are the same field: pass one.')
      }
      const target = focusOn !== undefined ? focusOn : focusObjectId
      let focusId: string | null | undefined
      if (typeof target === 'string') {
        const found = locateLayer(ctx.project, target)
        if (found.comp.id !== comp.id) {
          throw new CommandError(`"${found.layer.name}" is in "${found.comp.name}", not in "${comp.name}".`, 'focusOn must be a layer of the same world as the camera.')
        }
        if (found.layer.id === camera.id) {
          throw new CommandError('The camera cannot focus on itself.', 'Name the layer to keep sharp.')
        }
        focusId = found.layer.id
      } else if (target === null) {
        focusId = null
      }
      if (Object.keys(rest).length === 0 && focusId === undefined) {
        throw new CommandError('dof has nothing to change.', 'Pass enabled, focusDistance, fStop or focusOn.')
      }
      nextDof = { ...camera.camera.dof, enabled: true, ...rest, ...(focusId !== undefined ? { focusObjectId: focusId } : {}) }
      for (const [field, path] of [['focusDistance', 'camera.dof.focusDistance'], ['fStop', 'camera.dof.fStop']] as const) {
        if (rest[field] !== undefined && (camera.animations[path]?.length ?? 0) > 0) keysWin.push(field)
      }
    }

    const cameraLayer = camera
    ctx.write('Change world look', (draft) => {
      const target = draft.comps.find((c) => c.id === comp.id)
      if (target?.world) {
        target.world.render = next.render
        target.world.fog = next.fog
      }
      if (cameraLayer && nextDof) {
        const found = locateLayer(draft, cameraLayer.id).layer
        if (found.kind === 'camera') found.camera.dof = nextDof
      }
    })
    return {
      frameId: comp.id,
      toneMapping: next.render.toneMapping,
      exposure: next.render.exposure,
      shadows: next.render.shadows,
      shadowQuality: next.render.shadowQuality,
      mist: next.fog,
      bloom: next.render.bloom,
      ao: next.render.ao,
      floor: next.render.floor,
      ...(cameraLayer ? { cameraId: cameraLayer.id, dof: nextDof } : {}),
      ...(keysWin.length > 0 ? { note: `${keysWin.join(' and ')} ${keysWin.length > 1 ? 'are' : 'is'} keyed on this camera, so the keys win over the value written. keyframes_clear removes them.` } : {}),
    }
  },
})

