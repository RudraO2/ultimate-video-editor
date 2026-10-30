import type { LightSpec, MaterialSpec, World } from '@uve/core'
import { ACESFilmicToneMapping, AgXToneMapping, NeutralToneMapping, NoToneMapping, type ToneMapping } from 'three'
import { WORLD_UNIT } from './threeCamera'

// The numbers behind the world's lighting: how a light's watts and strengths
// become three.js intensities, shadow and tone settings, and how a material
// becomes three's parameters. Everything here is plain data and arithmetic
// (no GL context), so the tests run in node; `stage.ts` and `lights.ts` build
// the actual three objects from these.

/** The ambient light every lit scene gets, so nothing is pitch black. */
export const AMBIENT_INTENSITY = 0.03

/** Point and spot lights are given in watts; three wants candela (W / 4π). */
export const candela = (watts: number): number => watts / (4 * Math.PI)

/** A point or spot light's range in three units (0 is endless). */
export const lightDistance = (rangePx: number): number => rangePx * WORLD_UNIT

/** A spot's cone: three takes the half angle in radians; blend is its penumbra. */
export function spotCone(spotAngle: number, spotBlend: number): { angle: number; penumbra: number } {
  return { angle: ((spotAngle / 2) * Math.PI) / 180, penumbra: spotBlend }
}

/** A rectangular light's intensity: watts over the panel's area in m² (1 px is 1 cm), over π, over 4. */
export const areaIntensity = (watts: number, widthPx: number, heightPx: number): number => watts / (Math.PI * widthPx * heightPx * 1e-4) / 4

/** A rectangular light's size in three units. */
export const areaSize = (px: number): number => px * WORLD_UNIT

export const SHADOW_MAP_SIZE = { low: 512, medium: 1024, high: 2048 } as const

export const SHADOW_BIAS = -4e-4
export const SHADOW_NORMAL_BIAS = 0.02

export const TONE_MAPPING: Record<World['render']['toneMapping'], ToneMapping> = {
  agx: AgXToneMapping,
  aces: ACESFilmicToneMapping,
  neutral: NeutralToneMapping,
  none: NoToneMapping,
}

/** Exposure in stops to the renderer's multiplier. */
export const exposureOf = (stops: number): number => 2 ** stops

/** Linear fog in three units from the world's mist (px from the camera), or null when it is off. */
export function fogParameters(fog: World['fog']): { color: string; near: number; far: number } | null {
  if (!fog.enabled) return null
  return { color: fog.color.slice(0, 7), near: fog.start * WORLD_UNIT, far: Math.max(fog.end, fog.start + 1) * WORLD_UNIT }
}

/** What a light layer is, sampled at a moment (keyed intensity and colour applied). */
export type LightSample = Pick<LightSpec, 'type' | 'range' | 'spotAngle' | 'spotBlend' | 'width' | 'height' | 'groundColor' | 'castShadow' | 'shadowSoftness' | 'environment' | 'showBackground'> & {
  intensity: number
  color: string
}

/** How a light's strength reaches three: the intensity to set on its three.js light (environment lights are not three lights). */
export function threeIntensity(light: LightSample): number {
  switch (light.type) {
    case 'point':
    case 'spot':
      return candela(light.intensity)
    case 'area':
      return areaIntensity(light.intensity, light.width, light.height)
    default:
      return light.intensity
  }
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

/** Which three.js material a material model becomes. */
export type MaterialKind = 'physical' | 'toon' | 'basic'

export interface MaterialParameters {
  kind: MaterialKind
  /** The fields to set on the three.js material (colours as hex strings). */
  values: Record<string, number | string | boolean>
  /** Toon: the number of bands of the gradient map. */
  toonSteps?: number
  doubleSided: boolean
}

export const KIND_OF_MODEL: Record<MaterialSpec['model'], MaterialKind> = { pbr: 'physical', toon: 'toon', unlit: 'basic' }

/**
 * A material as three's parameters. Thickness is in px (three: units, so ×
 * 0.01). The colour tints the picture, which is the material's map; white
 * when there is no tint. Emission is the colour times its strength.
 */
export function materialParameters(material: MaterialSpec): MaterialParameters {
  const kind = KIND_OF_MODEL[material.model]
  const color = (material.color ?? '#ffffff').slice(0, 7)
  const base = { color }
  const emissive = { emissive: material.emission.slice(0, 7), emissiveIntensity: material.emissionStrength }
  if (kind === 'basic') return { kind, values: base, doubleSided: material.doubleSided }
  if (kind === 'toon') return { kind, values: { ...base, ...emissive }, toonSteps: material.toonSteps, doubleSided: material.doubleSided }
  return {
    kind,
    values: {
      ...base,
      ...emissive,
      roughness: material.roughness,
      metalness: material.metalness,
      transmission: material.transmission,
      ior: material.ior,
      thickness: material.thickness * WORLD_UNIT,
      clearcoat: material.clearcoat,
      clearcoatRoughness: material.clearcoatRoughness,
      sheen: material.sheen,
      sheenRoughness: 0.5,
      sheenColor: '#ffffff',
      iridescence: material.iridescence,
    },
    doubleSided: material.doubleSided,
  }
}

/** A toon material's gradient: one grey level per band, from dark to light. */
export function toonGradient(steps: number): Uint8Array {
  const n = Math.max(2, Math.round(steps))
  return Uint8Array.from({ length: n }, (_, i) => Math.round((255 * (i + 1)) / n))
}

/** Whether two materials need the same three.js material (only their fields change, so it is updated in place). */
export const sameKind = (a: MaterialSpec | undefined, b: MaterialSpec | undefined): boolean =>
  (a === undefined) === (b === undefined) && (a === undefined || KIND_OF_MODEL[a.model] === KIND_OF_MODEL[(b as MaterialSpec).model])
