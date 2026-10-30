import { describe, expect, it } from 'vitest'
import { createDefaultProject } from './doc'
import { sequentialIds } from './ids'
import { readProjectFile, writeProjectFile } from './projectFile'
import type { Comp } from './schema'
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
  const fail = async (name: string, input: unknown) => {
    const result = await session.call(name, input)
    if (result.ok) throw new Error(`${name} should have failed`)
    return result.error
  }
  const comp = () => session.project.comps[0] as Comp
  return { session, ok, fail, comp }
}

const footage = {
  gate: { gateDb: -38, troughDb: -60, peakDb: -23 },
  speech: [
    { startMs: 400, endMs: 2000 },
    { startMs: 3500, endMs: 6000 },
  ],
  sceneThreshold: 0.3,
  shots: [
    { startMs: 0, endMs: 3000, score: 0 },
    { startMs: 3000, endMs: 6500, score: 0.6 },
  ],
}

describe('media.footage and media.describe_shots', () => {
  it('keeps the analysis on the media, describes shots, and survives a save', async () => {
    const { session, ok, fail } = setup()
    const media = await ok('media.add', { kind: 'video', name: 'talk.mp4', path: 'C:/talk.mp4', durationMs: 6500 })
    await fail('media.describe_shots', { mediaId: media.id, shots: [{ index: 0, description: 'x' }] })
    await ok('media.footage', { mediaId: media.id, footage })
    expect(session.project.media[0]?.footage?.shots[1]?.description).toBeNull()
    expect(await fail('media.describe_shots', { mediaId: media.id, shots: [{ index: 2, description: 'x' }] })).toContain('no shot 2')
    await ok('media.describe_shots', { mediaId: media.id, shots: [{ index: 1, description: '  Screen recording of the editor  ' }] })
    expect(session.project.media[0]?.footage?.shots[1]?.description).toBe('Screen recording of the editor')
    const back = readProjectFile(writeProjectFile(session.project))
    expect(back.project.media[0]?.footage?.speech).toEqual(footage.speech)
    session.undo()
    expect(session.project.media[0]?.footage?.shots[1]?.description).toBeNull()
  })

  it('refuses spans out of order and media without sound', async () => {
    const { ok, fail } = setup()
    const media = await ok('media.add', { kind: 'video', name: 'talk.mp4', path: 'C:/talk.mp4', durationMs: 6500 })
    expect(await fail('media.footage', { mediaId: media.id, footage: { ...footage, speech: [{ startMs: 3000, endMs: 4000 }, { startMs: 100, endMs: 200 }] } })).toContain('out of order')
    const picture = await ok('media.add', { kind: 'image', name: 'a.png', path: 'C:/a.png' })
    expect(await fail('media.footage', { mediaId: picture.id, footage })).toContain('not footage')
  })
})

describe('timeline.markers', () => {
  it('adds, lists, replaces a kind and removes marks', async () => {
    const { ok, fail, comp } = setup()
    const made = await ok('timeline.markers', {
      add: [
        { startMs: 2000, endMs: 2600, kind: 'cut', label: 'pause of 1.2 s' },
        { startMs: 500, kind: 'flag', label: 'check this' },
      ],
    })
    expect(made.added).toHaveLength(2)
    expect(comp().markers.map((m) => [m.startMs, m.durationMs, m.kind])).toEqual([
      [500, 0, 'flag'],
      [2000, 600, 'cut'],
    ])
    await ok('timeline.markers', { remove: 'cut', add: [{ startMs: 100, endMs: 300, kind: 'cut' }] })
    expect(comp().markers.map((m) => m.startMs)).toEqual([100, 500])
    expect((await ok('timeline.markers', {})).markers).toHaveLength(2)
    expect(await fail('timeline.markers', { remove: ['marker_nope'] })).toContain('no marker')
    await ok('timeline.markers', { remove: 'all' })
    expect(comp().markers).toEqual([])
  })
})
