import { Color, CustomBlending, DoubleSide, type Material, type Mesh, OneFactor, OneMinusSrcAlphaFactor, ShaderMaterial, type Texture } from 'three'

// The bloom's emission pass draws the scene again with every lit material
// reduced to its emission: the emissive colour times its intensity, over the
// same silhouette (the picture's alpha, or the mesh's opacity). Unlit
// pictures keep their silhouette and are drawn black (see pictures.ts
// `uBlack`), so everything still hides what is behind it. The result goes
// through the renderer's tone mapping and sRGB output like the real picture.

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`

const FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform float uHasMap;
uniform vec3 uEmission;
uniform float uOpacity;
uniform float uAlphaTest;
varying vec2 vUv;
void main() {
  float a = uOpacity;
  if (uHasMap > 0.5) a *= texture2D(uMap, vUv).a;
  if (a < uAlphaTest) discard;
  gl_FragColor = vec4(uEmission, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.rgb *= gl_FragColor.a;
}`

/** The material that draws a lit mesh as its emission. */
export function makeEmissionMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uMap: { value: null }, uHasMap: { value: 0 }, uEmission: { value: new Color(0, 0, 0) }, uOpacity: { value: 1 }, uAlphaTest: { value: 0 } },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    blending: CustomBlending,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
    side: DoubleSide,
    fog: false,
  })
}

/** What a lit material emits: its emissive colour (linear) times its intensity; black for materials that have none. */
export function emissionOf(material: Material, into: Color = new Color()): Color {
  const lit = material as { emissive?: Color; emissiveIntensity?: number }
  if (!lit.emissive) return into.setRGB(0, 0, 0)
  return into.copy(lit.emissive).multiplyScalar(lit.emissiveIntensity ?? 1)
}

/** Sets an emission material to stand in for a lit one: its emission, silhouette, sides, stacking and depth settings. */
export function applyEmission(twin: ShaderMaterial, original: Material & { map?: Texture | null }): void {
  const u = twin.uniforms
  emissionOf(original, u.uEmission!.value as Color)
  u.uMap!.value = original.map ?? null
  u.uHasMap!.value = original.map ? 1 : 0
  u.uOpacity!.value = original.opacity
  u.uAlphaTest!.value = original.alphaTest
  twin.side = original.side
  twin.transparent = original.transparent
  twin.depthWrite = original.depthWrite
  twin.polygonOffset = original.polygonOffset
  twin.polygonOffsetFactor = original.polygonOffsetFactor
  twin.polygonOffsetUnits = original.polygonOffsetUnits
}

const twins = new WeakMap<Mesh, ShaderMaterial>()
const stash = new WeakMap<Mesh, Material | Material[]>()

/** Puts a mesh into the emission pass: lit meshes get their emission material; the caller deals with unlit pictures. */
export function intoEmission(mesh: Mesh): void {
  const original = mesh.material as Material
  let twin = twins.get(mesh)
  if (!twin) {
    twin = makeEmissionMaterial()
    twins.set(mesh, twin)
  }
  applyEmission(twin, original)
  stash.set(mesh, original)
  mesh.material = twin
}

/** Gives a mesh its own material back after the emission pass. */
export function outOfEmission(mesh: Mesh): void {
  const original = stash.get(mesh)
  if (original) mesh.material = original
  stash.delete(mesh)
}

/** Lets go of a mesh's emission material (the mesh is going away). */
export function forgetEmission(mesh: Mesh): void {
  twins.get(mesh)?.dispose()
  twins.delete(mesh)
}
