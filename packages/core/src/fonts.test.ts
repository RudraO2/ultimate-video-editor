import { describe, expect, it } from 'vitest'
import { createDefaultProject } from './doc'
import { sequentialIds } from './ids'
import { Session } from './session'

function setup() {
  const ids = sequentialIds()
  const session = new Session({ project: createDefaultProject(ids), ids })
  // biome-ignore lint/suspicious/noExplicitAny: test results are checked field by field
  const ok = async (name: string, input: unknown = {}): Promise<any> => {
    const result = await session.call(name, input)
    if (!result.ok) throw new Error(name + ' failed: ' + result.error)
    return result.value
  }
  const fail = async (name: string, input: unknown) => {
    const result = await session.call(name, input)
    if (result.ok) throw new Error(name + ' should have failed')
    return result.error + '\n' + (result.hint ?? '')
  }
  return { session, ok, fail }
}

const file = { family: 'Acme Sans', path: 'C:/fonts/AcmeSans-Regular.ttf', name: 'AcmeSans-Regular.ttf' }

describe('installed fonts', () => {
  it('registers font files by family, reuses a file already registered, and shows them in the overview', async () => {
    const { session, ok } = setup()
    const first = await ok('fonts.add', file)
    expect(first).toMatchObject({ family: 'Acme Sans' })
    await ok('fonts.add', { ...file, path: 'C:/fonts/AcmeSans-Bold.ttf', name: 'AcmeSans-Bold.ttf', weight: 700 })
    expect(await ok('fonts.add', file)).toMatchObject({ id: first.id, reused: true })
    expect(session.project.fonts.map((f) => [f.family, f.weight, f.italic, f.format])).toEqual([
      ['Acme Sans', 400, false, 'ttf'],
      ['Acme Sans', 700, false, 'ttf'],
    ])
    expect((await ok('doc.overview')).fonts).toEqual(['Acme Sans'])
  })

  it('keeps a variable font with its weight range, and refuses bad input', async () => {
    const { session, ok, fail } = setup()
    await ok('fonts.add', { family: 'Acme Var', path: 'C:/f/var.woff2', name: 'var.woff2', variable: { min: 100, max: 900 }, format: 'woff2' })
    expect(session.project.fonts[0]).toMatchObject({ variable: { min: 100, max: 900 }, format: 'woff2' })
    expect(await fail('fonts.add', { ...file, family: '' })).toContain('family')
    expect(await fail('fonts.add', { ...file, weight: 1200 })).toContain('weight')
    expect(await fail('fonts.add', { ...file, format: 'exe' })).toContain('format')
  })

  it('takes a family out of the project and names the text that still uses it', async () => {
    const { session, ok, fail } = setup()
    await ok('fonts.add', file)
    await ok('fonts.add', { ...file, path: 'C:/fonts/b.ttf', name: 'b.ttf', weight: 700 })
    await ok('layer.create', { kind: 'text', text: 'Hello', style: { fontFamily: 'Acme Sans' } })
    const removed = await ok('fonts.remove', { family: 'Acme Sans' })
    expect(removed).toMatchObject({ removed: 'Acme Sans', files: 2, usedBy: ['Hello'] })
    expect(session.project.fonts).toHaveLength(0)
    expect(await fail('fonts.remove', { family: 'Acme Sans' })).toContain('No installed font family')
    session.undo()
    expect(session.project.fonts).toHaveLength(2)
  })
})
