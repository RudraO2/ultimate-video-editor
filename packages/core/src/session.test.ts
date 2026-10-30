import { describe, expect, it } from 'vitest'
import { CORE_COMMANDS } from './commands'
import { createDefaultProject } from './doc'
import { sequentialIds } from './ids'
import { ProjectSchema } from './schema'
import { Session } from './session'

function setup() {
  const ids = sequentialIds()
  const session = new Session({ project: createDefaultProject(ids), ids })
  const call = (name: string, input: unknown = {}) => session.call(name, input)
  // biome-ignore lint/suspicious/noExplicitAny: test results are checked field by field
  const ok = async (name: string, input: unknown = {}): Promise<any> => {
    const result = await session.call(name, input)
    if (!result.ok) throw new Error(`${name} failed: ${result.error}`)
    return result.value
  }
  const comp = () => session.project.comps[0]
  const layer = (id: string) => comp()?.tracks.flatMap((t) => t.layers).find((l) => l.id === id)
  return { session, call, ok, comp, layer }
}

describe('history', () => {
  it('makes each call one undo step', async () => {
    const { session, ok, comp, layer } = setup()
    const created = await ok('layer.create', { kind: 'text', text: 'Hello world' })
    expect(created).toEqual({ id: 'layer_1', trackId: 'track_1', compId: 'comp_1' })
    expect(layer('layer_1')).toMatchObject({ name: 'Hello world', durationMs: 10_000, transform: { x: 0, opacity: 1 } })
    expect(session.undoLabel).toBe('Create layer')

    expect(session.undo()).toBe(true)
    expect(comp()?.tracks).toHaveLength(0)
    expect(session.redo()).toBe(true)
    expect(layer('layer_1')?.kind).toBe('text')
  })

  it('groups a transaction into one undo step with its label', async () => {
    const { session, comp } = setup()
    await session.transact('Agent: title card', async (call) => {
      await call('layer.create', { kind: 'shape' })
      await call('layer.create', { kind: 'text', text: 'Title' })
    })
    expect(comp()?.tracks).toHaveLength(2)
    expect(session.undoLabel).toBe('Agent: title card')
    session.undo()
    expect(comp()?.tracks).toHaveLength(0)
  })

  it('joins grouped calls into one undo step until another step comes between', async () => {
    const { session, comp } = setup()
    const agent = { group: 'agent:1', label: 'Agent: title' }
    await session.call('layer.create', { kind: 'shape' }, agent)
    await session.call('doc.overview', {}, agent)
    await session.call('layer.create', { kind: 'text', text: 'Title' }, agent)
    expect(session.undoLabel).toBe('Agent: title')
    expect(session.undoGroup).toBe('agent:1')

    await session.call('project.update', { name: 'By hand' })
    await session.call('layer.create', { kind: 'text', text: 'More' }, agent)
    expect(comp()?.tracks).toHaveLength(3)
    session.undo()
    expect(comp()?.tracks).toHaveLength(2)
    expect(session.undoGroup).toBeUndefined()
    session.undo()
    expect(session.project.name).not.toBe('By hand')
    expect(session.undoGroup).toBe('agent:1')
    session.undo()
    expect(comp()?.tracks).toHaveLength(0)
    expect(session.canUndo).toBe(false)
  })

  it('leaves no trace when a command fails', async () => {
    const { session, ok, call } = setup()
    await ok('layer.create', { kind: 'shape' })
    const before = session.project
    const result = await call('layer.patch', { id: 'layer_1', ops: [{ op: 'set', path: 'shape.width', value: -5 }] })
    expect(result.ok).toBe(false)
    expect(session.project).toBe(before)
    expect(session.undoLabel).toBe('Create layer')
  })

  it('does not record read-only calls', async () => {
    const { session, ok } = setup()
    await ok('doc.overview')
    expect(session.canUndo).toBe(false)
  })
})

describe('layers', () => {
  it('refuses fields that have their own commands, with a hint', async () => {
    const { ok, call } = setup()
    await ok('layer.create', { kind: 'shape' })
    const result = await call('layer.patch', { id: 'layer_1', ops: [{ op: 'set', path: 'startMs', value: 5 }] })
    expect(result).toMatchObject({ ok: false, hint: expect.stringContaining('timeline.move') })
  })

  it('patches fields and rejects unknown ones', async () => {
    const { ok, call, layer } = setup()
    await ok('layer.create', { kind: 'text', text: 'Hi' })
    await ok('layer.patch', { id: 'layer_1', ops: [{ op: 'merge', path: 'style', value: { align: 'left' } }] })
    expect(layer('layer_1')).toMatchObject({ style: { align: 'left', fontSize: 96 } })

    const typo = await call('layer.patch', { id: 'layer_1', ops: [{ op: 'set', path: 'style.colour', value: '#000000' }] })
    expect(typo.ok).toBe(false)
    expect(!typo.ok && typo.error).toMatch(/colour/)
  })

  it('rejects unknown input fields instead of dropping them', async () => {
    const { call, comp } = setup()
    const result = await call('layer.create', { kind: 'shape', colour: '#ff0000' })
    expect(result).toMatchObject({ ok: false })
    expect(!result.ok && result.error).toContain('colour')
    expect(comp()?.tracks).toHaveLength(0)
  })

  it('finds layers by a unique name', async () => {
    const { ok, layer } = setup()
    await ok('layer.create', { kind: 'text', text: 'Headline' })
    await ok('layer.set', { id: 'Headline', values: { y: -200 } })
    expect(layer('layer_1')?.transform.y).toBe(-200)
  })

  it('needs media of the right kind for media layers', async () => {
    const { ok, call } = setup()
    const missing = await call('layer.create', { kind: 'video' })
    expect(missing).toMatchObject({ ok: false, hint: expect.stringContaining('media.add') })
    const { id } = await ok('media.add', { kind: 'image', name: 'logo.png', path: 'C:/media/logo.png' })
    const wrong = await call('layer.create', { kind: 'video', mediaId: id })
    expect(wrong.ok).toBe(false)
  })

  it('deletes layers but keeps their tracks', async () => {
    const { ok, comp } = setup()
    await ok('layer.create', { kind: 'shape' })
    await ok('layers.delete', { ids: ['layer_1'] })
    expect(comp()?.tracks).toHaveLength(1)
    expect(comp()?.tracks[0]?.layers).toHaveLength(0)
  })

  it('scales pictures larger than the comp down to fit, unless a scale is given', async () => {
    const { ok, layer } = setup()
    const big = await ok('media.add', { kind: 'video', name: 'uhd.mp4', path: 'C:/media/uhd.mp4', width: 3840, height: 2160 })
    const small = await ok('media.add', { kind: 'image', name: 'logo.png', path: 'C:/media/logo.png', width: 400, height: 300 })
    await ok('layer.create', { kind: 'video', mediaId: big.id })
    await ok('layer.create', { kind: 'video', mediaId: big.id, transform: { scaleX: 1 } })
    await ok('layer.create', { kind: 'image', mediaId: small.id })
    expect(layer('layer_1')?.transform).toMatchObject({ scaleX: 0.5, scaleY: 0.5 })
    expect(layer('layer_2')?.transform).toMatchObject({ scaleX: 1, scaleY: 1 })
    expect(layer('layer_3')?.transform).toMatchObject({ scaleX: 1, scaleY: 1 })
  })
})

describe('text boxes', () => {
  it('creates text with a wrap width and a fixed box, and only on text layers', async () => {
    const { ok, call, layer } = setup()
    const { id } = await ok('layer.create', { kind: 'text', text: 'A long caption', maxWidth: 600 })
    expect(layer(id)).toMatchObject({ maxWidth: 600, maxHeight: null, verticalAlign: 'top', clipContent: false })
    const fixed = await ok('layer.create', { kind: 'text', text: 'Box', maxWidth: 400, maxHeight: 200 })
    expect(layer(fixed.id)).toMatchObject({ maxWidth: 400, maxHeight: 200 })
    expect((await ok('layer.create', { kind: 'text', text: 'Auto' })).id).toBeTruthy()
    const shape = await call('layer.create', { kind: 'shape', maxWidth: 100 })
    expect(shape.ok).toBe(false)
  })

  it('keys the box width, switches back to auto width with a patch, and justifies', async () => {
    const { ok, call, layer } = setup()
    const { id } = await ok('layer.create', { kind: 'text', text: 'Words', maxWidth: 600 })
    await ok('layer.set', { id, values: { maxWidth: 300 }, mode: 'keyframe', atMs: 0 })
    expect(layer(id)?.animations.maxWidth).toHaveLength(1)
    expect((await call('layer.set', { id, values: { maxWidth: 0 } })).ok).toBe(false)
    await ok('layer.patch', { id, ops: [{ op: 'set', path: 'maxWidth', value: null }, { op: 'set', path: 'style.align', value: 'justify' }] })
    expect(layer(id)).toMatchObject({ maxWidth: null, style: { align: 'justify' } })
    expect((await call('layer.patch', { id, ops: [{ op: 'set', path: 'verticalAlign', value: 'centre' }] })).ok).toBe(false)
  })

  it("takes the pivot as a fraction of the box, under AtomCut's names too", async () => {
    const { ok, layer } = setup()
    const { id } = await ok('layer.create', { kind: 'text', text: 'Left' })
    expect(layer(id)?.transform).toMatchObject({ anchorX: 0.5, anchorY: 0.5 })
    await ok('layer.set', { id, values: { 'anchor.x': 0, 'anchor.y': 1 } })
    expect(layer(id)?.transform).toMatchObject({ anchorX: 0, anchorY: 1 })
    await ok('layer.set', { id, values: { anchor: [0.5, 0.25] } })
    expect(layer(id)?.transform).toMatchObject({ anchorX: 0.5, anchorY: 0.25 })
  })
})

describe('paints', () => {
  it('creates gradient fills and strokes with minted ids, and AtomCut shorthands', async () => {
    const { ok, layer } = setup()
    const { id } = await ok('layer.create', {
      kind: 'shape',
      fill: { type: 'linear', stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }] },
      stroke: { paint: '#ffffff', width: 6, align: 'outside', dash: [10, 5], trim: { end: 0.5 } },
    })
    const created = layer(id)
    if (created?.kind !== 'shape') throw new Error('not a shape')
    expect(created.fills[0]).toMatchObject({ type: 'linear', start: { x: 0, y: 0.5 }, end: { x: 1, y: 0.5 } })
    expect(created.fills[0]?.id).toMatch(/^paint_/)
    expect(created.strokes[0]).toMatchObject({ width: 6, align: 'outside', dash: [10, 5], trim: { start: 0, end: 0.5, offset: 0 } })
    const plain = await ok('layer.create', { kind: 'shape', shape: { fill: '#00ff00', strokeWidth: 3 } })
    expect(layer(plain.id)).toMatchObject({ fills: [{ color: '#00ff00' }], strokes: [{ width: 3, paint: { color: '#ffffff' } }] })
    const bare = await ok('layer.create', { kind: 'shape', fill: null })
    expect(layer(bare.id)).toMatchObject({ fills: [], strokes: [] })
    const text = await ok('layer.create', { kind: 'text', text: 'Hi', fill: { type: 'radial', stops: [{ offset: 0, color: '#ffffff' }, { offset: 1, color: '#000000' }] } })
    expect(layer(text.id)).toMatchObject({ fills: [{ type: 'radial', start: { x: 0.5, y: 0.5 } }] })
  })

  it("keys paints by AtomCut's paths and by the first paint's short names", async () => {
    const { ok, call, layer } = setup()
    const { id } = await ok('layer.create', { kind: 'shape', stroke: '#ffffff' })
    const shape = layer(id)
    if (shape?.kind !== 'shape') throw new Error('not a shape')
    const fillId = shape.fills[0]!.id
    const strokeId = shape.strokes[0]!.id
    await ok('layer.set', { id, values: { fill: '#123456', strokeWidth: 8 } })
    expect(layer(id)).toMatchObject({ fills: [{ color: '#123456' }], strokes: [{ width: 8 }] })
    await ok('keyframes.set', { id, property: `stroke.${strokeId}.trim.end`, keys: [{ at: 0, value: 0 }, { at: 800, value: 1 }] })
    await ok('layer.set', { id, values: { [`fill.${fillId}`]: '#ffffff' }, mode: 'keyframe', atMs: 0 })
    expect(Object.keys(layer(id)!.animations).sort()).toEqual([`fill.${fillId}`, `stroke.${strokeId}.trim.end`])
    const props = await ok('layer.properties', { id, atMs: 400 })
    expect(props.find((p: { path: string }) => p.path === `stroke.${strokeId}.trim.end`)).toMatchObject({ alias: 'trimEnd' })
    expect((await call('layer.set', { id, values: { trimEnd: 2 } })).ok).toBe(false)
    expect((await call('layer.set', { id, values: { 'fill.nope': '#ffffff' } })).ok).toBe(false)
  })

  it('mints ids for patched paints, drops the keys of removed ones, and refuses trim on text', async () => {
    const { ok, call, layer } = setup()
    const { id } = await ok('layer.create', { kind: 'shape' })
    await ok('layer.patch', { id, ops: [{ op: 'insert', path: 'strokes[-]', value: { paint: { type: 'solid', color: '#ff0000' }, width: 4 } }] })
    const strokeId = (layer(id) as { strokes: { id: string }[] }).strokes[0]!.id
    await ok('layer.set', { id, values: { strokeWidth: 9 }, mode: 'keyframe', atMs: 0 })
    const removed = await ok('layer.patch', { id, ops: [{ op: 'remove', path: 'strokes[0]' }] })
    expect(removed.droppedKeys).toEqual([`stroke.${strokeId}.width`])
    expect(layer(id)!.animations).toEqual({})
    const text = await ok('layer.create', { kind: 'text', text: 'Hi' })
    const refused = await call('layer.patch', { id: text.id, ops: [{ op: 'insert', path: 'strokes[-]', value: { paint: { type: 'solid', color: '#ff0000' }, width: 4, trim: { end: 0.5 } } }] })
    expect(refused.ok).toBe(false)
    await ok('layer.patch', { id: text.id, ops: [{ op: 'insert', path: 'strokes[-]', value: { paint: { type: 'solid', color: '#000000' }, width: 4, align: 'outside' } }] })
    expect((await call('layer.set', { id: text.id, values: { trimEnd: 0.5 } })).ok).toBe(false)
  })
})

describe('media and tracks', () => {
  it('registers a file once and lists what uses it', async () => {
    const { session, ok } = setup()
    const first = await ok('media.add', { kind: 'audio', name: 'music.mp3', path: 'C:/media/music.mp3', durationMs: 9000 })
    const again = await ok('media.add', { kind: 'audio', name: 'music.mp3', path: 'C:/media/music.mp3' })
    expect(again).toEqual({ id: first.id, reused: true })
    expect(session.project.media).toHaveLength(1)
    await ok('layer.create', { kind: 'audio', mediaId: first.id })
    expect(await ok('media.list')).toEqual([expect.objectContaining({ id: first.id, usedBy: 1 })])
  })

  it('keeps media that layers use unless told to delete them too', async () => {
    const { session, ok, call, comp } = setup()
    const media = await ok('media.add', { kind: 'image', name: 'logo.png', path: 'C:/media/logo.png' })
    await ok('layer.create', { kind: 'image', mediaId: media.id })
    const refused = await call('media.remove', { id: media.id })
    expect(refused).toMatchObject({ ok: false, hint: expect.stringContaining('deleteLayers') })

    expect(await ok('media.remove', { id: media.id, deleteLayers: true })).toEqual({
      removed: media.id,
      deletedLayers: ['layer_1'],
    })
    expect(session.project.media).toHaveLength(0)
    expect(comp()?.tracks[0]?.layers).toHaveLength(0)
    session.undo()
    expect(session.project.media).toHaveLength(1)
    expect(comp()?.tracks[0]?.layers).toHaveLength(1)
  })

  it('adds tracks at a position and deletes only empty ones', async () => {
    const { ok, call, comp } = setup()
    await ok('layer.create', { kind: 'shape' })
    expect(await ok('track.create', { index: 1 })).toEqual({ id: 'track_2', compId: 'comp_1', index: 1 })
    expect(comp()?.tracks.map((t) => t.id)).toEqual(['track_1', 'track_2'])
    expect(await call('track.delete', { id: 'track_1' })).toMatchObject({ ok: false, hint: expect.stringContaining('timeline.move') })
    await ok('track.delete', { id: 'track_2' })
    expect(comp()?.tracks.map((t) => t.id)).toEqual(['track_1'])
  })

  it('renames the project', async () => {
    const { ok, call, session } = setup()
    await ok('project.update', { name: '  Launch video ' })
    expect(session.project.name).toBe('Launch video')
    expect(await call('project.update', { name: ' ' })).toMatchObject({ ok: false })
  })

  it('renames, hides, mutes and locks a track as one undo step', async () => {
    const { ok, call, comp, session } = setup()
    await ok('layer.create', { kind: 'shape' })
    expect(comp()?.tracks[0]).toMatchObject({ hidden: false, muted: false, locked: false })
    await ok('track.update', { id: 'track_1', name: 'Titles', hidden: true, locked: true })
    expect(comp()?.tracks[0]).toMatchObject({ name: 'Titles', hidden: true, muted: false, locked: true })
    expect(await call('track.update', { id: 'track_1' })).toMatchObject({ ok: false })
    session.undo()
    expect(comp()?.tracks[0]).toMatchObject({ hidden: false, locked: false })
    expect(comp()?.tracks[0]?.name).toBeUndefined()
  })
})

describe('properties and keys', () => {
  it('sets static values, then keys once a property is animated', async () => {
    const { ok, call, layer } = setup()
    await ok('layer.create', { kind: 'shape', startMs: 1000 })
    await ok('layer.set', { id: 'layer_1', values: { x: 100, fill: '#ff0000', scale: 2 } })
    expect(layer('layer_1')).toMatchObject({
      transform: { x: 100, scaleX: 2, scaleY: 2 },
      fills: [{ type: 'solid', color: '#ff0000' }],
    })

    await ok('keyframes.set', {
      id: 'layer_1',
      path: 'x',
      keys: [
        { t: 0, v: 0, ease: 'linear' },
        { t: 1000, v: 500, ease: 'linear' },
      ],
    })
    const needsTime = await call('layer.set', { id: 'layer_1', values: { x: 50 } })
    expect(needsTime).toMatchObject({ ok: false, hint: expect.stringContaining('atMs') })

    await ok('layer.set', { id: 'layer_1', values: { x: 250 }, atMs: 1500 })
    expect(layer('layer_1')?.animations['transform.x']?.map((k) => [k.t, k.v])).toEqual([
      [0, 0],
      [500, 250],
      [1000, 500],
    ])

    const props = await ok('layer.properties', { id: 'layer_1', atMs: 1250 })
    expect(props.find((p: { alias: string }) => p.alias === 'x')).toMatchObject({ keys: 3 })
  })

  it('reads animated values at a comp time', async () => {
    const { ok } = setup()
    await ok('layer.create', { kind: 'shape', startMs: 1000 })
    await ok('keyframes.set', {
      id: 'layer_1',
      path: 'opacity',
      keys: [
        { t: 0, v: 0, ease: 'linear' },
        { t: 1000, v: 1 },
      ],
    })
    const props = await ok('layer.properties', { id: 'layer_1', atMs: 1500 })
    expect(props.find((p: { alias: string }) => p.alias === 'opacity').value).toBeCloseTo(0.5)
  })

  it('converts comp-time keys and validates values', async () => {
    const { ok, call, layer } = setup()
    await ok('layer.create', { kind: 'shape', startMs: 2000 })
    await ok('keyframes.set', {
      id: 'layer_1',
      path: 'rotation',
      clock: 'comp',
      keys: [
        { t: 2000, v: 0 },
        { t: 3000, v: 90 },
      ],
    })
    expect(layer('layer_1')?.animations['transform.rotation']?.map((k) => k.t)).toEqual([0, 1000])
    const bad = await call('keyframes.set', { id: 'layer_1', path: 'opacity', keys: [{ t: 0, v: 3 }] })
    expect(bad.ok).toBe(false)
  })

  it('clears keys back to a static value', async () => {
    const { ok, layer } = setup()
    await ok('layer.create', { kind: 'shape' })
    await ok('keyframes.set', { id: 'layer_1', path: 'y', keys: [{ t: 0, v: 40 }, { t: 500, v: 80 }] })
    const { cleared } = await ok('keyframes.clear', { id: 'layer_1', path: 'y' })
    expect(cleared).toEqual(['transform.y'])
    expect(layer('layer_1')?.transform.y).toBe(40)
    expect(layer('layer_1')?.animations).toEqual({})
  })

  it('removes single keys, and the last one leaves the first value static', async () => {
    const { ok, call, layer } = setup()
    await ok('layer.create', { kind: 'shape', startMs: 1000 })
    await ok('keyframes.set', { id: 'layer_1', path: 'scale', keys: [{ t: 0, v: 0.5 }, { t: 500, v: 1 }] })
    expect(await ok('keyframes.remove', { id: 'layer_1', path: 'scale', times: [1500], clock: 'comp' })).toMatchObject({
      removed: 2,
    })
    expect(layer('layer_1')?.animations['transform.scaleX']?.map((k) => k.t)).toEqual([0])

    const missing = await call('keyframes.remove', { id: 'layer_1', path: 'scale', times: [250] })
    expect(missing).toMatchObject({ ok: false, error: expect.stringContaining('no key') })

    await ok('keyframes.remove', { id: 'layer_1', path: 'scale', times: [0] })
    expect(layer('layer_1')?.animations).toEqual({})
    expect(layer('layer_1')?.transform).toMatchObject({ scaleX: 0.5, scaleY: 0.5 })
  })
})

describe('timeline', () => {
  it('keeps layers on a track from overlapping', async () => {
    const { ok, call, comp } = setup()
    await ok('layer.create', { kind: 'shape', durationMs: 5000 })
    await ok('layer.create', { kind: 'text', text: 'B', startMs: 5000, durationMs: 2000, trackId: 'track_1' })
    const clash = await call('timeline.move', { id: 'layer_2', startMs: 4000 })
    expect(clash).toMatchObject({ ok: false, hint: expect.stringContaining('"new"') })

    const moved = await ok('timeline.move', { id: 'layer_2', startMs: 4000, trackId: 'new' })
    expect(moved.trackId).toBe('track_2')
    expect(comp()?.tracks.map((t) => t.id)).toEqual(['track_2', 'track_1'])
  })

  it('trims media layers without moving their picture', async () => {
    const { ok, call, layer } = setup()
    const media = await ok('media.add', { kind: 'video', name: 'demo.mp4', path: 'C:/media/demo.mp4', durationMs: 8000 })
    await ok('layer.create', { kind: 'video', mediaId: media.id, startMs: 1000 })
    expect(layer('layer_1')?.durationMs).toBe(8000)
    await ok('keyframes.set', { id: 'layer_1', path: 'opacity', keys: [{ t: 0, v: 0 }, { t: 4000, v: 1 }] })

    await ok('timeline.trim', { id: 'layer_1', startMs: 3000 })
    expect(layer('layer_1')).toMatchObject({ startMs: 3000, durationMs: 6000, sourceStartMs: 2000 })
    expect(layer('layer_1')?.animations['transform.opacity']?.map((k) => k.t)).toEqual([-2000, 2000])

    expect((await call('timeline.trim', { id: 'layer_1', startMs: 500 })).ok).toBe(false)
    expect((await call('timeline.trim', { id: 'layer_1', endMs: 9500 })).ok).toBe(false)
  })

  it('splits a layer in two', async () => {
    const { ok, comp, layer } = setup()
    const media = await ok('media.add', { kind: 'video', name: 'demo.mp4', path: 'C:/media/demo.mp4', durationMs: 8000 })
    await ok('layer.create', { kind: 'video', mediaId: media.id })
    await ok('keyframes.set', { id: 'layer_1', path: 'x', keys: [{ t: 0, v: 0 }, { t: 6000, v: 600 }] })
    const { left, right } = await ok('timeline.split', { id: 'layer_1', atMs: 3000 })
    expect(left).toBe('layer_1')
    expect(comp()?.tracks[0]?.layers.map((l) => l.id)).toEqual(['layer_1', right])
    expect(layer(left)?.durationMs).toBe(3000)
    expect(layer(right)).toMatchObject({ startMs: 3000, durationMs: 5000, sourceStartMs: 3000 })
    expect(layer(right)?.animations['transform.x']?.map((k) => k.t)).toEqual([-3000, 3000])
  })
})

describe('api.batch', () => {
  it('passes earlier results to later calls and records one undo step', async () => {
    const { session, ok, comp, layer } = setup()
    const { results } = await ok('api.batch', {
      calls: [
        { command: 'layer.create', input: { kind: 'text', text: 'Title' } },
        { command: 'layer_set', input: { id: '$0.id', values: { y: 200 } } },
      ],
    })
    expect(results.map((r: { ok: boolean }) => r.ok)).toEqual([true, true])
    expect(layer('layer_1')?.transform.y).toBe(200)
    session.undo()
    expect(comp()?.tracks).toHaveLength(0)
  })

  it('stops at the first failure unless told to continue', async () => {
    const { ok } = setup()
    const stopped = await ok('api.batch', {
      calls: [
        { command: 'layer.set', input: { id: 'nobody', values: { x: 1 } } },
        { command: 'layer.create', input: { kind: 'shape' } },
      ],
    })
    expect(stopped).toMatchObject({ stoppedAt: 0, skipped: 1 })

    const continued = await ok('api.batch', {
      continueOnError: true,
      calls: [
        { command: 'layer.set', input: { id: 'nobody', values: { x: 1 } } },
        { command: 'layer.create', input: { kind: 'shape' } },
      ],
    })
    expect(continued.results.map((r: { ok: boolean }) => r.ok)).toEqual([false, true])
  })

  it('does not nest batches', async () => {
    const { ok } = setup()
    const { results } = await ok('api.batch', { calls: [{ command: 'api.batch', input: { calls: [] } }] })
    expect(results[0]).toMatchObject({ ok: false, error: 'Batches do not nest.' })
  })
})

describe('describing the API', () => {
  it('describes document types and commands from the live schema', async () => {
    const { ok, call } = setup()
    const text = await ok('api.describe', { type: 'text' })
    expect(text.schema.properties).toHaveProperty('style')
    const create = await ok('api.describe', { command: 'layer_create' })
    expect(create.input.properties.kind.enum).toContain('shape')
    const index = await ok('api.describe')
    expect(index.commands).toHaveLength(CORE_COMMANDS.length)
    const unknown = await call('layer.wiggle', {})
    expect(unknown).toMatchObject({ ok: false, hint: expect.stringContaining('layer.') })
  })
})

describe('integrity', () => {
  it('keeps the project schema-valid through a series of edits', async () => {
    const { session, ok } = setup()
    const media = await ok('media.add', { kind: 'video', name: 'clip.mp4', path: 'C:/media/clip.mp4', durationMs: 6000 })
    await ok('comp.update', { id: 'comp_1', durationMs: 15_000, background: '#101014' })
    await ok('layer.create', { kind: 'video', mediaId: media.id })
    await ok('layer.create', { kind: 'text', text: 'Launch day', style: { fontSize: 140 } })
    await ok('layer.create', { kind: 'shape', shape: { type: 'ellipse', fill: '#22cc88' } })
    await ok('keyframes.set', { id: 'layer_2', path: 'scale', keys: [{ t: 0, v: 0.8 }, { t: 600, v: 1, ease: 'ease-out-back' }] })
    await ok('timeline.split', { id: 'layer_1', atMs: 2500 })
    await ok('timeline.trim', { id: 'layer_3', endMs: 8000 })
    await ok('comp.create', { name: 'Thumbnail', width: 1280, height: 720 })
    expect(() => ProjectSchema.parse(session.project)).not.toThrow()
  })
})
