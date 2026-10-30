import { createDefaultProject, Session } from '@uve/core'
import { describe, expect, it } from 'vitest'
import { type ContextState, editorContext } from './chatContext'

async function stateWithText(text: string): Promise<ContextState & { layerId: string }> {
  const session = new Session({ project: createDefaultProject() })
  const created = await session.call('layer.create', { kind: 'text', name: 'Title', text, startMs: 500, durationMs: 2000 })
  if (!created.ok) throw new Error(created.error)
  const project = session.project
  const comp = project.comps[0]!
  const layer = comp.tracks.flatMap((t) => t.layers)[0]!
  return { project, activeCompId: comp.id, timeMs: 1234.6, selectedLayerId: layer.id, layerId: layer.id }
}

describe('editorContext', () => {
  it('describes the open comp, the playhead and the selected text layer', async () => {
    const state = await stateWithText('Ship Happens')
    const lines = editorContext(state).split('\n')
    expect(lines[0]).toBe('Editor context (where the person is; "this" and "here" mean the selection and the playhead):')
    expect(lines[1]).toMatch(/^Open comp: ".+" \(id .+\), \d+x\d+, \d+ fps, \d+ ms long$/)
    expect(lines[2]).toBe('Playhead: 1235 ms')
    expect(lines[3]).toBe(`Selected layer: "Title" (id ${state.layerId}), text, 500-2500 ms, track 0`)
    expect(lines[4]).toBe('Selected text: "Ship Happens"')
    expect(lines).toHaveLength(5)
  })

  it('cuts a long text and flattens its lines', async () => {
    const state = await stateWithText(`first\nsecond ${'x'.repeat(400)}`)
    const text = editorContext(state).split('\n').find((l) => l.startsWith('Selected text'))!
    expect(text).not.toContain('\n')
    expect(text.startsWith('Selected text: "first second x')).toBe(true)
    expect(text.length).toBeLessThan(240)
    expect(text.endsWith('…"')).toBe(true)
  })

  it('says so when nothing is selected', async () => {
    const state = await stateWithText('Hi')
    const context = editorContext({ ...state, selectedLayerId: null })
    expect(context).toContain('Selected layer: nothing selected')
    expect(context).not.toContain('Selected text')
  })

  it('treats a selection that no longer exists as nothing', async () => {
    const state = await stateWithText('Hi')
    expect(editorContext({ ...state, selectedLayerId: 'gone' })).toContain('nothing selected')
  })

  it('adds the editor mode when the state has one', async () => {
    const state = await stateWithText('Hi')
    expect(editorContext({ ...state, uiMode: 'easy' } as ContextState)).toMatch(/\nEditor mode: easy$/)
    expect(editorContext(state)).not.toContain('Editor mode')
  })
})
