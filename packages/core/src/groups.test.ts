import { describe, expect, it } from 'vitest'
import { createDefaultProject } from './doc'
import { groupStructureProblem } from './groups'
import { sequentialIds } from './ids'
import type { Measure, Placement } from './registry'
import { type Comp, type Layer, ProjectSchema } from './schema'
import { Session } from './session'

/** A stand-in for the editor's measurer: a shape's box at its position, text 100 × 40. */
const fakeMeasure: Measure = (comp: Comp) => {
  const out = new Map<string, Placement>()
  for (const layer of comp.tracks.flatMap((t) => t.layers)) {
    const t = layer.transform
    const width = layer.kind === 'shape' ? layer.shape.width : 100
    const height = layer.kind === 'shape' ? layer.shape.height : 40
    out.set(layer.id, {
      x: t.x,
      y: t.y,
      rotation: t.rotation,
      scaleX: t.scaleX,
      scaleY: t.scaleY,
      opacity: t.opacity,
      bounds: { left: t.x - width / 2, top: t.y - height / 2, width, height },
    })
  }
  return out
}

function setup(measure?: Measure) {
  const ids = sequentialIds()
  const session = new Session({ project: createDefaultProject(ids), ids, measure })
  // biome-ignore lint/suspicious/noExplicitAny: test results are checked field by field
  const ok = async (name: string, input: unknown = {}): Promise<any> => {
    const result = await session.call(name, input)
    if (!result.ok) throw new Error(`${name} failed: ${result.error}`)
    return result.value
  }
  const fail = async (name: string, input: unknown) => {
    const result = await session.call(name, input)
    if (result.ok) throw new Error(`${name} should have failed`)
    return result.error
  }
  const comp = () => session.project.comps[0] as Comp
  const lanes = () => comp().tracks.map((t) => `${t.layers.map((l) => l.name).join('+') || '∅'}${t.groupId ? `@${t.groupId}` : ''}`)
  const layer = (id: string) => comp().tracks.flatMap((t) => t.layers).find((l) => l.id === id) as Layer
  return { session, ok, fail, comp, lanes, layer }
}

describe('groups', () => {
  it('groups layers on their own lanes behind a group lane, as one undo step', async () => {
    const { session, ok, comp, lanes } = setup()
    const a = await ok('layer.create', { kind: 'shape', name: 'A' })
    const b = await ok('layer.create', { kind: 'shape', name: 'B' })
    await ok('layer.create', { kind: 'shape', name: 'C' })
    expect(lanes()).toEqual(['C', 'B', 'A'])
    const { groupId } = await ok('layers.group', { ids: [a.id, b.id], name: 'Pair' })
    expect(lanes()).toEqual(['C', 'Pair', `B@${groupId}`, `A@${groupId}`])
    expect(groupStructureProblem(comp())).toBeNull()
    session.undo()
    expect(lanes()).toEqual(['C', 'B', 'A'])
  })

  it('takes a layer off a shared lane, and spans its members in time', async () => {
    const { ok, lanes, layer } = setup()
    const first = await ok('layer.create', { kind: 'shape', name: 'First', durationMs: 1000 })
    await ok('layer.create', { kind: 'shape', name: 'Later', trackId: first.trackId, startMs: 2000, durationMs: 1000 })
    const other = await ok('layer.create', { kind: 'shape', name: 'Other', startMs: 500, durationMs: 4000 })
    const { groupId } = await ok('layers.group', { ids: [first.id, other.id] })
    expect(lanes()).toEqual(['Group', `Other@${groupId}`, `First@${groupId}`, 'Later'])
    expect(layer(groupId)).toMatchObject({ startMs: 0, durationMs: 4500 })
  })

  it('nests groups, keeps them together and moves and deletes them whole', async () => {
    const { ok, fail, comp, lanes } = setup()
    const a = await ok('layer.create', { kind: 'shape', name: 'A', durationMs: 1000 })
    const b = await ok('layer.create', { kind: 'shape', name: 'B', durationMs: 1000 })
    const inner = await ok('layers.group', { ids: [a.id, b.id], name: 'Inner' })
    const c = await ok('layer.create', { kind: 'shape', name: 'C', durationMs: 1000 })
    const outer = await ok('layers.group', { ids: [inner.groupId, c.id], name: 'Outer' })
    expect(lanes()).toEqual(['Outer', `C@${outer.groupId}`, `Inner@${outer.groupId}`, `B@${inner.groupId}`, `A@${inner.groupId}`])
    expect(groupStructureProblem(comp())).toBeNull()

    await ok('timeline.move', { id: outer.groupId, startMs: 500 })
    expect(comp().tracks.flatMap((t) => t.layers).map((l) => l.startMs)).toEqual([500, 500, 500, 500, 500])
    expect(await fail('timeline.split', { id: inner.groupId, atMs: 900 })).toMatch(/cannot be split/)
    expect(await fail('timeline.move', { id: c.id, trackId: comp().tracks[0]?.id })).toMatch(/lane of group/)

    const deleted = await ok('layers.delete', { ids: [inner.groupId] })
    expect(deleted.alsoDeleted.sort()).toEqual([a.id, b.id].sort())
    expect(lanes()).toEqual(['Outer', `C@${outer.groupId}`])
  })

  it('refuses layers at different levels and audio', async () => {
    const { ok, fail } = setup()
    const a = await ok('layer.create', { kind: 'shape', name: 'A' })
    const b = await ok('layer.create', { kind: 'shape', name: 'B' })
    const c = await ok('layer.create', { kind: 'shape', name: 'C' })
    await ok('layers.group', { ids: [a.id, b.id] })
    expect(await fail('layers.group', { ids: [a.id, c.id] })).toMatch(/another level/)
  })

  it('creates layers in a group, and new lanes join the group they land in', async () => {
    const { ok, comp, lanes } = setup()
    const a = await ok('layer.create', { kind: 'shape', name: 'A' })
    const { groupId } = await ok('layers.group', { ids: [a.id] })
    await ok('layer.create', { kind: 'text', text: 'Label', groupId })
    expect(lanes()).toEqual(['Group', `Label@${groupId}`, `A@${groupId}`])
    await ok('track.create', { index: 2 })
    expect(lanes()[2]).toBe(`∅@${groupId}`)
    await ok('track.create', { index: 0 })
    expect(lanes()[0]).toBe('∅')
    expect(groupStructureProblem(comp())).toBeNull()
  })

  it('ungroups in place, and needs the editor to bake a moved group', async () => {
    const { ok, fail, lanes } = setup()
    const a = await ok('layer.create', { kind: 'shape', name: 'A' })
    const b = await ok('layer.create', { kind: 'shape', name: 'B' })
    const { groupId } = await ok('layers.group', { ids: [a.id, b.id] })
    await ok('layers.ungroup', { ids: a.id })
    expect(lanes()).toEqual(['B', 'A'])
    const again = await ok('layers.group', { ids: [a.id, b.id] })
    await ok('layer.set', { id: again.groupId, values: { x: 100 } })
    expect(await fail('layers.ungroup', { ids: again.groupId })).toMatch(/measure/)
    expect(groupId).not.toBe(again.groupId)
  })

  it('bakes a moved group into its members when it can measure', async () => {
    const { ok, layer, lanes } = setup(fakeMeasure)
    const a = await ok('layer.create', { kind: 'shape', name: 'A', x: 10 })
    const { groupId } = await ok('layers.group', { ids: [a.id] })
    // The fake measurer does not apply groups, so baking writes back where it says the member is.
    await ok('layer.set', { id: groupId, values: { opacity: 0.5 } })
    await ok('layers.ungroup', { ids: groupId })
    expect(lanes()).toEqual(['A'])
    expect(layer(a.id).transform).toMatchObject({ x: 10, opacity: 1 })
  })

  it('makes an auto layout, ordered along the flow, and a rectangle behind becomes the container', async () => {
    const { ok, layer, lanes } = setup(fakeMeasure)
    const pill = await ok('layer.create', { kind: 'shape', name: 'Pill', width: 400, height: 100, fill: '#222222', cornerRadius: 50 })
    const right = await ok('layer.create', { kind: 'text', text: 'Right', x: 60 })
    const left = await ok('layer.create', { kind: 'text', text: 'Left', x: -60 })
    const made = await ok('layers.group', { ids: [pill.id, right.id, left.id], name: 'Button', layout: { flow: 'row', alignY: 'center' } })
    expect(made.background).toMatch(/Pill/)
    expect(lanes()).toEqual(['Button', `Left@${made.groupId}`, `Right@${made.groupId}`])
    const group = layer(made.groupId)
    if (group.kind !== 'group') throw new Error('not a group')
    expect(group.layout).toMatchObject({ flow: 'row', gap: 20, x: -200, y: -50, padding: { top: 30, right: 90, bottom: 30, left: 90 } })
    expect(group.fills).toMatchObject([{ color: '#222222' }])
    expect(group.cornerRadius).toBe(50)
  })

  it('changes a layout by merging, and turns it off only where it can measure', async () => {
    const { ok, fail, layer } = setup()
    const a = await ok('layer.create', { kind: 'shape', name: 'A' })
    const { groupId } = await ok('layers.group', { ids: [a.id], layout: { flow: 'column', gap: 8 } })
    await ok('layout.set', { id: groupId, layout: { padding: 12, alignX: 'center' } })
    expect((layer(groupId) as Extract<Layer, { kind: 'group' }>).layout).toMatchObject({
      flow: 'column',
      gap: 8,
      alignX: 'center',
      padding: { top: 12, right: 12, bottom: 12, left: 12 },
    })
    expect(await fail('layout.set', { id: groupId, layout: null })).toMatch(/measure/)
    expect(await fail('layout.set', { id: a.id, layout: {} })).toMatch(/not a group/)
  })

  it('reports a broken group structure in a project file', () => {
    const project = ProjectSchema.parse({
      version: 1,
      id: 'p',
      name: 'P',
      comps: [{ id: 'c', name: 'C', width: 100, height: 100, fps: 30, durationMs: 1000, tracks: [{ id: 't', groupId: 'missing', layers: [] }] }],
    })
    expect(groupStructureProblem(project.comps[0] as Comp)).toMatch(/not in the comp/)
  })
})
