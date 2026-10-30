import { CommandError } from '@uve/core'
import { describe, expect, it } from 'vitest'
import { isStillFormat, parseExportFormat } from './formats'

describe('parseExportFormat', () => {
  it('forgives case, a leading dot and spaces', () => {
    expect(parseExportFormat('MP4')).toBe('mp4')
    expect(parseExportFormat(' .mp4 ')).toBe('mp4')
    expect(parseExportFormat('mpeg4')).toBe('mp4')
  })

  it('reads WebM and audio only, with their aliases', () => {
    expect(parseExportFormat('WebM')).toBe('webm')
    expect(parseExportFormat('audio')).toBe('audio')
    expect(parseExportFormat('.wav')).toBe('audio')
    expect(parseExportFormat('audio-only')).toBe('audio')
  })

  it('reads MOV, also as quicktime', () => {
    expect(parseExportFormat('MOV')).toBe('mov')
    expect(parseExportFormat('quicktime')).toBe('mov')
  })

  it('reads the image formats and their aliases', () => {
    expect(parseExportFormat('GIF')).toBe('gif')
    expect(parseExportFormat('png_seq')).toBe('png-seq')
    expect(parseExportFormat('png-sequence')).toBe('png-seq')
    expect(parseExportFormat('.png')).toBe('png')
    expect(parseExportFormat('image')).toBe('png')
    expect(parseExportFormat('jpeg')).toBe('jpg')
    expect(parseExportFormat('webp')).toBe('webp')
  })

  it('refuses an unknown format and lists the ids', () => {
    expect(() => parseExportFormat('avi')).toThrow(/not an export format/)
    try {
      parseExportFormat('avi')
    } catch (e) {
      expect(e).toBeInstanceOf(CommandError)
      expect((e as CommandError).hint).toContain('png-seq')
    }
  })
})

describe('isStillFormat', () => {
  it('is true for the one-frame images only', () => {
    expect(['png', 'jpg', 'webp'].every((f) => isStillFormat(parseExportFormat(f)))).toBe(true)
    expect(['png-seq', 'gif', 'mp4', 'mov'].some((f) => isStillFormat(parseExportFormat(f)))).toBe(false)
  })
})
