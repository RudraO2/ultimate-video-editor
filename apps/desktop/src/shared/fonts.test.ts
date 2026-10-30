import { describe, expect, it } from 'vitest'
import { fontCssUrl, fontFilesIn } from './fonts'

describe('fontCssUrl', () => {
  it('builds the stylesheet URL the editor loads', () => {
    expect(fontCssUrl('Playfair Display', 700)).toBe('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&display=block')
    expect(fontCssUrl('Anton')).toBe('https://fonts.googleapis.com/css2?family=Anton&display=block')
  })
})

describe('fontFilesIn', () => {
  const css = `/* cyrillic */
@font-face { font-family: 'Anton'; src: url(https://fonts.gstatic.com/s/anton/v27/cyr.woff2) format('woff2'); }
/* latin-ext */
@font-face { font-family: 'Anton'; src: url(https://fonts.gstatic.com/s/anton/v27/ext.woff2) format('woff2'); }
/* latin */
@font-face { font-family: 'Anton'; src: url(https://fonts.gstatic.com/s/anton/v27/lat.woff2) format('woff2'); }
`
  it('lists the files of the wanted subsets only', () => {
    expect(fontFilesIn(css, ['latin', 'latin-ext'])).toEqual([
      'https://fonts.gstatic.com/s/anton/v27/ext.woff2',
      'https://fonts.gstatic.com/s/anton/v27/lat.woff2',
    ])
    expect(fontFilesIn('not css', ['latin'])).toEqual([])
  })
})
