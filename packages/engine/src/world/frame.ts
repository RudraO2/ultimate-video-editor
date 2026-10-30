import {
  buildScene,
  type Rect,
  type SceneNode,
  type SceneSource,
} from '../scene'
import {
  type CameraSpec,
  CameraSchema,
  type Comp,
  defaultCamera,
  evaluateProperty,
  flatEquivalent,
  isSpatialKind,
  type Layer,
  liveCamera,
  type MaterialSpec,
  materialAt,
  type MeshGeometry,
  meshColor,
  meshGeometryAt,
  type ModelClipTime,
  modelClipAt,
  type ModelFormat,
  mat4Invert,
  mat4Multiply,
  mat4TransformPoint,
  PICTURE_AXES,
  projectWorldPoint,
  propertiesOf,
  TransformSchema,
  transformAt,
  WorldFogSchema,
  WorldRenderSchema,
  type WorldMat4,
  type WorldObject,
  type World,
  worldObjects,
} from '@uve/core'
import { resolveLayer } from '../evaluate'
import { modelFormatOf } from '../models'
import { multiply, translate } from '../math'
import { cameraDofAt, type FrameDof } from './dof'
import type { LightSample } from './lighting'

// A 3D world at one moment, as flat pictures standing in space. The key idea:
// a picture plane is exactly what the flat renderer would draw for the layer
// whose flat transform is `flatEquivalent(world transform)`, moved to its place
// by P·(...). So the world is turned into a *proxy flat comp* (every picture
// given its flat equivalent, groups made identity and applied as world
// parents, cameras, lights and empties dropped), the flat scene builder makes
// each picture's node (poses, blur, effects and content are all resolved in
// flat space, so nothing is converted), and the plane's world matrix is
// groups · P · node.matrix. With the default camera that is the flat picture.
//
// Not applied in worlds yet: a group's own effects, blend mode, clip and
// cutting modes (groups only move, turn and fade their members), wipes, veils
// and tears of transitions. A world nested in a world draws nothing (phase E).
// Motion blur is done by drawing the frame at several moments of the shutter
// (worldBlur.ts), each a full frame built here.

const IDENTITY_TRANSFORM = TransformSchema.parse({})

/** The part of a camera the renderer reads. */
export type FrameLens = Pick<CameraSpec, 'projection' | 'focalLength' | 'sensorWidth' | 'orthoScale' | 'shiftX' | 'shiftY' | 'clipStart' | 'clipEnd'>

export interface FrameCamera {
  /** The camera layer's id, or "default". */
  id: string
  /** Camera space to world, units px. */
  matrix: WorldMat4
  lens: FrameLens
  /** The camera layer's depth of field when it is on; the default camera has none. */
  dof?: FrameDof
  /** The camera layer's own motion blur settings (the live camera's shutter), undefined for the default camera. */
  motionBlur?: Layer['motionBlur']
}

/** A picture standing in the world. */
export interface WorldPlane {
  id: string
  /** The layer as the document holds it: its identity keys the texture cache. */
  layer: Layer
  /** The picture as the flat renderer builds it from the proxy comp: a leaf, or a nested comp drawn as a whole. */
  node: SceneNode
  /** The picture's local space (origin at its box centre, x right, y down, px) to world. */
  matrix: WorldMat4
  /** The picture's own opacity (poses included) times its groups'. */
  opacity: number
  /** Back to front, 0 is the back. */
  order: number
  locked: boolean
  /** The picture's box in its local space. */
  local: Rect
  /** Whether what is drawn changes with time (so the texture is redrawn as time moves). */
  timeVarying: boolean
  /** The layer's material at this moment (keyed fields sampled); undefined is an unlit picture. */
  material: MaterialSpec | undefined
}

/** A mesh standing in the world. */
export interface WorldMesh {
  id: string
  layer: Layer & { kind: 'mesh' }
  /** Local space (Z up, px) to world. */
  matrix: WorldMat4
  /** The mesh's own opacity (entrance and exit poses included) times its groups'. */
  opacity: number
  /** Back to front, 0 is the back. */
  order: number
  /** The primitive with its params sampled at this moment, or the model asset, and how it is shaded. */
  geometry: MeshGeometry
  /** The model file a mesh of an imported model shows, and where its clip stands; undefined for a primitive, or a model whose asset is gone. */
  model?: { path: string; format: ModelFormat; clip: ModelClipTime | null }
  /** The first enabled solid fill at this moment (hex), else the default grey. */
  color: string
  /** The layer's material at this moment; undefined takes the default (plain PBR). */
  material: MaterialSpec | undefined
  castShadow: boolean
  receiveShadow: boolean
}

/** A light standing in the world. */
export interface FrameLight {
  id: string
  /** The light's settings at this moment (keyed intensity and colour sampled). */
  light: LightSample
  /** Local space to world, px (its scale is ignored by the renderer). */
  matrix: WorldMat4
}

export interface WorldFrame {
  comp: Comp
  proxy: Comp
  /** The proxy comp's scene (flat equivalents), back to front. */
  scene: SceneNode[]
  camera: FrameCamera
  planes: WorldPlane[]
  /** Meshes, front lane first (`order` says the stacking). */
  meshes: WorldMesh[]
  /** Lights, front lane first (the first environment light is the one that counts). */
  lights: FrameLight[]
  render: World['render']
  fog: World['fog']
  /** The sources the pictures were built from, for cache keys. */
  media: SceneSource['media']
  comps: SceneSource['comps']
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** The nested layers of a comp whose source is a world are left out of a world's pictures. */
function showsWorld(layer: Layer, comps: readonly Comp[] | undefined): boolean {
  return layer.kind === 'nested' && comps?.find((c) => c.id === layer.sourceCompId)?.world !== undefined
}

const withoutTransformKeys = (layer: Layer): Layer['animations'] =>
  Object.fromEntries(Object.entries(layer.animations).filter(([path]) => !path.startsWith('transform.')))

/**
 * The proxy flat comp of a world at a time (comp time): pictures carry
 * `flatEquivalent` of their sampled world transform, with no transform keys;
 * groups are identity (their sampled matrices are applied as parents by the
 * caller); cameras, lights, empties and nested worlds are gone.
 */
export function proxyComp(comp: Comp, timeMs: number, comps?: readonly Comp[]): Comp {
  const { world: _world, ...rest } = comp
  const tracks = comp.tracks.map((track) => ({
    ...track,
    layers: track.layers.flatMap((layer): Layer[] => {
      if (isSpatialKind(layer.kind) || showsWorld(layer, comps)) return []
      if (layer.kind === 'audio') return [layer]
      const animations = withoutTransformKeys(layer)
      if (layer.kind === 'group') return [{ ...layer, transform: { ...IDENTITY_TRANSFORM }, animations }]
      // Transition windows hold a layer at its first or last moment.
      const own = transformAt(layer, clamp(timeMs - layer.startMs, 0, layer.durationMs))
      return [{ ...layer, transform: flatEquivalent(own), animations }]
    }),
  }))
  return { ...rest, tracks } as Comp
}

function lensOf(layer: Layer & { kind: 'camera' }, layerTimeMs: number): FrameLens {
  const spec = propertiesOf(layer).find((s) => s.path === 'camera.focalLength')
  const sampled = spec ? evaluateProperty(layer, spec, layerTimeMs) : undefined
  const { projection, sensorWidth, orthoScale, shiftX, shiftY, clipStart, clipEnd } = layer.camera
  const focalLength = typeof sampled === 'number' && Number.isFinite(sampled) ? clamp(sampled, 1, 5000) : layer.camera.focalLength
  return { projection, focalLength, sensorWidth, orthoScale, shiftX, shiftY, clipStart, clipEnd }
}

/** The camera a world shows at a comp time: the live camera layer with its keyed lens, or the default camera. */
export function frameCamera(comp: Comp, timeMs: number, objects: readonly WorldObject[]): FrameCamera {
  const live = liveCamera(comp, timeMs)
  const object = live ? objects.find((o) => o.layer.id === live.id) : undefined
  if (live && object) {
    const layerTime = timeMs - live.startMs
    const dof = cameraDofAt(live, layerTime, object.matrix, objects)
    return { id: live.id, matrix: object.matrix, lens: lensOf(live, layerTime), ...(dof ? { dof } : {}), motionBlur: live.motionBlur }
  }
  const base = defaultCamera(comp.width, comp.height)
  return { id: 'default', matrix: base.matrix, lens: { ...CameraSchema.parse({}), ...base.spec } }
}

/** A picture's box in its own space: a leaf's is centred, a nested comp's is its source's. */
export function localBox(node: SceneNode): Rect {
  if (node.kind === 'leaf') {
    const { width, height } = node.content.box
    return { left: -width / 2, top: -height / 2, width, height }
  }
  return { ...node.box }
}

/** Whether a picture's pixels can change from one moment to the next, beyond where it stands. */
function changesWithTime(node: SceneNode, original: Layer): boolean {
  const r = node.resolved
  if (original.kind === 'video' || original.kind === 'image' || original.kind === 'nested') return true
  if (r.blur || r.effects || r.glyphs || r.drawOn || r.captionPill) return true
  if ('caption' in original && original.caption) return true
  return Object.keys(original.animations).some((path) => !path.startsWith('transform.') && !path.startsWith('material.'))
}

/** A light layer at a layer time: its settings with keyed intensity and colour sampled. */
function lightAt(layer: Layer & { kind: 'light' }, layerTimeMs: number): LightSample {
  const specs = propertiesOf(layer)
  const sampled = (path: string) => {
    const spec = specs.find((p) => p.path === path)
    return spec ? evaluateProperty(layer, spec, layerTimeMs) : undefined
  }
  const intensity = sampled('light.intensity')
  const color = sampled('light.color')
  return {
    ...layer.light,
    intensity: typeof intensity === 'number' && Number.isFinite(intensity) ? Math.max(0, intensity) : layer.light.intensity,
    color: typeof color === 'string' ? color : layer.light.color,
  }
}

/** An object's matrix before constraints moved it (`final = correction · unconstrained`). */
function unconstrained(object: WorldObject): WorldMat4 {
  const inverse = object.correction ? mat4Invert(object.correction) : null
  return inverse ? mat4Multiply(inverse, object.matrix) : object.matrix
}

/** Builds a world at a time: its proxy scene, camera and picture planes. */
export function buildWorldFrame(comp: Comp, source: SceneSource, timeMs: number): WorldFrame {
  const t = comp.mode === 'static' ? Math.min(comp.stillMs, comp.durationMs) : timeMs
  const objects = worldObjects(comp, t)
  const parents = new Map(objects.map((o) => [o.layer.id, o]))
  const originals = new Map(comp.tracks.flatMap((track) => track.layers.map((l) => [l.id, l] as const)))
  const proxy = proxyComp(comp, t, source.comps)
  const scene = buildScene(proxy, source, timeMs)
  const planes: WorldPlane[] = []

  const walk = (nodes: readonly SceneNode[], fade: number): void => {
    for (const node of nodes) {
      if (node.kind === 'group') {
        // A group's pose (an entrance or exit) can still fade its members; its own transform is the world matrix of its object.
        walk(node.children, fade * node.resolved.transform.opacity)
        continue
      }
      if (node.stencil) continue
      const original = originals.get(node.layer.id)
      if (!original) continue
      const parent = node.track.groupId ? parents.get(node.track.groupId) : undefined
      const flatToWorld = mat4Multiply(PICTURE_AXES, node.matrix)
      // Constraints move a picture by its own correction, which already holds any constrained group's.
      const above = parent ? unconstrained(parent) : null
      const base = above ? mat4Multiply(above, flatToWorld) : flatToWorld
      const correction = parents.get(node.layer.id)?.correction
      planes.push({
        id: node.layer.id,
        layer: original,
        node,
        matrix: correction ? mat4Multiply(correction, base) : base,
        opacity: node.resolved.transform.opacity * (parent?.opacity ?? 1) * fade,
        order: planes.length,
        locked: node.locked,
        local: localBox(node),
        timeVarying: changesWithTime(node, original),
        material: materialAt(original, node.resolved.layerTimeMs),
      })
    }
  }
  walk(scene, 1)
  const lights = objects.flatMap((o): FrameLight[] => (o.layer.kind === 'light' ? [{ id: o.layer.id, light: lightAt(o.layer, t - o.layer.startMs), matrix: o.matrix }] : []))
  const meshObjects = objects.filter((o) => o.layer.kind === 'mesh')
  const meshes = meshObjects.map((o, i): WorldMesh => {
    const layer = o.layer as Layer & { kind: 'mesh' }
    const layerTime = t - layer.startMs
    const resolved = resolveLayer(layer, t)
    const parent = o.parentId ? parents.get(o.parentId) : undefined
    const geometry = meshGeometryAt(layer, layerTime)
    return {
      id: layer.id,
      layer,
      matrix: o.matrix,
      opacity: resolved.transform.opacity * (parent?.opacity ?? 1),
      order: meshObjects.length - 1 - i,
      geometry,
      model: modelOf(layer, geometry, layerTime, source.media),
      color: meshColor({ fills: resolved.fills ?? layer.fills }),
      material: materialAt(layer, layerTime),
      castShadow: layer.castShadow,
      receiveShadow: layer.receiveShadow,
    }
  })
  const world = comp.world ?? { render: WorldRenderSchema.parse({}), fog: WorldFogSchema.parse({}) }
  return { comp, proxy, scene, camera: frameCamera(comp, t, objects), planes, meshes, lights, render: world.render, fog: world.fog, media: source.media, comps: source.comps }
}

/** The file and clip pose of a mesh that shows an imported model. */
function modelOf(layer: Layer & { kind: 'mesh' }, geometry: MeshGeometry, layerTimeMs: number, media: SceneSource['media']): WorldMesh['model'] {
  if (geometry.type !== 'asset') return undefined
  const asset = media.find((m) => m.id === geometry.assetId)
  const format = asset?.model?.format ?? (asset ? modelFormatOf(asset.path) : null)
  if (!asset || !format) return undefined
  return { path: asset.path, format, clip: modelClipAt(layer, asset, layerTimeMs) }
}

/** A world comp's pictures as the flat renderer sees them (flat equivalents), for placements and sizes. */
export function worldScene(comp: Comp, source: SceneSource, timeMs: number): SceneNode[] {
  return buildWorldFrame(comp, source, timeMs).scene
}

// ---------------------------------------------------------------------------
// Where a plane lands
// ---------------------------------------------------------------------------

type Pt = [number, number]

/** A local point of a plane in comp pixels through the frame's camera, or null when it is behind the camera. */
export function projectLocal(frame: WorldFrame, plane: WorldPlane, x: number, y: number): Pt | null {
  const [wx, wy, wz] = mat4TransformPoint(plane.matrix, x, y, 0)
  return projectWorldPoint({ matrix: frame.camera.matrix, spec: frame.camera.lens }, frame.comp.width, frame.comp.height, [wx, wy, wz])
}

/** A plane's four box corners in comp pixels (top-left, top-right, bottom-right, bottom-left), grown by `grow` px; null when one is behind the camera. */
export function planeCorners(frame: WorldFrame, plane: WorldPlane, grow = 0): Pt[] | null {
  const { left, top, width, height } = plane.local
  const out: Pt[] = []
  for (const [x, y] of [
    [left - grow, top - grow],
    [left + width + grow, top - grow],
    [left + width + grow, top + height + grow],
    [left - grow, top + height + grow],
  ] as const) {
    const p = projectLocal(frame, plane, x, y)
    if (!p) return null
    out.push(p)
  }
  return out
}

function containsPoint(polygon: readonly Pt[], [x, y]: Pt): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i] as Pt
    const [xj, yj] = polygon[j] as Pt
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** The front-most plane under a point in comp pixels: the nearest to the camera first, then the later layer. */
export function pickPlane(frame: WorldFrame, point: Pt, includeLocked = false): WorldPlane | null {
  const [cx, cy, cz] = [frame.camera.matrix[12] as number, frame.camera.matrix[13] as number, frame.camera.matrix[14] as number]
  const distance = (p: WorldPlane) => Math.hypot((p.matrix[12] as number) - cx, (p.matrix[13] as number) - cy, (p.matrix[14] as number) - cz)
  const hits = frame.planes
    .filter((p) => !p.node.stencil && (includeLocked || !p.locked))
    .filter((p) => {
      const corners = planeCorners(frame, p)
      return corners !== null && containsPoint(corners, point)
    })
  hits.sort((a, b) => distance(a) - distance(b) || b.order - a.order)
  return hits[0] ?? null
}

// ---------------------------------------------------------------------------
// Drawing a plane's picture
// ---------------------------------------------------------------------------

const IDENTITY = translate(0, 0, 0)

/**
 * A node as it is drawn alone onto a plane's texture: in its own space (its
 * matrix and what is inside it rebased by the inverse of its matrix), at
 * opacity 1 (the plane carries the opacity) and with no transition pairing.
 */
export function standAlone(node: SceneNode): SceneNode {
  const inverse = mat4Invert(node.matrix) ?? IDENTITY
  const rebase = (n: SceneNode): SceneNode => {
    const matrix = multiply(inverse, n.matrix)
    const above = multiply(inverse, n.above)
    return n.kind === 'leaf' ? { ...n, matrix, above } : { ...n, matrix, above, children: n.children.map(rebase) }
  }
  const { transition: _transition, ...rest } = node
  const resolved = { ...node.resolved, transform: { ...node.resolved.transform, opacity: 1 } }
  const own = { ...rest, resolved, matrix: IDENTITY, above: IDENTITY }
  return (node.kind === 'leaf' ? own : { ...own, children: node.children.map(rebase) }) as SceneNode
}

/** What a plane's texture covers and how finely. */
export interface TextureSpec {
  /** The texture's rectangle in the picture's local space. */
  rect: Rect
  /** Texels per local px. */
  raster: number
  width: number
  height: number
  /** Where the local origin lands in output pixels along each axis when texels were snapped to whole output pixels there (NaN: not snapped); null when neither was. */
  snap: Pt | null
}

/** The largest side of a plane's texture, texels: a 1400 px wordmark pushed in 3× stays sharp (Q10). */
export const MAX_TEXTURE = 4096
const SNAP_TOLERANCE = 1e-4

/**
 * Chooses a plane's texture: the picture's box grown by what its pixels
 * reach, at `scale` × its on-screen magnification (clamped to 0.5 to 4 times
 * the output scale and to MAX_TEXTURE texels). When the plane faces the
 * camera squarely at 1:1 (the default camera and an unturned picture) the
 * rectangle is chosen so every texel lands on a whole output pixel.
 */
export function textureSpec(frame: WorldFrame, plane: WorldPlane, reach: number, scale: number): TextureSpec {
  const { left, top, width, height } = plane.local
  const grown = { left: left - reach, top: top - reach, width: width + reach * 2, height: height + reach * 2 }
  const p0 = projectLocal(frame, plane, 0, 0)
  const px = projectLocal(frame, plane, 1, 0)
  const py = projectLocal(frame, plane, 0, 1)
  let magnification = 1
  let ax = 0
  let by = 0
  let aligned = false
  if (p0 && px && py) {
    const [ex, ey] = [px[0] - p0[0], px[1] - p0[1]]
    const [fx, fy] = [py[0] - p0[0], py[1] - p0[1]]
    magnification = Math.max(Math.hypot(ex, ey), Math.hypot(fx, fy))
    ax = ex
    by = fy
    aligned = ex > 0 && fy > 0 && Math.abs(ey) < SNAP_TOLERANCE * ex && Math.abs(fx) < SNAP_TOLERANCE * fy
  }
  let raster = scale * clamp(magnification, 0.5, 4)
  raster = Math.max(1e-3, Math.min(raster, MAX_TEXTURE / Math.max(grown.width, grown.height, 1)))
  const snapX = aligned && Math.abs(raster - scale * ax) < SNAP_TOLERANCE * raster
  const snapY = aligned && Math.abs(raster - scale * by) < SNAP_TOLERANCE * raster
  const origin: Pt = p0 ? [scale * p0[0], scale * p0[1]] : [0, 0]
  // The texel grid along one axis, from `from` to `to` (local px); with `snap` it is offset so texel edges fall on whole output pixels.
  const grid = (from: number, to: number, offset: number, snap: boolean): { start: number; count: number } => {
    const shift = snap ? offset : 0
    const n = Math.floor(shift + raster * from + 1e-6)
    const m = Math.ceil(shift + raster * to - 1e-6)
    return { start: (n - shift) / raster, count: Math.max(1, m - n) }
  }
  const gx = grid(grown.left, grown.left + grown.width, origin[0], snapX)
  const gy = grid(grown.top, grown.top + grown.height, origin[1], snapY)
  return {
    rect: { left: gx.start, top: gy.start, width: gx.count / raster, height: gy.count / raster },
    raster,
    width: gx.count,
    height: gy.count,
    snap: snapX || snapY ? [snapX ? origin[0] : Number.NaN, snapY ? origin[1] : Number.NaN] : null,
  }
}
