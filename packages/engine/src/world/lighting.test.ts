import { LIGHT_INTENSITY, LightSchema, MaterialSchema, SKY_PRESETS, WorldFogSchema, WorldRenderSchema } from '@uve/core'
import { ACESFilmicToneMapping, AgXToneMapping, Color, NeutralToneMapping, NoToneMapping, PointLight, SpotLight } from 'three'
import { describe, expect, it } from 'vitest'
import { skyColor, skyScene, sunDirection } from './environment'
import {
  AMBIENT_INTENSITY,
  areaIntensity,
  areaSize,
  candela,
  exposureOf,
  fogParameters,
  KIND_OF_MODEL,
  lightDistance,
  materialParameters,
  SHADOW_MAP_SIZE,
  spotCone,
  threeIntensity,
  TONE_MAPPING,
  toonGradient,
} from './lighting'
import { applyParameters, litGeometry, makeLitMaterial, makeUnlitMaterial, pictureKind, UNLIT_FRAGMENT, UNLIT_VERTEX } from './pictures'

const light = (over: Record<string, unknown>) => {
  const spec = LightSchema.parse(over)
  return { ...spec, intensity: spec.intensity, color: spec.color }
}

describe('light units', () => {
  it('turns watts into candela at W / 4π and a 1000 W bulb into about 79.6', () => {
    expect(candela(1000)).toBeCloseTo(79.577, 3)
    expect(threeIntensity(light({ type: 'point', intensity: 1500 }))).toBeCloseTo(1500 / (4 * Math.PI), 9)
    expect(threeIntensity(light({ type: 'spot', intensity: 1500 }))).toBeCloseTo(1500 / (4 * Math.PI), 9)
  })

  it('leaves sun, hemisphere and environment strengths as they are', () => {
    for (const type of ['sun', 'hemisphere', 'environment'] as const) {
      expect(threeIntensity(light({ type, intensity: LIGHT_INTENSITY[type] }))).toBe(LIGHT_INTENSITY[type])
    }
  })

  it('gives an area light I / (π · w·h·1e-4) / 4', () => {
    expect(areaIntensity(800, 100, 100)).toBeCloseTo(800 / (Math.PI * 1) / 4, 9)
    expect(threeIntensity(light({ type: 'area', intensity: 800, width: 200, height: 50 }))).toBeCloseTo(800 / (Math.PI * 1) / 4, 9)
    expect(areaSize(250)).toBe(2.5)
  })

  it('scales range to three units (0 stays endless) and halves the spot angle into radians', () => {
    expect(lightDistance(0)).toBe(0)
    expect(lightDistance(2000)).toBe(20)
    expect(spotCone(90, 0.3)).toEqual({ angle: Math.PI / 4, penumbra: 0.3 })
    const spot = new SpotLight()
    Object.assign(spot, spotCone(45, 0.15))
    expect(spot.angle).toBeCloseTo((22.5 * Math.PI) / 180, 9)
    expect(spot.penumbra).toBe(0.15)
    const point = new PointLight()
    point.distance = lightDistance(500)
    expect(point.distance).toBe(5)
  })

  it('has the 0.03 ambient and shadow maps of 512, 1024 and 2048', () => {
    expect(AMBIENT_INTENSITY).toBe(0.03)
    expect(SHADOW_MAP_SIZE).toEqual({ low: 512, medium: 1024, high: 2048 })
  })
})

describe('tone mapping, exposure and mist', () => {
  it('maps the four tone mappings to three constants', () => {
    expect(TONE_MAPPING).toEqual({ agx: AgXToneMapping, aces: ACESFilmicToneMapping, neutral: NeutralToneMapping, none: NoToneMapping })
    expect(TONE_MAPPING[WorldRenderSchema.parse({}).toneMapping]).toBe(AgXToneMapping)
  })

  it('makes exposure 2^stops', () => {
    expect([exposureOf(0), exposureOf(1), exposureOf(-2), exposureOf(0.5)]).toEqual([1, 2, 0.25, Math.SQRT2])
  })

  it('gives linear fog only when enabled, in three units', () => {
    expect(fogParameters(WorldFogSchema.parse({}))).toBeNull()
    expect(fogParameters(WorldFogSchema.parse({ enabled: true, color: '#112233', start: 500, end: 8000 }))).toEqual({ color: '#112233', near: 5, far: 80 })
  })
})

describe('environments', () => {
  it('holds AtomCut\'s five sky colour tables', () => {
    expect(SKY_PRESETS.sunset).toMatchObject({ top: '#28335e', horizon: '#ff9452', bottom: '#2c2230', sun: { color: '#ffb36b', strength: 14 } })
    expect(SKY_PRESETS.soft.sun?.strength).toBe(3)
    expect(SKY_PRESETS.dawn.sun?.strength).toBe(8)
    expect(SKY_PRESETS.night).toMatchObject({ top: '#03050c', horizon: '#141c34', bottom: '#010103', sun: { color: '#bcd0ff', strength: 2.5 } })
    expect(SKY_PRESETS.overcast).toMatchObject({ top: '#c8cdd5', horizon: '#b0b5bd', bottom: '#5d6168', sun: null })
  })

  it('blends the horizon into the top above it and the bottom below it', () => {
    const sky = SKY_PRESETS.sunset
    const at = (z: number) => skyColor(sky, z)
    const close = (got: number[], want: number[]) => got.forEach((v, i) => expect(v).toBeCloseTo(want[i] as number, 9))
    close(at(0), new Color(sky.horizon).toArray())
    close(at(1), new Color(sky.top).toArray())
    close(at(-1), new Color(sky.bottom).toArray())
    const mid = at(0.25)
    expect(mid[0]).toBeLessThan(new Color(sky.horizon).r)
    expect(mid[2]).toBeGreaterThan(new Color(sky.horizon).b)
  })

  it('aims the sun by elevation and azimuth, Z up', () => {
    const [x, y, z] = sunDirection(90, 0)
    expect([x, y, z].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 0, 1])
    const level = sunDirection(0, 0)
    expect(level.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 1, 0])
    expect(Math.hypot(...sunDirection(35, 20))).toBeCloseTo(1, 12)
  })

  it('builds a sky scene with a dome and, when it has one, a sun at the sun strength', () => {
    const sunset = skyScene(SKY_PRESETS.sunset)
    expect(sunset.children).toHaveLength(2)
    const sun = sunset.children[1] as unknown as { material: { color: Color }; position: { z: number } }
    expect(sun.material.color.r).toBeGreaterThan(new Color('#ffb36b').r * 13)
    expect(sun.position.z).toBeGreaterThan(0)
    expect(skyScene(SKY_PRESETS.overcast).children).toHaveLength(1)
  })
})

describe('materials as three parameters', () => {
  const material = (over: Record<string, unknown>) => MaterialSchema.parse(over)

  it('maps a pbr material, thickness px to units', () => {
    const p = materialParameters(material({ roughness: 0.18, metalness: 1, color: '#f5c46b', transmission: 1, thickness: 20, ior: 1.5, clearcoat: 0.6, sheen: 1, iridescence: 1 }))
    expect(p.kind).toBe('physical')
    expect(p.values).toMatchObject({ color: '#f5c46b', roughness: 0.18, metalness: 1, transmission: 1, thickness: 0.2, ior: 1.5, clearcoat: 0.6, clearcoatRoughness: 0.1, sheen: 1, iridescence: 1 })
    expect(p.doubleSided).toBe(false)
  })

  it('tints white when there is no colour, and glows by emission times strength', () => {
    const p = materialParameters(material({ emission: '#ff2fb1', emissionStrength: 4 }))
    expect(p.values).toMatchObject({ color: '#ffffff', emissive: '#ff2fb1', emissiveIntensity: 4 })
  })

  it('maps toon to a toon material with its bands, and unlit to a basic one', () => {
    const toon = materialParameters(material({ model: 'toon', toonSteps: 5, doubleSided: true }))
    expect([toon.kind, toon.toonSteps, toon.doubleSided]).toEqual(['toon', 5, true])
    expect(Array.from(toonGradient(3))).toEqual([85, 170, 255])
    expect(toonGradient(5)).toHaveLength(5)
    const flat = materialParameters(material({ model: 'unlit', color: '#336699' }))
    expect(flat).toEqual({ kind: 'basic', values: { color: '#336699' }, doubleSided: false })
    expect(KIND_OF_MODEL).toEqual({ pbr: 'physical', toon: 'toon', unlit: 'basic' })
  })

  it('writes the parameters into real three.js materials', () => {
    const params = materialParameters(material({ roughness: 0.3, metalness: 0.7, color: '#c4202f', emission: '#00ff00', emissionStrength: 2, thickness: 50, doubleSided: true }))
    const m = makeLitMaterial('physical')
    applyParameters(m, params)
    const physical = m as import('three').MeshPhysicalMaterial
    expect([physical.roughness, physical.metalness, physical.thickness, physical.emissiveIntensity]).toEqual([0.3, 0.7, 0.5, 2])
    expect(physical.color.getHexString()).toBe('c4202f')
    expect(physical.emissive.getHexString()).toBe('00ff00')
    expect(physical.side).toBe(2)
    expect(physical.premultipliedAlpha).toBe(true)
    expect(physical.alphaTest).toBe(0.004)
    const toon = makeLitMaterial('toon')
    applyParameters(toon, materialParameters(material({ model: 'toon', toonSteps: 4 })))
    expect((toon as import('three').MeshToonMaterial).gradientMap?.image as unknown as { width: number }).toMatchObject({ width: 4 })
    expect(makeLitMaterial('basic').toneMapped).toBe(false)
  })

  it('picks the three.js material from the layer material, none being an unlit picture', () => {
    expect(pictureKind(undefined)).toBe('unlit')
    expect(pictureKind(material({}))).toBe('physical')
    expect(pictureKind(material({ model: 'toon' }))).toBe('toon')
    expect(pictureKind(material({ model: 'unlit' }))).toBe('basic')
  })

  it('stands a lit plane\'s front toward the viewer of the flat picture', () => {
    const geo = litGeometry()
    const normals = geo.getAttribute('normal')
    expect([normals.getZ(0), normals.getZ(3)]).toEqual([-1, -1])
    expect(geo.getIndex()?.count).toBe(6)
  })
})

describe('unlit pictures stay exact', () => {
  it('writes the premultiplied texel times the opacity with no colour conversion or tone mapping', () => {
    // The shader does not include three's colour-space or tone-mapping chunks, so the renderer's output colour space and tone mapping cannot change it.
    for (const source of [UNLIT_FRAGMENT, UNLIT_VERTEX]) {
      // Only the clipping chunks (empty unless the renderer has a clipping plane, for the mirror floor's reflection pass).
      expect((source.match(/#include <[^>]+>/g) ?? []).filter((chunk) => !chunk.includes('clipping_planes'))).toEqual([])
      expect(source).not.toMatch(/colorspace|tonemapping|linearToOutputTexel|sRGB/i)
    }
    expect(UNLIT_FRAGMENT).toContain('vec4 c = texel * uOpacity;')
    expect(UNLIT_FRAGMENT).toContain('gl_FragColor = c;')
  })

  it('keeps the old blending (premultiplied over), alpha test and side, and ignores tone mapping', () => {
    const m = makeUnlitMaterial()
    expect([m.blending, m.blendSrc, m.blendDst, m.blendEquation]).toEqual([5, 201, 205, 100])
    expect([m.transparent, m.side, m.toneMapped, m.fog, m.polygonOffset]).toEqual([true, 2, false, false, true])
  })

  // The same arithmetic as the fragment shader, to show what reaches the canvas for any texel and opacity.
  const shade = (texel: number[], opacity: number): number[] | null => {
    const c = texel.map((v) => v * opacity)
    return (c[3] as number) < 0.004 ? null : c
  }

  it('hands a premultiplied texel to the canvas as texel × opacity', () => {
    for (const texel of [[0.2, 0.4, 0.6, 0.8], [1, 1, 1, 1], [0.05, 0, 0.1, 0.1]]) {
      for (const opacity of [1, 0.5, 0.123]) expect(shade(texel, opacity)).toEqual(texel.map((v) => v * opacity))
    }
    expect(shade([0, 0, 0, 0.003], 1)).toBeNull()
  })
})
