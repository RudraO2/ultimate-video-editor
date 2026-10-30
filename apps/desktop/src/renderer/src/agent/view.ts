import { type Comp, compTimeFor, type Project } from '@uve/core'
import { CompRenderer, FONT_PROBE_TEXT, fontsOf } from '@uve/engine'
import { loadFontsOf } from '../library/fonts'
import { backdrop } from '../export/render'
import { ExportSources } from '../export/sources'

// Pictures for agents: a comp at one instant (view_render) or a contact sheet
// of several (view_frames). They are drawn exactly as an export draws them,
// with media frames decoded by mediabunny, so what an agent sees is what the
// file will hold.

export type Detail = 'glance' | 'look' | 'inspect'

/** The long side of a picture, in pixels, at each detail level. */
export const DETAIL_PX: Record<Detail, number> = { glance: 384, look: 768, inspect: 1280 }
/** Largest canvas side drawn, whatever the zoom a crop asks for. */
const MAX_CANVAS = 4096
/** Pictures over this many bytes as PNG are sent as JPEG instead. */
const MAX_PNG_BYTES = 3_000_000

/** A region of the comp in comp pixels, from the top-left corner. */
export interface Region {
  left: number
  top: number
  width: number
  height: number
}

export interface Picture {
  data: string
  mimeType: 'image/png' | 'image/jpeg'
  width: number
  height: number
}

/** Draws `comp` at each of `times` (comp ms; a static comp always shows its still), cropped to `region`, each with its long side at `longSide` pixels. */
export async function renderStills(
  project: Project,
  comp: Comp,
  times: readonly number[],
  longSide: number,
  region: Region = { left: 0, top: 0, width: comp.width, height: comp.height },
): Promise<OffscreenCanvas[]> {
  const zoom = Math.min(longSide / Math.max(region.width, region.height), MAX_CANVAS / Math.max(comp.width, comp.height))
  const full = new OffscreenCanvas(Math.max(1, Math.round(comp.width * zoom)), Math.max(1, Math.round(comp.height * zoom)))
  // With alpha, as the export draws (an opaque canvas gets LCD text; see backdrop).
  const ctx = full.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D is not available.')

  const sources = new ExportSources(project)
  const renderer = new CompRenderer()
  const stills = new Map<number, OffscreenCanvas>()
  const shown = times.map((t) => compTimeFor(comp, t))
  try {
    await sources.checkFiles(comp)
    await renderer.prepare(comp, project)
    await loadFontsOf(project.comps)
    await Promise.all(fontsOf(comp, project.comps).map((font) => document.fonts.load(font, FONT_PROBE_TEXT)))
    // Media is decoded forward, so the instants are drawn in order.
    for (const timeMs of [...new Set(shown)].sort((a, b) => a - b)) {
      await sources.prepare(comp, timeMs)
      renderer.render(ctx, comp, project, timeMs, zoom, sources)
      backdrop(ctx)
      const out = new OffscreenCanvas(Math.max(1, Math.round(region.width * zoom)), Math.max(1, Math.round(region.height * zoom)))
      out
        .getContext('2d')
        ?.drawImage(full, region.left * zoom, region.top * zoom, region.width * zoom, region.height * zoom, 0, 0, out.width, out.height)
      stills.set(timeMs, out)
    }
  } finally {
    await sources.dispose()
  }
  return shown.map((t) => stills.get(t) as OffscreenCanvas)
}

/** Lays stills out in a grid close to 16:9, each labelled with its time, the whole sheet `longSide` pixels across its long side. */
export function contactSheet(stills: readonly OffscreenCanvas[], times: readonly number[], longSide: number): OffscreenCanvas {
  const first = stills[0]
  if (!first) throw new Error('No frames to lay out.')
  const gap = 6
  const aspect = first.width / first.height
  let columns = 1
  let best = Number.POSITIVE_INFINITY
  for (let c = 1; c <= stills.length; c++) {
    const rows = Math.ceil(stills.length / c)
    const miss = Math.abs(Math.log((c * aspect) / rows / (16 / 9)))
    if (miss < best) {
      best = miss
      columns = c
    }
  }
  const rows = Math.ceil(stills.length / columns)
  const sheetAspect = (columns * aspect) / rows
  const sheetWidth = sheetAspect >= 1 ? longSide : longSide * sheetAspect
  const tileWidth = Math.floor((sheetWidth - gap * (columns + 1)) / columns)
  const tileHeight = Math.round(tileWidth / aspect)
  const sheet = new OffscreenCanvas(columns * tileWidth + gap * (columns + 1), rows * tileHeight + gap * (rows + 1))
  const ctx = sheet.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D is not available.')
  ctx.fillStyle = '#100c11'
  ctx.fillRect(0, 0, sheet.width, sheet.height)
  const fontSize = Math.max(11, Math.round(tileWidth / 18))
  ctx.font = `500 ${fontSize}px "JetBrains Mono", monospace`
  ctx.textBaseline = 'top'
  stills.forEach((still, index) => {
    const x = gap + (index % columns) * (tileWidth + gap)
    const y = gap + Math.floor(index / columns) * (tileHeight + gap)
    ctx.drawImage(still, x, y, tileWidth, tileHeight)
    const label = `${((times[index] ?? 0) / 1000).toFixed(2)} s`
    const pad = Math.round(fontSize / 3)
    const width = ctx.measureText(label).width + pad * 2
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)'
    ctx.fillRect(x + pad, y + pad, width, fontSize + pad * 2)
    ctx.fillStyle = '#ffffff'
    ctx.fillText(label, x + pad * 2, y + pad * 2)
  })
  return sheet
}

/** Encodes a canvas for an MCP image: PNG, or JPEG when the PNG would be large. */
export async function encodePicture(canvas: OffscreenCanvas): Promise<Picture> {
  let blob = await canvas.convertToBlob({ type: 'image/png' })
  if (blob.size > MAX_PNG_BYTES) blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return { data: btoa(binary), mimeType: blob.type as Picture['mimeType'], width: canvas.width, height: canvas.height }
}
