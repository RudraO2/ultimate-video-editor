import { describe, expect, it } from 'vitest'
import { firstFontFileIn, fontCssUrl, isFontCssUrl } from './fonts'

describe('fontCssUrl with a text', () => {
  it('asks for the glyphs of a text only, for previews', () => {
    expect(fontCssUrl('Anton', 400, 'Aa b')).toBe('https://fonts.googleapis.com/css2?family=Anton:wght@400&text=Aa%20b&display=block')
  })
})

describe('isFontCssUrl', () => {
  it('accepts only the Google Fonts stylesheet API over https', () => {
    expect(isFontCssUrl(fontCssUrl('Anton', 400, 'A'))).toBe(true)
    expect(isFontCssUrl('http://fonts.googleapis.com/css2?family=Anton')).toBe(false)
    expect(isFontCssUrl('https://fonts.googleapis.com/css?family=Anton')).toBe(false)
    expect(isFontCssUrl('https://evil.example/css2?family=Anton')).toBe(false)
    expect(isFontCssUrl('https://fonts.gstatic.com/s/anton/v27/lat.woff2')).toBe(false)
    expect(isFontCssUrl('not a url')).toBe(false)
  })
})

describe('firstFontFileIn', () => {
  it('finds the first font file a stylesheet lists, from the font host only', () => {
    expect(firstFontFileIn('@font-face { src: url(https://fonts.gstatic.com/l/font?kit=abc) format("woff2"); }')).toBe('https://fonts.gstatic.com/l/font?kit=abc')
    expect(firstFontFileIn('nothing here')).toBeNull()
    expect(firstFontFileIn('src: url(https://evil.example/a.woff2)')).toBeNull()
  })
})
