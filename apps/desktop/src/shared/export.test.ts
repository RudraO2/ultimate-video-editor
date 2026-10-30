import { describe, expect, it } from 'vitest'
import {
  EXPORT_EXTENSIONS,
  exportFileName,
  exportFolderName,
  isExportExtension,
  numberedFolder,
  numberedPath,
  SEQUENCE_FILE,
  withExtension,
} from './export'

describe('isExportExtension', () => {
  it('accepts the export extensions only', () => {
    for (const extension of EXPORT_EXTENSIONS) expect(isExportExtension(extension)).toBe(true)
    expect(isExportExtension('mov')).toBe(true)
    expect(isExportExtension('gif')).toBe(true)
    expect(isExportExtension('jpg')).toBe(true)
    expect(isExportExtension('avi')).toBe(false)
    expect(isExportExtension('MP4')).toBe(false)
    expect(isExportExtension(undefined)).toBe(false)
    expect(isExportExtension(4)).toBe(false)
  })
})

describe('exportFileName', () => {
  it('makes a file name from a comp name', () => {
    expect(exportFileName('Comp 1')).toBe('Comp 1.mp4')
  })

  it('takes the extension of the format', () => {
    expect(exportFileName('Comp 1', 'webm')).toBe('Comp 1.webm')
    expect(exportFileName(' ?* ', 'wav')).toBe('Export.wav')
  })

  it('drops characters Windows does not allow, and trailing dots', () => {
    expect(exportFileName('Intro: take 2/3?')).toBe('Intro take 23.mp4')
    expect(exportFileName('Final...')).toBe('Final.mp4')
  })

  it('falls back to "Export" when nothing usable is left', () => {
    expect(exportFileName(' ?* ')).toBe('Export.mp4')
  })
})

describe('export paths', () => {
  it('adds the extension only when missing', () => {
    expect(withExtension('C:/v/a.MP4', 'mp4')).toBe('C:/v/a.MP4')
    expect(withExtension('C:/v/a', 'mp4')).toBe('C:/v/a.mp4')
    expect(withExtension('C:/v/a.webm', 'webm')).toBe('C:/v/a.webm')
    expect(withExtension('C:/v/a.WAV', 'wav')).toBe('C:/v/a.WAV')
    expect(withExtension('C:/v/a', 'wav')).toBe('C:/v/a.wav')
    expect(withExtension('C:/v/a.mp4', 'webm')).toBe('C:/v/a.mp4.webm')
  })

  it('numbers a taken name before its extension', () => {
    expect(numberedPath('C:/v/Comp 1.mp4', 2)).toBe('C:/v/Comp 1 (2).mp4')
    expect(numberedPath('C:/v/Comp 1.webm', 2)).toBe('C:/v/Comp 1 (2).webm')
    expect(numberedPath('C:/v/Comp 1.wav', 3)).toBe('C:/v/Comp 1 (3).wav')
  })

  it('numbers a name without an extension at its end', () => {
    expect(numberedPath('C:/v/Comp 1', 2)).toBe('C:/v/Comp 1 (2)')
  })

  it('ignores dots in folder names', () => {
    expect(numberedPath('C:/my.videos/Comp 1', 2)).toBe('C:/my.videos/Comp 1 (2)')
    expect(numberedPath('C:\\my.videos\\Comp 1.webm', 2)).toBe('C:\\my.videos\\Comp 1 (2).webm')
  })
})

describe('image extensions', () => {
  it('lists the image and gif types', () => {
    expect([...EXPORT_EXTENSIONS]).toEqual(['mp4', 'mov', 'webm', 'wav', 'gif', 'png', 'jpg', 'webp'])
    expect(exportFileName('Comp 1', 'png')).toBe('Comp 1.png')
    expect(withExtension('C:/v/a', 'gif')).toBe('C:/v/a.gif')
  })
})

describe('folder exports', () => {
  it('names the folder after the comp', () => {
    expect(exportFolderName('Comp 1')).toBe('Comp 1-png-seq')
    expect(exportFolderName('')).toBe('Export-png-seq')
    expect(exportFolderName('Intro: take 2/3?')).toBe('Intro take 23-png-seq')
  })

  it('numbers a taken folder at its end', () => {
    expect(numberedFolder('C:/v/Comp 1-png-seq', 2)).toBe('C:/v/Comp 1-png-seq (2)')
    expect(numberedFolder('C:/my.videos/Comp', 3)).toBe('C:/my.videos/Comp (3)')
  })

  it('accepts sequence frame names only', () => {
    expect(SEQUENCE_FILE.test('frame-000.png')).toBe(true)
    expect(SEQUENCE_FILE.test('frame-123456789.png')).toBe(true)
    expect(SEQUENCE_FILE.test('frame-1234567890.png')).toBe(false)
    expect(SEQUENCE_FILE.test('frame-.png')).toBe(false)
    expect(SEQUENCE_FILE.test('frame-001.jpg')).toBe(false)
    expect(SEQUENCE_FILE.test('../frame-001.png')).toBe(false)
    expect(SEQUENCE_FILE.test('sub/frame-001.png')).toBe(false)
    expect(SEQUENCE_FILE.test('frame-001.png\n')).toBe(false)
  })
})
