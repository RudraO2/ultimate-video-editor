import type { MediaAsset } from '@uve/core'
import { traceSilhouette } from '@uve/engine'
import { mediaUrl } from '../../../shared/media'

// A picture's silhouette for physics: its alpha traced once, at a small size,
// and kept on the media item, so bodies collide on their outline.

/** The long side a picture is traced at. */
const TRACE_SIDE = 256

/** Traces a decoded picture: polygons in fractions of its width and height, or undefined when it has no visible pixels. */
export function silhouetteOf(image: CanvasImageSource, width: number, height: number): [number, number][][] | undefined {
  const k = Math.min(1, TRACE_SIDE / Math.max(width, height))
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(width * k)), Math.max(1, Math.round(height * k)))
  const ctx = canvas.getContext('2d')
  if (!ctx) return undefined
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
  const polygons = traceSilhouette(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)
  return polygons.length > 0 ? polygons.map((p) => p.map(([x, y]) => [x, y] as [number, number])) : undefined
}

/** Loads a picture from Media and traces it (for pictures imported before silhouettes were kept). */
export async function silhouetteOfMedia(media: MediaAsset): Promise<[number, number][][] | undefined> {
  if (media.kind !== 'image') return undefined
  const image = new Image()
  image.crossOrigin = 'anonymous'
  image.src = mediaUrl(media.path)
  try {
    await image.decode()
  } catch {
    return undefined
  }
  return silhouetteOf(image, media.width ?? image.naturalWidth ?? 512, media.height ?? image.naturalHeight ?? 512)
}
