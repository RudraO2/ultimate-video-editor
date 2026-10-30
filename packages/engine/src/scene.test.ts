import { type Comp, createDefaultProject, type Layer, sequentialIds, Session } from '@uve/core'
import { describe, expect, it } from 'vitest'
import type { Ctx2D } from './content'
import { buildScene, flattenScene, nodeBounds, placementsOf, type SceneNode } from './scene'

// Text is 10 px per character in this stand-in for a canvas.
const measure = {
  font: '',
  letterSpacing: '',
  textAlign: 'left',
  textBaseline: 'alphabetic',
  measureText: (text: string) => ({ width: text.length * 10 }),
} as unknown as Ctx2D

function setup() {
  const ids = sequentialIds()
  const session = new Session({ project: createDefaultProject(ids), ids })
  const comp = () => session.project.comps[0] as Comp
  const scene = (t = 0) => buildScene(comp(), { measure, media: [] }, t)
  session.measure = (c, t) => placementsOf(buildScene(c, { measure, media: [] }, t))
  // biome-ignore lint/suspicious/noExplicitAny: test results are checked field by field
  const ok = async (name: string, input: unknown = {}): Promise<any> => {
    const result = await session.call(name, input)
    if (!result.ok) throw new Error(`${name} failed: ${result.error}`)
    return result.value
  }
  const layer = (id: string) => comp().tracks.flatMap((t) => t.layers).find((l) => l.id === id) as Layer
  const find = (id: string, t = 0) => flattenScene(scene(t)).find((n) => n.layer.id === id) as SceneNode
  return { session, ok, comp, scene, layer, find }
}

const rounded = (r: { left: number; top: number; width: number; height: number }) =>
  Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round(v * 1000) / 1000]))

describe('scene: groups', () => {
  it("moves, turns and fades members as one, around the group's box", async () => {
    const { ok, find } = setup()
    const a = await ok('layer.create', { kind: 'shape', width: 100, height: 100, x: -100 })
    const b = await ok('layer.create', { kind: 'shape', width: 100, height: 100, x: 100 })
    const { groupId } = await ok('layers.group', { ids: [a.id, b.id] })
    expect(rounded(nodeBounds(find(groupId)))).toEqual({ left: -150, top: -50, width: 300, height: 100 })
    await ok('layer.set', { id: groupId, values: { x: 30, rotation: 90 } })
    // Turned a quarter around the box centre (0, 0) and moved right: A goes from left to top.
    expect(rounded(nodeBounds(find(a.id)))).toEqual({ left: -20, top: -150, width: 100, height: 100 })
  })

  it('shows members only inside the group window and its visible lanes', async () => {
    const { ok, scene, comp, session } = setup()
    const a = await ok('layer.create', { kind: 'shape', durationMs: 4000 })
    const { groupId } = await ok('layers.group', { ids: [a.id] })
    await ok('timeline.trim', { id: groupId, endMs: 1000 })
    expect(flattenScene(scene(500)).map((n) => n.layer.id)).toEqual([groupId, a.id])
    expect(flattenScene(scene(2000))).toEqual([])
    const lane = comp().tracks.find((t) => t.layers[0]?.id === groupId)
    await session.call('track.update', { id: lane?.id, hidden: true })
    expect(scene(500)).toEqual([])
  })

  it('arranges a column with gap and padding, and stretches a member that fills', async () => {
    const { ok, find } = setup()
    const title = await ok('layer.create', { kind: 'text', text: 'Title text', style: { fontSize: 40, lineHeight: 1 } })
    const sub = await ok('layer.create', { kind: 'text', text: 'Sub', style: { fontSize: 20, lineHeight: 1 } })
    const bar = await ok('layer.create', { kind: 'shape', width: 10, height: 4 })
    // All three are centred at y 0, so sorted by their top edges the tallest comes first: title, sub, bar.
    const { groupId } = await ok('layers.group', {
      ids: [title.id, sub.id, bar.id],
      layout: { flow: 'column', gap: 10, padding: 20, x: -400, y: -300 },
    })
    await ok('layer.patch', { id: bar.id, ops: [{ op: 'set', path: 'layoutItem.fillX', value: true }] })
    const group = find(groupId)
    // Widest member: "Title text" is 100 px; the bar stretches to it.
    expect(rounded(nodeBounds(group))).toEqual({ left: -400, top: -300, width: 140, height: 124 })
    const order = [title.id, sub.id, bar.id]
    expect(order.map((id) => rounded(nodeBounds(find(id))).top)).toEqual([-280, -230, -200])
    expect(rounded(nodeBounds(find(bar.id)))).toMatchObject({ left: -380, width: 100 })
  })

  it('draws a container from the group paints at the layout box', async () => {
    const { ok, find } = setup()
    const label = await ok('layer.create', { kind: 'text', text: 'Go', style: { fontSize: 20, lineHeight: 1 } })
    const { groupId } = await ok('layers.group', { ids: [label.id], layout: { flow: 'row', padding: { left: 16, right: 16, top: 8, bottom: 8 } } })
    await ok('layer.patch', { id: groupId, ops: [{ op: 'insert', path: 'fills[-]', value: { type: 'solid', color: '#ff3366' } }] })
    const group = find(groupId)
    if (group.kind !== 'group') throw new Error('not a group')
    expect(group.container?.box).toEqual({ width: 52, height: 36 })
  })

  it('ungroups a layout without moving anything, and keeps the container as a rectangle', async () => {
    const { ok, find, layer, comp } = setup()
    const a = await ok('layer.create', { kind: 'shape', width: 50, height: 20, x: 300 })
    const b = await ok('layer.create', { kind: 'shape', width: 80, height: 20, x: -300 })
    const { groupId } = await ok('layers.group', { ids: [a.id, b.id], layout: { flow: 'row', gap: 12, x: 0, y: 0 } })
    await ok('layer.patch', { id: groupId, ops: [{ op: 'insert', path: 'fills[-]', value: { type: 'solid', color: '#000000' } }] })
    const before = [a.id, b.id].map((id) => rounded(nodeBounds(find(id))))
    expect(before.map((r) => r.left)).toEqual([92, 0])
    await ok('layers.ungroup', { ids: groupId })
    expect([a.id, b.id].map((id) => rounded(nodeBounds(find(id))))).toEqual(before)
    const rect = comp().tracks.flatMap((t) => t.layers).find((l) => l.name === 'Group background')
    expect(rect && rounded(nodeBounds(find(rect.id)))).toEqual({ left: 0, top: 0, width: 142, height: 20 })
    expect(layer(a.id).transform.x).toBe(117)
  })

  it('bakes a turned group into its members', async () => {
    const { ok, find } = setup()
    const a = await ok('layer.create', { kind: 'shape', width: 100, height: 50, x: 100 })
    const { groupId } = await ok('layers.group', { ids: [a.id] })
    await ok('layer.set', { id: groupId, values: { rotation: 30, x: 20, opacity: 0.5 } })
    const before = rounded(nodeBounds(find(a.id)))
    await ok('layers.ungroup', { ids: groupId })
    expect(rounded(nodeBounds(find(a.id)))).toEqual(before)
  })

  it('centres a path on the box around its resting outline, even while it morphs', async () => {
    const { ok, find } = setup()
    const path = await ok('layer.create', { kind: 'path', d: 'M100 100 L300 100 L300 200 Z', x: 50, y: -20 })
    expect(rounded(nodeBounds(find(path.id)))).toEqual({ left: -50, top: -70, width: 200, height: 100 })
    await ok('keyframes.set', { id: path.id, property: 'geometry', keys: [{ at: 0, value: 'M100 100 L300 100 L300 200 Z' }, { at: 1000, value: 'M0 0 L300 100 L300 200 Z' }] })
    // The box stays the resting outline's, so the pivot does not drift.
    expect(rounded(nodeBounds(find(path.id, 500)))).toEqual({ left: -50, top: -70, width: 200, height: 100 })
  })

  it('marks the cutters of a mask group: stencils, or else the front-most member', async () => {
    const { ok, find } = setup()
    const photo = await ok('layer.create', { kind: 'shape', name: 'Photo', width: 400, height: 300 })
    const hole = await ok('layer.create', { kind: 'shape', name: 'Hole', shape: 'ellipse', width: 200, height: 200 })
    const { groupId } = await ok('layers.group', { ids: [photo.id, hole.id], mode: 'mask' })
    expect(find(hole.id).stencil).toBe(true)
    expect(find(photo.id).stencil).toBeUndefined()
    await ok('layer.patch', { id: photo.id, ops: [{ op: 'set', path: 'isStencil', value: true }] })
    expect([find(photo.id).stencil, find(hole.id).stencil]).toEqual([true, undefined])
    await ok('layer.patch', { id: groupId, ops: [{ op: 'set', path: 'mode', value: 'pass' }] })
    expect(find(photo.id).stencil).toBeUndefined()
  })
})
