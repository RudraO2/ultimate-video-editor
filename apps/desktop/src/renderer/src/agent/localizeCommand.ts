import { categoryForFileName, CommandError, compsInside, defineCommand, findComp, fitPace, layerEnd, locateLayer, type Project, type SpeechInfo, takeSlots } from '@uve/core'
import { z } from 'zod'
import { languageCode, SARVAM_LANGUAGES, TRANSLATE_MODES, TTS_MODELS } from '../../../shared/sarvam'
import { useEditor } from '../store'
import { speak, type Take, translateText } from './voiceCommands'

// A comp in another language (comp_localize): a copy whose text is translated
// and whose every voice take is spoken again in the new language. Timing comes
// from each new take's real length: a take keeps the moment its voice starts;
// one that runs past the room it had is read a little faster, and what still
// does not fit gets room made after it (timeline.insert_time), so the scenes
// after it wait for the voice. Captions are re-timed to the new words.

type Call = (name: string, input: unknown) => Promise<{ ok: true; value: unknown } | { ok: false; error: string; hint?: string }>

const must = async <T>(result: Promise<{ ok: true; value: unknown } | { ok: false; error: string; hint?: string }>): Promise<T> => {
  const done = await result
  if (!done.ok) throw new CommandError(done.error, done.hint)
  return done.value as T
}

interface VoiceTake {
  layerId: string
  mediaId: string
  speech: SpeechInfo
}

/** The comp time a take's voice starts and ends, from its layer as it is now. */
function placed(project: Project, take: VoiceTake): { startMs: number; endMs: number; layerStart: number } {
  const { layer } = locateLayer(project, take.layerId)
  const source = layer.kind === 'audio' || layer.kind === 'video' ? layer.sourceStartMs : 0
  return { startMs: layer.startMs + take.speech.startMs - source, endMs: layer.startMs + take.speech.endMs - source, layerStart: layer.startMs }
}

/** The voice takes of a comp: audio layers whose media says what it speaks, or that sound like a voice (category or file name). */
function voiceLayers(project: Project, compId: string): { layerId: string; mediaId: string }[] {
  const comp = findComp(project, compId)
  const out: { layerId: string; mediaId: string }[] = []
  for (const track of comp.tracks) {
    if (track.muted) continue
    for (const layer of track.layers) {
      if (layer.kind !== 'audio') continue
      const media = project.media.find((m) => m.id === layer.mediaId)
      if (!media) continue
      if (media.speech || layer.soundBus === 'voice' || categoryForFileName(media.name) === 'voice' || categoryForFileName(media.path) === 'voice') out.push({ layerId: layer.id, mediaId: media.id })
    }
  }
  return out
}

export const compLocalize = defineCommand({
  name: 'comp.localize',
  summary:
    'Make a comp speak another Indian language: a copy with its text translated, each voice take spoken again by a Sarvam voice, the timeline re-timed from the new takes, and captions re-timed to the new words.',
  details:
    'Voice takes are the comp\'s audio layers whose media knows its script (generate_speech, media_transcribe) or that are voice by category or file name (vo-*.wav); a take without a script is heard first (Sarvam speech to text). Each take is translated and spoken again with voice (default: the take\'s own voice, else shubh), placed so its voice starts where the old one did. fit: "room" (default) reads a take that runs long up to maxPace faster, then opens the time still missing right after it (timeline.insert_time), so everything after waits; "pace" only speeds up (the voice may run into the next); "none" keeps each take at pace. Text layers (in nested comps too) are translated; keep lists words to leave as they are (brand names). A caption over a take gets that take\'s new words, word-synced. copy (default true) makes a new frame named "<name> · <language>"; false changes the comp itself. Returns the comp id, each take (old and new voice length, pace, room made), text changed, and costInr. Run it once per language from the original comp.',
  effect: 'write',
  input: z.strictObject({
    compId: z.string().optional().describe('Default the open comp (AtomCut: frameId)'),
    language: z.string().min(2).describe('Target: hi-IN, ta-IN, bn-IN, te-IN, kn-IN, ml-IN, mr-IN, gu-IN, pa-IN, od-IN or en-IN'),
    from: z.string().optional().describe('The language the comp speaks now; default detected'),
    voice: z.string().min(1).optional(),
    model: z.enum(TTS_MODELS).optional(),
    pace: z.number().min(0.5).max(2).default(1),
    maxPace: z.number().min(0.5).max(2).default(1.25),
    fit: z.enum(['room', 'pace', 'none']).default('room'),
    mode: z.enum(TRANSLATE_MODES).optional().describe('Translation register: formal (default), modern-colloquial, classic-colloquial, code-mixed'),
    keep: z.array(z.string().min(1)).optional().describe('Words to leave untranslated, e.g. the product name'),
    copy: z.boolean().default(true),
    name: z.string().min(1).optional(),
  }),
  run: async (input, ctx) => {
    const call: Call = (name, value) => ctx.call(name, value)
    const target = languageCode(input.language)
    if (!target) throw new CommandError(`Unknown language "${input.language}".`, `Languages: ${SARVAM_LANGUAGES.map((l) => l.code).join(', ')}.`)
    const from = input.from ? (languageCode(input.from) ?? undefined) : undefined
    const original = findComp(ctx.project, input.compId ?? useEditor.getState().activeCompId)
    const native = SARVAM_LANGUAGES.find((l) => l.code === target)?.native ?? target
    const compId = input.copy ? (await must<{ id: string }>(call('frame.duplicate', { id: original.id, name: input.name ?? `${original.name} · ${native}` }))).id : original.id
    let costInr = 0

    // Every take must know what it says: hear the ones that do not.
    const takes: VoiceTake[] = []
    for (const { layerId, mediaId } of voiceLayers(ctx.project, compId)) {
      let speech = ctx.project.media.find((m) => m.id === mediaId)?.speech
      if (!speech) {
        const heard = await must<{ costInr: number }>(call('media.transcribe', { id: layerId, ...(from ? { language: from } : {}) }))
        costInr += heard.costInr
        speech = ctx.project.media.find((m) => m.id === mediaId)?.speech
      }
      if (speech) takes.push({ layerId, mediaId, speech })
    }
    const slots = new Map(
      takeSlots(
        takes.map((t) => {
          const at = placed(ctx.project, t)
          return { id: t.layerId, speechStartMs: at.startMs, speechEndMs: at.endMs }
        }),
        findComp(ctx.project, compId).durationMs,
      ).map((s) => [s.id, s.slotMs]),
    )
    takes.sort((a, b) => placed(ctx.project, a).startMs - placed(ctx.project, b).startMs)

    // Captions belong to the takes they overlap; the rest of the text is translated as text.
    const comps = [compId, ...compsInside(ctx.project, compId)]
    const texts = comps.flatMap((id) => findComp(ctx.project, id).tracks.flatMap((t) => t.layers)).filter((l) => l.kind === 'text')
    const captionTakes = new Map<string, VoiceTake[]>()
    for (const layer of texts) {
      if (layer.kind !== 'text' || !layer.caption || layer.caption.cues.length === 0 || !findComp(ctx.project, compId).tracks.some((t) => t.layers.includes(layer))) continue
      const over = takes.filter((t) => {
        const at = placed(ctx.project, t)
        return Math.min(layerEnd(layer), at.endMs) - Math.max(layer.startMs, at.startMs) > 0
      })
      if (over.length > 0) captionTakes.set(layer.id, over)
    }

    const lines = []
    let addedMs = 0
    const speakers: Record<string, Take> = {}
    for (const take of takes) {
      const translated = await translateText(take.speech.text, target, from ?? take.speech.language, input.mode)
      costInr += translated.costInr
      const voice = input.voice ?? (take.speech.provider?.startsWith('sarvam') ? (take.speech.voice ?? undefined) : undefined)
      const options = { text: translated.text, language: target, ...(voice ? { voice } : {}), ...(input.model ? { model: input.model } : {}), source: take.mediaId }
      let spoken = await speak({ ...options, pace: input.pace }, call)
      costInr += spoken.costInr
      const slot = slots.get(take.layerId) ?? Number.POSITIVE_INFINITY
      const length = (t: Take) => t.speech.endMs - t.speech.startMs
      let pace = input.pace
      let roomMs = 0
      if (input.fit !== 'none') {
        const fitted = fitPace(length(spoken), slot, input.pace, input.maxPace)
        if (fitted.pace > input.pace + 0.005) {
          pace = fitted.pace
          spoken = await speak({ ...options, pace }, call)
          costInr += spoken.costInr
        }
      }
      // Swap the layer's take in place (its id, lane, mix and the characters that talk with it stay).
      const at = placed(ctx.project, take)
      if (input.fit === 'room' && length(spoken) > slot) {
        roomMs = Math.ceil(length(spoken) - slot)
        await must(call('timeline.insert_time', { compId, atMs: Math.round(at.startMs + slot), durationMs: roomMs }))
        addedMs += roomMs
      }
      const { layer, track } = locateLayer(ctx.project, take.layerId)
      const start = Math.max(0, Math.round(at.startMs - spoken.speech.startMs))
      const next = track.layers.filter((l) => l.id !== layer.id && l.startMs >= layer.startMs).reduce((m, l) => Math.min(m, l.startMs), Number.POSITIVE_INFINITY)
      const end = Math.min(start + spoken.durationMs, next)
      await must(call('layer.patch', { id: layer.id, ops: [{ op: 'set', path: 'mediaId', value: spoken.mediaId }, { op: 'set', path: 'sourceStartMs', value: 0 }] }))
      // Shrink first, then move, so the layer never overlaps its neighbours on the way.
      await must(call('timeline.trim', { id: layer.id, endMs: Math.min(layerEnd(locateLayer(ctx.project, layer.id).layer), layer.startMs + spoken.durationMs) }))
      await must(call('timeline.move', { id: layer.id, startMs: start }))
      await must(call('timeline.trim', { id: layer.id, endMs: Math.max(start + 1, end) }))
      if (ctx.project.media.find((m) => m.id === take.mediaId)?.envelope) await must(call('media.envelope', { mediaId: spoken.mediaId }))
      speakers[take.layerId] = spoken
      lines.push({ layerId: take.layerId, text: translated.text, oldMs: Math.round(length({ speech: take.speech } as Take)), newMs: Math.round(length(spoken)), pace, roomMs })
    }

    // Captions: the new words of the takes they cover, in comp time.
    const captions: string[] = []
    for (const [captionId, over] of captionTakes) {
      const words = over.flatMap((t) => {
        const spoken = speakers[t.layerId]
        if (!spoken) return []
        const { layer } = locateLayer(ctx.project, t.layerId)
        return spoken.speech.words.map((w) => ({ ...w, startMs: w.startMs + layer.startMs, endMs: w.endMs + layer.startMs }))
      })
      if (words.length === 0) continue
      const caption = locateLayer(ctx.project, captionId).layer
      const first = words[0]!.startMs
      const last = words.at(-1)!.endMs
      if (caption.startMs > first || layerEnd(caption) < last) {
        await must(call('timeline.trim', { id: captionId, startMs: Math.max(0, Math.min(caption.startMs, first - 100)), endMs: Math.max(layerEnd(caption), last + 300) }))
      }
      await must(call('text.set', { id: captionId, text: words.map((w) => w.text).join(' ') }))
      await must(call('caption.set', { id: captionId, words, timesIn: 'comp' }))
      captions.push(captionId)
    }

    // The rest of the text.
    const plain = texts.filter((l) => !captionTakes.has(l.id)).map((l) => l.id)
    let changed: { id: string; from: string; to: string }[] = []
    if (plain.length > 0) {
      const translated = await must<{ layers: typeof changed; costInr: number }>(
        call('text.translate', { ids: plain, to: target, ...(from ? { from } : {}), ...(input.mode ? { mode: input.mode } : {}), ...(input.keep ? { keep: input.keep } : {}) }),
      )
      changed = translated.layers
      costInr += translated.costInr
    }
    return {
      compId,
      language: target,
      takes: lines,
      addedMs,
      durationMs: findComp(ctx.project, compId).durationMs,
      captions,
      text: changed,
      costInr: Math.round(costInr * 100) / 100,
      ...(takes.length === 0 ? { note: 'No voice takes were found: only the text was translated. generate_speech makes takes that know their script.' } : {}),
    }
  },
})

