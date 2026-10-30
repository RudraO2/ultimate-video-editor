import { TextStyleSchema } from '@uve/core'
import { describe, expect, it } from 'vitest'
import { layoutText, type TextBoxSpec, type TextMeasurer } from './content'

// Every character is 10 px wide, so widths are easy to read.
const measure: TextMeasurer = {
  font: '',
  letterSpacing: '0px',
  textAlign: 'left',
  textBaseline: 'alphabetic',
  // Wider for a bigger font: 10 px per character at 20 px.
  measureText(text) {
    return { width: (text.length * 10 * Number.parseFloat(this.font.split(' ')[1] ?? '20')) / 20 }
  },
}
const style = (fields: object = {}) => TextStyleSchema.parse({ fontSize: 20, lineHeight: 1, ...fields })
const auto: TextBoxSpec = { maxWidth: null, maxHeight: null, verticalAlign: 'top' }

describe('text layout', () => {
  it('auto width: one line per paragraph and a box that hugs the widest', () => {
    const layout = layoutText(measure, 'one two three\nfour', style(), auto)
    expect(layout.lines.map((l) => l.text)).toEqual(['one two three', 'four'])
    expect(layout.box).toEqual({ width: 130, height: 40 })
  })

  it('auto height: wraps between words at maxWidth and keeps the box width', () => {
    const layout = layoutText(measure, 'one two three four', style(), { ...auto, maxWidth: 80 })
    expect(layout.lines.map((l) => l.text)).toEqual(['one two', 'three', 'four'])
    expect(layout.box).toEqual({ width: 80, height: 60 })
  })

  it('lets a word longer than the box overflow on its own line', () => {
    const layout = layoutText(measure, 'a extraordinary b', style(), { ...auto, maxWidth: 50 })
    expect(layout.lines.map((l) => l.text)).toEqual(['a', 'extraordinary', 'b'])
  })

  it('aligns lines inside the box', () => {
    const spec = { ...auto, maxWidth: 100 }
    expect(layoutText(measure, 'ab', style({ align: 'left' }), spec).lines[0]!.x).toBe(-50)
    expect(layoutText(measure, 'ab', style({ align: 'center' }), spec).lines[0]!.x).toBe(-10)
    expect(layoutText(measure, 'ab', style({ align: 'right' }), spec).lines[0]!.x).toBe(30)
  })

  it('justifies every line but the last of a paragraph', () => {
    const layout = layoutText(measure, 'aa bb cc dd', style({ align: 'justify' }), { ...auto, maxWidth: 90 })
    expect(layout.lines.map((l) => l.text)).toEqual(['aa bb cc', 'dd'])
    // 'aa bb cc' is 80 px; the 10 px left over is shared by its two spaces.
    expect(layout.lines[0]!.fragments.map((f) => [f.text, f.x])).toEqual([
      ['aa', -45],
      ['bb', -10],
      ['cc', 25],
    ])
    expect(layout.lines[1]!.fragments.map((f) => [f.text, f.x])).toEqual([['dd', -45]])
  })

  it('fixed box: keeps its height and places the lines with verticalAlign', () => {
    const spec: TextBoxSpec = { maxWidth: 100, maxHeight: 100, verticalAlign: 'top' }
    expect(layoutText(measure, 'a\nb', style(), spec).box).toEqual({ width: 100, height: 100 })
    expect(layoutText(measure, 'a\nb', style(), spec).lines[0]!.top).toBe(-50)
    expect(layoutText(measure, 'a\nb', style(), { ...spec, verticalAlign: 'middle' }).lines[0]!.top).toBe(-20)
    expect(layoutText(measure, 'a\nb', style(), { ...spec, verticalAlign: 'bottom' }).lines[0]!.top).toBe(10)
  })

  it('cuts fragments where a styled range starts and ends, and makes its line as tall as its largest size', () => {
    const ranges = [{ id: 'r', start: 3, end: 8, style: { fontSize: 40, color: '#ffd60a' } }]
    const layout = layoutText(measure, 'We count down', style(), auto, ranges)
    const line = layout.lines[0]!
    expect(line.fragments.map((f) => [f.text, f.style.fontSize, f.style.ownColor])).toEqual([
      ['We', 20, false],
      ['count', 40, true],
      ['down', 20, false],
    ])
    // "We " 30 + "count" 100 (twice the size) + " down" 50.
    expect(layout.box).toEqual({ width: 180, height: 40 })
    expect(line.fragments.map((f) => f.x)).toEqual([-90, -60, 50])
  })

  it('shows text in upper, lower or title case without changing the text', () => {
    const text = 'hello wORLD it\'s-fine (x) "y"'
    const lines = (textCase: string) => layoutText(measure, text, style({ textCase }), auto).lines.map((l) => l.text)
    expect(lines('none')).toEqual([text])
    expect(lines('upper')).toEqual(['HELLO WORLD IT\'S-FINE (X) "Y"'])
    expect(lines('lower')).toEqual(['hello world it\'s-fine (x) "y"'])
    // Title case raises the first letter of each word and leaves the rest as typed; an apostrophe inside a word does not start one.
    expect(lines('title')).toEqual(['Hello WORLD It\'s-Fine (X) "Y"'])
  })

  it('keeps grapheme indices when a case change makes a character longer', () => {
    const layout = layoutText(measure, 'aß b', style({ textCase: 'upper' }), auto)
    expect(layout.lines[0]!.fragments.map((f) => [f.text, f.start])).toEqual([
      ['ASS', 0],
      ['B', 3],
    ])
  })

  it('lets a styled range have its own case', () => {
    const ranges = [{ id: 'r', start: 0, end: 5, style: { textCase: 'upper' as const } }]
    expect(layoutText(measure, 'hello world', style(), auto, ranges).lines[0]!.text).toBe('HELLO world')
  })

  it('makes fragments of the spaces between decorated words, so one line runs through them', () => {
    const texts = (fields: object) => layoutText(measure, 'ab cd', style(fields), auto).lines[0]!.fragments.map((f) => f.text)
    expect(texts({})).toEqual(['ab', 'cd'])
    expect(texts({ decoration: 'underline' })).toEqual(['ab', ' ', 'cd'])
    expect(texts({ decoration: 'strikethrough' })).toEqual(['ab', ' ', 'cd'])
  })

  it('wraps with styled words measured in their own size', () => {
    const ranges = [{ id: 'r', start: 0, end: 3, style: { fontSize: 60 } }]
    const layout = layoutText(measure, 'Big word here', style(), { ...auto, maxWidth: 120 }, ranges)
    expect(layout.lines.map((l) => l.text)).toEqual(['Big', 'word here'])
    expect(layout.lines.map((l) => l.height)).toEqual([60, 20])
  })
})
