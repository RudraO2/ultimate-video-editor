import type { WorldMat4 } from '@uve/core'
import {
  AmbientLight,
  Box3,
  DirectionalLight,
  HemisphereLight,
  type Light,
  Matrix4,
  type Object3D,
  PointLight,
  RectAreaLight,
  type Scene,
  Sphere,
  SpotLight,
  Vector3,
} from 'three'
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js'
import type { FrameLight } from './frame'
import { AMBIENT_INTENSITY, areaSize, lightDistance, SHADOW_BIAS, SHADOW_MAP_SIZE, SHADOW_NORMAL_BIAS, spotCone, threeIntensity } from './lighting'
import { WORLD_UNIT } from './threeCamera'

// The three.js lights of a world: one per light layer (environment lights are
// not lights: see environment.ts), kept between frames so shadow maps are not
// remade each time. Lights are placed in three units (px × 0.01) straight in
// the scene; their scale is ignored.

type Kind = 'point' | 'spot' | 'sun' | 'area' | 'hemisphere'

interface Entry {
  kind: Kind
  light: Light
  /** Where a spot or sun aims. */
  target?: Object3D
  used: number
}

/** The lights of one world view. */
export interface LightRig {
  ambient: AmbientLight
  entries: Map<string, Entry>
  used: number
}

let uniformsReady = false

export function makeRig(scene: Scene): LightRig {
  if (!uniformsReady) {
    RectAreaLightUniformsLib.init()
    uniformsReady = true
  }
  const ambient = new AmbientLight(0xffffff, AMBIENT_INTENSITY)
  scene.add(ambient)
  return { ambient, entries: new Map(), used: 0 }
}

function dispose(entry: Entry, scene: Scene): void {
  scene.remove(entry.light)
  if (entry.target) scene.remove(entry.target)
  ;(entry.light as { shadow?: { dispose(): void } }).shadow?.dispose()
  entry.light.dispose()
}

export function disposeRig(rig: LightRig, scene: Scene): void {
  for (const entry of rig.entries.values()) dispose(entry, scene)
  rig.entries.clear()
  scene.remove(rig.ambient)
}

const make = (kind: Kind): Light => {
  switch (kind) {
    case 'point':
      return new PointLight(0xffffff, 1, 0, 2)
    case 'spot':
      return new SpotLight(0xffffff, 1, 0, Math.PI / 8, 0, 2)
    case 'sun':
      return new DirectionalLight(0xffffff, 1)
    case 'area':
      return new RectAreaLight(0xffffff, 1, 1, 1)
    case 'hemisphere':
      return new HemisphereLight(0xffffff, 0x444444, 1)
  }
}

/** A light's position (px), the way it shines (-Z) and its axes, from its world matrix. */
function pose(matrix: WorldMat4): { position: Vector3; forward: Vector3; basis: Matrix4 } {
  const axis = (c: number) => new Vector3(matrix[c * 4] as number, matrix[c * 4 + 1] as number, matrix[c * 4 + 2] as number).normalize()
  const [x, y, z] = [axis(0), axis(1), axis(2)]
  return {
    position: new Vector3(matrix[12] as number, matrix[13] as number, matrix[14] as number),
    forward: z.clone().negate(),
    basis: new Matrix4().makeBasis(x, y, z),
  }
}

export interface LightSettings {
  shadows: boolean
  shadowQuality: keyof typeof SHADOW_MAP_SIZE
  /** The bounds of what is drawn, for fitting a sun's shadow (three units). */
  bounds: Sphere
}

/** Brings the rig's lights to the world's light layers at this moment. */
export function syncLights(rig: LightRig, scene: Scene, frame: readonly FrameLight[], settings: LightSettings, tick: number): void {
  const size = SHADOW_MAP_SIZE[settings.shadowQuality]
  const radius = Math.max(settings.bounds.radius, 0.5)
  for (const { id, light: spec, matrix } of frame) {
    if (spec.type === 'environment') continue
    const kind = spec.type as Kind
    let entry = rig.entries.get(id)
    if (entry && entry.kind !== kind) {
      dispose(entry, scene)
      rig.entries.delete(id)
      entry = undefined
    }
    if (!entry) {
      const light = make(kind)
      entry = { kind, light, used: tick }
      if (kind === 'spot' || kind === 'sun') {
        entry.target = (light as SpotLight | DirectionalLight).target
        scene.add(entry.target)
      }
      scene.add(light)
      rig.entries.set(id, entry)
    }
    entry.used = tick
    const { light } = entry
    const { position, forward, basis } = pose(matrix)
    const at = position.clone().multiplyScalar(WORLD_UNIT)
    const intensity = threeIntensity(spec)
    light.color.set(spec.color.slice(0, 7))
    light.intensity = intensity
    const casts = settings.shadows && spec.castShadow
    switch (kind) {
      case 'point': {
        const point = light as PointLight
        point.position.copy(at)
        point.distance = lightDistance(spec.range)
        point.decay = 2
        shadow(point, casts, size, spec.shadowSoftness, 0.05, shadowFar(spec.range, at, settings.bounds))
        break
      }
      case 'spot': {
        const spot = light as SpotLight
        spot.position.copy(at)
        spot.target.position.copy(at).addScaledVector(forward, 10)
        spot.distance = lightDistance(spec.range)
        spot.decay = 2
        Object.assign(spot, spotCone(spec.spotAngle, spec.spotBlend))
        shadow(spot, casts, size, spec.shadowSoftness, 0.05, shadowFar(spec.range, at, settings.bounds))
        break
      }
      case 'sun': {
        const sun = light as DirectionalLight
        sun.target.position.copy(settings.bounds.center)
        sun.position.copy(settings.bounds.center).addScaledVector(forward, -radius * 2)
        shadow(sun, casts, size, spec.shadowSoftness, radius * 0.5, radius * 3.5)
        const camera = sun.shadow.camera
        camera.left = -radius
        camera.right = radius
        camera.top = radius
        camera.bottom = -radius
        camera.updateProjectionMatrix()
        break
      }
      case 'area': {
        const area = light as RectAreaLight
        area.position.copy(at)
        area.quaternion.setFromRotationMatrix(basis)
        area.width = areaSize(spec.width)
        area.height = areaSize(spec.height)
        break
      }
      case 'hemisphere': {
        const hemi = light as HemisphereLight
        hemi.position.set(0, 0, 1)
        hemi.groundColor.set(spec.groundColor.slice(0, 7))
        // Hemisphere light's "up" is its position direction: the world is Z up.
        break
      }
    }
  }
  for (const [id, entry] of rig.entries) {
    if (entry.used !== tick) {
      dispose(entry, scene)
      rig.entries.delete(id)
    }
  }
}

/** A point or spot shadow's far plane: the light's range, or past everything it can see. */
function shadowFar(rangePx: number, at: Vector3, bounds: Sphere): number {
  if (rangePx > 0) return rangePx * WORLD_UNIT
  return Math.max(1, at.distanceTo(bounds.center) + Math.max(bounds.radius, 0.5)) * 1.5
}

function shadow(light: PointLight | SpotLight | DirectionalLight, on: boolean, size: number, softness: number, near: number, far: number): void {
  light.castShadow = on
  if (!on) return
  const s = light.shadow
  if (s.mapSize.x !== size) {
    s.map?.dispose()
    s.map = null
    s.mapSize.set(size, size)
  }
  s.bias = SHADOW_BIAS
  s.normalBias = SHADOW_NORMAL_BIAS
  s.radius = softness
  s.camera.near = near
  s.camera.far = far
  if (!(light instanceof DirectionalLight)) s.camera.updateProjectionMatrix()
}

/** The bounds of a scene's drawn objects, in three units; a unit sphere at the origin when nothing is there. */
export function boundsOf(root: Object3D): Sphere {
  root.updateMatrixWorld(true)
  const box = new Box3().setFromObject(root)
  return box.isEmpty() ? new Sphere(new Vector3(), 1) : box.getBoundingSphere(new Sphere())
}

