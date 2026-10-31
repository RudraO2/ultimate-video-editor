import { describe, expect, it } from 'vitest'
import type { RecordingSource } from '../../../shared/recording'
import { matchSource } from './matchSource'

const src = (id: string, kind: RecordingSource['kind'], name: string, primary = false): RecordingSource => ({ id, kind, name, thumbnail: null, primary })

const sources = [src('screen:1:0', 'display', 'Screen 2'), src('screen:0:0', 'display', 'Screen 1', true), src('window:42:0', 'window', 'Notepad - notes.txt')]

describe('matchSource', () => {
  it('takes the main display when nothing or a generic word is given', () => {
    for (const q of [undefined, '', 'screen', 'Display', ' main ']) {
      const m = matchSource(sources, q)
      expect(m.ok && m.source.id).toBe('screen:0:0')
    }
  })
  it('falls back to the first display when none is primary', () => {
    const m = matchSource([src('window:1:0', 'window', 'A'), src('screen:3:0', 'display', 'Screen 3')])
    expect(m.ok && m.source.id).toBe('screen:3:0')
  })
  it('matches an id, an exact name, then a substring, ignoring case', () => {
    expect(matchSource(sources, 'window:42:0')).toMatchObject({ ok: true, source: { id: 'window:42:0' } })
    expect(matchSource(sources, 'screen 2')).toMatchObject({ ok: true, source: { id: 'screen:1:0' } })
    expect(matchSource(sources, 'NOTEPAD')).toMatchObject({ ok: true, source: { id: 'window:42:0' } })
  })
  it('lists the names when nothing matches', () => {
    const m = matchSource(sources, 'chrome')
    expect(m.ok).toBe(false)
    if (!m.ok) expect(m.error).toContain('"Notepad - notes.txt" (window)')
  })
  it('errors when there is no display to default to', () => {
    expect(matchSource([], undefined).ok).toBe(false)
  })
})
