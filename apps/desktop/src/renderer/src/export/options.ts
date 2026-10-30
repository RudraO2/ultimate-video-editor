import { CommandError } from '@uve/core'

/** The quality steps of AtomCut's export panel: the video bitrate is the recommended one times 0.5, 1 or 2. */
export const EXPORT_QUALITIES = ['draft', 'high', 'master'] as const
export type ExportQuality = (typeof EXPORT_QUALITIES)[number]

/** The audio bitrate when none is asked for, in bits per second. */
export const DEFAULT_AUDIO_BITRATE = 192_000

/** The smallest and largest export scale: output pixels per comp pixel. */
export const MIN_EXPORT_SCALE = 0.05
export const MAX_EXPORT_SCALE = 4

const MIN_VIDEO_BITRATE = 100_000
const MAX_VIDEO_BITRATE = 500_000_000
const MIN_AUDIO_BITRATE = 64_000
const MAX_AUDIO_BITRATE = 320_000

/** The video bitrate that suits a picture size and frame rate, in bits per second: 0.4 bit per pixel, between 8 and 120 Mbps. */
export function recommendedBitrate(width: number, height: number, fps: number): number {
  return Math.min(120_000_000, Math.max(8_000_000, width * height * fps * 0.4))
}

/** The video bitrate of a quality step, in whole bits per second: the recommended one times 0.5 (draft), 1 (high) or 2 (master). */
export function qualityBitrate(quality: ExportQuality, width: number, height: number, fps: number): number {
  const factor = quality === 'draft' ? 0.5 : quality === 'master' ? 2 : 1
  return Math.round(recommendedBitrate(width, height, fps) * factor)
}

/** A frame rate clamped to 1 to 240 and rounded to 3 decimals (23.976 stays). Throws a command error for a value that is not a number. */
export function clampFps(fps: number): number {
  if (!Number.isFinite(fps)) {
    throw new CommandError('fps must be a number.', 'Give a frame rate such as 24, 30, 60 or 23.976.')
  }
  return Math.round(Math.min(240, Math.max(1, fps)) * 1000) / 1000
}

/** A video bitrate as agents give it, in bits per second: below 1000 is megabits per second (25 is 25 Mbps). Throws a command error outside 100 kbps to 500 Mbps. */
export function videoBitrateOf(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new CommandError('The video bitrate must be a positive number.', 'Give megabits per second (25) or bits per second (25000000).')
  }
  const bits = Math.round(value < 1000 ? value * 1_000_000 : value)
  if (bits < MIN_VIDEO_BITRATE || bits > MAX_VIDEO_BITRATE) {
    throw new CommandError(
      `The video bitrate ${bits} bit/s is out of range.`,
      'Use 100 kbps to 500 Mbps: 0.1 to 500 as megabits per second, or 100000 to 500000000 as bits per second.',
    )
  }
  return bits
}

/** An audio bitrate as agents give it, in bits per second: below 1000 is kilobits per second (192 is 192 kbps). Clamped to 64 to 320 kbps, as AtomCut. Throws a command error for a non-positive or non-numeric value. */
export function audioBitrateOf(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new CommandError('The audio bitrate must be a positive number.', 'Give kilobits per second (192) or bits per second (192000).')
  }
  const bits = Math.round(value < 1000 ? value * 1000 : value)
  return Math.min(MAX_AUDIO_BITRATE, Math.max(MIN_AUDIO_BITRATE, bits))
}

/** The export scale when it is a number from 0.05 to 4, else a command error. */
export function checkScale(scale: number): number {
  if (!Number.isFinite(scale) || scale < MIN_EXPORT_SCALE || scale > MAX_EXPORT_SCALE) {
    throw new CommandError('scale must be between 0.05 and 4.', "1 is the comp's own size; 0.5 is half, 2 is double.")
  }
  return scale
}
