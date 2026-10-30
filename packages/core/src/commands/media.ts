import { z } from 'zod'
import { findMedia, layersUsing, locateLayer } from '../doc'
import { CommandError, parseOrThrow } from '../errors'
import { defineCommand } from '../registry'
import { IdSchema, MEDIA_KINDS, MediaAssetSchema, SpeechInfoSchema } from '../schema'

export const mediaAdd = defineCommand({
  name: 'media.add',
  summary: 'Register a media file (video, image, audio or 3D model) so layers can use it.',
  details:
    'path is an absolute file path or URL. Give durationMs, width, height and fps when known; the editor fills them in itself when it imports a file. A 3D model (kind model) also needs model, {format, clips, size} as the editor reads it (world_import_model does this for you). A file that is already registered with the same kind is reused: the result has its id and reused: true.',
  effect: 'write',
  input: z.strictObject({
    kind: z.enum(MEDIA_KINDS),
    name: z.string().min(1),
    path: z.string().min(1),
    mime: z.string().optional(),
    durationMs: z.number().positive().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    fps: z.number().positive().optional(),
    hasAudio: z.boolean().optional(),
    model: MediaAssetSchema.shape.model,
    credit: MediaAssetSchema.shape.credit,
    silhouette: MediaAssetSchema.shape.silhouette,
    speech: MediaAssetSchema.shape.speech,
  }),
  run: (input, ctx) => {
    if (input.kind === 'model' && !input.model) throw new CommandError('A model needs model: {format, clips, size}.', 'world_import_model reads the file and registers it; media.add only records what you give it.')
    if (input.kind !== 'model' && input.model) throw new CommandError('model only applies to 3D models (kind model).')
    const known = ctx.project.media.find((m) => m.path === input.path && m.kind === input.kind)
    if (known) return { id: known.id, reused: true }
    const asset = parseOrThrow(MediaAssetSchema, { id: ctx.ids('media'), ...input }, 'The media entry')
    ctx.write('Add media', (draft) => {
      draft.media.push(asset)
    })
    return { id: asset.id }
  },
})

export const mediaList = defineCommand({
  name: 'media.list',
  summary: 'Every registered media file with its kind, size, duration and the number of layers using it.',
  effect: 'read',
  input: z.strictObject({}),
  run: (_input, ctx) => ctx.project.media.map((m) => ({ ...m, usedBy: layersUsing(ctx.project, m.id).length })),
})

export const mediaRemove = defineCommand({
  name: 'media.remove',
  summary: 'Remove a media file from the project. The file on disk is not touched.',
  details: 'A file that layers still use is kept unless deleteLayers is true, which deletes those layers too.',
  effect: 'write',
  input: z.strictObject({ id: IdSchema, deleteLayers: z.boolean().default(false) }),
  run: ({ id, deleteLayers }, ctx) => {
    const media = findMedia(ctx.project, id)
    const users = layersUsing(ctx.project, media.id).map((l) => l.id)
    if (users.length > 0 && !deleteLayers) {
      throw new CommandError(
        `"${media.name}" is used by ${users.length} layer${users.length === 1 ? '' : 's'}: ${users.join(', ')}.`,
        'Delete those layers first, or pass deleteLayers: true.',
      )
    }
    ctx.write('Remove media', (draft) => {
      for (const layerId of users) {
        const location = locateLayer(draft, layerId)
        location.track.layers.splice(location.layerIndex, 1)
      }
      draft.media = draft.media.filter((m) => m.id !== media.id)
    })
    return { removed: media.id, deletedLayers: users }
  },
})

export const mediaEnvelope = defineCommand({
  name: 'media.envelope',
  summary: "Read a voice's loudness over time and keep it on the media item: what talk and nod behaviours follow.",
  details: 'character.bringToLife does this itself; call it when building a talking character step by step (or from its dryRun script). Needs an editor that can decode sound.',
  effect: 'write',
  input: z.strictObject({ mediaId: IdSchema }),
  async run({ mediaId }, ctx) {
    const media = findMedia(ctx.project, mediaId)
    if (media.kind !== 'audio' && media.kind !== 'video') throw new CommandError(`${media.name} has no sound.`, 'Give an audio or video media id (media.list).')
    if (!ctx.envelope) throw new CommandError('This editor cannot read sound here.', 'Run it in the desktop app.')
    const traced = await ctx.envelope(media)
    if (!traced) throw new CommandError(`Could not read the loudness of ${media.name}.`, 'Check that the file is still where the project says.')
    ctx.write('Read voice loudness', (draft) => {
      const target = draft.media.find((m) => m.id === mediaId)
      if (target) target.envelope = { rate: traced.rate, values: traced.values }
    })
    return { mediaId, rate: traced.rate, samples: traced.values.length }
  },
})

export const mediaSpeech = defineCommand({
  name: 'media.speech',
  summary: 'Keep what a voice take says on its media: its script, language, voice and word times (media_transcribe and generate_speech do this for you).',
  details:
    'speech: {text, language, voice?, provider?, pace?, startMs, endMs, words: [{text, startMs, endMs}], source?}, times in ms from the start of the file; null clears it. Captions, translations and comp_localize read it.',
  effect: 'write',
  input: z.strictObject({ mediaId: IdSchema, speech: z.union([SpeechInfoSchema, z.null()]) }),
  run: ({ mediaId, speech }, ctx) => {
    const media = findMedia(ctx.project, mediaId)
    if (media.kind !== 'audio' && media.kind !== 'video') throw new CommandError(`${media.name} has no sound.`, 'Give an audio or video media id (media.list).')
    if (speech) {
      if (speech.endMs < speech.startMs) throw new CommandError('speech.endMs is before speech.startMs.')
      let last = 0
      for (const [i, word] of speech.words.entries()) {
        if (word.endMs < word.startMs || word.startMs < last - 1) throw new CommandError(`Word ${i + 1} ("${word.text}") is out of order or ends before it starts.`, 'Words are in spoken order, each with startMs ≤ endMs.')
        last = word.endMs
      }
    }
    ctx.write(speech ? 'Set speech' : 'Clear speech', (draft) => {
      const target = draft.media.find((m) => m.id === mediaId)
      if (!target) return
      if (speech) target.speech = speech
      else delete target.speech
    })
    return { mediaId, words: speech?.words.length ?? 0 }
  },
})
