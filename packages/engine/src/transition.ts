import type { TransitionWipe } from '@uve/core'
import { hash } from './analog'
import { blurOf } from './pixels'

// Drawing what joins the two sides of a transition: the wipe that reveals the
// incoming side, and the sideways tear of a glitch cut. Both work in the box
// around the pair (the frame, for full-frame clips), in canvas pixels.

export interface Frame {
  x: number
  y: number
  width: number
  height: number
}

/** The direction the wipe's edge travels in: angle 180 brings B in from the left. */
function travel(angleDeg: number): [number, number] {
  const r = (angleDeg * Math.PI) / 180
  return [-Math.cos(r), -Math.sin(r)]
}

/** The least and greatest projection of the frame's corners on a direction. */
function span(frame: Frame, [tx, ty]: [number, number]): [number, number] {
  const p = [
    [frame.x, frame.y],
    [frame.x + frame.width, frame.y],
    [frame.x, frame.y + frame.height],
    [frame.x + frame.width, frame.y + frame.height],
  ].map(([x, y]) => (x as number) * tx + (y as number) * ty)
  return [Math.min(...p), Math.max(...p)]
}

/** A mask the size of the canvas: opaque where the incoming side shows. */
export function wipeMask(width: number, height: number, frame: Frame, wipe: TransitionWipe): OffscreenCanvas {
  const mask = new OffscreenCanvas(Math.max(1, width), Math.max(1, height))
  const g = mask.getContext('2d')
  if (!g) return mask
  const soft = Math.max(0.5, (wipe.softness / 100) * 0.3 * Math.min(frame.width, frame.height))
  const p = Math.min(1, Math.max(0, wipe.progress))
  if (wipe.kind === 'linear' || wipe.kind === 'barn') {
    const [tx, ty] = travel(wipe.angleDeg)
    const [lo, hi] = span(frame, [tx, ty])
    const at = (s: number): [number, number] => [tx * s, ty * s]
    // Along the travel, from before the frame to past it: stops at fractions of [lo − soft, hi + soft].
    const from = lo - soft
    const to = hi + soft
    const frac = (s: number) => Math.min(1, Math.max(0, (s - from) / (to - from)))
    const ramp = g.createLinearGradient(...at(from), ...at(to))
    if (wipe.kind === 'linear') {
      const edge = lo - soft / 2 + p * (hi - lo + soft)
      ramp.addColorStop(0, '#fff')
      ramp.addColorStop(frac(edge - soft / 2), '#fff')
      ramp.addColorStop(frac(edge + soft / 2), 'rgba(255,255,255,0)')
      ramp.addColorStop(1, 'rgba(255,255,255,0)')
    } else {
      // Barn doors: a band opening from the middle line.
      const mid = (lo + hi) / 2
      const half = p * ((hi - lo) / 2 + soft)
      ramp.addColorStop(0, 'rgba(255,255,255,0)')
      ramp.addColorStop(frac(mid - half), 'rgba(255,255,255,0)')
      ramp.addColorStop(frac(Math.min(mid, mid - half + soft)), '#fff')
      ramp.addColorStop(frac(Math.max(mid, mid + half - soft)), '#fff')
      ramp.addColorStop(frac(mid + half), 'rgba(255,255,255,0)')
      ramp.addColorStop(1, 'rgba(255,255,255,0)')
    }
    g.fillStyle = ramp
    g.fillRect(0, 0, width, height)
    return mask
  }
  const cx = frame.x + wipe.cx * frame.width
  const cy = frame.y + wipe.cy * frame.height
  const far = Math.max(
    ...[
      [frame.x, frame.y],
      [frame.x + frame.width, frame.y],
      [frame.x, frame.y + frame.height],
      [frame.x + frame.width, frame.y + frame.height],
    ].map(([x, y]) => Math.hypot((x as number) - cx, (y as number) - cy)),
  )
  if (wipe.kind === 'circle') {
    const r = p * (far + soft)
    const disc = g.createRadialGradient(cx, cy, Math.max(0, r - soft), cx, cy, Math.max(0.001, r))
    disc.addColorStop(0, '#fff')
    disc.addColorStop(1, 'rgba(255,255,255,0)')
    if (wipe.invert) {
      g.fillStyle = '#fff'
      g.fillRect(0, 0, width, height)
      g.globalCompositeOperation = 'destination-out'
    }
    g.fillStyle = disc
    g.fillRect(0, 0, width, height)
    return mask
  }
  // Clock: one blade (or two, opposite) sweeping round from the start angle.
  const start = (wipe.startDeg * Math.PI) / 180
  const sweep = (p * Math.PI * 2) / wipe.blades
  g.filter = blurOf(soft / 2)
  g.fillStyle = '#fff'
  for (let k = 0; k < wipe.blades; k++) {
    const from = start + k * Math.PI
    g.beginPath()
    g.moveTo(cx, cy)
    g.arc(cx, cy, far * 2, from, from + sweep)
    g.closePath()
    g.fill()
  }
  return mask
}

/** Tears a picture sideways in bands across the frame: each band (with odds) shifts by up to `amount` of the frame's width. */
export function tear(picture: OffscreenCanvas, frame: Frame, amount: number, seed: number): OffscreenCanvas {
  if (amount <= 0.001) return picture
  const out = new OffscreenCanvas(picture.width, picture.height)
  const g = out.getContext('2d')
  if (!g) return picture
  g.drawImage(picture, 0, 0)
  const bands = 14
  const height = frame.height / bands
  for (let i = 0; i < bands; i++) {
    if (hash(seed, i, 1) > 0.55) continue
    const top = Math.floor(frame.y + i * height + (hash(seed, i, 2) - 0.5) * height * 0.5)
    const size = Math.max(1, Math.ceil(height * (0.4 + hash(seed, i, 3))))
    const shift = (hash(seed, i, 4) * 2 - 1) * amount * frame.width
    g.save()
    g.beginPath()
    g.rect(0, top, out.width, size)
    g.clip()
    g.clearRect(0, top, out.width, size)
    g.drawImage(picture, shift, 0)
    g.restore()
  }
  return out
}
