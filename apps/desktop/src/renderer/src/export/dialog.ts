import type { Comp } from '@uve/core'
import { renderPlan } from '@uve/engine'
import type { ExportSettings } from './job'
import type { ExportFormat } from './formats'
import { EXPORT_QUALITIES, type ExportQuality, MAX_EXPORT_SCALE, MIN_EXPORT_SCALE } from './options'

// The export dialog's choices, as AtomCut's live export panel (4.17.0) lays
// them out: an Image or Video kind, a format, the range, size and frame rate
// presets, switches, and quality and audio bitrate under Advanced. Pure, so
// the dialog's rules are tested here and the component only draws them.

/** Image (one frame) or Video (every other format), as AtomCut's kind toggle. */
export type ExportKind = 'image' | 'video'

export type VideoFormat = Extract<ExportFormat, 'mp4' | 'mov' | 'webm' | 'gif' | 'png-seq' | 'audio'>
export type ImageFormat = Extract<ExportFormat, 'png' | 'jpg' | 'webp'>

/** The Video kind's formats with AtomCut's labels, in its order. */
export const VIDEO_FORMATS: readonly { id: VideoFormat; label: string }[] = [
  { id: 'mp4', label: 'MP4 video' },
  { id: 'mov', label: 'Master — lossless MOV' },
  { id: 'webm', label: 'WebM video' },
  { id: 'gif', label: 'Animated GIF' },
  { id: 'png-seq', label: 'PNG sequence' },
  { id: 'audio', label: 'Audio only (WAV)' },
]

/** The Image kind's formats (AtomCut has PNG; JPG and WebP are ours). */
export const IMAGE_FORMATS: readonly { id: ImageFormat; label: string }[] = [
  { id: 'png', label: 'PNG' },
  { id: 'jpg', label: 'JPG' },
  { id: 'webp', label: 'WebP' },
]

/** Resolution presets by the output's short side, as AtomCut's Size menu. */
export const RESOLUTION_PRESETS: readonly { label: string; tag: string; side: number }[] = [
  { label: '360p', tag: '', side: 360 },
  { label: '480p', tag: 'SD', side: 480 },
  { label: '720p', tag: 'HD', side: 720 },
  { label: '1080p', tag: 'Full HD', side: 1080 },
  { label: '1440p', tag: 'QHD', side: 1440 },
  { label: '4K', tag: 'UHD', side: 2160 },
]

/** Scale presets, as AtomCut's. */
export const SCALE_PRESETS: readonly number[] = [0.5, 1, 1.5, 2, 3, 4]

/** Frame rate presets with AtomCut's notes. */
export const FPS_PRESETS: readonly { fps: number; label: string }[] = [
  { fps: 8, label: 'Rough / thumbnail' },
  { fps: 12, label: 'Hand-drawn animation' },
  { fps: 15, label: 'Limited animation' },
  { fps: 23.976, label: 'Film (NTSC pulldown)' },
  { fps: 24, label: 'Film' },
  { fps: 25, label: 'PAL broadcast' },
  { fps: 29.97, label: 'NTSC broadcast' },
  { fps: 30, label: 'Standard video' },
  { fps: 50, label: 'PAL high frame rate' },
  { fps: 59.94, label: 'NTSC high frame rate' },
  { fps: 60, label: 'Smooth / UI motion' },
  { fps: 120, label: 'High frame rate' },
]

/** GIF delays are whole hundredths of a second: it plays at most this many frames a second. */
export const GIF_MAX_FPS = 50

/** Everything the dialog holds. Settings for formats not chosen are kept, so switching back restores them. */
export interface ExportForm {
  kind: ExportKind
  videoFormat: VideoFormat
  imageFormat: ImageFormat
  /** Used only when a working range is on for the comp. */
  range: 'full' | 'span'
  scale: number
  /** As typed: may be out of range or empty (NaN), and is checked by the export. */
  fps: number
  quality: ExportQuality
  /** Kilobits per second. */
  audioBitrate: number
  includeAudio: boolean
  transparent: boolean
  motionBlur: boolean
  /** A still's moment, in ms of comp time. */
  atMs: number
}

/** Which rows the dialog shows for a format. `advanced` is the collapsible box (quality and audio bitrate). */
export interface ExportFields {
  range: boolean
  size: boolean
  fps: boolean
  includeAudio: boolean
  transparent: boolean
  motionBlur: boolean
  atMs: boolean
  quality: boolean
  audioBitrate: boolean
}

/** The form an export of `comp` opens with: a PNG still for a static frame, else an MP4 of the working range when one is on. */
export function initialForm(comp: Comp, view: { timeMs: number; rangeOn: boolean }): ExportForm {
  return {
    kind: comp.mode === 'static' ? 'image' : 'video',
    videoFormat: 'mp4',
    imageFormat: 'png',
    range: view.rangeOn ? 'span' : 'full',
    scale: 1,
    fps: comp.fps,
    quality: 'high',
    audioBitrate: 192,
    includeAudio: true,
    transparent: false,
    motionBlur: true,
    atMs: Math.min(Math.max(0, view.timeMs), comp.durationMs),
  }
}

/** The format the form exports. */
export const formatOf = (form: ExportForm): ExportFormat => (form.kind === 'image' ? form.imageFormat : form.videoFormat)

/** The Video formats offered: audio only when the comp makes sound. */
export function videoFormatsFor(hasSound: boolean): readonly { id: VideoFormat; label: string }[] {
  return hasSound ? VIDEO_FORMATS : VIDEO_FORMATS.filter((f) => f.id !== 'audio')
}

/** The rows a format shows; `rangeOn` when a working range is on for the comp. */
export function fieldsOf(format: ExportFormat, rangeOn: boolean): ExportFields {
  const still = format === 'png' || format === 'jpg' || format === 'webp'
  const audio = format === 'audio'
  const picture = !audio
  return {
    range: rangeOn && !still,
    size: picture,
    fps: picture && !still,
    includeAudio: format === 'mp4' || format === 'mov' || format === 'webm',
    transparent: format !== 'mp4' && format !== 'jpg' && !audio,
    motionBlur: picture,
    atMs: still,
    quality: format === 'mp4' || format === 'webm' || format === 'jpg' || format === 'webp',
    audioBitrate: format === 'mp4' || format === 'webm',
  }
}

/** The export settings the form comes to: only what its format uses, so `exportRenderOptions` refuses nothing it does not show. */
export function settingsOf(form: ExportForm, rangeOn: boolean): ExportSettings {
  const format = formatOf(form)
  const fields = fieldsOf(format, rangeOn)
  const settings: ExportSettings = { format, motionBlur: form.motionBlur }
  if (fields.size) settings.scale = form.scale
  if (!fields.atMs) settings.range = fields.range ? form.range : 'full'
  if (fields.fps) settings.fps = form.fps
  if (fields.includeAudio) settings.includeAudio = form.includeAudio
  if (fields.transparent) settings.transparent = form.transparent
  if (fields.atMs) settings.atMs = form.atMs
  if (fields.quality) settings.quality = form.quality
  if (fields.audioBitrate) settings.audioBitrate = form.audioBitrate
  return settings
}

/** The output size of `comp` at `scale`, rounded as the export rounds it. */
export function scaledSize(comp: Comp, scale: number): { width: number; height: number } {
  const { width, height } = renderPlan(comp, undefined, { scale })
  return { width, height }
}

/** The scale of a resolution preset for `comp` (its short side becomes `side`), or null when it is outside 0.05 to 4. */
export function resolutionScale(comp: Pick<Comp, 'width' | 'height'>, side: number): number | null {
  const scale = side / Math.min(comp.width, comp.height)
  return scale >= MIN_EXPORT_SCALE && scale <= MAX_EXPORT_SCALE ? scale : null
}

/** The resolution preset a scale matches for `comp`, if any. */
export function resolutionOf(comp: Pick<Comp, 'width' | 'height'>, scale: number): (typeof RESOLUTION_PRESETS)[number] | undefined {
  return RESOLUTION_PRESETS.find((p) => Math.abs(p.side / Math.min(comp.width, comp.height) - scale) < 1e-6)
}

/** A scale as the Size menu shows it: "1×", "0.67×". */
export function scaleLabel(scale: number): string {
  return `${Number(scale.toFixed(2))}×`
}

/** The frame rate presets a format offers (GIF: up to 50). */
export function fpsPresetsFor(format: ExportFormat): readonly { fps: number; label: string }[] {
  return format === 'gif' ? FPS_PRESETS.filter((p) => p.fps <= GIF_MAX_FPS) : FPS_PRESETS
}

/** The quality steps with their labels. */
export const QUALITY_LABELS: Record<ExportQuality, string> = { draft: 'Draft', high: 'High', master: 'Master' }
export { EXPORT_QUALITIES }

/** Seconds as the summary shows them: "10.0s". */
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`

/** A frame rate without trailing zeros: 30, 23.976. */
export const fpsLabel = (fps: number): string => String(Number(fps.toFixed(3)))

/**
 * The summary line under the fields, as AtomCut's: "1920×1080 · 30 fps · 10.0s";
 * audio only "10.0s"; a still "1920×1080 · at 1.0s".
 */
export function summaryOf(
  format: ExportFormat,
  plan: { width: number; height: number; fps: number; durationMs: number },
  atMs?: number,
): string {
  if (format === 'audio') return seconds(plan.durationMs)
  const size = `${plan.width}×${plan.height}`
  if (atMs !== undefined) return `${size} · at ${seconds(atMs)}`
  return `${size} · ${fpsLabel(plan.fps)} fps · ${seconds(plan.durationMs)}`
}
