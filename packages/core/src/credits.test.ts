import { describe, expect, it } from 'vitest'
import { creditLine, creditsOf } from './credits'
import { createDefaultProject } from './doc'
import { sequentialIds } from './ids'
import { Session } from './session'

describe('credits', () => {
  it('lists library sounds and icon sets in use, once each, and follows the document', async () => {
    const ids = sequentialIds()
    const session = new Session({ project: createDefaultProject(ids), ids })
    expect(creditsOf(session.project)).toEqual([])

    await session.call('media.add', {
      kind: 'audio',
      name: 'Pop 3.wav',
      path: 'C:/sounds/pop.wav',
      durationMs: 400,
      credit: { source: 'AtomCut sound library', license: 'CC0-1.0', attribution: 'Kenney' },
    })
    const svg = '<svg viewBox="0 0 8 8"><rect width="8" height="8" fill="#fff"/></svg>'
    const origin = (id: string) => ({ kind: 'icon', id, license: 'MIT', author: 'Lucide Contributors' })
    const first = await session.call('svg.place', { svg, origin: origin('lucide:house') })
    await session.call('svg.place', { svg, origin: origin('lucide:camera') })
    await session.call('svg.place', { svg, origin: { kind: 'icon', id: 'twemoji:red-heart', license: 'CC-BY-4.0', author: 'Twitter' } })

    const credits = creditsOf(session.project)
    expect(credits.map((c) => [c.kind, c.name, c.license, c.credit, c.uses])).toEqual([
      ['sound', 'Pop 3.wav', 'CC0-1.0', 'Kenney', undefined],
      ['icon', 'lucide icons', 'MIT', 'Lucide Contributors', 2],
      ['icon', 'twemoji icons', 'CC-BY-4.0', 'Twitter', 1],
    ])
    expect(creditLine(credits[1] as NonNullable<(typeof credits)[number]>)).toBe('lucide icons by Lucide Contributors (MIT)')
    expect(creditLine(credits[0] as NonNullable<(typeof credits)[number]>)).toBe('Pop 3.wav: Kenney (CC0-1.0)')

    // The overview carries them for an agent to cite.
    const overview = await session.call('doc.overview', {})
    expect(overview.ok && (overview.value as { credits: { line: string }[] }).credits.map((c) => c.line)).toHaveLength(3)

    // Deleting the layers takes the credit away.
    if (first.ok) await session.call('layers.delete', { ids: (first.value as { ids: string[] }).ids })
    expect(creditsOf(session.project).find((c) => c.name === 'lucide icons')?.uses).toBe(1)
  })
})
