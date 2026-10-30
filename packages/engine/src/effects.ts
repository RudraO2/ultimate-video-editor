import { type Effect, effectNumber, parseColor } from '@uve/core'
import type { Ctx2D } from './content'
import { filmDamage, grain, noise, scanlines } from './analog'
import { boil, bulge, glitch, goo, lensDistort, roughenEdges, twirl, wave } from './distort'
import { glass, lensFlare, lightning, lightRays } from './light'
import { bevel, chromaKey, colorGrade, gradientMap, halftone, overlay, pixelate, posterize } from './stylize'
import { distanceField } from './distance'
import { pixelScale } from './paint'
import { blurOf, canvasLike, context, direction, type EffectEnv, type Point, splitAlpha, unit, vec } from './pixels'

export type { EffectEnv } from './pixels'
export { distanceField } from './distance'

// Layer effects: each card turns the layer's drawn pixels (a region of the
// output, premultiplied RGBA) into new ones, first card first. Lengths are in
// layer px and go through the layer's own scale and turn, so a shadow's
// offset turns with the layer and a glow grows with it.

const text = (e: Effect, key: string): string => {
  const value = e[key]
  return typeof value === 'string' ? value : ''
}

/** The layer's silhouette in one colour (the colour's own alpha kept). */
function tinted(source: OffscreenCanvas, color: string): OffscreenCanvas {
  const [canvas, g] = canvasLike(source)
  g.drawImage(source, 0, 0)
  g.globalCompositeOperation = 'source-in'
  g.fillStyle = color
  g.fillRect(0, 0, canvas.width, canvas.height)
  return canvas
}

function shadow(source: OffscreenCanvas, e: Effect, env: EffectEnv): OffscreenCanvas {
  const [canvas, g] = canvasLike(source)
  const [ox, oy] = vec(env, effectNumber(e, 'x'), effectNumber(e, 'y'))
  g.filter = blurOf(effectNumber(e, 'blur') * unit(env))
  g.drawImage(tinted(source, text(e, 'color')), ox, oy)
  g.filter = 'none'
  g.drawImage(source, 0, 0)
  return canvas
}

/** Colour where the layer is not, then blurred and kept only where it is: light or shade from the edges in. */
function edgesIn(source: OffscreenCanvas, color: string, offset: Point, blur: number): OffscreenCanvas {
  const [outside, o] = canvasLike(source)
  o.fillStyle = color
  o.fillRect(0, 0, outside.width, outside.height)
  o.globalCompositeOperation = 'destination-out'
  o.drawImage(source, offset[0], offset[1])
  const [inner, g] = canvasLike(source)
  g.filter = blurOf(blur)
  g.drawImage(outside, 0, 0)
  g.filter = 'none'
  g.globalCompositeOperation = 'destination-in'
  g.drawImage(source, 0, 0)
  return inner
}

function innerShadow(source: OffscreenCanvas, e: Effect, env: EffectEnv): OffscreenCanvas {
  const [canvas, g] = canvasLike(source)
  g.drawImage(source, 0, 0)
  g.drawImage(edgesIn(source, text(e, 'color'), vec(env, effectNumber(e, 'x'), effectNumber(e, 'y')), effectNumber(e, 'blur') * unit(env)), 0, 0)
  return canvas
}

/** Draws `layer` `strength` times over: whole passes at full alpha, the rest at partial alpha, added (lighter) after the first. */
function stamp(g: OffscreenCanvasRenderingContext2D, layer: OffscreenCanvas, strength: number, first: GlobalCompositeOperation): void {
  for (let i = 0; i < Math.ceil(strength - 1e-6); i++) {
    g.globalAlpha = Math.min(1, strength - i)
    g.globalCompositeOperation = i === 0 ? first : 'lighter'
    g.drawImage(layer, 0, 0)
  }
  g.globalAlpha = 1
  g.globalCompositeOperation = 'source-over'
}

function glow(source: OffscreenCanvas, e: Effect, env: EffectEnv): OffscreenCanvas {
  const size = effectNumber(e, 'size') * unit(env)
  const intensity = effectNumber(e, 'intensity')
  const solid = text(e, 'mode') === 'solid'
  const tone = `saturate(${effectNumber(e, 'saturation')}) brightness(${effectNumber(e, 'brightness')})`
  const [canvas, g] = canvasLike(source)
  if (e.inner === true) {
    // Light that reaches in from the edges: the layer's own colours (auto) or one colour, kept near the edges.
    const edges = edgesIn(source, '#ffffff', [0, 0], size)
    const [light, l] = canvasLike(source)
    if (solid) {
      l.fillStyle = text(e, 'color')
      l.fillRect(0, 0, light.width, light.height)
    } else {
      l.filter = tone
      l.drawImage(source, 0, 0)
      l.filter = 'none'
    }
    l.globalCompositeOperation = 'destination-in'
    l.drawImage(edges, 0, 0)
    g.drawImage(source, 0, 0)
    stamp(g, light, intensity, 'source-over')
    return canvas
  }
  const [light, l] = canvasLike(source)
  l.filter = solid ? blurOf(size) : `${tone} ${blurOf(size)}`
  l.drawImage(solid ? tinted(source, text(e, 'color')) : source, 0, 0)
  stamp(g, light, intensity, 'source-over')
  g.drawImage(source, 0, 0)
  return canvas
}

function blur(source: OffscreenCanvas, e: Effect, env: EffectEnv): OffscreenCanvas {
  const px = effectNumber(e, 'radius') * unit(env)
  if (px < 0.2) return source
  const [canvas, g] = canvasLike(source)
  g.filter = blurOf(px)
  g.drawImage(source, 0, 0)
  return canvas
}

/**
 * An outline of the drawn shape, found from the pixels: distance fields to
 * the shape and to the space around it give a band of the width outside,
 * inside or across the edge, feathered by softness.
 */
function outline(source: OffscreenCanvas, e: Effect, env: EffectEnv): OffscreenCanvas {
  const width = effectNumber(e, 'width') * unit(env)
  if (width < 0.25) return source
  const { width: w, height: h } = source
  const pixels = context(source).getImageData(0, 0, w, h)
  const alpha = (i: number) => pixels.data[i * 4 + 3] as number
  const toShape = distanceField(w, h, (i) => alpha(i) >= 128)
  const toSpace = distanceField(w, h, (i) => alpha(i) < 128)
  const placement = text(e, 'placement')
  const ramp = Math.max(1, effectNumber(e, 'softness') * width)
  const cover = (reach: number, d: number) => Math.min(1, Math.max(0, (reach + 0.5 - d) / ramp + (ramp > 1 ? 0.5 : 0)))
  const [r, g, b, a] = parseColor(text(e, 'color')) ?? [0, 0, 0, 255]
  const band = new ImageData(w, h)
  for (let i = 0; i < w * h; i++) {
    const out = toShape[i] as number
    const into = toSpace[i] as number
    let c: number
    if (placement === 'inside') c = out > 0 ? 0 : cover(width, into)
    else if (placement === 'center') c = cover(width / 2, out > 0 ? out : into - 1)
    // Outside: the band, and under the shape's own edge so its soft pixels sit on the outline.
    else c = out > 0 ? cover(width, out) : into <= 1.5 ? 1 : 0
    if (c <= 0) continue
    const o = i * 4
    band.data[o] = r
    band.data[o + 1] = g
    band.data[o + 2] = b
    band.data[o + 3] = Math.round(c * a)
  }
  const [stroke, s] = canvasLike(source)
  s.putImageData(band, 0, 0)
  const [canvas, out] = canvasLike(source)
  if (placement === 'outside') {
    out.drawImage(stroke, 0, 0)
    out.drawImage(source, 0, 0)
  } else {
    out.drawImage(source, 0, 0)
    if (placement === 'inside') out.globalCompositeOperation = 'source-atop'
    out.drawImage(stroke, 0, 0)
  }
  return canvas
}

/** Where the layer's box lies along a direction: the least and greatest projection of its corners. */
function span(env: EffectEnv, [dx, dy]: Point): [number, number] {
  const p = env.box.map(([x, y]) => x * dx + y * dy)
  return [Math.min(...p), Math.max(...p)]
}

function longShadow(source: OffscreenCanvas, e: Effect, env: EffectEnv): OffscreenCanvas {
  const length = effectNumber(e, 'length') * unit(env)
  if (length < 0.5) return source
  const [dx, dy] = direction(env, effectNumber(e, 'angle'))
  const [opaque, alpha] = splitAlpha(text(e, 'color'))
  // The silhouette smeared along the direction by doubling: each pass adds a copy as far again.
  let smear = tinted(source, opaque)
  for (let covered = 0; covered < length; ) {
    const step = Math.min(covered + 1, length - covered)
    const [next, n] = canvasLike(source)
    n.drawImage(smear, 0, 0)
    n.drawImage(smear, dx * step, dy * step)
    smear = next
    covered += step
  }
  const fade = effectNumber(e, 'fade')
  if (fade > 0) {
    const [from, to] = span(env, [dx, dy])
    const s = context(smear)
    const ramp = s.createLinearGradient(dx * from, dy * from, dx * (to + length), dy * (to + length))
    ramp.addColorStop(0, 'rgba(0,0,0,1)')
    ramp.addColorStop(1, `rgba(0,0,0,${1 - fade})`)
    s.globalCompositeOperation = 'destination-in'
    s.fillStyle = ramp
    s.fillRect(0, 0, smear.width, smear.height)
  }
  const [canvas, g] = canvasLike(source)
  g.globalAlpha = alpha
  g.drawImage(smear, 0, 0)
  g.globalAlpha = 1
  g.drawImage(source, 0, 0)
  return canvas
}

function rgbSplit(source: OffscreenCanvas, e: Effect, env: EffectEnv): OffscreenCanvas {
  const distance = effectNumber(e, 'distance') * unit(env)
  if (distance < 0.5) return source
  const [dx, dy] = direction(env, effectNumber(e, 'angle'))
  const sx = Math.round(dx * distance)
  const sy = Math.round(dy * distance)
  const { width: w, height: h } = source
  const from = context(source).getImageData(0, 0, w, h).data
  const out = new ImageData(w, h)
  // Premultiplied channel `ch` and alpha of the pixel at (x, y), or nothing outside.
  const at = (x: number, y: number, ch: number): [number, number] => {
    if (x < 0 || y < 0 || x >= w || y >= h) return [0, 0]
    const o = (y * w + x) * 4
    const a = from[o + 3] as number
    return [((from[o + ch] as number) * a) / 255, a]
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, ra] = at(x - sx, y - sy, 0)
      const [g, ga] = at(x, y, 1)
      const [b, ba] = at(x + sx, y + sy, 2)
      const a = Math.max(ra, ga, ba)
      if (a === 0) continue
      const o = (y * w + x) * 4
      out.data[o] = (r * 255) / a
      out.data[o + 1] = (g * 255) / a
      out.data[o + 2] = (b * 255) / a
      out.data[o + 3] = a
    }
  }
  const [canvas, c] = canvasLike(source)
  c.putImageData(out, 0, 0)
  return canvas
}

function adjust(source: OffscreenCanvas, e: Effect): OffscreenCanvas {
  const [canvas, g] = canvasLike(source)
  g.filter = [
    `brightness(${effectNumber(e, 'brightness')})`,
    `contrast(${effectNumber(e, 'contrast')})`,
    `saturate(${effectNumber(e, 'saturate')})`,
    `hue-rotate(${effectNumber(e, 'hueDeg')}deg)`,
    `grayscale(${effectNumber(e, 'grayscale')})`,
    `sepia(${effectNumber(e, 'sepia')})`,
  ].join(' ')
  g.drawImage(source, 0, 0)
  return canvas
}

/** Draws in the layer's box space: (0, 0) its top-left corner, (1, 1) its bottom-right, with axis lengths overridden. */
function boxSpace(g: OffscreenCanvasRenderingContext2D, env: EffectEnv, lengths?: [number, number]): void {
  const [tl, tr, , bl] = env.box
  let u: Point = [tr[0] - tl[0], tr[1] - tl[1]]
  let v: Point = [bl[0] - tl[0], bl[1] - tl[1]]
  if (lengths) {
    const lu = Math.hypot(...u) || 1
    const lv = Math.hypot(...v) || 1
    const cx = tl[0] + (u[0] + v[0]) / 2
    const cy = tl[1] + (u[1] + v[1]) / 2
    u = [(u[0] / lu) * lengths[0], (u[1] / lu) * lengths[0]]
    v = [(v[0] / lv) * lengths[1], (v[1] / lv) * lengths[1]]
    g.setTransform(u[0], u[1], v[0], v[1], cx - (u[0] + v[0]) / 2, cy - (u[1] + v[1]) / 2)
    return
  }
  g.setTransform(u[0], u[1], v[0], v[1], tl[0], tl[1])
}

function vignette(source: OffscreenCanvas, e: Effect, env: EffectEnv): OffscreenCanvas {
  const amount = effectNumber(e, 'amount')
  if (Math.abs(amount) < 0.001) return source
  const [tl, tr, , bl] = env.box
  const lu = Math.hypot(tr[0] - tl[0], tr[1] - tl[1])
  const lv = Math.hypot(bl[0] - tl[0], bl[1] - tl[1])
  const round = effectNumber(e, 'roundness')
  const big = Math.max(lu, lv)
  const [canvas, g] = canvasLike(source)
  g.drawImage(source, 0, 0)
  boxSpace(g, env, [lu + (big - lu) * round, lv + (big - lv) * round])
  // From clear in the middle to the edge colour past the corners; softness widens the ramp.
  const outer = Math.SQRT1_2
  const inner = outer * (1 - Math.max(0.05, effectNumber(e, 'softness')))
  const shade = amount > 0 ? splitAlpha(text(e, 'color'))[0] : 'rgb(255, 255, 255)'
  const ramp = g.createRadialGradient(0.5, 0.5, inner, 0.5, 0.5, outer)
  ramp.addColorStop(0, 'rgba(0,0,0,0)')
  ramp.addColorStop(1, shade)
  g.globalCompositeOperation = 'source-atop'
  g.globalAlpha = Math.min(1, Math.abs(amount))
  g.fillStyle = ramp
  g.fillRect(-1, -1, 3, 3)
  return canvas
}

function sharpen(source: OffscreenCanvas, e: Effect, env: EffectEnv): OffscreenCanvas {
  const amount = effectNumber(e, 'amount')
  if (amount <= 0) return source
  const { width: w, height: h } = source
  const [soft, s] = canvasLike(source)
  s.filter = blurOf(Math.max(0.3, effectNumber(e, 'radius') * unit(env)))
  s.drawImage(source, 0, 0)
  const sharp = context(source).getImageData(0, 0, w, h)
  const blurred = s.getImageData(0, 0, w, h).data
  const data = sharp.data
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue
    for (let ch = 0; ch < 3; ch++) {
      const value = data[i + ch] as number
      data[i + ch] = value + amount * (value - (blurred[i + ch] as number))
    }
  }
  const [canvas, c] = canvasLike(source)
  c.putImageData(sharp, 0, 0)
  return canvas
}

/**
 * The mean of 2^levels copies of the layer spread evenly over `span`, where
 * `place(g, t)` sets the transform that moves a copy by t (a shift, a turn
 * or a log-scale, about a fixed point, so moves add up). Each level averages
 * two copies of the level before, half a step either side, so 32 samples
 * take 5 draws; premultiplied pixels make streaks fade where copies miss.
 */
export function smear(source: OffscreenCanvas, span: number, levels: number, place: (g: OffscreenCanvasRenderingContext2D, t: number) => void, offset = 0): OffscreenCanvas {
  let current = source
  for (let j = 0; j < levels; j++) {
    const d = span / 2 ** (j + 2)
    const [next, g] = canvasLike(source)
    g.globalAlpha = 0.5
    place(g, -d)
    g.drawImage(current, 0, 0)
    g.globalCompositeOperation = 'lighter'
    place(g, d)
    g.drawImage(current, 0, 0)
    current = next
  }
  if (offset !== 0) {
    const [next, g] = canvasLike(source)
    place(g, offset)
    g.drawImage(current, 0, 0)
    current = next
  }
  return current
}

/** Halving levels for a streak `length` output px long: samples about 1.5 px apart, 2 to 64 of them. */
const levelsFor = (length: number) => Math.max(1, Math.min(6, Math.ceil(Math.log2(Math.max(2, length / 1.5)))))

function directionalBlur(source: OffscreenCanvas, e: Effect, env: EffectEnv): OffscreenCanvas {
  const length = effectNumber(e, 'distance') * unit(env)
  if (length < 0.5) return source
  const [dx, dy] = direction(env, effectNumber(e, 'angle'))
  return smear(source, length, levelsFor(length), (g, t) => g.setTransform(1, 0, 0, 1, dx * t, dy * t))
}

/** A centre given in the layer's box (-1 to 1 on each axis), in region px. */
function boxCentre(env: EffectEnv, e: Effect): Point {
  const [tl, tr, , bl] = env.box
  const u = (effectNumber(e, 'centerX') + 1) / 2
  const v = (effectNumber(e, 'centerY') + 1) / 2
  return [tl[0] + (tr[0] - tl[0]) * u + (bl[0] - tl[0]) * v, tl[1] + (tr[1] - tl[1]) * u + (bl[1] - tl[1]) * v]
}

/** The farthest the region reaches from a point, px. */
function farthest(source: OffscreenCanvas, [cx, cy]: Point): number {
  return Math.max(...[[0, 0], [source.width, 0], [0, source.height], [source.width, source.height]].map(([x, y]) => Math.hypot((x as number) - cx, (y as number) - cy)))
}

function zoomBlur(source: OffscreenCanvas, e: Effect, env: EffectEnv): OffscreenCanvas {
  // Copies grown up to 1 / (1 - strength) about the centre: streaks run out from it.
  const strength = Math.min(0.95, effectNumber(e, 'strength'))
  const [cx, cy] = boxCentre(env, e)
  const reach = farthest(source, [cx, cy]) * strength
  if (reach < 0.5) return source
  const logSpan = -Math.log(1 - strength)
  const grow = (g: OffscreenCanvasRenderingContext2D, t: number) => {
    const s = Math.exp(t)
    g.setTransform(s, 0, 0, s, cx - cx * s, cy - cy * s)
  }
  return smear(source, logSpan, levelsFor(reach), grow, logSpan / 2)
}

function spinBlur(source: OffscreenCanvas, e: Effect, env: EffectEnv): OffscreenCanvas {
  const arc = (effectNumber(e, 'angle') * Math.PI) / 180
  const [cx, cy] = boxCentre(env, e)
  const reach = farthest(source, [cx, cy]) * arc
  if (reach < 0.5) return source
  const turn = (g: OffscreenCanvasRenderingContext2D, t: number) => {
    const cos = Math.cos(t)
    const sin = Math.sin(t)
    g.setTransform(cos, sin, -sin, cos, cx - cx * cos + cy * sin, cy - cx * sin - cy * cos)
  }
  return smear(source, arc, levelsFor(reach), turn)
}

/** Where a shine's bands are: its position plus how far the current pass has gone (AtomCut's sweep timing). */
export function shinePosition(e: Effect, timeMs: number): number {
  const position = effectNumber(e, 'position')
  const duration = effectNumber(e, 'duration')
  if (!(duration > 0)) return position
  const delay = Math.max(0, effectNumber(e, 'delay'))
  const t = timeMs / 1000
  if (t < delay) return position
  const run = t - delay
  if (e.loop !== true) return position + Math.min(1, run / duration)
  const cycle = duration + delay
  const into = ((run % cycle) + cycle) % cycle
  return position + (into >= duration ? 1 : into / duration)
}

function shine(source: OffscreenCanvas, e: Effect, env: EffectEnv): OffscreenCanvas {
  const at = shinePosition(e, env.timeMs)
  const intensity = effectNumber(e, 'intensity')
  if (at <= 0 || at >= 1 || intensity <= 0) return source
  // The bands travel across the band direction: angle 0 is an upright band moving right.
  const [dx, dy] = direction(env, effectNumber(e, 'angle'))
  const [from, to] = span(env, [dx, dy])
  const width = Math.max(1, effectNumber(e, 'width') * unit(env))
  const bloom = effectNumber(e, 'bloom') * unit(env)
  const count = Math.max(1, Math.round(effectNumber(e, 'count')))
  const spacing = effectNumber(e, 'gap') * (to - from)
  // A pass starts with every band before the box and ends with every band past it, glow included.
  const start = from - width / 2 - bloom * 2
  const end = to + width / 2 + (count - 1) * spacing + bloom * 2
  const lead = start + at * (end - start)
  const soft = effectNumber(e, 'softness')
  const falloff = effectNumber(e, 'falloff')
  const [opaque, colorAlpha] = splitAlpha(text(e, 'color'))
  const [light, l] = canvasLike(source)
  for (let i = 0; i < count; i++) {
    const centre = lead - i * spacing
    const strength = Math.min(1, intensity * (1 - falloff) ** i) * colorAlpha
    // In band space: x runs along the travel, y along the band.
    l.setTransform(dx, dy, -dy, dx, 0, 0)
    const ramp = l.createLinearGradient(centre - width / 2, 0, centre + width / 2, 0)
    const edge = Math.min(0.499, soft * 0.5)
    ramp.addColorStop(0, 'rgba(0,0,0,0)')
    ramp.addColorStop(edge, opaque)
    ramp.addColorStop(1 - edge, opaque)
    ramp.addColorStop(1, 'rgba(0,0,0,0)')
    l.globalAlpha = strength
    l.globalCompositeOperation = 'lighter'
    l.fillStyle = ramp
    l.fillRect(centre - width / 2, -1e5, width, 2e5)
    l.setTransform(1, 0, 0, 1, 0, 0)
  }
  let lit = light
  if (bloom >= 0.5) {
    const [glowing, b] = canvasLike(source)
    b.filter = blurOf(bloom)
    b.drawImage(light, 0, 0)
    b.filter = 'none'
    b.globalCompositeOperation = 'lighter'
    b.drawImage(light, 0, 0)
    lit = glowing
  }
  // More than full strength burns brighter.
  const extra = Math.max(0, intensity - 1)
  const [mask, m] = canvasLike(source)
  stamp(m, lit, 1 + extra, 'source-over')
  m.globalCompositeOperation = 'destination-in'
  if (e.inside !== false) m.drawImage(source, 0, 0)
  else {
    m.beginPath()
    env.box.forEach(([x, y], i) => (i === 0 ? m.moveTo(x, y) : m.lineTo(x, y)))
    m.closePath()
    m.fill()
  }
  const [canvas, g] = canvasLike(source)
  g.drawImage(source, 0, 0)
  const blend = text(e, 'blend')
  g.globalCompositeOperation = (blend || 'screen') as GlobalCompositeOperation
  g.drawImage(mask, 0, 0)
  return canvas
}

const CARDS: Readonly<Record<string, (source: OffscreenCanvas, e: Effect, env: EffectEnv) => OffscreenCanvas>> = {
  shadow,
  innerShadow,
  glow,
  blur,
  stroke: outline,
  longShadow,
  rgbSplit,
  adjust,
  vignette,
  sharpen,
  directionalBlur,
  zoomBlur,
  spinBlur,
  shine,
  grain,
  noise,
  scanlines,
  filmDamage,
  bulge,
  wave,
  twirl,
  lensDistort,
  goo,
  roughenEdges,
  boil,
  glitch,
  colorGrade,
  gradientMap,
  posterize,
  overlay,
  chromaKey,
  halftone,
  pixelate,
  bevel,
  lightRays,
  lensFlare,
  lightning,
  glass,
}

/** Runs a layer's enabled cards over its drawn pixels, first card first. */
export function applyEffects(source: OffscreenCanvas, effects: readonly Effect[], env: EffectEnv): OffscreenCanvas {
  let canvas = source
  for (const effect of effects) {
    if (!effect.enabled) continue
    const card = CARDS[effect.type]
    if (card) canvas = card(canvas, effect, env)
  }
  return canvas
}

/** How far past the layer's drawn pixels its cards can reach, in layer px, for a layer box of `size`. */
export function effectsReach(effects: readonly Effect[], size: { width: number; height: number }): number {
  const halfDiagonal = Math.hypot(size.width, size.height) / 2
  let reach = 0
  for (const e of effects) {
    if (!e.enabled) continue
    const n = (key: string) => Math.abs(effectNumber(e, key))
    switch (e.type) {
      case 'shadow':
        reach += Math.max(n('x'), n('y')) + n('blur') * 3
        break
      case 'glow':
        if (e.inner !== true) reach += n('size') * 3
        break
      case 'blur':
        reach += n('radius') * 3
        break
      case 'stroke':
        if (e.placement !== 'inside') reach += n('width') + 2
        break
      case 'longShadow':
        reach += n('length')
        break
      case 'rgbSplit':
      case 'directionalBlur':
        reach += n('distance')
        break
      case 'shine':
        if (e.inside === false) reach += n('bloom') * 3
        break
      case 'zoomBlur':
        reach += (halfDiagonal + reach) * (1 / (1 - Math.min(0.95, n('strength'))) - 1)
        break
      case 'noise':
        reach += n('displace')
        break
      case 'wave':
        reach += n('amplitude')
        break
      case 'roughenEdges':
        reach += n('amount')
        break
      case 'boil':
        reach += n('amount') + n('shake') + halfDiagonal * Math.sin((n('rotate') * Math.PI) / 180)
        break
      case 'goo':
        reach += n('blur')
        break
      case 'glitch':
        reach += n('displace') + n('chroma')
        break
      case 'lightRays':
        reach += halfDiagonal * n('length') * 1.5
        break
      case 'lensFlare':
        if (e.inside !== true) reach += n('size') * 2
        break
      case 'lightning':
        if (e.inside !== true) reach += n('glow') * 3 + halfDiagonal * 0.6
        break
      case 'bevel':
        if (e.style === 'outer' || e.style === 'emboss') reach += n('depth')
        break
      case 'halftone':
        if (e.inside === false) reach += n('spread') + n('jitter')
        break
      case 'filmDamage':
        reach += Math.max(n('weaveX'), n('weaveY')) + halfDiagonal * Math.sin((n('weaveRotate') * Math.PI) / 180)
        break
      case 'spinBlur':
        reach += (halfDiagonal + reach) * Math.sin(Math.min(Math.PI, (n('angle') * Math.PI) / 360))
        break
    }
  }
  return reach
}

/**
 * Draws one text effect for a glyph run: `fill(dx, dy)` fills the run's text
 * moved by (dx, dy) layer px with the context's current style. Shadows and
 * glows blur in layer px; extrusions and echoes repeat the run along a direction.
 */
export function drawTextEffect(g: Ctx2D, e: Effect, color: string, fill: (dx: number, dy: number) => void): void {
  const opacity = effectNumber(e, 'opacity')
  if (opacity <= 0) return
  g.save()
  const alpha = g.globalAlpha * opacity
  g.globalAlpha = alpha
  g.fillStyle = color
  // A unit's own blur (from its animation) stays; the effect's adds to it.
  const own = g.filter && g.filter !== 'none' ? g.filter : ''
  const blurBy = (px: number) => {
    const b = px * pixelScale(g)
    g.filter = b >= 0.2 ? `${own} blur(${b.toFixed(2)}px)`.trim() : own || 'none'
  }
  const along = (degrees: number): Point => [Math.cos((degrees * Math.PI) / 180), Math.sin((degrees * Math.PI) / 180)]
  switch (e.type) {
    case 'shadow':
      blurBy(effectNumber(e, 'blur'))
      fill(effectNumber(e, 'x'), effectNumber(e, 'y'))
      break
    case 'glow': {
      blurBy(effectNumber(e, 'radius'))
      const intensity = effectNumber(e, 'intensity')
      for (let i = 0; i < Math.ceil(intensity - 1e-6); i++) {
        g.globalAlpha = alpha * Math.min(1, intensity - i)
        fill(0, 0)
      }
      break
    }
    case 'extrude': {
      const length = effectNumber(e, 'length')
      const [dx, dy] = along(effectNumber(e, 'angle'))
      // One copy per output pixel of depth, so the side reads solid.
      const steps = Math.min(400, Math.ceil(length * Math.max(1, pixelScale(g))))
      for (let k = steps; k >= 1; k--) fill((dx * length * k) / steps, (dy * length * k) / steps)
      break
    }
    case 'echo': {
      const count = Math.max(1, Math.round(effectNumber(e, 'count')))
      const distance = effectNumber(e, 'distance')
      const fade = effectNumber(e, 'fade')
      const [dx, dy] = along(effectNumber(e, 'angle'))
      for (let i = count; i >= 1; i--) {
        g.globalAlpha = alpha * Math.max(0, 1 - (fade * i) / count)
        fill(dx * distance * i, dy * distance * i)
      }
      break
    }
  }
  g.restore()
}

/** How far text effects reach past the glyphs, px. */
export function textEffectsReach(effects: readonly Effect[]): number {
  let reach = 0
  for (const e of effects) {
    const n = (key: string) => Math.abs(effectNumber(e, key))
    if (e.type === 'shadow') reach = Math.max(reach, Math.max(n('x'), n('y')) + n('blur') * 3)
    else if (e.type === 'glow') reach = Math.max(reach, n('radius') * 3)
    else if (e.type === 'extrude') reach = Math.max(reach, n('length'))
    else if (e.type === 'echo') reach = Math.max(reach, n('distance') * n('count'))
  }
  return reach
}

/** The weighted mean of two pictures of one size, in premultiplied colour (so transparency averages too). */
function meanOf(a: OffscreenCanvas, wa: number, b: OffscreenCanvas, wb: number): OffscreenCanvas {
  const [canvas, g] = canvasLike(a)
  g.globalAlpha = wa / (wa + wb)
  g.drawImage(a, 0, 0)
  g.globalCompositeOperation = 'lighter'
  g.globalAlpha = wb / (wa + wb)
  g.drawImage(b, 0, 0)
  return canvas
}

/**
 * Mixes pictures of one size with weights (summing to 1): average in pairs
 * (each step a weighted mean of two, so rounding stays small); add sums them
 * as light, at most four times as bright where they overlap; screen and max
 * lay each over the others at its weight relative to the strongest.
 */
export function blendPictures(pictures: readonly OffscreenCanvas[], weights: readonly number[], mode: 'average' | 'add' | 'screen' | 'max'): OffscreenCanvas {
  const first = pictures[0]
  if (!first) throw new Error('blendPictures needs a picture')
  if (pictures.length === 1) return first
  if (mode === 'screen' || mode === 'max') {
    const top = Math.max(...weights)
    const [canvas, g] = canvasLike(first)
    pictures.forEach((picture, i) => {
      g.globalAlpha = (weights[i] ?? 0) / top
      g.globalCompositeOperation = i === 0 ? 'source-over' : mode === 'screen' ? 'screen' : 'lighten'
      g.drawImage(picture, 0, 0)
    })
    return canvas
  }
  let level = pictures.map((picture, i) => ({ picture, weight: weights[i] ?? 0 }))
  while (level.length > 1) {
    const next: typeof level = []
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i] as (typeof level)[number]
      const b = level[i + 1]
      next.push(b && a.weight + b.weight > 0 ? { picture: meanOf(a.picture, a.weight, b.picture, b.weight), weight: a.weight + b.weight } : a)
    }
    level = next
  }
  const mean = (level[0] as (typeof level)[number]).picture
  if (mode === 'average') return mean
  const [canvas, g] = canvasLike(first)
  stamp(g, mean, Math.min(4, 1 / Math.max(...weights)), 'source-over')
  return canvas
}

/** The weighted mean of two pictures (a sharp frame and its blur, for a strength below 1). */
export function mixPictures(a: OffscreenCanvas, b: OffscreenCanvas, amountOfB: number): OffscreenCanvas {
  return amountOfB >= 1 ? b : amountOfB <= 0 ? a : meanOf(a, 1 - amountOfB, b, amountOfB)
}
