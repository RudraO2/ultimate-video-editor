import { type Comp, compSoundHitsDeep, frameToMs, type Project } from '@uve/core'
import {
  audibleLayers,
  CompRenderer,
  FONT_PROBE_TEXT,
  fontsOf,
  type MasterLevels,
  MasterMeter,
  MIX_SAMPLE_RATE,
  MixStream,
  masterTrimDb,
  mixSampleAt,
  renderPlan,
  type Stereo,
} from '@uve/engine'
import {
  AudioSample,
  AudioSampleSource,
  CanvasSource,
  canEncodeAudio,
  getFirstEncodableVideoCodec,
  Output,
  type OutputFormat,
  Quality,
  StreamTarget,
  type VideoCodec,
} from 'mediabunny'
import { loadFontsOf } from '../library/fonts'
import { measuredMixPlan } from '../media/mixLevels'
import { type EncodeSpec, type ImageCodec, interleavePcm16, MP4_H264_AAC, VIDEO_CODEC_LABELS } from './encode'
import { GifWriter, gifDelays } from './gif'
import { AUDIO_WINDOW, measureMix, windowMixer } from './mixWindows'
import { MovWriter } from './mov'
import { DEFAULT_AUDIO_BITRATE, qualityBitrate } from './options'
import { ExportSources } from './sources'

/** Largest write to the file, in bytes. */
const WRITE_CHUNK = 4 * 1024 * 1024

export interface RenderOptions {
  /** Writes bytes into the output file at a byte position. */
  write(position: number, data: Uint8Array): Promise<void>
  /** Writes one file of a PNG sequence into the output folder, by name; needed for `png-seq` only. */
  writeFile?(name: string, data: Uint8Array): Promise<void>
  /** Called after each frame. */
  onProgress?(frame: number, frameCount: number): void
  signal?: AbortSignal
  /** Renders only this span of the comp (the working range); the file starts at its first whole frame. */
  span?: { startMs: number; endMs: number }
  /** The container and codecs; default MP4 with H.264 and AAC. */
  encode?: EncodeSpec
  /** Output pixels per comp pixel; default 1. */
  scale?: number
  /** Output frame rate; default the comp's. */
  fps?: number
  /** Video bitrate in bits per second; default the "high" tier for the output size and rate (`qualityBitrate`). */
  videoBitrate?: number
  /** Sound bitrate in bits per second, for compressed codecs; default 192 kbps. */
  audioBitrate?: number
  /** false writes no sound track. Default true. */
  includeAudio?: boolean
  /** false draws no motion blur (the comp's and layers' settings are ignored). Default true. */
  motionBlur?: boolean
  /** true leaves the comp's background out and keeps the picture's alpha; only for encodings with `alpha`. Default false. */
  transparent?: boolean
  /** The comp time a still shows, in ms (already mapped onto a static frame's still); default 0. Stills only. */
  atMs?: number
  /** JPEG and WebP quality, 0 to 1 (1 is lossless WebP); default the canvas's own. */
  imageQuality?: number
}

export interface RenderResult {
  /** Video frames written (1 for a still); 0 for a sound-only file. */
  frameCount: number
  /** The file's length; 0 for a still. */
  durationMs: number
  /** The comp time of the file's first frame (a still's moment), in ms. */
  startMs: number
  width: number
  height: number
  fps: number
  scale: number
  /** The video codec used (`png`, `jpeg` or `webp` for an image per frame, `gif` for GIF frames); null for a sound-only file. */
  videoCodec: VideoCodec | ImageCodec | 'gif' | null
  /** The video bitrate asked of the encoder; null for a sound-only file or image frames. */
  videoBitrate: number | null
  /** The sound bitrate; null without sound or for PCM. */
  audioBitrate: number | null
  hasSound: boolean
  /** Whether the picture kept its alpha (the background left out). */
  transparent: boolean
  /** Mix samples the limiter's last clamp (or, with the limiter off, full scale) had to cut. */
  clippedSamples: number
  /** The loudness of the sound as written, measured on the final master; null without sound. */
  loudness: RenderLoudness | null
}

/** What the file's sound measures (BS.1770, as ffmpeg's ebur128 reads it). */
export interface RenderLoudness {
  /** Integrated loudness, LUFS; -Infinity for silence. */
  integratedLufs: number
  /** True peak (4x oversampled), dBTP; -Infinity for silence. */
  truePeakDbtp: number
  /** The loudness match's trim, dB (0 when it is off or had nothing to do). */
  matchDb: number
}

/** Where the frames and sound of one render go: a mediabunny output, or our own MOV muxer. */
interface Sink {
  start(): Promise<void>
  /** Adds the canvas as the next frame, frame `index` of the file. */
  addFrame(index: number): Promise<void>
  /** Adds sound whose first sample plays at `seconds` in the file (below 0 for a lead-in). */
  addSound(stereo: Stereo, seconds: number): Promise<void>
  finish(): Promise<void>
  cancel(): Promise<void>
}

/** Fills what the frame left clear with black, under the picture: an opaque output's backdrop. */
export function backdrop(ctx: OffscreenCanvasRenderingContext2D): void {
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'destination-over'
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  ctx.restore()
}

/** Whether a comp makes any sound: media layers that are heard, or hits of the sounds stack. */
export function compHasSound(project: Project, comp: Comp): boolean {
  return audibleLayers(comp, project).length > 0 || compSoundHitsDeep(comp, project.comps).length > 0
}

/** A sink into a mediabunny container; frames go through `video` (a source on the canvas) and sound through `sound`. */
function mediabunnySink(
  format: OutputFormat,
  write: RenderOptions['write'],
  video: { source: CanvasSource; fps: number; frameCount: number } | null,
  sound: { source: AudioSampleSource; packets: number } | null,
): Sink {
  const target = new StreamTarget(new WritableStream({ write: (chunk) => write(chunk.position, chunk.data) }), {
    chunked: true,
    chunkSize: WRITE_CHUNK,
  })
  const output = new Output({ format, target })
  if (video) output.addVideoTrack(video.source, { frameRate: video.fps, maximumPacketCount: video.frameCount + 4 })
  if (sound) output.addAudioTrack(sound.source, { maximumPacketCount: sound.packets })
  return {
    start: () => output.start(),
    addFrame: async (index) => {
      if (video) await video.source.add(index / video.fps, 1 / video.fps)
    },
    addSound: async (stereo, seconds) => {
      if (!sound) return
      const count = stereo.left.length
      const data = new Float32Array(count * 2)
      data.set(stereo.left, 0)
      data.set(stereo.right, count)
      const sample = new AudioSample({ data, format: 'f32-planar', numberOfChannels: 2, sampleRate: MIX_SAMPLE_RATE, timestamp: seconds })
      try {
        await sound.source.add(sample)
      } finally {
        sample.close()
      }
    },
    finish: async () => {
      video?.source.close()
      sound?.source.close()
      await output.finalize()
    },
    cancel: async () => {
      if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => undefined)
    },
  }
}

/** A sink into our own QuickTime muxer: each frame the canvas as a PNG, the sound as 16-bit PCM. */
function movSink(
  write: RenderOptions['write'],
  canvas: OffscreenCanvas | null,
  fps: number,
  transparent: boolean,
  audible: boolean,
): Sink {
  const writer = new MovWriter(write, {
    video: canvas ? { width: canvas.width, height: canvas.height, fps, alpha: transparent } : null,
    audio: audible ? { sampleRate: MIX_SAMPLE_RATE, channels: 2 } : null,
  })
  return {
    start: () => writer.start(),
    addFrame: async () => {
      if (!canvas) return
      const png = await canvas.convertToBlob({ type: 'image/png' })
      await writer.addFrame(new Uint8Array(await png.arrayBuffer()))
    },
    addSound: (stereo) => writer.addSound(interleavePcm16(stereo)),
    finish: () => writer.finish(),
    // The partial file is removed by whoever opened it.
    cancel: async () => undefined,
  }
}

/** A sink into our own GIF writer: each frame the canvas's pixels, read back, with its share of the frame delays. */
function gifSink(write: RenderOptions['write'], ctx: OffscreenCanvasRenderingContext2D, fps: number, frameCount: number, transparent: boolean): Sink {
  const { width, height } = ctx.canvas
  const writer = new GifWriter(write, { width, height })
  const delays = gifDelays(frameCount, fps)
  return {
    start: () => writer.start(),
    addFrame: (index) => writer.addFrame(ctx.getImageData(0, 0, width, height).data, delays[index] ?? 2, transparent),
    addSound: async () => undefined,
    finish: () => writer.finish(),
    cancel: async () => undefined,
  }
}

/** A sink into a folder: frame n as `frame-<n>.png`, n padded to the digits of the frame count (AtomCut's names). */
function pngSequenceSink(writeFile: RenderOptions['writeFile'], canvas: OffscreenCanvas, frameCount: number): Sink {
  if (!writeFile) throw new Error('A PNG sequence needs a folder to write into.')
  const digits = String(frameCount).length
  return {
    start: async () => undefined,
    addFrame: async (index) => {
      const png = await canvas.convertToBlob({ type: 'image/png' })
      await writeFile(`frame-${String(index).padStart(digits, '0')}.png`, new Uint8Array(await png.arrayBuffer()))
    },
    addSound: async () => undefined,
    finish: async () => undefined,
    // The files written so far are removed by whoever opened the folder.
    cancel: async () => undefined,
  }
}

/** A sink for one image of one frame, written by the canvas. */
function stillSink(write: RenderOptions['write'], canvas: OffscreenCanvas, codec: ImageCodec, quality: number | undefined): Sink {
  return {
    start: async () => undefined,
    addFrame: async () => {
      const image = await canvas.convertToBlob({ type: `image/${codec}`, ...(codec !== 'png' && quality !== undefined ? { quality } : {}) })
      await write(0, new Uint8Array(await image.arrayBuffer()))
    },
    addSound: async () => undefined,
    finish: async () => undefined,
    cancel: async () => undefined,
  }
}

/**
 * Renders a comp to a file, by default an MP4 with H.264 video and AAC sound
 * (`options.encode` picks another container and codecs, or a sound-only
 * file). Frame n is the comp at `frameToMs(firstFrame + n, fps)` (an exact
 * clock, never real time), drawn by the same compositor as the preview, with
 * media frames decoded by mediabunny.
 */
export async function renderComp(project: Project, comp: Comp, options: RenderOptions): Promise<RenderResult> {
  const spec = options.encode ?? MP4_H264_AAC
  const still = spec.container === 'still'
  const plan = renderPlan(comp, still ? undefined : options.span, {
    ...(options.scale !== undefined ? { scale: options.scale } : {}),
    ...(options.fps !== undefined ? { fps: options.fps } : {}),
  })
  // A still is one frame, at its own moment rather than on the frame clock.
  const frameCount = still ? 1 : plan.frameCount
  const stillMs = options.atMs ?? 0
  // Sound is mixed at absolute comp samples `base` to `mixEnd`; the file's clock starts at `base`.
  const base = mixSampleAt(plan.startMs)
  const totalSamples = Math.round((plan.durationMs * MIX_SAMPLE_RATE) / 1000)
  const withSound = options.includeAudio !== false ? spec.audio : null
  const sounding = withSound ? audibleLayers(comp, project) : []
  const hits = withSound ? compSoundHitsDeep(comp, project.comps) : []
  /** The sound's encoding, or null when the file has no sound. */
  const audio = sounding.length > 0 || hits.length > 0 ? withSound : null
  const audible = audio !== null
  if (!spec.video && !audible) throw new Error(`"${comp.name}" makes no sound, so there is nothing to write as ${spec.label}.`)
  const transparent = options.transparent === true
  if (transparent && !(spec.video && spec.alpha)) throw new Error(`${spec.label} cannot keep transparency.`)

  let videoCodec: RenderResult['videoCodec'] = null
  let videoBitrate: number | null = null
  if (typeof spec.video === 'string') {
    videoCodec = spec.video
  } else if (spec.video) {
    videoBitrate = options.videoBitrate ?? qualityBitrate('high', plan.width, plan.height, plan.fps)
    videoCodec = await getFirstEncodableVideoCodec(spec.video.codecs, {
      width: plan.width,
      height: plan.height,
      frameRate: plan.fps,
      quality: new Quality({ bitrate: videoBitrate }),
    })
    if (!videoCodec) {
      const names = spec.video.codecs.map((codec) => VIDEO_CODEC_LABELS[codec] ?? codec).join(' or ')
      throw new Error(`This computer cannot encode ${names} video at ${plan.width}×${plan.height}. Try a smaller size (scale).`)
    }
  }
  const audioBitrate = audio?.compressed ? (options.audioBitrate ?? DEFAULT_AUDIO_BITRATE) : null
  const audioQuality = audioBitrate === null ? undefined : new Quality({ bitrate: audioBitrate })
  // Our own muxer writes PCM itself; mediabunny's encoders are asked first.
  if (audio && typeof spec.container === 'function') {
    const soundSupported = await canEncodeAudio(audio.codec, {
      numberOfChannels: 2,
      sampleRate: MIX_SAMPLE_RATE,
      ...(audioQuality ? { quality: audioQuality } : {}),
    })
    if (!soundSupported) throw new Error(`This computer cannot encode ${audio.label} sound, so the ${spec.label} cannot keep its sound.`)
  }

  const sources = new ExportSources(project)
  await sources.checkFiles(comp)
  // The mix: every sound is measured first, so the leveler and the ducking know what is coming.
  const mix = audible ? await measuredMixPlan(project, comp, sounding, hits, sources) : null
  /** The master stream of the encoding pass; made after the loudness match has measured the mix. */
  let stream: MixStream | null = null
  const mixer = windowMixer({ comp, sounding, hits, mix, sources })
  const finalLevels = new MasterMeter(MIX_SAMPLE_RATE)
  let matchDb = 0
  let finalMeasure: MasterLevels = { integrated: Number.NEGATIVE_INFINITY, samplePeakDb: Number.NEGATIVE_INFINITY, truePeakDb: Number.NEGATIVE_INFINITY }
  let canvas: OffscreenCanvas | null = null
  let ctx: OffscreenCanvasRenderingContext2D | null = null
  if (videoCodec) {
    // Text must be drawn in its own font from the first frame.
    await loadFontsOf(project.comps)
    await Promise.all(fontsOf(comp, project.comps).map((font) => document.fonts.load(font, FONT_PROBE_TEXT)))
    canvas = new OffscreenCanvas(plan.width, plan.height)
    // Always a canvas with alpha: on an opaque one Chromium draws text with LCD
    // (coloured) anti-aliasing, unlike the preview and a world's textures, so a
    // layer moved into a world changed its edges. Opaque output gets a black
    // backdrop instead (backdrop), as the opaque canvas had.
    ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D is not available.')
  }

  let sink: Sink
  if (spec.container === 'mov') {
    sink = movSink(options.write, canvas, plan.fps, transparent, audible)
  } else if (spec.container === 'gif') {
    if (!ctx) throw new Error('A GIF needs a picture.')
    sink = gifSink(options.write, ctx, plan.fps, frameCount, transparent)
  } else if (spec.container === 'png-seq') {
    if (!canvas) throw new Error('A PNG sequence needs a picture.')
    sink = pngSequenceSink(options.writeFile, canvas, frameCount)
  } else if (spec.container === 'still') {
    if (!canvas || (videoCodec !== 'png' && videoCodec !== 'jpeg' && videoCodec !== 'webp')) throw new Error('A still needs a picture.')
    sink = stillSink(options.write, canvas, videoCodec, options.imageQuality)
  } else {
    const video =
      canvas && videoCodec && typeof spec.video === 'object' && videoBitrate !== null
        ? {
            source: new CanvasSource(canvas, {
              codec: videoCodec as VideoCodec,
              quality: new Quality({ bitrate: videoBitrate }),
              latencyMode: 'quality',
              alpha: transparent ? 'keep' : 'discard',
            }),
            fps: plan.fps,
            frameCount: plan.frameCount,
          }
        : null
    const sound = audio
      ? {
          source: new AudioSampleSource({ codec: audio.codec, ...(audioQuality ? { quality: audioQuality } : {}) }),
          // Encoders add a few packets of priming and padding.
          packets: Math.ceil(totalSamples / audio.frameSamples) + 16,
        }
      : null
    sink = mediabunnySink(spec.container(), options.write, video, sound)
  }

  const renderer = new CompRenderer()
  const mixEnd = base + totalSamples
  let mixed = base
  /** Mix samples written to the file so far (the limiter's look-ahead holds a few back until the end). */
  let written = base

  /** Writes master sound that is ready. */
  const write = async (master: Stereo) => {
    if (master.left.length === 0) return
    finalLevels.push(master)
    await sink.addSound(master, (written - base) / MIX_SAMPLE_RATE)
    written += master.left.length
  }

  /** Mixes and encodes the next second of sound. */
  const mixNext = async () => {
    const count = Math.min(AUDIO_WINDOW, mixEnd - mixed)
    const buses = await mixer(mixed, count)
    if (stream) await write(stream.process(mixed, count, buses))
    mixed += count
  }

  try {
    await renderer.prepare(comp, project)
    if (mix) {
      // The loudness match: the whole mix is measured once, before the limiter, and one trim brings it to the target.
      if (mix.loudness.enabled) {
        const levels = await measureMix({ comp, sounding, hits, mix, sources }, base, totalSamples, options.signal)
        matchDb = masterTrimDb(levels.integrated, levels.peakDb, mix.loudness, mix.limiter)
      }
      stream = new MixStream({ ...mix, masterTrim: 10 ** (matchDb / 20) })
    }
    await sink.start()
    if (audio?.leadIn) {
      // See `leadIn`: one packet of silence before 0 s, trimmed by the muxer.
      const lead = audio.frameSamples
      await sink.addSound({ left: new Float32Array(lead), right: new Float32Array(lead) }, -lead / MIX_SAMPLE_RATE)
    }
    if (ctx) {
      const renderOptions = { motionBlur: options.motionBlur !== false, transparent }
      for (let frame = 0; frame < frameCount; frame++) {
        options.signal?.throwIfAborted()
        const timeMs = still ? stillMs : frameToMs(plan.firstFrame + frame, plan.fps)
        while (audible && mixed < mixEnd && mixed <= mixSampleAt(timeMs)) await mixNext()
        await sources.prepare(comp, timeMs)
        renderer.render(ctx, comp, project, timeMs, plan.scale, sources, renderOptions)
        if (!transparent) backdrop(ctx)
        await sink.addFrame(frame)
        options.onProgress?.(frame + 1, frameCount)
      }
    }
    // A sound-only file has no frames: its progress counts mixed seconds.
    const seconds = Math.ceil(totalSamples / AUDIO_WINDOW)
    while (audible && mixed < mixEnd) {
      options.signal?.throwIfAborted()
      await mixNext()
      if (!ctx) options.onProgress?.(Math.ceil((mixed - base) / AUDIO_WINDOW), seconds)
    }
    if (stream) await write(stream.finish())
    finalMeasure = finalLevels.levels()
    await sink.finish()
  } catch (error) {
    await sink.cancel()
    throw error
  } finally {
    await sources.dispose()
  }

  return {
    frameCount: ctx ? frameCount : 0,
    durationMs: still ? 0 : plan.durationMs,
    startMs: still ? stillMs : plan.startMs,
    width: ctx ? plan.width : 0,
    height: ctx ? plan.height : 0,
    fps: plan.fps,
    scale: plan.scale,
    videoCodec,
    videoBitrate,
    audioBitrate,
    hasSound: audible,
    transparent,
    clippedSamples: stream?.clamped ?? 0,
    loudness: audible ? { integratedLufs: finalMeasure.integrated, truePeakDbtp: finalMeasure.truePeakDb, matchDb } : null,
  }
}
