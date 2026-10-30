import { ALL_FORMATS, CanvasSink, Input, UrlSource, VideoSampleSink } from 'mediabunny'
import { mediaUrl } from '../../../shared/media'

// Reading the picture of a footage file for media.analyze and media_inspect:
// a scene-change score between small frames a few times a second, and stills
// at chosen moments for a contact sheet.

/** Side of the small frames compared for scene changes. */
const PROBE_W = 64
const PROBE_H = 36

function openInput(path: string): Input {
  return new Input({ source: new UrlSource(mediaUrl(path)), formats: ALL_FORMATS })
}

/**
 * How much the picture changes between frames sampled `sampleFps` times a
 * second: the mean colour difference of 64×36 frames, 0 (same) to 1 (every
 * pixel flipped), like ffmpeg's scene score. The first sample scores 0.
 */
export async function sceneScores(path: string, sampleFps = 10): Promise<{ durationMs: number; samples: { timeMs: number; score: number }[] }> {
  const input = openInput(path)
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) return { durationMs: 0, samples: [] }
    const duration = await track.computeDuration()
    const start = await track.getFirstTimestamp()
    const step = 1 / sampleFps
    const times: number[] = []
    for (let t = start; t < duration; t += step) times.push(t)
    const canvas = new OffscreenCanvas(PROBE_W, PROBE_H)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('No 2D canvas here.')
    let previous: Uint8ClampedArray | null = null
    const samples: { timeMs: number; score: number }[] = []
    for await (const sample of new VideoSampleSink(track).samplesAtTimestamps(times)) {
      if (!sample) continue
      const timeMs = Math.round((sample.timestamp - start) * 1000)
      context.clearRect(0, 0, PROBE_W, PROBE_H)
      sample.draw(context, 0, 0, PROBE_W, PROBE_H)
      sample.close()
      const pixels = context.getImageData(0, 0, PROBE_W, PROBE_H).data
      let score = 0
      if (previous) {
        let sum = 0
        for (let i = 0; i < pixels.length; i += 4) sum += Math.abs(pixels[i]! - previous[i]!) + Math.abs(pixels[i + 1]! - previous[i + 1]!) + Math.abs(pixels[i + 2]! - previous[i + 2]!)
        score = sum / ((pixels.length / 4) * 3 * 255)
      }
      previous = pixels
      if (samples.at(-1)?.timeMs !== timeMs) samples.push({ timeMs, score: Math.round(score * 10000) / 10000 })
    }
    return { durationMs: Math.round((duration - start) * 1000), samples }
  } finally {
    input.dispose()
  }
}

/** Stills of a video file at `timesMs` (from its start), each fitted inside `longSide` px. */
export async function mediaStills(path: string, timesMs: readonly number[], longSide: number): Promise<OffscreenCanvas[]> {
  const input = openInput(path)
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error('That file has no picture in it.')
    const start = await track.getFirstTimestamp()
    const scale = Math.min(1, longSide / Math.max(track.displayWidth, track.displayHeight))
    const width = Math.max(2, Math.round(track.displayWidth * scale))
    const height = Math.max(2, Math.round(track.displayHeight * scale))
    const sink = new CanvasSink(track, { width, height, fit: 'contain', poolSize: 0 })
    const stills: OffscreenCanvas[] = []
    const sorted = [...timesMs].map((t, i) => ({ t, i })).sort((a, b) => a.t - b.t)
    const out: OffscreenCanvas[] = new Array(timesMs.length)
    let k = 0
    for await (const wrapped of sink.canvasesAtTimestamps(sorted.map((s) => start + s.t / 1000))) {
      const still = new OffscreenCanvas(width, height)
      const context = still.getContext('2d')
      if (wrapped && context) context.drawImage(wrapped.canvas, 0, 0, width, height)
      out[sorted[k]!.i] = still
      k++
    }
    for (const still of out) if (still) stills.push(still)
    return stills
  } finally {
    input.dispose()
  }
}
