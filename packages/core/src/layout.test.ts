import { describe, expect, it } from 'vitest'
import { type LayoutEntry, solveLayout } from './layout'
import { LayoutItemSchema, LayoutSchema } from './schema'

const spec = (fields: object) => LayoutSchema.parse(fields)
const entry = (id: string, width: number, height: number, item: object = {}): LayoutEntry => ({ id, width, height, item: LayoutItemSchema.parse(item) })

describe('auto layout', () => {
  it('stacks a column that hugs its members, with gap and padding', () => {
    const result = solveLayout(spec({ flow: 'column', gap: 10, padding: { top: 5, right: 20, bottom: 5, left: 20 }, x: 100, y: 50 }), [
      entry('a', 200, 40),
      entry('b', 120, 30),
    ])
    expect(result).toMatchObject({ x: 100, y: 50, width: 240, height: 90 })
    expect(result.slots).toEqual([
      { id: 'a', x: 120, y: 55, width: 200, height: 40 },
      { id: 'b', x: 120, y: 105, width: 120, height: 30 },
    ])
  })

  it('centres a row across its height and lets a member fill the free width', () => {
    const result = solveLayout(spec({ flow: 'row', gap: 10, width: 300, alignY: 'center' }), [entry('icon', 40, 40), entry('label', 100, 20, { fillX: true })])
    expect(result.height).toBe(40)
    expect(result.slots[1]).toEqual({ id: 'label', x: 50, y: 10, width: 250, height: 20 })
  })

  it('aligns and spreads a row inside a fixed width', () => {
    const centred = solveLayout(spec({ flow: 'row', gap: 10, width: 300, alignX: 'center' }), [entry('a', 50, 10), entry('b', 50, 10)])
    expect(centred.slots.map((s) => s.x)).toEqual([95, 155])
    const spread = solveLayout(spec({ flow: 'row', gap: 10, width: 300, spaceBetween: true }), [entry('a', 50, 10), entry('b', 50, 10), entry('c', 50, 10)])
    expect(spread.slots.map((s) => s.x)).toEqual([0, 125, 250])
  })

  it('wraps rows at the width and stacks them with the line gap', () => {
    const result = solveLayout(spec({ flow: 'wrap', gap: 10, lineGap: 4, width: 120 }), [entry('a', 50, 20), entry('b', 50, 30), entry('c', 50, 20)])
    expect(result.slots.map(({ x, y }) => [x, y])).toEqual([
      [0, 0],
      [60, 0],
      [0, 34],
    ])
    expect(result.height).toBe(54)
  })

  it('fills a grid row by row, each column as wide as its widest member', () => {
    const result = solveLayout(spec({ flow: 'grid', columns: 2, gap: 10, lineGap: 10 }), [entry('a', 50, 20), entry('b', 80, 20), entry('c', 70, 40)])
    expect(result.slots.map(({ x, y }) => [x, y])).toEqual([
      [0, 0],
      [80, 0],
      [0, 30],
    ])
    expect(result).toMatchObject({ width: 160, height: 70 })
  })

  it('keeps a hugging container within its min and max', () => {
    expect(solveLayout(spec({ flow: 'row', minWidth: 300 }), [entry('a', 50, 10)]).width).toBe(300)
    expect(solveLayout(spec({ flow: 'row', maxWidth: 40 }), [entry('a', 50, 10)]).width).toBe(40)
  })
})
