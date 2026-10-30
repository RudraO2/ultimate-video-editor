import { evaluateProperty, propertiesOf } from './properties'
import { CommandError } from './errors'
import { findPrimitive, PRIMITIVE_IDS, type PrimitiveId, primitiveParams, primitiveSize } from './primitives'
import { type MediaAsset, type MeshGeometrySpec, type MeshLayer, type MeshShading, type ModelAnimation, type Project } from './schema'

// Meshes of 3D worlds: what a mesh is made of at a moment, and its colour.

/** The colour of a mesh with no solid fill (a neutral light grey). */
export const MESH_DEFAULT_COLOR = '#c9cbd1'

/** A mesh's geometry at a layer time: the primitive, every param resolved (keys sampled, clamped, counts rounded), and its shading. */
export interface PrimitiveGeometry {
  type: 'primitive'
  primitive: PrimitiveId
  params: Record<string, number>
  shading: MeshShading
  smoothAngle: number
}

/** An imported model's geometry: the media asset it reads, and how it is shaded (custom materials only). */
export interface ModelGeometry {
  type: 'asset'
  assetId: string
  shading: MeshShading
  smoothAngle: number
}

export type MeshGeometry = PrimitiveGeometry | ModelGeometry

/** The geometry of a mesh at a time measured from the layer start (keys `geometry.<param>` and `smoothAngle` sampled). */
export function meshGeometryAt(layer: MeshLayer, layerTimeMs: number): MeshGeometry {
  const keyed = Object.keys(layer.animations).length > 0
  let smoothAngle = layer.smoothAngle
  if (keyed) {
    const angle = propertiesOf(layer).find((s) => s.path === 'smoothAngle')
    if (angle && (layer.animations.smoothAngle?.length ?? 0) > 0) {
      const value = evaluateProperty(layer, angle, layerTimeMs)
      if (typeof value === 'number' && Number.isFinite(value)) smoothAngle = Math.min(180, Math.max(0, value))
    }
  }
  if (layer.geometry.type === 'asset') return { type: 'asset', assetId: layer.geometry.assetId, shading: layer.shading, smoothAngle }
  const { primitive, params } = layer.geometry
  const stored: Record<string, number> = { ...params }
  if (keyed) {
    const specs = propertiesOf(layer)
    for (const param of findPrimitive(primitive)?.params ?? []) {
      const spec = specs.find((s) => s.path === `geometry.${param.key}`)
      if (!spec || (layer.animations[spec.path]?.length ?? 0) === 0) continue
      const value = evaluateProperty(layer, spec, layerTimeMs)
      if (typeof value === 'number' && Number.isFinite(value)) stored[param.key] = value
    }
  }
  return { type: 'primitive', primitive, params: primitiveParams(primitive, stored), shading: layer.shading, smoothAngle }
}

/**
 * A mesh's model settings, checked: `animation` only plays a file's clip, so a
 * primitive has none; a clip must be one the file has; a model must be media
 * of kind model.
 */
export function assertModelMesh(layer: Pick<MeshLayer, 'geometry' | 'animation' | 'name'>, project: Pick<Project, 'media'>): void {
  if (layer.geometry.type === 'asset') {
    const asset = findModelAsset(project, layer.geometry.assetId)
    const clip = layer.animation?.clip
    if (clip != null && !asset.model?.clips.some((c) => c.name === clip)) {
      const names = asset.model?.clips.map((c) => c.name) ?? []
      throw new CommandError(`"${asset.name}" has no animation clip "${clip}".`, names.length > 0 ? `Its clips: ${names.join(', ')}. clip null holds it at rest.` : 'The file has no animation clips.')
    }
  } else if (layer.animation) {
    throw new CommandError(`"${layer.name}" is a primitive, so it has no animation clip.`, 'Only a mesh made from a model file (world_import_model) plays clips; keyframes animate a primitive.')
  }
}

/** A model mesh's size before the layer's scale, when its file's size is unknown: a 200 px cube. */
const MODEL_FALLBACK_SIZE: [number, number, number] = [200, 200, 200]

/** A mesh's size in world px before its layer scale: the primitive's box at a layer time, or the model file's size. */
export function meshSolidSize(layer: MeshLayer, layerTimeMs: number, project: Pick<Project, 'media'>): [number, number, number] {
  const geometry = meshGeometryAt(layer, layerTimeMs)
  if (geometry.type === 'asset') return project.media.find((m) => m.id === geometry.assetId)?.model?.size ?? MODEL_FALLBACK_SIZE
  return primitiveSize(geometry.primitive, geometry.params)
}

/** Where a model's clip stands at a layer time: the clip's name and its time in seconds. */
export interface ModelClipTime {
  clip: string
  seconds: number
}

/**
 * The pose of a model's animation at a time measured from the layer start:
 * null when it holds at rest (no animation, no clip, or a clip the file does
 * not have). Before the layer starts the clip is at 0; a looping clip wraps,
 * any other holds its last pose. Pure, so a frame always shows the same pose.
 */
export function modelClipAt(layer: Pick<MeshLayer, 'animation'>, asset: Pick<MediaAsset, 'model'> | undefined, layerTimeMs: number): ModelClipTime | null {
  const animation = layer.animation
  if (!animation || animation.clip === null) return null
  const clip = asset?.model?.clips.find((c) => c.name === animation.clip)
  if (!clip) return null
  const duration = clip.durationMs / 1000
  const played = (Math.max(0, layerTimeMs) / 1000) * animation.speed
  if (duration <= 0) return { clip: clip.name, seconds: 0 }
  const seconds = animation.loop ? played % duration : Math.min(played, duration)
  return { clip: clip.name, seconds }
}

/** An imported model's media asset, checked: it must exist and be of kind model. */
export function findModelAsset(project: Pick<Project, 'media'>, assetId: string): MediaAsset {
  const asset = project.media.find((m) => m.id === assetId)
  if (!asset) throw new CommandError(`No media "${assetId}".`, 'world_import_model adds a 3D model file to the project; media.list lists the media.')
  if (asset.kind !== 'model') throw new CommandError(`"${asset.name}" is ${asset.kind} media, not a 3D model.`, 'Only model files (glb, gltf, obj, stl, ply) make a model mesh; world_import_model adds one.')
  return asset
}

/** A model's layer name: the file name without its extension. */
export function modelName(asset: Pick<MediaAsset, 'name'>): string {
  return asset.name.replace(/.[^.\/]+$/, '') || asset.name
}

/** A new model mesh's animation: its file's first clip, playing at speed 1 in a loop; none when the file has no clips. */
export function defaultModelAnimation(asset: Pick<MediaAsset, 'model'>): ModelAnimation | undefined {
  const first = asset.model?.clips[0]
  return first ? { clip: first.name, speed: 1, loop: true } : undefined
}

/** A mesh's colour: its first enabled solid fill's, else `MESH_DEFAULT_COLOR`. */
export function meshColor(layer: Pick<MeshLayer, 'fills'>): string {
  for (const fill of layer.fills) if (fill.type === 'solid' && fill.enabled) return fill.color
  return MESH_DEFAULT_COLOR
}

/**
 * The geometry a command's `primitive` and `params` ask for, checked: an
 * unknown primitive or param is an error that lists the valid ones, and a
 * value must be a finite number. Values are kept as given (the stored params
 * stay sparse; `primitiveParams` clamps them when read).
 */
export function meshGeometryInput(primitive: string | undefined, params: Readonly<Record<string, unknown>> | undefined): MeshGeometrySpec {
  const id = primitive ?? 'cube'
  const found = findPrimitive(id)
  if (!found) throw new CommandError(`No primitive "${id}".`, `Primitives: ${PRIMITIVE_IDS.join(', ')}. catalog.list primitives describes them.`)
  const given: Record<string, number> = {}
  for (const [key, value] of Object.entries(params ?? {})) {
    const param = found.params.find((p) => p.key === key)
    if (!param) throw new CommandError(`The ${found.label} has no param "${key}".`, `Its params: ${found.params.map((p) => p.key).join(', ')}.`)
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new CommandError(`Param "${key}" needs a number, not ${JSON.stringify(value)}.`, `${param.label}: ${param.min} to ${param.max ?? 'any'}, default ${param.default}.`)
    given[key] = value
  }
  return { type: 'primitive', primitive: found.id, params: given }
}
