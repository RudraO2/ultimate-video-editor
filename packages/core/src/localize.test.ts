import { describe, expect, it } from 'vitest'
import { createDefaultProject } from './doc'
import { sequentialIds } from './ids'
import { fitPace, takeSlots } from './localize'
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
  const comp = () => session.project.comps[0] as Comp
  const layer = (id: string) => comp().tracks.flatMap((t) => t.layers).find((l) => l.id === id) as Layer
  return { session, ok, comp, layer }
}

describe('timeline.insert_time', () => {
  it('slides what follows, holds what spans the moment (keys and cues after it slide too), and grows the comp, as one step', async () => {
    const { session, ok, comp, layer } = setup()
    const before = comp().durationMs
    const bg = await ok('layer.create', { kind: 'shape', name: 'BG', startMs: 0, durationMs: before })
    await ok('keyframes.set', { id: bg.id, path: 'transform.x', keys: [{ t: 500, v: 0 }, { t: 3000, v: 100 }] })
    const late = await ok('layer.create', { kind: 'shape', name: 'Late', startMs: 2500, durationMs: 1000 })
    const early = await ok('layer.create', { kind: 'shape', name: 'Early', startMs: 0, durationMs: 1000 })
    const text = await ok('layer.create', { kind: 'text', name: 'Cap', text: 'one two', startMs: 1000, durationMs: 2000 })
    await ok('caption.set', { id: text.id, words: [{ startMs: 100, endMs: 600 }, { startMs: 1200, endMs: 1800 }] })

    const result = await ok('timeline.insert_time', { atMs: 2000, durationMs: 700 })
    expect(result.addedMs).toBe(700)
    expect(comp().durationMs).toBe(before + 700)
    expect(layer(late.id).startMs).toBe(3200)
    expect(layer(early.id)).toMatchObject({ startMs: 0, durationMs: 1000 })
    const held = layer(bg.id)
    expect(held.durationMs).toBe(before + 700)
    expect(held.animations['transform.x']?.map((k) => k.t)).toEqual([500, 3700])
    const cap = layer(text.id)
    expect(cap.durationMs).toBe(2700)
    expect(cap.kind === 'text' && cap.caption?.cues.map((c) => [c.startMs, c.endMs])).toEqual([
      [100, 600],
      [1900, 2500],
    ])
    session.undo()
    expect(comp().durationMs).toBe(before)
    expect(layer(late.id).startMs).toBe(2500)
  })

  it('refuses a moment past the end', async () => {
    const { session, comp } = setup()
    const result = await session.call('timeline.insert_time', { atMs: comp().durationMs + 1000, durationMs: 500 })
    expect(result.ok).toBe(false)
  })
})

describe('takeSlots and fitPace', () => {
  it('gives each take the room up to the next take less a breath, never less than it had', () => {
    const slots = takeSlots(
      [
        { id: 'b', speechStartMs: 3000, speechEndMs: 4000 },
        { id: 'a', speechStartMs: 200, speechEndMs: 2900 },
      ],
      6000,
    )
    expect(slots).toEqual([
      { id: 'a', slotMs: 2700 },
      { id: 'b', slotMs: 2750 },
    ])
  })

  it('keeps the pace when a take fits, speeds up to the limit, and reports what still overflows', () => {
    expect(fitPace(1800, 2000)).toEqual({ pace: 1, overflowMs: 0 })
    expect(fitPace(2200, 2000)).toEqual({ pace: 1.1, overflowMs: 0 })
    const tight = fitPace(3000, 2000, 1, 1.25)
    expect(tight.pace).toBe(1.25)
    expect(tight.overflowMs).toBe(400)
  })
})
