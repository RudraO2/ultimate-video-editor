// Screen recording, shared by the main process (which runs OpenScreen's capture
// helpers) and the renderer (which asks for a recording and imports the file).
// Plain TypeScript only: no Node or DOM APIs.
//
// The cursor sidecar keeps OpenScreen's layout (`<video>.cursor.json`, version 2,
// samples with cx/cy as fractions of the captured surface), and the sample
// normalisation below is ported from OpenScreen's
// electron/native-bridge/cursor/recording/windowsNativeRecordingSession.ts
// (MIT, copyright Siddharth Vaddem and the OpenScreen contributors,
// https://github.com/getopenscreen/openscreen).

/** Something that can be recorded: a whole display or one window. */
export interface RecordingSource {
  /** desktopCapturer's id: `screen:<n>:0` or `window:<hwnd>:0`. */
  id: string
  kind: 'display' | 'window'
  name: string
  /** A small picture of it (data URL), for the picker. */
  thumbnail: string | null
  /** The main display (displays only). */
  primary: boolean
}

/** What to record, as the renderer asks for it. */
export interface RecordingOptions {
  /** A RecordingSource id; default the main display. */
  sourceId?: string
  /** The computer's sound (what plays through the speakers). Default true. */
  systemAudio?: boolean
  /** The default microphone. Default false. */
  microphone?: boolean
  /** The default webcam, as a picture-in-picture in the bottom-right corner. Default false. */
  webcam?: boolean
  /** 30 or 60. Default 60. */
  fps?: 30 | 60
  /** Stop by itself after this long (ms). Default: until Stop is pressed. */
  durationMs?: number
}

/** Where the recorder is; pushed to the renderer on every change. */
export type RecorderState =
  | { state: 'idle' }
  | { state: 'starting'; sourceName: string }
  | { state: 'recording'; sourceName: string; startedAt: number; durationMs: number | null }
  | { state: 'stopping'; sourceName: string }

/** A finished recording. The file is granted to the renderer already. */
export interface RecordingResult {
  /** Absolute path of the MP4. */
  path: string
  name: string
  size: number
  /** Absolute path of the cursor sidecar, or null when no cursor data was kept. */
  cursorPath: string | null
  sourceName: string
  /** Wall-clock length from start to stop (the file's own length may differ by a frame). */
  elapsedMs: number
  /** Cursor samples and left clicks kept beside it. */
  cursorSamples: number
  clicks: number
}

/** The recording failed or was refused; `hint` says what to do. */
export interface RecordingError {
  error: string
  hint?: string
}

/** What a recording ends in: the finished file, or why there is none. */
export type RecordingOutcome = ({ ok: true } & RecordingResult) | ({ ok: false } & RecordingError)

/** One cursor sample in the sidecar (OpenScreen's CursorRecordingSample). */
export interface CursorSample {
  /** Since the recording started (ms). */
  timeMs: number
  /** Position as a fraction of the captured surface (0 left/top, 1 right/bottom; outside when off it). */
  cx: number
  cy: number
  /** The cursor image (an id in `assets`), or null. */
  assetId: string | null
  visible: boolean
  /** arrow, text, pointer, … as the sampler names it, or null. */
  cursorType: string | null
  interactionType: 'move' | 'click' | 'mouseup'
}

/** A cursor image seen during the recording. */
export interface CursorAsset {
  id: string
  platform: 'win32'
  imageDataUrl: string
  width: number
  height: number
  hotspotX: number
  hotspotY: number
  cursorType: string | null
}

/** The sidecar file beside a recording. */
export interface CursorRecording {
  version: 2
  provider: 'native' | 'none'
  /** UVE addition: the captured surface in physical screen pixels, and what it was. */
  surface?: { kind: 'display' | 'window'; name: string; x: number; y: number; width: number; height: number }
  samples: CursorSample[]
  assets: CursorAsset[]
}

/** A physical-pixel rectangle. */
export interface PixelRect {
  x: number
  y: number
  width: number
  height: number
}

/** One line from cursor-sampler.exe. */
export type SamplerEvent =
  | { type: 'ready'; timestampMs: number }
  | { type: 'error'; timestampMs: number; message: string }
  | {
      type: 'sample'
      timestampMs: number
      x: number
      y: number
      visible: boolean
      handle: string | null
      cursorType?: string | null
      leftButtonDown?: boolean
      leftButtonPressed?: boolean
      leftButtonReleased?: boolean
      bounds?: PixelRect | null
      asset?: { id: string; imageDataUrl: string; width: number; height: number; hotspotX: number; hotspotY: number; cursorType?: string | null } | null
    }

/** How often the cursor is sampled (ms); about 60 a second, like OpenScreen. */
export const CURSOR_SAMPLE_INTERVAL_MS = 16

/** The longest recording the agent tool asks for (ms). */
export const MAX_RECORDING_MS = 60 * 60_000

/** The sidecar's path: OpenScreen's `<video>.cursor.json`. */
export function cursorSidecarPath(videoPath: string): string {
  return `${videoPath}.cursor.json`
}

/** "Recording 2026-10-31 14-03-22.mp4", local time. */
export function recordingFileName(at: Date): string {
  const two = (n: number) => String(n).padStart(2, '0')
  const day = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`
  const time = `${two(at.getHours())}-${two(at.getMinutes())}-${two(at.getSeconds())}`
  return `Recording ${day} ${time}.mp4`
}

/** Reads one line of the sampler's output; null for anything else. */
export function parseSamplerLine(line: string): SamplerEvent | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const event = JSON.parse(trimmed) as { type?: unknown }
    return event.type === 'sample' || event.type === 'ready' || event.type === 'error' ? (event as SamplerEvent) : null
  } catch {
    return null
  }
}

/**
 * Turns a sampler sample into a sidecar sample (ported from OpenScreen): the
 * position as a fraction of `surface` (the window's own bounds when the sampler
 * sends them), a click on the press, a mouseup on the release. Returns the
 * sample and whether the left button is down now (pass it back next time).
 */
export function cursorSampleFrom(
  event: Extract<SamplerEvent, { type: 'sample' }>,
  surface: PixelRect,
  startMs: number,
  wasDown: boolean,
): { sample: CursorSample; down: boolean } {
  const bounds = event.bounds ?? surface
  const width = Math.max(1, bounds.width)
  const height = Math.max(1, bounds.height)
  const cx = (event.x - bounds.x) / width
  const cy = (event.y - bounds.y) / height
  const inside = cx >= 0 && cx <= 1 && cy >= 0 && cy <= 1
  const down = event.leftButtonDown === true
  const interactionType =
    event.leftButtonPressed === true || (down && !wasDown) ? 'click' : event.leftButtonReleased === true || (!down && wasDown) ? 'mouseup' : 'move'
  return {
    down,
    sample: {
      timeMs: Math.max(0, event.timestampMs - startMs),
      cx,
      cy,
      assetId: event.handle,
      visible: event.visible && inside,
      cursorType: event.cursorType ?? event.asset?.cursorType ?? null,
      interactionType,
    },
  }
}

/** Collects a recording's cursor: samples (from the start on) and each cursor image once. */
export class CursorCollector {
  private readonly samples: CursorSample[] = []
  private readonly assets = new Map<string, CursorAsset>()
  private down = false

  constructor(
    private readonly surface: PixelRect,
    /** Wall-clock ms (Date.now()) when the video's first frame was taken; the sampler stamps in the same clock. */
    private startMs: number,
  ) {}

  /** Moves the start (when the video started after the sampler did). */
  setStart(startMs: number): void {
    this.startMs = startMs
  }

  add(event: SamplerEvent): void {
    if (event.type !== 'sample') return
    const asset = event.asset
    if (asset?.id && !this.assets.has(asset.id)) {
      this.assets.set(asset.id, {
        id: asset.id,
        platform: 'win32',
        imageDataUrl: asset.imageDataUrl,
        width: asset.width,
        height: asset.height,
        hotspotX: asset.hotspotX,
        hotspotY: asset.hotspotY,
        cursorType: asset.cursorType ?? event.cursorType ?? null,
      })
    }
    const { sample, down } = cursorSampleFrom(event, this.surface, this.startMs, this.down)
    this.down = down
    this.samples.push(sample)
  }

  /** The sidecar. Samples from before the start (stamped 0) collapse into the last of them: where the cursor was at 0. */
  finish(surface?: CursorRecording['surface']): CursorRecording {
    const before = this.samples.filter((s) => s.timeMs === 0)
    const samples = [...before.slice(-1), ...this.samples.filter((s) => s.timeMs > 0)]
    return {
      version: 2,
      provider: samples.length > 0 ? 'native' : 'none',
      ...(surface ? { surface } : {}),
      samples,
      assets: [...this.assets.values()],
    }
  }
}

/** How many left clicks a sidecar holds. */
export function countClicks(recording: Pick<CursorRecording, 'samples'>): number {
  return recording.samples.filter((s) => s.interactionType === 'click').length
}

/** The JSON argument for wgc-capture.exe (OpenScreen's schema 2). */
export function captureHelperConfig(input: {
  outputPath: string
  source: { kind: 'display'; displayId: number; bounds: PixelRect } | { kind: 'window'; sourceId: string }
  fps: number
  systemAudio: boolean
  microphone: boolean
  webcam: boolean
}): Record<string, unknown> {
  const source =
    input.source.kind === 'display'
      ? {
          sourceType: 'display',
          displayId: input.source.displayId,
          displayX: input.source.bounds.x,
          displayY: input.source.bounds.y,
          displayW: input.source.bounds.width,
          displayH: input.source.bounds.height,
          hasDisplayBounds: true,
        }
      : { sourceType: 'window', sourceId: input.source.sourceId }
  return {
    schemaVersion: 2,
    recordingId: Date.now(),
    ...source,
    outputPath: input.outputPath,
    fps: input.fps,
    captureSystemAudio: input.systemAudio,
    captureMic: input.microphone,
    microphoneGain: 1,
    // The real cursor, drawn by Windows: every shape and animation exactly as on screen.
    captureCursor: true,
    webcamEnabled: input.webcam,
    outputs: { screenPath: input.outputPath },
  }
}

/** Reads one line of wgc-capture.exe's stdout: its JSON events; null for the legacy text lines. */
export function parseHelperLine(line: string): { event: string; [key: string]: unknown } | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const event = JSON.parse(trimmed) as { event?: unknown }
    return typeof event.event === 'string' ? (event as { event: string }) : null
  } catch {
    return null
  }
}

/**
 * The size of the `mfra` box an MP4 ends with, read from its last 16 bytes (the
 * `mfro` box: size 16, type, version and flags, then the whole mfra's size), or
 * null when the file does not end with one.
 */
export function mfraSizeFromTail(tail: Uint8Array): number | null {
  if (tail.length < 16) return null
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
  const at = tail.length - 16
  const type = String.fromCharCode(tail[at + 4]!, tail[at + 5]!, tail[at + 6]!, tail[at + 7]!)
  if (view.getUint32(at) !== 16 || type !== 'mfro') return null
  const size = view.getUint32(at + 12)
  return size >= 16 ? size : null
}
