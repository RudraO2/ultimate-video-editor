import type { MediaKind, ModelInfo } from '@uve/core'
import { ALL_FORMATS, CanvasSink, Input, type InputVideoTrack, UrlSource } from 'mediabunny'
import { type GrantedFile, mediaTypeOf, mediaUrl } from '../../../shared/media'
import { modelFormatOfName, probeModelFile } from './model'
import { silhouetteOf } from './silhouette'

/** What the editor learns about a file before adding it: the input of media.add, plus a thumbnail. */
export interface ProbedMedia {
  kind: MediaKind
  name: string
  path: string
  mime: string
  durationMs?: number
  width?: number
  height?: number
  fps?: number
  hasAudio?: boolean
  /** A 3D model's format, clips and size. */
  model?: ModelInfo
  /** A small JPEG of the picture for the library, as an object URL. */
  thumbnail?: string
  /** A picture's outline from its alpha, for physics (see `MediaAsset.silhouette`). */
  silhouette?: [number, number][][]
}

/** A file the editor cannot use, with a message for the user. */
export class ProbeError extends Error {}

const THUMBNAIL_HEIGHT = 144
/** The long side a small SVG opens at. */
const SVG_MIN_SIDE = 512

async function toObjectUrl(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<string | undefined> {
  const blob =
    canvas instanceof OffscreenCanvas
      ? await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 })
      : await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8))
  return blob ? URL.createObjectURL(blob) : undefined
}

async function probeImage(file: GrantedFile, mime: string): Promise<ProbedMedia> {
  const image = new Image()
  image.crossOrigin = 'anonymous'
  image.src = mediaUrl(file.path)
  try {
    await image.decode()
  } catch {
    throw new ProbeError(`"${file.name}" is not an image this editor can read.`)
  }
  // SVGs without a size report 0; give them a sensible one. Vectors draw sharp
  // at any size, so a small one (an icon's 32 × 32) opens at 512 on its long side.
  let width = image.naturalWidth || 512
  let height = image.naturalHeight || 512
  if (mime === 'image/svg+xml' && Math.max(width, height) < SVG_MIN_SIDE) {
    const scale = SVG_MIN_SIDE / Math.max(width, height)
    width = Math.round(width * scale)
    height = Math.round(height * scale)
  }
  const canvas = document.createElement('canvas')
  canvas.height = THUMBNAIL_HEIGHT
  canvas.width = Math.max(1, Math.round((THUMBNAIL_HEIGHT * width) / height))
  canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height)
  // JPEGs have no alpha: their silhouette is their box.
  const silhouette = mime === 'image/jpeg' ? undefined : silhouetteOf(image, width, height)
  return { kind: 'image', name: file.name, path: file.path, mime, width, height, thumbnail: await toObjectUrl(canvas), ...(silhouette ? { silhouette } : {}) }
}

async function videoThumbnail(track: InputVideoTrack, durationS: number): Promise<string | undefined> {
  try {
    const sink = new CanvasSink(track, { height: THUMBNAIL_HEIGHT, poolSize: 1 })
    // A moment in, past fades from black, but close to the first key frame so it decodes fast.
    const at = (await track.getFirstTimestamp()) + Math.min(1, durationS / 4)
    const frame = await sink.getCanvas(at)
    return frame ? await toObjectUrl(frame.canvas) : undefined
  } catch {
    return undefined
  }
}

/**
 * Reads a granted file's kind, duration, display size and frame rate, and
 * checks that this machine can decode it. Video and audio are read with
 * mediabunny straight from the media URL, so only the bytes it needs are loaded.
 */
export async function probeMedia(file: GrantedFile): Promise<ProbedMedia> {
  const type = mediaTypeOf(file.name)
  if (!type) throw new ProbeError(`"${file.name}" is not a video, image, audio or 3D model file.`)
  if (type.kind === 'image') return probeImage(file, type.mime)
  if (type.kind === 'model') {
    const format = modelFormatOfName(file.name)
    if (!format) throw new ProbeError(`"${file.name}" is not a 3D model this editor can read.`)
    try {
      return { kind: 'model', name: file.name, path: file.path, mime: type.mime, model: await probeModelFile(file.path, format) }
    } catch (error) {
      throw new ProbeError(error instanceof Error ? error.message : `Could not read "${file.name}".`)
    }
  }

  const input = new Input({ source: new UrlSource(mediaUrl(file.path)), formats: ALL_FORMATS })
  try {
    let video: InputVideoTrack | null
    let durationS: number
    try {
      video = type.kind === 'video' ? await input.getPrimaryVideoTrack() : null
      durationS = await input.computeDuration()
    } catch {
      throw new ProbeError(`"${file.name}" is damaged or in a format this editor cannot read.`)
    }
    const audio = await input.getPrimaryAudioTrack()
    const hasAudio = audio !== null && (await audio.canDecode())
    const base = { name: file.name, path: file.path, mime: type.mime, hasAudio }
    const durationMs = durationS > 0 ? Math.round(durationS * 1000) : undefined

    if (video) {
      if (!(await video.canDecode())) {
        const codec = (await video.getCodec()) ?? 'unknown'
        throw new ProbeError(`This computer cannot decode the ${codec} video in "${file.name}".`)
      }
      const stats = await video.computePacketStats(120)
      return {
        ...base,
        kind: 'video',
        durationMs,
        width: await video.getDisplayWidth(),
        height: await video.getDisplayHeight(),
        fps: stats.averagePacketRate > 0 ? Math.round(stats.averagePacketRate * 1000) / 1000 : undefined,
        thumbnail: await videoThumbnail(video, durationS),
      }
    }
    // An audio file, or a video file that only carries sound.
    if (!audio) throw new ProbeError(`"${file.name}" has no picture or sound in it.`)
    if (!hasAudio) throw new ProbeError(`This computer cannot decode the sound in "${file.name}".`)
    return { ...base, kind: 'audio', durationMs }
  } finally {
    input.dispose()
  }
}
