import { blinkAt, blinkWindows, type Comp, createDefaultProject, type Layer, sequentialIds, Session } from '@uve/core'
import { describe, expect, it } from 'vitest'
import { behaviourSeed } from './character'
import type { Ctx2D } from './content'
import { buildScene, flattenScene, nodeBounds, type SceneNode } from './scene'

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
  // The voice's loudness is traced in the app; here a test sets it on the media.
  let envelope: { rate: number; values: number[] } | undefined
  const media = () => session.project.media.map((m) => (envelope ? { ...m, envelope } : m))
  const scene = (t = 0) => buildScene(comp(), { measure, media: media() }, t)
  // biome-ignore lint/suspicious/noExplicitAny: test results are checked field by field
  const ok = async (name: string, input: unknown = {}): Promise<any> => {
    const result = await session.call(name, input)
    if (!result.ok) throw new Error(`${name} failed: ${result.error}`)
    return result.value
  }
  const find = (id: string, t = 0) => flattenScene(scene(t)).find((n) => n.layer.id === id) as SceneNode | undefined
  const shape = async (name: string, width: number, height: number, x = 0, y = 0): Promise<string> => (await ok('layer.create', { kind: 'shape', name, width, height, x, y })).id
  const layer = (id: string) => comp().tracks.flatMap((t) => t.layers).find((l) => l.id === id) as Layer
  return { session, ok, comp, scene, find, shape, layer, setEnvelope: (e: typeof envelope) => (envelope = e) }
}

const round = (n: number) => Math.round(n * 1000) / 1000
const box = (n: SceneNode | undefined) => {
  const b = nodeBounds(n as SceneNode)
  return { left: round(b.left), top: round(b.top), width: round(b.width), height: round(b.height) }
}

describe('switch', () => {
  async function mouth() {
    const s = setup()
    const a = await s.shape('A', 40, 40, -100, 0)
    const b = await s.shape('B', 60, 20, 0, 0)
    const c = await s.shape('C', 20, 80, 100, 0)
    const { switchId, members } = await s.ok('switch.create', { ids: [a, b, c], name: 'Mouth' })
    // Members count from the top: the layer made last is in front.
    const m = (members as { id: string }[]).map((x) => x.id)
    return { ...s, a, b, c, switchId, m }
  }
  const shown = (s: Awaited<ReturnType<typeof mouth>>, t = 0) => flattenScene(s.scene(t)).map((n) => n.layer.id).filter((id) => [s.a, s.b, s.c].includes(id))

  it('shows only the chosen member and keeps the union box', async () => {
    const s = await mouth()
    expect(shown(s)).toEqual([s.m[0]])
    const union = box(s.find(s.switchId))
    await s.ok('switch.show', { id: s.switchId, show: 2 })
    expect(shown(s)).toEqual([s.m[2]])
    expect(box(s.find(s.switchId))).toEqual(union)
    expect(union).toEqual({ left: -120, top: -40, width: 230, height: 80 })
    await s.ok('switch.show', { id: s.switchId, show: 1 })
    expect(shown(s)).toEqual([s.m[1]])
  })

  it('clamps a value past the last member', async () => {
    const s = await mouth()
    await s.ok('layer.set', { id: s.switchId, values: { switch: 9 } })
    expect(shown(s)).toEqual([s.m[2]])
  })

  it('holds a keyed switch until the next key', async () => {
    const s = await mouth()
    await s.ok('switch.show', { id: s.switchId, show: 0, key: true, atMs: 0 })
    await s.ok('switch.show', { id: s.switchId, show: 2, key: true, atMs: 1000 })
    expect(shown(s, 100)).toEqual([s.m[0]])
    expect(shown(s, 900)).toEqual([s.m[0]])
    expect(shown(s, 1500)).toEqual([s.m[2]])
  })
})

describe('rig', () => {
  it('moves a member with the bone it rides', async () => {
    const s = setup()
    const arm = await s.shape('Arm', 100, 20, 50, 0)
    const { rigId } = await s.ok('rig.create', { ids: [arm], bones: [{ name: 'Arm', head: [0, 0], tail: [100, 0] }] })
    expect(box(s.find(arm))).toEqual({ left: 0, top: -10, width: 100, height: 20 })
    await s.ok('rig.pose', { rigId, key: false, poses: [{ bone: 'Arm', rotation: 90 }] })
    // A quarter turn clockwise about the head (0, 0): the arm points down.
    expect(box(s.find(arm))).toEqual({ left: -10, top: 0, width: 20, height: 100 })
    // The group's box (its pivot) does not move with the pose.
    await s.ok('rig.pose', { rigId, reset: true })
    expect(box(s.find(arm))).toEqual({ left: 0, top: -10, width: 100, height: 20 })
  })

  it('reads keyed bone poses and a child bone carries its own piece', async () => {
    const s = setup()
    const upper = await s.shape('Upper', 100, 20, 50, 0)
    const lower = await s.shape('Lower', 100, 20, 150, 0)
    const { rigId } = await s.ok('rig.create', {
      ids: [upper, lower],
      bones: [
        { name: 'Upper', head: [0, 0], tail: [100, 0] },
        { name: 'Lower', head: [100, 0], tail: [200, 0] },
      ],
    })
    await s.ok('rig.pose', { rigId, key: true, atMs: 1000, poses: [{ bone: 'Upper', rotation: 90 }] })
    expect(box(s.find(upper, 1000))).toEqual({ left: -10, top: 0, width: 20, height: 100 })
    expect(box(s.find(lower, 1000))).toEqual({ left: -10, top: 100, width: 20, height: 100 })
  })

  it('leaves a member with bind none where it is', async () => {
    const s = setup()
    const arm = await s.shape('Arm', 100, 20, 50, 0)
    const { rigId } = await s.ok('rig.create', { ids: [arm], bones: [{ name: 'Arm', head: [0, 0], tail: [100, 0] }] })
    await s.ok('rig.bind', { ids: arm, mode: 'none' })
    await s.ok('rig.pose', { rigId, key: false, poses: [{ bone: 'Arm', rotation: 90 }] })
    expect(box(s.find(arm))).toEqual({ left: 0, top: -10, width: 100, height: 20 })
  })
})

describe('behaviours', () => {
  it('blink squashes an eye only inside blink windows', async () => {
    const s = setup()
    const eye = await s.shape('Eye', 40, 40, 0, 0)
    const head = await s.shape('Head', 200, 200, 0, 0)
    const { groupId } = await s.ok('layers.group', { ids: [eye, head], name: 'Mia' })
    const { behavior } = await s.ok('behaviors.add', { groupId, type: 'blink', fields: { eyes: [eye], every: 1 } })
    const params = { every: behavior.every, closedMs: behavior.closedMs, variance: behavior.variance, doubles: behavior.doubles, seed: behaviourSeed(groupId, behavior.id, behavior.seed) }
    const windows = blinkWindows(params, 6000)
    expect(windows.length).toBeGreaterThan(2)
    const w = windows[1] as { startMs: number; endMs: number }
    const shut = (w.startMs + w.endMs) / 2
    expect(blinkAt(params, shut)).toBe(1)
    expect(box(s.find(eye, shut)).height).toBeCloseTo(40 * behavior.closedScale, 3)
    // Centre stays: the squash is about the eye's centre.
    expect(box(s.find(eye, shut)).top).toBeCloseTo(-2, 3)
    const open = windows.reduce((t, win) => (t >= win.startMs && t < win.endMs ? win.endMs + 1 : t), 0)
    expect(blinkAt(params, open)).toBe(0)
    expect(box(s.find(eye, open)).height).toBe(40)
    // The head is never squashed.
    expect(box(s.find(head, shut)).height).toBe(200)
  })

  it('blink on an eye switch shows the closed member, and half when there is one', async () => {
    const s = setup()
    const half = await s.shape('Half', 40, 20)
    const closed = await s.shape('Eyes Closed', 40, 4)
    const open = await s.shape('Eyes Open', 40, 40)
    const { switchId } = await s.ok('switch.create', { ids: [open, half, closed], name: 'Eyes' })
    const head = await s.shape('Head', 200, 200)
    const { groupId } = await s.ok('layers.group', { ids: [switchId, head], name: 'Mia' })
    const { behavior } = await s.ok('behaviors.add', { groupId, type: 'blink', fields: { eyes: [switchId], every: 1, variance: 0, doubles: 0 } })
    const params = { every: 1, closedMs: behavior.closedMs, variance: 0, doubles: 0, seed: behaviourSeed(groupId, behavior.id, behavior.seed) }
    const w = blinkWindows(params, 3000)[0] as { startMs: number; endMs: number }
    const shownAt = (t: number) => flattenScene(s.scene(t)).map((n) => n.layer.id).filter((id) => [open, half, closed].includes(id))
    expect(shownAt(w.startMs - 5)).toEqual([open])
    expect(shownAt((w.startMs + w.endMs) / 2)).toEqual([closed])
    expect(blinkAt(params, w.startMs + 1)).toBe(0.5)
    expect(shownAt(w.startMs + 1)).toEqual([half])
    expect(shownAt(w.endMs + 5)).toEqual([open])
  })

  it('breathe keeps the bottom edge fixed', async () => {
    const s = setup()
    const body = await s.shape('Body', 100, 200, 0, 0)
    const other = await s.shape('Other', 20, 20, 300, 0)
    const { groupId } = await s.ok('layers.group', { ids: [body, other], name: 'Mia' })
    await s.ok('behaviors.add', { groupId, type: 'breathe', fields: { layer: body, amount: 10, rate: 60, phase: 0 } })
    const rest = box(s.find(body, 0))
    const full = box(s.find(body, 500))
    expect(rest).toEqual({ left: -50, top: -100, width: 100, height: 200 })
    expect(full.top + full.height).toBeCloseTo(100, 3)
    expect(full.height).toBeCloseTo(220, 3)
    expect(full.width).toBe(100)
  })

  it('breathe on a bone swells the piece along the bone', async () => {
    const s = setup()
    const torso = await s.shape('Torso', 20, 100, 0, -50)
    const { rigId } = await s.ok('rig.create', { ids: [torso], bones: [{ name: 'Spine', head: [0, 0], tail: [0, -100] }] })
    await s.ok('behaviors.add', { groupId: rigId, type: 'breathe', fields: { bone: 'Spine', amount: 10, rate: 60 } })
    const full = box(s.find(torso, 500))
    // Stretched about the head (the bottom): the base stays at 0.
    expect(full.top + full.height).toBeCloseTo(0, 3)
    expect(full.height).toBeCloseTo(110, 3)
  })

  it('glance moves the pupils by the same offset', async () => {
    const s = setup()
    const left = await s.shape('L', 10, 10, -30, 0)
    const right = await s.shape('R', 10, 10, 30, 0)
    const head = await s.shape('Head', 100, 100)
    const { groupId } = await s.ok('layers.group', { ids: [left, right, head], name: 'Mia' })
    await s.ok('behaviors.add', { groupId, type: 'glance', fields: { layers: [left, right], hold: 0.5, centre: 0 } })
    let moved = 0
    for (let t = 0; t < 5000; t += 250) {
      const l = box(s.find(left, t))
      const r = box(s.find(right, t))
      expect(r.left - l.left).toBeCloseTo(60, 3)
      expect(r.top).toBeCloseTo(l.top, 3)
      if (l.left !== -35) moved++
    }
    expect(moved).toBeGreaterThan(3)
  })

  it('talk picks mouth members from the envelope of a voice on an audio layer', async () => {
    const s = setup()
    const names = ['Rest', 'E', 'AI', 'O', 'U', 'MBP']
    const ids: string[] = []
    for (const n of names) ids.push(await s.shape(n, 40, 20))
    const { switchId } = await s.ok('switch.create', { ids, name: 'Mouth' })
    const head = await s.shape('Head', 200, 200)
    const { groupId } = await s.ok('layers.group', { ids: [switchId, head], name: 'Mia' })
    await s.ok('behaviors.add', { groupId, type: 'talk', fields: { mouth: switchId } })
    const media = await s.ok('media.add', { kind: 'audio', name: 'voice.wav', path: 'C:/voice.wav', durationMs: 3000 })
    await s.ok('layer.create', { kind: 'audio', mediaId: media.id, durationMs: 3000 })
    // Loud for the first second (a few syllables), then silent.
    const values = Array.from({ length: 150 }, (_, i) => (i < 50 ? (i % 12 < 8 ? 0.8 : 0.2) : 0))
    s.setEnvelope({ rate: 50, values })
    const shownAt = (t: number) => flattenScene(s.scene(t)).map((n) => n.layer.id).filter((id) => ids.includes(id))
    const seen = new Set<string>()
    for (let t = 0; t < 1000; t += 40) for (const id of shownAt(t)) seen.add(id)
    expect(seen.size).toBeGreaterThan(1)
    // Silent: the rest mouth.
    expect(shownAt(2000)).toEqual([ids[0]])
    // Loud: something other than the rest mouth.
    expect(seen.has(ids[2] as string) || seen.has(ids[3] as string)).toBe(true)
    // With no envelope there is no voice, so the rest mouth.
    s.setEnvelope(undefined)
    expect(shownAt(500)).toEqual([ids[0]])
  })

  it('nod turns a bone with the loudness', async () => {
    const s = setup()
    const head = await s.shape('Head', 20, 100, 0, -50)
    const { rigId } = await s.ok('rig.create', { ids: [head], bones: [{ name: 'Neck', head: [0, 0], tail: [0, -100] }] })
    await s.ok('behaviors.add', { groupId: rigId, type: 'nod', fields: { bone: 'Neck', amount: 90 } })
    const media = await s.ok('media.add', { kind: 'audio', name: 'voice.wav', path: 'C:/voice.wav', durationMs: 3000 })
    await s.ok('layer.create', { kind: 'audio', mediaId: media.id, durationMs: 3000 })
    s.setEnvelope({ rate: 50, values: Array.from({ length: 150 }, (_, i) => (i < 50 ? 1 : 0)) })
    // Full loudness turns the neck 90 degrees clockwise about its head: the piece lies to the right.
    expect(box(s.find(head, 500))).toEqual({ left: 0, top: -10, width: 100, height: 20 })
    expect(box(s.find(head, 2000))).toEqual({ left: -10, top: -100, width: 20, height: 100 })
  })

  it('draws the same frame twice, and in any order of times', async () => {
    const s = setup()
    const eye = await s.shape('Eye', 40, 40, -20, -20)
    const pupil = await s.shape('Pupil', 10, 10, -20, -20)
    const body = await s.shape('Body', 100, 200, 0, 60)
    const { groupId } = await s.ok('layers.group', { ids: [eye, pupil, body], name: 'Mia' })
    await s.ok('behaviors.add', { groupId, type: 'blink', fields: { eyes: [eye], every: 1 } })
    await s.ok('behaviors.add', { groupId, type: 'glance', fields: { layers: [pupil], hold: 0.4 } })
    await s.ok('behaviors.add', { groupId, type: 'breathe', fields: { layer: body } })
    await s.ok('behaviors.add', { groupId, type: 'sway', fields: { layer: body, amount: 10 } })
    const matrices = (t: number) => JSON.stringify(flattenScene(s.scene(t)).map((n) => [n.layer.id, n.matrix]))
    const first = matrices(3210)
    expect(matrices(3210)).toBe(first)
    matrices(9000)
    matrices(100)
    expect(matrices(3210)).toBe(first)
    expect(matrices(100)).not.toBe(first)
  })

  it('ignores a disabled behaviour', async () => {
    const s = setup()
    const body = await s.shape('Body', 100, 200)
    const other = await s.shape('Other', 20, 20, 300, 0)
    const { groupId } = await s.ok('layers.group', { ids: [body, other], name: 'Mia' })
    const { behavior } = await s.ok('behaviors.add', { groupId, type: 'breathe', fields: { layer: body, amount: 10, rate: 60 } })
    await s.ok('behaviors.update', { groupId, id: behavior.id, enabled: false })
    expect(box(s.find(body, 500)).height).toBe(200)
  })
})
