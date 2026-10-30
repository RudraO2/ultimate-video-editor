import { describe, expect, it } from 'vitest'
import { createDefaultProject } from './doc'
import { sequentialIds } from './ids'
import type { Layer, TextRange } from './schema'
import { Session } from './session'
import { graphemes, remapRanges, styleRange, targetSpans } from './textRanges'

const ids = () => {
  let n = 0
  return () => `r${++n}`
}

describe('text ranges', () => {
  it('counts an emoji with its modifiers as one character', () => {
    expect(graphemes('a👍🏽b')).toEqual(['a', '👍🏽', 'b'])
    expect(targetSpans('a👍🏽b ok', { match: 'ok' })).toEqual([[4, 6]])
  })

  it('finds a match, a later one, or all of them, and says when there is none', () => {
    expect(targetSpans('one two one', { match: 'one' })).toEqual([[0, 3]])
    expect(targetSpans('one two one', { match: 'one', occurrence: 2 })).toEqual([[8, 11]])
    expect(targetSpans('one two one', { match: 'one', occurrence: 'all' })).toHaveLength(2)
    expect(() => targetSpans('one', { match: 'two' })).toThrow(/does not appear/)
    expect(() => targetSpans('one', { match: 'one', occurrence: 3 })).toThrow(/only 1 time/)
    expect(targetSpans('hello', { start: 1, end: 3 })).toEqual([[1, 3]])
  })

  it('splits a range it crosses, layers the new style on top, and joins equal neighbours', () => {
    const id = ids()
    const first: TextRange[] = styleRange([], 0, 10, { color: '#ff0000' }, id)
    const ranges = styleRange(first, 4, 6, { fontWeight: 900 }, id)
    expect(ranges.map((r) => [r.start, r.end, r.style])).toEqual([
      [0, 4, { color: '#ff0000' }],
      [4, 6, { color: '#ff0000', fontWeight: 900 }],
      [6, 10, { color: '#ff0000' }],
    ])
    // Styling the same characters the same way again changes nothing.
    expect(styleRange(ranges, 0, 4, { color: '#ff0000' }, id).map((r) => [r.start, r.end])).toEqual([
      [0, 4],
      [4, 6],
      [6, 10],
    ])
    // A gap gets a new range.
    expect(styleRange([], 2, 4, { italic: true }, id)).toMatchObject([{ start: 2, end: 4, style: { italic: true } }])
  })

  it('keeps ranges on their words through an edit', () => {
    const red = { id: 'a', start: 6, end: 11, style: { color: '#ff0000' } }
    // A word inserted before moves the range.
    expect(remapRanges([red], 'Hello world', 'Oh hello world')).toMatchObject([{ start: 9, end: 14 }])
    // The styled word replaced: the range takes the new word.
    expect(remapRanges([red], 'Hello world', 'Hello there')).toMatchObject([{ start: 6, end: 11 }])
    // The styled word deleted: the range goes.
    expect(remapRanges([red], 'Hello world', 'Hello ')).toEqual([])
  })
})

describe('text.style and text.set', () => {
  it('styles a word, keys its colour, and keeps it through text.set and a patch of the text', async () => {
    const sid = sequentialIds()
    const session = new Session({ project: createDefaultProject(sid), ids: sid })
    const call = (name: string, input: unknown) => session.call(name, input)
    const created = await call('layer.create', { kind: 'text', text: 'We count down' })
    if (!created.ok) throw new Error(created.error)
    const id = (created.value as { id: string }).id
    const layer = () => session.project.comps[0]?.tracks[0]?.layers[0] as Extract<Layer, { kind: 'text' }>
    const styled = await call('text.style', { id, match: 'count', style: { color: '#FFD60A', fontWeight: 900 } })
    expect(styled).toMatchObject({ ok: true, value: { styled: [{ start: 3, end: 8, text: 'count' }] } })
    const rangeId = layer().ranges[0]?.id
    expect((await call('keyframes.set', { id, property: `range.${rangeId}.color`, keys: [{ at: 0, value: '#ffffff' }, { at: 300, value: '#FFD60A' }] })).ok).toBe(true)
    await call('text.set', { id, text: 'Now we count down' })
    expect(layer().ranges).toMatchObject([{ start: 7, end: 12 }])
    await call('layer.patch', { id, ops: [{ op: 'set', path: 'text', value: 'So now we count down' }] })
    expect(layer().ranges).toMatchObject([{ start: 10, end: 15 }])
    const cleared = await call('text.style', { id, match: 'count', clear: true })
    expect(cleared.ok && layer().ranges).toEqual([])
    expect((await call('text.style', { id, match: 'nope', style: { italic: true } })).ok).toBe(false)
    // Only the character fields can be styled per range: align is the layer's.
    expect((await call('text.style', { id, match: 'down', style: { align: 'left' } })).ok).toBe(false)
    expect((await call('text.style', { id, match: 'down', style: { textCase: 'upper', decoration: 'underline' } })).ok).toBe(true)
  })

  it("keys some characters' colour through AtomCut's range", async () => {
    const sid = sequentialIds()
    const session = new Session({ project: createDefaultProject(sid), ids: sid })
    const created = await session.call('layer.create', { kind: 'text', text: 'Ready set go' })
    const id = (created as { value: { id: string } }).value.id
    const keyed = await session.call('keyframes.set', { id, property: 'color', range: { start: 6, end: 9 }, keys: [{ at: 0, value: '#ffffff' }, { at: 200, value: '#ff3366' }] })
    expect(keyed).toMatchObject({ ok: true, value: { paths: [expect.stringMatching(/^range\.range_\d+\.color$/)] } })
    const layer = session.project.comps[0]?.tracks[0]?.layers[0] as Extract<Layer, { kind: 'text' }>
    expect(layer.ranges).toMatchObject([{ start: 6, end: 9, style: { color: '#ffffff' } }])
    expect((await session.call('keyframes.set', { id, property: 'x', range: { start: 0, end: 2 }, keys: [{ at: 0, value: 1 }] })).ok).toBe(false)
  })
})
