import { describe, expect, it } from 'vitest'
import { captionLook, cueState, focusCue, overlayRanges } from './caption'
import { createDefaultProject } from './doc'
import { sequentialIds } from './ids'
import type { Comp, Layer } from './schema'
import { Session } from './session'

function setup() {
  const ids = sequentialIds()
  const session = new Session({ project: createDefaultProject(ids), ids })
  // biome-ignore lint/suspicious/noExplicitAny: test results are checked field by field
  const ok = async (name: string, input: unknown = {}): Promise<any> => {
    const result = await session.call(name, input)
    if (!result.ok) throw new Error(`${name} failed: ${result.error}`)
    return result.value
  }
  const fail = async (name: string, input: unknown) => {
    const result = await session.call(name, input)
    if (result.ok) throw new Error(`${name} should have failed`)
    return `${result.error}\n${result.hint ?? ''}`
  }
  const text = (id: string) => (session.project.comps[0] as Comp).tracks.flatMap((t) => t.layers).find((l) => l.id === id) as Extract<Layer, { kind: 'text' }>
  return { ok, fail, text }
}

describe('captions', () => {
  it('matches words in order and stores cues in layer time', async () => {
    const { ok, fail, text } = setup()
    const { id } = await ok('layer.create', { kind: 'text', text: 'Hello big world', startMs: 1000 })
    await ok('caption.set', {
      id,
      timesIn: 'comp',
      words: [
        { text: 'hello', startMs: 1000, endMs: 1300 },
        { startMs: 1300, endMs: 1500 },
        { text: 'World', startMs: 1500, endMs: 1900 },
      ],
    })
    expect(text(id).caption?.cues.map((c) => [c.start, c.end, c.startMs, c.endMs])).toEqual([
      [0, 5, 0, 300],
      [6, 9, 300, 500],
      [10, 15, 500, 900],
    ])
    expect(await fail('caption.set', { id, words: [{ text: 'moon', startMs: 0, endMs: 100 }] })).toContain('not in the text')
  })

  it('spreads words evenly and moves cues with text edits', async () => {
    const { ok, text } = setup()
    const { id } = await ok('layer.create', { kind: 'text', text: 'one two three', durationMs: 3000 })
    await ok('caption.set', { id, even: { unit: 'word' } })
    expect(text(id).caption?.cues.map((c) => c.startMs)).toEqual([0, 1000, 2000])
    await ok('text.set', { id, text: 'zero one two three' })
    expect(text(id).caption?.cues.map((c) => [c.start, c.end])).toEqual([
      [5, 8],
      [9, 12],
      [13, 18],
    ])
  })

  it('looks unread, focus and read in turn, blending over the motion', async () => {
    const { ok, text } = setup()
    const { id } = await ok('layer.create', { kind: 'text', text: 'a b', style: { color: '#ffffff' } })
    await ok('caption.set', { id, cues: [{ start: 0, end: 1, startMs: 100, endMs: 400 }, { start: 2, end: 3, startMs: 400, endMs: 700 }] })
    const caption = text(id).caption!
    expect(cueState(caption.cues[0]!, 50)).toBe('unread')
    expect(focusCue(caption, 450)).toBe(1)
    const early = captionLook(caption, 50, '#ffffff')
    expect(early.spans.every((s) => s.style.opacity === 0.45)).toBe(true)
    // Settled in focus: dark ink on the amber pill, scaled.
    const focus = captionLook(caption, 300, '#ffffff')
    expect(focus.spans[0]?.style).toMatchObject({ color: '#0F0E0C', highlight: { color: '#F5B843' } })
    expect(focus.scales[0]).toMatchObject({ start: 0, end: 1 })
    // Half way into focus the colour is between white and the ink.
    const blending = captionLook(caption, 180, '#ffffff')
    expect(blending.spans[0]?.style.color).not.toBe('#ffffff')
    expect(blending.spans[0]?.style.color?.toLowerCase()).not.toBe('#0f0e0c')
  })

  it('glides one pill with travel, and takes AtomCut state shapes', async () => {
    const { ok, text } = setup()
    const { id } = await ok('layer.create', { kind: 'text', text: 'a b' })
    await ok('caption.set', {
      id,
      cues: [{ start: 0, end: 1, startMs: 0, endMs: 300 }, { start: 2, end: 3, startMs: 300, endMs: 600 }],
      motion: { travel: true },
      states: { read: { overlay: { props: { opacity: 0.35 } }, scale: 1 } },
    })
    const caption = text(id).caption!
    expect(caption.states.read.style.opacity).toBe(0.35)
    const look = captionLook(caption, 340, '#ffffff')
    expect(look.pill).toMatchObject({ from: [0, 1], to: [2, 3] })
    expect(look.pill!.t).toBeGreaterThan(0)
    expect(look.spans.every((s) => s.style.highlight === null)).toBe(true)
  })

  it('lays spans over ranges without overlaps', () => {
    const ranges = overlayRanges('abcd', [{ id: 'r', start: 1, end: 3, style: { color: '#ff0000' } }], [{ start: 2, end: 4, style: { opacity: 0.5 } }])
    expect(ranges.map((r) => [r.start, r.end, r.style])).toEqual([
      [1, 2, { color: '#ff0000' }],
      [2, 3, { color: '#ff0000', opacity: 0.5 }],
      [3, 4, { opacity: 0.5 }],
    ])
  })
})
