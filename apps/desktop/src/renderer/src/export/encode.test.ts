import { describe, expect, it } from 'vitest'
import { encodeSpecOf, interleavePcm16 } from './encode'

describe('interleavePcm16', () => {
  it('interleaves the channels and rounds as mediabunny writes pcm-s16', () => {
    const out = interleavePcm16({ left: new Float32Array([0, 0.5, -1, 1.5]), right: new Float32Array([1, -0.5, -2, 1 / 32768]) })
    expect([...out]).toEqual([0, 32767, 16384, -16384, -32768, -32768, 32767, 1])
  })

  it('is empty for no samples', () => {
    expect(interleavePcm16({ left: new Float32Array(0), right: new Float32Array(0) }).length).toBe(0)
  })
})

describe('encodeSpecOf', () => {
  it('writes MOV as PNG frames and 16-bit PCM through our own muxer, with alpha', () => {
    const mov = encodeSpecOf('mov')
    expect(mov).toMatchObject({ extension: 'mov', container: 'mov', video: 'png', alpha: true, audio: { codec: 'pcm-s16', compressed: false } })
  })

  it('keeps alpha for MOV, WebM, GIF, PNG sequences, PNG and WebP, not MP4, audio or JPG', () => {
    for (const format of ['mov', 'webm', 'gif', 'png-seq', 'png', 'webp'] as const) expect(encodeSpecOf(format).alpha).toBe(true)
    for (const format of ['mp4', 'audio', 'jpg'] as const) expect(encodeSpecOf(format).alpha).toBe(false)
  })

  it('writes images with no sound, GIF at most 50 fps', () => {
    expect(encodeSpecOf('gif')).toMatchObject({ extension: 'gif', container: 'gif', video: 'gif', maxFps: 50, audio: null })
    expect(encodeSpecOf('png-seq')).toMatchObject({ extension: 'png', container: 'png-seq', video: 'png', audio: null })
    expect(encodeSpecOf('jpg')).toMatchObject({ extension: 'jpg', container: 'still', video: 'jpeg', audio: null })
    expect(encodeSpecOf('webp')).toMatchObject({ extension: 'webp', container: 'still', video: 'webp' })
  })
})
