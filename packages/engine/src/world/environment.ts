import { type EnvironmentPreset, SKY_PRESETS, type SkyPreset } from '@uve/core'
import {
  BackSide,
  Color,
  Mesh,
  MeshBasicMaterial,
  PMREMGenerator,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  type Texture,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

// Environments: the surroundings that light a world and show in reflections.
// `studio` is three's lit room; the others are gradient skies (top, horizon,
// bottom) with a sun disc, built as a small scene and baked once by PMREM.
// The world is Z up; the sky is built that way, three's room is Y up.

const rad = (deg: number) => (deg * Math.PI) / 180

/** The unit direction of a sky's sun: elevation above the horizon and azimuth round it (0 toward +Y), degrees, Z up. */
export function sunDirection(elevation: number, azimuth: number): [number, number, number] {
  const el = rad(elevation)
  const az = rad(azimuth)
  return [Math.cos(el) * Math.sin(az), Math.cos(el) * Math.cos(az), Math.sin(el)]
}

/**
 * A sky's colour looking along a direction with height `z` (−1 down, 0 the
 * horizon, 1 up): the horizon colour meets the top above it and the bottom
 * below it, easing quickly away from the horizon. Linear colours; the shader
 * does the same.
 */
export function skyColor(sky: Pick<SkyPreset, 'top' | 'horizon' | 'bottom'>, z: number): [number, number, number] {
  const k = Math.min(1, Math.abs(z)) ** 0.6
  const from = new Color(sky.horizon)
  const to = new Color(z >= 0 ? sky.top : sky.bottom)
  const mixed = from.lerp(to, k)
  return [mixed.r, mixed.g, mixed.b]
}

const SKY_VERTEX = `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`

const SKY_FRAGMENT = `
uniform vec3 top;
uniform vec3 horizon;
uniform vec3 bottom;
varying vec3 vDir;
void main() {
  float z = clamp(vDir.z, -1.0, 1.0);
  float k = pow(abs(z), 0.6);
  vec3 c = mix(horizon, z >= 0.0 ? top : bottom, k);
  gl_FragColor = vec4(c, 1.0);
}`

/** A sky as a scene to bake: a gradient sphere round the origin and a bright sun disc. */
export function skyScene(sky: SkyPreset): Scene {
  const scene = new Scene()
  const dome = new Mesh(
    new SphereGeometry(50, 48, 24),
    new ShaderMaterial({
      uniforms: { top: { value: new Color(sky.top) }, horizon: { value: new Color(sky.horizon) }, bottom: { value: new Color(sky.bottom) } },
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      side: BackSide,
      depthWrite: false,
    }),
  )
  scene.add(dome)
  if (sky.sun) {
    const colour = new Color(sky.sun.color).multiplyScalar(sky.sun.strength)
    const disc = new Mesh(new SphereGeometry(40 * Math.tan(rad(3)), 16, 8), new MeshBasicMaterial({ color: colour }))
    const [x, y, z] = sunDirection(sky.sun.elevation, sky.sun.azimuth)
    disc.position.set(x * 40, y * 40, z * 40)
    scene.add(disc)
  }
  return scene
}

export interface EnvironmentMap {
  texture: Texture
  /** True when the map is built Z up like the world; false for the Y-up studio room (it is turned upright with the world). */
  zUp: boolean
}

/** Baked environments for one WebGL renderer, one per preset, made on first use. */
export class Environments {
  private readonly baked = new Map<EnvironmentPreset, { target: WebGLRenderTarget; zUp: boolean }>()
  private generator: PMREMGenerator | null = null

  constructor(private readonly renderer: WebGLRenderer) {}

  get(preset: EnvironmentPreset): EnvironmentMap {
    const known = this.baked.get(preset)
    if (known) return { texture: known.target.texture, zUp: known.zUp }
    this.generator ??= new PMREMGenerator(this.renderer)
    let target: WebGLRenderTarget
    let zUp: boolean
    if (preset === 'studio') {
      const room = new RoomEnvironment()
      target = this.generator.fromScene(room, 0.04)
      room.traverse((o) => {
        const mesh = o as Mesh
        mesh.geometry?.dispose()
        ;(mesh.material as { dispose?: () => void } | undefined)?.dispose?.()
      })
      zUp = false
    } else {
      const scene = skyScene(SKY_PRESETS[preset])
      target = this.generator.fromScene(scene, 0, 0.1, 100)
      scene.traverse((o) => {
        const mesh = o as Mesh
        mesh.geometry?.dispose()
        ;(mesh.material as { dispose?: () => void } | undefined)?.dispose?.()
      })
      zUp = true
    }
    this.baked.set(preset, { target, zUp })
    return { texture: target.texture, zUp }
  }

  dispose(): void {
    for (const { target } of this.baked.values()) target.dispose()
    this.baked.clear()
    this.generator?.dispose()
    this.generator = null
  }
}
