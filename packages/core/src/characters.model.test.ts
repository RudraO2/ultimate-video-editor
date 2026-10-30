import { describe, expect, it } from 'vitest'
import { createDefaultProject } from './doc'
import { sequentialIds } from './ids'
import { evaluateProperty, propertiesOf, resolveProperty } from './properties'
import { PROJECT_FILE_VERSION, readProjectFile, writeProjectFile } from './projectFile'
import type { GroupLayer, Layer, Project } from './schema'
import { Session } from './session'

function setup() {
  const ids = sequentialIds()
  const session = new Session({ project: createDefaultProject(ids), ids })
  // biome-ignore lint/suspicious/noExplicitAny: test results are checked field by field
  const ok = async (name: string, input: unknown = {}): Promise<any> => {
    const result = await session.call(name, input)
    if (!result.ok) throw new Error(`${name} failed: ${result.error} ${result.hint ?? ''}`)
    return result.value
  }
  const fail = async (name: string, input: unknown) => {
    const result = await session.call(name, input)
    if (result.ok) throw new Error(`${name} should have failed`)
    return `${result.error}\n${result.hint ?? ''}`
  }
  const layer = (id: string) => session.project.comps.flatMap((c) => c.tracks.flatMap((t) => t.layers)).find((l) => l.id === id) as Layer
  const group = (id: string) => layer(id) as GroupLayer
  const box = async (name: string) => (await ok('layer.create', { kind: 'shape', shape: 'rect', name })).id as string
  const names = async (list: string[]): Promise<[string, string, ...string[]]> => {
    const out: string[] = []
    for (const n of list) out.push(await box(n))
    return out as [string, string, ...string[]]
  }
  return { session, ok, fail, layer, group, box, names }
}

const ARM = [
  { name: 'Shoulder', head: [0, 0], tail: [0, 100] },
  { name: 'Elbow', head: [0, 100], tail: [0, 200] },
  { name: 'Hand', head: [0, 200], tail: [0, 260] },
]

describe('switch.create and switch.show', () => {
  it('groups layers as members and shows one by name, loosely matched', async () => {
    const s = setup()
    const [open, closed] = await s.names(['Mouth Open', 'Mouth Closed'])
    const made = await s.ok('switch.create', { ids: [open, closed], name: 'Mouth', show: 'mouth_open' })
    // The layer made last is in front, so it is member 0.
    expect(made.members.map((m: { name: string }) => m.name)).toEqual(['Mouth Closed', 'Mouth Open'])
    expect(made.show).toBe(1)
    expect(s.group(made.switchId).switch).toBe(1)
    const shown = await s.ok('switch.show', { id: made.switchId, show: 'MOUTH CLOSED!' })
    expect(shown.member).toMatchObject({ index: 0, id: closed })
    expect(s.group(made.switchId).switch).toBe(0)
    expect(open).toBeDefined()
  })

  it('makes an existing group a switch, and undoes as one step', async () => {
    const s = setup()
    const [a, b] = await s.names(['A', 'B'])
    const { groupId } = await s.ok('layers.group', { ids: [a, b], name: 'Hands' })
    const made = await s.ok('switch.create', { id: groupId, show: 1 })
    expect(made.switchId).toBe(groupId)
    expect(s.group(groupId).switch).toBe(1)
    expect(s.session.undo()).toBe(true)
    expect(s.group(groupId).switch).toBeNull()
  })

  it('creating from layers is one undo step', async () => {
    const s = setup()
    const [a, b] = await s.names(['A', 'B'])
    const before = JSON.stringify(s.session.project)
    await s.ok('switch.create', { ids: [a, b] })
    expect(s.session.undo()).toBe(true)
    expect(JSON.stringify(s.session.project)).toBe(before)
  })

  it('keys hold keys at comp time; off removes the switch and its keys', async () => {
    const s = setup()
    const [a, b] = await s.names(['A', 'B'])
    const { switchId } = await s.ok('switch.create', { ids: [a, b] })
    await s.ok('switch.show', { id: switchId, show: 'A', key: true, atMs: 1000 })
    await s.ok('switch.show', { id: switchId, show: 'B', atMs: 2000 })
    const keys = s.group(switchId).animations.switch ?? []
    expect(keys.map((k) => [k.t, k.v, k.ease])).toEqual([
      [1000, 1, 'hold'],
      [2000, 0, 'hold'],
    ])
    const spec = resolveProperty(s.layer(switchId), 'switch')[0]
    expect(spec && evaluateProperty(s.layer(switchId), spec, 1500)).toBe(1)
    expect(await s.fail('switch.show', { id: switchId, show: 'B' })).toContain('needs a time')
    expect(await s.fail('switch.show', { id: switchId, show: 'B', key: false })).toContain('keys')
    await s.ok('switch.show', { id: switchId, off: true })
    expect(s.group(switchId).switch).toBeNull()
    expect(s.group(switchId).animations.switch).toBeUndefined()
    expect(propertiesOf(s.layer(switchId)).some((p) => p.path === 'switch')).toBe(false)
  })

  it('switch keys written by keyframes.set and layer.set hold by default', async () => {
    const s = setup()
    const [a, b] = await s.names(['A', 'B'])
    const { switchId } = await s.ok('switch.create', { ids: [a, b] })
    await s.ok('keyframes.set', { id: switchId, path: 'switch', keys: [{ t: 0, v: 0 }, { t: 500, v: 1 }] })
    expect(s.group(switchId).animations.switch?.map((k) => k.ease)).toEqual(['hold', 'hold'])
    await s.ok('layer.set', { id: switchId, values: { switch: 0 }, atMs: 900 })
    expect(s.group(switchId).animations.switch?.at(-1)?.ease).toBe('hold')
  })

  it('lists members when a name or index is unknown, and refuses non-groups', async () => {
    const s = setup()
    const [a, b] = await s.names(['Smile', 'Frown'])
    const { switchId } = await s.ok('switch.create', { ids: [a, b] })
    const message = await s.fail('switch.show', { id: switchId, show: 'grin' })
    expect(message).toContain('0 Frown')
    expect(message).toContain('1 Smile')
    expect(await s.fail('switch.show', { id: switchId, show: 5 })).toContain('no member 5')
    expect(await s.fail('switch.show', { id: a, show: 0 })).toContain('not a group')
    expect(await s.fail('switch.show', { id: switchId })).toContain('Say which member')
    expect(await s.fail('switch.show', { id: switchId, show: 0, off: true })).toContain('off')
    expect(await s.fail('switch.create', {})).toContain('Say which layer')
  })
})

describe('rig.create and rig.bone', () => {
  it('makes a rig with a chain: a bone hangs from the one before it', async () => {
    const s = setup()
    const [body, arm] = await s.names(['Body', 'Arm'])
    const made = await s.ok('rig.create', { ids: [body, arm], name: 'Mia', bones: ARM })
    expect(made.bones.map((b: { name: string; parent: string | null }) => [b.name, b.parent])).toEqual([
      ['Shoulder', null],
      ['Elbow', made.bones[0].id],
      ['Hand', made.bones[1].id],
    ])
    expect(s.group(made.rigId).name).toBe('Mia')
    expect(s.group(made.rigId).rig?.bones[0]?.pose).toEqual({ rotation: 0, x: 0, y: 0, scale: 1 })
    expect(s.group(made.rigId).rig?.bones[0]?.deform).toBe(true)
    expect(made.bones[0].id).toMatch(/^bone_/)
  })

  it('refuses a second rig, duplicate names, a zero-length bone and backwards limits', async () => {
    const s = setup()
    const [a, b] = await s.names(['A', 'B'])
    const { rigId } = await s.ok('rig.create', { ids: [a, b], bones: ARM })
    expect(await s.fail('rig.create', { ids: rigId })).toContain('already a rig')
    const c = await s.box('C')
    expect(await s.fail('rig.create', { ids: c, bones: [{ name: 'X', head: [0, 0], tail: [1, 1] }, { name: 'x', head: [0, 0], tail: [1, 1] }] })).toContain('Two bones')
    expect(await s.fail('rig.create', { ids: c, bones: [{ head: [5, 5], tail: [5, 5] }] })).toContain('same point')
    expect(await s.fail('rig.create', { ids: c, bones: [{ head: [0, 0], tail: [1, 1], limits: { rotation: [10, -10] } }] })).toContain('minimum')
    expect(await s.fail('rig.create', { ids: c, bones: [{ name: 'A', head: [0, 0], tail: [1, 1], parent: 'Nope' }] })).toContain('no bone')
  })

  it('undoes a rig creation in one step', async () => {
    const s = setup()
    const [a, b] = await s.names(['A', 'B'])
    const before = JSON.stringify(s.session.project)
    await s.ok('rig.create', { ids: [a, b], bones: ARM })
    expect(s.session.undo()).toBe(true)
    expect(JSON.stringify(s.session.project)).toBe(before)
  })

  it('adds, edits and removes bones; removing reparents and drops keys, IK, binds and behaviours', async () => {
    const s = setup()
    const [body, arm] = await s.names(['Body', 'Arm'])
    const { rigId, bones } = await s.ok('rig.create', { ids: [body, arm], bones: ARM })
    const [shoulder, elbow] = bones as { id: string }[]
    await s.ok('rig.bone', { rigId, add: [{ name: 'Aim', head: [50, 0], tail: [50, 50], parent: null }] })
    await s.ok('rig.bone', { rigId, edit: [{ bone: 'Hand', ik: { target: 'Aim', flip: true } }, { bone: 'Elbow', limits: { rotation: [-90, 90] } }] })
    expect(s.group(rigId).rig?.bones.find((b) => b.name === 'Hand')?.ik).toMatchObject({ chain: 2, flip: true, mix: 1 })
    await s.ok('rig.pose', { rigId, key: true, atMs: 0, poses: [{ bone: 'Elbow', rotation: 10 }] })
    await s.ok('rig.bind', { ids: arm, mode: 'rigid', bone: 'Elbow' })
    await s.ok('behaviors.add', { groupId: rigId, type: 'sway', fields: { bone: 'Elbow' } })
    await s.ok('behaviors.add', { groupId: rigId, type: 'breathe', fields: { layer: body } })
    const removed = await s.ok('rig.bone', { rigId, remove: ['Elbow', 'Aim'] })
    const left = s.group(rigId).rig?.bones ?? []
    expect(left.map((b) => b.name)).toEqual(['Shoulder', 'Hand'])
    expect(left.find((b) => b.name === 'Hand')?.parent).toBe(shoulder?.id)
    expect(left.find((b) => b.name === 'Hand')?.ik).toBeUndefined()
    expect(removed.droppedKeys).toEqual([`bone.${elbow?.id}.rotation`])
    expect(removed.unbound).toEqual([arm])
    expect(s.layer(arm).bind).toBeUndefined()
    expect(s.group(rigId).behaviors.map((b) => b.type)).toEqual(['breathe'])
    expect(s.group(rigId).animations[`bone.${elbow?.id}.rotation`]).toBeUndefined()
    expect(s.session.undo()).toBe(true)
    expect(s.group(rigId).rig?.bones).toHaveLength(4)
  })

  it('refuses edits that break the rig', async () => {
    const s = setup()
    const [a] = await s.names(['A'])
    const { rigId } = await s.ok('rig.create', { ids: a, bones: ARM })
    expect(await s.fail('rig.bone', { rigId, edit: [{ bone: 'Shoulder', parent: 'Hand' }] })).toContain('own ancestor')
    expect(await s.fail('rig.bone', { rigId, edit: [{ bone: 'Hand', ik: { target: 'Hand' } }] })).toContain('itself')
    expect(await s.fail('rig.bone', { rigId, edit: [{ bone: 'Hand' }], remove: ['hand'] })).toContain('both edited and removed')
    expect(await s.fail('rig.bone', { rigId, remove: ['Knee'] })).toContain('Its bones')
    expect(await s.fail('rig.bone', { rigId: a, add: [] })).toContain('not a group')
  })
})

describe('rig.pose, rig.bind and rig.inspect', () => {
  async function rigged() {
    const s = setup()
    const [body, arm] = await s.names(['Body', 'Arm'])
    const made = await s.ok('rig.create', { ids: [body, arm], bones: ARM })
    await s.ok('rig.bone', { rigId: made.rigId, edit: [{ bone: 'Elbow', limits: { rotation: [-45, 45], scale: [0.5, 2] } }] })
    return { s, body, arm, rigId: made.rigId as string, bones: made.bones as { id: string; name: string }[] }
  }

  it('sets the resting pose, clamped to limits, and resets', async () => {
    const { s, rigId } = await rigged()
    const posed = await s.ok('rig.pose', { rigId, poses: [{ bone: 'elbow', rotation: 80, x: 4 }, { bone: 'Hand', scale: 1.2 }] })
    expect(posed.poses[0]).toMatchObject({ name: 'Elbow', rotation: 45, x: 4, clamped: true, keyed: [] })
    expect(s.group(rigId).rig?.bones[1]?.pose).toEqual({ rotation: 45, x: 4, y: 0, scale: 1 })
    expect(s.group(rigId).rig?.bones[2]?.pose.scale).toBe(1.2)
    await s.ok('rig.pose', { rigId, reset: true })
    expect(s.group(rigId).rig?.bones.every((b) => b.pose.rotation === 0 && b.pose.x === 0 && b.pose.scale === 1)).toBe(true)
    expect(await s.fail('rig.pose', { rigId })).toContain('Nothing to pose')
    expect(await s.fail('rig.pose', { rigId, reset: true, poses: [{ bone: 'Hand', rotation: 3 }] })).toContain('reset takes bones')
    expect(await s.fail('rig.pose', { rigId, poses: [{ bone: 'Knee', rotation: 3 }] })).toContain('no bone')
  })

  it('keys poses at comp time through the bone channels, and a keyed channel keeps keying', async () => {
    const { s, rigId, bones } = await rigged()
    const elbow = bones[1]?.id as string
    await s.ok('rig.pose', { rigId, key: true, atMs: 0, poses: [{ bone: 'Elbow', rotation: 0 }] })
    await s.ok('rig.pose', { rigId, atMs: 1000, poses: [{ bone: 'Elbow', rotation: 30 }] })
    const keys = s.group(rigId).animations[`bone.${elbow}.rotation`] ?? []
    expect(keys.map((k) => [k.t, k.v])).toEqual([
      [0, 0],
      [1000, 30],
    ])
    expect(s.group(rigId).rig?.bones[1]?.pose.rotation).toBe(0)
    const props = propertiesOf(s.layer(rigId)).map((p) => p.path)
    for (const channel of ['rotation', 'x', 'y', 'scale']) expect(props).toContain(`bone.${elbow}.${channel}`)
    const spec = resolveProperty(s.layer(rigId), `bone.${elbow}.rotation`)[0]
    expect(spec && evaluateProperty(s.layer(rigId), spec, 1000)).toBe(30)
    const read = await s.ok('rig.inspect', { rigId, atMs: 1000 })
    expect(read.bones[1]).toMatchObject({ name: 'Elbow', parent: bones[0]?.id, parentName: 'Shoulder', pose: { rotation: 30 }, keyed: ['rotation'], limits: { rotation: [-45, 45] } })
    expect(read.members.map((m: { bind: unknown }) => m.bind)).toEqual([{ mode: 'auto' }, { mode: 'auto' }])
    await s.ok('layer.set', { id: rigId, values: { [`bone.${elbow}.scale`]: 1.5 }, mode: 'base' })
    expect(s.group(rigId).rig?.bones[1]?.pose.scale).toBe(1.5)
  })

  it('gives a helpful hint for unknown bone and switch property names', async () => {
    const { s, rigId, arm } = await rigged()
    expect(await s.fail('layer.set', { id: rigId, values: { 'bone.nope.rotation': 3 }, mode: 'base' })).toContain('rotation|x|y|scale')
    expect(await s.fail('layer.set', { id: arm, values: { 'bone.x.rotation': 3 }, mode: 'base' })).toContain('rig group')
    expect(await s.fail('layer.set', { id: rigId, values: { switch: 1 }, mode: 'base' })).toContain('switch.create')
  })

  it('binds members to bones, refusing what is not a member of a rig', async () => {
    const { s, arm, body, rigId } = await rigged()
    const bound = await s.ok('rig.bind', { ids: [arm, body], mode: 'rigid', bone: 'Shoulder' })
    expect(bound.binds).toHaveLength(2)
    expect(s.layer(arm).bind).toEqual({ mode: 'rigid', bone: s.group(rigId).rig?.bones[0]?.id })
    await s.ok('rig.bind', { ids: body, mode: 'none' })
    expect(s.layer(body).bind).toEqual({ mode: 'none' })
    await s.ok('rig.bind', { ids: arm, mode: 'auto' })
    expect(s.layer(arm).bind).toEqual({ mode: 'auto' })
    expect(await s.fail('rig.bind', { ids: arm, mode: 'rigid' })).toContain('needs a bone')
    expect(await s.fail('rig.bind', { ids: arm, mode: 'none', bone: 'Hand' })).toContain('only goes with')
    expect(await s.fail('rig.bind', { ids: arm, mode: 'rigid', bone: 'Knee' })).toContain('Its bones')
    const loose = await s.box('Loose')
    expect(await s.fail('rig.bind', { ids: loose, mode: 'none' })).toContain('direct members')
    expect(await s.fail('rig.bind', { ids: [arm, loose], mode: 'none' })).toContain('direct members')
    expect(s.session.undo()).toBe(true)
  })
})

describe('behaviors', () => {
  async function character() {
    const s = setup()
    const [head, eyes, mouthA, mouthB, body] = await s.names(['Head', 'Eyes', 'Open', 'Closed', 'Body'])
    const mouth = (await s.ok('switch.create', { ids: [mouthA, mouthB], name: 'Mouth' })).switchId as string
    const made = await s.ok('rig.create', { ids: [head, eyes, mouth, body], name: 'Mia', bones: [{ name: 'Torso', head: [0, 100], tail: [0, -50] }] })
    return { s, head, eyes, mouth, body, rigId: made.rigId as string, torsoId: made.bones[0].id as string }
  }

  it('adds each type with its defaults, by id or name, and places it with index', async () => {
    const { s, eyes, mouth, rigId, head, torsoId } = await character()
    const blink = await s.ok('behaviors.add', { groupId: rigId, type: 'blink', fields: { eyes: 'Eyes' } })
    expect(blink.behavior).toMatchObject({ type: 'blink', eyes: [eyes], every: 4, closedMs: 120, variance: 40, doubles: 17, closedScale: 0.1, enabled: true, seed: 1 })
    expect(blink.behavior.id).toMatch(/^bhv_/)
    const breathe = await s.ok('behaviors.add', { groupId: rigId, type: 'breathe', fields: { bone: 'Torso' }, index: 0 })
    expect(breathe.behavior).toMatchObject({ bone: torsoId, amount: 1.2, rate: 16, phase: 0, keepBottom: true })
    await s.ok('behaviors.add', { groupId: rigId, type: 'sway', fields: { target: { layer: head } } })
    const nod = await s.ok('behaviors.add', { groupId: rigId, type: 'nod', fields: { layer: head, pivot: [0, 50] } })
    expect(nod.behavior).toMatchObject({ amount: 1.5, voice: null, pivot: [0, 50] })
    await s.ok('behaviors.add', { groupId: rigId, type: 'glance', fields: { layers: [eyes] } })
    const talk = await s.ok('behaviors.add', { groupId: rigId, type: 'talk', fields: { mouth, map: { open: 'Open' } } })
    expect(talk.behavior).toMatchObject({ mouth, voice: null, lead: 60, map: { open: 'Open' } })
    expect(s.group(rigId).behaviors.map((b) => b.type)).toEqual(['breathe', 'blink', 'sway', 'nod', 'glance', 'talk'])
    expect(s.session.undo()).toBe(true)
    expect(s.group(rigId).behaviors).toHaveLength(5)
  })

  it('refuses bad targets, a mouth that is not a switch, missing bones and values out of range', async () => {
    const { s, eyes, head, rigId, body } = await character()
    const outside = await s.box('Outside')
    expect(await s.fail('behaviors.add', { groupId: rigId, type: 'sway', fields: {} })).toContain('exactly one target')
    expect(await s.fail('behaviors.add', { groupId: rigId, type: 'sway', fields: { layer: head, bone: 'Torso' } })).toContain('exactly one target')
    expect(await s.fail('behaviors.add', { groupId: rigId, type: 'sway', fields: { layer: outside } })).toContain('not a layer of')
    expect(await s.fail('behaviors.add', { groupId: rigId, type: 'sway', fields: { bone: 'Tail' } })).toContain('no bone')
    expect(await s.fail('behaviors.add', { groupId: rigId, type: 'talk', fields: { mouth: body } })).toContain('not a switch')
    expect(await s.fail('behaviors.add', { groupId: rigId, type: 'blink', fields: {} })).toContain('eyes')
    expect(await s.fail('behaviors.add', { groupId: rigId, type: 'blink', fields: { eyes: [] } })).toContain('needs eyes')
    expect(await s.fail('behaviors.add', { groupId: rigId, type: 'blink', fields: { eyes, every: 99 } })).toContain('every')
    expect(await s.fail('behaviors.add', { groupId: rigId, type: 'blink', fields: { eyes, colour: 1 } })).toContain('colour')
    expect(await s.fail('behaviors.add', { groupId: rigId, type: 'nod', fields: { layer: head, voice: head } })).toContain('audio or video')
    expect(await s.fail('behaviors.add', { groupId: head, type: 'blink', fields: { eyes } })).toContain('not a group')
  })

  it('updates, clears to the default with null, moves, disables and removes', async () => {
    const { s, eyes, head, rigId } = await character()
    const { behavior } = await s.ok('behaviors.add', { groupId: rigId, type: 'blink', fields: { eyes, every: 8 } })
    const other = (await s.ok('behaviors.add', { groupId: rigId, type: 'sway', fields: { layer: head } })).behavior
    const updated = await s.ok('behaviors.update', { groupId: rigId, id: behavior.id, fields: { every: null, closedMs: 200 }, enabled: false, index: 1 })
    expect(updated.behavior).toMatchObject({ every: 4, closedMs: 200, enabled: false })
    expect(s.group(rigId).behaviors.map((b) => b.id)).toEqual([other.id, behavior.id])
    expect(await s.fail('behaviors.update', { groupId: rigId, id: behavior.id, fields: { type: 'talk' } })).toContain('keeps its type')
    expect(await s.fail('behaviors.update', { groupId: rigId, id: 'bhv_nope', enabled: true })).toContain('Its behaviours')
    expect(await s.fail('behaviors.update', { groupId: rigId, id: behavior.id })).toContain('Nothing to change')
    expect(await s.fail('behaviors.update', { groupId: rigId, id: behavior.id, fields: { eyes: null } })).toContain('eyes')
    await s.ok('behaviors.remove', { groupId: rigId, id: behavior.id })
    expect(s.group(rigId).behaviors.map((b) => b.id)).toEqual([other.id])
    expect(await s.fail('behaviors.remove', { groupId: rigId, id: behavior.id })).toContain('no behaviour')
    expect(s.session.undo()).toBe(true)
    expect(s.group(rigId).behaviors).toHaveLength(2)
  })

  it('inspects groups, and lists every type with its fields and defaults', async () => {
    const { s, eyes, rigId } = await character()
    expect((await s.ok('behaviors.inspect', {})).groups).toEqual([])
    await s.ok('behaviors.add', { groupId: rigId, type: 'blink', fields: { eyes } })
    const read = await s.ok('behaviors.inspect', { types: true })
    expect(read.groups).toHaveLength(1)
    expect(read.groups[0].behaviors[0].type).toBe('blink')
    expect(read.types.map((t: { type: string }) => t.type)).toEqual(['blink', 'breathe', 'sway', 'nod', 'glance', 'talk'])
    const blink = read.types[0].fields
    expect(blink.eyes.required).toBe(true)
    expect(blink.every).toMatchObject({ default: 4, required: false })
    expect(read.types[5].fields.lead.default).toBe(60)
    expect((await s.ok('behaviors.inspect', { groupId: rigId })).groups[0].name).toBe('Mia')
  })

  it('drops references to deleted layers and remaps them on duplicate', async () => {
    const { s, eyes, head, mouth, rigId } = await character()
    await s.ok('behaviors.add', { groupId: rigId, type: 'blink', fields: { eyes: [eyes] } })
    await s.ok('behaviors.add', { groupId: rigId, type: 'sway', fields: { layer: head } })
    await s.ok('behaviors.add', { groupId: rigId, type: 'talk', fields: { mouth } })
    const copy = await s.ok('layers.duplicate', { ids: rigId })
    const copied = s.group(copy.ids[0] as string)
    expect(copied.behaviors).toHaveLength(3)
    const copiedBlink = copied.behaviors[0]
    expect(copiedBlink?.type === 'blink' && copiedBlink.eyes[0]).not.toBe(eyes)
    const copiedTalk = copied.behaviors[2]
    expect(copiedTalk?.type === 'talk' && copiedTalk.mouth).not.toBe(mouth)
    expect(copiedTalk?.type === 'talk' && s.layer(copiedTalk.mouth).kind).toBe('group')

    await s.ok('layers.delete', { ids: [head] })
    expect(s.group(rigId).behaviors.map((b) => b.type)).toEqual(['blink', 'talk'])
    await s.ok('layers.delete', { ids: [mouth, eyes] })
    expect(s.group(rigId).behaviors).toEqual([])
    expect(s.session.undo()).toBe(true)
    expect(s.group(rigId).behaviors).toHaveLength(2)
  })
})

describe('project file with characters', () => {
  it('round-trips switch, rig, binds, behaviours and an envelope at format 16', async () => {
    const s = setup()
    const [a, b, c] = await s.names(['A', 'B', 'C'])
    const mouth = (await s.ok('switch.create', { ids: [a, b], name: 'Mouth', show: 1 })).switchId as string
    const { rigId } = await s.ok('rig.create', { ids: [mouth, c], bones: ARM })
    await s.ok('rig.bind', { ids: c, mode: 'rigid', bone: 'Hand' })
    await s.ok('rig.pose', { rigId, key: true, atMs: 500, poses: [{ bone: 'Elbow', rotation: 12 }] })
    await s.ok('switch.show', { id: mouth, show: 0, key: true, atMs: 700 })
    await s.ok('behaviors.add', { groupId: rigId, type: 'talk', fields: { mouth } })
    await s.ok('behaviors.add', { groupId: rigId, type: 'nod', fields: { bone: 'Hand', amount: 3 } })
    const mediaId = (await s.ok('media.add', { kind: 'audio', name: 'voice.wav', path: 'C:/audio/voice.wav', durationMs: 1000 })).id as string
    const project = JSON.parse(JSON.stringify(s.session.project)) as Project
    const media = project.media.find((m) => m.id === mediaId)
    if (media) media.envelope = { rate: 50, values: [0, 0.5, 1] }

    const text = writeProjectFile(project)
    expect(JSON.parse(text).formatVersion).toBe(PROJECT_FILE_VERSION)
    const back = readProjectFile(text).project as Project
    expect(back).toEqual(project)
    expect(back.media.find((m) => m.id === mediaId)?.envelope).toEqual({ rate: 50, values: [0, 0.5, 1] })
    const rig = back.comps[0]?.tracks.flatMap((t) => t.layers).find((l) => l.id === rigId) as GroupLayer
    expect(rig.rig?.bones).toHaveLength(3)
    expect(rig.behaviors.map((x) => x.type)).toEqual(['talk', 'nod'])
  })

  it('opens an earlier file: groups have no switch, rig or behaviours', async () => {
    const s = setup()
    const [a, b] = await s.names(['A', 'B'])
    const { groupId } = await s.ok('layers.group', { ids: [a, b] })
    const file = JSON.parse(writeProjectFile(s.session.project))
    file.formatVersion = 15
    const doc = JSON.stringify(file.document)
    file.document = JSON.parse(doc.replace(/,"switch":null/g, '').replace(/,"rig":null/g, '').replace(/,"behaviors":\[\]/g, ''))
    const back = readProjectFile(JSON.stringify(file)).project as Project
    const group = back.comps[0]?.tracks.flatMap((t) => t.layers).find((l) => l.id === groupId) as GroupLayer
    expect(group.switch).toBeNull()
    expect(group.rig).toBeNull()
    expect(group.behaviors).toEqual([])
  })
})
