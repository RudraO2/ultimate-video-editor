import { type Effect, effectNumber, parseColor } from '@uve/core'
import { hash, noiseField, random, rollAt } from './analog'
import { blurOf, canvasLike, context, direction, type EffectEnv, type Point, unit } from './pixels'

// The distortion cards: each moves pixels, looking every output pixel up
// somewhere in the layer's picture (bilinear, on premultiplied colour so
// edges stay clean). Centres and radii are given in the layer's box.

const num = effectNumber
const text = (e: Effect, key: string): string => {
  const value = e[key]
  return typeof value === 'string' ? value : ''
}

/** Premultiplied RGBA of a picture, as floats. */
function premultiplied(source: OffscreenCanvas): Float32Array {
  const { width: w, height: h } = source
  const data = context(source).getImageData(0, 0, w, h).data
  const out = new Float32Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    const a = (data[i * 4 + 3] as number) / 255
    out[i * 4] = (data[i * 4] as number) * a
    out[i * 4 + 1] = (data[i * 4 + 1] as number) * a
    out[i * 4 + 2] = (data[i * 4 + 2] as number) * a
    out[i * 4 + 3] = data[i * 4 + 3] as number
  }
  return out
}

/** Bilinear lookup of channel `ch` at (x, y) (pixel centres at .5); 0 outside. */
function lookup(pre: Float32Array, w: number, h: number, x: number, y: number, ch: number): number {
  const fx = x - 0.5
  const fy = y - 0.5
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const tx = fx - x0
  const ty = fy - y0
  let sum = 0
  for (let j = 0; j < 4; j++) {
    const px = x0 + (j & 1)
    const py = y0 + (j >> 1)
    if (px < 0 || py < 0 || px >= w || py >= h) continue
    sum += (pre[(py * w + px) * 4 + ch] as number) * (j & 1 ? tx : 1 - tx) * (j >> 1 ? ty : 1 - ty)
  }
  return sum
}

/** Writes premultiplied floats back into a picture. */
function toCanvas(source: OffscreenCanvas, pre: Float32Array): OffscreenCanvas {
  const { width: w, height: h } = source
  const out = new ImageData(w, h)
  for (let i = 0; i < w * h; i++) {
    const a = pre[i * 4 + 3] as number
    if (a <= 0) continue
    const k = 255 / a
    out.data[i * 4] = (pre[i * 4] as number) * k
    out.data[i * 4 + 1] = (pre[i * 4 + 1] as number) * k
    out.data[i * 4 + 2] = (pre[i * 4 + 2] as number) * k
    out.data[i * 4 + 3] = a
  }
  const [canvas, g] = canvasLike(source)
  g.putImageData(out, 0, 0)
  return canvas
}

/**
 * Moves pixels: the output pixel at (x, y) shows the picture at
 * `map(x, y)`; with `fringe`, red and blue look up at their own points
 * (map with a bigger and a smaller push) for colour fringing.
 */
export function remap(source: OffscreenCanvas, map: (x: number, y: number, push: number) => Point, fringe = 0): OffscreenCanvas {
  const { width: w, height: h } = source
  const pre = premultiplied(source)
  const out = new Float32Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      const [sx, sy] = map(x + 0.5, y + 0.5, 1)
      if (fringe > 0) {
        const [rx, ry] = map(x + 0.5, y + 0.5, 1 + fringe)
        const [bx, by] = map(x + 0.5, y + 0.5, 1 - fringe)
        const ra = lookup(pre, w, h, rx, ry, 3)
        const ga = lookup(pre, w, h, sx, sy, 3)
        const ba = lookup(pre, w, h, bx, by, 3)
        out[o] = lookup(pre, w, h, rx, ry, 0)
        out[o + 1] = lookup(pre, w, h, sx, sy, 1)
        out[o + 2] = lookup(pre, w, h, bx, by, 2)
        out[o + 3] = Math.max(ra, ga, ba)
        continue
      }
      for (let ch = 0; ch < 4; ch++) out[o + ch] = lookup(pre, w, h, sx, sy, ch)
    }
  }
  return toCanvas(source, out)
}

/** A point given in the layer's box (-1 to 1 on each axis, beyond for outside), in region px. */
function inBox(env: EffectEnv, cx: number, cy: number): Point {
  const [tl, tr, , bl] = env.box
  const u = (cx + 1) / 2
  const v = (cy + 1) / 2
  return [tl[0] + (tr[0] - tl[0]) * u + (bl[0] - tl[0]) * v, tl[1] + (tr[1] - tl[1]) * u + (bl[1] - tl[1]) * v]
}

/** The box's longer side, region px. */
function longSide(env: EffectEnv): number {
  const [tl, tr, , bl] = env.box
  return Math.max(Math.hypot(tr[0] - tl[0], tr[1] - tl[1]), Math.hypot(bl[0] - tl[0], bl[1] - tl[1]), 1)
}

const smoothstep = (t: number) => {
  const c = Math.min(1, Math.max(0, t))
  return c * c * (3 - 2 * c)
}

export function bulge(source: OffscreenCanvas, e: Effect, env: EffectEnv): OffscreenCanvas {
  const strength = num(e, 'strength')
  if (Math.abs(strength) < 0.001) return source
  const [cx, cy] = inBox(env, num(e, 'centerX'), num(e, 'centerY'))
  const radius = num(e, 'radius') * longSide(env)
  const aspect = Math.sqrt(num(e, 'aspect') || 1)
  const soft = num(e, 'softness')
  return remap(
    source,
    (x, y, push) => {
      const dx = (x - cx) / (radius * aspect)
      const dy = (y - cy) / (radius / aspect)
      const d = Math.hypot(dx, dy)
      if (d >= 1) return [x, y]
      // Inside the lens points are looked up nearer the centre (magnify) or farther (pinch), fading out at the rim.
      const falloff = 1 - smoothstep((d - (1 - soft)) / Math.max(0.001, soft))
      const k = 1 - strength * push * falloff * (1 - d * d) * 0.9
      return [cx + (x - cx) * k, cy + (y - cy) * k]
    },
    num(e, 'refract') * 0.08,
  )
}

/** The wave shape at a phase (radians), -1 to 1. */
function waveAt(shape: string, phase: number, seed: number): number {
  switch (shape) {
    case 'triangle':
      return (2 / Math.PI) * Math.asin(Math.sin(phase))
    case 'square':
      return Math.tanh(Math.sin(phase) * 6)
    case 'noise': {
      const t = phase / (Math.PI * 2)
      const k = Math.floor(t)
      const f = t - k
      const a = hash(seed, k) * 2 - 1
      const b = hash(seed, k + 1) * 2 - 1
      return a + (b - a) * f * f * (3 - 2 * f)
    }
    default:
      return Math.sin(phase)
  }
}

export function wave(source: OffscreenCanvas, e: Effect, env: EffectEnv): OffscreenCanvas {
  const amplitude = num(e, 'amplitude') * unit(env)
  if (amplitude < 0.1) return source
  const [dx, dy] = direction(env, num(e, 'angle'))
  const length = Math.max(1, num(e, 'wavelength') * unit(env))
  const travel = e.animate === false ? 0 : (env.timeMs / 1000) * num(e, 'speed') * Math.PI * 2
  const phase = (num(e, 'phase') * Math.PI) / 180 + travel
  const cross = num(e, 'cross')
  const anchor = num(e, 'anchor')
  // Distance along the wave, measured from the box's first corner along its direction.
  const along = env.box.map(([x, y]) => x * dx + y * dy)
  const start = Math.min(...along)
  const span = Math.max(1, Math.max(...along) - start)
  const shape = text(e, 'shape')
  return remap(source, (x, y) => {
    const u = x * dx + y * dy
    const ramp = anchor > 0 ? 1 - anchor + anchor * Math.min(1, Math.max(0, (u - start) / span)) : 1
    const offset = amplitude * ramp * waveAt(shape, ((u - start) / length) * Math.PI * 2 - phase, 7)
    // Across the wave (a flag) or along it (a pulse).
    const ox = -dy * offset * (1 - cross) + dx * offset * cross
    const oy = dx * offset * (1 - cross) + dy * offset * cross
    return [x - ox, y - oy]
  })
}

export function twirl(source: OffscreenCanvas, e: Effect, env: EffectEnv): OffscreenCanvas {
  const angle = (num(e, 'angle') * Math.PI) / 180
  if (Math.abs(angle) < 0.001) return source
  const [cx, cy] = inBox(env, num(e, 'centerX'), num(e, 'centerY'))
  const radius = num(e, 'radius') * longSide(env)
  const soft = 1 + num(e, 'softness') * 2
  return remap(source, (x, y) => {
    const d = Math.hypot(x - cx, y - cy) / radius
    if (d >= 1) return [x, y]
    const turn = -angle * (1 - d) ** soft
    const cos = Math.cos(turn)
    const sin = Math.sin(turn)
    return [cx + (x - cx) * cos - (y - cy) * sin, cy + (x - cx) * sin + (y - cy) * cos]
  })
}

export function lensDistort(source: OffscreenCanvas, e: Effect, env: EffectEnv): OffscreenCanvas {
  const amount = num(e, 'amount')
  const cubic = num(e, 'cubic')
  const scale = num(e, 'scale') || 1
  if (Math.abs(amount) < 0.001 && Math.abs(cubic) < 0.001 && Math.abs(scale - 1) < 0.001) return source
  const [cx, cy] = inBox(env, num(e, 'centerX'), num(e, 'centerY'))
  const reach = longSide(env) / 2
  return remap(
    source,
    (x, y, push) => {
      const nx = (x - cx) / reach
      const ny = (y - cy) / reach
      const r2 = nx * nx + ny * ny
      // Barrel looks the picture up farther out toward the edges (lines bow out); the fringe pushes red and blue apart.
      const k = (1 + amount * push * r2 * 0.5 + cubic * push * r2 * r2 * 0.5) / scale
      return [cx + nx * k * reach, cy + ny * k * reach]
    },
    num(e, 'chroma') * 0.15,
  )
}

export function goo(source: OffscreenCanvas, e: Effect, env: EffectEnv): OffscreenCanvas {
  const reach = num(e, 'blur') * unit(env)
  const [, s] = canvasLike(source)
  s.filter = blurOf(reach)
  s.drawImage(source, 0, 0)
  const { width: w, height: h } = source
  const blurred = s.getImageData(0, 0, w, h)
  const data = blurred.data
  const threshold = num(e, 'threshold')
  const softness = num(e, 'softness')
  // The blurred silhouette cut at the threshold: shapes that came near each other now share one outline.
  // The edge is as wide as the alpha's slope there allows (about 2 px at the default softness), so necks stay crisp.
  const alpha = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) alpha[i] = (data[i * 4 + 3] as number) / 255
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const a = alpha[i] as number
      const gx = ((alpha[x < w - 1 ? i + 1 : i] as number) - (alpha[x > 0 ? i - 1 : i] as number)) / 2
      const gy = ((alpha[y < h - 1 ? i + w : i] as number) - (alpha[y > 0 ? i - w : i] as number)) / 2
      const edge = Math.max(1e-4, Math.hypot(gx, gy) * (0.7 + softness * 25))
      data[i * 4 + 3] = 255 * smoothstep((a - threshold + edge) / (2 * edge))
    }
  }
  const [canvas, g] = canvasLike(source)
  g.putImageData(blurred, 0, 0)
  // Inside the old shapes the sharp picture shows through.
  g.globalCompositeOperation = 'source-atop'
  g.drawImage(source, 0, 0)
  const amount = num(e, 'mix')
  if (amount >= 1) return canvas
  const [out, o] = canvasLike(source)
  o.globalAlpha = 1 - amount
  o.drawImage(source, 0, 0)
  o.globalCompositeOperation = 'lighter'
  o.globalAlpha = amount
  o.drawImage(canvas, 0, 0)
  return out
}

/** A displacement field on a coarse grid (step px apart), smoothly sampled: noise in [-1, 1] for two axes. */
function displacementField(w: number, h: number, step: number, at: (x: number, y: number, axis: number) => number): (x: number, y: number) => Point {
  const cols = Math.ceil(w / step) + 2
  const rows = Math.ceil(h / step) + 2
  const fx = new Float32Array(cols * rows)
  const fy = new Float32Array(cols * rows)
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      fx[j * cols + i] = at(i * step, j * step, 0)
      fy[j * cols + i] = at(i * step, j * step, 1)
    }
  }
  return (x, y) => {
    const gx = Math.min(cols - 1.001, Math.max(0, x / step))
    const gy = Math.min(rows - 1.001, Math.max(0, y / step))
    const i = Math.floor(gx)
    const j = Math.floor(gy)
    const tx = gx - i
    const ty = gy - j
    const bi = (f: Float32Array) =>
      ((f[j * cols + i] as number) * (1 - tx) + (f[j * cols + i + 1] as number) * tx) * (1 - ty) +
      ((f[(j + 1) * cols + i] as number) * (1 - tx) + (f[(j + 1) * cols + i + 1] as number) * tx) * ty
    return [bi(fx), bi(fy)]
  }
}

/** A fractal field card for edges and boils: shape, octaves and sharpness on our value noise. */
function fieldCard(seed: number, shape: string, octaves: number, roughness = 0.5): Effect {
  return { id: 'field', type: 'noise', enabled: true, seed, shape, octaves, roughness, lacunarity: 2, contrast: 1, brightness: 0 }
}

export function roughenEdges(source: OffscreenCanvas, e: Effect, env: EffectEnv): OffscreenCanvas {
  const amount = num(e, 'amount') * unit(env)
  if (amount < 0.25) return source
  const style = text(e, 'style')
  const scale = Math.max(1, num(e, 'scale') * unit(env) * (style === 'torn' ? 2 : 1))
  const seed = num(e, 'seed') + rollAt(e, env.timeMs) * 13
  const z = e.animate === true ? (env.timeMs / 1000) * num(e, 'evolve') : 0
  const field = fieldCard(seed, style === 'spiky' ? 'ridged' : 'fractal', Math.max(1, Math.round(num(e, 'complexity'))))
  const sharp = 0.5 + num(e, 'sharpness') * 2.5
  const [ox, oy] = env.box[0]
  const shaped = (v: number) => Math.sign(v) * Math.abs(v) ** (1 / sharp)
  const push = displacementField(source.width, source.height, Math.max(1, scale / 8), (x, y, axis) =>
    shaped(noiseField(field, (x - ox) / scale, (y - oy) / scale, z, axis * 577) * 2 - 1),
  )
  const { width: w, height: h } = source
  const pre = premultiplied(source)
  const out = new Float32Array(w * h * 4)
  const tint = style === 'rusty' ? (parseColor(text(e, 'color')) ?? [138, 90, 42, 255]) : null
  const tintAmount = num(e, 'tint')
  // Only the outline moves: the alpha comes from a pushed point, the colour stays where it was (or comes from there where there was none).
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let [px, py] = push(x, y)
      if (style === 'melt') {
        px = 0
        py = -Math.abs(py) * 1.5
      }
      if (style === 'torn') py *= 0.4
      const sx = x + 0.5 + px * amount
      const sy = y + 0.5 + py * amount
      const o = (y * w + x) * 4
      const alpha = lookup(pre, w, h, sx, sy, 3)
      const own = pre[o + 3] as number
      const from = own > 1 ? null : [sx, sy]
      const k = alpha / Math.max(1, from ? alpha : own)
      for (let ch = 0; ch < 3; ch++) out[o + ch] = (from ? lookup(pre, w, h, from[0] as number, from[1] as number, ch) : (pre[o + ch] as number)) * k
      out[o + 3] = alpha
      if (tint && alpha > 0) {
        // Rust eats in from the edge: the more the edge moved here, the more tint.
        const eaten = Math.min(1, Math.abs(alpha - own) / 255 + (1 - Math.min(1, own / 255)) * 0.5) * tintAmount
        for (let ch = 0; ch < 3; ch++) out[o + ch] = (out[o + ch] as number) * (1 - eaten) + ((tint[ch] as number) * alpha * eaten) / 255
      }
    }
  }
  return toCanvas(source, out)
}

export function boil(source: OffscreenCanvas, e: Effect, env: EffectEnv): OffscreenCanvas {
  const amount = num(e, 'amount') * unit(env)
  const roll = rollAt(e, env.timeMs)
  const variants = Math.round(num(e, 'variants'))
  const take = variants > 0 ? ((roll % variants) + variants) % variants : roll
  const seed = num(e, 'seed') * 97 + take * 7
  const style = text(e, 'style')
  const scale = Math.max(1, num(e, 'scale') * unit(env) * (style === 'wobble' ? 2.5 : style === 'jitter' ? 0.4 : 1))
  const field = fieldCard(seed, style === 'jitter' ? 'ridged' : 'fractal', style === 'wobble' ? 1 : Math.max(1, Math.round(num(e, 'complexity'))))
  const [ox, oy] = env.box[0]
  const next = random(seed)
  const shake = num(e, 'shake') * unit(env)
  const sx = (next() * 2 - 1) * shake
  const sy = (next() * 2 - 1) * shake
  const turn = ((next() * 2 - 1) * num(e, 'rotate') * Math.PI) / 180
  const [cx, cy] = inBox(env, 0, 0)
  const push = amount >= 0.1 ? displacementField(source.width, source.height, Math.max(1, scale / 6), (x, y, axis) => noiseField(field, (x - ox) / scale, (y - oy) / scale, 0, axis * 389) * 2 - 1) : null
  const cos = Math.cos(turn)
  const sin = Math.sin(turn)
  const result = remap(source, (x, y) => {
    const [px, py] = push ? push(x, y) : [0, 0]
    const ux = x - sx - cx
    const uy = y - sy - cy
    return [cx + ux * cos + uy * sin + px * amount, cy - ux * sin + uy * cos + py * amount]
  })
  const mix = num(e, 'mix')
  if (mix >= 1) return result
  const [canvas, g] = canvasLike(source)
  g.globalAlpha = 1 - mix
  g.drawImage(source, 0, 0)
  g.globalCompositeOperation = 'lighter'
  g.globalAlpha = mix
  g.drawImage(result, 0, 0)
  return canvas
}

export function glitch(source: OffscreenCanvas, e: Effect, env: EffectEnv): OffscreenCanvas {
  const amount = num(e, 'amount')
  if (amount <= 0) return source
  const roll = rollAt(e, env.timeMs)
  const next = random(num(e, 'seed') * 6151 + roll * 389)
  const { width: w, height: h } = source
  const blocks = Math.max(1, Math.round(num(e, 'blocks')))
  const displace = num(e, 'displace') * unit(env)
  const chroma = num(e, 'chroma') * unit(env)
  const direction = text(e, 'direction')
  const [canvas, g] = canvasLike(source)
  g.drawImage(source, 0, 0)
  // The picture cut into bands across the tear direction; each band tears with odds `amount`.
  for (const vertical of direction === 'both' ? [false, true] : [direction === 'vertical']) {
    const length = vertical ? w : h
    const band = length / blocks
    for (let b = 0; b < blocks; b++) {
      if (next() > amount) continue
      const start = Math.floor(b * band + next() * band * 0.3)
      const size = Math.max(1, Math.ceil(band * (0.3 + next() * 0.9)))
      const shift = (next() * 2 - 1) * displace
      const scrambled = next() < num(e, 'scramble')
      const from = scrambled ? Math.floor(next() * Math.max(1, length - size)) : start
      const strip = (dx: number, filter: string, op: GlobalCompositeOperation) => {
        g.save()
        g.beginPath()
        if (vertical) g.rect(start, 0, size, h)
        else g.rect(0, start, w, size)
        g.clip()
        g.globalCompositeOperation = op
        g.filter = filter
        if (vertical) g.drawImage(source, from, 0, size, h, start, dx, size, h)
        else g.drawImage(source, 0, from, w, size, dx, start, w, size)
        g.restore()
      }
      // Clear the band, then draw it torn: shifted, its channels split, sometimes another colour.
      g.save()
      g.beginPath()
      if (vertical) g.rect(start, 0, size, h)
      else g.rect(0, start, w, size)
      g.clip()
      g.clearRect(0, 0, w, h)
      g.restore()
      const hue = next() < num(e, 'colorShift') ? `hue-rotate(${Math.round(next() * 300 + 30)}deg)` : 'none'
      strip(shift, hue, 'source-over')
      if (chroma >= 0.5) {
        strip(shift + chroma, `${hue === 'none' ? '' : `${hue} `}sepia(1) saturate(8) hue-rotate(-50deg)`, 'lighter')
        strip(shift - chroma, `${hue === 'none' ? '' : `${hue} `}sepia(1) saturate(8) hue-rotate(160deg)`, 'lighter')
      }
    }
  }
  if (e.inside !== false) {
    g.globalCompositeOperation = 'destination-in'
    const [shape, s] = canvasLike(source)
    s.drawImage(source, 0, 0)
    // Torn bands may slide past the layer's own pixels, but not past its box.
    s.globalCompositeOperation = 'source-over'
    s.beginPath()
    env.box.forEach(([x, y], i) => (i === 0 ? s.moveTo(x, y) : s.lineTo(x, y)))
    s.closePath()
    s.fill()
    g.drawImage(shape, 0, 0)
  }
  const mix = num(e, 'mix')
  if (mix >= 1) return canvas
  const [out, o] = canvasLike(source)
  o.globalAlpha = 1 - mix
  o.drawImage(source, 0, 0)
  o.globalCompositeOperation = 'lighter'
  o.globalAlpha = mix
  o.drawImage(canvas, 0, 0)
  return out
}
