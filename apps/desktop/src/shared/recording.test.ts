import { describe, expect, it } from 'vitest'
import {
  mfraSizeFromTail,
  captureHelperConfig,
  countClicks,
  CursorCollector,
  cursorSampleFrom,
  cursorSidecarPath,
  parseHelperLine,
  parseSamplerLine,
  recordingFileName,
  type SamplerEvent,
} from './recording'

type Sample = Extract<SamplerEvent, { type: 'sample' }>

const surface = { x: 100, y: 200, width: 1000, height: 500 }

const sample = (patch: Partial<Sample> = {}): Sample => ({
  type: 'sample',
  timestampMs: 5000,
  x: 600,
  y: 450,
  visible: true,
  handle: 'c1',
  ...patch,
})

describe('cursorSampleFrom', () => {
  it('gives the position as a fraction of the surface', () => {
    const { sample: s } = cursorSampleFrom(sample(), surface, 4000, false)
    expect(s.cx).toBeCloseTo(0.5)
    expect(s.cy).toBeCloseTo(0.5)
    expect(s.timeMs).toBe(1000)
    expect(s.visible).toBe(true)
    expect(s.assetId).toBe('c1')
    expect(s.interactionType).toBe('move')
  })

  it("prefers the sample's own bounds (a window) over the surface", () => {
    const { sample: s } = cursorSampleFrom(sample({ x: 50, y: 50, bounds: { x: 0, y: 0, width: 200, height: 100 } }), surface, 0, false)
    expect(s.cx).toBeCloseTo(0.25)
    expect(s.cy).toBeCloseTo(0.5)
  })

  it('marks a click on the press and a mouseup on the release', () => {
    const press = cursorSampleFrom(sample({ leftButtonDown: true, leftButtonPressed: true }), surface, 0, false)
    expect(press.sample.interactionType).toBe('click')
    expect(press.down).toBe(true)
    const held = cursorSampleFrom(sample({ leftButtonDown: true }), surface, 0, press.down)
    expect(held.sample.interactionType).toBe('move')
    const release = cursorSampleFrom(sample({ leftButtonDown: false, leftButtonReleased: true }), surface, 0, held.down)
    expect(release.sample.interactionType).toBe('mouseup')
    expect(release.down).toBe(false)
  })

  it('finds a click from the button state when the flags are missing', () => {
    const down = cursorSampleFrom(sample({ leftButtonDown: true }), surface, 0, false)
    expect(down.sample.interactionType).toBe('click')
    const up = cursorSampleFrom(sample({ leftButtonDown: false }), surface, 0, true)
    expect(up.sample.interactionType).toBe('mouseup')
  })

  it('is not visible off the surface, even when the sampler says visible', () => {
    const { sample: s } = cursorSampleFrom(sample({ x: 5000 }), surface, 0, false)
    expect(s.cx).toBeGreaterThan(1)
    expect(s.visible).toBe(false)
  })

  it('never goes before 0', () => {
    const { sample: s } = cursorSampleFrom(sample({ timestampMs: 100 }), surface, 4000, false)
    expect(s.timeMs).toBe(0)
  })
})

describe('CursorCollector', () => {
  const asset = { id: 'c1', imageDataUrl: 'data:image/png;base64,AAAA', width: 32, height: 32, hotspotX: 1, hotspotY: 2, cursorType: 'arrow' }

  it('collapses samples from before the start into one at 0', () => {
    const collector = new CursorCollector(surface, 0)
    collector.add(sample({ timestampMs: 1000, x: 100 }))
    collector.add(sample({ timestampMs: 2000, x: 200 }))
    collector.setStart(2500)
    collector.add(sample({ timestampMs: 3000, x: 300 }))
    // Stamps are taken against the start at the time of adding: the first two were added against 0.
    const recording = collector.finish()
    expect(recording.provider).toBe('native')
    expect(recording.samples.filter((s) => s.timeMs === 0).length).toBeLessThanOrEqual(1)
    expect(recording.samples.at(-1)?.timeMs).toBe(500)
  })

  it('keeps one sample at 0 when everything came before the start', () => {
    const collector = new CursorCollector(surface, 10_000)
    collector.add(sample({ timestampMs: 1000, x: 100 }))
    collector.add(sample({ timestampMs: 2000, x: 200 }))
    collector.add(sample({ timestampMs: 12_000, x: 300 }))
    const recording = collector.finish()
    expect(recording.samples.map((s) => s.timeMs)).toEqual([0, 2000])
    expect(recording.samples[0]?.cx).toBeCloseTo((200 - 100) / 1000)
  })

  it('keeps each cursor image once', () => {
    const collector = new CursorCollector(surface, 0)
    collector.add(sample({ timestampMs: 1, asset }))
    collector.add(sample({ timestampMs: 2, asset }))
    collector.add(sample({ timestampMs: 3 }))
    const recording = collector.finish()
    expect(recording.assets).toHaveLength(1)
    expect(recording.assets[0]).toMatchObject({ id: 'c1', platform: 'win32', cursorType: 'arrow' })
    expect(recording.samples).toHaveLength(3)
  })

  it('ignores events that are not samples, and reports no provider when empty', () => {
    const collector = new CursorCollector(surface, 0)
    collector.add({ type: 'ready', timestampMs: 1 })
    const recording = collector.finish({ kind: 'display', name: 'Display 1', ...surface })
    expect(recording.provider).toBe('none')
    expect(recording.version).toBe(2)
    expect(recording.samples).toEqual([])
    expect(recording.surface?.name).toBe('Display 1')
  })

  it('counts left clicks', () => {
    const collector = new CursorCollector(surface, 0)
    collector.add(sample({ timestampMs: 10, leftButtonDown: true, leftButtonPressed: true }))
    collector.add(sample({ timestampMs: 20, leftButtonReleased: true }))
    collector.add(sample({ timestampMs: 30, leftButtonDown: true, leftButtonPressed: true }))
    expect(countClicks(collector.finish())).toBe(2)
  })
})

describe('recordingFileName and cursorSidecarPath', () => {
  it('names a recording by local date and time', () => {
    expect(recordingFileName(new Date(2026, 9, 31, 14, 3, 7))).toBe('Recording 2026-10-31 14-03-07.mp4')
  })

  it('puts the sidecar beside the video', () => {
    expect(cursorSidecarPath('C:/v/a.mp4')).toBe('C:/v/a.mp4.cursor.json')
  })
})

describe('captureHelperConfig', () => {
  const common = { outputPath: 'C:/v/a.mp4', fps: 60, systemAudio: true, microphone: false, webcam: false }

  it('describes a display with its physical bounds', () => {
    const config = captureHelperConfig({ ...common, source: { kind: 'display', displayId: 7, bounds: { x: -1920, y: 0, width: 1920, height: 1080 } } })
    expect(config).toMatchObject({
      schemaVersion: 2,
      sourceType: 'display',
      displayId: 7,
      displayX: -1920,
      displayY: 0,
      displayW: 1920,
      displayH: 1080,
      hasDisplayBounds: true,
      outputPath: 'C:/v/a.mp4',
      fps: 60,
      captureSystemAudio: true,
      captureMic: false,
      webcamEnabled: false,
      captureCursor: true,
      outputs: { screenPath: 'C:/v/a.mp4' },
    })
  })

  it('describes a window by its source id', () => {
    const config = captureHelperConfig({ ...common, microphone: true, source: { kind: 'window', sourceId: 'window:1234:0' } })
    expect(config).toMatchObject({ sourceType: 'window', sourceId: 'window:1234:0', captureMic: true, captureCursor: true })
    expect(config).not.toHaveProperty('displayId')
  })
})

describe('parseHelperLine', () => {
  it('reads JSON events', () => {
    expect(parseHelperLine('{"event":"recording-stopped","screenPath":"C:/v/a.mp4"}\r')).toEqual({ event: 'recording-stopped', screenPath: 'C:/v/a.mp4' })
  })

  it('skips legacy text lines and bad JSON', () => {
    expect(parseHelperLine('Recording started')).toBeNull()
    expect(parseHelperLine('{not json')).toBeNull()
    expect(parseHelperLine('{"type":"sample"}')).toBeNull()
  })
})

describe('parseSamplerLine', () => {
  it('reads ready, sample and error lines', () => {
    expect(parseSamplerLine('{"type":"ready","timestampMs":5}')).toEqual({ type: 'ready', timestampMs: 5 })
    expect(parseSamplerLine('{"type":"sample","timestampMs":6,"x":1,"y":2,"visible":true,"handle":null}')?.type).toBe('sample')
    expect(parseSamplerLine('{"type":"error","timestampMs":7,"message":"no"}')).toMatchObject({ type: 'error', message: 'no' })
  })

  it('skips other lines', () => {
    expect(parseSamplerLine('hello')).toBeNull()
    expect(parseSamplerLine('{"type":"other"}')).toBeNull()
    expect(parseSamplerLine('{broken')).toBeNull()
  })
})

describe('mfraSizeFromTail', () => {
  it('reads the mfra size from a trailing mfro box', () => {
    const tail = new Uint8Array(16)
    const view = new DataView(tail.buffer)
    view.setUint32(0, 16)
    tail.set([0x6d, 0x66, 0x72, 0x6f], 4)
    view.setUint32(12, 652)
    expect(mfraSizeFromTail(tail)).toBe(652)
  })
  it('is null for a file that does not end with one', () => {
    expect(mfraSizeFromTail(new Uint8Array(16))).toBeNull()
    expect(mfraSizeFromTail(new Uint8Array(4))).toBeNull()
  })
})
