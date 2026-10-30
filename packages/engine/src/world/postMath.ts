// The arithmetic of the post stack that is easy to state without a GPU: the
// finish blend, the bloom's level weights and the ambient occlusion's blend.
// The shaders in post.ts do the same sums; the tests check these.

export type Rgba = readonly [number, number, number, number]

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/**
 * Lays a glow over a picture. Both are premultiplied display values. The glow
 * is screened over the colour (base + glow * (1 - base)) and may raise the
 * alpha, so a transparent world still glows over what is under it: alpha is
 * the larger of the picture's and the brightest channel of the result.
 */
export function finishBlend(base: Rgba, glow: readonly [number, number, number]): [number, number, number, number] {
  const rgb = [0, 1, 2].map((i) => clamp01((base[i] as number) + (glow[i] as number) * (1 - (base[i] as number)))) as [number, number, number]
  return [...rgb, clamp01(Math.max(base[3], ...rgb))]
}

/** The weights of the bloom's five blur levels, narrowest first. */
export const BLOOM_LEVELS = [1, 0.8, 0.6, 0.4, 0.2] as const

/** One level's weight at a bloom radius: 0 keeps the tight levels strongest, 1 turns the order round toward the wide ones. */
export const bloomLevelWeight = (factor: number, radius: number): number => factor + (1.2 - factor - factor) * radius

/** The gaussian blur kernel sizes (taps each side) of the five levels. */
export const BLOOM_KERNELS = [3, 5, 7, 9, 11] as const

/** The size of the bloom's largest level, px. */
export const BLOOM_SIZE = 256

/** What the ambient occlusion multiplies the colour by, from its occlusion (1 open, 0 closed) and the world's strength. */
export const aoFactor = (occlusion: number, strength: number): number => clamp01(1 - strength * (1 - occlusion))

/** Which parts of the post stack a frame needs. */
export interface PostPlan {
  ao: boolean
  dof: boolean
  bloom: boolean
  /** The bloom is drawn from the emission pass, not from the picture. */
  emission: boolean
  /** Any of them: the scene goes through a render target instead of straight to the canvas. */
  any: boolean
}

/** The post stack a frame needs, from the world's render settings and whether its live camera has depth of field. */
export function postPlan(render: { ao: { enabled: boolean }; bloom: { enabled: boolean; source: 'bright' | 'emission' } }, hasDof: boolean): PostPlan {
  const ao = render.ao.enabled
  const bloom = render.bloom.enabled
  return { ao, dof: hasDof, bloom, emission: bloom && render.bloom.source === 'emission', any: ao || hasDof || bloom }
}
