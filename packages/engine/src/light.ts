import { type Effect, effectNumber, parseColor } from '@uve/core'
import { hash, noiseField, random, rollAt } from './analog'
import { distanceField } from './distance'
import { blurOf, canvasLike, context, direction, type EffectEnv, type Point, unit } from './pixels'

// Light and material cards: light rays from the layer's bright parts, a lens
// flare, lightning and liquid glass (which bends what lies behind the layer).

const num = effectNumber
const text = (e: Effect, key: string): string => {
  const value = e[key]
  return typeof value === 'string' ? value : ''
}
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** A point given in the layer's box (-1 to 1 on each axis, beyond for outside), in region px. */
function inBox(env: EffectEnv, cx: number, cy: number): Point {
  const [tl, tr, , bl] = env.box
  const u = (cx + 1) / 2
  const v = (cy + 1) / 2
  return [tl[0] + (tr[0] - tl[0]) * u + (bl[0] - tl[0]) * v, tl[1] + (tr[1] - tl[1]) * u + (bl[1] - tl[1]) * v]
}

function sides(env: EffectEnv): [number, number] {
  const [tl, tr, , bl] = env.box
  return [Math.hypot(tr[0] - tl[0], tr[1] - tl[1]) || 1, Math.hypot(bl[0] - tl[0], bl[1] - tl[1]) || 1]
}

/** Draws `layer` over `under` in a blend, `strength` times over (whole passes added). */
function addLight(under: OffscreenCanvas, layer: OffscreenCanvas, blend: string, strength: number, behind = false): OffscreenCanvas {
  const [canvas, g] = canvasLike(under)
  if (!behind) g.drawImage(under, 0, 0)
  for (let i = 0; i < Math.ceil(strength - 1e-6); i++) {
    g.globalAlpha = Math.min(1, strength - i)
    g.globalCompositeOperation = (i === 0 ? blend || 'lighter' : 'lighter') as GlobalCompositeOperation
    g.drawImage(layer, 0, 0)
  }
  if (behind) {
    g.globalAlpha = 1
    g.globalCompositeOperation = 'source-over'
    g.drawImage(under, 0, 0)
  }
  return canvas
}

export function lightRays(source: OffscreenCanvas, e: Effect, env: EffectEnv): OffscreenCanvas {
  const intensity = num(e, 'intensity')
  const length = num(e, 'length')
  if (intensity <= 0 || length <= 0) return source
  const { width: w, height: h } = source
  // The bright parts: above the threshold, in the layer's colours (boosted) or one colour.
  const image = context(source).getImageData(0, 0, w, h)
  const d = image.data
  const threshold = num(e, 'threshold')
  const solid = text(e, 'mode') === 'solid' ? parseColor(text(e, 'color')) : null
  for (let i = 0; i < w * h; i++) {
    const o = i * 4
    const l = (0.2126 * (d[o] as number) + 0.7152 * (d[o + 1] as number) + 0.0722 * (d[o + 2] as number)) / 255
    const keep = clamp01((l - threshold) / Math.max(0.02, 1 - threshold)) * ((d[o + 3] as number) / 255)
    if (solid) {
      d[o] = solid[0] as number
      d[o + 1] = solid[1] as number
      d[o + 2] = solid[2] as number
    }
    d[o + 3] = keep * 255
  }
  const [bright, b] = canvasLike(source)
  b.putImageData(image, 0, 0)
  if (!solid) {
    const [boosted, k] = canvasLike(source)
    k.filter = `saturate(${num(e, 'saturation')})`
    k.drawImage(bright, 0, 0)
    b.clearRect(0, 0, w, h)
    b.drawImage(boosted, 0, 0)
  }
  // Rays: copies of the bright parts grown about the centre, nearer copies stronger (decay), added up.
  const [cx, cy] = inBox(env, num(e, 'centerX'), num(e, 'centerY'))
  const steps = Math.max(4, Math.round(num(e, 'samples')))
  const decay = num(e, 'decay')
  const reach = 1 + length * 1.5
  const [stack, r] = canvasLike(source)
  let total = 0
  const weights = Array.from({ length: steps }, (_, k) => Math.exp((-decay * 3 * k) / steps))
  for (const weight of weights) total += weight
  weights.forEach((weight, k) => {
    const s = reach ** (k / (steps - 1))
    r.setTransform(s, 0, 0, s, cx - cx * s, cy - cy * s)
    r.globalAlpha = Math.min(1, (weight / total) * steps * 0.25)
    r.globalCompositeOperation = 'lighter'
    r.drawImage(bright, 0, 0)
  })
  // The copies are farther apart toward the far end: blur them by that spacing so the shafts read as one.
  const far = Math.max(...env.box.map(([x, y]) => Math.hypot(x - cx, y - cy)))
  const [rays, smooth] = canvasLike(source)
  smooth.filter = blurOf(far * (reach ** (1 / (steps - 1)) - 1) * 0.6)
  smooth.drawImage(stack, 0, 0)
  return addLight(source, rays, text(e, 'blend'), intensity, e.behind === true)
}

export function lensFlare(source: OffscreenCanvas, e: Effect, env: EffectEnv): OffscreenCanvas {
  const brightness = num(e, 'brightness')
  if (brightness <= 0) return source
  const k = unit(env)
  const [lx, ly] = inBox(env, num(e, 'centerX'), num(e, 'centerY'))
  const [cx, cy] = inBox(env, 0, 0)
  const size = num(e, 'size') * k
  const rgb = parseColor(text(e, 'color')) ?? [255, 233, 192, 255]
  const rgba = (c: readonly number[], a: number) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${clamp01(a)})`
  const [flare, f] = canvasLike(source)
  f.globalCompositeOperation = 'lighter'
  // The glow at the light.
  const glow = f.createRadialGradient(lx, ly, 0, lx, ly, Math.max(1, size / 2))
  glow.addColorStop(0, rgba(rgb, 1))
  glow.addColorStop(0.15, rgba(rgb, 0.6))
  glow.addColorStop(1, rgba(rgb, 0))
  f.fillStyle = glow
  f.fillRect(lx - size, ly - size, size * 2, size * 2)
  // The halo: a thin ring around it.
  const halo = num(e, 'halo')
  if (halo > 0) {
    const ring = f.createRadialGradient(lx, ly, size * 0.55, lx, ly, size * 0.75)
    ring.addColorStop(0, rgba(rgb, 0))
    ring.addColorStop(0.5, rgba(rgb, halo * 0.35))
    ring.addColorStop(1, rgba(rgb, 0))
    f.fillStyle = ring
    f.fillRect(lx - size, ly - size, size * 2, size * 2)
  }
  // The streak: a long thin line through the light.
  const streak = num(e, 'streak')
  if (streak > 0) {
    const sc = parseColor(text(e, 'streakColor')) ?? [111, 182, 255, 255]
    const [dx, dy] = direction(env, num(e, 'streakAngle'))
    const long = size * 4
    f.save()
    f.setTransform(dx, dy, -dy, dx, lx, ly)
    const line = f.createLinearGradient(-long, 0, long, 0)
    line.addColorStop(0, rgba(sc, 0))
    line.addColorStop(0.5, rgba(sc, streak))
    line.addColorStop(1, rgba(sc, 0))
    f.fillStyle = line
    f.filter = blurOf(Math.max(1, size * 0.012))
    f.fillRect(-long, -Math.max(1, size * 0.02), long * 2, Math.max(2, size * 0.04))
    f.restore()
  }
  // Ghosts: discs along the line from the light through the centre, each its own hue.
  const ghosts = Math.round(num(e, 'ghosts'))
  const spread = num(e, 'ghostSpread')
  const chroma = num(e, 'ghostChroma')
  for (let i = 0; i < ghosts; i++) {
    const t = 1 + (spread * (i + 1)) / Math.max(1, ghosts)
    const gx = lx + (cx - lx) * t * 1.2
    const gy = ly + (cy - ly) * t * 1.2
    const r = size * (0.08 + hash(7, i) * 0.22)
    const hue = (i * 67 + 200) % 360
    const tone = `hsla(${hue}, ${Math.round(chroma * 90)}%, 70%, `
    const disc = f.createRadialGradient(gx, gy, 0, gx, gy, r)
    disc.addColorStop(0, `${tone}0.08)`)
    disc.addColorStop(0.8, `${tone}0.18)`)
    disc.addColorStop(1, `${tone}0)`)
    f.fillStyle = disc
    f.beginPath()
    f.arc(gx, gy, r, 0, Math.PI * 2)
    f.fill()
  }
  if (e.inside === true) {
    f.globalCompositeOperation = 'destination-in'
    f.drawImage(source, 0, 0)
  }
  return addLight(source, flare, text(e, 'blend'), brightness)
}

/** A jagged line from a to b by midpoint displacement: `levels` halvings, each pushed sideways by up to `chaos` of its length. */
function jagged(a: Point, b: Point, levels: number, chaos: number, next: () => number): Point[] {
  let points: Point[] = [a, b]
  for (let level = 0; level < levels; level++) {
    const out: Point[] = [points[0] as Point]
    for (let i = 1; i < points.length; i++) {
      const p = points[i - 1] as Point
      const q = points[i] as Point
      const dx = q[0] - p[0]
      const dy = q[1] - p[1]
      const push = (next() * 2 - 1) * chaos * 0.5
      out.push([(p[0] + q[0]) / 2 - dy * push, (p[1] + q[1]) / 2 + dx * push], q)
    }
    points = out
  }
  return points
}

/** The part of a polyline between fractions `from` and `to` of its length. */
function slice(points: Point[], from: number, to: number): Point[] {
  const lengths = points.slice(1).map((p, i) => Math.hypot(p[0] - (points[i] as Point)[0], p[1] - (points[i] as Point)[1]))
  const total = lengths.reduce((a, b) => a + b, 0)
  if (total === 0) return points
  const out: Point[] = []
  let walked = 0
  for (let i = 0; i < lengths.length; i++) {
    const seg = lengths[i] as number
    const p = points[i] as Point
    const q = points[i + 1] as Point
    const at = (t: number): Point => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]
    const a = (from * total - walked) / seg
    const b = (to * total - walked) / seg
    if (b >= 0 && a <= 1) {
      if (out.length === 0) out.push(at(Math.max(0, a)))
      out.push(at(Math.min(1, b)))
    }
    walked += seg
  }
  return out
}

export function lightning(source: OffscreenCanvas, e: Effect, env: EffectEnv): OffscreenCanvas {
  const intensity = num(e, 'intensity')
  if (intensity <= 0) return source
  const k = unit(env)
  const roll = rollAt(e, env.timeMs)
  const next = random(num(e, 'seed') * 3571 + roll * 977)
  const { width: w, height: h } = source
  const [bw, bh] = sides(env)
  const reach = Math.max(bw, bh)
  const levels = Math.max(1, Math.round(num(e, 'detail')))
  const chaos = num(e, 'chaos')
  const count = Math.max(1, Math.round(num(e, 'count')))
  const mode = text(e, 'mode')
  // The endpoints of each arc, by mode.
  const arcs: [Point, Point][] = []
  if (mode === 'outline' || mode === 'fill') {
    const alpha = context(source).getImageData(0, 0, w, h).data
    const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && (alpha[(y * w + x) * 4 + 3] as number) >= 128
    const points: Point[] = []
    const stride = Math.max(1, Math.floor(Math.sqrt((w * h) / 40000)))
    for (let y = 0; y < h; y += stride) {
      for (let x = 0; x < w; x += stride) {
        if (!solid(x, y)) continue
        const edge = !solid(x - stride, y) || !solid(x + stride, y) || !solid(x, y - stride) || !solid(x, y + stride)
        if (mode === 'fill' || edge) points.push([x, y])
      }
    }
    if (points.length >= 2) {
      if (mode === 'outline') {
        // Arcs hop between nearby edge points, so they crawl along the outline.
        const [cx, cy] = inBox(env, 0, 0)
        points.sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx))
        for (let i = 0; i < count; i++) {
          const start = Math.floor(next() * points.length)
          const hop = Math.max(2, Math.floor(points.length * (0.05 + next() * 0.12)))
          arcs.push([points[start] as Point, points[(start + hop) % points.length] as Point])
        }
      } else {
        for (let i = 0; i < count; i++) arcs.push([points[Math.floor(next() * points.length)] as Point, points[Math.floor(next() * points.length)] as Point])
      }
    }
  } else if (mode === 'burst') {
    const centre = inBox(env, num(e, 'ax'), num(e, 'ay'))
    for (let i = 0; i < count; i++) {
      const t = next() * Math.PI * 2
      const far = reach * (0.3 + next() * 0.4)
      arcs.push([centre, [centre[0] + Math.cos(t) * far, centre[1] + Math.sin(t) * far]])
    }
  } else {
    const a = inBox(env, num(e, 'ax'), num(e, 'ay'))
    const b = inBox(env, num(e, 'bx'), num(e, 'by'))
    for (let i = 0; i < count; i++) arcs.push([a, b])
  }
  // Which part of each arc shows: all of it, or a window that slides (span, offset, drift, and the sweep).
  const span = num(e, 'span')
  const seconds = env.timeMs / 1000
  const duration = num(e, 'duration')
  let sweep = 0
  if (duration > 0 && span < 1) {
    const delay = num(e, 'delay')
    const run = Math.max(0, seconds - delay)
    sweep = e.loop === true ? (run % (duration + delay)) / duration : Math.min(1, run / duration)
  }
  const startAt = num(e, 'offset') + num(e, 'drift') * seconds + sweep * (1 + span) - (duration > 0 && span < 1 ? span : 0)
  const width = num(e, 'width') * k
  const taper = num(e, 'taper')
  const flicker = 1 - num(e, 'flicker') * hash(num(e, 'seed'), roll, 5)
  const [core, c] = canvasLike(source)
  c.lineCap = 'round'
  c.lineJoin = 'round'
  c.strokeStyle = text(e, 'coreColor') || '#ffffff'
  const stroke = (points: Point[], thickness: number) => {
    // Thinner toward the end of the arc.
    for (let i = 1; i < points.length; i++) {
      const p = points[i - 1] as Point
      const q = points[i] as Point
      c.lineWidth = Math.max(0.5, thickness * (1 - (taper * i) / points.length))
      c.beginPath()
      c.moveTo(p[0], p[1])
      c.lineTo(q[0], q[1])
      c.stroke()
    }
  }
  for (const [a, b] of arcs) {
    const line = jagged(a, b, levels, chaos, next)
    const from = span >= 1 ? 0 : ((startAt % 1) + 1) % 1
    const shown = span >= 1 ? line : slice(line, from, Math.min(1, from + span))
    stroke(shown, width)
    // Branches leave the main arc at random points and fork off to the side.
    const branches = Math.round(num(e, 'branches'))
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]) * num(e, 'branchLength')
    for (let i = 0; i < branches && shown.length > 2; i++) {
      const at = shown[Math.floor(next() * (shown.length - 1))] as Point
      const t = Math.atan2(b[1] - a[1], b[0] - a[0]) + (next() * 2 - 1) * 1.1
      const end: Point = [at[0] + Math.cos(t) * length * (0.4 + next() * 0.6), at[1] + Math.sin(t) * length * (0.4 + next() * 0.6)]
      stroke(jagged(at, end, Math.max(1, levels - 2), chaos, next), width * 0.5)
    }
  }
  // Glow: the core blurred in the arc's colour, under the white-hot core.
  const glowPx = num(e, 'glow') * k
  const [lit, l] = canvasLike(source)
  if (glowPx >= 0.5) {
    const [tinted, t] = canvasLike(source)
    t.drawImage(core, 0, 0)
    t.globalCompositeOperation = 'source-in'
    t.fillStyle = text(e, 'color') || '#8fc4ff'
    t.fillRect(0, 0, w, h)
    l.filter = blurOf(glowPx)
    l.drawImage(tinted, 0, 0)
    l.filter = blurOf(glowPx * 0.3)
    l.globalCompositeOperation = 'lighter'
    l.drawImage(tinted, 0, 0)
    l.filter = 'none'
  }
  l.globalCompositeOperation = 'lighter'
  l.drawImage(core, 0, 0)
  if (e.inside === true) {
    l.globalCompositeOperation = 'destination-in'
    l.drawImage(source, 0, 0)
  }
  return addLight(source, lit, text(e, 'blend'), intensity * flicker)
}

/** The rim profile: height (0 at the edge, 1 inside) at a fraction t of the rim width. */
function profile(name: string, t: number): number {
  const c = clamp01(t)
  switch (name) {
    case 'circle':
      return Math.sqrt(1 - (1 - c) * (1 - c))
    case 'lip':
      return Math.sin(c * Math.PI) * 0.6 + c * 0.4
    case 'concave':
      return c * c
    default:
      return 1 - (1 - c) ** 4
  }
}

export function glass(source: OffscreenCanvas, e: Effect, env: EffectEnv): OffscreenCanvas {
  const backdrop = env.backdrop?.()
  const { width: w, height: h } = source
  const k = unit(env)
  const [bw, bh] = sides(env)
  // What is seen through: the backdrop, frosted and graded.
  const [seen, s] = canvasLike(source)
  if (backdrop) {
    s.filter = `${blurOf(num(e, 'frost') * k)} saturate(${num(e, 'saturation')}) brightness(${num(e, 'brightness')})`
    s.drawImage(backdrop, 0, 0)
    s.filter = 'none'
  }
  const tint = num(e, 'tint')
  if (tint > 0) {
    s.globalAlpha = tint
    s.globalCompositeOperation = 'multiply'
    s.fillStyle = text(e, 'tintColor')
    s.fillRect(0, 0, w, h)
    s.globalAlpha = 1
    s.globalCompositeOperation = 'source-over'
  }
  const seenPixels = s.getImageData(0, 0, w, h).data
  const own = context(source).getImageData(0, 0, w, h).data
  // The glass body: the layer's silhouette moved in by inset, with a curved rim `depth` wide.
  const inside = distanceField(w, h, (i) => (own[i * 4 + 3] as number) < 128)
  const inset = num(e, 'inset') * k
  const rim = Math.max(1, num(e, 'depth') * k, num(e, 'coverage') * Math.min(bw, bh) * 0.5)
  const shape = text(e, 'profile')
  const height = (i: number) => {
    const d = (inside[i] as number) - inset
    return d <= 0 ? 0 : e.edgeOnly === true && d > rim ? 1 : profile(shape, d / rim)
  }
  const bend = num(e, 'refraction') * (num(e, 'ior') - 1) * 2 * rim * 0.5
  const dispersion = num(e, 'dispersion') * 0.25
  const [lx, ly] = direction(env, num(e, 'lightAngle'))
  const light = num(e, 'light')
  const splay = 0.15 + num(e, 'splay') * 0.85
  const lc = parseColor(text(e, 'lightColor')) ?? [255, 255, 255, 255]
  const paint = num(e, 'paint')
  const surface = num(e, 'noise')
  const ripple = num(e, 'ripple')
  const ripplePhase = (num(e, 'ripplePhase') * Math.PI) / 180 + (env.timeMs / 1000) * num(e, 'rippleSpeed') * Math.PI * 2
  const field = { id: 'glass', type: 'noise', enabled: true, seed: 3, shape: 'fractal', octaves: 3, roughness: 0.5, lacunarity: 2, contrast: 1, brightness: 0 }
  const [ox, oy] = env.box[0]
  const out = new ImageData(w, h)
  const sample = (x: number, y: number, ch: number) => {
    const fx = Math.min(w - 1.001, Math.max(0, x))
    const fy = Math.min(h - 1.001, Math.max(0, y))
    const x0 = Math.floor(fx)
    const y0 = Math.floor(fy)
    const tx = fx - x0
    const ty = fy - y0
    const at = (px: number, py: number) => seenPixels[(py * w + px) * 4 + ch] as number
    return (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const alpha = own[i * 4 + 3] as number
      if (alpha === 0) continue
      // The surface's slope (the rim's height in px, plus unevenness and ripples) bends the view.
      let nx = ((x < w - 1 ? height(i + 1) : height(i)) - (x > 0 ? height(i - 1) : height(i))) * rim * 0.5
      let ny = ((y < h - 1 ? height(i + w) : height(i)) - (y > 0 ? height(i - w) : height(i))) * rim * 0.5
      if (surface > 0) {
        const scale = 60 * k * num(e, 'noiseScale')
        nx += (noiseField(field, (x - ox) / scale + 7, (y - oy) / scale, 0) - 0.5) * surface
        ny += (noiseField(field, (x - ox) / scale, (y - oy) / scale + 7, 0) - 0.5) * surface
      }
      if (ripple > 0) {
        const scale = 40 * k * num(e, 'rippleScale')
        const r = Math.hypot(x - ox - bw / 2, y - oy - bh / 2) / scale
        const wave = Math.cos(r * Math.PI * 2 - ripplePhase) * ripple * 0.5
        nx += wave * ((x - ox - bw / 2) / (r * scale + 1))
        ny += wave * ((y - oy - bh / 2) / (r * scale + 1))
      }
      const o = i * 4
      for (let ch = 0; ch < 3; ch++) {
        const push = bend * (1 + (ch - 1) * dispersion)
        out.data[o + ch] = sample(x - nx * push, y - ny * push, ch)
      }
      // The rim light: brightest where the slope faces the light.
      const facing = clamp01((-nx * lx - ny * ly) / splay)
      const glint = facing * light * 0.6
      for (let ch = 0; ch < 3; ch++) {
        const through = out.data[o + ch] as number
        const tinted = through + ((own[o + ch] as number) - through) * paint
        out.data[o + ch] = tinted + ((lc[ch] as number) - tinted) * clamp01(glint)
      }
      out.data[o + 3] = backdrop ? alpha : alpha * paint
    }
  }
  const [canvas, g] = canvasLike(source)
  g.putImageData(out, 0, 0)
  const mix = num(e, 'mix')
  if (mix >= 1) return canvas
  const [blend, b] = canvasLike(source)
  b.globalAlpha = 1 - mix
  b.drawImage(source, 0, 0)
  b.globalCompositeOperation = 'lighter'
  b.globalAlpha = mix
  b.drawImage(canvas, 0, 0)
  return blend
}
