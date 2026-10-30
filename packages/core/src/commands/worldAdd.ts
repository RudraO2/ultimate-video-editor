import { z } from 'zod'
import { findComp, layerEnd, locateLayer } from '../doc'
import { CommandError } from '../errors'
import { defineCommand } from '../registry'
import { ColorSchema, IdSchema, LIGHT_TYPES, type LayerKind, type LightType } from '../schema'
import { LIGHT_INTENSITY } from '../lights'
import { findModelAsset, MESH_DEFAULT_COLOR, modelName } from '../meshes'
import { MATERIAL_PRESET_IDS } from '../materials'
import { PRIMITIVE_IDS } from '../primitives'
import { defaultCameraPose, liveCamera, lookAtRotation, type Vec3, worldObjects } from '../world'
import { findWorld } from './world'

// Adding cameras, lights, controllers and text to a 3D world, and choosing
// which camera is live. Both go through layer.create, so a call is one undo
// step and the layers are exactly the ones layer.create makes.

const vec3 = z.tuple([z.number(), z.number(), z.number()])


const LIGHT_NAME: Record<LightType, string> = {
  point: 'Point light',
  sun: 'Sun',
  spot: 'Spot light',
  area: 'Area light',
  environment: 'Environment',
  hemisphere: 'Hemisphere light',
}

const WORLD_KINDS = ['camera', 'light', 'controller', 'text', 'mesh', 'head'] as const

/** A layer's position in the world at a time, for aiming at it. */
function positionOf(comp: Parameters<typeof worldObjects>[0], id: string, timeMs: number): Vec3 {
  const found = worldObjects(comp, timeMs).find((o) => o.layer.id === id)
  if (!found) {
    throw new CommandError(
      `lookAt: "${id}" is not on the timeline at ${timeMs} ms, so there is nothing to aim at.`,
      'Pass lookAt as a point [x, y, z], or start the new layer while its target is there.',
    )
  }
  return found.position
}

export const worldAdd = defineCommand({
  name: 'world.add',
  summary: 'Add a camera, light, controller, text or mesh to a 3D world at a position, optionally aimed at a point or another layer.',
  details:
    'Positions are world px: Z up, X right, Y away from the front view. rotation is [x, y, z] degrees (applied z, then y, then x); lookAt aims the object at a point or at a layer\'s position (a camera or light aims its -Z, text faces it) and gives way to rotation when both are given. A camera with neither rotation nor lookAt gets [90, 0, 0], which looks along +Y like the default camera. light picks the type (point, sun, spot, area, environment, hemisphere); intensity defaults to point 1000, spot 1500, area 800, sun 3, environment 1, hemisphere 0.6. color tints a light or colours the text. A controller (kind "controller") is an empty point that nothing renders: aim cameras at it or move it to move whatever follows. text makes a picture plane with that text. A mesh is a solid: primitive (' + PRIMITIVE_IDS.join(', ') + ', default cube) with its params (catalog.get primitives <id> lists them; the rest take their defaults), color (default #c9cbd1) and material (a preset name such as glass or chrome, or a values object as in world.material); its scale is [x, y, z] in world axes. With no startMs and no durationMs the object spans the whole frame. The object gets a new lane at the front, so a new camera is the live one over its span (world.camera chooses). A 3D model file works as a mesh too: assetId (a media asset of kind model; world_import_model adds the file and calls this) makes a mesh that shows the model, named after the file, playing its first animation clip in a loop when the file has clips; primitive and params do not apply, and color only matters once the material is custom. Heads are not in this build. Returns the new layer\'s id.',
  effect: 'write',
  input: z.strictObject({
    compId: IdSchema.optional().describe('The world; default the frame open in the editor (AtomCut: frameId)'),
    kind: z.enum(WORLD_KINDS),
    light: z.enum(LIGHT_TYPES).default('point').describe('Light type, when kind is light'),
    position: vec3.default([0, 0, 0]),
    rotation: vec3.optional().describe('[x, y, z] degrees'),
    scale: z.union([z.number(), vec3]).optional().describe('One value, or [x, y, z] in world axes'),
    lookAt: z.union([vec3, IdSchema]).optional().describe('A point [x, y, z] or a layer id to aim at'),
    color: ColorSchema.optional().describe('A light colour, the text colour, or the colour of a mesh'),
    intensity: z.number().min(0).optional().describe('A light strength (see the defaults above)'),
    focalLength: z.number().min(1).max(5000).optional().describe('A camera lens, mm (default 50)'),
    text: z.string().optional().describe('The words of a text plane'),
    name: z.string().min(1).optional(),
    startMs: z.number().min(0).optional(),
    durationMs: z.number().positive().optional(),
    primitive: z.string().optional().describe('Meshes only: ' + PRIMITIVE_IDS.join(', ') + ' (default cube)'),
    params: z.record(z.string(), z.unknown()).optional().describe("Meshes only: the primitive's params by key, e.g. {radius: 120}; the rest take their defaults"),
    assetId: IdSchema.optional().describe('Meshes only: a 3D model in the project media (kind model) instead of a primitive'),
    material: z.union([z.string(), z.record(z.string(), z.unknown())]).optional().describe('Meshes only: a material preset (' + MATERIAL_PRESET_IDS.join(', ') + ') or a values object as in world.material'),
  }),
  run: async (input, ctx) => {
    const comp = findWorld(ctx.project, input.compId ?? ctx.view.compId)
    if (input.kind !== 'mesh' && (input.primitive !== undefined || input.params !== undefined || input.material !== undefined || input.assetId !== undefined)) {
      throw new CommandError('primitive, params, assetId and material only apply to meshes.', 'Pass kind "mesh", or give a light, text or camera its own fields.')
    }
    if (input.assetId !== undefined && (input.primitive !== undefined || input.params !== undefined)) {
      throw new CommandError('A mesh is a primitive or a model, not both.', 'Give primitive and params, or assetId.')
    }
    const model = input.assetId === undefined ? undefined : findModelAsset(ctx.project, input.assetId)
    if (input.kind === 'head') throw new CommandError('Heads are not in this build.', 'Talking heads come in a later phase.')

    const startMs = comp.mode === 'static' ? 0 : (input.startMs ?? 0)
    if (startMs >= comp.durationMs) {
      throw new CommandError(`startMs ${startMs} is past the end of "${comp.name}" (${comp.durationMs} ms).`, 'Start inside the frame.')
    }
    const layerKind: LayerKind = input.kind === 'controller' ? 'empty' : input.kind

    // The turns: given, else aimed, else the kind's own default.
    const target = typeof input.lookAt === 'string' ? positionOf(comp, input.lookAt, startMs) : input.lookAt
    let turns: Vec3 | undefined = input.rotation
    if (!turns && target) {
      const aimed = lookAtRotation(input.position, target, layerKind)
      turns = [aimed.rotationX, aimed.rotationY, aimed.rotation]
    }
    turns ??= input.kind === 'camera' ? [90, 0, 0] : [0, 0, 0]

    // A picture plane reads its world scales as (scaleX, scaleZ, scaleY): its height is world Z.
    const [sx, sy, sz] = typeof input.scale === 'number' ? [input.scale, input.scale, input.scale] : (input.scale ?? [1, 1, 1])
    const scales = layerKind === 'text' ? { scaleX: sx, scaleY: sz, scaleZ: sy } : { scaleX: sx, scaleY: sy, scaleZ: sz }
    const [x, y, z] = input.position
    const transform = { x, y, z, rotationX: turns[0], rotationY: turns[1], rotation: turns[2], ...scales }

    const made: Record<string, unknown> = { compId: comp.id, kind: layerKind, startMs, transform }
    if (input.durationMs !== undefined) made.durationMs = input.durationMs
    if (input.kind === 'camera') {
      made.name = input.name ?? 'Camera'
      if (input.focalLength !== undefined) made.camera = { focalLength: input.focalLength }
    } else if (input.kind === 'light') {
      made.name = input.name ?? LIGHT_NAME[input.light]
      made.light = { type: input.light, intensity: input.intensity ?? LIGHT_INTENSITY[input.light], ...(input.color !== undefined ? { color: input.color } : {}) }
    } else if (input.kind === 'controller') {
      made.name = input.name ?? 'Controller'
    } else if (input.kind === 'mesh') {
      if (input.name !== undefined || model) made.name = input.name ?? (model ? modelName(model) : undefined)
      made.mesh = model
        ? { assetId: model.id }
        : { ...(input.primitive !== undefined ? { primitive: input.primitive } : {}), ...(input.params !== undefined ? { params: input.params } : {}) }
      if (!model || input.color !== undefined) made.fill = input.color ?? MESH_DEFAULT_COLOR
    } else {
      if (input.name !== undefined) made.name = input.name
      made.text = input.text ?? 'Text'
      if (input.color !== undefined) made.style = { color: input.color }
    }

    const created = await ctx.call('layer.create', made)
    if (!created.ok) throw new CommandError(created.error, created.hint)
    const { id, trackId } = created.value as { id: string; trackId: string }
    if (input.material !== undefined) {
      const { preset, ...values } = typeof input.material === 'string' ? { preset: input.material } : input.material
      const given = await ctx.call('world.material', { ids: [id], ...(preset !== undefined ? { preset } : {}), ...(Object.keys(values).length > 0 ? { values } : {}) })
      if (!given.ok) throw new CommandError(given.error, given.hint)
    }

    // A new camera sits in front of the others: say so when it covers one of them.
    const added = findComp(ctx.project, comp.id).tracks.flatMap((t) => t.layers).find((l) => l.id === id)
    const covered =
      input.kind === 'camera' &&
      added &&
      comp.tracks.some((t) => t.layers.some((l) => l.kind === 'camera' && l.startMs < layerEnd(added) && added.startMs < layerEnd(l)))
    return {
      id,
      trackId,
      ...(covered ? { note: 'This camera is in front of another one over part of its span, so it is the live camera there. world.camera {activate} switches back.' } : {}),
    }
  },
})

export const worldCamera = defineCommand({
  name: 'world.camera',
  summary: 'See which camera is live in a 3D world, switch to another, or add a camera that matches the default view.',
  details:
    'The live camera at a time is the topmost visible camera layer that covers it (front lane first; a hidden lane or a disabled layer is skipped); with none, the default front camera shows the world. Without activate or fromDefault this only reports. activate (a camera layer id) turns that camera on, un-hides its lane and moves it in front of the live camera so it becomes live at atMs; it must be on the timeline at atMs. fromDefault adds a camera at the default front camera\'s pose over the whole frame, behind every other camera, so the picture does not change: a starting point to move. atMs defaults to the playhead when the frame is open, else 0. Returns cameraId (the camera acted on), activeAt and active (the live camera\'s id, or "default").',
  effect: 'write',
  input: z.strictObject({
    compId: IdSchema.optional().describe('The world; default the frame open in the editor (AtomCut: frameId)'),
    activate: IdSchema.optional().describe('A camera layer to make live'),
    atMs: z.number().min(0).optional().describe('Comp time to look at; default the playhead, else 0'),
    fromDefault: z.boolean().optional().describe('Add a camera at the default front pose, behind the other cameras'),
  }),
  run: async (input, ctx) => {
    const comp = findWorld(ctx.project, input.compId ?? ctx.view.compId)
    if (input.activate !== undefined && input.fromDefault) throw new CommandError('Give activate or fromDefault, not both.')
    const atMs = Math.min(input.atMs ?? (ctx.view.compId === comp.id ? (ctx.view.playheadMs ?? 0) : 0), comp.durationMs)
    const report = (cameraId?: string) => {
      const live = liveCamera(findComp(ctx.project, comp.id), atMs)
      return { ...(cameraId !== undefined ? { cameraId } : {}), activeAt: atMs, active: live?.id ?? 'default' }
    }
    const restack = async (id: string, to: { above: string } | { below: string }) => {
      const moved = await ctx.call('layers.restack', { ids: [id], to })
      if (!moved.ok) throw new CommandError(moved.error, moved.hint)
    }

    if (input.activate !== undefined) {
      const found = locateLayer(ctx.project, input.activate)
      const camera = found.layer
      if (found.comp.id !== comp.id) throw new CommandError(`"${camera.name}" is in another comp.`, 'world.inspect lists the cameras of this world.')
      if (camera.kind !== 'camera') throw new CommandError(`"${camera.name}" is a ${camera.kind} layer, not a camera.`, 'world.inspect lists the objects of this world.')
      if (atMs < camera.startMs || atMs >= layerEnd(camera)) {
        throw new CommandError(
          `"${camera.name}" is not on the timeline at ${atMs} ms (it spans ${camera.startMs}–${layerEnd(camera)} ms).`,
          'Pass atMs inside its span, or move or trim it with timeline_move and timeline_trim.',
        )
      }
      const live = liveCamera(comp, atMs)
      if (live?.id === camera.id) return { ...report(camera.id), note: 'It is already the live camera.' }
      if (!camera.enabled || found.track.hidden) {
        ctx.write('Show camera', (draft) => {
          const at = locateLayer(draft, camera.id)
          at.layer.enabled = true
          at.track.hidden = false
        })
      }
      const laneOf = (id: string) => comp.tracks.findIndex((t) => t.layers.some((l) => l.id === id))
      if (live && laneOf(camera.id) > laneOf(live.id)) await restack(camera.id, { above: live.id })
      return report(camera.id)
    }

    if (input.fromDefault) {
      const pose = defaultCameraPose(comp.width, comp.height)
      const [x, y, z] = pose.position
      const created = await ctx.call('layer.create', {
        compId: comp.id,
        kind: 'camera',
        name: 'Default camera',
        startMs: 0,
        transform: { x, y, z, rotationX: pose.rotationX, rotationY: pose.rotationY, rotation: pose.rotation },
      })
      if (!created.ok) throw new CommandError(created.error, created.hint)
      const { id } = created.value as { id: string }
      // Behind the lowest lane that holds a camera, so any camera already there still wins.
      const lowest = [...comp.tracks].reverse().flatMap((t) => t.layers).find((l) => l.kind === 'camera')
      if (lowest) await restack(id, { below: lowest.id })
      return report(id)
    }

    return report()
  },
})
