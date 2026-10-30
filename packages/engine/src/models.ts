import { type Comp, type MediaAsset, MODEL_FORMATS, type ModelFormat, type ModelInfo } from '@uve/core'
import { worldLoader } from './worldLoader'

// Imported 3D models (glb, gltf, obj, stl, ply). Everything here is free of
// three.js, so the main chunk can hold it: the loaders live in
// `world/models.ts` and are reached through the world module.

/** What the host gives the model loaders. */
export interface ModelConfig {
  /** The URL a model file (or a file beside it) is fetched from; the host grants the path first. */
  urlOf: (path: string) => string
  /** The folder of the Draco decoder files (draco_decoder.js, draco_decoder.wasm, draco_wasm_wrapper.js), with a trailing slash. */
  dracoPath: string
}

let config: ModelConfig | null = null

/** Tells the engine how to reach model files. Call it once at start-up. */
export function configureModels(next: ModelConfig): void {
  config = next
}

/** The configuration; throws when the host never set it. */
export function modelConfig(): ModelConfig {
  if (!config) throw new Error('Models are not configured: call configureModels first.')
  return config
}

/** A model file's format by its extension (any case), or null for any other file. */
export function modelFormatOf(name: string): ModelFormat | null {
  const dot = name.lastIndexOf('.')
  if (dot < 0 || /[\\/]/.test(name.slice(dot))) return null
  const extension = name.slice(dot + 1).toLowerCase()
  return (MODEL_FORMATS as readonly string[]).includes(extension) ? (extension as ModelFormat) : null
}

/** The longest side of a model that is fitted (obj, stl, ply), px. */
export const FIT_SIZE = 200

type Vec3 = readonly [number, number, number]

/**
 * How to fit a box to `longest` px: a uniform scale that gives its longest
 * side that length, and the offset (applied after scaling) that centres it in
 * x and y and stands it on z = 0. An empty or flat-to-a-point box scales by 1.
 */
export function fitBox(min: Vec3, max: Vec3, longest: number = FIT_SIZE): { scale: number; offset: [number, number, number] } {
  const side = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2])
  const scale = Number.isFinite(side) && side > 1e-12 ? longest / side : 1
  return { scale, offset: [-((min[0] + max[0]) / 2) * scale, -((min[1] + max[1]) / 2) * scale, -min[2] * scale] }
}

/** The folder of a file path (without the trailing separator), '' when it has none. */
export function folderOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut < 0 ? '' : path.slice(0, cut)
}

/**
 * The file path a uri inside a .gltf (or an .obj) names, beside the model:
 * percent-decoded, `.` and `..` resolved, with the separators of the model's
 * own path (so Windows paths stay Windows paths). Null for a uri that is not
 * a relative file (data:, blob:, http:, a rooted one).
 */
export function resolveModelUri(folder: string, uri: string): string | null {
  if (/^[a-z][a-z0-9+.-]+:/i.test(uri) || uri.startsWith('/') || uri.startsWith('\\')) return null
  let relative = uri.split(/[?#]/, 1)[0] as string
  try {
    relative = decodeURIComponent(relative)
  } catch {
    // Not valid percent-encoding: the name is taken as it is.
  }
  const sep = folder.includes('\\') && !folder.includes('/') ? '\\' : '/'
  const parts = folder === '' ? [] : folder.split(/[\\/]/)
  // A rooted folder ('/home', 'C:\x') keeps its root.
  const root = parts.length > 0 && (parts[0] === '' || /^[a-z]:$/i.test(parts[0] as string)) ? parts.shift() : undefined
  for (const part of relative.split(/[\\/]/)) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  const joined = parts.join(sep)
  return root === undefined ? joined : root === '' ? sep + joined : root + sep + joined
}

/** A model file a world needs. */
export interface ModelRef {
  path: string
  format: ModelFormat
}

/** The model files the meshes of a comp's worlds use (nested comps followed), each once. */
export function modelsUsed(comp: Comp, comps: readonly Comp[], media: readonly MediaAsset[]): ModelRef[] {
  const found = new Map<string, ModelRef>()
  const seen = new Set<string>()
  const walk = (c: Comp): void => {
    if (seen.has(c.id)) return
    seen.add(c.id)
    for (const track of c.tracks) {
      for (const layer of track.layers) {
        if (layer.kind === 'nested') {
          const source = comps.find((other) => other.id === layer.sourceCompId)
          if (source) walk(source)
        } else if (layer.kind === 'mesh' && c.world !== undefined && layer.geometry.type === 'asset') {
          const assetId = layer.geometry.assetId
          const asset = media.find((m) => m.id === assetId)
          const format = asset?.model?.format ?? (asset ? modelFormatOf(asset.path) : null)
          if (asset && format) found.set(`${format}|${asset.path}`, { path: asset.path, format })
        }
      }
    }
  }
  walk(comp)
  return [...found.values()]
}

/**
 * Reads a model file: its format, animation clips and size in px (after the
 * sizing that places it in a world, rounded to 0.1). Fails with a message
 * a user can read.
 */
export async function probeModel(path: string, format: ModelFormat): Promise<ModelInfo> {
  try {
    const world = await worldLoader.ensure()
    return await world.probeModel(path, format)
  } catch (error) {
    throw new Error(`Could not read the model: ${error instanceof Error ? error.message : String(error)}`)
  }
}
