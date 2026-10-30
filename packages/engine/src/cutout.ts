// Removing a flat background: the picture's ground is one colour (a studio
// white, a key green or magenta), found from its borders and made transparent.
// Edges stay soft: a pixel on an edge is part ground and part subject, so its
// alpha is how far it sits from the ground towards the nearby subject, and its
// colour is unmixed from the ground (no green or grey fringe). Pure code on
// RGBA bytes, so it runs and tests anywhere.

export interface RgbaImage {
  width: number
  height: number
  /** RGBA, 4 bytes per pixel, rows top to bottom. */
  data: Uint8ClampedArray
}

export interface CutoutOptions {
  /** The ground colour; found from the borders when left out. */
  background?: readonly [number, number, number]
  /** How far (RGB distance, 0–441) a pixel may sit from the ground and still be ground; found from the borders' noise when left out. */
  tolerance?: number
  /**
   * Also clear ground-coloured areas the borders do not reach (inside a ring,
   * between fingers). Default: on for a saturated ground (a key colour no
   * subject uses), off for white, grey or black (eyes and highlights share it).
   */
  holes?: boolean
  /** Opaque islands smaller than this many pixels are dropped as specks; default 0.02% of the picture, at least 4. */
  minSpeck?: number
}

export interface Cutout extends RgbaImage {
  background: [number, number, number]
  tolerance: number
  holes: boolean
  /** The share of pixels made fully transparent. */
  cleared: number
}

/** Why a picture cannot be cut by colour. */
export class CutoutError extends Error {}

/** How many pixels deep an edge can be. */
const BAND = 3
/** How far an edge pixel looks for the subject colour it mixes with. */
const REACH = 3
/** The share of the border that must be the ground colour. */
const MIN_FLAT_BORDER = 0.7

const dist = (r: number, g: number, b: number, bg: readonly number[]) => {
  const dr = r - (bg[0] as number)
  const dg = g - (bg[1] as number)
  const db = b - (bg[2] as number)
  return Math.sqrt(dr * dr + dg * dg + db * db)
}

/** Indices of the border pixels (each once). */
function borderPixels(width: number, height: number): number[] {
  const out: number[] = []
  for (let x = 0; x < width; x++) {
    out.push(x)
    if (height > 1) out.push((height - 1) * width + x)
  }
  for (let y = 1; y < height - 1; y++) {
    out.push(y * width)
    if (width > 1) out.push(y * width + width - 1)
  }
  return out
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

/** The ground colour (the borders' median) and how noisy the borders are around it. */
export function findBackground(image: RgbaImage): { color: [number, number, number]; noise: number; flat: number; transparent: number } {
  const { data, width, height } = image
  const border = borderPixels(width, height)
  const opaque = border.filter((i) => (data[i * 4 + 3] as number) >= 250)
  const transparent = 1 - opaque.length / Math.max(1, border.length)
  const color: [number, number, number] = [0, 1, 2].map((c) => median(opaque.map((i) => data[i * 4 + c] as number))) as [number, number, number]
  const distances = opaque.map((i) => dist(data[i * 4] as number, data[i * 4 + 1] as number, data[i * 4 + 2] as number, color)).sort((a, b) => a - b)
  // The noise of the ground: the distance most border pixels stay within.
  const noise = distances[Math.floor(distances.length * 0.6)] ?? 0
  const tolerance = toleranceFor(noise)
  const flat = distances.filter((d) => d <= tolerance).length / Math.max(1, border.length)
  return { color, noise, flat, transparent }
}

const toleranceFor = (noise: number) => Math.min(90, Math.max(18, noise * 2.5 + 10))

/** Whether a colour is saturated enough to be a key ground (green, magenta, blue) rather than a neutral one. */
const saturated = ([r, g, b]: readonly number[]) => Math.max(r!, g!, b!) - Math.min(r!, g!, b!) > 96

/**
 * Makes the flat ground of a picture transparent. Throws CutoutError when the
 * borders are not mostly one colour (a photo with a real background), or are
 * already transparent.
 */
export function removeFlatBackground(image: RgbaImage, options: CutoutOptions = {}): Cutout {
  const { width, height, data } = image
  const n = width * height
  if (n === 0) throw new CutoutError('The picture is empty.')
  const found = findBackground(image)
  if (!options.background && found.transparent > 0.5) throw new CutoutError('The picture already has a transparent background.')
  const bg = options.background ? ([...options.background] as [number, number, number]) : found.color
  const tolerance = options.tolerance ?? toleranceFor(found.noise)
  if (!options.background && found.flat < MIN_FLAT_BORDER) {
    throw new CutoutError('The background is not one flat colour, so it cannot be removed by colour.')
  }
  const holes = options.holes ?? saturated(bg)

  // Distance of every pixel from the ground.
  const d = new Float32Array(n)
  for (let i = 0; i < n; i++) d[i] = dist(data[i * 4] as number, data[i * 4 + 1] as number, data[i * 4 + 2] as number, bg)

  // Ground: every ground-coloured pixel (holes), or those the borders reach.
  const ground = new Uint8Array(n)
  if (holes) {
    for (let i = 0; i < n; i++) if ((d[i] as number) <= tolerance) ground[i] = 1
  } else {
    const stack: number[] = []
    for (const i of borderPixels(width, height)) {
      if ((d[i] as number) <= tolerance && !ground[i]) {
        ground[i] = 1
        stack.push(i)
      }
    }
    while (stack.length > 0) {
      const i = stack.pop() as number
      const x = i % width
      const y = (i - x) / width
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ] as const) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
        const j = ny * width + nx
        if (!ground[j] && (d[j] as number) <= tolerance) {
          ground[j] = 1
          stack.push(j)
        }
      }
    }
  }

  const near = (x: number, y: number, r: number, visit: (j: number) => void) => {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const nx = x + dx
        const ny = y + dy
        if (nx >= 0 && ny >= 0 && nx < width && ny < height) visit(ny * width + nx)
      }
    }
  }
  const touches = (i: number, test: (j: number) => boolean) => {
    const x = i % width
    let hit = false
    near(x, (i - x) / width, 1, (j) => {
      if (!hit && test(j)) hit = true
    })
    return hit
  }

  // Ground pixels beside the subject that are not quite the ground colour
  // (a pale subject on white) are its faint edge: they get an alpha below,
  // not a hard cut, so the outline does not come out notched.
  const faint = tolerance * 0.5
  const softened: number[] = []
  for (let i = 0; i < n; i++) if (ground[i] && (d[i] as number) > faint && touches(i, (j) => !ground[j])) softened.push(i)
  for (const i of softened) ground[i] = 0

  // Edge pixels: 1 for those touching the ground (8-connected), 2 and 3 for
  // those further in (soft renders and enlarged pictures blur edges that wide).
  const edge = new Uint8Array(n)
  for (let i = 0; i < n; i++) if (!ground[i] && touches(i, (j) => ground[j] === 1)) edge[i] = 1
  for (let ring = 2; ring <= BAND; ring++) {
    for (let i = 0; i < n; i++) if (!ground[i] && !edge[i] && touches(i, (j) => edge[j] === ring - 1)) edge[i] = ring
  }

  // On a key colour, black and white are subject colours too: an edge
  // shaded into the key (a dark rim, a highlight) is the key mixed with them.
  // Not on a neutral ground, where every grey lies on that same line.
  const shades = saturated(bg)
    ? ([
        [-bg[0], -bg[1], -bg[2]],
        [255 - bg[0], 255 - bg[1], 255 - bg[2]],
      ] as const)
    : []
  const out = new Uint8ClampedArray(data)
  for (let i = 0; i < n; i++) {
    if (ground[i]) {
      out[i * 4 + 3] = 0
      continue
    }
    if (!edge[i]) continue
    // An edge pixel mixes the ground with a subject colour nearby: of the
    // inner subject pixels within reach, the one that best explains it as such
    // a mix. A part too thin to have an inside (a hairline) mixes with its own
    // strongest pixel instead.
    const p = i * 4
    const ir = (data[p] as number) - bg[0]
    const ig = (data[p + 1] as number) - bg[1]
    const ib = (data[p + 2] as number) - bg[2]
    const x = i % width
    const y = (i - x) / width
    let alpha = -1
    let bestResidual = Infinity
    let bestD = -1
    const mixWith = (fr: number, fg: number, fb: number, strength: number) => {
      const len2 = fr * fr + fg * fg + fb * fb
      if (len2 === 0) return
      // The pixel's share of the subject: its projection onto ground → subject.
      const a = Math.min(1, Math.max(0, (ir * fr + ig * fg + ib * fb) / len2))
      const rr = ir - a * fr
      const rg = ig - a * fg
      const rb = ib - a * fb
      const residual = rr * rr + rg * rg + rb * rb
      if (residual < bestResidual - 1e-6 || (Math.abs(residual - bestResidual) <= 1e-6 && strength > bestD)) {
        bestResidual = residual
        bestD = strength
        alpha = a
      }
    }
    // A mix of the ground with two colours at once (a subject colour and a
    // shade), solved by least squares; only with both shares positive.
    const mixPair = (f: readonly number[], g: readonly number[], strength: number) => {
      const [f0, f1, f2] = f as [number, number, number]
      const [g0, g1, g2] = g as [number, number, number]
      const ff = f0 * f0 + f1 * f1 + f2 * f2
      const gg = g0 * g0 + g1 * g1 + g2 * g2
      const fg = f0 * g0 + f1 * g1 + f2 * g2
      const det = ff * gg - fg * fg
      if (det < 1e-3 * ff * gg) return
      const fi = f0 * ir + f1 * ig + f2 * ib
      const gi = g0 * ir + g1 * ig + g2 * ib
      const a1 = (fi * gg - gi * fg) / det
      const a2 = (gi * ff - fi * fg) / det
      if (a1 <= 0 || a2 <= 0) return
      const rr = ir - a1 * f0 - a2 * g0
      const rg = ig - a1 * f1 - a2 * g1
      const rb = ib - a1 * f2 - a2 * g2
      const residual = rr * rr + rg * rg + rb * rb
      if (residual < bestResidual - 1e-6) {
        bestResidual = residual
        bestD = strength
        alpha = Math.min(1, a1 + a2)
      }
    }
    const offset = (j: number): [number, number, number] => {
      const q = j * 4
      return [(data[q] as number) - bg[0], (data[q + 1] as number) - bg[1], (data[q + 2] as number) - bg[2]]
    }
    near(x, y, REACH, (j) => {
      if (ground[j] || edge[j]) return
      const f = offset(j)
      mixWith(...f, d[j] as number)
      for (const shade of shades) mixPair(f, shade, d[j] as number)
    })
    for (const [fr, fg, fb] of shades) mixWith(fr, fg, fb, 0)
    // Further in, a pixel is only a mix when the mix explains it well; else
    // it is the subject (a dark rim beside a bright fill is not ground).
    if ((edge[i] as number) >= 2 && (alpha < 0 || alpha >= 1 || Math.sqrt(bestResidual) > 0.15 * (d[i] as number))) alpha = 1
    if (alpha < 0) {
      // No inside to look at: the subject colour lies on the line from the
      // ground through the strongest pixel nearby, taken to the most extreme
      // colour on it (where a channel reaches 0 or 255): right for the black
      // and saturated strokes of drawings.
      let strongest = i
      near(x, y, REACH, (j) => {
        if (!ground[j] && (d[j] as number) > (d[strongest] as number)) strongest = j
      })
      const [fr, fg, fb] = offset(strongest)
      let t = Infinity
      for (const [o, c] of [
        [fr, bg[0]],
        [fg, bg[1]],
        [fb, bg[2]],
      ] as const) {
        if (o > 0) t = Math.min(t, (255 - c) / o)
        else if (o < 0) t = Math.min(t, -c / o)
      }
      if (Number.isFinite(t) && t >= 1) mixWith(fr * t, fg * t, fb * t, d[strongest] as number)
    }
    if (alpha < 0) alpha = 1
    if (alpha >= 1) continue
    if (alpha < 1 / 255) {
      out[p + 3] = 0
      continue
    }
    // Unmix the ground: colour = ground + (pixel − ground) / alpha.
    out[p] = bg[0] + ir / alpha
    out[p + 1] = bg[1] + ig / alpha
    out[p + 2] = bg[2] + ib / alpha
    out[p + 3] = Math.round((data[p + 3] as number) * alpha)
  }

  dropSpecks(out, width, height, options.minSpeck ?? Math.max(4, Math.round(n * 0.0002)))

  let cleared = 0
  for (let i = 0; i < n; i++) if (out[i * 4 + 3] === 0) cleared++
  return { width, height, data: out, background: bg, tolerance, holes, cleared: cleared / n }
}

/** Clears islands of visible pixels smaller than `min` pixels (8-connected). */
function dropSpecks(data: Uint8ClampedArray, width: number, height: number, min: number): void {
  const n = width * height
  const seen = new Uint8Array(n)
  const island: number[] = []
  for (let start = 0; start < n; start++) {
    if (seen[start] || data[start * 4 + 3] === 0) continue
    island.length = 0
    seen[start] = 1
    const stack = [start]
    while (stack.length > 0) {
      const i = stack.pop() as number
      island.push(i)
      const x = i % width
      const y = (i - x) / width
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          const j = ny * width + nx
          if (!seen[j] && data[j * 4 + 3] !== 0) {
            seen[j] = 1
            stack.push(j)
          }
        }
      }
    }
    if (island.length < min) for (const i of island) data[i * 4 + 3] = 0
  }
}
