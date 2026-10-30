import type { Layout, LayoutItem } from './schema'

// Auto layout as pure geometry: given a container spec and its members'
// sizes, where each member goes. No measuring happens here; callers pass the
// sizes they measured (the engine, from what it draws).

/** A member to place: its size, and how it may stretch. */
export interface LayoutEntry {
  id: string
  width: number
  height: number
  item: LayoutItem
}

/** Where a member goes: its box's top-left corner (comp space) and size. */
export interface LayoutSlot {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export interface LayoutResult {
  /** The container's box, padding included; x and y are its top-left corner. */
  x: number
  y: number
  width: number
  height: number
  slots: LayoutSlot[]
}

const clamp = (value: number, min: number | null, max: number | null) => Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? 0, value))

/** Offset of something `size` long inside `room`, for an alignment. */
const align = (how: Layout['alignX'], room: number, size: number) => (how === 'center' ? (room - size) / 2 : how === 'end' ? room - size : 0)

interface Line {
  entries: LayoutEntry[]
  /** Length along the flow (main axis), gaps included. */
  main: number
  /** Thickness across the flow. */
  cross: number
}

/**
 * Places members in a container. `row` and `column` lay them on one line;
 * `wrap` starts a new row when the next member would pass the inner width
 * (fixed or maximum); `grid` fills `columns` columns row by row, each column
 * as wide as its widest member (or an even share of a fixed width). A
 * container without a fixed size hugs its members, within its min and max.
 */
export function solveLayout(spec: Layout, entries: readonly LayoutEntry[]): LayoutResult {
  const pad = spec.padding
  const horizontal = spec.flow !== 'column'
  const fixedInnerWidth = spec.width === null ? null : Math.max(0, spec.width - pad.left - pad.right)
  const fixedInnerHeight = spec.height === null ? null : Math.max(0, spec.height - pad.top - pad.bottom)
  const maxInnerWidth = fixedInnerWidth ?? (spec.maxWidth === null ? null : Math.max(0, spec.maxWidth - pad.left - pad.right))

  // Items' own sizes, within their min and max.
  const sized = entries.map((e) => ({
    ...e,
    width: clamp(e.width, e.item.minWidth, e.item.maxWidth),
    height: clamp(e.height, e.item.minHeight, e.item.maxHeight),
  }))
  const along = (e: LayoutEntry) => (horizontal ? e.width : e.height)
  const across = (e: LayoutEntry) => (horizontal ? e.height : e.width)

  if (spec.flow === 'grid') return solveGrid(spec, sized, fixedInnerWidth, fixedInnerHeight)

  // Break into lines (only wrap makes more than one).
  const lines: Line[] = []
  let line: Line = { entries: [], main: 0, cross: 0 }
  for (const entry of sized) {
    const next = line.entries.length === 0 ? along(entry) : line.main + spec.gap + along(entry)
    if (spec.flow === 'wrap' && maxInnerWidth !== null && line.entries.length > 0 && next > maxInnerWidth) {
      lines.push(line)
      line = { entries: [], main: 0, cross: 0 }
    }
    line.main = line.entries.length === 0 ? along(entry) : line.main + spec.gap + along(entry)
    line.cross = Math.max(line.cross, across(entry))
    line.entries.push(entry)
  }
  if (line.entries.length > 0) lines.push(line)

  const contentMain = Math.max(0, ...lines.map((l) => l.main))
  const contentCross = lines.reduce((sum, l) => sum + l.cross, 0) + spec.lineGap * Math.max(0, lines.length - 1)
  const innerWidth = fixedInnerWidth ?? clampInner(horizontal ? contentMain : contentCross, spec.minWidth, spec.maxWidth, pad.left + pad.right)
  const innerHeight = fixedInnerHeight ?? clampInner(horizontal ? contentCross : contentMain, spec.minHeight, spec.maxHeight, pad.top + pad.bottom)
  const room = horizontal ? innerWidth : innerHeight
  const thickness = horizontal ? innerHeight : innerWidth
  const fills = (e: LayoutEntry) => (horizontal ? e.item.fillX : e.item.fillY)
  const stretches = (e: LayoutEntry) => (horizontal ? e.item.fillY : e.item.fillX)
  const mainAlign = horizontal ? spec.alignX : spec.alignY
  const crossAlign = horizontal ? spec.alignY : spec.alignX

  const slots: LayoutSlot[] = []
  let crossAt = align(crossAlign, thickness, contentCross)
  for (const l of lines) {
    // Members that fill share the free length of the line.
    const free = Math.max(0, room - l.main)
    const fillers = l.entries.filter(fills)
    const share = fillers.length > 0 ? free / fillers.length : 0
    const lineMain = fillers.length > 0 ? room : l.main
    const gaps = Math.max(1, l.entries.length - 1)
    const between = spec.spaceBetween && fillers.length === 0 && l.entries.length > 1 ? spec.gap + free / gaps : spec.gap
    let mainAt = spec.spaceBetween && fillers.length === 0 && l.entries.length > 1 ? 0 : align(mainAlign, room, lineMain)
    // A single line uses the whole thickness, so cross alignment works per member.
    const lineCross = lines.length === 1 ? thickness : l.cross
    for (const e of l.entries) {
      const mainSize = along(e) + (fills(e) ? share : 0)
      const crossSize = stretches(e) ? lineCross : across(e)
      const crossOffset = crossAt + align(crossAlign, lineCross, crossSize)
      slots.push(
        horizontal
          ? { id: e.id, x: mainAt, y: crossOffset, width: mainSize, height: crossSize }
          : { id: e.id, x: crossOffset, y: mainAt, width: crossSize, height: mainSize },
      )
      mainAt += mainSize + between
    }
    crossAt += l.cross + spec.lineGap
  }
  return finish(spec, innerWidth, innerHeight, slots)
}

function clampInner(content: number, min: number | null, max: number | null, padding: number): number {
  return Math.max(0, clamp(content + padding, min, max) - padding)
}

function solveGrid(spec: Layout, entries: LayoutEntry[], fixedInnerWidth: number | null, fixedInnerHeight: number | null): LayoutResult {
  const pad = spec.padding
  const columns = Math.max(1, spec.columns)
  const rows = Math.ceil(entries.length / columns)
  const colWidths = Array.from({ length: columns }, (_, c) => Math.max(0, ...entries.filter((_, i) => i % columns === c).map((e) => e.width)))
  const rowHeights = Array.from({ length: rows }, (_, r) => Math.max(0, ...entries.slice(r * columns, r * columns + columns).map((e) => e.height)))
  if (fixedInnerWidth !== null) colWidths.fill(Math.max(0, (fixedInnerWidth - spec.gap * (columns - 1)) / columns))
  const contentWidth = colWidths.reduce((a, b) => a + b, 0) + spec.gap * (columns - 1)
  const contentHeight = rowHeights.reduce((a, b) => a + b, 0) + spec.lineGap * Math.max(0, rows - 1)
  const innerWidth = fixedInnerWidth ?? clampInner(contentWidth, spec.minWidth, spec.maxWidth, pad.left + pad.right)
  const innerHeight = fixedInnerHeight ?? clampInner(contentHeight, spec.minHeight, spec.maxHeight, pad.top + pad.bottom)
  const slots: LayoutSlot[] = []
  const startX = align(spec.alignX, innerWidth, contentWidth)
  let y = align(spec.alignY, innerHeight, contentHeight)
  for (let r = 0; r < rows; r++) {
    let x = startX
    const rowHeight = rowHeights[r] ?? 0
    for (let c = 0; c < columns; c++) {
      const e = entries[r * columns + c]
      const cellWidth = colWidths[c] ?? 0
      if (e) {
        const width = e.item.fillX ? cellWidth : e.width
        const height = e.item.fillY ? rowHeight : e.height
        slots.push({ id: e.id, x: x + align(spec.alignX, cellWidth, width), y: y + align(spec.alignY, rowHeight, height), width, height })
      }
      x += cellWidth + spec.gap
    }
    y += rowHeight + spec.lineGap
  }
  return finish(spec, innerWidth, innerHeight, slots)
}

/** Moves slots from inner-box space to comp space and adds the padding to the box. */
function finish(spec: Layout, innerWidth: number, innerHeight: number, slots: LayoutSlot[]): LayoutResult {
  const pad = spec.padding
  return {
    x: spec.x,
    y: spec.y,
    width: innerWidth + pad.left + pad.right,
    height: innerHeight + pad.top + pad.bottom,
    slots: slots.map((s) => ({ ...s, x: spec.x + pad.left + s.x, y: spec.y + pad.top + s.y })),
  }
}
