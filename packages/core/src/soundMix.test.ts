import { describe, expect, it } from 'vitest'
import { createDefaultProject } from './doc'
import { sequentialIds } from './ids'
import { readProjectFile, writeProjectFile } from './projectFile'
import type { Comp, Layer, Project } from './schema'
import { Session } from './session'
import { categoryForFileName } from './soundMix'

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
  const comp = () => session.project.comps[0] as Comp
  const layer = (id: string) => comp().tracks.flatMap((t) => t.layers).find((l) => l.id === id) as Layer
  const audio = async (path: string) => {
    const { id: mediaId } = await ok('media.add', { kind: 'audio', path, name: path.replace(/^.*\//, ''), durationMs: 4000, hasAudio: true })
    return (await ok('layer.create', { kind: 'audio', mediaId })).id as string
  }
  return { session, ok, fail, comp, layer, audio }
}

describe('sound categories', () => {
  it('starts with the four built-ins, music ducking under dialogue by 10 dB', () => {
    const project = createDefaultProject(sequentialIds())
    expect(project.soundCategories.map((c) => c.id)).toEqual(['voice', 'music', 'sfx', 'ambience'])
    const music = project.soundCategories[1]
    expect(music?.ducking).toEqual([{ id: 'duck_music_voice', enabled: true, under: { kind: 'bus', id: 'voice' }, depthDb: 10, attackMs: 150, releaseMs: 500 }])
    expect(project.comps[0]?.soundMix).toEqual({
      volume: 1,
      leveler: { enabled: true, mode: 'category', strength: 0.8, tameLoud: true, liftQuiet: false, evenSpeech: true },
      loudness: { enabled: true, targetLufs: -14 },
      limiter: { enabled: true, ceilingDb: -1 },
    })
  })

  it('lists with targets and layer counts; creates, updates and deletes custom ones', async () => {
    const { ok, fail, session, layer, audio } = setup()
    const listed = await ok('sound.category')
    expect(listed.categories.map((c: { id: string; target: number }) => [c.id, c.target])).toEqual([
      ['voice', -16],
      ['music', -20],
      ['sfx', -19],
      ['ambience', -28],
    ])
    const { created } = await ok('sound.category', { action: 'create', name: 'Foley', ducking: [{ under: 'voice', depthDb: 6 }] })
    expect(created).toMatchObject({ name: 'Foley', character: 'sfx', builtIn: false, layers: 0, color: '#ff6b8b' })
    expect(created.ducking[0]).toMatchObject({ under: { kind: 'bus', id: 'voice' }, depthDb: 6, attackMs: 150, releaseMs: 500 })

    const clip = await audio('C:/media/steps.wav')
    await ok('layer.patch', { id: clip, ops: [{ op: 'set', path: 'soundBus', value: created.id }] })
    expect(layer(clip).soundBus).toBe(created.id)
    await ok('sound.category', { action: 'update', id: 'music', ducking: [{ under: { kind: 'bus', id: created.id } }] })
    const foley = (await ok('sound.category', { action: 'update', id: 'Foley', volume: 0.5, targetLufs: -24 })).updated
    expect(foley).toMatchObject({ volume: 0.5, target: -24, layers: 1 })

    expect(await fail('sound.category', { action: 'delete', id: 'voice' })).toContain('built in')
    expect(await fail('sound.category', { action: 'update', id: 'music', ducking: [{ under: 'music' }] })).toContain('itself')
    expect(await fail('sound.category', { action: 'update', id: 'music', ducking: [{ under: 'nope' }] })).toContain('does not exist')

    expect(await ok('sound.category', { action: 'delete', id: created.id })).toEqual({ deleted: created.id, untagged: 1 })
    expect(layer(clip).soundBus).toBeUndefined()
    expect(session.project.soundCategories.find((c) => c.id === 'music')?.ducking).toEqual([])
  })

  it('checks the bus and duck sources a layer names', async () => {
    const { ok, fail, audio } = setup()
    const clip = await audio('C:/media/a.wav')
    expect(await fail('layer.patch', { id: clip, ops: [{ op: 'set', path: 'soundBus', value: 'nope' }] })).toContain('No sound category')
    await ok('layer.patch', { id: clip, ops: [{ op: 'set', path: 'ducking', value: [{ id: 'd1', under: { kind: 'clip', id: clip } }] }] })
    expect(await fail('layer.patch', { id: clip, ops: [{ op: 'set', path: 'ducking', value: [{ id: 'd1', under: { kind: 'clip', id: 'gone' } }] }] })).toContain('does not exist')
  })

  it('tags audio and video by file name', async () => {
    const { ok, layer, audio } = setup()
    expect(layer(await audio('C:/media/intro_vo.wav')).soundBus).toBe('voice')
    expect(layer(await audio('C:/media/Narration take 2.mp3')).soundBus).toBe('voice')
    expect(layer(await audio('C:/media/bgm-loop.mp3')).soundBus).toBe('music')
    expect(layer(await audio('C:/media/rain.ogg')).soundBus).toBe('ambience')
    expect(layer(await audio('C:/media/whoosh 3.wav')).soundBus).toBe('sfx')
    expect(layer(await audio('C:/media/clip.wav')).soundBus).toBeUndefined()
    const { id: mediaId } = await ok('media.add', { kind: 'audio', path: 'C:/media/x.wav', name: 'x.wav', durationMs: 1000 })
    expect(layer((await ok('layer.create', { kind: 'audio', mediaId, soundBus: 'Music' })).id).soundBus).toBe('music')
    expect(categoryForFileName('bravo.wav')).toBeNull()
  })

  it('merges frame.update soundMix and reaches it by patch path', async () => {
    const { ok, comp } = setup()
    await ok('frame.update', { soundMix: { volume: 0.8, leveler: { mode: 'all' }, loudness: { targetLufs: -16 }, limiter: { ceilingDb: -2 } } })
    expect(comp().soundMix).toMatchObject({ volume: 0.8, leveler: { enabled: true, mode: 'all', strength: 0.8 }, loudness: { enabled: true, targetLufs: -16 }, limiter: { enabled: true, ceilingDb: -2 } })
    await ok('frame.update', { ops: [{ op: 'set', path: 'soundMix.leveler.enabled', value: false }] })
    expect(comp().soundMix.leveler.enabled).toBe(false)
  })
})

describe('the mix in the project file', () => {
  it('round-trips, and turns the leveler and limiter off in older files', () => {
    const project = createDefaultProject(sequentialIds())
    const { project: back } = readProjectFile(writeProjectFile(project))
    expect(back.soundCategories).toEqual(project.soundCategories)
    expect(back.comps[0]?.soundMix.leveler.enabled).toBe(true)

    const old = JSON.parse(writeProjectFile(project)) as { formatVersion: number; document: Omit<Project, 'soundCategories'> & { soundCategories?: unknown } }
    old.formatVersion = 11
    delete old.document.soundCategories
    delete (old.document.comps[0] as { soundMix?: unknown }).soundMix
    const { project: migrated } = readProjectFile(JSON.stringify(old))
    expect(migrated.soundCategories.map((c) => c.id)).toEqual(['voice', 'music', 'sfx', 'ambience'])
    expect(migrated.comps[0]?.soundMix).toMatchObject({ volume: 1, leveler: { enabled: false, strength: 0.8 }, loudness: { enabled: false, targetLufs: -14 }, limiter: { enabled: false, ceilingDb: -1 } })
  })

  it('turns the loudness match off in format 12 and 13 files, and keeps it in format 14', () => {
    const project = createDefaultProject(sequentialIds())
    expect(readProjectFile(writeProjectFile(project)).project.comps[0]?.soundMix.loudness).toEqual({ enabled: true, targetLufs: -14 })
    for (const version of [12, 13]) {
      const old = JSON.parse(writeProjectFile(project)) as { formatVersion: number; document: { comps: { soundMix: { loudness?: unknown } }[] } }
      old.formatVersion = version
      delete old.document.comps[0]?.soundMix.loudness
      const { project: migrated } = readProjectFile(JSON.stringify(old))
      expect(migrated.comps[0]?.soundMix).toMatchObject({ leveler: { enabled: true }, loudness: { enabled: false, targetLufs: -14 }, limiter: { enabled: true } })
    }
  })
})
