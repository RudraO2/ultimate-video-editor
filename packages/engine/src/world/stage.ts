import { evaluateProperty, propertiesOf, mat4Compose, mat4Scale, mat4Translate, type MaterialSpec, MaterialSchema } from '@uve/core'
import {
  BufferGeometry,
  Color,
  DoubleSide,
  Euler,
  FrontSide,
  Fog,
  Group,
  Matrix4,
  Mesh,
  PCFShadowMap,
  Plane,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  type Texture,
  Vector2,
  Vector3,
  WebGLRenderer,
  type WebGLRenderTarget,
  type PerspectiveCamera,
  type OrthographicCamera,
} from 'three'
import type { Rect } from '../scene'
import { dofAperture } from './dof'
import { forgetEmission, intoEmission, outOfEmission } from './emission'
import { Environments } from './environment'
import { disposeFloor, type FloorRig, makeFloor, reflectionOf, syncFloor } from './floor'
import { acquireExtrusion, releaseExtrusion } from './extrude'
import { outlineFontsRevision } from './textOutlines'
import { projectLocal, standAlone, type TextureSpec, textureSpec, type WorldFrame, type WorldMesh, type WorldPlane } from './frame'
import type { WorldHost } from './host'
import { acquireGeometry, geometryKey, isOpenSurface, releaseGeometry } from './meshes'
import { ModelInstance, peekModel, releaseModel, retainModel } from './models'
import type { ModelRef } from '../models'
import { boundsOf, disposeRig, type LightRig, makeRig, syncLights } from './lights'
import { exposureOf, fogParameters, type MaterialKind, type MaterialParameters, materialParameters, TONE_MAPPING } from './lighting'
import {
  applyParameters,
  litGeometry,
  type LitMaterial,
  makeLitMaterial,
  makeLitTexture,
  makeUnlitMaterial,
  makeUnlitTexture,
  type PictureKind,
  type PictureMaterial,
  pictureKind,
  setMap,
  unlitGeometry,
} from './pictures'
import { PostStack } from './post'
import { postPlan } from './postMath'
import { makeThreeCamera, WORLD_UNIT } from './threeCamera'
import type { WorldSample } from './worldBlur'

// The three.js side of a world: one shared WebGL renderer, a scene per
// (renderer, comp) with a picture plane per layer. Each plane's texture is the
// layer drawn alone by the 2D renderer. A plane with no material is an unlit
// picture (pictures.ts): a shader that writes the premultiplied texel times the
// opacity with no colour conversion, so what the 2D renderer drew reaches the
// canvas as it is. A plane with a material is lit by the world's lights and
// environment, tone mapped, and encoded to sRGB by three.
//
// A frame that needs nothing more is drawn straight to the canvas. One with
// ambient occlusion, depth of field, bloom or motion blur goes through the
// post stack (post.ts): the scene is drawn into a half-float target that
// holds the same display values the canvas would, the passes work on those,
// and the result is copied to the canvas. A mirror floor draws the scene a
// second time, mirrored, before the real one.

/** A scene that is not drawn for this many renders is let go. */
const KEEP_RENDERS = 300

interface Entry {
  kind: PictureKind
  mesh: Mesh<BufferGeometry, PictureMaterial>
  texture: Texture
  canvas: OffscreenCanvas
  /** What the texture was drawn from (see `keyOf`). */
  key: string
  spec: TextureSpec
  /** Where the plane's origin was on the previous frame, output px: a moving plane keeps its texture. */
  last: [number, number]
  used: number
  solid?: Mesh<BufferGeometry, LitMaterial>
  solidKey?: string
  solidKind?: MaterialKind
}

/** A mesh layer's three.js mesh: its geometry comes from the shared cache (`key`), its material is its own. */
interface MeshEntry {
  kind: MaterialKind
  mesh: Mesh<BufferGeometry, LitMaterial>
  /** The cache key of the geometry the mesh holds (a reference), '' before it has one. */
  key: string
  used: number
}

/** A mesh layer that shows an imported model: its instance, and what it is made of ('file' keeps the file's materials, else the layer's lit material kind). */
interface ModelEntry {
  ref: ModelRef
  mode: string
  instance: ModelInstance
  used: number
}

export interface View {
  scene: Scene
  root: Group
  rig: LightRig
  entries: Map<string, Entry>
  meshes: Map<string, MeshEntry>
  models: Map<string, ModelEntry>
  floor: FloorRig
  /** The view's one three camera, updated each frame (see `steadyCamera`). */
  camera?: PerspectiveCamera | OrthographicCamera
  used: number
  generation: number
}

let shared: WebGLRenderer | null = null
let environments: Environments | null = null
let post: PostStack | null = null
/** For checks: send every frame through the render targets, whatever it needs. */
let forceTargets = false
let failed = false
let generation = 0
let tick = 0
const views = new WeakMap<WorldHost, Map<string, View>>()
const ids = new WeakMap<object, number>()
let nextId = 1

const idOf = (value: object | undefined): number => {
  if (!value) return 0
  let id = ids.get(value)
  if (id === undefined) {
    id = nextId++
    ids.set(value, id)
  }
  return id
}

/**
 * Transparent planes are drawn far to near, and planes at the same depth in
 * layer order (the back one first). Depth here is the plane's origin in the
 * camera's clip space, so equal means coplanar and parallel to the camera.
 */
function sortTransparent(a: { groupOrder: number; z: number; renderOrder: number; id: number }, b: { groupOrder: number; z: number; renderOrder: number; id: number }): number {
  if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder
  if (Math.abs(a.z - b.z) > 1e-10) return b.z - a.z
  return a.renderOrder - b.renderOrder || a.id - b.id
}

function renderer(width: number, height: number): WebGLRenderer | null {
  if (failed) return null
  if (shared?.getContext().isContextLost()) {
    environments = null
    post = null
    shared.dispose()
    shared = null
    generation++
  }
  if (!shared) {
    try {
      const canvas = new OffscreenCanvas(width, height)
      const r = new WebGLRenderer({
        canvas: canvas as unknown as HTMLCanvasElement,
        antialias: true,
        alpha: true,
        premultipliedAlpha: true,
        preserveDrawingBuffer: false,
        powerPreference: 'high-performance',
      })
      r.setPixelRatio(1)
      // Lit materials are encoded to sRGB by three; unlit pictures write raw values and are not touched by this.
      r.outputColorSpace = SRGBColorSpace
      r.shadowMap.type = PCFShadowMap
      r.setClearColor(0x000000, 0)
      r.setTransparentSort(sortTransparent)
      shared = r
    } catch (error) {
      failed = true
      console.error('The 3D renderer could not start (WebGL2 is not available):', error)
      return null
    }
  }
  const size = shared.getSize(new Vector2())
  if (size.x !== width || size.y !== height) shared.setSize(width, height, false)
  return shared
}

/** The scene a host keeps for a key (a comp id, or an editor view of it) if it has one; never made here. */
export function peekView(host: WorldHost, key: string): View | undefined {
  const view = views.get(host)?.get(key)
  return view && view.generation === generation ? view : undefined
}

/** The baked environments of the shared renderer (made on first use). */
export function environmentsOf(gl: WebGLRenderer): Environments {
  environments ??= new Environments(gl)
  return environments
}

function viewOf(host: WorldHost, compId: string): View {
  let byComp = views.get(host)
  if (!byComp) {
    byComp = new Map()
    views.set(host, byComp)
  }
  let view = byComp.get(compId)
  if (view && view.generation !== generation) {
    disposeView(view)
    byComp.delete(compId)
    view = undefined
  }
  if (!view) {
    const scene = new Scene()
    const root = new Group()
    root.scale.setScalar(WORLD_UNIT)
    scene.add(root)
    const floor = makeFloor()
    scene.add(floor.group)
    view = { scene, root, rig: makeRig(scene), entries: new Map(), meshes: new Map(), models: new Map(), floor, used: tick, generation }
    byComp.set(compId, view)
  }
  view.used = tick
  for (const [id, other] of byComp) {
    if (other !== view && tick - other.used > KEEP_RENDERS) {
      disposeView(other)
      byComp.delete(id)
    }
  }
  return view
}

function disposeEntry(entry: Entry, root: Group): void {
  root.remove(entry.mesh)
  if (entry.solid) { root.remove(entry.solid); entry.solid.material.dispose(); forgetEmission(entry.solid) }
  if (entry.solidKey) releaseExtrusion(entry.solidKey)
  entry.texture.dispose()
  entry.mesh.material.dispose()
  forgetEmission(entry.mesh)
}

function disposeMeshEntry(entry: MeshEntry, root: Group): void {
  root.remove(entry.mesh)
  entry.mesh.material.dispose()
  forgetEmission(entry.mesh)
  if (entry.key) releaseGeometry(entry.key)
  entry.key = ''
}

function disposeModelEntry(entry: ModelEntry, root: Group): void {
  root.remove(entry.instance.group)
  for (const mesh of entry.instance.meshes) forgetEmission(mesh)
  entry.instance.dispose()
  releaseModel(entry.ref)
}

/** The meshes of a model that the emission pass can swap (a mesh with several materials is left as it is). */
const emissive = (entry: ModelEntry): Mesh[] => entry.instance.meshes.filter((mesh) => !Array.isArray(mesh.material))

function disposeView(view: View): void {
  for (const entry of view.entries.values()) disposeEntry(entry, view.root)
  view.entries.clear()
  for (const entry of view.meshes.values()) disposeMeshEntry(entry, view.root)
  view.meshes.clear()
  for (const entry of view.models.values()) disposeModelEntry(entry, view.root)
  view.models.clear()
  disposeRig(view.rig, view.scene)
  disposeFloor(view.floor)
}

/** What a plane's texture was drawn from: change any of it and the picture is drawn again. */
function keyOf(frame: WorldFrame, plane: WorldPlane): string {
  const fonts = typeof document === 'undefined' ? '' : `${document.fonts.status}:${document.fonts.size}`
  const time = plane.timeVarying ? plane.node.resolved.layerTimeMs : 0
  const stretch = plane.node.stretched ? `${plane.node.stretched.width ?? ''}x${plane.node.stretched.height ?? ''}` : ''
  return [idOf(plane.layer), time, idOf(frame.media), idOf(frame.comps), stretch, fonts, idOf(frame.proxy.tracks)].join('|')
}

/** The matrix that puts a unit square at a texture's rectangle in a plane's local space, then the plane in the world. */
function meshMatrix(plane: WorldPlane, rect: Rect): number[] {
  return mat4Compose(plane.matrix, mat4Translate(rect.left + rect.width / 2, rect.top + rect.height / 2, 0), mat4Scale(rect.width, rect.height, 1))
}

/** A texture of a canvas, for an unlit picture or a lit one. */
const makeTexture = (canvas: OffscreenCanvas, kind: PictureKind): Texture => (kind === 'unlit' ? makeUnlitTexture(canvas) : makeLitTexture(canvas))

function makeEntry(kind: PictureKind): Entry {
  const material: PictureMaterial = kind === 'unlit' ? makeUnlitMaterial() : makeLitMaterial(kind)
  const mesh = new Mesh(kind === 'unlit' ? unlitGeometry : litGeometry(), material)
  mesh.matrixAutoUpdate = false
  mesh.frustumCulled = false
  const canvas = new OffscreenCanvas(1, 1)
  const texture = makeTexture(canvas, kind)
  setMap(material, texture)
  const spec: TextureSpec = { rect: { left: 0, top: 0, width: 1, height: 1 }, raster: 1, width: 1, height: 1, snap: null }
  return { kind, mesh, texture, canvas, key: '', spec, last: [Number.NaN, Number.NaN], used: 0 }
}

const near = (a: number, b: number) => (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) < 1e-3

/**
 * Whether a plane's texture can stay as drawn: same picture, a texture about
 * as fine as is wanted now, and, once the plane stands still, snapped to the
 * output pixels the way it would be drawn fresh.
 */
function reusable(entry: Entry, key: string, wanted: TextureSpec, origin: [number, number]): boolean {
  if (entry.key !== key) return false
  const ratio = wanted.raster / entry.spec.raster
  if (ratio < 0.8 || ratio > 1.25) return false
  const moving = !near(origin[0], entry.last[0]) || !near(origin[1], entry.last[1])
  if (moving) return true
  const a = entry.spec.snap
  const b = wanted.snap
  if (!a && !b) return true
  if (!a || !b) return false
  return near(a[0], b[0]) && near(a[1], b[1]) && Math.abs(ratio - 1) < 1e-6
}

/** For checks: sends every frame through the render targets, even one that needs no post pass, so the two paths can be compared. */
export function setForceTargets(on: boolean): void {
  forceTargets = on
}

/** What a prepared frame is seen with. */
export interface Prepared {
  gl: WebGLRenderer
  camera: PerspectiveCamera | OrthographicCamera
}

/** Brings a world frame into the view's scene (pictures, meshes, look, lights, floor) and builds the camera that sees it. */
function prepareFrame(host: WorldHost, view: View, frame: WorldFrame, gl: WebGLRenderer, width: number, height: number): Prepared {
  const scale = width / frame.comp.width
  const seen = new Set<string>()
  const fog = fogParameters(frame.fog)

  for (const plane of frame.planes) {
    if (plane.opacity <= 0) continue
    seen.add(plane.id)
    const key = keyOf(frame, plane)
    const wanted = textureSpec(frame, plane, host.reach(plane.node), scale)
    const extrusion = extrusionAt(plane)
    const kind = solidAtSomeTime(plane) ? pictureKind(plane.material ?? DEFAULT_MATERIAL) : pictureKind(plane.material)
    let entry = view.entries.get(plane.id)
    if (entry && entry.kind !== kind) {
      // Lit or unlit, or another material model: a different three.js material (and texture encoding), so a new plane.
      disposeEntry(entry, view.root)
      view.entries.delete(plane.id)
      entry = undefined
    }
    const fresh = !entry
    if (!entry) {
      entry = makeEntry(kind)
      view.entries.set(plane.id, entry)
      view.root.add(entry.mesh)
    }
    const origin = planeOrigin(frame, plane, scale)
    if (fresh || !reusable(entry, key, wanted, origin)) {
      const same = entry.canvas.width === wanted.width && entry.canvas.height === wanted.height
      const canvas = host.drawAlone(standAlone(plane.node), frame.comp, wanted.rect, wanted.raster, wanted.width, wanted.height, same ? entry.canvas : undefined)
      if (same) entry.texture.needsUpdate = true
      else {
        // A texture's storage has the size it was first uploaded at: a different size is a new texture.
        entry.texture.dispose()
        entry.texture = makeTexture(canvas, entry.kind)
        setMap(entry.mesh.material, entry.texture)
      }
      entry.canvas = canvas
      // The picture may start loading a font while it is drawn: the key is read after, so the next change of the font state redraws it.
      entry.key = keyOf(frame, plane)
      entry.spec = wanted
    }
    entry.last = origin
    entry.used = tick
    updateMaterial(entry, plane, frame)
    syncExtrusion(view, entry, plane, frame, extrusion)
    entry.mesh.renderOrder = plane.order
    entry.mesh.matrix.fromArray(meshMatrix(plane, entry.spec.rect))
    entry.mesh.matrixWorldNeedsUpdate = true
  }

  for (const [id, entry] of view.entries) {
    if (!seen.has(id)) {
      disposeEntry(entry, view.root)
      view.entries.delete(id)
    }
  }

  const seenMeshes = new Set<string>()
  for (const item of frame.meshes) {
    if (item.opacity <= 0) continue
    seenMeshes.add(item.id)
    syncMesh(host, view, item, frame)
  }
  for (const [id, entry] of view.meshes) {
    if (!seenMeshes.has(id)) {
      disposeMeshEntry(entry, view.root)
      view.meshes.delete(id)
    }
  }
  for (const [id, entry] of view.models) {
    if (!seenMeshes.has(id)) {
      disposeModelEntry(entry, view.root)
      view.models.delete(id)
    }
  }

  // Drawing a plane's picture may have rendered another world (a flat comp nested in this one can nest a world): size the shared canvas again.
  const target = renderer(width, height) ?? gl
  setLook(target, view, frame, fog)
  syncFloor(view.floor, frame.render.floor)
  return { gl: target, camera: steadyCamera(view, makeThreeCamera(frame.camera, frame.comp, width, height)) }
}

/**
 * The view's camera with `fresh`'s lens and pose. Three keeps a render target
 * per camera id (the transmission pass of glass materials) and never frees it,
 * so a new camera per frame or blur sample would leak GPU memory until the
 * context is lost; the same camera object is reused instead.
 */
function steadyCamera(view: View, fresh: PerspectiveCamera | OrthographicCamera): PerspectiveCamera | OrthographicCamera {
  const kept = view.camera
  if (kept && kept.type === fresh.type) {
    // copy() takes the matrices as they are, so the lens shift in the projection stays.
    ;(kept as PerspectiveCamera).copy(fresh as PerspectiveCamera)
    return kept
  }
  view.camera = fresh
  return fresh
}

const reflectionPlane = new Plane()
const clipAboveFloor = [reflectionPlane]
const noClipping: Plane[] = []

/**
 * Draws the prepared scene into a target (null is the canvas). With a mirror
 * floor the scene is first drawn mirrored in z about the floor, cut at the
 * floor so only what stands above it is reflected (the scene's own matrix
 * carries the mirror, so the lights and shadows are mirrored too, and three
 * turns the faces round for the negative determinant), then the depth is
 * cleared and the real scene, with the floor, is drawn over it.
 */
function drawScene(gl: WebGLRenderer, view: View, frame: WorldFrame, camera: PerspectiveCamera | OrthographicCamera, target: WebGLRenderTarget | null): void {
  gl.setRenderTarget(target)
  if (frame.render.floor.mode !== 'mirror') {
    gl.render(view.scene, camera)
    return
  }
  const { scene, floor } = view
  const autoClear = gl.autoClear
  gl.autoClear = false
  gl.clear()
  floor.group.visible = false
  scene.matrixAutoUpdate = false
  scene.matrix.copy(reflectionOf(frame.render.floor.z))
  scene.matrixWorldNeedsUpdate = true
  reflectionPlane.normal.set(0, 0, -1)
  reflectionPlane.constant = frame.render.floor.z * WORLD_UNIT
  gl.clippingPlanes = clipAboveFloor
  gl.render(scene, camera)
  gl.clippingPlanes = noClipping
  scene.matrix.identity()
  scene.matrixAutoUpdate = true
  scene.matrixWorldNeedsUpdate = true
  floor.group.visible = true
  // The background was painted by the first pass, and would cover the reflection.
  const background = scene.background
  scene.background = null
  gl.clearDepth()
  gl.render(scene, camera)
  scene.background = background
  gl.autoClear = autoClear
}

/**
 * Draws the prepared scene reduced to its emission (see emission.ts) for the
 * bloom: no shadows, no floor, no background. Unlit pictures are black.
 */
function drawEmission(gl: WebGLRenderer, view: View, camera: PerspectiveCamera | OrthographicCamera, target: WebGLRenderTarget): void {
  // An unlit picture's material is a shader with a black switch; any other plane is lit (its mesh is the one swapped).
  const blackOut = (entry: Entry, on: boolean) => {
    if (entry.kind === 'unlit') (entry.mesh.material as ShaderMaterial).uniforms.uBlack!.value = on ? 1 : 0
  }
  for (const entry of view.entries.values()) {
    blackOut(entry, true)
    if (entry.kind !== 'unlit') intoEmission(entry.mesh)
    if (entry.solid) intoEmission(entry.solid)
  }
  for (const entry of view.meshes.values()) intoEmission(entry.mesh)
  for (const entry of view.models.values()) for (const mesh of emissive(entry)) intoEmission(mesh)
  const { scene, floor } = view
  const background = scene.background
  scene.background = null
  floor.group.visible = false
  gl.shadowMap.autoUpdate = false
  try {
    gl.setRenderTarget(target)
    gl.render(scene, camera)
  } finally {
    gl.shadowMap.autoUpdate = true
    floor.group.visible = floor.kind !== null
    scene.background = background
    for (const entry of view.entries.values()) {
      blackOut(entry, false)
      if (entry.kind !== 'unlit') outOfEmission(entry.mesh)
      if (entry.solid) outOfEmission(entry.solid)
    }
    for (const entry of view.meshes.values()) outOfEmission(entry.mesh)
    for (const entry of view.models.values()) for (const mesh of emissive(entry)) outOfEmission(mesh)
  }
}

/**
 * What an editor view adds to a draw (the orbit view, orbitView.ts); the
 * camera's own view passes none, so it draws exactly as it always did.
 */
export interface DrawHooks {
  /** The key of the scene the frame is drawn in (default the comp's id), so an editor view never touches the camera view's scene. */
  viewKey?: string
  /** Called once the frame is in the scene and before it is drawn; may change the scene for the draw and returns how to put it back. */
  shade?(view: View, prepared: Prepared, frame: WorldFrame): (() => void) | void
  /** Called after the world is on the canvas; `depthKept` says whether the canvas still holds the scene's depth. */
  overlay?(gl: WebGLRenderer, camera: PerspectiveCamera | OrthographicCamera, depthKept: boolean): void
}

/**
 * Draws a world frame with three.js onto the shared canvas at the given
 * size and returns that canvas (draw it right away: the next call reuses it),
 * or null when WebGL is not available. `host` draws each plane's picture.
 * `samples` are the frames of a motion-blurred shutter (worldBlur.ts) with
 * their weights; `frame` is the one at the frame time, whose world settings
 * and post effects rule. A frame that needs no post pass goes straight to the
 * canvas, exactly as it always did.
 */
export function drawWorld(host: WorldHost, frame: WorldFrame, outWidth: number, outHeight: number, samples?: readonly WorldSample[], hooks?: DrawHooks): OffscreenCanvas | null {
  const width = Math.max(1, Math.round(outWidth))
  const height = Math.max(1, Math.round(outHeight))
  const gl = renderer(width, height)
  if (!gl) return null
  tick++
  const view = viewOf(host, hooks?.viewKey ?? frame.comp.id)
  const moments: readonly WorldSample[] = samples && samples.length > 0 ? samples : [{ frame, weight: 1 }]
  const plan = postPlan(frame.render, frame.camera.dof !== undefined)
  if (moments.length === 1 && !plan.any && !forceTargets) {
    const prepared = prepareFrame(host, view, (moments[0] as WorldSample).frame, gl, width, height)
    const restore = hooks?.shade?.(view, prepared, frame)
    try {
      drawScene(prepared.gl, view, frame, prepared.camera, null)
      // The depth the scene wrote is still in the canvas: an overlay may test against it.
      hooks?.overlay?.(prepared.gl, prepared.camera, true)
    } finally {
      restore?.()
    }
    return prepared.gl.domElement as unknown as OffscreenCanvas
  }

  post ??= new PostStack(gl)
  const stack = post
  const sceneTarget = stack.sceneTarget(width, height)
  const emissionTarget = plan.emission ? stack.emissionTarget(width, height) : null
  const sum = moments.length > 1 ? stack.accumulator('image', width, height) : null
  const emissionSum = sum && emissionTarget ? stack.accumulator('emission', width, height) : null
  if (sum) stack.clear(sum)
  if (emissionSum) stack.clear(emissionSum)
  let picture: Texture = sceneTarget.texture
  let glowSource: Texture | null = emissionTarget?.texture ?? null
  let canvas = gl
  let lastCamera: PerspectiveCamera | OrthographicCamera | null = null
  for (const { frame: at, weight } of moments) {
    const prepared = prepareFrame(host, view, at, gl, width, height)
    canvas = prepared.gl
    lastCamera = prepared.camera
    const restore = hooks?.shade?.(view, prepared, at)
    try {
      drawScene(canvas, view, at, prepared.camera, sceneTarget)
    } finally {
      restore?.()
    }
    let texture: Texture = sceneTarget.texture
    if (plan.ao) texture = stack.occlude(sceneTarget, prepared.camera, { radius: at.render.ao.radius * WORLD_UNIT, strength: at.render.ao.strength })
    const dof = at.camera.dof
    if (plan.dof && dof) {
      const { lens } = at.camera
      texture = stack.defocus(sceneTarget, texture, prepared.camera, {
        focus: dof.focusDistance * WORLD_UNIT,
        aperture: dofAperture(lens.focalLength, dof.fStop, dof.focusDistance, lens.sensorWidth),
      })
    }
    if (emissionTarget) drawEmission(canvas, view, prepared.camera, emissionTarget)
    if (sum) {
      stack.accumulate(sum, texture, weight)
      if (emissionSum && emissionTarget) stack.accumulate(emissionSum, emissionTarget.texture, weight)
    } else {
      picture = texture
      glowSource = emissionTarget?.texture ?? null
    }
  }
  if (sum) picture = sum.texture
  if (emissionSum) glowSource = emissionSum.texture
  const { bloom } = frame.render
  const glow = plan.bloom ? stack.bloom(plan.emission ? (glowSource ?? picture) : picture, width, height, { strength: bloom.strength, radius: bloom.radius, threshold: bloom.threshold }) : null
  stack.finish(picture, glow)
  // The scene's depth went to a target, not the canvas: an overlay finds no depth there.
  if (lastCamera) hooks?.overlay?.(canvas, lastCamera, false)
  return canvas.domElement as unknown as OffscreenCanvas
}

const DEFAULT_MATERIAL: MaterialSpec = MaterialSchema.parse({})
const tint = new Color()

/** Brings a mesh layer's three.js mesh to what the frame says: its shared geometry, material, shadows and place. */
function syncMesh(host: WorldHost, view: View, item: WorldMesh, frame: WorldFrame): void {
  const geometry = item.geometry
  if (geometry.type === 'asset') {
    const stale = view.meshes.get(item.id)
    if (stale) {
      disposeMeshEntry(stale, view.root)
      view.meshes.delete(item.id)
    }
    syncModel(host, view, item, frame)
    return
  }
  const gone = view.models.get(item.id)
  if (gone) {
    disposeModelEntry(gone, view.root)
    view.models.delete(item.id)
  }
  const spec = item.material ?? DEFAULT_MATERIAL
  const params = materialParameters(spec)
  let entry = view.meshes.get(item.id)
  if (entry && entry.kind !== params.kind) {
    disposeMeshEntry(entry, view.root)
    view.meshes.delete(item.id)
    entry = undefined
  }
  if (!entry) {
    const material = makeLitMaterial(params.kind)
    // An opaque solid: no picture, no alpha test, and no layer-order offset (that is for coplanar pictures).
    material.alphaTest = 0
    material.polygonOffset = false
    const mesh = new Mesh<BufferGeometry, LitMaterial>(new BufferGeometry(), material)
    mesh.matrixAutoUpdate = false
    mesh.frustumCulled = false
    view.root.add(mesh)
    entry = { kind: params.kind, mesh, key: '', used: 0 }
    view.meshes.set(item.id, entry)
  }
  const wanted = geometryKey(geometry)
  if (entry.key !== wanted) {
    const next = acquireGeometry(geometry)
    entry.mesh.geometry = next.geometry
    if (entry.key) releaseGeometry(entry.key)
    entry.key = next.key
  }
  shadeMaterial(entry.mesh.material, item, params, isOpenSurface(geometry))
  entry.mesh.castShadow = frame.render.shadows && item.castShadow
  entry.mesh.receiveShadow = frame.render.shadows && item.receiveShadow
  entry.mesh.renderOrder = item.order
  entry.mesh.matrix.fromArray(item.matrix)
  entry.mesh.matrixWorldNeedsUpdate = true
  entry.used = tick
}

/** Sets a mesh's lit material to the layer's: the material's values, the mesh's colour times its tint, the sides, and the opacity. */
function shadeMaterial(material: LitMaterial, item: WorldMesh, params: MaterialParameters, open: boolean): void {
  const before = [material.side, material.transparent]
  applyParameters(material, params)
  // The mesh's colour times the material's tint (white when it has none).
  material.color.multiply(tint.set(item.color.slice(0, 7)))
  material.side = params.doubleSided || open ? DoubleSide : FrontSide
  material.opacity = item.opacity
  material.transparent = item.opacity < 1
  if (material.side !== before[0] || material.transparent !== before[1]) material.needsUpdate = true
}

/**
 * Brings a mesh layer that shows an imported model to what the frame says.
 * The model draws once its file is loaded (until then, nothing; the host is
 * told when it is, to draw again). It keeps the file's materials unless the
 * layer's material is custom.
 */
function syncModel(host: WorldHost, view: View, item: WorldMesh, frame: WorldFrame): void {
  const model = item.model
  let entry = view.models.get(item.id)
  const spec = item.material?.source === 'custom' ? item.material : undefined
  const params = spec ? materialParameters(spec) : null
  const mode = params ? `custom:${params.kind}` : 'file'
  if (entry && (!model || entry.mode !== mode || entry.ref.path !== model.path || entry.ref.format !== model.format)) {
    disposeModelEntry(entry, view.root)
    view.models.delete(item.id)
    entry = undefined
  }
  if (!model) return
  if (!entry) {
    const ref: ModelRef = { path: model.path, format: model.format }
    peekModel(ref, host.modelLoaded)
    const template = retainModel(ref)
    if (!template) return
    let custom: LitMaterial | null = null
    if (params) {
      custom = makeLitMaterial(params.kind)
      // An opaque solid, like a primitive mesh: no alpha test and no layer-order offset.
      custom.alphaTest = 0
      custom.polygonOffset = false
    }
    const instance = new ModelInstance(template, custom)
    view.root.add(instance.group)
    entry = { ref, mode, instance, used: 0 }
    view.models.set(item.id, entry)
  }
  const { instance } = entry
  instance.pose(model.clip)
  if (params) shadeMaterial(instance.materials[0] as LitMaterial, item, params, false)
  else instance.fade(item.opacity)
  for (const mesh of instance.meshes) {
    mesh.castShadow = frame.render.shadows && item.castShadow
    mesh.receiveShadow = frame.render.shadows && item.receiveShadow
    mesh.renderOrder = item.order
  }
  instance.group.matrix.fromArray(item.matrix)
  instance.group.matrixWorldNeedsUpdate = true
  entry.used = tick
}

/** Sample thickness independently of the picture texture, so keyed depth stays cheap. */
function extrusionAt(plane: WorldPlane): NonNullable<typeof plane.layer.extrude> | undefined {
  const spec = plane.layer.extrude
  if (!spec) return undefined
  const sampled = (path: string, fallback: number): number => {
    const prop = propertiesOf(plane.layer).find(p => p.path === path)
    const value = prop ? evaluateProperty(plane.layer, prop, plane.node.resolved.layerTimeMs) : undefined
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : fallback
  }
  return { ...spec, depth: sampled('extrude.depth', spec.depth), bevel: sampled('extrude.bevel', spec.bevel) }
}

/** A picture that has thickness at any time takes light all the time, so keyed depth growing from 0 does not jump from unlit to lit. */
function solidAtSomeTime(plane: WorldPlane): boolean {
  const spec = plane.layer.extrude
  if (!spec) return false
  return spec.depth > 0 || (plane.layer.animations['extrude.depth'] ?? []).some((key) => typeof key.v === 'number' && key.v > 0)
}

function syncExtrusion(view: View, entry: Entry, plane: WorldPlane, frame: WorldFrame, spec: ReturnType<typeof extrusionAt>): void {
  if (!spec || spec.depth <= 0) {
    if (entry.solid) { view.root.remove(entry.solid); entry.solid.material.dispose(); forgetEmission(entry.solid); entry.solid = undefined }
    if (entry.solidKey) { releaseExtrusion(entry.solidKey); entry.solidKey = undefined }
    return
  }
  const params = materialParameters(plane.material ?? DEFAULT_MATERIAL)
  if (entry.solid && entry.solidKind !== params.kind) {
    view.root.remove(entry.solid)
    entry.solid.material.dispose()
    forgetEmission(entry.solid)
    entry.solid = undefined
    if (entry.solidKey) { releaseExtrusion(entry.solidKey); entry.solidKey = undefined }
  }
  if (!entry.solid) {
    const material = makeLitMaterial(params.kind)
    material.alphaTest = 0
    material.polygonOffset = false
    entry.solid = new Mesh(new BufferGeometry(), material)
    entry.solid.matrixAutoUpdate = false
    entry.solid.frustumCulled = false
    view.root.add(entry.solid)
    entry.solidKind = params.kind
  }
  const outlineKey = [entry.key, JSON.stringify(entry.spec.rect), spec.fit, plane.layer.kind === 'text' ? outlineFontsRevision() : 0].join('|')
  const key = [outlineKey, spec.depth, spec.bevel, spec.bevelSegments].join('|')
  if (entry.solidKey !== key) {
    const geometry = acquireExtrusion(outlineKey, key, plane, entry.canvas, entry.spec.rect, spec)
    if (entry.solidKey) releaseExtrusion(entry.solidKey)
    entry.solid.geometry = geometry
    entry.solidKey = key
  }
  const material = entry.solid.material
  applyParameters(material, params)
  // Default side colour uses the first visible solid fill, or the text colour; picture-only layers use neutral grey.
  const fills = plane.node.resolved.fills ?? ('fills' in plane.layer ? plane.layer.fills : [])
  const fill = fills.find(f => f.enabled && f.type === 'solid')
  // Text without a solid fill paints in its style's colour.
  const textColor = plane.node.kind === 'leaf' && plane.layer.kind === 'text' ? (plane.node.resolved.style ?? plane.layer.style).color : undefined
  const color = spec.sideColor ?? (fill && fill.type === 'solid' ? fill.color : textColor ?? '#c9cbd1')
  material.color.set(color.slice(0, 7))
  if (!spec.sideColor) material.color.multiplyScalar(0.62)
  material.side = DoubleSide
  material.opacity = plane.opacity
  material.transparent = plane.opacity < 1
  entry.solid.castShadow = frame.render.shadows
  entry.solid.receiveShadow = frame.render.shadows
  entry.solid.renderOrder = plane.order
  entry.solid.matrix.fromArray(plane.matrix)
  entry.solid.matrixWorldNeedsUpdate = true
}

/** What a plane's material does this frame: its opacity and stacking, the world's mist, and (lit) its material's values and shadows. */
function updateMaterial(entry: Entry, plane: WorldPlane, frame: WorldFrame): void {
  const material = entry.mesh.material
  material.polygonOffsetFactor = 0
  material.polygonOffsetUnits = -2 * plane.order
  if (material instanceof ShaderMaterial) {
    const u = material.uniforms
    u.uOpacity!.value = plane.opacity
    const fog = fogParameters(frame.fog)
    u.uFog!.value = fog ? 1 : 0
    if (fog) {
      // An unlit picture is in the output's own values, so the mist colour is too.
      const [r, g, b] = rawRgb(fog.color)
      u.uFogColor!.value.setRGB(r, g, b)
      u.uFogNear!.value = fog.near
      u.uFogFar!.value = fog.far
    }
    return
  }
  if (plane.material || plane.layer.extrude) applyParameters(material as LitMaterial, materialParameters(plane.material ?? DEFAULT_MATERIAL))
  material.opacity = plane.opacity
  entry.mesh.castShadow = frame.render.shadows
  entry.mesh.receiveShadow = frame.render.shadows
}

/** A hex colour's channels as 0 to 1 numbers, with no colour conversion. */
function rawRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1, 7), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

function axesOf(m: ArrayLike<number>): [Vector3, Vector3, Vector3] {
  const axis = (c: number) => new Vector3(m[c * 4] as number, m[c * 4 + 1] as number, m[c * 4 + 2] as number).normalize()
  return [axis(0), axis(1), axis(2)]
}

/** The world's look for this frame: tone mapping, exposure, shadows, mist, lights and the environment. */
function setLook(gl: WebGLRenderer, view: View, frame: WorldFrame, fog: ReturnType<typeof fogParameters>): void {
  const { scene } = view
  const { render } = frame
  gl.toneMapping = TONE_MAPPING[render.toneMapping]
  gl.toneMappingExposure = exposureOf(render.exposure)
  gl.shadowMap.enabled = render.shadows
  scene.fog = fog ? new Fog(new Color(fog.color), fog.near, fog.far) : null
  syncLights(view.rig, scene, frame.lights, { shadows: render.shadows, shadowQuality: render.shadowQuality, bounds: boundsOf(view.root) }, tick)

  // The first environment light that is on is the world's environment.
  const env = frame.lights.find((l) => l.light.type === 'environment' && l.light.intensity > 0)
  if (!env) {
    scene.environment = null
    scene.background = null
    return
  }
  const map = environmentsOf(gl).get(env.light.environment)
  // The light's own turns spin the environment; the studio room is built Y up, so it is stood upright first.
  const turned = new Matrix4().makeBasis(...axesOf(env.matrix))
  if (!map.zUp) turned.multiply(new Matrix4().makeRotationX(Math.PI / 2))
  const rotation = new Euler().setFromRotationMatrix(turned)
  scene.environment = map.texture
  scene.environmentIntensity = env.light.intensity
  scene.environmentRotation.copy(rotation)
  if (env.light.showBackground) {
    scene.background = map.texture
    scene.backgroundIntensity = env.light.intensity
    scene.backgroundRotation.copy(rotation)
  } else scene.background = null
}

/** Where a plane's origin lands in output pixels. */
function planeOrigin(frame: WorldFrame, plane: WorldPlane, scale: number): [number, number] {
  const p = projectLocal(frame, plane, 0, 0)
  return p ? [p[0] * scale, p[1] * scale] : [Number.NaN, Number.NaN]
}

/** Lets go of every texture and scene a host holds (the host is going away). */
export function releaseWorlds(host: WorldHost): void {
  const byComp = views.get(host)
  if (!byComp) return
  for (const view of byComp.values()) disposeView(view)
  views.delete(host)
}
