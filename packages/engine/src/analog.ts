import { type Effect, effectNumber, parseColor } from '@uve/core'
import { blurOf, canvasLike, context, type EffectEnv, type Point, unit } from './pixels'

// The analog cards: film grain, procedural noise, a CRT mask and film damage.
// Each re-rolls on a seeded clock (`rate` looks per second, with jitter and
// stutter), so a frame always looks the same in the preview and the export;
// with `animate` off a card holds one look.

const num = effectNumber
const text = (e: Effect, key: string): string => {
  const value = e[key]
  return typeof value === 'string' ? value : ''
}

/** A hash of integers to [0, 1). */
export function hash(...values: number[]): number {
  let h = 0x811c9dc5
  for (const v of values) {
    h = Math.imul(h ^ (v | 0), 0x01000193)
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
    h ^= h >>> 13
  }
  return ((h >>> 0) % 1_000_003) / 1_000_003
}

/** A seeded generator of numbers in [0, 1). */
export function random(seed: number): () => number {
  let a = (seed | 0) ^ 0x9e3779b9
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Which look a card shows at a layer time: the step of its clock (`rate`
 * steps a second), each boundary moved by up to `jitter` of a step, and a
 * step held over with odds `stutter`. 0 for a still card.
 */
export function rollAt(e: Effect, timeMs: number): number {
  if (e.animate !== true) return 0
  const seed = num(e, 'seed')
  const t = (Math.max(0, timeMs) / 1000) * num(e, 'rate')
  const base = Math.floor(t)
  const step = Math.floor(t + (hash(seed, base, 1) - 0.5) * num(e, 'jitter'))
  return step > 0 && hash(seed, step, 2) < num(e, 'stutter') ? step - 1 : step
}

/** A value that changes once per roll, eased between rolls by `smooth` (0 jumps, 1 glides). */
function wander(seed: number, timeMs: number, rate: number, smooth: number, salt: number): number {
  const t = (timeMs / 1000) * rate
  const k = Math.floor(t)
  const a = hash(seed, k, salt) * 2 - 1
  if (smooth <= 0) return a
  const b = hash(seed, k + 1, salt) * 2 - 1
  const f = Math.min(1, (t - k) / Math.max(0.01, smooth))
  return a + (b - a) * f * f * (3 - 2 * f)
}

/** Keeps a texture only where the layer is (`inside`), or inside its box. */
function clipTo(texture: OffscreenCanvas, source: OffscreenCanvas, env: EffectEnv, inside: boolean): void {
  const g = context(texture)
  g.save()
  g.setTransform(1, 0, 0, 1, 0, 0)
  g.globalCompositeOperation = 'destination-in'
  if (inside) g.drawImage(source, 0, 0)
  else {
    g.beginPath()
    env.box.forEach(([x, y], i) => (i === 0 ? g.moveTo(x, y) : g.lineTo(x, y)))
    g.closePath()
    g.fill()
  }
  g.restore()
}

/** The layer with `texture` laid over it in `blend` at `alpha`. */
function layOver(source: OffscreenCanvas, texture: OffscreenCanvas, blend: string, alpha: number, filter = 'none'): OffscreenCanvas {
  const [canvas, g] = canvasLike(source)
  g.filter = filter
  g.drawImage(source, 0, 0)
  g.filter = 'none'
  g.globalAlpha = Math.min(1, Math.max(0, alpha))
  g.globalCompositeOperation = (blend || 'source-over') as GlobalCompositeOperation
  g.drawImage(texture, 0, 0)
  return canvas
}

/** The weighted mean of the layer before and after a card, for `mix`. */
function mixed(source: OffscreenCanvas, result: OffscreenCanvas, amount: number): OffscreenCanvas {
  if (amount >= 1) return result
  if (amount <= 0) return source
  const [canvas, g] = canvasLike(source)
  g.globalAlpha = 1 - amount
  g.drawImage(source, 0, 0)
  g.globalCompositeOperation = 'lighter'
  g.globalAlpha = amount
  g.drawImage(result, 0, 0)
  return canvas
}

export function grain(source: OffscreenCanvas, e: Effect, env: EffectEnv): OffscreenCanvas {
  const amount = num(e, 'amount')
  if (amount <= 0) return source
  const size = Math.max(0.25, num(e, 'size') * unit(env))
  const aspect = Math.sqrt(num(e, 'aspect') || 1)
  const cellW = Math.max(0.25, size * aspect)
  const cellH = Math.max(0.25, size / aspect)
  const w = Math.max(1, Math.ceil(source.width / cellW))
  const h = Math.max(1, Math.ceil(source.height / cellH))
  const chroma = num(e, 'chroma')
  const next = random(num(e, 'seed') * 7919 + rollAt(e, env.timeMs) * 104729)
  const cells = new ImageData(w, h)
  for (let i = 0; i < w * h; i++) {
    const grey = next() * 255
    const o = i * 4
    cells.data[o] = grey + (next() * 255 - grey) * chroma
    cells.data[o + 1] = grey + (next() * 255 - grey) * chroma
    cells.data[o + 2] = grey + (next() * 255 - grey) * chroma
    cells.data[o + 3] = 255
  }
  const small = new OffscreenCanvas(w, h)
  context(small).putImageData(cells, 0, 0)
  const [texture, t] = canvasLike(source)
  const softness = num(e, 'softness') * unit(env)
  t.imageSmoothingEnabled = softness > 0
  t.filter = blurOf(softness)
  t.drawImage(small, 0, 0, w * cellW, h * cellH)
  clipTo(texture, source, env, true)
  return layOver(source, texture, text(e, 'blend'), amount)
}

/** Smooth value noise in [0, 1] on an integer lattice, in three dimensions (the third is time). */
function valueNoise(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const iz = Math.floor(z)
  const fx = x - ix
  const fy = y - iy
  const fz = z - iz
  const sx = fx * fx * (3 - 2 * fx)
  const sy = fy * fy * (3 - 2 * fy)
  const sz = fz * fz * (3 - 2 * fz)
  const corner = (dx: number, dy: number, dz: number) => hash(seed, ix + dx, iy + dy, iz + dz)
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t
  const plane = (dz: number) => lerp(lerp(corner(0, 0, dz), corner(1, 0, dz), sx), lerp(corner(0, 1, dz), corner(1, 1, dz), sx), sy)
  return lerp(plane(0), plane(1), sz)
}

/** The noise card's field at a point (in feature units), shaped and with its contrast and brightness, 0 to 1. */
export function noiseField(e: Effect, x: number, y: number, z: number, salt = 0): number {
  const shape = text(e, 'shape')
  const seed = num(e, 'seed') * 31 + salt
  const octaves = shape === 'value' ? 1 : Math.max(1, Math.round(num(e, 'octaves')))
  let amp = 1
  let freq = 1
  let sum = 0
  let total = 0
  for (let o = 0; o < octaves; o++) {
    const n = valueNoise(x * freq, y * freq, z, seed + o * 101)
    const v = shape === 'turbulence' ? Math.abs(n * 2 - 1) : shape === 'ridged' ? (1 - Math.abs(n * 2 - 1)) ** 2 : n
    sum += v * amp
    total += amp
    amp *= num(e, 'roughness')
    freq *= num(e, 'lacunarity')
  }
  const v = (sum / total - 0.5) * num(e, 'contrast') + 0.5 + num(e, 'brightness')
  return Math.min(1, Math.max(0, v))
}

export function noise(source: OffscreenCanvas, e: Effect, env: EffectEnv): OffscreenCanvas {
  const scale = Math.max(1, num(e, 'scale') * unit(env))
  const aspect = Math.sqrt(num(e, 'aspect') || 1)
  const seconds = env.timeMs / 1000
  const moving = e.animate === true
  const z = moving ? seconds * num(e, 'evolve') : 0
  const [ox, oy] = env.box[0]
  const driftX = moving ? num(e, 'driftX') * unit(env) * seconds : 0
  const driftY = moving ? num(e, 'driftY') * unit(env) * seconds : 0
  // The field is sampled on a grid a sixth of a feature apart (at least a pixel) and smoothed up; it sticks to the layer's box.
  const step = Math.max(1, scale / 6)
  const w = Math.ceil(source.width / step) + 1
  const h = Math.ceil(source.height / step) + 1
  const at = (px: number, py: number, salt = 0) => noiseField(e, (px - ox - driftX) / (scale * aspect), (py - oy - driftY) / (scale / aspect), z, salt)
  const field = new Float32Array(w * h)
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) field[j * w + i] = at(i * step, j * step)

  let result = source
  const displace = num(e, 'displace') * unit(env)
  if (displace >= 0.5) {
    // A second field across the first: the two push each pixel sideways and up or down.
    const across = new Float32Array(w * h)
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) across[j * w + i] = at(i * step, j * step, 977)
    const sample = (grid: Float32Array, x: number, y: number) => {
      const gx = Math.min(w - 1.001, Math.max(0, x / step))
      const gy = Math.min(h - 1.001, Math.max(0, y / step))
      const i = Math.floor(gx)
      const j = Math.floor(gy)
      const fx = gx - i
      const fy = gy - j
      const v = (a: number, b: number) => grid[b * w + a] as number
      return (v(i, j) * (1 - fx) + v(i + 1, j) * fx) * (1 - fy) + (v(i, j + 1) * (1 - fx) + v(i + 1, j + 1) * fx) * fy
    }
    const { width: W, height: H } = source
    const from = context(source).getImageData(0, 0, W, H).data
    const out = new ImageData(W, H)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const sx = Math.round(x + (sample(field, x, y) - 0.5) * 2 * displace)
        const sy = Math.round(y + (sample(across, x, y) - 0.5) * 2 * displace)
        if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue
        const s = (sy * W + sx) * 4
        const o = (y * W + x) * 4
        out.data[o] = from[s] as number
        out.data[o + 1] = from[s + 1] as number
        out.data[o + 2] = from[s + 2] as number
        out.data[o + 3] = from[s + 3] as number
      }
    }
    const [warped, g] = canvasLike(source)
    g.putImageData(out, 0, 0)
    result = warped
  }

  const amount = num(e, 'amount')
  if (amount > 0) {
    const low = parseColor(text(e, 'lowColor')) ?? [0, 0, 0, 255]
    const high = parseColor(text(e, 'highColor')) ?? [255, 255, 255, 255]
    const chroma = num(e, 'chroma')
    const cells = new ImageData(w, h)
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const v = field[j * w + i] as number
        const o = (j * w + i) * 4
        for (let ch = 0; ch < 3; ch++) {
          const own = chroma > 0 ? v + (at(i * step, j * step, 31 * (ch + 1)) - v) * chroma : v
          cells.data[o + ch] = (low[ch] as number) + ((high[ch] as number) - (low[ch] as number)) * own
        }
        cells.data[o + 3] = (low[3] as number) + ((high[3] as number) - (low[3] as number)) * v
      }
    }
    const small = new OffscreenCanvas(w, h)
    context(small).putImageData(cells, 0, 0)
    const [texture, t] = canvasLike(source)
    t.imageSmoothingEnabled = true
    t.drawImage(small, 0, 0, w * step, h * step)
    clipTo(texture, result, env, e.inside !== false)
    result = layOver(result, texture, text(e, 'blend'), amount)
  }
  return mixed(source, result, num(e, 'mix'))
}

/** One cell of a scanline mask, `period` px tall (and wide, for the colour masks), drawn into a pattern. */
function maskCell(shape: string, period: number, aspect: number, thickness: number, softness: number, dark: string): OffscreenCanvas {
  const p = Math.max(1, period)
  const width = shape === 'line' ? 1 : Math.max(3, Math.round(p * aspect))
  const height = shape === 'slot' ? Math.max(2, Math.round(p * 2)) : Math.max(1, Math.round(p))
  const cell = new OffscreenCanvas(width, height)
  const g = context(cell)
  g.fillStyle = '#ffffff'
  g.fillRect(0, 0, width, height)
  const edge = Math.max(0.5, softness * p * 0.5)
  if (shape === 'line') {
    // A dark band `thickness` of the period, its edges feathered by softness.
    const band = g.createLinearGradient(0, 0, 0, height)
    const half = thickness / 2
    const soft = Math.min(0.49, edge / height)
    band.addColorStop(0, dark)
    band.addColorStop(Math.max(0, half - soft / 2), dark)
    band.addColorStop(Math.min(1, half + soft / 2), 'rgba(255,255,255,0)')
    band.addColorStop(Math.max(0, 1 - half - soft / 2), 'rgba(255,255,255,0)')
    band.addColorStop(Math.min(1, 1 - half + soft / 2), dark)
    band.addColorStop(1, dark)
    g.fillStyle = band
    g.fillRect(0, 0, width, height)
    return cell
  }
  // Colour masks: red, green and blue phosphors on the dark colour.
  g.fillStyle = dark
  g.fillRect(0, 0, width, height)
  g.filter = blurOf(softness * 1.5)
  const third = width / 3
  const lit = 1 - thickness
  const phosphors = ['#ff5050', '#50ff50', '#5050ff']
  phosphors.forEach((colour, k) => {
    g.fillStyle = colour
    if (shape === 'grille') g.fillRect(k * third + (third * (1 - lit)) / 2, 0, third * lit, height)
    else if (shape === 'slot') {
      // Slots in staggered columns: every other column is half a cell lower.
      const y = k % 2 === 0 ? 0 : height / 2
      g.fillRect(k * third + (third * (1 - lit)) / 2, y + (height / 2) * (1 - lit) * 0.5, third * lit, (height / 2) * lit)
    } else {
      g.beginPath()
      g.arc(k * third + third / 2, height / 2 + (k === 1 ? -height / 4 : height / 4) * 0.6, (Math.min(third, height) / 2) * lit, 0, Math.PI * 2)
      g.fill()
    }
  })
  return cell
}

/** Bends the picture as if on a curved tube: points move out from the box centre by k·r². */
function bulge(source: OffscreenCanvas, env: EffectEnv, amount: number): OffscreenCanvas {
  const [tl, , br] = env.box
  const cx = (tl[0] + br[0]) / 2
  const cy = (tl[1] + br[1]) / 2
  const radius = Math.max(1, Math.hypot(br[0] - tl[0], br[1] - tl[1]) / 2)
  const { width: W, height: H } = source
  const from = context(source).getImageData(0, 0, W, H).data
  const out = new ImageData(W, H)
  const k = amount * 0.35
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x - cx) / radius
      const dy = (y - cy) / radius
      const f = 1 + k * (dx * dx + dy * dy)
      const sx = Math.round(cx + dx * f * radius)
      const sy = Math.round(cy + dy * f * radius)
      if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue
      const s = (sy * W + sx) * 4
      const o = (y * W + x) * 4
      for (let c = 0; c < 4; c++) out.data[o + c] = from[s + c] as number
    }
  }
  const [canvas, g] = canvasLike(source)
  g.putImageData(out, 0, 0)
  return canvas
}

export function scanlines(source: OffscreenCanvas, e: Effect, env: EffectEnv): OffscreenCanvas {
  const amount = num(e, 'amount')
  const roll = rollAt(e, env.timeMs)
  const moving = e.animate === true
  const period = Math.max(1, num(e, 'pitch') * unit(env))
  const shape = text(e, 'shape') || 'line'
  const flicker = num(e, 'flicker')
  const seed = num(e, 'seed')
  // Brightness: the boost that makes up for the dark lines, and a flicker per roll.
  const bright = 1 + num(e, 'boost') + (moving && flicker > 0 ? (hash(seed, roll, 3) - 0.5) * flicker : 0)
  let base = source
  const bleed = num(e, 'bleed') * unit(env)
  if (bleed >= 0.5) {
    const [glowing, g] = canvasLike(source)
    g.drawImage(source, 0, 0)
    g.globalCompositeOperation = 'screen'
    g.globalAlpha = 0.6
    g.filter = `brightness(1.2) ${blurOf(bleed)}`
    g.drawImage(source, 0, 0)
    base = glowing
  }
  let result = base
  if (amount > 0) {
    const cell = maskCell(shape, period, num(e, 'aspect') || 1, num(e, 'thickness'), num(e, 'softness'), text(e, 'color') || '#000000')
    const [texture, t] = canvasLike(source)
    const pattern = t.createPattern(cell, 'repeat')
    if (pattern) {
      const seconds = env.timeMs / 1000
      const shift = num(e, 'offset') * unit(env) + (moving ? num(e, 'roll') * unit(env) * seconds : 0) + (moving && roll % 2 === 1 ? (period / 2) * num(e, 'interlace') : 0)
      const [ox, oy] = env.box[0]
      // The mask sticks to the layer's box corner, turned by angle and scrolled along the lines' normal.
      pattern.setTransform(new DOMMatrix().translateSelf(ox, oy).rotateSelf(num(e, 'angle')).translateSelf(0, shift))
      t.fillStyle = pattern
      t.fillRect(0, 0, texture.width, texture.height)
      clipTo(texture, source, env, e.inside !== false)
      result = layOver(base, texture, text(e, 'blend'), amount, bright !== 1 ? `brightness(${bright.toFixed(3)})` : 'none')
    }
  }
  const curve = num(e, 'curvature')
  if (curve > 0.001) result = bulge(result, env, curve)
  return mixed(source, result, num(e, 'mix'))
}

export function filmDamage(source: OffscreenCanvas, e: Effect, env: EffectEnv): OffscreenCanvas {
  const seed = num(e, 'seed')
  const roll = rollAt(e, env.timeMs)
  const moving = e.animate === true
  const rate = num(e, 'rate')
  const k = unit(env)
  const [tl, tr, br, bl] = env.box
  const left = Math.min(tl[0], bl[0])
  const top = Math.min(tl[1], tr[1])
  const boxW = Math.max(1, Math.max(tr[0], br[0]) - left)
  const boxH = Math.max(1, Math.max(bl[1], br[1]) - top)
  const time = moving ? env.timeMs : 0

  // Gate weave and flicker: the whole picture drifts, turns and pulses a little.
  const [canvas, g] = canvasLike(source)
  const wx = num(e, 'weaveX') * k * wander(seed, time, rate / 4, num(e, 'weaveSmooth'), 11)
  const wy = num(e, 'weaveY') * k * wander(seed, time, rate / 4, num(e, 'weaveSmooth'), 12)
  const wr = (num(e, 'weaveRotate') * Math.PI) / 180 * wander(seed, time, rate / 4, num(e, 'weaveSmooth'), 13)
  const flicker = 1 + num(e, 'flicker') * 0.5 * wander(seed, time, rate, num(e, 'flickerSmooth'), 14)
  // A slip at a splice: the frame jumps up by part of its height, a dark bar at the join.
  const slip = e.splices === true && moving && hash(seed, roll, 15) < num(e, 'jump') ? num(e, 'jumpAmount') * boxH : 0
  const cx = left + boxW / 2
  const cy = top + boxH / 2
  g.filter = flicker !== 1 ? `brightness(${flicker.toFixed(3)})` : 'none'
  g.setTransform(Math.cos(wr), Math.sin(wr), -Math.sin(wr), Math.cos(wr), cx + wx - cx * Math.cos(wr) + cy * Math.sin(wr), cy + wy - slip - cx * Math.sin(wr) - cy * Math.cos(wr))
  g.drawImage(source, 0, 0)
  if (slip > 0) g.drawImage(source, 0, boxH)
  g.setTransform(1, 0, 0, 1, 0, 0)
  g.filter = 'none'

  // The damage is drawn on its own layer, then kept where the picture is.
  const [marks, m] = canvasLike(source)
  if (slip > 0) {
    m.fillStyle = `rgba(0,0,0,${num(e, 'splice')})`
    m.fillRect(left, top + boxH - slip - 6 * k, boxW, 12 * k)
  }
  const next = random(seed * 4099 + roll * 131)
  const dust = num(e, 'dust')
  const specks = Math.round(dust * 40 * ((boxW * boxH) / (1920 * 1080)) * 4 + (dust > 0 ? dust * 6 : 0))
  const bias = num(e, 'dustBias')
  const speckSize = num(e, 'dustSize') * k
  m.filter = blurOf(num(e, 'dustSoftness') * speckSize)
  for (let i = 0; i < specks; i++) {
    const x = left + next() * boxW
    const y = top + next() * boxH
    const r = speckSize * (0.3 + next())
    m.fillStyle = next() < (1 + bias) / 2 ? 'rgba(10,8,6,0.85)' : 'rgba(250,248,240,0.85)'
    m.beginPath()
    m.ellipse(x, y, r, r * (0.4 + next() * 0.6), next() * Math.PI, 0, Math.PI * 2)
    m.fill()
  }
  // Scratches live a while (a second or so), wandering sideways as the reel runs.
  const seconds = time / 1000
  const scratchCount = Math.round(num(e, 'scratches'))
  m.filter = blurOf(num(e, 'scratchSoftness') * num(e, 'scratchWidth') * k)
  m.strokeStyle = text(e, 'scratchColor') || '#ffffff'
  m.lineWidth = num(e, 'scratchWidth') * k
  const tilt = (num(e, 'scratchAngle') * Math.PI) / 180
  for (let i = 0; i < scratchCount; i++) {
    const life = 0.6 + hash(seed, i, 21) * 2
    const era = Math.floor((seconds + hash(seed, i, 22) * life) / life)
    if (hash(seed, i, era, 23) < 0.25) continue
    const x = left + hash(seed, i, era, 24) * boxW + (hash(seed, i, era, 25) - 0.5) * num(e, 'scratchDrift') * k * ((seconds % life) - life / 2)
    const length = num(e, 'scratchLength') * boxH * (0.5 + hash(seed, i, era, 26) / 2)
    const y = top + hash(seed, i, era, 27) * Math.max(0, boxH - length)
    m.globalAlpha = num(e, 'scratchOpacity') * (0.6 + 0.4 * next())
    m.beginPath()
    m.moveTo(x, y)
    m.lineTo(x + Math.tan(tilt) * length, y + length)
    m.stroke()
  }
  // Hairs: dark curls that sit on the gate for a moment.
  const hairs = Math.round(num(e, 'hairs'))
  m.filter = 'none'
  m.strokeStyle = 'rgba(12,10,8,1)'
  m.lineWidth = num(e, 'hairWidth') * k
  m.lineCap = 'round'
  for (let i = 0; i < hairs; i++) {
    const era = Math.floor(seconds * 1.5 + hash(seed, i, 31))
    const x = left + hash(seed, i, era, 32) * boxW
    const y = top + hash(seed, i, era, 33) * boxH
    const length = num(e, 'hairSize') * boxH
    const point = (salt: number): Point => [x + (hash(seed, i, era, salt) - 0.5) * length, y + (hash(seed, i, era, salt + 1) - 0.5) * length]
    const [ax, ay] = point(34)
    const [bx, by] = point(36)
    const [ex, ey] = point(38)
    m.globalAlpha = num(e, 'hairOpacity')
    m.beginPath()
    m.moveTo(x, y)
    m.bezierCurveTo(ax, ay, bx, by, ex, ey)
    m.stroke()
  }
  m.globalAlpha = 1
  clipTo(marks, canvas, env, e.inside !== false)
  g.drawImage(marks, 0, 0)
  return mixed(source, canvas, num(e, 'mix'))
}
