import { describe, expect, it } from 'vitest'
import { deepClone } from './clone'
import { createDefaultProject } from './doc'
import { sequentialIds } from './ids'
import { readProjectFile, writeProjectFile } from './projectFile'
import type { Comp, Layer } from './schema'
import { Session } from './session'
import { type Vec3, type WorldMat4, lookAtRotation, mat4Invert, mat4Multiply, worldCoresAt, worldMatrix, worldObjects } from './world'
import { hasWorldPath, worldPathTimes } from './worldPath'

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
    return { error: result.error, hint: result.hint ?? '' }
  }
  const comp = (id: string) => session.project.comps.find((c) => c.id === id) as Comp
  const layer = (compId: string, id: string) => comp(compId).tracks.flatMap((t) => t.layers).find((l) => l.id === id) as Layer
  const world = async (durationMs = 4000) => (await ok('world.create', { starter: false, durationMs })).frameId as string
  const add = async (compId: string, kind: string, position: Vec3, extra: Record<string, unknown> = {}): Promise<string> =>
    (await ok('world.add', { compId, kind, position, ...extra })).id
  const keyAxis = (id: string, path: string, from: number, to: number, toAt = 1000) =>
    ok('keyframes.set', { id, path, keys: [{ t: 0, v: from, ease: 'linear' }, { t: toAt, v: to, ease: 'linear' }] })
  const at = (compId: string, id: string, timeMs: number, box?: { width: number; height: number }) => {
    const found = worldObjects(comp(compId), timeMs, box ? { box: () => box } : {}).find((o) => o.layer.id === id)
    if (!found) throw new Error(`${id} is not standing at ${timeMs}`)
    return found
  }
  return { session, ok, fail, comp, layer, world, add, keyAxis, at }
}

const close = (a: readonly number[], b: readonly number[], digits = 6) => {
  expect(a).toHaveLength(b.length)
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i] as number, digits))
}

const mul = (...ms: WorldMat4[]) => ms.reduce((a, b) => mat4Multiply(a, b))
const inv = (m: WorldMat4) => mat4Invert(m) as WorldMat4

describe('world.track: lookAt', () => {
  it('turns a camera, a mesh and a text plane exactly as lookAtRotation says, keeping position and scale', async () => {
    const s = setup()
    const w = await s.world()
    const target: Vec3 = [50, 40, -90]
    const goal = await s.add(w, 'controller', target)
    const box = { width: 300, height: 90 }
    const made = {
      camera: await s.add(w, 'camera', [100, -500, 200]),
      mesh: await s.add(w, 'mesh', [300, 100, 50], { scale: [2, 1, 3] }),
      text: await s.add(w, 'text', [-200, 300, 100], { text: 'Hello' }),
    }
    await s.ok('layer.patch', { id: made.text, ops: [{ op: 'set', path: 'transform.anchorX', value: 0.2 }] })
    for (const id of Object.values(made)) await s.ok('world.track', { id, lookAt: goal })
    for (const [kind, id] of Object.entries(made)) {
      const before = s.layer(w, id)
      const t = before.transform
      const aim = lookAtRotation([t.x, t.y, t.z], target, before.kind)
      const expected = worldMatrix({ kind: before.kind, transform: { ...t, ...aim } }, kind === 'text' ? box : null)
      const got = s.at(w, id, 0, kind === 'text' ? box : undefined)
      close(got.matrix, expected)
      close(got.position, got.matrix.slice(12, 15))
      expect(got.correction).toBeDefined()
    }
  })

  it('keeps aiming as the target moves', async () => {
    const s = setup()
    const w = await s.world()
    const goal = await s.add(w, 'controller', [0, 0, 0])
    const eye = await s.add(w, 'camera', [0, -800, 100])
    await s.keyAxis(goal, 'transform.x', -300, 300)
    await s.ok('world.track', { id: eye, lookAt: goal })
    for (const ms of [0, 250, 1000, 1500]) {
      const x = Math.max(-300, Math.min(300, -300 + (600 * ms) / 1000))
      const aim = lookAtRotation([0, -800, 100], [x, 0, 0], 'camera')
      const expected = worldMatrix({ kind: 'camera', transform: { ...s.layer(w, eye).transform, ...aim } }, null)
      close(s.at(w, eye, ms).matrix, expected)
    }
  })

  it('leaves the layer alone when the target sits on it', async () => {
    const s = setup()
    const w = await s.world()
    const goal = await s.add(w, 'controller', [10, 20, 30])
    const eye = await s.add(w, 'camera', [10, 20, 30], { rotation: [12, 0, 7] })
    await s.ok('world.track', { id: eye, lookAt: goal })
    const o = s.at(w, eye, 0)
    expect(o.rotation.rotationX).toBeCloseTo(12, 6)
    expect(o.correction).toBeUndefined()
  })
})

describe('world.track: follow', () => {
  it('reads the stored position as an offset from the target', async () => {
    const s = setup()
    const w = await s.world()
    const lead = await s.add(w, 'controller', [100, 0, 0])
    const rider = await s.add(w, 'mesh', [10, 20, 30])
    await s.keyAxis(lead, 'transform.x', 100, 300)
    await s.ok('world.track', { id: rider, follow: lead })
    close(s.at(w, rider, 0).position, [110, 20, 30])
    close(s.at(w, rider, 500).position, [210, 20, 30])
    close(s.at(w, rider, 1000).position, [310, 20, 30])
    // The stored fields did not change.
    expect(s.layer(w, rider).transform).toMatchObject({ x: 10, y: 20, z: 30 })
  })

  it('turns with the target when followRotation is on', async () => {
    const s = setup()
    const w = await s.world()
    const lead = await s.add(w, 'controller', [100, 0, 0], { rotation: [0, 0, 90] })
    const plain = await s.add(w, 'mesh', [10, 0, 0])
    const turning = await s.add(w, 'mesh', [10, 0, 0])
    await s.ok('world.track', { id: plain, follow: lead })
    await s.ok('world.track', { id: turning, follow: lead, followRotation: true })
    close(s.at(w, plain, 0).position, [110, 0, 0])
    expect(s.at(w, plain, 0).rotation.rotation).toBeCloseTo(0, 6)
    close(s.at(w, turning, 0).position, [100, 10, 0])
    expect(s.at(w, turning, 0).rotation.rotation).toBeCloseTo(90, 6)
  })
})

describe('world.track: childOf', () => {
  it('stays where it is at atMs, then rides the parent’s move, turn and scale', async () => {
    const s = setup()
    const w = await s.world()
    const parent = await s.add(w, 'controller', [50, -20, 10], { rotation: [0, 0, 15], scale: 1.5 })
    const child = await s.add(w, 'mesh', [200, 100, 40], { rotation: [10, 20, 30] })
    await s.keyAxis(parent, 'transform.x', 50, 350)
    await s.keyAxis(parent, 'transform.rotation', 15, 105)
    await s.keyAxis(parent, 'transform.scaleX', 1.5, 3)
    const before = s.at(w, child, 0).matrix
    const bound = await s.ok('world.track', { id: child, childOf: parent, atMs: 0 })
    expect(bound.constraints).toHaveLength(1)
    expect(s.layer(w, child).constraints?.[0]).toMatchObject({ type: 'childOf', targetId: parent, enabled: true, influence: 1 })
    close(s.at(w, child, 0).matrix, before)
    for (const ms of [250, 1000]) {
      const expected = mul(s.at(w, parent, ms).matrix, inv(s.at(w, parent, 0).matrix), before)
      close(s.at(w, child, ms).matrix, expected)
    }
  })

  it('binds at the playhead when the frame is open, so it stays put there', async () => {
    const s = setup()
    const w = await s.world()
    const parent = await s.add(w, 'controller', [0, 0, 0])
    const child = await s.add(w, 'mesh', [100, 0, 0])
    await s.keyAxis(parent, 'transform.z', 0, 200)
    s.session.view = () => ({ compId: w, playheadMs: 500 })
    await s.ok('world.track', { id: child, childOf: parent })
    close(s.at(w, child, 500).position, [100, 0, 0])
    close(s.at(w, child, 1000).position, [100, 0, 100])
  })

  it('chains controller, arm and hand, whatever order they are listed in', async () => {
    const s = setup()
    const w = await s.world()
    // Created back to front: the hand's lane is processed before the arm's, the arm's before the controller's.
    const controller = await s.add(w, 'controller', [0, 0, 0])
    const arm = await s.add(w, 'controller', [0, 0, 100])
    const hand = await s.add(w, 'mesh', [20, 0, 160])
    await s.keyAxis(controller, 'transform.x', 0, 200)
    await s.keyAxis(controller, 'transform.rotation', 0, 90)
    await s.ok('world.track', { id: hand, childOf: arm, atMs: 500 })
    await s.ok('world.track', { id: arm, childOf: controller, atMs: 500 })
    const handBefore = s.at(w, hand, 500)
    const armBefore = s.at(w, arm, 500)
    const delta = (ms: number) => mul(s.at(w, controller, ms).matrix, inv(s.at(w, controller, 500).matrix))
    const unconstrained = (id: string) => worldMatrix(s.layer(w, id), null)
    close(handBefore.matrix, unconstrained(hand))
    for (const ms of [0, 500, 1000]) {
      close(s.at(w, arm, ms).matrix, mul(delta(ms), unconstrained(arm)))
      close(s.at(w, hand, ms).matrix, mul(delta(ms), unconstrained(hand)))
    }
    expect(armBefore.correction).toBeUndefined()
  })
})

describe('world.track: influence, enabled, removal', () => {
  it('blends position at influence 0.5 and rotation along the shortest turn', async () => {
    const s = setup()
    const w = await s.world()
    const lead = await s.add(w, 'controller', [100, 0, 0])
    const rider = await s.add(w, 'controller', [0, 0, 0])
    const aimer = await s.add(w, 'controller', [0, 0, 0])
    const made = await s.ok('world.track', { id: rider, follow: lead })
    await s.ok('world.track', { id: aimer, lookAt: lead })
    const full = s.at(w, aimer, 0).rotation.rotation
    expect(Math.abs(full)).toBeGreaterThan(10)

    const [follow] = made.constraints
    await s.ok('layer.patch', { id: rider, ops: [{ op: 'set', path: `constraints[id=${follow.id}].influence`, value: 0.5 }] })
    close(s.at(w, rider, 0).position, [50, 0, 0])
    const look = s.layer(w, aimer).constraints?.[0]
    await s.ok('layer.patch', { id: aimer, ops: [{ op: 'set', path: `constraints[id=${look?.id}].influence`, value: 0.5 }] })
    expect(s.at(w, aimer, 0).rotation.rotation).toBeCloseTo(full / 2, 6)

    await s.ok('layer.patch', { id: rider, ops: [{ op: 'set', path: `constraints[id=${follow.id}].enabled`, value: false }] })
    close(s.at(w, rider, 0).position, [0, 0, 0])
    await s.ok('layer.patch', { id: rider, ops: [{ op: 'set', path: `constraints[id=${follow.id}].influence`, value: 0 }, { op: 'set', path: `constraints[id=${follow.id}].enabled`, value: true }] })
    close(s.at(w, rider, 0).position, [0, 0, 0])
  })

  it('replaces one kind, removes with null and keeps the others', async () => {
    const s = setup()
    const w = await s.world()
    const a = await s.add(w, 'controller', [100, 0, 0])
    const b = await s.add(w, 'controller', [0, 100, 0])
    const rider = await s.add(w, 'mesh', [0, 0, 0])
    const first = await s.ok('world.track', { id: rider, follow: a, lookAt: b })
    expect(first.constraints.map((c: { type: string }) => c.type)).toEqual(['lookAt', 'follow'])
    const second = await s.ok('world.track', { id: rider, follow: b })
    expect(second.constraints.map((c: { type: string; targetId: string }) => [c.type, c.targetId])).toEqual([
      ['lookAt', b],
      ['follow', b],
    ])
    expect(second.constraints[1].id).not.toBe(first.constraints[1].id)
    const cleared = await s.ok('world.track', { id: rider, follow: null })
    expect(cleared.constraints.map((c: { type: string }) => c.type)).toEqual(['lookAt'])
    await s.ok('world.track', { id: rider, lookAt: null })
    expect(s.layer(w, rider).constraints).toBeUndefined()
    // One undo step per call, labelled Track.
    expect(s.session.undoLabel).toBe('Track')
    expect(s.session.undo()).toBe(true)
    expect(s.layer(w, rider).constraints?.map((c) => c.type)).toEqual(['lookAt'])
  })
})

describe('world.track: groups', () => {
  it('carries the members of a constrained group, and members can have their own', async () => {
    const s = setup()
    const w = await s.world()
    const lift = await s.add(w, 'controller', [0, 0, 300])
    const sideways = await s.add(w, 'controller', [0, 50, 0])
    const a = await s.add(w, 'mesh', [100, 0, 0])
    const b = await s.add(w, 'mesh', [-100, 0, 0])
    const { groupId } = await s.ok('layers.group', { ids: [a, b], name: 'G' })
    const before = (id: string) => s.at(w, id, 0).matrix
    const [a0, b0] = [before(a), before(b)]
    await s.ok('world.track', { id: groupId, follow: lift })
    close(s.at(w, a, 0).position, [100, 0, 300])
    close(s.at(w, b, 0).position, [-100, 0, 300])
    await s.ok('world.track', { id: b, follow: sideways })
    close(s.at(w, b, 0).position, [-100, 50, 300])
    close(s.at(w, a, 0).position, [100, 0, 300])

    // final = correction · unconstrained, for the members as for the group.
    const bare = deepClone(s.comp(w)) as Comp
    for (const t of bare.tracks) for (const l of t.layers) delete l.constraints
    for (const id of [groupId, a, b]) {
      const o = s.at(w, id, 0)
      const base = worldObjects(bare, 0).find((x) => x.layer.id === id) as { matrix: WorldMat4 }
      expect(o.correction).toBeDefined()
      close(mul(o.correction as WorldMat4, base.matrix), o.matrix)
    }
    close(base0(bare, a), a0)
    close(base0(bare, b), b0)
  })
})

function base0(comp: Comp, id: string): WorldMat4 {
  return (worldObjects(comp, 0).find((x) => x.layer.id === id) as { matrix: WorldMat4 }).matrix
}

describe('world.track: refusals', () => {
  it('refuses a flat comp, nothing given, ik, a self target, another comp and a missing layer', async () => {
    const s = setup()
    const flat = await s.ok('layer.create', { kind: 'shape', shape: { type: 'rect', width: 10, height: 10 } })
    const flatOther = await s.ok('layer.create', { kind: 'shape', shape: { type: 'rect', width: 10, height: 10 }, name: 'Other' })
    expect((await s.fail('world.track', { id: flat.id, lookAt: flatOther.id })).error).toMatch(/is a flat comp, not a 3D world/)

    const w = await s.world()
    const w2 = await s.world()
    const a = await s.add(w, 'controller', [0, 0, 0])
    const elsewhere = await s.add(w2, 'controller', [0, 0, 0])
    expect((await s.fail('world.track', { id: a })).error).toMatch(/Nothing to track/)
    expect((await s.fail('world.track', { id: a, ik: { chain: 2 } })).error).toMatch(/IK is not in this build yet/)
    expect((await s.fail('world.track', { id: a, ik: { chain: 2 } })).hint).toMatch(/lookAt/)
    expect((await s.fail('world.track', { id: a, lookAt: a })).error).toMatch(/itself/)
    expect((await s.fail('world.track', { id: a, follow: elsewhere })).error).toMatch(/another comp/)
    expect((await s.fail('world.track', { id: a, followRotation: true })).error).toMatch(/Nothing to track/)
    expect((await s.fail('world.track', { id: a, lookAt: 'nope' })).error).toMatch(/No layer/)
    // An ik of null is not given: it only removes nothing.
    await s.ok('world.track', { id: a, lookAt: null, ik: null })
  })

  it('refuses a childOf loop through childOf or a group, and a target that is not there at atMs', async () => {
    const s = setup()
    const w = await s.world()
    const a = await s.add(w, 'controller', [0, 0, 0])
    const b = await s.add(w, 'controller', [100, 0, 0])
    const c = await s.add(w, 'controller', [200, 0, 0])
    await s.ok('world.track', { id: a, childOf: b, atMs: 0 })
    await s.ok('world.track', { id: b, childOf: c, atMs: 0 })
    const loop = await s.fail('world.track', { id: c, childOf: a, atMs: 0 })
    expect(loop.error).toMatch(/loop/)
    // Following is not a loop: the position is only read.
    await s.ok('world.track', { id: c, follow: a })

    const m = await s.add(w, 'mesh', [0, 0, 0])
    const { groupId } = await s.ok('layers.group', { ids: [m], name: 'G' })
    expect((await s.fail('world.track', { id: m, childOf: groupId, atMs: 0 })).error).toMatch(/loop/)

    const late = await s.add(w, 'controller', [0, 0, 0], { startMs: 2000, durationMs: 1000 })
    const refused = await s.fail('world.track', { id: a, childOf: late, atMs: 500 })
    expect(refused.error).toMatch(/not on the timeline at 500 ms/)
    // The target of a lookAt is read live, so it needs no moment.
    await s.ok('world.track', { id: a, lookAt: late })
    expect(s.layer(w, a).constraints?.map((k) => k.type)).toEqual(['childOf', 'lookAt'])
  })

  it('ignores a constraint whose target is gone at that time, and one on a cycle written by hand', async () => {
    const s = setup()
    const w = await s.world()
    const late = await s.add(w, 'controller', [500, 0, 0], { startMs: 2000, durationMs: 1000 })
    const rider = await s.add(w, 'mesh', [10, 0, 0])
    await s.ok('world.track', { id: rider, follow: late })
    close(s.at(w, rider, 100).position, [10, 0, 0])
    close(s.at(w, rider, 2500).position, [510, 0, 0])

    const x = await s.add(w, 'mesh', [0, 0, 0])
    const y = await s.add(w, 'mesh', [100, 0, 0])
    const cx = { id: 'hand_x', type: 'childOf', targetId: y, enabled: true, influence: 1, inverse: null }
    const cy = { id: 'hand_y', type: 'childOf', targetId: x, enabled: true, influence: 1, inverse: null }
    await s.ok('layer.patch', { id: x, ops: [{ op: 'set', path: 'constraints', value: [cx] }] })
    await s.ok('layer.patch', { id: y, ops: [{ op: 'set', path: 'constraints', value: [cy] }] })
    expect(() => worldObjects(s.comp(w), 0)).not.toThrow()
  })
})

describe('world.inspect and motion paths', () => {
  it('shows the constrained camera and lists constraints with their target and influence', async () => {
    const s = setup()
    const w = await s.world()
    const goal = await s.add(w, 'controller', [0, 0, 0])
    const eye = await s.add(w, 'camera', [600, -600, 200])
    await s.ok('world.track', { id: eye, lookAt: goal })
    const seen = await s.ok('world.inspect', { compId: w, atMs: 0 })
    const aim = lookAtRotation([600, -600, 200], [0, 0, 0], 'camera')
    expect(seen.camera.id).toBe(eye)
    expect(seen.camera.rotation).toEqual([aim.rotationX, aim.rotationY, aim.rotation].map((v) => Math.round(v * 10) / 10))
    const entry = seen.objects.find((o: { id: string }) => o.id === eye)
    expect(entry.constraints).toEqual([{ id: s.layer(w, eye).constraints?.[0]?.id, type: 'lookAt', target: goal, influence: 1 }])
    expect(seen.objects.find((o: { id: string }) => o.id === goal).constraints).toBeUndefined()
  })

  it('draws a follower’s path from its target’s keys, and samples the target’s key times', async () => {
    const s = setup()
    const w = await s.world(2000)
    const lead = await s.add(w, 'controller', [0, 0, 0])
    const rider = await s.add(w, 'mesh', [10, 0, 0])
    const still = await s.add(w, 'mesh', [10, 0, 0])
    await s.ok('keyframes.set', { id: lead, path: 'transform.x', keys: [{ t: 300, v: 0 }, { t: 700, v: 100 }] })
    await s.ok('world.track', { id: rider, follow: lead })
    const comp = s.comp(w)
    expect(hasWorldPath(s.layer(w, rider))).toBe(false)
    expect(hasWorldPath(s.layer(w, rider), comp)).toBe(true)
    expect(hasWorldPath(s.layer(w, still), comp)).toBe(false)
    const plain = worldPathTimes(s.layer(w, rider))
    const driven = worldPathTimes(s.layer(w, rider), comp)
    expect(plain).not.toContain(300)
    expect(driven).toContain(300)
    expect(driven).toContain(700)

    // A target inside a keyed group counts too, and a chain of followers.
    const a = await s.add(w, 'mesh', [0, 0, 0])
    const { groupId } = await s.ok('layers.group', { ids: [a], name: 'G' })
    await s.ok('keyframes.set', { id: groupId, path: 'transform.y', keys: [{ t: 0, v: 0 }, { t: 900, v: 50 }] })
    const chase = await s.add(w, 'mesh', [0, 0, 0])
    const chain = await s.add(w, 'mesh', [0, 0, 0])
    await s.ok('world.track', { id: chase, follow: a })
    await s.ok('world.track', { id: chain, follow: chase })
    expect(hasWorldPath(s.layer(w, chase), s.comp(w))).toBe(true)
    expect(hasWorldPath(s.layer(w, chain), s.comp(w))).toBe(true)
    expect(worldPathTimes(s.layer(w, chain), s.comp(w))).toContain(900)
  })
})

describe('world.track in the project file', () => {
  it('survives a save and a load, and moves things the same afterwards', async () => {
    const s = setup()
    const w = await s.world()
    const lead = await s.add(w, 'controller', [100, 0, 0])
    const rider = await s.add(w, 'mesh', [10, 0, 0])
    const eye = await s.add(w, 'camera', [0, -500, 100])
    await s.keyAxis(lead, 'transform.x', 100, 400)
    await s.ok('world.track', { id: rider, childOf: lead, atMs: 200 })
    await s.ok('world.track', { id: eye, lookAt: rider })
    const { project } = readProjectFile(writeProjectFile(s.session.project))
    expect(project).toEqual(s.session.project)
    const back = project.comps.find((c) => c.id === w) as Comp
    for (const ms of [0, 200, 800]) {
      const here = worldObjects(s.comp(w), ms).find((o) => o.layer.id === eye)
      const there = worldObjects(back, ms).find((o) => o.layer.id === eye)
      close(there?.matrix as WorldMat4, here?.matrix as WorldMat4, 12)
    }
    close(worldCoresAt(back, 200, 'childOf').get(lead) as WorldMat4, worldCoresAt(s.comp(w), 200, 'childOf').get(lead) as WorldMat4)
  })
})
