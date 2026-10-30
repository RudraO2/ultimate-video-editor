import { CommandError, defineCommand, findComp, locateLayer, type MediaAsset } from '@uve/core'
import { CutoutError, removeFlatBackground } from '@uve/engine'
import { z } from 'zod'
import { mediaUrl } from '../../../shared/media'
import { mediaInput } from '../media/import'
import { probeMedia } from '../media/probe'
import { useEditor } from '../store'

// Removing a picture's flat background (AtomCut's media_remove_background):
// the engine's keyer makes the ground transparent, the result is kept as a
// new PNG beside the original (which stays in the media library), and the
// layer it came from switches to it.

const HEX = /^#?([0-9a-f]{6})$/i

const hexOf = ([r, g, b]: readonly number[]) => '#' + [r, g, b].map((v) => Math.round(v ?? 0).toString(16).padStart(2, '0')).join('')

/** The picture's pixels at its own size. */
async function pixels(media: MediaAsset): Promise<ImageData> {
  const image = new Image()
  image.crossOrigin = 'anonymous'
  image.src = mediaUrl(media.path)
  try {
    await image.decode()
  } catch {
    throw new CommandError(`Could not read "${media.name}".`, 'Check that the file is still on disk.')
  }
  const canvas = new OffscreenCanvas(image.naturalWidth, image.naturalHeight)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new CommandError('Could not draw the picture.')
  ctx.drawImage(image, 0, 0)
  return ctx.getImageData(0, 0, canvas.width, canvas.height)
}

export const mediaRemoveBackground = defineCommand({
  name: 'media.remove_background',
  summary:
    "Make a picture's flat background transparent (a studio white, a key green or magenta, any one colour): a new PNG; the layer switches to it, the original stays in Media.",
  details:
    'id: an image layer (it switches to the cut-out and keeps its transform, timing, effects and keys) or an image media id (the cut-out is added to Media; place also puts it on the timeline). The ground colour is read from the borders; edges stay soft and lose the ground colour. Holes (ground colour inside the subject) are cleared on a saturated ground and kept on white, grey or black; holes overrides. A photo with a real background, a video, or an SVG is refused: for a flat video backdrop add the chromaKey effect. model is accepted for AtomCut and ignored (this is a colour key, not an AI model). Returns mediaId, the layer id when one changed or was placed, background (hex) and cleared (share of pixels made transparent).',
  effect: 'write',
  input: z.strictObject({
    id: z.string().min(1).describe('An image layer, or an image media id'),
    model: z.string().optional().describe('Ignored: the background is removed by colour'),
    replace: z.boolean().default(true).describe('Switch the layer to the cut-out (with a layer id)'),
    place: z
      .strictObject({
        startMs: z.number().min(0).optional(),
        durationMs: z.number().positive().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        above: z.string().optional().describe('Accepted for AtomCut; the new layer goes on top'),
        frameId: z.string().optional().describe('The comp; default the open one'),
      })
      .optional()
      .describe('Also put the cut-out on the timeline as a new layer'),
    background: z.string().regex(HEX).optional().describe('The ground colour as #rrggbb; default read from the borders'),
    tolerance: z.number().min(0).max(441).optional().describe('How far from the ground colour still counts as ground (RGB distance); default from the borders'),
    holes: z.boolean().optional(),
  }),
  run: async ({ id, replace, place, background, tolerance, holes }, ctx) => {
    let layerId: string | null = null
    let media = ctx.project.media.find((m) => m.id === id)
    if (!media) {
      const { layer } = locateLayer(ctx.project, id)
      if (!('mediaId' in layer) || typeof layer.mediaId !== 'string') {
        throw new CommandError(`"${layer.name}" is a ${layer.kind} layer, not a picture.`, 'Give an image layer or an image media id.')
      }
      layerId = layer.id
      media = ctx.project.media.find((m) => m.id === layer.mediaId)
    }
    if (!media) throw new CommandError(`No media "${id}".`, 'media.list lists the media in the project.')
    if (media.kind === 'video') throw new CommandError('Backgrounds are removed from pictures only.', 'For a flat video backdrop add the chromaKey effect (effects.add).')
    if (media.kind !== 'image') throw new CommandError(`"${media.name}" is not a picture.`)
    if (media.mime === 'image/svg+xml' || media.path.toLowerCase().endsWith('.svg')) {
      throw new CommandError('An SVG already has a transparent background.', 'Use it as it is.')
    }

    const source = await pixels(media)
    let cut
    try {
      const hex = background ? HEX.exec(background)?.[1] : undefined
      cut = removeFlatBackground(
        { width: source.width, height: source.height, data: source.data },
        {
          ...(hex ? { background: [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number] } : {}),
          ...(tolerance !== undefined ? { tolerance } : {}),
          ...(holes !== undefined ? { holes } : {}),
        },
      )
    } catch (error) {
      if (error instanceof CutoutError) {
        throw new CommandError(error.message, 'This removes one flat background colour. For a backdrop on video, add the chromaKey effect.')
      }
      throw error
    }

    const canvas = new OffscreenCanvas(cut.width, cut.height)
    canvas.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(cut.data), cut.width, cut.height), 0, 0)
    const png = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())
    const baseName = media.name.replace(/\.[^.]+$/, '')
    const file = await window.uve.media.writeCutout(`${baseName} cutout`, png)
    const probed = await probeMedia(file)
    if (probed.thumbnail) useEditor.setState((s) => ({ thumbnails: { ...s.thumbnails, [probed.path]: probed.thumbnail as string } }))
    const added = await ctx.call('media.add', {
      ...mediaInput(probed),
      name: `${baseName} (cut out).png`,
      ...(media.credit ? { credit: media.credit } : {}),
    })
    if (!added.ok) throw new CommandError(added.error, added.hint)
    const mediaId = (added.value as { id: string }).id

    const out = { mediaId, background: hexOf(cut.background), cleared: Math.round(cut.cleared * 1000) / 1000, holes: cut.holes }
    if (layerId && replace) {
      const patched = await ctx.call('layer.patch', { id: layerId, ops: [{ op: 'set', path: 'mediaId', value: mediaId }] })
      if (!patched.ok) throw new CommandError(patched.error, patched.hint)
    }
    if (place) {
      const comp = findComp(ctx.project, place.frameId ?? useEditor.getState().activeCompId)
      const created = await ctx.call('layer.create', {
        compId: comp.id,
        kind: 'image',
        mediaId,
        startMs: place.startMs ?? useEditor.getState().timeMs,
        ...(place.durationMs !== undefined ? { durationMs: place.durationMs } : {}),
        ...(place.x !== undefined || place.y !== undefined ? { transform: { x: place.x ?? 0, y: place.y ?? 0 } } : {}),
      })
      if (!created.ok) throw new CommandError(created.error, created.hint)
      return { ...out, layerId: (created.value as { id: string }).id }
    }
    return layerId ? { ...out, layerId, replaced: replace } : out
  },
})
