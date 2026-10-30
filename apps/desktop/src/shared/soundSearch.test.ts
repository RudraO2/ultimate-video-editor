import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import notes from './soundNotes.json'
import { packQuality, QUALITY_WEIGHT } from './soundQuality'
import { noteTermsByPack, packMayMatch, parseSoundQuery, plain, rankScore, rankSounds, scoreSound } from './soundSearch'

const sound = (name: string, tags: string[] = [], blurb = '', source: 'pack' | 'project' | 'library' = 'library') => ({ name, tags, blurb, source })

describe('sound search (AtomCut rule)', () => {
  it('splits a query into words and #tags', () => {
    expect(parseSoundQuery('Soft  CLICK #UI #ui-2')).toEqual({ terms: ['soft', 'click'], tags: ['ui', 'ui-2'], allow: [] })
    expect(parseSoundQuery(undefined)).toEqual({ terms: [], tags: [], allow: [] })
  })

  it('lets chiptune and voices in only when a word asks, and drops the words that only choose', () => {
    expect(parseSoundQuery('coin retro')).toEqual({ terms: ['coin'], tags: [], allow: ['retro'] })
    expect(parseSoundQuery('8bit jump')).toEqual({ terms: ['jump'], tags: [], allow: ['retro'] })
    expect(parseSoundQuery('screams')).toEqual({ terms: ['screams'], tags: [], allow: ['voice'] })
    expect(rankScore({ name: 'Jump', tags: [], quality: 'retro' }, parseSoundQuery('8bit jump'))).toBe(100 * QUALITY_WEIGHT.retro)
    expect(rankScore({ name: 'Jump', tags: [], quality: 'retro' }, parseSoundQuery('jump'))).toBe(0)
    expect(rankScore({ name: 'Scream', tags: [], quality: 'voice' }, parseSoundQuery('scream'))).toBeGreaterThan(0)
    expect(rankScore({ name: 'Coin', tags: [], quality: 'retro' }, parseSoundQuery('bell'))).toBe(0)
  })

  it('ranks by quality and by having a note', () => {
    const q = parseSoundQuery('whoosh')
    const found = rankSounds(
      [
        { ...sound('Whoosh'), quality: 'game' as const },
        { ...sound('Whoosh Soft'), quality: 'motion' as const },
        { ...sound('Air', ['whoosh']), quality: 'foley' as const, use: 'Soft airy whoosh: a card sliding in.' },
        { ...sound('Whoosh'), quality: 'retro' as const },
      ],
      q,
    )
    // 60 × 1.6 = 96, 30 × 1.3 + 40 = 79, 100 × 0.8 = 80; retro hidden.
    expect(found.map((s) => s.name)).toEqual(['Whoosh Soft', 'Whoosh', 'Air'])
  })

  it('matches a word in its plain form, and a note like a tag', () => {
    expect(plain('drops')).toBe('drop')
    expect(plain('whooshes')).toBe('whoosh')
    expect(plain('landing')).toBe('land')
    expect(plain('stamped')).toBe('stamp')
    expect(plain('glass')).toBe('glass')
    expect(scoreSound(sound('Drop'), parseSoundQuery('drops'))).toBe(100)
    expect(scoreSound({ name: 'Thud', tags: [], use: 'Soft landing of a card' }, parseSoundQuery('landing'))).toBe(30)
    expect(packMayMatch({ terms: ['drop'], tags: [] }, parseSoundQuery('drops'))).toBe(true)
  })

  it('scores each word by where it matches and sums them', () => {
    const q = (text: string) => parseSoundQuery(text)
    expect(scoreSound(sound('Click'), q('click'))).toBe(100)
    expect(scoreSound(sound('Click Soft'), q('click'))).toBe(60)
    expect(scoreSound(sound('Mouse Click'), q('click'))).toBe(40)
    expect(scoreSound(sound('Tap', ['click']), q('click'))).toBe(30)
    expect(scoreSound(sound('Tap', ['clicks']), q('click'))).toBe(18)
    expect(scoreSound(sound('Tap', [], 'a dry click'), q('click'))).toBe(8)
    expect(scoreSound(sound('Soft Tap', ['click']), q('click soft'))).toBe(30 + 60)
  })

  it('needs every word and every #tag', () => {
    expect(scoreSound(sound('Soft Pad', ['ambient']), parseSoundQuery('click soft'))).toBe(0)
    expect(scoreSound(sound('Click', ['ui']), parseSoundQuery('click #button'))).toBe(0)
    expect(scoreSound(sound('Click', ['ui', 'button']), parseSoundQuery('#button'))).toBe(1)
  })

  it('ranks by score, then source, then name', () => {
    const found = rankSounds([sound('Pop B', ['pop']), sound('Pop', [], '', 'project'), sound('Pop A', ['pop']), sound('Pop', [], '', 'pack')], parseSoundQuery('pop'))
    expect(found.map((s) => `${s.source}:${s.name}`)).toEqual(['pack:Pop', 'project:Pop', 'library:Pop A', 'library:Pop B'])
  })

  it('opens only packs whose terms and tags can match', () => {
    const pack = { terms: ['clicks', 'soft', 'tap'], tags: ['ui'] }
    expect(packMayMatch(pack, parseSoundQuery('click soft'))).toBe(true)
    expect(packMayMatch(pack, parseSoundQuery('click whoosh'))).toBe(false)
    expect(packMayMatch(pack, parseSoundQuery('#impact'))).toBe(false)
  })

  // The library as mirrored on this computer (skipped where there is no mirror).
  const mirror = join(homedir(), 'uve-assets', 'atomcut-sound-library')
  it.skipIf(!existsSync(join(mirror, 'sounds.json')))('finds what AtomCut finds on the whole library', () => {
    const index = JSON.parse(readFileSync(join(mirror, 'index.json'), 'utf8')) as { packs: { id: string; terms: string[]; tagCounts: Record<string, number> }[] }
    const all = (JSON.parse(readFileSync(join(mirror, 'sounds.json'), 'utf8')) as { sounds: { pack: string; id: string; name: string; tags: string[]; blurb: string | null }[] }).sounds
    const noteTerms = noteTermsByPack(notes.notes)
    const search = (text: string, withNotes = false) => {
      const query = parseSoundQuery(text)
      const terms = (p: { id: string; terms: string[] }) => (withNotes ? [...p.terms, ...(noteTerms.get(p.id) ?? [])] : p.terms)
      const open = new Set(index.packs.filter((p) => packMayMatch({ terms: terms(p), tags: Object.keys(p.tagCounts) }, query)).map((p) => p.id))
      return rankSounds(
        all.filter((s) => open.has(s.pack)).map((s) => ({ ...s, source: 'library' as const, quality: packQuality(s.pack), ...(withNotes ? { use: (notes.notes as Record<string, string>)[`${s.pack}/${s.id}`] } : {}) })),
        query,
      )
    }
    expect(search('click soft').map((s) => s.name)).toEqual(['Soft Tap'])
    // A name match outranks a tag match.
    const whoosh = search('whoosh')
    expect(whoosh.length).toBeGreaterThan(5)
    expect(whoosh[0]?.name.toLowerCase()).toMatch(/^whoosh/)
    expect(search('#impact').every((s) => s.tags.includes('impact'))).toBe(true)
    // Our usage notes add what a sound suits: Soft Tap stays first, and a use finds sounds by it.
    expect(search('click soft', true)[0]?.name).toBe('Soft Tap')
    expect(search('logo slam', true).length).toBeGreaterThan(0)
    expect(search('logo slam').length).toBe(0)
    // Quality: no chiptune or voices unless asked, motion packs first.
    const quality = (s: { pack: string }) => packQuality(s.pack)
    for (const word of ['drop', 'pop', 'click', 'jump', 'coin', 'hit', 'whoosh', 'impact']) {
      expect(search(word, true).every((s) => quality(s) !== 'retro' && quality(s) !== 'voice')).toBe(true)
    }
    expect(search('coin retro').some((s) => quality(s) === 'retro')).toBe(true)
    expect(quality(search('whoosh', true)[0]!)).toBe('motion')
    expect(quality(search('impact', true)[0]!)).toBe('motion')
  })
})
