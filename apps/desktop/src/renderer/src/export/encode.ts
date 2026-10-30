import type { Stereo } from '@uve/engine'
import { type AudioCodec, Mp4OutputFormat, type OutputFormat, type VideoCodec, WavOutputFormat, WebMOutputFormat } from 'mediabunny'
import type { ExportExtension } from '../../../shared/export'
import type { ExportFormat } from './formats'

/**
 * How a render is written: the container and the codecs in it. `renderComp`
 * takes one of these; the formats an export can ask for map onto them. The
 * bitrates come with the export's options, not from here.
 */
export interface EncodeSpec {
  /** Short name for messages, e.g. "MP4". */
  label: string
  /** File extension without the dot (of each file, for a PNG sequence). */
  extension: ExportExtension
  /**
   * Makes a fresh container for one file, or names our own writer: `mov` our
   * QuickTime muxer (`mov.ts`, the only one that takes PNG frames), `gif` our
   * GIF writer (`gif.ts`), `png-seq` a folder with a PNG per frame, `still`
   * one image of one frame.
   */
  container: (() => OutputFormat) | 'mov' | 'gif' | 'png-seq' | 'still'
  /**
   * The picture: codecs in order of preference (the first this computer can
   * encode is used); `png`, `jpeg` or `webp` for an image per frame (written by
   * the canvas); `gif` for GIF frames; or null for a sound-only file.
   */
  video: { codecs: VideoCodec[] } | ImageCodec | 'gif' | null
  /** Whether the picture can keep transparency (`transparent`). */
  alpha: boolean
  /** The highest frame rate the format plays (GIF: 50, its delays are in hundredths); none when absent. */
  maxFps?: number
  /** The sound, or null for a format that has none (images). */
  audio: {
    codec: AudioCodec
    label: string
    /** Samples per encoded packet, for the muxer's packet budget. */
    frameSamples: number
    /** Whether the codec takes a bitrate (PCM does not). */
    compressed: boolean
    /**
     * Encode one packet of silence before 0 s. AAC's first packet decodes
     * imperfectly (its first ~10 ms come out silent), so the lead-in takes
     * that loss and the muxer trims it with an edit list, as ffmpeg does with
     * its priming.
     */
    leadIn: boolean
  } | null
}

/** Images the canvas writes (`convertToBlob`), by their MIME subtype. */
export type ImageCodec = 'png' | 'jpeg' | 'webp'

/** Names of video codecs for messages. */
export const VIDEO_CODEC_LABELS: Partial<Record<VideoCodec, string>> = { avc: 'H.264', vp9: 'VP9', vp8: 'VP8', av1: 'AV1', hevc: 'HEVC' }

/** H.264 video and AAC sound in an MP4, its index reserved at the start ("fast start") so players can begin before the end loads. */
export const MP4_H264_AAC: EncodeSpec = {
  label: 'MP4',
  extension: 'mp4',
  container: () => new Mp4OutputFormat({ fastStart: 'reserve' }),
  video: { codecs: ['avc'] },
  alpha: false,
  audio: { codec: 'aac', label: 'AAC', frameSamples: 1024, compressed: true, leadIn: true },
}

/**
 * VP9 (else VP8) video and Opus sound in a WebM. Opus carries its own
 * pre-skip, so no lead-in. A transparent picture keeps its alpha as a second,
 * alpha-only stream (mediabunny's `alpha: 'keep'`).
 */
export const WEBM_VP9_OPUS: EncodeSpec = {
  label: 'WebM',
  extension: 'webm',
  container: () => new WebMOutputFormat(),
  video: { codecs: ['vp9', 'vp8'] },
  alpha: true,
  audio: { codec: 'opus', label: 'Opus', frameSamples: 960, compressed: true, leadIn: false },
}

/** AtomCut's lossless master: a PNG per frame (with alpha when transparent) and 16-bit PCM sound (`sowt`) in a QuickTime MOV. */
export const MOV_PNG_PCM: EncodeSpec = {
  label: 'MOV',
  extension: 'mov',
  container: 'mov',
  video: 'png',
  alpha: true,
  audio: { codec: 'pcm-s16', label: '16-bit PCM', frameSamples: 1, compressed: false, leadIn: false },
}

/** The 48 kHz mix as 16-bit PCM in a WAV file, with no picture. */
export const WAV_PCM16: EncodeSpec = {
  label: 'WAV',
  extension: 'wav',
  container: () => new WavOutputFormat(),
  video: null,
  alpha: false,
  audio: { codec: 'pcm-s16', label: '16-bit PCM', frameSamples: 1024, compressed: false, leadIn: false },
}

/**
 * AtomCut's animated GIF: a palette per frame, no dithering, looping forever;
 * pixels under half alpha are transparent when `transparent`. No sound; at
 * most 50 fps (delays are whole hundredths of a second, at least 2).
 */
export const GIF: EncodeSpec = {
  label: 'GIF',
  extension: 'gif',
  container: 'gif',
  video: 'gif',
  alpha: true,
  maxFps: 50,
  audio: null,
}

/** A folder `<name>-png-seq` with `frame-000.png`, … from 0 (padded to the frame count's digits); no sound. */
export const PNG_SEQUENCE: EncodeSpec = {
  label: 'PNG sequence',
  extension: 'png',
  container: 'png-seq',
  video: 'png',
  alpha: true,
  audio: null,
}

/** One frame as an image: PNG (as AtomCut), JPEG or WebP. JPEG has no alpha. */
function still(video: ImageCodec, extension: ExportExtension, label: string): EncodeSpec {
  return { label, extension, container: 'still', video, alpha: video !== 'jpeg', audio: null }
}

export const PNG_STILL = still('png', 'png', 'PNG')
export const JPG_STILL = still('jpeg', 'jpg', 'JPG')
export const WEBP_STILL = still('webp', 'webp', 'WebP')

/** Mix samples as 16-bit PCM, the two channels interleaved, rounded as mediabunny writes `pcm-s16` (so a MOV's sound equals the WAV's). */
export function interleavePcm16(stereo: Stereo): Int16Array {
  const count = stereo.left.length
  const out = new Int16Array(count * 2)
  const s16 = (value: number) => Math.min(32767, Math.max(-32768, Math.round(value * 32768)))
  for (let i = 0; i < count; i++) {
    out[2 * i] = s16(stereo.left[i] as number)
    out[2 * i + 1] = s16(stereo.right[i] as number)
  }
  return out
}

/** The encoding of a format. */
export function encodeSpecOf(format: ExportFormat): EncodeSpec {
  switch (format) {
    case 'mp4':
      return MP4_H264_AAC
    case 'webm':
      return WEBM_VP9_OPUS
    case 'mov':
      return MOV_PNG_PCM
    case 'audio':
      return WAV_PCM16
    case 'gif':
      return GIF
    case 'png-seq':
      return PNG_SEQUENCE
    case 'png':
      return PNG_STILL
    case 'jpg':
      return JPG_STILL
    case 'webp':
      return WEBP_STILL
  }
}
