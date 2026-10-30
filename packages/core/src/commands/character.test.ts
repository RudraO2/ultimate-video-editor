import { describe, expect, it } from 'vitest'
import { layerBox, matchName } from '../characterDetect'
import { createDefaultProject } from '../doc'
import { sequentialIds } from '../ids'
import type { Comp, GroupLayer, Layer } from '../schema'
import { Session, type SessionOptions } from '../session'

// Core loads no Node types, so the modules are named by variable.
const fsName: string = 'node:fs'
const { existsSync, readFileSync } = (await import(fsName)) as { existsSync(p: string): boolean; readFileSync(p: string, enc: string): string }

type PartOut = { role: string; id: string; name: string; confidence: number; reason: string }

function setup(options: Partial<SessionOptions> = {}) {
  const ids = sequentialIds()
  const session = new Session({ project: createDefaultProject(ids), ids, ...options })
  // biome-ignore lint/suspicious/noExplicitAny: test results are checked field by field
  const ok = async (name: string, input: unknown = {}): Promise<any> => {
    const result = await session.call(name, input)
    if (!result.ok) throw new Error(`${name} failed: ${result.error} ${result.hint ?? ''}`)
    return result.value
  }
  const all = (): Layer[] => (session.project.comps[0] as Comp).tracks.flatMap((t) => t.layers)
  const layer = (id: string) => all().find((l) => l.id === id) as Layer
  const group = (id: string) => layer(id) as GroupLayer
  const byName = (name: string) => all().find((l) => l.name === name) as Layer
  const shape = async (name: string, type: 'ellipse' | 'rect', width: number, height: number, x: number, y: number) =>
    (await ok('layer.create', { kind: 'shape', shape: { type, width, height }, name, x, y })).id as string
  /** A character made of named shapes, grouped. */
  const drawn = async (parts: [string, 'ellipse' | 'rect', number, number, number, number][], name = 'Mia') => {
    const made: string[] = []
    for (const p of parts) made.push(await shape(...p))
    return (await ok('layers.group', { ids: made, name })).groupId as string
  }
  const detect = async (id: string, overrides?: Record<string, string | null>) => (await ok('character.detect', { id, overrides })) as { figure: string; parts: PartOut[]; pieces?: number; life: Record<string, string> }
  const role = (parts: PartOut[], r: string) => parts.find((p) => p.role === r)
  return { session, ok, all, layer, group, byName, shape, drawn, detect, role }
}

// A face as a drawing of a head: a big circle, two eyes high in it, a nose, a mouth.
const FACE: [string, 'ellipse' | 'rect', number, number, number, number][] = [
  ['Shape 1', 'ellipse', 200, 200, 0, 0],
  ['Shape 2', 'ellipse', 30, 40, 40, -30],
  ['Shape 3', 'ellipse', 30, 40, -40, -30],
  ['Shape 4', 'ellipse', 60, 20, 0, 50],
]

// A miniature of an Open Peeps file: body, head, a face drawn as ONE path of many outlines, accessories.
const PEEP = `<svg viewBox="0 0 240 324"><g id="Introduction" fill="none"><g id="variations"><g id="images"><g id="a-person/bust">
  <g id="body/Dress"><path id="🎨-Background" fill="#FFFFFF" d="M20 200h200v120H20z"/><path id="🖍-Ink" fill="#000000" d="M30 210h180v100H30z"/></g>
  <g id="head/Bangs"><path id="🎨-Background" fill="#FFFFFF" d="M70 30h100v130H70z"/><path id="🖍-Ink" fill="#000000" d="M65 25h110v30H65z"/></g>
  <g id="face/Calm" fill="#000000"><path id="🖍-Ink" fill-rule="evenodd" d="M93 80h14v14H93z M98 84h4v4H98z M133 80h14v14H133z M90 66h24v5H90z M126 66h24v5H126z M115 100h10v14H115z M105 126h30v8H105z"/></g>
  <g id="accessories/Glasses-3" fill="#000000"><path id="🖍-Ink" d="M88 70h64v2H88z"/></g>
</g></g></g></g></svg>`

describe('matchName', () => {
  it('reads names in many languages, sides, plurals and copies', () => {
    expect(matchName('ojo izquierdo')).toMatchObject({ role: 'eye', side: 'L' })
    expect(matchName('左目')).toMatchObject({ role: 'eye', side: 'L' })
    expect(matchName('Eye_L copy 2')).toMatchObject({ role: 'eye', side: 'L', copy: true })
    expect(matchName('EyeBrowR')).toMatchObject({ role: 'brow', side: 'R' })
    expect(matchName('Upper Arm.R')).toMatchObject({ role: 'arm', side: 'R' })
    expect(matchName('forearm')?.role).toBe('forearm')
    expect(matchName('Eyes')).toMatchObject({ role: 'eye', plural: true })
    expect(matchName('Bouche')?.role).toBe('mouth')
    expect(matchName('Layer 12')).toBeNull()
    expect(matchName('Forehead')).toBeNull()
  })
})

describe('character.detect', () => {
  it('finds parts by name, in Spanish with sides', async () => {
    const s = setup()
    const id = await s.drawn([
      ['Cabeza', 'ellipse', 200, 200, 0, 0],
      ['ojo izquierdo', 'ellipse', 30, 40, 40, -30],
      ['ojo derecho', 'ellipse', 30, 40, -40, -30],
      ['Boca', 'ellipse', 60, 20, 0, 50],
    ])
    const found = await s.detect(id)
    expect(s.role(found.parts, 'eye.L')).toMatchObject({ name: 'ojo izquierdo', confidence: 0.9 })
    expect(s.role(found.parts, 'eye.R')?.name).toBe('ojo derecho')
    expect(s.role(found.parts, 'mouth')?.name).toBe('Boca')
    expect(s.role(found.parts, 'head')?.name).toBe('Cabeza')
    expect(found.figure).toBe('face')
  })

  it('lets a name beat place: Japanese 左目 on the screen left is still the left eye', async () => {
    const s = setup()
    const id = await s.drawn([
      ['頭', 'ellipse', 200, 200, 0, 0],
      ['左目', 'ellipse', 30, 40, -40, -30],
      ['右目', 'ellipse', 30, 40, 40, -30],
    ])
    const found = await s.detect(id)
    expect(s.role(found.parts, 'eye.L')?.name).toBe('左目')
    expect(s.role(found.parts, 'eye.R')?.name).toBe('右目')
  })

  it('ignores a stale side in a copy, and still finds a lone copy', async () => {
    const s = setup()
    const id = await s.drawn([
      ['Eye.L', 'ellipse', 30, 40, -40, -30],
      ['Eye_L copy 2', 'ellipse', 30, 40, 40, -30],
    ])
    const found = await s.detect(id)
    expect(s.role(found.parts, 'eye.L')?.name).toBe('Eye.L')
    expect(s.role(found.parts, 'eye.R')?.name).toBe('Eye_L copy 2')
    const t = setup()
    const lone = await t.detect(await t.drawn([['Eye_L copy 2', 'ellipse', 30, 40, 0, 0]]))
    expect(t.role(lone.parts, 'eye.L')?.name).toBe('Eye_L copy 2')
  })

  it('counts the children of a plural group, and sides from the parent', async () => {
    const s = setup()
    const a = await s.shape('A', 'ellipse', 20, 20, -30, 0)
    const b = await s.shape('B', 'ellipse', 20, 20, 30, 0)
    const eyes = (await s.ok('layers.group', { ids: [a, b], name: 'Eyes' })).groupId as string
    const root = (await s.ok('layers.group', { ids: [eyes], name: 'Mia' })).groupId as string
    const found = await s.detect(root)
    expect(s.role(found.parts, 'eye.L')).toMatchObject({ id: b, confidence: 0.63 })
    expect(s.role(found.parts, 'eye.R')?.id).toBe(a)
  })

  it('reads switches: mouth shapes and open and closed eyes', async () => {
    const s = setup()
    const mouthShapes: string[] = []
    for (const n of ['X', 'MBP', 'E', 'AI', 'O', 'U']) mouthShapes.push(await s.shape(n, 'ellipse', 20, 10, 0, 40))
    const mouth = (await s.ok('switch.create', { ids: mouthShapes, name: 'Layer 7' })).switchId as string
    const open = await s.shape('Open', 'ellipse', 16, 16, 30, -20)
    const closed = await s.shape('Closed', 'rect', 16, 4, 30, -20)
    const eye = (await s.ok('switch.create', { ids: [open, closed], name: 'Thing' })).switchId as string
    const root = (await s.ok('layers.group', { ids: [mouth, eye], name: 'Mia' })).groupId as string
    const found = await s.detect(root)
    expect(s.role(found.parts, 'mouth')).toMatchObject({ id: mouth, confidence: 0.88 })
    const eyePart = found.parts.find((p) => p.role.startsWith('eye.'))
    expect(eyePart).toMatchObject({ id: eye })
    expect(eyePart?.confidence).toBeCloseTo(0.6, 2)
    // Members of a switch are not parts of their own.
    expect(found.parts.some((p) => mouthShapes.includes(p.id))).toBe(false)
  })

  it('finds unnamed shapes by where they sit: two small ellipses high in a big circle, and one below', async () => {
    const s = setup()
    const id = await s.drawn(FACE)
    const found = await s.detect(id)
    expect(s.role(found.parts, 'head')?.name).toBe('Shape 1')
    expect(s.role(found.parts, 'eye.L')).toMatchObject({ name: 'Shape 2' })
    expect(s.role(found.parts, 'eye.R')).toMatchObject({ name: 'Shape 3' })
    expect(s.role(found.parts, 'mouth')).toMatchObject({ name: 'Shape 4' })
    expect(s.role(found.parts, 'eye.L')?.confidence).toBeLessThan(0.6)
    expect(found.life.blink).toBe('can')
  })

  it('takes overrides: pin a part, rule one out', async () => {
    const s = setup()
    const id = await s.drawn(FACE)
    const found = await s.detect(id, { mouth: 'Shape 2', 'eye.L': null })
    expect(s.role(found.parts, 'mouth')).toMatchObject({ name: 'Shape 2', confidence: 1, reason: 'set by you' })
    expect(s.role(found.parts, 'eye.L')).toBeUndefined()
  })

  it('reports the pieces of a one-path face', async () => {
    const s = setup()
    const placed = await s.ok('svg.place', { svg: PEEP, name: 'Peep', groups: true, size: 300 })
    const found = await s.detect(placed.groupId)
    expect(found.pieces).toBe(6)
    expect(s.role(found.parts, 'torso')?.name).toBe('body')
    expect(s.role(found.parts, 'face')?.name).toBe('face')
    expect(found.figure).toBe('body')
    expect(found.life.blink).toMatch(/^No eyes found/)
  })
})

describe('character.bringToLife', () => {
  const behaviorTypes = (g: GroupLayer) => g.behaviors.map((b) => b.type)

  it('splits a one-path face, rigs Body and Head, and adds blink and breathe', async () => {
    const s = setup()
    const placed = await s.ok('svg.place', { svg: PEEP, name: 'Peep', groups: true, size: 300 })
    const result = await s.ok('character.bringToLife', { id: placed.groupId })
    expect(result.characterId).toBe(placed.groupId)
    const roles = result.parts.map((p: PartOut) => p.role)
    for (const r of ['eye.L', 'eye.R', 'brow.L', 'brow.R', 'mouth', 'nose', 'head', 'torso']) expect(roles).toContain(r)
    // The one Ink path is gone; its pieces are layers named after their parts.
    expect(s.all().filter((l) => l.name === 'Ink' && l.kind === 'path').length).toBe(3)
    expect(s.all().some((l) => /^Ink d/.test(l.name))).toBe(false)
    for (const name of ['eye.L', 'eye.R', 'brow.L', 'brow.R', 'mouth', 'nose']) expect(s.byName(name)).toBeTruthy()
    const g = s.group(placed.groupId)
    expect(g.rig?.bones.map((b) => b.name)).toEqual(['Body', 'Head'])
    expect(g.rig?.bones[1]?.parent).toBe(g.rig?.bones[0]?.id)
    expect(behaviorTypes(g).sort()).toEqual(['blink', 'breathe'])
    const blink = g.behaviors.find((b) => b.type === 'blink')
    expect(blink?.type === 'blink' && blink.eyes).toEqual([s.byName('eye.L').id, s.byName('eye.R').id])
    const breathe = g.behaviors.find((b) => b.type === 'breathe')
    expect(breathe?.type === 'breathe' && breathe.bone).toBe(g.rig?.bones[0]?.id)
    expect(result.life).toMatchObject({ blink: 'on', breathe: 'on', nod: 'Nods with a voice', talk: 'No voice: add a voice line to talk', look: 'off' })
    // The head group rides Head, the body rides Body.
    expect(s.byName('head').bind).toMatchObject({ mode: 'rigid', bone: g.rig?.bones[1]?.id })
    expect(s.byName('body').bind).toMatchObject({ mode: 'rigid', bone: g.rig?.bones[0]?.id })
    // The pieces sit where the one path drew them: the eyes are side by side, high in the head.
    const eyeL = s.byName('eye.L').transform
    const eyeR = s.byName('eye.R').transform
    expect(eyeL.x).toBeGreaterThan(eyeR.x)
    expect(eyeL.y).toBeCloseTo(eyeR.y, 3)
  })

  it('adds a Mouth switch, talk and nod when there is a voice and a way to read it', async () => {
    const s = setup({ envelope: async () => ({ rate: 50, values: [0, 0.4, 0.9, 0.3, 0] }) })
    const placed = await s.ok('svg.place', { svg: PEEP, name: 'Peep', groups: true, size: 300 })
    const media = await s.ok('media.add', { kind: 'audio', name: 'voice.wav', path: 'C:/audio/voice.wav', durationMs: 4000 })
    await s.ok('layer.create', { kind: 'audio', mediaId: media.id })
    const result = await s.ok('character.bringToLife', { id: placed.groupId })
    const mouth = s.byName('Mouth') as GroupLayer
    expect(mouth.switch).toBe(0)
    const comp = s.session.project.comps[0] as Comp
    const members = comp.tracks.filter((t) => t.groupId === mouth.id).flatMap((t) => t.layers.map((l) => l.name))
    expect(members).toEqual(['X', 'MBP', 'E', 'AI', 'O', 'U'])
    const g = s.group(placed.groupId)
    expect(behaviorTypes(g).sort()).toEqual(['blink', 'breathe', 'nod', 'talk'])
    const talk = g.behaviors.find((b) => b.type === 'talk')
    expect(talk?.type === 'talk' && talk.mouth).toBe(mouth.id)
    const nod = g.behaviors.find((b) => b.type === 'nod')
    expect(nod?.type === 'nod' && nod.bone).toBe(g.rig?.bones[1]?.id)
    expect(s.session.project.media[0]?.envelope).toEqual({ rate: 50, values: [0, 0.4, 0.9, 0.3, 0] })
    expect(result.life).toMatchObject({ blink: 'on', breathe: 'on', nod: 'on', talk: 'on' })
    expect(result.parts.find((p: PartOut) => p.role === 'mouth')).toMatchObject({ id: mouth.id })
  })

  it('says it cannot read the voice when the app has no way to', async () => {
    const s = setup()
    const placed = await s.ok('svg.place', { svg: PEEP, name: 'Peep', groups: true, size: 300 })
    const media = await s.ok('media.add', { kind: 'audio', name: 'voice.wav', path: 'C:/audio/voice.wav', durationMs: 4000 })
    await s.ok('layer.create', { kind: 'audio', mediaId: media.id })
    const result = await s.ok('character.bringToLife', { id: placed.groupId })
    expect(result.life.talk).toBe('Cannot read the voice here')
    expect(s.byName('Mouth')).toBeUndefined()
  })

  it('is one undo step, and a second run plans nothing', async () => {
    const s = setup({ envelope: async () => ({ rate: 50, values: [0.5] }) })
    const placed = await s.ok('svg.place', { svg: PEEP, name: 'Peep', groups: true, size: 300 })
    const media = await s.ok('media.add', { kind: 'audio', name: 'voice.wav', path: 'C:/audio/voice.wav', durationMs: 4000 })
    await s.ok('layer.create', { kind: 'audio', mediaId: media.id })
    const before = JSON.stringify(s.session.project)
    await s.ok('character.bringToLife', { id: placed.groupId })
    const after = JSON.stringify(s.session.project)
    expect(after).not.toBe(before)
    const again = await s.ok('character.bringToLife', { id: placed.groupId })
    expect(again.steps).toEqual([])
    expect(JSON.stringify(s.session.project)).toBe(after)
    // The second run was an empty step; the first undoes whole.
    s.session.undo()
    if (JSON.stringify(s.session.project) !== before) s.session.undo()
    expect(JSON.stringify(s.session.project)).toBe(before)
  })

  it('is exactly one undo step', async () => {
    const s = setup()
    const placed = await s.ok('svg.place', { svg: PEEP, name: 'Peep', groups: true, size: 300 })
    const before = JSON.stringify(s.session.project)
    await s.ok('character.bringToLife', { id: placed.groupId })
    expect(s.session.undo()).toBe(true)
    expect(JSON.stringify(s.session.project)).toBe(before)
  })

  it('dryRun plans with placeholders and writes nothing', async () => {
    const s = setup({ envelope: async () => ({ rate: 50, values: [0.5] }) })
    const placed = await s.ok('svg.place', { svg: PEEP, name: 'Peep', groups: true, size: 300 })
    const media = await s.ok('media.add', { kind: 'audio', name: 'voice.wav', path: 'C:/audio/voice.wav', durationMs: 4000 })
    await s.ok('layer.create', { kind: 'audio', mediaId: media.id })
    const before = JSON.stringify(s.session.project)
    const plan = await s.ok('character.bringToLife', { id: placed.groupId, dryRun: true })
    expect(JSON.stringify(s.session.project)).toBe(before)
    const calls = plan.steps.map((st: { call: string }) => st.call)
    for (const c of ['layer.create', 'layers.delete', 'switch.create', 'rig.create', 'behaviors.add']) expect(calls).toContain(c)
    expect(JSON.stringify(plan.steps)).toContain('<Mouth>')
    expect(plan.life.blink).toBe('on')
  })

  it("dryRun's script does what the real call does, in one script.run", async () => {
    const make = async () => {
      const s = setup({ envelope: async () => ({ rate: 50, values: [0.5, 0.2] }) })
      const placed = await s.ok('svg.place', { svg: PEEP, name: 'Peep', groups: true, size: 300 })
      const media = await s.ok('media.add', { kind: 'audio', name: 'voice.wav', path: 'C:/audio/voice.wav', durationMs: 4000 })
      await s.ok('layer.create', { kind: 'audio', mediaId: media.id })
      return { s, groupId: placed.groupId as string }
    }
    const real = await make()
    await real.s.ok('character.bringToLife', { id: real.groupId })
    const scripted = await make()
    const plan = await scripted.s.ok('character.bringToLife', { id: scripted.groupId, dryRun: true })
    expect(plan.script).toMatch(/^\/\/ character\.bringToLife plan/)
    expect(plan.script).toContain('await ac.media.envelope(')
    expect(plan.script).not.toContain('<Mouth>')
    const run = await scripted.s.ok('script.run', { code: plan.script })
    expect(run.created.layers).toBeGreaterThan(0)
    // Same document, ids aside (the dry run used up ids of its own).
    const idsAside = (p: unknown) => {
      const seen = new Map<string, string>()
      return JSON.stringify(p).replace(/"([a-z]+_\d+)"/g, (_, id: string) => {
        if (!seen.has(id)) seen.set(id, `#${seen.size}`)
        return `"${seen.get(id)}"`
      })
    }
    expect(idsAside(scripted.s.session.project)).toBe(idsAside(real.s.session.project))
  })

  it('gives a lone picture a Character group, a Head bone and breathe', async () => {
    const s = setup()
    const media = await s.ok('media.add', { kind: 'image', name: 'emoji.png', path: 'C:/img/emoji.png', width: 200, height: 300 })
    const pic = (await s.ok('layer.create', { kind: 'image', mediaId: media.id })).id as string
    const result = await s.ok('character.bringToLife', { id: pic })
    const g = s.group(result.characterId)
    expect(g.name).toBe('Character')
    expect(g.rig?.bones.map((b) => b.name)).toEqual(['Head'])
    const breathe = g.behaviors.find((b) => b.type === 'breathe')
    expect(breathe?.type === 'breathe' && breathe.layer).toBe(g.id)
    expect(result.life.blink).toBe('No eyes found')
    expect(result.life.talk).toBe('No voice: add a voice line to talk')
    expect(result.figure).toBe('face')
  })

  it('removes a behaviour given false, and adds look on the pupils or eyes', async () => {
    const s = setup()
    const id = await s.drawn(FACE)
    const first = await s.ok('character.bringToLife', { id, look: true })
    const g = s.group(id)
    expect(behaviorTypes(g).sort()).toEqual(['blink', 'breathe', 'glance'])
    expect(first.life.look).toBe('on')
    const glance = g.behaviors.find((b) => b.type === 'glance')
    expect(glance?.type === 'glance' && glance.rangeX).toBeCloseTo(7.5, 5)
    await s.ok('character.bringToLife', { id, blink: false, look: false })
    expect(behaviorTypes(s.group(id)).sort()).toEqual(['breathe'])
  })

  const REAL = 'C:/Users/rpxi1/uve-assets/open-peeps/peep-1.svg'
  it.skipIf(!existsSync(REAL))('brings a real Open Peeps person to life', async () => {
    const s = setup()
    const placed = await s.ok('svg.place', { svg: readFileSync(REAL, 'utf8'), name: 'Peep', groups: true, size: 600 })
    const found = await s.detect(placed.groupId)
    expect(found.pieces).toBeGreaterThanOrEqual(3)
    const result = await s.ok('character.bringToLife', { id: placed.groupId })
    const roles = result.parts.map((p: PartOut) => p.role)
    expect(roles).toContain('eye.L')
    expect(roles).toContain('eye.R')
    expect(roles).toContain('mouth')
    expect(result.life.blink).toBe('on')
  })
})

// Fluent Emoji (MIT): flat colour faces, drawn as many same-named path layers.
const FLUENT = 'C:/Users/rpxi1/uve-assets/fluent-emoji/assets'
const fluentFile = (name: string) => `${FLUENT}/${name}/Color/${name.toLowerCase().replace(/ /g, '_')}_color.svg`
const GRIN = fluentFile('Grinning face')

describe('a Fluent Emoji face', () => {
  const voiced = async (s: ReturnType<typeof setup>) => {
    const media = await s.ok('media.add', { kind: 'audio', name: 'voice.wav', path: 'C:/audio/voice.wav', durationMs: 4000 })
    await s.ok('layer.create', { kind: 'audio', mediaId: media.id })
  }
  const place = (s: ReturnType<typeof setup>, file: string, merge?: boolean) =>
    s.ok('svg.place', { svg: readFileSync(file, 'utf8'), name: 'emoji', groups: true, size: 300, ...(merge === undefined ? {} : { merge }) })

  it.skipIf(!existsSync(GRIN))('finds the head, eyes with pupils and the mouth of layers that are only numbered', async () => {
    const s = setup()
    const placed = await place(s, GRIN, false)
    const found = await s.detect(placed.groupId)
    for (const r of ['head', 'eye.L', 'eye.R', 'pupil.L', 'pupil.R', 'mouth']) expect(s.role(found.parts, r), r).toBeDefined()
    // The teeth bar inside the mouth is part of the mouth, not a nose.
    expect(s.role(found.parts, 'nose')).toBeUndefined()
    expect(found.life.blink).toBe('can')
  })

  it.skipIf(!existsSync(GRIN))('splits eyes joined by paint, groups each eye with its pupil, and makes the whole grin the rest shape', async () => {
    const s = setup({ envelope: async () => ({ rate: 50, values: [0, 0.5, 1, 0.4, 0] }) })
    const placed = await place(s, GRIN)
    await voiced(s)
    const result = await s.ok('character.bringToLife', { id: placed.groupId })
    const roles = result.parts.map((p: PartOut) => p.role)
    for (const r of ['eye.L', 'eye.R', 'mouth']) expect(roles).toContain(r)
    expect(result.life).toMatchObject({ blink: 'on', talk: 'on' })
    const comp = s.session.project.comps[0] as Comp
    const members = (id: string) => comp.tracks.filter((t) => t.groupId === id).flatMap((t) => t.layers)
    // Each eye is a group of its pieces (white and pupil).
    for (const name of ['eye.L', 'eye.R']) {
      const eye = s.byName(name) as GroupLayer
      expect(eye.kind).toBe('group')
      expect(members(eye.id).length).toBeGreaterThanOrEqual(2)
    }
    const blink = s.group(placed.groupId).behaviors.find((b) => b.type === 'blink')
    expect(blink?.type === 'blink' && blink.eyes).toEqual([s.byName('eye.L').id, s.byName('eye.R').id])
    // The Mouth switch: X holds the dark inside and the teeth, and the other shapes take the mouth's colour.
    const mouth = s.byName('Mouth') as GroupLayer
    const shapes = members(mouth.id)
    expect(shapes.map((l) => l.name)).toEqual(['X', 'MBP', 'E', 'AI', 'O', 'U'])
    const x = shapes[0] as GroupLayer
    expect(x.kind).toBe('group')
    expect(members(x.id).length).toBe(2)
    const ai = shapes[3]
    expect(ai?.kind === 'path' && ai.fills[0]?.type).toBe('solid')
    const aiBox = ai ? layerBox(s.session.project, comp, ai) : null
    const xBox = layerBox(s.session.project, comp, x)
    expect(aiBox?.width).toBeCloseTo(xBox?.width ?? 0, 0)
    expect(aiBox?.height).toBeLessThanOrEqual((xBox?.height ?? 0) + 0.5)
    // The plan's path data is cut short.
    const long = JSON.stringify(result.steps).match(/"[^"]{122,}"/g)
    expect(long ?? []).toEqual([])
    expect(JSON.stringify(result.steps)).toContain('…')
  })

  it('ignores names that only count: three layers called "Part 1", "Part 2", "Part 3"', async () => {
    const s = setup()
    const id = await s.drawn([
      ['Eye 1', 'ellipse', 200, 200, 0, 0],
      ['Eye 2', 'ellipse', 30, 40, 40, -30],
      ['Eye 3', 'ellipse', 30, 40, -40, -30],
      ['Eye 4', 'ellipse', 60, 20, 0, 50],
    ])
    const found = await s.detect(id)
    expect(s.role(found.parts, 'head')?.name).toBe('Eye 1')
    expect(s.role(found.parts, 'eye.L')?.confidence).toBeLessThan(0.6)
    expect(s.role(found.parts, 'mouth')?.name).toBe('Eye 4')
  })

  it('does not take a highlight for an eye or a pupil', async () => {
    const s = setup()
    const id = await s.drawn([
      ['A', 'ellipse', 200, 200, 0, 0],
      ['B', 'ellipse', 40, 44, 40, -30],
      ['C', 'ellipse', 40, 44, -40, -30],
      ['D', 'ellipse', 8, 8, 44, -42],
      ['E', 'ellipse', 8, 8, -36, -42],
      ['F', 'ellipse', 60, 20, 0, 50],
    ])
    const found = await s.detect(id)
    expect(s.role(found.parts, 'eye.L')?.name).toBe('B')
    expect(s.role(found.parts, 'eye.R')?.name).toBe('C')
    expect(found.parts.some((p) => p.role.startsWith('pupil'))).toBe(false)
  })

  const OTHERS = ['Smiling face with smiling eyes', 'Slightly smiling face', 'Grinning squinting face']
  it.skipIf(!OTHERS.every((n) => existsSync(fluentFile(n))))('reports which other flat faces find eyes and mouth', async () => {
    const report: string[] = []
    for (const name of OTHERS) {
      const s = setup({ envelope: async () => ({ rate: 50, values: [0.5] }) })
      const placed = await place(s, fluentFile(name))
      await voiced(s)
      const result = await s.ok('character.bringToLife', { id: placed.groupId })
      report.push(`${name}: eyes ${result.parts.filter((p: PartOut) => p.role.startsWith('eye.')).length}, mouth ${result.parts.some((p: PartOut) => p.role === 'mouth')}, blink ${result.life.blink}, talk ${result.life.talk}`)
    }
    ;(globalThis as unknown as { console: { info(m: string): void } }).console.info(report.join('\n'))
  })
})
