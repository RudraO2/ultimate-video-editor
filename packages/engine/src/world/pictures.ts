import type { MaterialSpec } from '@uve/core'
import {
  AddEquation,
  BufferAttribute,
  BufferGeometry,
  Color,
  CustomBlending,
  DataTexture,
  DoubleSide,
  FrontSide,
  LinearFilter,
  LinearMipmapLinearFilter,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshToonMaterial,
  NearestFilter,
  NoColorSpace,
  NormalBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PlaneGeometry,
  RedFormat,
  ShaderMaterial,
  SRGBColorSpace,
  Texture,
  UnsignedByteType,
} from 'three'
import { type MaterialKind, type MaterialParameters, materialParameters, toonGradient } from './lighting'

// The materials a picture plane can have. A plane with no material is an
// *unlit picture*: its pixels reach the canvas exactly as the 2D renderer drew
// them. That is a small ShaderMaterial that samples the premultiplied texture
// raw, multiplies it by the opacity and writes it, with no colour-space
// conversion and no tone mapping (it includes neither chunk), so switching the
// renderer's output to sRGB for lit content leaves it untouched. A plane with a
// material is lit: its picture is the `map` (straight alpha, sRGB) of a
// physical, toon or basic three.js material.

export type PictureKind = 'unlit' | MaterialKind

export const UNLIT_VERTEX = /* glsl */ `
#include <clipping_planes_pars_vertex>
varying vec2 vUv;
varying float vDepth;
void main() {
  vUv = uv;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vDepth = -mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;
  #include <clipping_planes_vertex>
}`

/**
 * Premultiplied texel times opacity, written as it is. No colorspace_fragment,
 * no tonemapping_fragment. Fog (when on) mixes the straight colour toward the
 * fog colour the way three does (smoothstep over the view depth), kept
 * premultiplied. Pixels under 0.4 % alpha are dropped, as before. The
 * clipping chunks (empty unless the renderer has a clipping plane) let the
 * reflection pass cut the scene at the floor.
 */
export const UNLIT_FRAGMENT = /* glsl */ `
#include <clipping_planes_pars_fragment>
uniform sampler2D uMap;
uniform float uOpacity;
uniform float uBlack;
uniform float uFog;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
varying vec2 vUv;
varying float vDepth;
void main() {
  #include <clipping_planes_fragment>
  vec4 texel = texture2D(uMap, vUv);
  vec4 c = texel * uOpacity;
  if (c.a < 0.004) discard;
  if (uFog > 0.5) {
    float f = smoothstep(uFogNear, uFogFar, vDepth);
    c.rgb = mix(c.rgb, uFogColor * c.a, f);
  }
  // uBlack is 1 only when the picture is drawn as a black occluder (the bloom's emission pass).
  c.rgb *= 1.0 - uBlack;
  gl_FragColor = c;
}`

/** Rewrites of a plane's geometry for lit materials: its front is the picture's front (toward the viewer of the flat picture). */
let litShared: BufferGeometry | null = null

/** The picture plane geometry of unlit pictures. */
export const unlitGeometry = new PlaneGeometry(1, 1)

/**
 * A plane whose front face is the picture's front. Pictures stand with y
 * down, so `PlaneGeometry` (made y up) faces away from the viewer once placed;
 * this has its winding turned and its normal toward the viewer.
 */
export function litGeometry(): BufferGeometry {
  if (litShared) return litShared
  const plane = new PlaneGeometry(1, 1)
  const index = plane.getIndex() as BufferAttribute
  const flipped = new Uint16Array(index.count)
  for (let i = 0; i < index.count; i += 3) {
    flipped[i] = index.getX(i)
    flipped[i + 1] = index.getX(i + 2)
    flipped[i + 2] = index.getX(i + 1)
  }
  const normals = plane.getAttribute('normal') as BufferAttribute
  for (let i = 0; i < normals.count; i++) normals.setXYZ(i, 0, 0, -1)
  plane.setIndex(new BufferAttribute(flipped, 1))
  litShared = plane
  return plane
}

/** The material of an unlit picture. */
export function makeUnlitMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uMap: { value: null },
      uOpacity: { value: 1 },
      uFog: { value: 0 },
      uFogColor: { value: new Color(0, 0, 0) },
      uFogNear: { value: 0 },
      uFogFar: { value: 1 },
      uBlack: { value: 0 },
    },
    vertexShader: UNLIT_VERTEX,
    fragmentShader: UNLIT_FRAGMENT,
    transparent: true,
    side: DoubleSide,
    blending: CustomBlending,
    blendEquation: AddEquation,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
    polygonOffset: true,
    toneMapped: false,
    fog: false,
    // Only so the reflection pass can cut the scene at the floor; with no clipping plane the chunks are empty.
    clipping: true,
  })
}

export type LitMaterial = MeshPhysicalMaterial | MeshToonMaterial | MeshBasicMaterial
export type PictureMaterial = ShaderMaterial | LitMaterial

/** A lit picture's three.js material of a kind. */
export function makeLitMaterial(kind: MaterialKind): LitMaterial {
  const common = { transparent: true, alphaTest: 0.004, premultipliedAlpha: true, blending: NormalBlending, polygonOffset: true }
  switch (kind) {
    case 'physical':
      return new MeshPhysicalMaterial(common)
    case 'toon':
      return new MeshToonMaterial(common)
    case 'basic':
      // A flat picture keeps its colours: no tone mapping.
      return new MeshBasicMaterial({ ...common, toneMapped: false })
  }
}

const gradients = new Map<number, DataTexture>()

/** The stepped gradient map of a toon material, shared per band count. */
export function toonMap(steps: number): DataTexture {
  const key = Math.max(2, Math.round(steps))
  let map = gradients.get(key)
  if (!map) {
    map = new DataTexture(toonGradient(key), key, 1, RedFormat, UnsignedByteType)
    map.minFilter = NearestFilter
    map.magFilter = NearestFilter
    map.generateMipmaps = false
    map.needsUpdate = true
    gradients.set(key, map)
  }
  return map
}

/** Sets a lit material to a material's parameters (in place). */
export function applyParameters(material: LitMaterial, params: MaterialParameters): void {
  const target = material as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(params.values)) {
    const current = target[key]
    if (current instanceof Color) current.set(value as string)
    else if (key in target) target[key] = value
  }
  material.side = params.doubleSided ? DoubleSide : FrontSide
  if (params.kind === 'toon' && params.toonSteps) (material as MeshToonMaterial).gradientMap = toonMap(params.toonSteps)
}

/** A texture of a canvas for an unlit picture: no colour space (values reach the output untouched), premultiplied, trilinear. */
export function makeUnlitTexture(canvas: OffscreenCanvas): Texture {
  const texture = new Texture(canvas as unknown as HTMLCanvasElement)
  texture.colorSpace = NoColorSpace
  texture.flipY = false
  texture.premultiplyAlpha = true
  texture.generateMipmaps = true
  texture.minFilter = LinearMipmapLinearFilter
  texture.magFilter = LinearFilter
  texture.anisotropy = 4
  texture.needsUpdate = true
  return texture
}

/** A texture of a canvas for a lit picture: sRGB colour, straight alpha (the material premultiplies after shading). */
export function makeLitTexture(canvas: OffscreenCanvas): Texture {
  const texture = makeUnlitTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.premultiplyAlpha = false
  texture.needsUpdate = true
  return texture
}

/** Which kind of three.js material a plane with this material (or none) needs. */
export const pictureKind = (material: MaterialSpec | undefined): PictureKind => (material ? materialParameters(material).kind : 'unlit')

export function setMap(material: PictureMaterial, texture: Texture): void {
  if (material instanceof ShaderMaterial) material.uniforms.uMap!.value = texture
  else {
    material.map = texture
    material.needsUpdate = true
  }
}

