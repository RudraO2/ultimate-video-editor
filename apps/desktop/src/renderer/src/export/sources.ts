import type { Comp, Layer, MediaAsset } from '@uve/core'
import {
  FRAME_LOOKUP_EPSILON_MS,
  type FrameProvider,
  isActiveAt,
  type MediaLayer,
  type Pcm,
  playedMedia,
  sourceTimeMs,
  toStereo,
} from '@uve/engine'
import { ALL_FORMATS, type AudioSample, AudioSampleSink, CanvasSink, Input, UrlSource, type WrappedCanvas } from 'mediabunny'
import { mediaUrl } from '../../../shared/media'

/** Sound decoded before the first second a layer needs and thrown away: the first packets after a jump decode imperfectly. */
const PREROLL_SEC = 0.2
/** Decoded sound older than this, behind the newest request, is dropped (seconds). */
const KEEP_SEC = 0.5

type VideoLayer = Extract<Layer, { kind: 'video' }>

/** Plays one layer's video forward, decoding every frame in order. Requests must not go back in time. */
export class VideoCursor {
  private frames: AsyncGenerator<WrappedCanvas, void> | null = null
  private current: WrappedCanvas | null = null
  private next: WrappedCanvas | null = null
  private lastSec = -Infinity

  constructor(private readonly sink: CanvasSink) {}

  /** The frame showing at source time `sec`: the last one that starts at or before it, or the first one. */
  async frameAt(sec: number): Promise<CanvasImageSource | null> {
    if (!this.frames || sec < this.lastSec) {
      await this.close()
      this.frames = this.sink.canvases(sec)
      this.current = (await this.frames.next()).value ?? null
      this.next = (await this.frames.next()).value ?? null
    }
    this.lastSec = sec
    while (this.next && this.next.timestamp <= sec) {
      this.current = this.next
      this.next = (await this.frames.next()).value ?? null
    }
    return this.current?.canvas ?? null
  }

  async close(): Promise<void> {
    const frames = this.frames
    this.frames = null
    this.current = null
    this.next = null
    await frames?.return()
  }
}

/** Decodes one layer's sound forward and keeps a stretch of it as stereo samples. Requests must not go back in time. */
export class SoundCursor {
  private samples: AsyncGenerator<AudioSample, void> | null = null
  private pcm: Pcm | null = null
  private ended = false
  private lastStartSec = -Infinity

  constructor(private readonly sink: AudioSampleSink) {}

  /** Stereo sound covering source seconds [startSec, endSec], as far as the file has it. */
  async cover(startSec: number, endSec: number): Promise<Pcm | null> {
    if (!this.samples || startSec < this.lastStartSec) await this.restart(startSec)
    this.lastStartSec = startSec
    this.dropBefore(startSec - KEEP_SEC)
    const samples = this.samples
    while (samples && !this.ended && !this.covers(endSec)) {
      const next = await samples.next()
      if (next.done) {
        this.ended = true
        break
      }
      try {
        this.append(next.value)
      } finally {
        next.value.close()
      }
    }
    return this.pcm
  }

  async close(): Promise<void> {
    const samples = this.samples
    this.samples = null
    this.pcm = null
    await samples?.return()
  }

  private async restart(startSec: number): Promise<void> {
    await this.close()
    this.ended = false
    // No clamp at 0: AAC files begin with priming packets before 0 s, and sound at 0 s only decodes fully after them.
    this.samples = this.sink.samples(startSec - PREROLL_SEC)
  }

  private covers(endSec: number): boolean {
    const { pcm } = this
    return pcm !== null && pcm.startSec + pcm.length / pcm.sampleRate >= endSec
  }

  private append(sample: AudioSample): void {
    const frames = sample.numberOfFrames
    if (frames === 0) return
    const planes = Array.from({ length: sample.numberOfChannels }, (_, planeIndex) => {
      const plane = new Float32Array(frames)
      sample.copyTo(plane, { planeIndex, format: 'f32-planar' })
      return plane
    })
    const { left, right } = toStereo(planes)
    this.pcm ??= {
      sampleRate: sample.sampleRate,
      startSec: sample.timestamp,
      left: new Float32Array(sample.sampleRate * 4),
      right: new Float32Array(sample.sampleRate * 4),
      length: 0,
    }
    const pcm = this.pcm
    // Place each packet by its timestamp: gaps stay silent, overlaps are written over.
    const at = Math.round((sample.timestamp - pcm.startSec) * pcm.sampleRate)
    const skip = Math.max(0, -at)
    if (skip >= frames) return
    const end = at + frames
    if (end > pcm.left.length) {
      const capacity = Math.max(end, pcm.left.length * 2)
      for (const side of ['left', 'right'] as const) {
        const grown = new Float32Array(capacity)
        grown.set(pcm[side].subarray(0, pcm.length))
        pcm[side] = grown
      }
    }
    if (at > pcm.length) {
      pcm.left.fill(0, pcm.length, at)
      pcm.right.fill(0, pcm.length, at)
    }
    pcm.left.set(skip ? left.subarray(skip) : left, at + skip)
    pcm.right.set(skip ? right.subarray(skip) : right, at + skip)
    pcm.length = Math.max(pcm.length, end)
  }

  /** Forgets sound before `sec`, a second at a time, so long layers keep memory flat. */
  private dropBefore(sec: number): void {
    const { pcm } = this
    if (!pcm) return
    const drop = Math.min(pcm.length, Math.floor((sec - pcm.startSec) * pcm.sampleRate))
    if (drop < pcm.sampleRate) return
    pcm.left.copyWithin(0, drop, pcm.length)
    pcm.right.copyWithin(0, drop, pcm.length)
    pcm.length -= drop
    pcm.startSec += drop / pcm.sampleRate
  }
}

/**
 * The media of an export, read with mediabunny rather than the preview's
 * media elements: exact video frames decoded forward per layer, still images,
 * and each layer's sound. As a FrameProvider it hands the compositor the
 * frames that `prepare` decoded for the current time.
 */
export class ExportSources implements FrameProvider {
  private readonly inputs = new Map<string, Input>()
  private readonly videos = new Map<string, Promise<VideoCursor>>()
  private readonly sounds = new Map<string, Promise<SoundCursor | null>>()
  private readonly imageLoads = new Map<string, Promise<HTMLImageElement>>()
  private readonly images = new Map<string, HTMLImageElement>()
  private readonly ready = new Map<string, CanvasImageSource | null>()

  private readonly media: readonly MediaAsset[]
  private readonly comps: readonly Comp[]

  /** `doc` is the project: its media, and the comps nested layers show. */
  constructor(doc: { media: readonly MediaAsset[]; comps: readonly Comp[] }) {
    this.media = doc.media
    this.comps = doc.comps
  }

  /** Checks that every file the comp's enabled layers use is still on disk, before any rendering starts. */
  async checkFiles(comp: Comp): Promise<void> {
    const used = new Set<string>()
    for (const { layer } of playedMedia(comp, this.comps)) if (layer.enabled) used.add(layer.mediaId)
    for (const asset of this.media) {
      if (!used.has(asset.id)) continue
      const response = await fetch(mediaUrl(asset.path), { method: 'HEAD' }).catch(() => null)
      if (!response?.ok) throw new Error(`"${asset.name}" is missing. It was at ${asset.path}.`)
    }
  }

  frame(media: MediaAsset, _sourceTimeMs: number, layerId: string): CanvasImageSource | null {
    return media.kind === 'image' ? (this.images.get(media.path) ?? null) : (this.ready.get(layerId) ?? null)
  }

  /** Decodes every picture `comp` shows at `timeMs` (inside its nested comps too), and lets go of the video of layers that have ended. */
  async prepare(comp: Comp, timeMs: number): Promise<void> {
    this.ready.clear()
    const jobs: Promise<unknown>[] = []
    for (const { layer } of playedMedia(comp, this.comps)) {
      if (layer.kind !== 'video' && layer.kind !== 'image') continue
      const asset = this.media.find((m) => m.id === layer.mediaId)
      if (!asset) continue
      if (!isActiveAt(layer, timeMs)) {
        if (layer.kind === 'video' && timeMs >= layer.startMs + layer.durationMs) jobs.push(this.closeVideo(layer.id))
        continue
      }
      if (asset.kind === 'image') jobs.push(this.image(asset))
      else if (layer.kind === 'video') jobs.push(this.videoFrame(layer, asset, timeMs))
    }
    await Promise.all(jobs)
  }

  /** A layer's sound over source seconds [startSec, endSec], or null when its file has none this computer can decode. */
  async sound(layer: MediaLayer, startSec: number, endSec: number): Promise<Pcm | null> {
    let cursor = this.sounds.get(layer.id)
    if (!cursor) {
      const asset = this.media.find((m) => m.id === layer.mediaId)
      cursor = asset ? this.openSound(asset) : Promise.resolve(null)
      this.sounds.set(layer.id, cursor)
    }
    const opened = await cursor
    if (!opened) return null
    return this.reading(layer.mediaId, () => opened.cover(startSec, endSec))
  }

  /** A short sound file decoded whole (a custom sound of a sounds stack), or null when it cannot be decoded. */
  async wholeSound(assetId: string): Promise<Pcm | null> {
    const asset = this.media.find((m) => m.id === assetId)
    if (!asset) return null
    const cursor = await this.openSound(asset)
    if (!cursor) return null
    try {
      // Up to 30 s: sounds on animation are short; a longer file is cut there.
      const seconds = Math.min(30, (asset.durationMs ?? 30000) / 1000)
      const pcm = await this.reading(asset.id, () => cursor.cover(0, seconds))
      return pcm ? { ...pcm, left: pcm.left.slice(0, pcm.length), right: pcm.right.slice(0, pcm.length) } : null
    } finally {
      await cursor.close()
    }
  }

  /**
   * Decodes a file's sound over source seconds [startSec, endSec] in pieces of
   * a few seconds and hands each to `visit` once, in order (for measuring its
   * loudness). Returns false when the file has no sound this computer can decode.
   */
  async eachSoundPiece(assetId: string, startSec: number, endSec: number, visit: (left: Float32Array, right: Float32Array, sampleRate: number) => void): Promise<boolean> {
    const asset = this.media.find((m) => m.id === assetId)
    if (!asset) return false
    const cursor = await this.openSound(asset)
    if (!cursor) return false
    try {
      for (let from = Math.max(0, startSec); from < endSec; ) {
        const to = Math.min(endSec, from + 4)
        const pcm = await this.reading(asset.id, () => cursor.cover(from, to))
        if (!pcm) break
        const first = Math.max(0, Math.round((from - pcm.startSec) * pcm.sampleRate))
        const end = Math.min(pcm.length, Math.round((to - pcm.startSec) * pcm.sampleRate))
        if (end > first) visit(pcm.left.subarray(first, end), pcm.right.subarray(first, end), pcm.sampleRate)
        // The file ends before the range does.
        if (pcm.startSec + pcm.length / pcm.sampleRate < to - 0.001) break
        from = to
      }
      return true
    } finally {
      await cursor.close()
    }
  }

  /** Lets go of a layer's sound once it has been mixed. */
  async closeSound(layerId: string): Promise<void> {
    const cursor = this.sounds.get(layerId)
    if (!cursor) return
    this.sounds.delete(layerId)
    await (await cursor)?.close()
  }

  async dispose(): Promise<void> {
    const cursors = [...this.videos.values(), ...this.sounds.values()]
    this.videos.clear()
    this.sounds.clear()
    await Promise.allSettled(cursors.map(async (cursor) => (await cursor)?.close()))
    for (const input of this.inputs.values()) input.dispose()
    this.inputs.clear()
    this.images.clear()
  }

  private async videoFrame(layer: VideoLayer, asset: MediaAsset, timeMs: number): Promise<void> {
    let cursor = this.videos.get(layer.id)
    if (!cursor) {
      cursor = this.openVideo(asset)
      this.videos.set(layer.id, cursor)
    }
    const opened = await cursor
    const sec = (sourceTimeMs(layer, timeMs) + FRAME_LOOKUP_EPSILON_MS) / 1000
    this.ready.set(layer.id, await this.reading(asset.id, () => opened.frameAt(sec)))
  }

  private async closeVideo(layerId: string): Promise<void> {
    const cursor = this.videos.get(layerId)
    if (!cursor) return
    this.videos.delete(layerId)
    await (await cursor).close()
  }

  private async openVideo(asset: MediaAsset): Promise<VideoCursor> {
    const track = await this.reading(asset.id, () => this.input(asset).getPrimaryVideoTrack())
    if (!track) throw new Error(`"${asset.name}" has no picture in it.`)
    // Canvases come at the display size with rotation applied, as the preview shows them; alpha is kept.
    return new VideoCursor(new CanvasSink(track, { alpha: true, poolSize: 3 }))
  }

  private async openSound(asset: MediaAsset): Promise<SoundCursor | null> {
    const track = await this.reading(asset.id, () => this.input(asset).getPrimaryAudioTrack())
    if (!track || !(await track.canDecode())) return null
    return new SoundCursor(new AudioSampleSink(track))
  }

  private image(asset: MediaAsset): Promise<HTMLImageElement> {
    let load = this.imageLoads.get(asset.path)
    if (!load) {
      const image = new Image()
      image.crossOrigin = 'anonymous'
      image.src = mediaUrl(asset.path)
      load = image.decode().then(
        () => {
          this.images.set(asset.path, image)
          return image
        },
        () => {
          throw new Error(`Could not read "${asset.name}".`)
        },
      )
      this.imageLoads.set(asset.path, load)
    }
    return load
  }

  private input(asset: MediaAsset): Input {
    let input = this.inputs.get(asset.path)
    if (!input) {
      input = new Input({ source: new UrlSource(mediaUrl(asset.path)), formats: ALL_FORMATS })
      this.inputs.set(asset.path, input)
    }
    return input
  }

  /** Runs a read of a media file, naming the file in any error. */
  private async reading<T>(mediaId: string, read: () => Promise<T>): Promise<T> {
    try {
      return await read()
    } catch (error) {
      const name = this.media.find((m) => m.id === mediaId)?.name ?? 'a media file'
      throw new Error(`Could not read "${name}": ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      })
    }
  }
}
