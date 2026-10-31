import { type Comp, createCoreRegistry, createDefaultProject, type Layer, Session } from '@uve/core'
import { describe, expect, it } from 'vitest'
import { screenFrame } from './frameCommand'

let counter = 0
const ids = (prefix: string) => `${prefix}_${++counter}`

async function setup() {
  const registry = createCoreRegistry()
  registry.register(screenFrame)
  const session = new Session({ project: createDefaultProject(ids), registry, ids })
  // biome-ignore lint/suspicious/noExplicitAny: results are checked field by field
  const ok = async (name: string, input: unknown = {}): Promise<any> => {
    const result = await session.call(name, input)
    if (!result.ok) throw new Error(`${name} failed: ${result.error}`)
    return result.value
  }
  const media = await ok('media.add', { kind: 'video', name: 'screen.mp4', path: 'C:/screen.mp4', durationMs: 8000, width: 1280, height: 720 })
  const video = await ok('layer.create', { kind: 'video', mediaId: media.id, startMs: 1000, durationMs: 5000 })
  const comp = () => session.project.comps[0] as Comp
  const layers = () => comp().tracks.flatMap((t) => t.layers)
  const find = (id: string) => layers().find((l) => l.id === id) as Layer
  return { session, ok, video: video.id as string, comp, layers, find }
}

describe('screen.frame', () => {
  it('frames the clip: a masked group with a rounded stencil, a shadow, and a background at the back', async () => {
    const { ok, video, comp, find } = await setup()
    const result = await ok('screen.frame', { id: video })
    expect(Object.keys(result).sort()).toEqual(['backgroundId', 'frameId', 'groupId', 'videoId'])

    const group = find(result.groupId)
    if (group.kind !== 'group') throw new Error('not a group')
    expect(group.name).toBe('Screen frame')
    expect(group.mode).toBe('mask')
    expect(group.layout).toMatchObject({ width: 1280, height: 720, x: -640, y: -360 })
    // 1080 px tall comp, 6 % of it left on each side: the 720 px card scales to fit 950.4 px.
    expect(group.transform.scaleX).toBeCloseTo(950.4 / 720, 5)
    expect(group.transform.scaleY).toBeCloseTo(950.4 / 720, 5)
    expect([group.transform.x, group.transform.y]).toEqual([0, 0])
    expect(group.effects.map((e) => e.type)).toEqual(['shadow'])

    const frame = find(result.frameId)
    expect(frame).toMatchObject({ kind: 'shape', isStencil: true, name: 'Frame', startMs: 1000, durationMs: 5000 })
    if (frame.kind !== 'shape') throw new Error('not a shape')
    expect(frame.shape).toMatchObject({ type: 'rect', width: 1280, height: 720, cornerRadius: 20 })

    // The clip is a member of the group and keeps its own transform.
    const members = comp().tracks.filter((t) => t.groupId === group.id).flatMap((t) => t.layers.map((l) => l.id))
    expect(members).toEqual([result.frameId, video])
    expect(find(video).transform).toMatchObject({ x: 0, y: 0, scaleX: 1, scaleY: 1 })

    // The background is the last (back) lane, over the clip's time, with a gradient.
    const last = comp().tracks[comp().tracks.length - 1]
    expect(last?.layers.map((l) => l.id)).toEqual([result.backgroundId])
    const background = find(result.backgroundId)
    expect(background).toMatchObject({ kind: 'shape', name: 'Background', startMs: 1000, durationMs: 5000 })
    if (background.kind !== 'shape') throw new Error('not a shape')
    expect(background.shape).toMatchObject({ width: 1920, height: 1080 })
    expect(background.fills[0]).toMatchObject({ type: 'linear' })
  })

  it('centres the card where the clip sits and honours padding, radius, shadow and a colour', async () => {
    const { ok, video, find } = await setup()
    await ok('layer.set', { id: video, values: { x: 100, y: -50, scale: 0.5 }, mode: 'base' })
    const result = await ok('screen.frame', { id: video, padding: 0, radius: 200, shadow: false, background: '#102030' })
    const group = find(result.groupId)
    if (group.kind !== 'group') throw new Error('not a group')
    // Footprint 640 x 360 centred at (100, -50); the group moves that centre to the comp's.
    expect(group.layout).toMatchObject({ width: 640, height: 360, x: -220, y: -230 })
    expect([group.transform.x, group.transform.y]).toEqual([-100, 50])
    expect(group.transform.scaleX).toBeCloseTo(3, 5)
    expect(group.effects).toEqual([])
    const frame = find(result.frameId)
    if (frame.kind !== 'shape') throw new Error('not a shape')
    expect(frame.shape.cornerRadius).toBe(180)
    const background = find(result.backgroundId)
    if (background.kind !== 'shape') throw new Error('not a shape')
    expect(background.fills[0]).toMatchObject({ type: 'solid', color: '#102030' })
  })

  it('run again on the same clip updates the frame instead of nesting another', async () => {
    const { ok, video, layers } = await setup()
    const first = await ok('screen.frame', { id: video })
    const second = await ok('screen.frame', { id: video, radius: 40, padding: 0.1, shadow: false, background: 'sunset' })
    expect(second).toEqual(first)
    expect(layers().filter((l) => l.kind === 'group')).toHaveLength(1)
    expect(layers().filter((l) => l.name === 'Background')).toHaveLength(1)
    const group = layers().find((l) => l.id === first.groupId)
    if (group?.kind !== 'group') throw new Error('not a group')
    expect(group.effects).toEqual([])
    expect(group.transform.scaleX).toBeCloseTo(864 / 720, 5)
    const frame = layers().find((l) => l.id === first.frameId)
    if (frame?.kind !== 'shape') throw new Error('not a shape')
    expect(frame.shape.cornerRadius).toBe(40)
  })

  it('refuses a layer that is not a video and a background it does not know', async () => {
    const { session, ok, video } = await setup()
    const rect = await ok('layer.create', { kind: 'shape' })
    const notVideo = await session.call('screen.frame', { id: rect.id })
    expect(notVideo.ok).toBe(false)
    const badBackground = await session.call('screen.frame', { id: video, background: 'plaid' })
    expect(badBackground.ok).toBe(false)
  })
})
