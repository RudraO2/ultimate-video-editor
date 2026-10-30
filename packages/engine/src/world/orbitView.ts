import { type Comp, type Layer, type Vec3, worldObjects } from '@uve/core'
import { Box3, DoubleSide, Euler, Matrix4, type Material, type Mesh, MeshStandardMaterial, type Scene, Vector3 } from 'three'
import { type Bounds3, orbitCamera, type OrbitRenderOptions, type OrbitShading, type OrbitView } from '../orbit'
import type { SceneSource } from '../scene'
import { buildWorldFrame, type FrameCamera, type WorldFrame } from './frame'
import { OrbitHelpers } from './helpers'
import type { WorldHost } from './host'
import { type DrawHooks, drawWorld, environmentsOf, peekView, type View } from './stage'
import { WORLD_UNIT } from './threeCamera'

// The orbit view: a world drawn through an editor camera instead of the
// document's, for the viewport. It draws in a scene of its own (the key
// `<comp>#orbit` in stage.ts), so it never changes what the camera view draws
// or exports. How the view shades the world follows AtomCut's viewport:
//   solid    every mesh and model in its fill colour on a plain standard
//            material, lit only by the studio room (strength 0.9); no scene
//            lights, shadows, mist, floor or post effects;
//   material the real materials, the same room at 1.0, nothing else of the scene;
//   rendered everything the world does, but no depth of field or motion blur.
// Pictures draw as they always do. The grid, gizmos, selection and paths are
// drawn over the finished picture (helpers.ts).

/** The studio room's strength as the only light of Solid, and of Material. */
export const SOLID_ENVIRONMENT = 0.9
export const MATERIAL_ENVIRONMENT = 1
/** The plain material of Solid. */
export const SOLID_ROUGHNESS = 0.7

/** The key of a comp's orbit scene in stage.ts. */
export const orbitKey = (comp: Pick<Comp, 'id'>): string => `${comp.id}#orbit`

/** The moment a world is read at: a static comp shows its still moment whatever time is asked. */
export const worldTime = (comp: Comp, timeMs: number): number => (comp.mode === 'static' ? Math.min(comp.stillMs, comp.durationMs) : timeMs)

/** The orbit camera as the world renderer's camera: no depth of field, no shutter. */
export function orbitFrameCamera(view: OrbitView, comp: Pick<Comp, 'width' | 'height'>): FrameCamera {
  const { matrix, spec } = orbitCamera(view, comp.width, comp.height)
  const { projection, focalLength, sensorWidth, orthoScale, shiftX, shiftY, clipStart, clipEnd } = spec
  return { id: 'orbit', matrix, lens: { projection, focalLength, sensorWidth, orthoScale, shiftX, shiftY, clipStart, clipEnd } }
}

/**
 * A world frame as the orbit view draws it: seen from the orbit camera, and
 * for Solid and Material with the scene's lights, shadows, mist, floor, bloom
 * and ambient occlusion left out (the studio room lights it instead: see
 * `shadeOrbit`).
 */
export function orbitFrame(frame: WorldFrame, view: OrbitView, shading: OrbitShading): WorldFrame {
  const camera = orbitFrameCamera(view, frame.comp)
  if (shading === 'rendered') return { ...frame, camera }
  const { render, fog } = frame
  return {
    ...frame,
    camera,
    lights: [],
    fog: { ...fog, enabled: false },
    render: { ...render, shadows: false, bloom: { ...render.bloom, enabled: false }, ao: { ...render.ao, enabled: false }, floor: { ...render.floor, mode: 'none' } },
  }
}

/** What the orbit view keeps for one comp. */
interface Rig {
  helpers: OrbitHelpers
  /** Solid's materials, one per mesh layer. */
  solids: Map<string, MeshStandardMaterial>
  shading: OrbitShading | null
}

const rigs = new WeakMap<WorldHost, Map<string, Rig>>()

function rigOf(host: WorldHost, compId: string): Rig {
  let byComp = rigs.get(host)
  if (!byComp) rigs.set(host, (byComp = new Map()))
  let rig = byComp.get(compId)
  if (!rig) byComp.set(compId, (rig = { helpers: new OrbitHelpers(), solids: new Map(), shading: null }))
  return rig
}

/** Lets go of everything the orbit views of a host hold. */
export function releaseOrbit(host: WorldHost): void {
  const byComp = rigs.get(host)
  if (!byComp) return
  for (const rig of byComp.values()) {
    rig.helpers.dispose()
    for (const m of rig.solids.values()) m.dispose()
  }
  rigs.delete(host)
}

/** The studio room is built Y up: turned upright for the Z-up world, as stage.ts does for an environment light. */
const UPRIGHT = new Euler().setFromRotationMatrix(new Matrix4().makeRotationX(Math.PI / 2))

/** Every material of a scene must be looked at again (the lights or the environment changed). */
function refreshMaterials(scene: Scene): void {
  scene.traverse((object) => {
    const material = (object as Mesh).material as Material | Material[] | undefined
    if (!material) return
    for (const m of Array.isArray(material) ? material : [material]) m.needsUpdate = true
  })
}

/**
 * Brings the orbit scene to the shading for one draw and returns how to put
 * it back (the scene is made again from the document on the next frame, so
 * only the material swaps need undoing).
 */
function shadeOrbit(rig: Rig, shading: OrbitShading): NonNullable<DrawHooks['shade']> {
  return (view: View, prepared, frame) => {
    const { scene } = view
    const plain = shading !== 'rendered'
    view.rig.ambient.visible = !plain
    if (plain) {
      const map = environmentsOf(prepared.gl).get('studio')
      scene.environment = map.texture
      scene.environmentIntensity = shading === 'solid' ? SOLID_ENVIRONMENT : MATERIAL_ENVIRONMENT
      scene.environmentRotation.copy(UPRIGHT)
      scene.background = null
    }
    if (rig.shading !== shading) {
      rig.shading = shading
      refreshMaterials(scene)
    }
    // Pushed back a little, so the crease lines of a selected mesh show on its surface.
    for (const entry of view.meshes.values()) {
      const m = entry.mesh.material
      m.polygonOffset = true
      m.polygonOffsetFactor = 1
      m.polygonOffsetUnits = 1
    }
    const restores: (() => void)[] = []
    if (shading === 'solid') {
      const seen = new Set<string>()
      for (const item of frame.meshes) {
        seen.add(item.id)
        let material = rig.solids.get(item.id)
        if (!material) rig.solids.set(item.id, (material = new MeshStandardMaterial({ roughness: SOLID_ROUGHNESS, metalness: 0 })))
        material.color.set(item.color.slice(0, 7))
        material.opacity = item.opacity
        material.transparent = item.opacity < 1
        const entry = view.meshes.get(item.id)
        if (entry) {
          const original = entry.mesh.material
          material.side = original.side
          material.polygonOffset = true
          material.polygonOffsetFactor = 1
          material.polygonOffsetUnits = 1
          // Only this scene's meshes are swapped, and put back after the draw.
          const mesh: Mesh = entry.mesh
          mesh.material = material
          restores.push(() => (mesh.material = original))
          continue
        }
        const model = view.models.get(item.id)
        if (!model) continue
        material.side = DoubleSide
        for (const mesh of model.instance.meshes) {
          const original = mesh.material
          mesh.material = material
          restores.push(() => (mesh.material = original))
        }
      }
      for (const [id, material] of rig.solids) {
        if (!seen.has(id)) {
          material.dispose()
          rig.solids.delete(id)
        }
      }
    }
    return () => {
      for (const restore of restores) restore()
    }
  }
}

/**
 * Draws a world through the orbit view onto the shared canvas and returns it
 * (draw it over the viewport right away); null when WebGL is not available.
 */
export function renderOrbit(host: WorldHost, comp: Comp, source: SceneSource, timeMs: number, width: number, height: number, options: OrbitRenderOptions): OffscreenCanvas | null {
  const frame = orbitFrame(buildWorldFrame(comp, source, timeMs), options.view, options.shading)
  const rig = rigOf(host, comp.id)
  const t = worldTime(comp, timeMs)
  const hooks: DrawHooks = {
    viewKey: orbitKey(comp),
    shade: shadeOrbit(rig, options.shading),
    overlay: (gl, camera, depthKept) => {
      rig.helpers.sync({ comp, frame, timeMs: t, objects: worldObjects(comp, t), options, view: peekView(host, orbitKey(comp)) })
      rig.helpers.draw(gl, camera, depthKept)
    },
  }
  return drawWorld(host, frame, width, height, undefined, hooks)
}

// ---------------------------------------------------------------------------
// Bounds, for framing
// ---------------------------------------------------------------------------

/**
 * The world bounds of layers at a time: pictures by their boxes, meshes by
 * their geometry and models by their loaded file (a mesh that has not been
 * drawn yet counts as its origin). All pictures, meshes and models when `ids`
 * is omitted; cameras, lights and controllers count as their origin, and only
 * when `ids` names them. Null when there is nothing.
 */
export function orbitBounds(host: WorldHost, comp: Comp, source: SceneSource, timeMs: number, ids?: readonly string[]): Bounds3 | null {
  const t = worldTime(comp, timeMs)
  const frame = buildWorldFrame(comp, source, timeMs)
  const view = peekView(host, orbitKey(comp))
  const wanted = (id: string) => !ids || ids.includes(id)
  const box = new Box3()
  const add = (p: readonly number[]) => box.expandByPoint(new Vector3(p[0] as number, p[1] as number, p[2] as number))
  for (const plane of frame.planes) {
    if (!wanted(plane.id)) continue
    const { left, top, width, height } = plane.local
    const m = plane.matrix
    for (const [x, y] of [[left, top], [left + width, top], [left + width, top + height], [left, top + height]] as const) {
      add([(m[0] as number) * x + (m[4] as number) * y + (m[12] as number), (m[1] as number) * x + (m[5] as number) * y + (m[13] as number), (m[2] as number) * x + (m[6] as number) * y + (m[14] as number)])
    }
  }
  for (const item of frame.meshes) {
    if (!wanted(item.id)) continue
    const entry = view?.meshes.get(item.id)
    const model = view?.models.get(item.id)
    if (entry) {
      const geometry = entry.mesh.geometry
      geometry.computeBoundingBox()
      if (geometry.boundingBox) box.union(geometry.boundingBox.clone().applyMatrix4(new Matrix4().fromArray(item.matrix)))
    } else if (model) {
      const world = new Box3().setFromObject(model.instance.group)
      if (!world.isEmpty()) {
        add([world.min.x / WORLD_UNIT, world.min.y / WORLD_UNIT, world.min.z / WORLD_UNIT])
        add([world.max.x / WORLD_UNIT, world.max.y / WORLD_UNIT, world.max.z / WORLD_UNIT])
      }
    } else add([item.matrix[12] as number, item.matrix[13] as number, item.matrix[14] as number])
  }
  if (ids) {
    for (const object of worldObjects(comp, t)) {
      if (ids.includes(object.layer.id) && isMarker(object.layer)) add(object.position)
    }
  }
  if (box.isEmpty()) return null
  return { min: [box.min.x, box.min.y, box.min.z] as Vec3, max: [box.max.x, box.max.y, box.max.z] as Vec3 }
}

const isMarker = (layer: Layer): boolean => layer.kind === 'camera' || layer.kind === 'light' || layer.kind === 'empty'
