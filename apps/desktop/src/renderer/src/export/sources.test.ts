import type { AudioSample, AudioSampleSink, CanvasSink, WrappedCanvas } from 'mediabunny'
import { describe, expect, it } from 'vitest'
import { SoundCursor, VideoCursor } from './sources'

/** A stand-in for mediabunny's CanvasSink over frames at the given timestamps; it records where iteration started. */
function fakeCanvasSink(timestamps: number[], starts: number[]): CanvasSink {
  return {
    async *canvases(start = 0) {
      starts.push(start)
      // Like mediabunny: begin with the last frame at or before `start` (or the first one).
      const first = Math.max(0, timestamps.findLastIndex((t) => t <= start))
      for (const timestamp of timestamps.slice(first)) {
        yield { canvas: { timestamp } as unknown as HTMLCanvasElement, timestamp, duration: 0.04 } satisfies WrappedCanvas
      }
    },
  } as unknown as CanvasSink
}

const shown = async (cursor: VideoCursor, sec: number) =>
  ((await cursor.frameAt(sec)) as unknown as { timestamp: number } | null)?.timestamp

describe('VideoCursor', () => {
  const frames = [0, 0.04, 0.08, 0.12, 0.16]

  it('shows the last frame that starts at or before the time, decoding forward', async () => {
    const starts: number[] = []
    const cursor = new VideoCursor(fakeCanvasSink(frames, starts))
    expect(await shown(cursor, 0.05)).toBe(0.04)
    expect(await shown(cursor, 0.08)).toBe(0.08)
    expect(await shown(cursor, 0.159)).toBe(0.12)
    expect(await shown(cursor, 5)).toBe(0.16)
    expect(starts).toEqual([0.05])
  })

  it('starts again when asked for an earlier time', async () => {
    const starts: number[] = []
    const cursor = new VideoCursor(fakeCanvasSink(frames, starts))
    await cursor.frameAt(0.12)
    expect(await shown(cursor, 0.01)).toBe(0)
    expect(starts).toEqual([0.12, 0.01])
  })
})

/** A stand-in for a decoded mono packet of `frames` samples at 1 kHz, all set to `value`. */
function packet(timestamp: number, frames: number, value: number): AudioSample {
  return {
    timestamp,
    sampleRate: 1000,
    numberOfFrames: frames,
    numberOfChannels: 1,
    copyTo: (destination: Float32Array) => destination.fill(value),
    close: () => undefined,
  } as unknown as AudioSample
}

function fakeAudioSink(packets: AudioSample[], starts: number[]): AudioSampleSink {
  return {
    async *samples(start = 0) {
      starts.push(start)
      yield* packets
    },
  } as unknown as AudioSampleSink
}

describe('SoundCursor', () => {
  it('decodes from before the asked time, places packets by timestamp and leaves gaps silent', async () => {
    const starts: number[] = []
    const cursor = new SoundCursor(fakeAudioSink([packet(-0.1, 100, 0.5), packet(0, 100, 1), packet(0.2, 100, 2)], starts))
    const pcm = await cursor.cover(0.05, 0.25)
    expect(starts[0]).toBeCloseTo(-0.15, 9)
    expect(pcm?.startSec).toBe(-0.1)
    expect(pcm?.length).toBe(400)
    expect(pcm?.left[50]).toBe(0.5)
    expect(pcm?.right[150]).toBe(1)
    expect(pcm?.left[250]).toBe(0)
    expect(pcm?.left[350]).toBe(2)
  })

  it('stops decoding once the asked span is covered', async () => {
    const consumed: number[] = []
    const packets = [0, 0.1, 0.2, 0.3].map((t) => {
      const p = packet(t, 100, 1)
      return new Proxy(p, {
        get: (target, key) => {
          if (key === 'copyTo') consumed.push(t)
          return Reflect.get(target, key)
        },
      })
    })
    const cursor = new SoundCursor(fakeAudioSink(packets, []))
    await cursor.cover(0, 0.15)
    expect(consumed).toEqual([0, 0.1])
  })
})
