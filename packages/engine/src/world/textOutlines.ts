import { flattenSvgPath, parseSvgPath, type TextStyle } from '@uve/core'
import { parse, type Font } from 'opentype.js'
import { layoutText } from '../content'
import type { WorldPlane } from './frame'

const fonts = new Map<string, Font>()
let revision = 0
export const outlineFontsRevision = () => revision
const key = (family: string, weight: number, italic: boolean) => `${family.toLowerCase()}:${weight}:${italic}`

/** Register a font's TrueType, OpenType or WOFF bytes, loaded by the host. */
export function registerOutlineFont(family: string, weight: number, italic: boolean, bytes: ArrayBuffer): boolean {
  try { fonts.set(key(family, weight, italic), parse(bytes)); revision++; return true } catch { return false }
}

/** Glyph contours at the same lines, fragment positions and baselines as the flat text renderer. */
export function textOutlineRings(plane: WorldPlane): [number, number][][] | null {
  const node = plane.node
  if (node.kind !== 'leaf' || node.layer.kind !== 'text') return null
  const layer = node.layer, style = node.resolved.style ?? layer.style
  const canvas = new OffscreenCanvas(1, 1), ctx = canvas.getContext('2d')!
  const layout = layoutText(ctx, layer.text, style, { maxWidth: node.resolved.textBox?.maxWidth ?? layer.maxWidth, maxHeight: node.resolved.textBox?.maxHeight ?? layer.maxHeight, verticalAlign: layer.verticalAlign }, node.resolved.ranges ?? layer.ranges)
  const css = (s: TextStyle) => `${s.italic ? 'italic ' : ''}${s.fontWeight} ${s.fontSize}px "${s.fontFamily.replace(/["\\]/g, '')}", system-ui, sans-serif`
  ctx.font = css(style)
  const metrics = ctx.measureText('Hg')
  const ascent = (metrics.fontBoundingBoxAscent || style.fontSize * 0.8) / style.fontSize
  const descent = (metrics.fontBoundingBoxDescent || style.fontSize * 0.2) / style.fontSize
  const rings: [number, number][][] = []
  for (const line of layout.lines) {
    const baseline = line.top + (line.height - line.size * (ascent + descent)) / 2 + line.size * ascent
    for (const fragment of line.fragments) {
      const s = fragment.style
      const font = fonts.get(key(s.fontFamily, s.fontWeight, s.italic))
      if (!font) return null
      // Missing glyphs must follow the browser's fallback font in the picture.
      if (Array.from(fragment.text).some((character) => !font.hasChar(character))) return null
      try {
        // Some fonts contain GSUB lookup types opentype.js does not implement.
        // Retry without optional Latin substitutions; if shaping still fails,
        // let the caller trace the rendered picture rather than abort a frame.
        let path: string
        try {
          path = font.getPath(fragment.text, fragment.x, baseline, s.fontSize, { kerning: true, letterSpacing: s.letterSpacing / s.fontSize }).toPathData(3)
        } catch {
          // Even an empty feature set can hit an unsupported contextual GSUB.
          // Use cmap glyphs directly and retain advances and pair kerning.
          let x = fragment.x
          const glyphs = Array.from(fragment.text, (character) => font.charToGlyph(character))
          path = glyphs.map((glyph, i) => {
            const part = glyph.getPath(x, baseline, s.fontSize).toPathData(3)
            const next = glyphs[i + 1]
            let kern = 0
            try { if (next) kern = font.getKerningValue(glyph, next) } catch { /* no pair adjustment */ }
            x += ((glyph.advanceWidth ?? 0) + kern) * s.fontSize / font.unitsPerEm + s.letterSpacing
            return part
          }).join('')
        }
        if (!path) continue
        // A glyph's contours are always closed, but opentype's path data may end on the start point without a Z.
        for (const ring of flattenSvgPath(parseSvgPath(path), 16)) {
          const points = ring.points, first = points[0]!, last = points[points.length - 1]!
          if (points.length > 1 && Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-6) points.pop()
          if (points.length >= 3) rings.push(points)
        }
      } catch { return null }
    }
  }
  return rings
}
