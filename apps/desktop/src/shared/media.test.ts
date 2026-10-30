import { describe, expect, it } from 'vitest'
import { baseName, mediaPathFromUrl, mediaTypeOf, mediaUrl, parseByteRange } from './media'

describe('media URLs', () => {
  it('round-trips Windows and POSIX paths, including awkward characters', () => {
    for (const path of ['C:\\Users\\me\\Videos\\clip 1 (final).mp4', '/home/me/a#b?c%20d.webm', 'D:\\données\\vidéo.mov']) {
      expect(mediaPathFromUrl(mediaUrl(path))).toBe(path)
    }
  })

  it('keeps the whole path in one segment, so dot segments cannot escape', () => {
    const url = mediaUrl('C:\\media\\..\\secret.mp4')
    expect(new URL(url).pathname.split('/')).toHaveLength(2)
    expect(mediaPathFromUrl(url)).toBe('C:\\media\\..\\secret.mp4')
  })

  it('rejects other URLs', () => {
    expect(mediaPathFromUrl('https://example.com/clip.mp4')).toBeNull()
    expect(mediaPathFromUrl('uve-media://other/C%3A%5Cclip.mp4')).toBeNull()
    expect(mediaPathFromUrl('uve-media://file/')).toBeNull()
    expect(mediaPathFromUrl('uve-media://file/%E0%A4%A')).toBeNull()
  })
})

describe('media types', () => {
  it('reads the kind and MIME type from the extension', () => {
    expect(mediaTypeOf('Clip.MP4')).toEqual({ kind: 'video', mime: 'video/mp4' })
    expect(mediaTypeOf('voice.m4a')?.kind).toBe('audio')
    expect(mediaTypeOf('logo.svg')?.kind).toBe('image')
    expect(mediaTypeOf('notes.txt')).toBeNull()
    expect(mediaTypeOf('mp4')).toBeNull()
    expect(mediaTypeOf('x.constructor')).toBeNull()
  })

  it('takes the file name from either kind of path', () => {
    expect(baseName('C:\\a\\b\\clip.mp4')).toBe('clip.mp4')
    expect(baseName('/a/b/song.mp3')).toBe('song.mp3')
    expect(baseName('still.png')).toBe('still.png')
  })
})

describe('byte ranges', () => {
  it('reads the forms media elements and fetch send', () => {
    expect(parseByteRange('bytes=0-', 1000)).toEqual({ start: 0, end: 999 })
    expect(parseByteRange('bytes=100-199', 1000)).toEqual({ start: 100, end: 199 })
    expect(parseByteRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseByteRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
  })

  it('sends the whole file for no range or ranges it does not serve', () => {
    expect(parseByteRange(null, 1000)).toBeNull()
    expect(parseByteRange('bytes=0-10,20-30', 1000)).toBeNull()
    expect(parseByteRange('items=0-1', 1000)).toBeNull()
  })

  it('refuses ranges outside the file', () => {
    expect(parseByteRange('bytes=1000-', 1000)).toBe('unsatisfiable')
    expect(parseByteRange('bytes=500-100', 1000)).toBe('unsatisfiable')
    expect(parseByteRange('bytes=-0', 1000)).toBe('unsatisfiable')
    expect(parseByteRange('bytes=0-', 0)).toBe('unsatisfiable')
  })
})
