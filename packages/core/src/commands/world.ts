import { z } from 'zod'
import { findComp, newTrack } from '../doc'
import { CommandError, parseOrThrow } from '../errors'
import { defineCommand } from '../registry'
import { type Comp, CompSchema, type Layer, LayerSchema, type Project } from '../schema'
import {
  cameraFov,
  decomposeXYZ,
  defaultCameraPose,
  isWorld,
  liveCamera,
  lookAtRotation,
  mat4Compose,
  mat4Invert,
  mat4Translate,
  PICTURE_AXES,
  type Vec3,
  type WorldMat4,
  type WorldObject,
  worldObjects,
} from '../world'
import { evaluateProperty, propertiesOf } from '../properties'
import { MESH_DEFAULT_COLOR, meshSolidSize } from '../meshes'
import { toPaint } from '../paint'
import { pageFor } from './frame'

// 3D worlds: comps with `world`, where 2D layers stand as picture planes and
// cameras, lights and controllers live. Space is Z up, X right, Y away from
// the front view, 1 unit = 1 px. The renderer comes in A7d.

const size = z.number().int().min(16).max(8192)

/** The background of a new world: AtomCut's dark grey, or clear. */
const WORLD_BACKGROUND = '#16171b'
const CLEAR = '#00000000'

/** The starter scene's objects (AtomCut's): a camera aimed at the origin, a point light, a dim studio environment and a cube at the origin. */
const STARTER_CAMERA: Vec3 = [736, -693, 496]
const STARTER_LIGHT: Vec3 = [408, 100, 590]

/** A comp that must be a world, with AtomCut's refusal for a flat one. */
export function findWorld(project: Project, ref: string | undefined): Comp & { world: NonNullable<Comp['world']> } {
  const comp = findComp(project, ref)
  if (!isWorld(comp)) {
    throw new CommandError(`"${comp.name}" is a flat comp, not a 3D world.`, 'Make one with world_create, or pass the frameId of a world.')
  }
  return comp
}

const UNSWAP = mat4Invert(PICTURE_AXES) as WorldMat4

/**
 * Where an object stands, as its own fields read: the pivot's world position,
 * its turns and its world scale. A picture's matrix ends with the axis swap
 * and the pivot offset; those are taken off before decomposing.
 */
function standing(o: WorldObject, box: { width: number; height: number } | null) {
  if (o.kind === 'camera' || o.kind === 'light' || o.kind === 'empty' || o.kind === 'mesh' || o.kind === 'group') return decomposeXYZ(o.matrix)
  const px = box ? (o.transform.anchorX - 0.5) * box.width : 0
  const py = box ? (o.transform.anchorY - 0.5) * box.height : 0
  return decomposeXYZ(mat4Compose(o.matrix, mat4Translate(px, py, 0), UNSWAP))
}

const round1 = (v: number) => Math.round(v * 10) / 10
const round3 = (v: Vec3 | readonly number[]) => v.map(round1)

export const worldCreate = defineCommand({
  name: 'world.create',
  summary: 'Create a 3D world: a frame where layers have depth, seen through cameras and lit by lights.',
  details:
    'A world is a frame (comp) with 3D space: Z is up, X right, Y away from the front view, and 1 unit is 1 px. starter (default true) adds a camera at [736, -693, 496] aimed at the origin, a point light at [408, 100, 590] (1500 W), a "Studio" environment light at 0.3 and a grey 200 px cube at the origin, each spanning the frame. transparent clears the background so the world can sit over 2D layers when nested. With no camera on the timeline the world is seen by the default front camera, which shows depth 0 exactly as a flat frame would. Returns frameId and the starter objects.',
  effect: 'write',
  input: z.strictObject({
    name: z.string().min(1).optional(),
    width: size.default(1920),
    height: size.default(1080),
    fps: z.number().min(1).max(240).default(30),
    durationMs: z.number().positive().default(10_000),
    starter: z.boolean().default(true).describe('Add a camera, lights and a cube to start from'),
    transparent: z.boolean().default(false).describe('A clear background instead of dark grey'),
    pageId: z.string().min(1).optional().describe('A page id or name; default the page of the frame in view'),
  }),
  run: (input, ctx) => {
    const page = pageFor(ctx.project, input.pageId, ctx.view.compId)
    const worlds = ctx.project.comps.filter((c) => c.world !== undefined && !c.embedded).length
    const objects: Layer[] = []
    if (input.starter) {
      const span = { startMs: 0, durationMs: input.durationMs }
      const aim = lookAtRotation(STARTER_CAMERA, [0, 0, 0], 'camera')
      const [cx, cy, cz] = STARTER_CAMERA
      const [lx, ly, lz] = STARTER_LIGHT
      const made: unknown[] = [
        { kind: 'camera', name: 'Camera', transform: { x: cx, y: cy, z: cz, ...aim } },
        { kind: 'light', name: 'Point light', transform: { x: lx, y: ly, z: lz }, light: { type: 'point', intensity: 1500 } },
        { kind: 'light', name: 'Studio', light: { type: 'environment', environment: 'studio', intensity: 0.3 } },
        { kind: 'mesh', name: 'Cube', geometry: { type: 'primitive', primitive: 'cube', params: {} }, fills: [toPaint(MESH_DEFAULT_COLOR, ctx.ids)] },
      ]
      for (const raw of made) objects.push(parseOrThrow(LayerSchema, { id: ctx.ids('layer'), ...span, ...(raw as object) }, 'The starter object'))
    }
    const comp = parseOrThrow(
      CompSchema,
      {
        id: ctx.ids('comp'),
        name: input.name ?? '3D world ' + (worlds + 1),
        width: input.width,
        height: input.height,
        fps: input.fps,
        durationMs: input.durationMs,
        background: input.transparent ? CLEAR : WORLD_BACKGROUND,
        pageId: page.id,
        tracks: objects.map((layer) => newTrack(ctx.ids('track'), [layer])),
        world: {},
      },
      'The world',
    )
    ctx.write('Create 3D world', (draft) => {
      draft.comps.push(comp)
    })
    return {
      frameId: comp.id,
      pageId: page.id,
      objects: objects.map((l) => ({ id: l.id, name: l.name, kind: l.kind })),
    }
  },
})

/** A camera's focal length at a comp time: keyed values sampled. */
function focalAt(camera: Layer & { kind: 'camera' }, atMs: number): number {
  const spec = propertiesOf(camera).find((p) => p.path === 'camera.focalLength')
  const value = spec ? evaluateProperty(camera, spec, atMs - camera.startMs) : undefined
  return typeof value === 'number' && Number.isFinite(value) ? value : camera.camera.focalLength
}

/** A picture plane's size before its scale, where the core can tell without measuring; null otherwise. */
function pictureSize(project: Project, layer: Layer): [number, number] | null {
  switch (layer.kind) {
    case 'shape':
      return [layer.shape.width, layer.shape.height]
    case 'image':
    case 'video': {
      const media = project.media.find((m) => m.id === layer.mediaId)
      return media?.width && media.height ? [media.width, media.height] : null
    }
    case 'nested': {
      const source = project.comps.find((c) => c.id === layer.sourceCompId)
      return source ? [source.width, source.height] : null
    }
    default:
      return null
  }
}

export const worldInspect = defineCommand({
  name: 'world.inspect',
  summary: "Read a 3D world at a moment: its output size, the live camera, the environment and every object's world position, rotation and size.",
  details:
    'Positions are world px (Z up, Y away from the front view); rotations are [x, y, z] degrees applied z, then y, then x; values are rounded to 0.1. A mesh size is [x, y, z]: its primitive box times its scales; a picture plane size is [width, height]. The live camera is the topmost visible camera layer at atMs (front lane first); with none, "default" is the front camera that shows depth 0 exactly as a flat frame. 2D layers are listed as "plane (<kind>)". look is the bloom, ao and floor of the world; a live camera layer also lists its dof. Objects with constraints (world.track) show them, already applied to the pose. Read it before rendering to check the camera sees what it should.',
  effect: 'read',
  input: z.strictObject({
    compId: z.string().min(1).optional().describe('Default the frame open in the editor (AtomCut: frameId)'),
    atMs: z.number().min(0).optional().describe('Comp time; default the playhead when the frame is open, else 0'),
  }),
  run: (input, ctx) => {
    const comp = findWorld(ctx.project, input.compId ?? ctx.view.compId)
    const atMs = Math.min(input.atMs ?? (ctx.view.compId === comp.id ? (ctx.view.playheadMs ?? 0) : 0), comp.durationMs)
    const placed = ctx.measure?.(comp, atMs)
    const box = (layer: Layer) => {
      const known = pictureSize(ctx.project, layer)
      if (known) return { width: known[0], height: known[1] }
      const p = placed?.get(layer.id)
      return p?.width !== undefined && p.height !== undefined ? { width: p.width, height: p.height } : null
    }
    const listed = worldObjects(comp, atMs, { box })
    const live = liveCamera(comp, atMs)
    let camera: { id: string; name?: string; position: number[]; rotation: number[]; fovY: number; dof?: { enabled: boolean; focusDistance: number; fStop: number; focusObjectId: string | null } }
    if (live) {
      const entry = listed.find((o) => o.layer.id === live.id)
      const pose = entry ? decomposeXYZ(entry.matrix) : null
      const at = pose?.position ?? [live.transform.x, live.transform.y, live.transform.z]
      const turn = pose?.rotation ?? live.transform
      camera = {
        id: live.id,
        name: live.name,
        position: round3(at),
        rotation: round3([turn.rotationX, turn.rotationY, turn.rotation]),
        fovY: round1(cameraFov({ ...live.camera, focalLength: focalAt(live, atMs) }, comp.width, comp.height).fovY),
        dof: { ...live.camera.dof },
      }
    } else {
      const pose = defaultCameraPose(comp.width, comp.height)
      camera = {
        id: 'default',
        position: round3(pose.position),
        rotation: [pose.rotationX, pose.rotationY, pose.rotation],
        fovY: round1(cameraFov({ focalLength: 50, sensorWidth: 36 }, comp.width, comp.height).fovY),
      }
    }
    const environment = listed.find((o) => o.layer.kind === 'light' && o.layer.light.type === 'environment')?.layer
    return {
      frameId: comp.id,
      output: [comp.width, comp.height],
      camera,
      look: { bloom: comp.world.render.bloom, ao: comp.world.render.ao, floor: comp.world.render.floor },
      environment:
        environment?.kind === 'light'
          ? { id: environment.id, preset: environment.light.environment, intensity: environment.light.intensity, showBackground: environment.light.showBackground }
          : null,
      objects: listed
        .filter((o) => o.layer.kind !== 'group')
        .map((o) => {
          const { layer } = o
          const active = (layer.constraints ?? []).filter((c) => c.enabled && c.targetId !== null)
          const spatial = layer.kind === 'camera' || layer.kind === 'light' || layer.kind === 'empty' || layer.kind === 'mesh'
          const picture = spatial ? null : box(layer)
          const pose = standing(o, picture)
          const [sx, sy, sz] = pose.scale
          const assetId = layer.kind === 'mesh' && layer.geometry.type === 'asset' ? layer.geometry.assetId : null
          const file = assetId ? { assetId, clips: ctx.project.media.find((m) => m.id === assetId)?.model?.clips.map((c) => c.name) ?? [], clip: layer.kind === 'mesh' ? (layer.animation?.clip ?? null) : null } : null
          const solid = layer.kind === 'mesh' ? meshSolidSize(layer, atMs - layer.startMs, ctx.project) : null
          return {
            id: layer.id,
            name: layer.name,
            kind: spatial ? layer.kind : `plane (${layer.kind})`,
            position: round3(pose.position),
            rotation: round3([pose.rotation.rotationX, pose.rotation.rotationY, pose.rotation.rotation]),
            size: solid ? [round1(solid[0] * sx), round1(solid[1] * sy), round1(solid[2] * sz)] : picture ? [round1(picture.width * sx), round1(picture.height * sz)] : null,
            opacity: Math.round(o.opacity * 100) / 100,
            ...(file ? { model: file } : {}),
            ...(active.length > 0 ? { constraints: active.map((c) => ({ id: c.id, type: c.type, target: c.targetId, influence: c.influence })) } : {}),
          }
        }),
      liveCameraAtMs: atMs,
    }
  },
})

