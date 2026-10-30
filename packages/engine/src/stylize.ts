import { type Effect, effectNumber, parseColor } from '@uve/core'
import { distanceField } from './distance'
import { blurOf, canvasLike, context, direction, type EffectEnv, type Point, unit } from './pixels'

// Colour and stylize cards: grading, ramps, posterize, paint fills, keying,
// halftone, pixelate and bevel. Colour work is per pixel on unpremultiplied
// sRGB values in 0..1; screens and mosaics are drawn with canvas shapes.

const num = effectNumber
const text = (e: Effect, key: string): string => {
  const value = e[key]
  return typeof value === 'string' ? value : ''
}
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const rgbOf = (color: string): [number, number, number, number] => {
  const c = parseColor(color) ?? [0, 0, 0, 255]
  return [(c[0] as number) / 255, (c[1] as number) / 255, (c[2] as number) / 255, (c[3] as number) / 255]
}
const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b

/** Runs `fn` on every visible pixel's colour (0..1, unpremultiplied); it returns the new colour, or null to keep it. */
function perPixel(source: OffscreenCanvas, fn: (r: number, g: number, b: number, x: number, y: number) => [number, number, number] | null): OffscreenCanvas {
  const { width: w, height: h } = source
  const image = context(source).getImageData(0, 0, w, h)
  const d = image.data
  for (let i = 0; i < w * h; i++) {
    if (d[i * 4 + 3] === 0) continue
    const out = fn((d[i * 4] as number) / 255, (d[i * 4 + 1] as number) / 255, (d[i * 4 + 2] as number) / 255, i % w, Math.floor(i / w))
    if (!out) continue
    d[i * 4] = clamp01(out[0]) * 255
    d[i * 4 + 1] = clamp01(out[1]) * 255
    d[i * 4 + 2] = clamp01(out[2]) * 255
  }
  const [canvas, g] = canvasLike(source)
  g.putImageData(image, 0, 0)
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

/** Turns a colour's hue by `deg` (in YIQ, keeping its brightness). */
function hueTurn(r: number, g: number, b: number, deg: number): [number, number, number] {
  const y = 0.299 * r + 0.587 * g + 0.114 * b
  const i = 0.596 * r - 0.274 * g - 0.322 * b
  const q = 0.211 * r - 0.523 * g + 0.312 * b
  const a = (deg * Math.PI) / 180
  const ni = i * Math.cos(a) - q * Math.sin(a)
  const nq = i * Math.sin(a) + q * Math.cos(a)
  return [y + 0.956 * ni + 0.621 * nq, y - 0.272 * ni - 0.647 * nq, y - 1.106 * ni + 1.703 * nq]
}

export function colorGrade(source: OffscreenCanvas, e: Effect): OffscreenCanvas {
  const intensity = num(e, 'intensity')
  if (intensity <= 0) return source
  const exposure = 2 ** num(e, 'exposure')
  const warm = num(e, 'temperature') / 100
  const tint = num(e, 'tint') / 100
  const balance = [1 + warm * 0.2 + tint * 0.08, 1 - tint * 0.16, 1 - warm * 0.2 + tint * 0.08]
  const lift = (['liftR', 'liftG', 'liftB'] as const).map((k) => num(e, k) + num(e, 'liftM'))
  const gamma = (['gammaR', 'gammaG', 'gammaB'] as const).map((k) => num(e, k) + num(e, 'gammaM'))
  const gain = (['gainR', 'gainG', 'gainB'] as const).map((k) => 1 + num(e, k) + num(e, 'gainM'))
  const contrast = num(e, 'contrast')
  const saturation = num(e, 'saturation')
  const vibrance = num(e, 'vibrance')
  const hue = num(e, 'hueDeg')
  return perPixel(source, (r0, g0, b0) => {
    let c = [r0, g0, b0].map((v, ch) => {
      let x = v * exposure * (balance[ch] as number)
      // Lift raises the darks, gain scales the lights, gamma bends the middle.
      x = (gain[ch] as number) * (x + (lift[ch] as number) * (1 - x))
      x = Math.max(0, x) ** (1 / Math.max(0.05, 1 + (gamma[ch] as number)))
      return (x - 0.5) * contrast + 0.5
    }) as [number, number, number]
    const y = luma(...c)
    const sat = Math.max(...c) - Math.min(...c)
    const boost = saturation * (1 + vibrance * (1 - sat))
    c = c.map((v) => y + (v - y) * boost) as [number, number, number]
    if (hue !== 0) c = hueTurn(c[0], c[1], c[2], hue)
    return [r0 + (c[0] - r0) * intensity, g0 + (c[1] - g0) * intensity, b0 + (c[2] - b0) * intensity]
  })
}

export function gradientMap(source: OffscreenCanvas, e: Effect): OffscreenCanvas {
  const low = rgbOf(text(e, 'shadowColor'))
  const mid = rgbOf(text(e, 'midColor'))
  const high = rgbOf(text(e, 'highColor'))
  const midpoint = num(e, 'midpoint')
  const contrast = num(e, 'contrast')
  const brightness = num(e, 'brightness')
  const invert = e.invert === true
  const mapped = perPixel(source, (r, g, b) => {
    let v = clamp01((luma(r, g, b) - 0.5) * contrast + 0.5 + brightness)
    if (invert) v = 1 - v
    const [a, z, t] = v < midpoint ? [low, mid, v / midpoint] : [mid, high, (v - midpoint) / (1 - midpoint)]
    return [a[0] + (z[0] - a[0]) * t, a[1] + (z[1] - a[1]) * t, a[2] + (z[2] - a[2]) * t]
  })
  return mixed(source, mapped, num(e, 'mix'))
}

/** A 4 × 4 ordered dither threshold, 0 to 1. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16)

export function posterize(source: OffscreenCanvas, e: Effect): OffscreenCanvas {
  const levels = Math.max(2, Math.round(num(e, 'levels'))) - 1
  const dither = num(e, 'dither')
  const gamma = num(e, 'gamma') || 1
  const quantise = (v: number, x: number, y: number) => {
    const bent = clamp01(v) ** gamma
    const t = (BAYER[(y % 4) * 4 + (x % 4)] as number) - 0.5
    return (Math.round(bent * levels + t * dither) / levels) ** (1 / gamma)
  }
  const posted = perPixel(source, (r, g, b, x, y) => {
    if (e.luminanceOnly !== true) return [quantise(r, x, y), quantise(g, x, y), quantise(b, x, y)]
    const l = luma(r, g, b)
    const k = l > 0 ? quantise(l, x, y) / l : 0
    return [r * k, g * k, b * k]
  })
  return mixed(source, posted, num(e, 'mix'))
}

/** The box's centre, its axes (unit vectors) and its width and height, region px. */
function boxFrame(env: EffectEnv) {
  const [tl, tr, br, bl] = env.box
  const u: Point = [tr[0] - tl[0], tr[1] - tl[1]]
  const v: Point = [bl[0] - tl[0], bl[1] - tl[1]]
  const width = Math.hypot(...u) || 1
  const height = Math.hypot(...v) || 1
  return { centre: [(tl[0] + br[0]) / 2, (tl[1] + br[1]) / 2] as Point, u: [u[0] / width, u[1] / width] as Point, v: [v[0] / height, v[1] / height] as Point, width, height }
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

export function overlay(source: OffscreenCanvas, e: Effect, env: EffectEnv): OffscreenCanvas {
  const opacity = num(e, 'opacity')
  if (opacity <= 0) return source
  const { centre, width, height } = boxFrame(env)
  const [cx, cy] = [centre[0] + num(e, 'offsetX') * width, centre[1] + num(e, 'offsetY') * height]
  const mode = text(e, 'mode')
  const scale = num(e, 'scale')
  const [paint, p] = canvasLike(source)
  let ramp: CanvasGradient | string
  if (mode === 'solid') ramp = text(e, 'colorA')
  else {
    let gradient: CanvasGradient
    if (mode === 'radial') gradient = p.createRadialGradient(cx, cy, 0, cx, cy, (Math.max(width, height) / 2) * scale)
    else if (mode === 'conic') gradient = p.createConicGradient(((num(e, 'angle') - 90) * Math.PI) / 180, cx, cy)
    else {
      const [dx, dy] = direction(env, num(e, 'angle'))
      const half = ((Math.abs(dx) * width + Math.abs(dy) * height) / 2) * scale
      gradient = p.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half)
    }
    const a = text(e, 'colorA')
    const b = text(e, 'colorB')
    const repeat = Math.max(1, Math.round(num(e, 'repeat')))
    const midpoint = num(e, 'midpoint')
    for (let k = 0; k < repeat; k++) {
      const [first, last] = e.mirror === true && k % 2 === 1 ? [b, a] : [a, b]
      const from = k / repeat
      const span = 1 / repeat
      gradient.addColorStop(from + 0.0001 * Math.min(k, 1), first)
      gradient.addColorStop(from + span * midpoint, mixHex(first, last))
      gradient.addColorStop(from + span - 0.0001, last)
    }
    ramp = gradient
  }
  p.fillStyle = ramp
  p.fillRect(0, 0, paint.width, paint.height)
  clipTo(paint, source, env, e.inside !== false)
  const [canvas, g] = canvasLike(source)
  g.drawImage(source, 0, 0)
  g.globalAlpha = opacity
  g.globalCompositeOperation = (text(e, 'blend') || 'source-over') as GlobalCompositeOperation
  g.drawImage(paint, 0, 0)
  return canvas
}

/** The colour half way between two hex colours. */
function mixHex(a: string, b: string): string {
  const x = rgbOf(a)
  const y = rgbOf(b)
  const c = (i: number) => Math.round((((x[i] as number) + (y[i] as number)) / 2) * 255)
  return `rgba(${c(0)}, ${c(1)}, ${c(2)}, ${((x[3] + y[3]) / 2).toFixed(3)})`
}

/** Colour as luma and two chroma axes (BT.601 YCbCr, 0..1). */
const chromaOf = (r: number, g: number, b: number): [number, number] => [-0.168736 * r - 0.331264 * g + 0.5 * b, 0.5 * r - 0.418688 * g - 0.081312 * b]

export function chromaKey(source: OffscreenCanvas, e: Effect): OffscreenCanvas {
  const [kr, kg, kb] = rgbOf(text(e, 'color'))
  const [kcb, kcr] = chromaOf(kr, kg, kb)
  const kLength = Math.hypot(kcb, kcr) || 1
  const tolerance = (num(e, 'tolerance') / 100) * 0.45
  const softness = (num(e, 'softness') / 100) * 0.45
  const spill = num(e, 'spill') / 100
  const { width: w, height: h } = source
  const image = context(source).getImageData(0, 0, w, h)
  const d = image.data
  const matte = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const r = (d[i * 4] as number) / 255
    const g = (d[i * 4 + 1] as number) / 255
    const b = (d[i * 4 + 2] as number) / 255
    const [cb, cr] = chromaOf(r, g, b)
    // Far from the key colour in chroma: kept; within the tolerance: keyed; the softness between.
    const distance = Math.hypot(cb - kcb, cr - kcr)
    let keep = softness > 0 ? clamp01((distance - tolerance) / softness) : distance > tolerance ? 1 : 0
    if (e.invert === true) keep = 1 - keep
    matte[i] = keep
    if (spill > 0 && keep > 0) {
      // Spill: take away the part of the colour's chroma that leans toward the key's.
      const along = (cb * kcb + cr * kcr) / kLength
      if (along > 0) {
        const take = (along / kLength) * spill * keep
        d[i * 4] = clamp01(r - take * (kr - luma(kr, kg, kb))) * 255
        d[i * 4 + 1] = clamp01(g - take * (kg - luma(kr, kg, kb))) * 255
        d[i * 4 + 2] = clamp01(b - take * (kb - luma(kr, kg, kb))) * 255
      }
    }
  }
  // Choke shrinks the matte (or grows it, negative) by a distance from its edge.
  const choke = num(e, 'choke')
  if (Math.abs(choke) >= 0.5) {
    const field = distanceField(w, h, choke > 0 ? (i) => (matte[i] as number) < 0.5 : (i) => (matte[i] as number) >= 0.5)
    for (let i = 0; i < w * h; i++) {
      const dist = field[i] as number
      if (choke > 0 && (matte[i] as number) >= 0.5) matte[i] = (matte[i] as number) * clamp01(dist - choke)
      if (choke < 0 && (matte[i] as number) < 0.5) matte[i] = Math.max(matte[i] as number, clamp01(-choke + 1 - dist))
    }
  }
  for (let i = 0; i < w * h; i++) {
    const m = matte[i] as number
    if (e.edgesOnly === true) {
      const edge = 1 - Math.abs(m * 2 - 1)
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 255
      d[i * 4 + 3] = (d[i * 4 + 3] as number) * edge
    } else d[i * 4 + 3] = (d[i * 4 + 3] as number) * m
  }
  const [keyed, k] = canvasLike(source)
  k.putImageData(image, 0, 0)
  const feather = num(e, 'feather')
  if (feather < 0.2) return keyed
  // Feather: the matte blurred, the colour left sharp.
  const [soft, s] = canvasLike(source)
  s.filter = blurOf(feather)
  s.drawImage(keyed, 0, 0)
  const [canvas, g] = canvasLike(source)
  g.drawImage(source, 0, 0)
  g.globalCompositeOperation = 'destination-in'
  g.drawImage(soft, 0, 0)
  return canvas
}

/** A cell-shaped path centred on (x, y), `r` its half size (0 to 1 of the cell's half). */
function cellShape(g: OffscreenCanvasRenderingContext2D, shape: string, x: number, y: number, rx: number, ry: number): void {
  if (shape === 'square') g.rect(x - rx, y - ry, rx * 2, ry * 2)
  else if (shape === 'diamond') {
    g.moveTo(x, y - ry)
    g.lineTo(x + rx, y)
    g.lineTo(x, y + ry)
    g.lineTo(x - rx, y)
    g.closePath()
  } else if (shape === 'cross') {
    g.rect(x - rx, y - ry / 3, rx * 2, (ry * 2) / 3)
    g.rect(x - rx / 3, y - ry, (rx * 2) / 3, ry * 2)
  } else if (shape === 'line') g.rect(x - rx * 1.6, y - ry, rx * 3.2, ry * 2)
  else {
    // A new sub-path, or the ellipse would be joined to the shape before it.
    g.moveTo(x + rx, y)
    g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2)
  }
}

export function pixelate(source: OffscreenCanvas, e: Effect, env: EffectEnv): OffscreenCanvas {
  const aspect = Math.sqrt(num(e, 'aspect') || 1)
  const size = Math.max(1, num(e, 'size') * unit(env))
  const cw = size * aspect
  const ch = size / aspect
  if (cw < 1.5 && ch < 1.5) return source
  // Cells line up with the box's corner, so the mosaic does not crawl as the layer moves.
  const [ox, oy] = env.box[0]
  const sx = ((ox % cw) + cw) % cw
  const sy = ((oy % ch) + ch) % ch
  const cols = Math.ceil((source.width + cw) / cw)
  const rows = Math.ceil((source.height + ch) / ch)
  const small = new OffscreenCanvas(cols, rows)
  const s = context(small)
  s.imageSmoothingQuality = 'high'
  s.drawImage(source, sx - cw, sy - ch, cols * cw, rows * ch, 0, 0, cols, rows)
  const [mosaic, m] = canvasLike(source)
  m.imageSmoothingEnabled = false
  m.drawImage(small, 0, 0, cols, rows, sx - cw, sy - ch, cols * cw, rows * ch)
  const shape = text(e, 'shape')
  const gap = num(e, 'gap')
  if (shape !== 'square' || gap > 0) {
    // Each cell cut to its shape (dots make an LED sign), the gap left dark.
    const [mask, k] = canvasLike(source)
    k.filter = blurOf(num(e, 'softness') * Math.min(cw, ch) * 0.25)
    k.beginPath()
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) cellShape(k, shape === 'square' ? 'square' : shape, sx - cw + (i + 0.5) * cw, sy - ch + (j + 0.5) * ch, (cw / 2) * (1 - gap), (ch / 2) * (1 - gap))
    }
    k.fill()
    m.globalCompositeOperation = 'destination-in'
    m.drawImage(mask, 0, 0)
  }
  return mixed(source, mosaic, num(e, 'mix'))
}

export function halftone(source: OffscreenCanvas, e: Effect, env: EffectEnv): OffscreenCanvas {
  const size = Math.max(2, num(e, 'size') * unit(env))
  const { width: w, height: h } = source
  const mode = text(e, 'mode')
  const shape = text(e, 'shape')
  const contrast = num(e, 'contrast')
  const invert = e.invert === true
  const jitter = num(e, 'jitter') * unit(env)
  const spread = num(e, 'spread') * unit(env)
  const pre = context(source).getImageData(0, 0, w, h).data
  // Colour at a point, averaged over the cell (a small cross of samples).
  const sample = (x: number, y: number): [number, number, number, number] => {
    let r = 0
    let g = 0
    let b = 0
    let a = 0
    let n = 0
    for (const [dx, dy] of [[0, 0], [-0.3, 0], [0.3, 0], [0, -0.3], [0, 0.3]] as const) {
      const px = Math.round(x + dx * size)
      const py = Math.round(y + dy * size)
      if (px < 0 || py < 0 || px >= w || py >= h) continue
      const o = (py * w + px) * 4
      const al = (pre[o + 3] as number) / 255
      r += ((pre[o] as number) / 255) * al
      g += ((pre[o + 1] as number) / 255) * al
      b += ((pre[o + 2] as number) / 255) * al
      a += al
      n++
    }
    return n === 0 || a === 0 ? [0, 0, 0, 0] : [r / a, g / a, b / a, a / n]
  }
  const ink = (v: number) => clamp01((v - 0.5) * contrast + 0.5)
  const [out, g] = canvasLike(source)
  const seedRandom = (i: number, j: number, salt: number) => {
    const s = Math.sin(i * 127.1 + j * 311.7 + salt * 74.7) * 43758.5453
    return s - Math.floor(s)
  }
  /** One screen at an angle: for each cell, a shape whose area follows `coverage` (0..1). */
  const screen = (angleDeg: number, coverage: (c: [number, number, number, number]) => number, fill: (c: [number, number, number, number]) => string, op: GlobalCompositeOperation) => {
    const a = (angleDeg * Math.PI) / 180
    const cos = Math.cos(a)
    const sin = Math.sin(a)
    const [ox, oy] = env.box[0]
    const reach = Math.hypot(w, h)
    const n = Math.ceil(reach / size) + 2
    g.globalCompositeOperation = op
    g.filter = blurOf(num(e, 'softness') * size * 0.2)
    const [cx, cy] = [w / 2, h / 2]
    // Cells on a grid turned by the angle, anchored to the box corner.
    const u0 = Math.floor(((cx - ox) * cos + (cy - oy) * sin) / size)
    const v0 = Math.floor((-(cx - ox) * sin + (cy - oy) * cos) / size)
    for (let j = -n; j <= n; j++) {
      for (let i = -n; i <= n; i++) {
        const u = (u0 + i + 0.5) * size
        const v = (v0 + j + 0.5) * size
        let x = ox + u * cos - v * sin
        let y = oy + u * sin + v * cos
        if (x < -size || y < -size || x > w + size || y > h + size) continue
        const c = sample(x, y)
        if (c[3] <= 0.01) continue
        const k = coverage(c)
        if (k <= 0.01) continue
        if (jitter > 0) {
          x += (seedRandom(i, j, 1) - 0.5) * jitter
          y += (seedRandom(i, j, 2) - 0.5) * jitter
        }
        if (spread > 0) {
          const t = seedRandom(i, j, 3) * Math.PI * 2
          const far = seedRandom(i, j, 4) * spread * (1 - k)
          x += Math.cos(t) * far
          y += Math.sin(t) * far
        }
        const r = (size / 2) * Math.sqrt(k) * (shape === 'line' ? 0.6 : 1.05)
        g.fillStyle = fill(c)
        g.beginPath()
        if (shape === 'line') {
          g.save()
          g.translate(x, y)
          g.rotate(a)
          g.rect(-size / 2, -r, size, r * 2)
          g.restore()
        } else cellShape(g, shape, x, y, r, r)
        g.fill()
      }
    }
    g.filter = 'none'
  }
  const darkness = (c: [number, number, number, number]) => {
    const v = ink(1 - luma(c[0], c[1], c[2]))
    return (invert ? 1 - v : v) * c[3]
  }
  const angle = num(e, 'angle')
  const paperColor = text(e, 'paperColor')
  const inkColor = text(e, 'inkColor')
  const css = (c: [number, number, number, number]) => `rgb(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)})`
  if (mode === 'color') {
    g.fillStyle = paperColor
    g.fillRect(0, 0, w, h)
    screen(angle, (c) => clamp01(darkness(c) * 0.6 + 0.35 * c[3]), css, 'source-over')
  } else if (mode === 'cmyk') {
    g.fillStyle = paperColor
    g.fillRect(0, 0, w, h)
    const cmyk = (c: [number, number, number, number]) => {
      const k = 1 - Math.max(c[0], c[1], c[2])
      const div = 1 - k || 1
      return [(1 - c[0] - k) / div, (1 - c[1] - k) / div, (1 - c[2] - k) / div, k]
    }
    const plates: [number, number, string][] = [
      [angle - 30, 0, '#00aeef'],
      [angle + 30, 1, '#ec008c'],
      [angle - 45, 2, '#fff200'],
      [angle, 3, '#231f20'],
    ]
    for (const [plateAngle, index, colour] of plates) screen(plateAngle, (c) => ink(cmyk(c)[index] as number) * c[3], () => colour, 'multiply')
  } else {
    // mono: ink on paper; duotone: ink over the layer's own colours, lifted toward the paper.
    if (mode === 'duotone') {
      g.drawImage(source, 0, 0)
      g.globalAlpha = 0.5
      g.globalCompositeOperation = 'source-atop'
      g.fillStyle = paperColor
      g.fillRect(0, 0, w, h)
      g.globalAlpha = 1
    } else {
      g.fillStyle = paperColor
      g.fillRect(0, 0, w, h)
    }
    screen(angle, darkness, () => inkColor, 'source-over')
  }
  g.globalCompositeOperation = 'source-over'
  clipTo(out, source, env, e.inside !== false)
  return mixed(source, out, num(e, 'mix'))
}

export function bevel(source: OffscreenCanvas, e: Effect, env: EffectEnv): OffscreenCanvas {
  const depth = num(e, 'depth') * unit(env)
  const strength = num(e, 'strength')
  if (depth < 0.5 || strength <= 0) return source
  const { width: w, height: h } = source
  const alpha = context(source).getImageData(0, 0, w, h).data
  const inside = (i: number) => (alpha[i * 4 + 3] as number) >= 128
  const toEdgeInside = distanceField(w, h, (i) => !inside(i))
  const toEdgeOutside = distanceField(w, h, inside)
  const style = text(e, 'style')
  const soft = num(e, 'softness')
  // Height: a slope `depth` wide at the edge, rounded by softness; outer and emboss slopes rise outside too.
  const ramp = (d: number) => {
    const t = clamp01(d / depth)
    const smooth = t * t * (3 - 2 * t)
    return t + (smooth - t) * soft
  }
  const height = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const din = toEdgeInside[i] as number
    const dout = toEdgeOutside[i] as number
    let v = 0
    if (inside(i)) v = style === 'outer' ? 1 : style === 'pillow' ? 1 - ramp(din) : ramp(din)
    else if (style === 'outer' || style === 'emboss') v = 1 - ramp(dout)
    height[i] = v
  }
  const [lx, ly] = direction(env, num(e, 'angle'))
  const elevation = (num(e, 'elevation') * Math.PI) / 180
  const lz = Math.sin(elevation)
  const planar = Math.cos(elevation)
  const light = new ImageData(w, h)
  const shade = new ImageData(w, h)
  const [hr, hg, hb] = rgbOf(text(e, 'highlightColor'))
  const [sr, sg, sb] = rgbOf(text(e, 'shadowColor'))
  const hiOpacity = num(e, 'highlightOpacity')
  const loOpacity = num(e, 'shadowOpacity')
  const outsideToo = style === 'outer' || style === 'emboss'
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      if (!inside(i) && !outsideToo) continue
      // The slope's normal from the height's gradient, lit from the light's direction.
      const gx = ((height[i + 1] as number) - (height[i - 1] as number)) * depth * 0.5
      const gy = ((height[i + w] as number) - (height[i - w] as number)) * depth * 0.5
      const nl = Math.hypot(gx, gy, 1)
      const lit = ((-gx * lx * planar - gy * ly * planar) / nl + lz / nl - lz) * strength
      const o = i * 4
      if (lit > 0) {
        light.data[o] = hr * 255
        light.data[o + 1] = hg * 255
        light.data[o + 2] = hb * 255
        light.data[o + 3] = clamp01(lit * 1.5) * hiOpacity * 255
      } else if (lit < 0) {
        shade.data[o] = sr * 255
        shade.data[o + 1] = sg * 255
        shade.data[o + 2] = sb * 255
        shade.data[o + 3] = clamp01(-lit * 1.5) * loOpacity * 255
      }
    }
  }
  const [lights, l] = canvasLike(source)
  l.putImageData(light, 0, 0)
  const [shades, s] = canvasLike(source)
  s.putImageData(shade, 0, 0)
  const [canvas, g] = canvasLike(source)
  g.drawImage(source, 0, 0)
  for (const [layer, blend] of [
    [shades, text(e, 'shadowBlend')],
    [lights, text(e, 'highlightBlend')],
  ] as const) {
    // Inside the shape the light mixes in its blend; outside (outer, emboss) it is drawn as it is.
    const [kept, k] = canvasLike(source)
    k.drawImage(layer, 0, 0)
    k.globalCompositeOperation = 'destination-in'
    k.drawImage(source, 0, 0)
    g.globalCompositeOperation = (blend || 'source-over') as GlobalCompositeOperation
    g.drawImage(kept, 0, 0)
    if (outsideToo) {
      const [out, o] = canvasLike(source)
      o.drawImage(layer, 0, 0)
      o.globalCompositeOperation = 'destination-out'
      o.drawImage(source, 0, 0)
      g.globalCompositeOperation = 'source-over'
      g.drawImage(out, 0, 0)
    }
  }
  return canvas
}
