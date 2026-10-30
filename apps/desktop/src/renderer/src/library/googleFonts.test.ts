import { describe, expect, it } from 'vitest'
import { filterFamilies, findFamily, googleCatalogue } from './googleFonts'

describe('the Google Fonts catalogue', () => {
  it('has every family with its category, weights and tags', async () => {
    const { families, categories } = await googleCatalogue()
    expect(families.length).toBeGreaterThan(1900)
    expect(categories).toEqual(['Sans', 'Serif', 'Display', 'Handwriting', 'Mono'])
    const roboto = findFamily(families, 'roboto')
    expect(roboto).toMatchObject({ family: 'Roboto', category: 'Sans', rank: 0 })
    expect(roboto?.variable).toEqual({ min: 100, max: 900 })
    expect(roboto?.styles).toContain('Neo Grotesque')
    const anton = findFamily(families, 'Anton')
    expect(anton?.weights).toEqual([400])
    expect(anton?.variable).toBeNull()
    expect(new Set(families.map((f) => f.family)).size).toBe(families.length)
  })

  it('filters by words, category, feeling and flags, and puts a name that starts with the query first', async () => {
    const { families } = await googleCatalogue()
    const mono = filterFamilies(families, { category: 'mono' })
    expect(mono.length).toBeGreaterThan(40)
    expect(mono.every((f) => f.category === 'Mono')).toBe(true)
    const calm = filterFamilies(families, { feeling: 'Calm' })
    expect(calm.length).toBeGreaterThan(10)
    expect(calm.every((f) => f.feelings.includes('Calm'))).toBe(true)
    expect(filterFamilies(families, { variable: true }).every((f) => f.variable)).toBe(true)
    expect(filterFamilies(families, { italic: true }).every((f) => f.italicWeights.length > 0)).toBe(true)
    const play = filterFamilies(families, { query: 'play' })
    expect(play[0]?.family.toLowerCase().startsWith('play')).toBe(true)
    expect(filterFamilies(families, { query: 'zzzz nothing' })).toEqual([])
    expect(filterFamilies(families, { query: 'geometric sans' }).length).toBeGreaterThan(5)
  })

  it('sorts by popularity, name or newest', async () => {
    const { families } = await googleCatalogue()
    expect(filterFamilies(families, {}, 'popular')[0]?.family).toBe('Roboto')
    const byName = filterFamilies(families, {}, 'name').slice(0, 20).map((f) => f.family)
    expect(byName).toEqual([...byName].sort((a, b) => a.localeCompare(b)))
    const newest = filterFamilies(families, {}, 'newest')
    expect((newest[0]?.year ?? 0) >= (newest[100]?.year ?? 0)).toBe(true)
  })
})
