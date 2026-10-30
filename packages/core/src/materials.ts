import { evaluateProperty, propertiesOf } from './properties'
import { type Layer, MaterialSchema, type MaterialSpec } from './schema'

// Material presets for 3D worlds. The values are AtomCut's preset data
// (ported with permission); applying one merges it over the defaults, and a
// colour in the preset tints the picture (`color`).

export interface MaterialPreset {
  id: string
  /** What it looks like and what it is for. */
  use: string
  /** The fields it sets; the rest stay at their defaults. */
  values: Partial<Omit<MaterialSpec, 'preset'>>
}

export const MATERIAL_PRESETS: readonly MaterialPreset[] = [
  { id: 'plastic', use: 'Glossy moulded plastic', values: { roughness: 0.25, clearcoat: 0.3, clearcoatRoughness: 0.1 } },
  { id: 'matte', use: 'Plain, dull surface', values: { roughness: 0.85 } },
  { id: 'clay', use: 'Soft terracotta clay', values: { color: '#c9a48a', roughness: 0.95, sheen: 0.2 } },
  { id: 'ceramic', use: 'Glazed porcelain', values: { color: '#f2f0ea', roughness: 0.15, clearcoat: 1, clearcoatRoughness: 0.05 } },
  { id: 'rubber', use: 'Dark soft rubber', values: { color: '#2a2a2c', roughness: 0.75, sheen: 0.4 } },
  { id: 'metal', use: 'Brushed grey metal', values: { color: '#b8bcc4', roughness: 0.35, metalness: 1 } },
  { id: 'chrome', use: 'Mirror-bright chrome', values: { color: '#e8ebf0', roughness: 0.04, metalness: 1 } },
  { id: 'gold', use: 'Polished gold', values: { color: '#f5c46b', roughness: 0.18, metalness: 1 } },
  { id: 'copper', use: 'Warm copper', values: { color: '#e0916b', roughness: 0.25, metalness: 1 } },
  { id: 'carpaint', use: 'Red car paint under a clear coat', values: { color: '#c4202f', roughness: 0.45, metalness: 0.6, clearcoat: 1, clearcoatRoughness: 0.03 } },
  { id: 'glass', use: 'Clear glass', values: { roughness: 0.02, transmission: 1, ior: 1.5, thickness: 20 } },
  { id: 'frosted', use: 'Frosted glass', values: { roughness: 0.4, transmission: 1, ior: 1.5, thickness: 20 } },
  { id: 'velvet', use: 'Purple velvet cloth', values: { color: '#5b2a86', roughness: 0.9, sheen: 1 } },
  { id: 'pearl', use: 'Iridescent pearl', values: { color: '#f4efe8', roughness: 0.2, metalness: 0.1, iridescence: 1, clearcoat: 0.6 } },
  { id: 'neon', use: 'Glowing pink neon', values: { color: '#ff2fb1', roughness: 0.4, emission: '#ff2fb1', emissionStrength: 4 } },
  { id: 'toon', use: 'Cartoon shading in bands of light', values: { model: 'toon', toonSteps: 3 } },
  { id: 'flat', use: 'Unlit: the picture as it is, ignoring lights', values: { model: 'unlit' } },
]

export const MATERIAL_PRESET_IDS: readonly string[] = MATERIAL_PRESETS.map((p) => p.id)

export function findMaterialPreset(id: string): MaterialPreset | undefined {
  return MATERIAL_PRESETS.find((p) => p.id === id.toLowerCase())
}

/** The material a preset makes: its values over the defaults, then `over` on top. */
export function applyMaterialPreset(id: string, over: Partial<MaterialSpec> = {}): MaterialSpec {
  const preset = findMaterialPreset(id)
  if (!preset) throw new Error(`No material preset "${id}"`)
  return MaterialSchema.parse({ ...preset.values, ...over, preset: preset.id })
}

/** The material fields that key, by path (`material.roughness`, …). */
export const MATERIAL_KEYS = ['roughness', 'metalness', 'emissionStrength', 'emission', 'transmission'] as const

/** A layer's material at a layer time, with its keyed fields sampled; undefined when it has none (an unlit picture). */
export function materialAt(layer: Layer, layerTimeMs: number): MaterialSpec | undefined {
  const { material } = layer
  if (!material) return undefined
  if (!Object.keys(layer.animations).some((path) => path.startsWith('material.'))) return material
  const now: MaterialSpec = { ...material }
  for (const spec of propertiesOf(layer)) {
    if (!spec.path.startsWith('material.') || (layer.animations[spec.path]?.length ?? 0) === 0) continue
    const value = evaluateProperty(layer, spec, layerTimeMs)
    const key = spec.path.slice('material.'.length) as (typeof MATERIAL_KEYS)[number]
    if (typeof value === 'number' && key !== 'emission') (now as Record<string, unknown>)[key] = Math.min(spec.max ?? Infinity, Math.max(spec.min ?? -Infinity, value))
    else if (typeof value === 'string' && key === 'emission') now.emission = value
  }
  return now
}

/** Takes a layer's material off, and its keys with it. */
export function stripMaterial(layer: { material?: unknown; animations: Record<string, unknown> }): void {
  delete layer.material
  for (const path of Object.keys(layer.animations)) if (path.startsWith('material.')) delete layer.animations[path]
}
