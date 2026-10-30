import { MESH_DEFAULT_COLOR, type ModelClipTime, type ModelFormat, type ModelInfo } from '@uve/core'
import {
  AnimationAction,
  type AnimationClip,
  AnimationMixer,
  Box3,
  BufferGeometry,
  type Material,
  Group,
  LoadingManager,
  LoopOnce,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  Vector3,
} from 'three'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'
import { clone as cloneWithSkeleton } from 'three/addons/utils/SkeletonUtils.js'
import { FIT_SIZE, fitBox, folderOf, type ModelRef, modelConfig, resolveModelUri } from '../models'

// Model files as three.js objects, in the world's own space (Z up, 1 unit =
// 1 px). A file is read once into a template (shared, ref-counted); each mesh
// layer that shows it gets an instance, a clone that shares the template's
// geometry and textures.
//
// Sizing: glTF is in metres with Y up, so it is turned to Z up and scaled by
// 100 (1 m = 100 px), where the file put its origin. OBJ is Y up: turned to Z
// up. OBJ, STL and PLY are then fitted: the longest side 200 px, centred in x
// and y, standing on z = 0.

/** A model read from a file: the object (sized for a world) and its animation clips. */
export interface ModelTemplate {
  root: Object3D
  clips: AnimationClip[]
  /** Its size in a world, px. */
  size: [number, number, number]
}

const DEFAULT_COLOR = MESH_DEFAULT_COLOR

const defaultMaterial = (): MeshStandardMaterial => new MeshStandardMaterial({ color: DEFAULT_COLOR, roughness: 0.6, metalness: 0 })

/** The size of an object's bounding box, px. */
function sizeOf(object: Object3D): [number, number, number] {
  object.updateWorldMatrix(true, true)
  const size = new Box3().setFromObject(object, true).getSize(new Vector3())
  return [size.x, size.y, size.z]
}

/** Wraps a model that is Y up (and perhaps to be fitted): the group that is the template's root. */
function placed(model: Object3D, format: ModelFormat): Object3D {
  const yUp = format === 'glb' || format === 'gltf' || format === 'obj'
  const orient = new Group()
  orient.add(model)
  if (yUp) orient.rotation.x = Math.PI / 2
  const root = new Group()
  root.add(orient)
  if (format === 'glb' || format === 'gltf') {
    root.scale.setScalar(100)
    return root
  }
  orient.updateWorldMatrix(true, true)
  const box = new Box3().setFromObject(orient, true)
  const fit = fitBox([box.min.x, box.min.y, box.min.z], [box.max.x, box.max.y, box.max.z], FIT_SIZE)
  root.scale.setScalar(fit.scale)
  root.position.set(fit.offset[0], fit.offset[1], fit.offset[2])
  return root
}

/** The URL modifier that sends a glTF's relative uris to granted files beside it. */
function urlModifier(path: string): (url: string) => string {
  const folder = folderOf(path)
  const { urlOf } = modelConfig()
  return (url) => {
    const file = resolveModelUri(folder, url)
    return file === null ? url : urlOf(file)
  }
}

const rounded = (size: [number, number, number]): [number, number, number] => [Math.round(size[0] * 10) / 10, Math.round(size[1] * 10) / 10, Math.round(size[2] * 10) / 10]

/** A BufferGeometry file (STL, PLY) as a mesh with the default material (vertex colours when it has them). */
function meshOf(geometry: BufferGeometry): Mesh {
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals()
  const material = defaultMaterial()
  if (geometry.getAttribute('color')) material.vertexColors = true
  return new Mesh(geometry, material)
}

/** Reads a model file's bytes into a template. `path` is where it came from (siblings of a .gltf are found beside it). */
export async function parseModel(format: ModelFormat, data: ArrayBuffer, path: string): Promise<ModelTemplate> {
  let model: Object3D
  let clips: AnimationClip[] = []
  if (format === 'glb' || format === 'gltf') {
    const manager = new LoadingManager()
    manager.setURLModifier(urlModifier(path))
    // Its own manager: the decoder files are the app's, not siblings of the model.
    const draco = new DRACOLoader()
    draco.setDecoderPath(modelConfig().dracoPath)
    const loader = new GLTFLoader(manager)
    loader.setDRACOLoader(draco)
    loader.setMeshoptDecoder(MeshoptDecoder)
    try {
      // The uris of the file are given to the modifier as they are (no base path).
      const gltf = await loader.parseAsync(data, '')
      model = gltf.scene
      clips = gltf.animations
    } finally {
      draco.dispose()
    }
  } else if (format === 'obj') {
    model = new OBJLoader().parse(new TextDecoder().decode(data))
    model.traverse((child) => {
      const mesh = child as Mesh
      if (!mesh.isMesh) return
      if (!mesh.geometry.getAttribute('normal')) mesh.geometry.computeVertexNormals()
      // Without a material library OBJLoader gives a Phong default: use ours.
      mesh.material = defaultMaterial()
    })
  } else if (format === 'stl') {
    model = meshOf(new STLLoader().parse(data))
  } else {
    model = meshOf(new PLYLoader().parse(data))
  }
  const root = placed(model, format)
  return { root, clips, size: sizeOf(root) }
}

/** Frees a template's geometries, materials and textures. */
function disposeTemplate(template: ModelTemplate): void {
  const textures = new Set<{ dispose(): void }>()
  template.root.traverse((object) => {
    const mesh = object as Mesh
    if (!mesh.isMesh) return
    mesh.geometry.dispose()
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      for (const value of Object.values(material as unknown as Record<string, unknown>)) {
        if (value && typeof value === 'object' && (value as { isTexture?: boolean }).isTexture) textures.add(value as { dispose(): void })
      }
      material.dispose()
    }
  })
  for (const texture of textures) texture.dispose()
}

// ---------------------------------------------------------------------------
// The cache
// ---------------------------------------------------------------------------

/** The most unused templates kept; older ones are freed. */
export const MAX_UNUSED_MODELS = 6

interface Cached {
  promise: Promise<ModelTemplate>
  template: ModelTemplate | null
  failed: boolean
  refs: number
  used: number
}

const cache = new Map<string, Cached>()
const warned = new Set<string>()
let clock = 0

const keyOf = (ref: ModelRef): string => `${ref.format}|${ref.path}`

/** The reader of a file; replaceable in tests. */
export const modelFiles = {
  read: async (path: string): Promise<ArrayBuffer> => {
    const response = await fetch(modelConfig().urlOf(path))
    if (!response.ok) throw new Error(`the file could not be read (${response.status})`)
    return response.arrayBuffer()
  },
}

function warn(ref: ModelRef, error: unknown): void {
  if (warned.has(ref.path)) return
  warned.add(ref.path)
  console.warn(`The 3D model ${ref.path} could not be loaded: ${error instanceof Error ? error.message : String(error)}`)
}

function entryOf(ref: ModelRef, retry: boolean): Cached {
  const key = keyOf(ref)
  let entry = cache.get(key)
  if (entry && entry.failed && retry) {
    cache.delete(key)
    entry = undefined
  }
  if (!entry) {
    const created: Cached = {
      promise: Promise.resolve(null as unknown as ModelTemplate),
      template: null,
      failed: false,
      refs: 0,
      used: ++clock,
    }
    created.promise = modelFiles
      .read(ref.path)
      .then((data) => parseModel(ref.format, data, ref.path))
      .then(
        (template) => {
          created.template = template
          return template
        },
        (error) => {
          created.failed = true
          warn(ref, error)
          throw error
        },
      )
    // A failed load is reported to whoever awaits it; this keeps it from being an unhandled rejection.
    created.promise.catch(() => undefined)
    cache.set(key, created)
    entry = created
  }
  entry.used = ++clock
  return entry
}

function evict(): void {
  for (;;) {
    const unused = [...cache].filter(([, e]) => e.refs === 0 && (e.template || e.failed))
    if (unused.length <= MAX_UNUSED_MODELS) return
    const oldest = unused.reduce((a, b) => (b[1].used < a[1].used ? b : a))
    if (oldest[1].template) disposeTemplate(oldest[1].template)
    cache.delete(oldest[0])
  }
}

/** Loads a model (once; the promise is shared). It rejects when the file cannot be read or parsed; `retry` tries again a file that failed before. */
export function loadModel(ref: ModelRef, retry = false): Promise<ModelTemplate> {
  return entryOf(ref, retry).promise
}

/** Loads every model of a list; a failure is logged once and does not stop the others. */
export async function preloadModels(refs: readonly ModelRef[]): Promise<void> {
  await Promise.all(refs.map((ref) => loadModel(ref, true).catch(() => undefined)))
}

/**
 * The template of a model if it is loaded, else null (its load is started;
 * `onLoaded` is called when it ends well). A file that failed stays failed
 * until `preloadModels` tries again.
 */
export function peekModel(ref: ModelRef, onLoaded?: () => void): ModelTemplate | null {
  const entry = entryOf(ref, false)
  if (entry.template) return entry.template
  if (!entry.failed) void entry.promise.then(() => onLoaded?.(), () => undefined)
  return null
}

/** Takes a loaded template for an instance; each call must be matched by `releaseModel`. */
export function retainModel(ref: ModelRef): ModelTemplate | null {
  const entry = cache.get(keyOf(ref))
  if (!entry?.template) return null
  entry.refs++
  entry.used = ++clock
  return entry.template
}

export function releaseModel(ref: ModelRef): void {
  const entry = cache.get(keyOf(ref))
  if (!entry) return
  entry.refs = Math.max(0, entry.refs - 1)
  evict()
}

/** How many models are cached (for tests). */
export const cachedModels = (): number => cache.size

/** Frees every model nothing holds, and forgets failures and warnings (for tests and a lost context). */
export function clearModelCache(): void {
  for (const [key, entry] of cache) {
    if (entry.refs > 0) continue
    if (entry.template) disposeTemplate(entry.template)
    cache.delete(key)
  }
  warned.clear()
}

/** Reads a model's format, clips and size (what an import stores). */
export async function probeModel(path: string, format: ModelFormat): Promise<ModelInfo> {
  const template = await loadModel({ path, format }, true)
  return {
    format,
    clips: template.clips.map((clip) => ({ name: clip.name, durationMs: clip.duration * 1000 })),
    size: rounded(template.size),
  }
}

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

/** What a file material was before the layer's opacity touched it. */
interface Base {
  opacity: number
  transparent: boolean
}

/**
 * A model in a scene: a clone of a template's object under a group that the
 * stage places. Its pose is a pure function of the clip and time it is given
 * (`pose`): the same time gives the same bones and morphs whatever was shown
 * before.
 */
export class ModelInstance {
  /** Placed by the stage (matrixAutoUpdate off). */
  readonly group = new Group()
  readonly meshes: Mesh[] = []
  private readonly mixer: AnimationMixer
  private readonly actions = new Map<string, AnimationAction>()
  private readonly bases = new Map<Material, Base>()
  private custom: Material | null = null
  private posed: string | null = null

  constructor(
    private readonly template: ModelTemplate,
    /** The layer's own material replaces the file's (one for every mesh); null keeps the file's. */
    custom: Material | null,
  ) {
    this.group.matrixAutoUpdate = false
    const root = cloneWithSkeleton(template.root)
    this.group.add(root)
    this.custom = custom
    root.traverse((object) => {
      const mesh = object as Mesh
      if (!mesh.isMesh) return
      mesh.frustumCulled = false
      if (custom) mesh.material = custom
      else {
        // The file's materials are cloned so this instance can fade them.
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => this.own(m)) : this.own(mesh.material)
      }
      this.meshes.push(mesh)
    })
    this.mixer = new AnimationMixer(root)
  }

  private own(material: Material): Material {
    const copy = material.clone()
    this.bases.set(copy, { opacity: copy.opacity, transparent: copy.transparent })
    return copy
  }

  /** Whether this instance draws the layer's material (true) or the file's (false). */
  get isCustom(): boolean {
    return this.custom !== null
  }

  /** The materials the instance fades or shades: the layer's one, or the clones of the file's. */
  get materials(): Material[] {
    return this.custom ? [this.custom] : [...this.bases.keys()]
  }

  /** Sets the opacity of the file's materials (times their own), and whether they blend. */
  fade(opacity: number): void {
    for (const [material, base] of this.bases) {
      const transparent = base.transparent || opacity < 1
      material.opacity = base.opacity * opacity
      if (material.transparent !== transparent) {
        material.transparent = transparent
        material.needsUpdate = true
      }
    }
  }

  /** Shows a clip at a time (seconds), or the rest pose when `clip` is null or the file has no such clip. */
  pose(clip: ModelClipTime | null): void {
    const wanted = clip && this.template.clips.find((c) => c.name === clip.clip)
    if (!clip || !wanted) {
      if (this.posed !== null) {
        // Stopping the last user of a property puts it back as it was before the first clip played.
        this.mixer.stopAllAction()
        this.posed = null
      }
      return
    }
    if (this.posed !== null && this.posed !== clip.clip) this.actions.get(this.posed)?.stop()
    let action = this.actions.get(clip.clip)
    if (!action) {
      action = this.mixer.clipAction(wanted)
      action.setLoop(LoopOnce, 1)
      action.clampWhenFinished = true
      this.actions.set(clip.clip, action)
    }
    action.enabled = true
    action.paused = false
    action.setEffectiveWeight(1)
    action.setEffectiveTimeScale(1)
    action.play()
    action.time = Math.min(Math.max(clip.seconds, 0), wanted.duration)
    // A zero step evaluates the clip at `action.time` and moves nothing on its own.
    this.mixer.update(0)
    this.posed = clip.clip
  }

  /** Frees what the instance owns: its mixer and the materials it cloned (the geometry and textures belong to the template). */
  dispose(): void {
    this.mixer.stopAllAction()
    this.mixer.uncacheRoot(this.group.children[0] as Object3D)
    this.group.removeFromParent()
    for (const material of this.bases.keys()) material.dispose()
    this.custom?.dispose()
    this.bases.clear()
  }
}
