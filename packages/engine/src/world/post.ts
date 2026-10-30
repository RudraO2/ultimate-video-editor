import {
  CustomBlending,
  DepthTexture,
  HalfFloatType,
  LinearFilter,
  Matrix4,
  Mesh,
  NoBlending,
  OneFactor,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  type Texture,
  Vector2,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three'
import type { PerspectiveCamera } from 'three'
import { DOF_MAX_BLUR } from './dof'
import { BLOOM_KERNELS, BLOOM_LEVELS, BLOOM_SIZE, bloomLevelWeight } from './postMath'

// The post stack: passes that work on a copy of the frame. The copy is made
// in the canvas's own terms: a half-float render target flagged so three
// applies the renderer's tone mapping and encodes to its own sRGB colour
// space (see `displayTarget`), so what it holds is the display-referred,
// premultiplied picture that lit materials leave on the canvas and unlit
// pictures write raw. The passes read and write those values with no colour
// conversion, and the last one copies the result to the canvas as it is.
//
// Order: ambient occlusion, depth of field (both need the depth of the
// scene), bloom, and a finish that screens the glow over the picture. Motion
// blur adds frames into an accumulation target before the bloom.

export interface AoSettings {
  radius: number
  strength: number
}

export interface DofSettings {
  /** Focus in three units (metres), aperture as `dofAperture`. */
  focus: number
  aperture: number
}

export interface BloomSettings {
  strength: number
  radius: number
  threshold: number
}

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`

/** Reads a view-space position from the depth texture; shared by the occlusion and depth-of-field shaders. */
const VIEW_AT = /* glsl */ `
uniform sampler2D tDepth;
uniform mat4 uInvProj;
vec3 viewAt(vec2 uv) {
  float d = texture2D(tDepth, uv).x;
  vec4 p = uInvProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}`

const AO_SAMPLES = 20

/** Ambient occlusion from depth: normal-oriented samples in a hemisphere of `uRadius` (view units), with a depth range check. */
const AO_FRAGMENT = /* glsl */ `
${VIEW_AT}
uniform mat4 uProj;
uniform vec2 uTexel;
uniform float uRadius;
varying vec2 vUv;
float rotation(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}
void main() {
  if (texture2D(tDepth, vUv).x >= 0.99999) { gl_FragColor = vec4(1.0); return; }
  vec3 P = viewAt(vUv);
  vec3 pl = viewAt(vUv - vec2(uTexel.x, 0.0));
  vec3 pr = viewAt(vUv + vec2(uTexel.x, 0.0));
  vec3 pd = viewAt(vUv - vec2(0.0, uTexel.y));
  vec3 pu = viewAt(vUv + vec2(0.0, uTexel.y));
  vec3 dx = abs(pr.z - P.z) < abs(P.z - pl.z) ? pr - P : P - pl;
  vec3 dy = abs(pu.z - P.z) < abs(P.z - pd.z) ? pu - P : P - pd;
  vec3 N = normalize(cross(dx, dy));
  if (dot(N, -P) < 0.0) N = -N;
  vec3 T = normalize(abs(N.y) < 0.99 ? cross(N, vec3(0.0, 1.0, 0.0)) : cross(N, vec3(1.0, 0.0, 0.0)));
  vec3 B = cross(N, T);
  float spin = rotation(gl_FragCoord.xy);
  float bias = 0.05 * uRadius + 0.001 * abs(P.z);
  float occlusion = 0.0;
  for (int i = 0; i < ${AO_SAMPLES}; i++) {
    float f = (float(i) + 0.5) / float(${AO_SAMPLES});
    float a = 6.2831853 * (spin + float(i) * 0.61803399);
    vec3 local = vec3(sqrt(f) * cos(a), sqrt(f) * sin(a), sqrt(1.0 - f));
    vec3 S = P + (T * local.x + B * local.y + N * local.z) * uRadius * mix(0.1, 1.0, f);
    vec4 clip = uProj * vec4(S, 1.0);
    vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) continue;
    float z = viewAt(uv).z;
    float range = smoothstep(0.0, 1.0, uRadius / max(abs(P.z - z), 1e-5));
    occlusion += (z >= S.z + bias ? 1.0 : 0.0) * range;
  }
  float ao = 1.0 - occlusion / float(${AO_SAMPLES});
  gl_FragColor = vec4(ao, ao, ao, 1.0);
}`

/** Multiplies the colour by the occlusion, blurred over a 5 x 5 patch of pixels that are at about the same depth. */
const AO_APPLY_FRAGMENT = /* glsl */ `
${VIEW_AT}
uniform sampler2D tColor;
uniform sampler2D tAo;
uniform vec2 uTexel;
uniform float uStrength;
uniform float uTolerance;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tColor, vUv);
  if (texture2D(tDepth, vUv).x >= 0.99999) { gl_FragColor = c; return; }
  float z0 = viewAt(vUv).z;
  float sum = 0.0;
  float total = 0.0;
  for (int x = -2; x <= 2; x++) {
    for (int y = -2; y <= 2; y++) {
      vec2 uv = vUv + vec2(float(x), float(y)) * uTexel;
      float w = abs(viewAt(uv).z - z0) <= uTolerance ? 1.0 : 0.0;
      sum += texture2D(tAo, uv).r * w;
      total += w;
    }
  }
  float ao = total > 0.0 ? sum / total : 1.0;
  float k = clamp(1.0 - uStrength * (1.0 - ao), 0.0, 1.0);
  gl_FragColor = vec4(c.rgb * k, c.a);
}`

const DOF_TAPS = 41

/**
 * Depth of field: 41 taps in four rings, spread by the circle of confusion
 * (focus plus view depth, times the aperture, up to `uMax`). Unlike three's
 * bokeh shader the alpha is blurred like the colour, so a transparent world
 * keeps its soft edges.
 */
const DOF_FRAGMENT = /* glsl */ `
${VIEW_AT}
uniform sampler2D tColor;
uniform float uFocus;
uniform float uAperture;
uniform float uMax;
uniform float uAspect;
uniform vec2 uTaps[${DOF_TAPS}];
varying vec2 vUv;
// The circle of confusion at view depth z: behind the focus plane it grows with the distance
// past it (s - d, times the aperture); in front it grows as a thin lens's does, by s / d more,
// so near things blur as they would through a real lens. Both agree at the focus plane.
float confusion(float z) {
  return clamp((uFocus + z) * uAperture * max(1.0, uFocus / max(-z, 1e-4)), -uMax, uMax);
}
void main() {
  float depth = viewAt(vUv).z;
  float blur = confusion(depth);
  vec4 sum = vec4(0.0);
  float total = 0.0;
  for (int i = 0; i < ${DOF_TAPS}; i++) {
    vec2 uv = vUv + uTaps[i] * vec2(1.0, uAspect) * blur;
    // A tap nearer the camera than this pixel counts only as far as its own blur spreads it:
    // a sharp edge in front does not bleed a halo into the blurred background behind it.
    float z = viewAt(uv).z;
    float reach = abs(confusion(z)) * 0.4;
    float away = length(uTaps[i]) * abs(blur);
    float w = z <= depth + 1e-4 ? 1.0 : clamp(reach / max(away, 1e-5), 0.0, 1.0);
    sum += texture2D(tColor, uv) * w;
    total += w;
  }
  gl_FragColor = sum / max(total, 1e-5);
}`

/** The bokeh taps: the centre, then rings of 16, 8, 8 and 8 around it, turned a little against each other. */
export function dofTaps(): Vector2[] {
  const taps = [new Vector2(0, 0)]
  const ring = (count: number, radius: number, turn: number) => {
    for (let i = 0; i < count; i++) {
      const a = turn + (i / count) * Math.PI * 2
      taps.push(new Vector2(Math.cos(a) * radius, Math.sin(a) * radius))
    }
  }
  ring(16, 0.4, Math.PI / 2)
  ring(8, 0.36, Math.PI / 8 + Math.PI / 2)
  ring(8, 0.28, Math.PI / 4 + Math.PI / 2)
  ring(8, 0.16, Math.PI / 4 + Math.PI / 2)
  return taps
}

/** Keeps the bright part of the picture, averaging a 4 x 4 patch of it into each texel of the small bloom image. */
const BRIGHT_FRAGMENT = /* glsl */ `
uniform sampler2D tBase;
uniform vec2 uSize;
uniform float uThreshold;
varying vec2 vUv;
void main() {
  vec4 c = vec4(0.0);
  for (int i = 0; i < 4; i++) {
    for (int j = 0; j < 4; j++) {
      c += texture2D(tBase, vUv + ((vec2(float(i), float(j)) + 0.5) / 4.0 - 0.5) / uSize);
    }
  }
  c /= 16.0;
  float luma = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  gl_FragColor = c * smoothstep(uThreshold, uThreshold + 0.01, luma);
}`

const BLUR_FRAGMENT = /* glsl */ `
uniform sampler2D tInput;
uniform vec2 uStep;
varying vec2 vUv;
void main() {
  float sigma = float(KERNEL) / 3.0;
  vec4 sum = texture2D(tInput, vUv);
  float total = 1.0;
  for (int i = 1; i < KERNEL; i++) {
    float w = exp(-0.5 * float(i * i) / (sigma * sigma));
    vec2 o = uStep * float(i);
    sum += (texture2D(tInput, vUv + o) + texture2D(tInput, vUv - o)) * w;
    total += 2.0 * w;
  }
  gl_FragColor = sum / total;
}`

const COMPOSITE_FRAGMENT = /* glsl */ `
uniform sampler2D tLevel0;
uniform sampler2D tLevel1;
uniform sampler2D tLevel2;
uniform sampler2D tLevel3;
uniform sampler2D tLevel4;
uniform float uWeights[5];
varying vec2 vUv;
void main() {
  gl_FragColor = uWeights[0] * texture2D(tLevel0, vUv) + uWeights[1] * texture2D(tLevel1, vUv) + uWeights[2] * texture2D(tLevel2, vUv) + uWeights[3] * texture2D(tLevel3, vUv) + uWeights[4] * texture2D(tLevel4, vUv);
}`

/** Writes a picture to the canvas as it is, or with a glow screened over it (postMath.ts `finishBlend`). */
const FINISH_FRAGMENT = /* glsl */ `
uniform sampler2D tBase;
uniform sampler2D tGlow;
uniform float uGlow;
varying vec2 vUv;
void main() {
  vec4 base = texture2D(tBase, vUv);
  if (uGlow < 0.5) { gl_FragColor = base; return; }
  vec3 glow = texture2D(tGlow, vUv).rgb;
  // A wide glow rises a level or two over hundreds of pixels: a fixed per-pixel dither of
  // the glow keeps 8-bit output from showing rings (fixed, so every render of a frame is the same).
  float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5;
  glow = max(glow + (noise / 255.0) * step(0.5 / 255.0, max(glow.r, max(glow.g, glow.b))), 0.0);
  vec3 rgb = clamp(base.rgb + glow * (1.0 - base.rgb), 0.0, 1.0);
  gl_FragColor = vec4(rgb, clamp(max(base.a, max(rgb.r, max(rgb.g, rgb.b))), 0.0, 1.0));
}`

const ADD_FRAGMENT = /* glsl */ `
uniform sampler2D tInput;
uniform float uWeight;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(tInput, vUv) * uWeight;
}`

function pass(fragmentShader: string, uniforms: ShaderMaterial['uniforms'], defines?: Record<string, number>, additive = false): ShaderMaterial {
  return new ShaderMaterial({
    uniforms,
    defines,
    vertexShader: VERTEX,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    fog: false,
    blending: additive ? CustomBlending : NoBlending,
    blendSrc: OneFactor,
    blendDst: OneFactor,
    blendSrcAlpha: OneFactor,
    blendDstAlpha: OneFactor,
    transparent: additive,
  })
}

/** A half-float target that holds values as the canvas would (see the header), with the scene's depth to read. */
export function displayTarget(width: number, height: number, depth: boolean): WebGLRenderTarget {
  const target = new WebGLRenderTarget(width, height, {
    type: HalfFloatType,
    format: RGBAFormat,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    depthBuffer: true,
    samples: 4,
    depthTexture: depth ? new DepthTexture(width, height) : null,
  })
  target.texture.colorSpace = SRGBColorSpace
  // Three tone maps and encodes only what goes to the canvas or an XR target. Flagged as one, this target gets
  // the renderer's tone mapping and its texture's colour space (sRGB), exactly like the canvas.
  ;(target as unknown as { isXRRenderTarget: boolean }).isXRRenderTarget = true
  return target
}

/** A plain half-float target with no depth: for passes and sums. */
function plainTarget(width: number, height: number): WebGLRenderTarget {
  return new WebGLRenderTarget(width, height, { type: HalfFloatType, format: RGBAFormat, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false })
}

interface Slot {
  target: WebGLRenderTarget
  width: number
  height: number
}

/** The sizes of the bloom's five levels for an output of `width` x `height`: the longest side of the first is `BLOOM_SIZE`. */
export function bloomSizes(width: number, height: number): [number, number][] {
  const long = Math.max(width, height)
  const w = Math.max(2, Math.round((width / long) * BLOOM_SIZE))
  const h = Math.max(2, Math.round((height / long) * BLOOM_SIZE))
  return BLOOM_KERNELS.map((_, i) => [Math.max(2, Math.round(w / 2 ** i)), Math.max(2, Math.round(h / 2 ** i))])
}

/**
 * The post passes and their render targets, made when first needed, resized
 * with the output and let go by `dispose`. Nothing is allocated per frame.
 */
export class PostStack {
  private readonly quad: Mesh
  private readonly quadScene = new Scene()
  private readonly quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly slots = new Map<string, Slot>()
  private readonly ao = pass(AO_FRAGMENT, { tDepth: { value: null }, uInvProj: { value: new Matrix4() }, uProj: { value: new Matrix4() }, uTexel: { value: new Vector2() }, uRadius: { value: 1 } })
  private readonly aoApply = pass(AO_APPLY_FRAGMENT, {
    tDepth: { value: null },
    uInvProj: { value: new Matrix4() },
    tColor: { value: null },
    tAo: { value: null },
    uTexel: { value: new Vector2() },
    uStrength: { value: 1 },
    uTolerance: { value: 1 },
  })
  private readonly dof = pass(DOF_FRAGMENT, {
    tDepth: { value: null },
    uInvProj: { value: new Matrix4() },
    tColor: { value: null },
    uFocus: { value: 1 },
    uAperture: { value: 0 },
    uMax: { value: DOF_MAX_BLUR },
    uAspect: { value: 1 },
    uTaps: { value: dofTaps() },
  })
  private readonly bright = pass(BRIGHT_FRAGMENT, { tBase: { value: null }, uSize: { value: new Vector2() }, uThreshold: { value: 0.75 } })
  private readonly blurs = BLOOM_KERNELS.map((k) => pass(BLUR_FRAGMENT, { tInput: { value: null }, uStep: { value: new Vector2() } }, { KERNEL: k }))
  private readonly composite = pass(COMPOSITE_FRAGMENT, {
    tLevel0: { value: null },
    tLevel1: { value: null },
    tLevel2: { value: null },
    tLevel3: { value: null },
    tLevel4: { value: null },
    uWeights: { value: [1, 1, 1, 1, 1] },
  })
  private readonly finishPass = pass(FINISH_FRAGMENT, { tBase: { value: null }, tGlow: { value: null }, uGlow: { value: 0 } })
  private readonly add = pass(ADD_FRAGMENT, { tInput: { value: null }, uWeight: { value: 1 } }, undefined, true)

  constructor(private readonly gl: WebGLRenderer) {
    this.quad = new Mesh(new PlaneGeometry(2, 2))
    this.quad.frustumCulled = false
    this.quadScene.add(this.quad)
  }

  /** A target kept under `name` at this size (made again when the size changes). */
  private slot(name: string, width: number, height: number, make: () => WebGLRenderTarget): WebGLRenderTarget {
    const held = this.slots.get(name)
    if (held && held.width === width && held.height === height) return held.target
    held?.target.dispose()
    held?.target.depthTexture?.dispose()
    const target = make()
    this.slots.set(name, { target, width, height })
    return target
  }

  /** Where the scene is drawn: display values, with depth for the occlusion and the depth of field. */
  sceneTarget(width: number, height: number): WebGLRenderTarget {
    return this.slot('scene', width, height, () => displayTarget(width, height, true))
  }

  /** Where the bloom's emission pass draws (no depth is read from it). */
  emissionTarget(width: number, height: number): WebGLRenderTarget {
    return this.slot('emission', width, height, () => displayTarget(width, height, false))
  }

  /** A sum of frames (motion blur), by name: the picture's and the emission's. */
  accumulator(name: 'image' | 'emission', width: number, height: number): WebGLRenderTarget {
    return this.slot(`sum:${name}`, width, height, () => plainTarget(width, height))
  }

  private run(material: ShaderMaterial, target: WebGLRenderTarget | null): void {
    this.quad.material = material
    this.gl.setRenderTarget(target)
    this.gl.render(this.quadScene, this.quadCamera)
  }

  /** Empties an accumulator. */
  clear(target: WebGLRenderTarget): void {
    this.gl.setRenderTarget(target)
    this.gl.clear()
  }

  /** Adds a picture times a weight into an accumulator. */
  accumulate(into: WebGLRenderTarget, texture: Texture, weight: number): void {
    this.add.uniforms.tInput!.value = texture
    this.add.uniforms.uWeight!.value = weight
    // Added over what is there: the target must not be cleared first.
    const autoClear = this.gl.autoClear
    this.gl.autoClear = false
    this.run(this.add, into)
    this.gl.autoClear = autoClear
  }

  /** Occludes the scene target's picture: returns the texture of the occluded picture. */
  occlude(scene: WebGLRenderTarget, camera: PerspectiveCamera | OrthographicCamera, settings: AoSettings): Texture {
    const { width, height } = scene
    const map = this.slot('ao', width, height, () => plainTarget(width, height))
    const out = this.slot('post:a', width, height, () => plainTarget(width, height))
    const u = this.ao.uniforms
    u.tDepth!.value = scene.depthTexture
    u.uInvProj!.value.copy(camera.projectionMatrixInverse)
    u.uProj!.value.copy(camera.projectionMatrix)
    u.uTexel!.value.set(1 / width, 1 / height)
    u.uRadius!.value = settings.radius
    this.run(this.ao, map)
    const a = this.aoApply.uniforms
    a.tDepth!.value = scene.depthTexture
    a.uInvProj!.value.copy(camera.projectionMatrixInverse)
    a.tColor!.value = scene.texture
    a.tAo!.value = map.texture
    a.uTexel!.value.set(1 / width, 1 / height)
    a.uStrength!.value = settings.strength
    a.uTolerance!.value = settings.radius * 0.5
    this.run(this.aoApply, out)
    return out.texture
  }

  /** Blurs the picture by the depth of what is in it; `color` is the scene's texture or the occlusion's result. */
  defocus(scene: WebGLRenderTarget, color: Texture, camera: PerspectiveCamera | OrthographicCamera, settings: DofSettings): Texture {
    const { width, height } = scene
    const out = this.slot('post:b', width, height, () => plainTarget(width, height))
    const u = this.dof.uniforms
    u.tDepth!.value = scene.depthTexture
    u.uInvProj!.value.copy(camera.projectionMatrixInverse)
    u.tColor!.value = color
    u.uFocus!.value = settings.focus
    u.uAperture!.value = settings.aperture
    u.uAspect!.value = width / height
    this.run(this.dof, out)
    return out.texture
  }

  /** The glow of a picture: its bright part, blurred at five widths and summed. Returns the texture of the glow. */
  bloom(source: Texture, width: number, height: number, settings: BloomSettings): Texture {
    const sizes = bloomSizes(width, height)
    const [w0, h0] = sizes[0] as [number, number]
    const bright = this.slot('bloom:bright', w0, h0, () => plainTarget(w0, h0))
    const u = this.bright.uniforms
    u.tBase!.value = source
    // The taps span one texel of the small image.
    u.uSize!.value.set(w0, h0)
    u.uThreshold!.value = settings.threshold
    this.run(this.bright, bright)
    let input: Texture = bright.texture
    const levels: Texture[] = []
    sizes.forEach(([w, h], i) => {
      const horizontal = this.slot(`bloom:h${i}`, w, h, () => plainTarget(w, h))
      const vertical = this.slot(`bloom:v${i}`, w, h, () => plainTarget(w, h))
      const blur = this.blurs[i] as ShaderMaterial
      blur.uniforms.tInput!.value = input
      blur.uniforms.uStep!.value.set(1 / w, 0)
      this.run(blur, horizontal)
      blur.uniforms.tInput!.value = horizontal.texture
      blur.uniforms.uStep!.value.set(0, 1 / h)
      this.run(blur, vertical)
      input = vertical.texture
      levels.push(vertical.texture)
    })
    const c = this.composite.uniforms
    levels.forEach((texture, i) => {
      c[`tLevel${i}`]!.value = texture
    })
    c.uWeights!.value = BLOOM_LEVELS.map((factor) => bloomLevelWeight(factor, settings.radius) * settings.strength)
    // The first target is free again (its picture is in the first level): the glow is summed into it.
    this.run(this.composite, bright)
    return bright.texture
  }

  /** Writes a picture to the canvas as it is; with `glow`, with the glow screened over it. */
  finish(base: Texture, glow: Texture | null): void {
    const u = this.finishPass.uniforms
    u.tBase!.value = base
    u.tGlow!.value = glow
    u.uGlow!.value = glow ? 1 : 0
    this.run(this.finishPass, null)
  }

  dispose(): void {
    for (const { target } of this.slots.values()) {
      target.dispose()
      target.depthTexture?.dispose()
    }
    this.slots.clear()
    for (const material of [this.ao, this.aoApply, this.dof, this.bright, ...this.blurs, this.composite, this.finishPass, this.add]) material.dispose()
    this.quad.geometry.dispose()
  }
}
