import { describe, expect, it } from 'vitest'
import { STICKER_ID, type Sticker, searchStickers, slugOf, wordsOf } from './stickers'

const sticker = (id: string, name: string, tags: string[]): Sticker => {
  const [source, style] = id.split('/') as [Sticker['source'], Sticker['style']]
  return { id, name, source, style, tags, path: `C:/stickers/${id}.png` }
}

const stickers = [
  sticker('fluent-emoji/flat/red-heart', 'red heart', ['red', 'heart', 'love', 'emoji', 'flat']),
  sticker('fluent-emoji/3d/red-heart', 'red heart', ['red', 'heart', 'love', 'emoji', '3d']),
  sticker('fluent-emoji/3d/heart-on-fire', 'heart on fire', ['heart', 'fire', 'passion', 'emoji', '3d']),
  sticker('fluent-emoji/3d/rocket', 'rocket', ['rocket', 'space', 'launch', 'emoji', '3d']),
  sticker('open-doodles/drawn/coffee', 'coffee', ['coffee', 'doodle', 'illustration', 'drawn']),
]

describe('searchStickers', () => {
  it('keeps everything for an empty query, 3D first', () => {
    const ids = searchStickers(stickers).map((s) => s.id)
    expect(ids).toHaveLength(5)
    expect(ids.slice(0, 3).every((id) => id.includes('/3d/'))).toBe(true)
  })

  it('needs every word to match', () => {
    expect(searchStickers(stickers, { query: 'heart' }).map((s) => s.name)).toEqual(['heart on fire', 'red heart', 'red heart'])
    expect(searchStickers(stickers, { query: 'red heart' }).map((s) => s.id)).toEqual([
      'fluent-emoji/3d/red-heart',
      'fluent-emoji/flat/red-heart',
    ])
    expect(searchStickers(stickers, { query: 'heart rocket' })).toEqual([])
  })

  it('scores the name above a tag', () => {
    expect(searchStickers(stickers, { query: 'fire' })[0]?.id).toBe('fluent-emoji/3d/heart-on-fire')
    expect(searchStickers(stickers, { query: 'launch' }).map((s) => s.id)).toEqual(['fluent-emoji/3d/rocket'])
  })

  it('requires #tags and filters by style and source', () => {
    expect(searchStickers(stickers, { query: '#flat heart' }).map((s) => s.id)).toEqual(['fluent-emoji/flat/red-heart'])
    expect(searchStickers(stickers, { query: 'heart', style: 'flat' }).map((s) => s.id)).toEqual(['fluent-emoji/flat/red-heart'])
    expect(searchStickers(stickers, { source: 'open-doodles' }).map((s) => s.id)).toEqual(['open-doodles/drawn/coffee'])
  })
})

describe('sticker names', () => {
  it('slugs and splits words', () => {
    expect(slugOf('Red heart')).toBe('red-heart')
    expect(slugOf('Piñata!')).toBe('pinata')
    expect(wordsOf('Smileys & Emotion')).toEqual(['smileys', 'emotion'])
  })

  it('accepts only well-formed ids', () => {
    expect(STICKER_ID.test('fluent-emoji/3d/red-heart')).toBe(true)
    expect(STICKER_ID.test('fluent-emoji/3d/../x')).toBe(false)
    expect(STICKER_ID.test('other/3d/x')).toBe(false)
  })
})
