import { type Comp, CompSchema } from '@uve/core'
import { describe, expect, it } from 'vitest'
import {
  fieldsOf,
  formatOf,
  fpsPresetsFor,
  initialForm,
  resolutionOf,
  resolutionScale,
  scaledSize,
  scaleLabel,
  settingsOf,
  summaryOf,
  videoFormatsFor,
} from './dialog'

const comp = (extra: object = {}): Comp =>
  CompSchema.parse({ id: 'comp_1', name: 'Comp', width: 1920, height: 1080, fps: 30, durationMs: 10_000, tracks: [], ...extra })

describe('the export form', () => {
  it('opens as an MP4 of the working range when one is on, else of the whole comp', () => {
    const form = initialForm(comp(), { timeMs: 2500, rangeOn: true })
    expect(formatOf(form)).toBe('mp4')
    expect(form.range).toBe('span')
    expect(form.fps).toBe(30)
    expect(form.atMs).toBe(2500)
    expect(initialForm(comp(), { timeMs: 0, rangeOn: false }).range).toBe('full')
  })

  it('opens a static frame as a PNG still, and keeps the still time inside the comp', () => {
    const form = initialForm(comp({ mode: 'static' }), { timeMs: 99_000, rangeOn: false })
    expect(formatOf(form)).toBe('png')
    expect(form.atMs).toBe(10_000)
  })

  it('offers audio only when the comp makes sound', () => {
    expect(videoFormatsFor(true).map((f) => f.id)).toContain('audio')
    expect(videoFormatsFor(false).map((f) => f.id)).not.toContain('audio')
  })
})

describe('the rows of each format', () => {
  it('shows transparency only where the format keeps it', () => {
    const keeps = ['mov', 'webm', 'gif', 'png-seq', 'png', 'webp'] as const
    for (const f of keeps) expect(fieldsOf(f, false).transparent).toBe(true)
    for (const f of ['mp4', 'audio', 'jpg'] as const) expect(fieldsOf(f, false).transparent).toBe(false)
  })

  it('shows the range only for moving formats with a working range on', () => {
    expect(fieldsOf('mp4', true).range).toBe(true)
    expect(fieldsOf('audio', true).range).toBe(true)
    expect(fieldsOf('mp4', false).range).toBe(false)
    expect(fieldsOf('png', true).range).toBe(false)
  })

  it('hides size and frame rate for audio, and frame rate for stills', () => {
    expect(fieldsOf('audio', false)).toMatchObject({ size: false, fps: false, motionBlur: false, includeAudio: false })
    expect(fieldsOf('jpg', false)).toMatchObject({ size: true, fps: false, atMs: true, quality: true, audioBitrate: false })
    expect(fieldsOf('gif', false)).toMatchObject({ includeAudio: false, quality: false })
    expect(fieldsOf('webm', false)).toMatchObject({ includeAudio: true, quality: true, audioBitrate: true })
  })
})

describe('settings from the form', () => {
  it('sends only what the format uses', () => {
    const form = { ...initialForm(comp(), { timeMs: 1000, rangeOn: false }), transparent: true, quality: 'master' as const }
    expect(settingsOf(form, false)).toEqual({
      format: 'mp4',
      motionBlur: true,
      scale: 1,
      range: 'full',
      fps: 30,
      includeAudio: true,
      quality: 'master',
      audioBitrate: 192,
    })
    expect(settingsOf({ ...form, videoFormat: 'gif' }, false)).toEqual({
      format: 'gif',
      motionBlur: true,
      scale: 1,
      range: 'full',
      fps: 30,
      transparent: true,
    })
  })

  it('sends a still its time and no range or frame rate', () => {
    const form = { ...initialForm(comp(), { timeMs: 1500, rangeOn: true }), kind: 'image' as const, imageFormat: 'webp' as const }
    expect(settingsOf(form, true)).toEqual({ format: 'webp', motionBlur: true, scale: 1, transparent: false, atMs: 1500, quality: 'high' })
  })

  it('sends the working range only when one is on', () => {
    const form = initialForm(comp(), { timeMs: 0, rangeOn: true })
    expect(settingsOf(form, true).range).toBe('span')
    expect(settingsOf({ ...form, range: 'full' }, true).range).toBe('full')
    expect(settingsOf({ ...form, videoFormat: 'audio' }, true)).toEqual({ format: 'audio', motionBlur: true, range: 'span' })
  })
})

describe('size and frame rate presets', () => {
  it('maps a resolution to the scale of the short side', () => {
    expect(resolutionScale(comp(), 720)).toBeCloseTo(2 / 3)
    expect(resolutionScale(comp({ width: 1080, height: 1920 }), 2160)).toBe(2)
    expect(resolutionScale(comp({ width: 100, height: 100 }), 2160)).toBeNull()
    expect(resolutionOf(comp(), 1)?.label).toBe('1080p')
    expect(resolutionOf(comp(), 1.5)).toBeUndefined()
  })

  it('rounds sizes as the export does', () => {
    expect(scaledSize(comp(), 2 / 3)).toEqual({ width: 1280, height: 720 })
    expect(scaledSize(comp({ width: 1001, height: 501 }), 1)).toEqual({ width: 1000, height: 500 })
    expect(scaleLabel(2 / 3)).toBe('0.67×')
    expect(scaleLabel(1)).toBe('1×')
  })

  it('caps GIF presets at 50 fps', () => {
    expect(Math.max(...fpsPresetsFor('gif').map((p) => p.fps))).toBe(50)
    expect(Math.max(...fpsPresetsFor('mp4').map((p) => p.fps))).toBe(120)
  })
})

describe('the summary line', () => {
  const plan = { width: 1280, height: 720, fps: 23.976, durationMs: 10_010 }
  it('reads as AtomCut', () => {
    expect(summaryOf('mp4', plan)).toBe('1280×720 · 23.976 fps · 10.0s')
    expect(summaryOf('audio', plan)).toBe('10.0s')
    expect(summaryOf('png', plan, 1500)).toBe('1280×720 · at 1.5s')
  })
})
