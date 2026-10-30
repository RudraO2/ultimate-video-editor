import { describe, expect, it } from 'vitest'
import { CutoutError, findBackground, type RgbaImage, removeFlatBackground } from './cutout'

type Rgb = [number, number, number]

const MAGENTA: Rgb = [255, 0, 255]
const GREEN: Rgb = [0, 255, 0]
const WHITE: Rgb = [255, 255, 255]

/**
 * Draws a picture with anti-aliased edges: each pixel averages 4 × 4 samples
 * of `paint` (a subject colour, or null for the ground). Also returns each
 * pixel's true coverage, to judge the keyer's alpha against.
 */
function draw(width: number, height: number, ground: Rgb, paint: (x: number, y: number) => Rgb | null): { image: RgbaImage; coverage: Float32Array } {
  const data = new Uint8ClampedArray(width * height * 4)
  const coverage = new Float32Array(width * height)
  const S = 4
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0
      let g = 0
      let b = 0
      let hits = 0
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const c = paint(x + (sx + 0.5) / S, y + (sy + 0.5) / S) ?? ground
          if (paint(x + (sx + 0.5) / S, y + (sy + 0.5) / S)) hits++
          r += c[0]
          g += c[1]
          b += c[2]
        }
      }
      const i = y * width + x
      data.set([r / (S * S), g / (S * S), b / (S * S), 255], i * 4)
      coverage[i] = hits / (S * S)
    }
  }
  return { image: { width, height, data }, coverage }
}

const alphaAt = (image: RgbaImage, x: number, y: number) => (image.data[(y * image.width + x) * 4 + 3] as number) / 255
const rgbAt = (image: RgbaImage, x: number, y: number): Rgb => {
  const p = (y * image.width + x) * 4
  return [image.data[p] as number, image.data[p + 1] as number, image.data[p + 2] as number]
}

/** A red disc with a black outline, centred at (32, 32). */
const outlinedDisc = (x: number, y: number): Rgb | null => {
  const r = Math.hypot(x - 32, y - 32)
  return r < 16 ? [230, 30, 30] : r < 20 ? [0, 0, 0] : null
}

describe('findBackground', () => {
  it('finds the ground from the borders', () => {
    const { image } = draw(64, 64, MAGENTA, outlinedDisc)
    const found = findBackground(image)
    expect(found.color).toEqual(MAGENTA)
    expect(found.flat).toBe(1)
  })
})

describe('removeFlatBackground', () => {
  it('clears the ground and keeps the subject', () => {
    const { image } = draw(64, 64, MAGENTA, outlinedDisc)
    const out = removeFlatBackground(image)
    expect(alphaAt(out, 2, 2)).toBe(0)
    expect(alphaAt(out, 32, 32)).toBe(1)
    expect(rgbAt(out, 32, 32)).toEqual([230, 30, 30])
    expect(out.cleared).toBeGreaterThan(0.6)
  })

  it('gives edges soft alpha that follows their coverage, with no ground colour left in them', () => {
    const { image, coverage } = draw(64, 64, MAGENTA, outlinedDisc)
    const out = removeFlatBackground(image)
    let edges = 0
    for (let i = 0; i < 64 * 64; i++) {
      const c = coverage[i] as number
      if (c <= 0 || c >= 1) continue
      edges++
      const x = i % 64
      const y = (i - x) / 64
      expect(Math.abs(alphaAt(out, x, y) - c)).toBeLessThan(0.08)
      // The outline is black: an unmixed edge has no magenta in it.
      if (c > 0.15) expect(Math.max(...rgbAt(out, x, y))).toBeLessThan(40)
    }
    expect(edges).toBeGreaterThan(50)
  })

  it('unmixes a coloured edge on green with no green fringe', () => {
    const disc = (x: number, y: number): Rgb | null => (Math.hypot(x - 32, y - 32) < 18 ? [240, 200, 40] : null)
    const { image, coverage } = draw(64, 64, GREEN, disc)
    const out = removeFlatBackground(image)
    for (let i = 0; i < 64 * 64; i++) {
      const c = coverage[i] as number
      if (c < 0.2 || c >= 1) continue
      const x = i % 64
      const y = (i - x) / 64
      const [r, g, b] = rgbAt(out, x, y)
      expect(Math.abs(r - 240) + Math.abs(g - 200) + Math.abs(b - 40)).toBeLessThan(30)
      expect(Math.abs(alphaAt(out, x, y) - c)).toBeLessThan(0.08)
    }
  })

  it('unmixes a soft edge about 2 px wide (a blurred render) with no green left', () => {
    const disc = (x: number, y: number): Rgb | null => (Math.hypot(x - 32, y - 32) < 18 ? [40, 80, 220] : null)
    const { image } = draw(64, 64, GREEN, disc)
    // A 3 × 3 box blur widens the edge to about 2 px each side.
    const src = new Uint8ClampedArray(image.data)
    for (let y = 1; y < 63; y++) {
      for (let x = 1; x < 63; x++) {
        for (let c = 0; c < 3; c++) {
          let sum = 0
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += src[((y + dy) * 64 + x + dx) * 4 + c] as number
          image.data[(y * 64 + x) * 4 + c] = sum / 9
        }
      }
    }
    const out = removeFlatBackground(image)
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        if (alphaAt(out, x, y) < 0.1) continue
        const [r, g, b] = rgbAt(out, x, y)
        // The subject has less green than red or blue; ground left in an edge would add green.
        expect(g - Math.max(r, b)).toBeLessThan(0)
      }
    }
  })

  it('treats a rim of darkened key colour as ground mixed with black', () => {
    // A blue disc whose outermost ring is the green ground shaded 20 % darker.
    const disc = (x: number, y: number): Rgb | null => {
      const r = Math.hypot(x - 32, y - 32)
      return r < 16 ? [40, 80, 220] : r < 17.5 ? [0, 204, 0] : null
    }
    const out = removeFlatBackground(draw(64, 64, GREEN, disc).image)
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const a = alphaAt(out, x, y)
        if (a < 0.05) continue
        const [r, g, b] = rgbAt(out, x, y)
        // Shown on any ground, no pixel adds visible green: a dark rim is fine, a green one is not.
        expect(a * (g - Math.max(r, b))).toBeLessThan(20)
      }
    }
  })

  it('clears a key-coloured hole inside a ring, but keeps white inside a subject on white', () => {
    const ring = (x: number, y: number): Rgb | null => {
      const r = Math.hypot(x - 32, y - 32)
      return r > 10 && r < 22 ? [40, 60, 200] : null
    }
    const keyed = removeFlatBackground(draw(64, 64, MAGENTA, ring).image)
    expect(keyed.holes).toBe(true)
    expect(alphaAt(keyed, 32, 32)).toBe(0)

    // A dark face on white with a white eye: the eye stays.
    const face = (x: number, y: number): Rgb | null => {
      if (Math.hypot(x - 28, y - 28) < 4) return WHITE
      return Math.hypot(x - 32, y - 32) < 20 ? [60, 40, 30] : null
    }
    const onWhite = removeFlatBackground(draw(64, 64, WHITE, face).image)
    expect(onWhite.holes).toBe(false)
    expect(alphaAt(onWhite, 28, 28)).toBe(1)
    expect(alphaAt(onWhite, 1, 1)).toBe(0)
    // holes: true clears it.
    expect(alphaAt(removeFlatBackground(draw(64, 64, WHITE, face).image, { holes: true }), 28, 28)).toBe(0)
  })

  it('keeps hairlines and parts near the edge', () => {
    // A 1 px diagonal line and a block 2 px from the right edge.
    const paint = (x: number, y: number): Rgb | null => {
      if (Math.abs(x - y) < 0.5 && x > 8 && x < 40) return [0, 0, 0]
      if (x > 50 && x < 62 && y > 20 && y < 40) return [20, 120, 220]
      return null
    }
    const out = removeFlatBackground(draw(64, 64, MAGENTA, paint).image)
    expect(alphaAt(out, 20, 20)).toBeGreaterThan(0.5)
    expect(Math.max(...rgbAt(out, 20, 20))).toBeLessThan(40)
    expect(alphaAt(out, 56, 30)).toBe(1)
    expect(alphaAt(out, 63, 30)).toBe(0)
  })

  it('drops specks', () => {
    const paint = (x: number, y: number): Rgb | null => {
      if (x >= 5 && x < 6 && y >= 5 && y < 6) return [0, 0, 0]
      return Math.hypot(x - 32, y - 32) < 15 ? [0, 0, 0] : null
    }
    const out = removeFlatBackground(draw(64, 64, MAGENTA, paint).image)
    expect(alphaAt(out, 5, 5)).toBe(0)
    expect(alphaAt(out, 32, 32)).toBe(1)
  })

  it('refuses a picture whose ground is not one colour, or is already transparent', () => {
    const noisy = draw(64, 64, MAGENTA, outlinedDisc).image
    for (let i = 0; i < 64 * 64; i++) noisy.data.set([(i * 37) % 256, (i * 91) % 256, (i * 53) % 256], i * 4)
    expect(() => removeFlatBackground(noisy)).toThrow(CutoutError)

    const clear = draw(32, 32, MAGENTA, () => null).image
    for (let i = 0; i < 32 * 32; i++) clear.data[i * 4 + 3] = 0
    expect(() => removeFlatBackground(clear)).toThrow(/already/)
  })

  it('takes a given ground colour and tolerance', () => {
    const { image } = draw(64, 64, [250, 250, 250], outlinedDisc)
    const out = removeFlatBackground(image, { background: [250, 250, 250], tolerance: 10 })
    expect(out.background).toEqual([250, 250, 250])
    expect(alphaAt(out, 2, 2)).toBe(0)
  })
})
