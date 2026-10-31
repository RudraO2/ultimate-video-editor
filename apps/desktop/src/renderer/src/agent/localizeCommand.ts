import { categoryForFileName, CommandError, compsInside, defineCommand, findComp, fitPace, layerEnd, locateLayer, type Layer, type Project, type SpeechInfo, takeSlots, wordsOnTimeline } from '@uve/core'
import { z } from 'zod'
import { languageCode, SARVAM_LANGUAGES, TRANSLATE_MODES, TTS_MODELS } from '../../../shared/sarvam'
import { useEditor } from '../store'
import { CAPTION_LINE_HEIGHT, captionTake, placeTake, speak, type Take, takePieces, translateText, voiceReference } from './voiceCommands'

// A comp in another language (comp_localize): a copy whose text is translated
// and whose every voice take is spoken again in the new language. Timing comes
// from each new take's real length: a take keeps the moment its voice starts;
// one that runs past the room it had is read a little faster, and what still
// does not fit gets room made after it (timeline.insert_time), so the scenes
// after it wait for the voice. Captions are re-timed to the new words.

/** How much faster filmed speech may be read to fit, at least: its picture cannot wait. */
const FOOTAGE_MAX_PACE = 1.4

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
  /** A person on camera: every piece of the video plays this take, and the new voice goes on its own track. */
  footage: boolean
}

/** Fields of a caption that are its words and timing, not its look. */
const NOT_LOOK = new Set(['id', 'name', 'kind', 'text', 'ranges', 'startMs', 'durationMs', 'animations', 'caption'])

/** layer.patch ops that give another caption this caption's look: type, box, place, effects, entrance, word states (copies: the project's own objects are frozen). */
function lookOf(layer: Layer): { op: 'set'; path: string; value: unknown }[] {
  const ops = Object.entries(layer)
    .filter(([key]) => !NOT_LOOK.has(key))
    .map(([path, value]) => ({ op: 'set' as const, path, value: structuredClone(value) }))
  if (layer.kind === 'text' && layer.caption) {
    for (const [key, value] of Object.entries(layer.caption)) if (key !== 'cues') ops.push({ op: 'set', path: `caption.${key}`, value: structuredClone(value) })
  }
  return ops
}

/** A filmed take's words that are still on the timeline, in comp time. */
function footageWords(project: Project, take: VoiceTake) {
  return wordsOnTimeline(takePieces(locateLayer(project, take.layerId).comp, take.layerId), take.speech.words)
}

/** The comp time a take's voice starts and ends, from its layer as it is now. */
function placed(project: Project, take: VoiceTake): { startMs: number; endMs: number; layerStart: number } {
  const { layer } = locateLayer(project, take.layerId)
  if (take.footage) {
    const words = footageWords(project, take)
    return { startMs: words[0]?.startMs ?? layer.startMs, endMs: words.at(-1)?.endMs ?? layer.startMs, layerStart: layer.startMs }
  }
  const source = layer.kind === 'audio' || layer.kind === 'video' ? layer.sourceStartMs : 0
  return { startMs: layer.startMs + take.speech.startMs - source, endMs: layer.startMs + take.speech.endMs - source, layerStart: layer.startMs }
}

/**
 * The voice takes of a comp: audio layers whose media says what it speaks, or
 * that sound like a voice (category or file name), and filmed speech (a video
 * with a voice), once per file however many pieces a cut made of it.
 */
function voiceLayers(project: Project, compId: string): { layerId: string; mediaId: string; footage: boolean }[] {
  const comp = findComp(project, compId)
  const out: { layerId: string; mediaId: string; footage: boolean }[] = []
  for (const track of comp.tracks) {
    if (track.muted) continue
    for (const layer of track.layers) {
      if (layer.kind !== 'audio' && layer.kind !== 'video') continue
      const media = project.media.find((m) => m.id === layer.mediaId)
      if (!media) continue
      const voice = media.speech || layer.soundBus === 'voice' || categoryForFileName(media.name) === 'voice' || categoryForFileName(media.path) === 'voice'
      if (layer.kind === 'audio' && voice) out.push({ layerId: layer.id, mediaId: media.id, footage: false })
      const filmed = layer.kind === 'video' && media.hasAudio !== false && (voice || media.footage?.speech?.length)
      if (filmed && !out.some((t) => t.footage && t.mediaId === media.id)) out.push({ layerId: layer.id, mediaId: media.id, footage: true })
    }
  }
  return out
}

export const compLocalize = defineCommand({
  name: 'comp.localize',
  summary:
    'Make a comp speak another Indian language: a copy with its text translated, each voice take spoken again by a Sarvam voice, the timeline re-timed from the new takes, and captions re-timed to the new words.',
  details:
    'Voice takes are the comp\'s audio layers whose media knows its script (generate_speech, media_transcribe) or that are voice by category or file name (vo-*.wav), and filmed speech: a video with a voice (media_analyze, media_transcribe) is one take however many pieces a cut made of it, said with only the words the cut kept; its new voice goes on its own track, the sound of the video is muted, and it may be read up to 1.4× to fit (the picture cannot wait). A take without a script is heard first (Sarvam speech to text). Each take is translated and spoken again with voice (default: the take\'s own voice, else shubh), placed so its voice starts where the old one did. fit: "room" (default) reads a take that runs long up to maxPace faster, then opens the time still missing right after it (timeline.insert_time), so everything after waits; "pace" only speeds up (the voice may run into the next); "none" keeps each take at pace. Text layers (in nested comps too) are translated; keep lists words to leave as they are (brand names). A caption over a take gets that take\'s new words, word-synced. copy (default true) makes a new frame named "<name> · <language>"; false changes the comp itself. Returns the comp id, each take (old and new voice length, pace, room made), text changed, and costInr. Run it once per language from the original comp.',
  effect: 'write',
  input: z.strictObject({
    compId: z.string().optional().describe('Default the open comp (AtomCut: frameId)'),
    language: z.string().min(2).describe('Target: hi-IN, ta-IN, bn-IN, te-IN, kn-IN, ml-IN, mr-IN, gu-IN, pa-IN, od-IN or en-IN'),
    from: z.string().optional().describe('The language the comp speaks now; default detected'),
    voice: z.string().min(1).optional(),
    ownVoice: z.boolean().default(false).describe("Speak each take in its own speaker's voice (Sarvam instant voice cloning from 12 s of the take); only for a voice the person agreed to clone"),
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
    for (const { layerId, mediaId, footage } of voiceLayers(ctx.project, compId)) {
      let speech = ctx.project.media.find((m) => m.id === mediaId)?.speech
      if (!speech) {
        const heard = await must<{ costInr: number }>(call('media.transcribe', { id: layerId, ...(from ? { language: from } : {}) }))
        costInr += heard.costInr
        speech = ctx.project.media.find((m) => m.id === mediaId)?.speech
      }
      if (speech) takes.push({ layerId, mediaId, speech, footage })
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
    // The layer that now plays each take's new voice (a filmed take gets a new one).
    const voiceLayer: Record<string, string> = {}
    const references: Record<string, Uint8Array> = {}
    for (const take of takes) {
      // A filmed take says only the words its cut kept.
      const said = take.footage ? footageWords(ctx.project, take).map((w) => w.text).join(' ') : take.speech.text
      if (!said.trim()) continue
      const translated = await translateText(said, target, from ?? take.speech.language, input.mode)
      costInr += translated.costInr
      const voice = input.voice ?? (take.speech.provider?.startsWith('sarvam') ? (take.speech.voice ?? undefined) : undefined)
      const reference = input.ownVoice ? (references[take.mediaId] ??= await voiceReference(ctx.project, take.mediaId)) : undefined
      const options = { text: translated.text, language: target, ...(reference ? { reference } : voice ? { voice } : {}), ...(input.model ? { model: input.model } : {}), source: take.mediaId }
      let spoken = await speak({ ...options, pace: input.pace }, call)
      costInr += spoken.costInr
      const slot = slots.get(take.layerId) ?? Number.POSITIVE_INFINITY
      const length = (t: Take) => t.speech.endMs - t.speech.startMs
      let pace = input.pace
      let roomMs = 0
      if (input.fit !== 'none') {
        // Filmed speech cannot be given room (the picture would stop), so it may be read a little faster.
        const maxPace = take.footage ? Math.max(input.maxPace, FOOTAGE_MAX_PACE) : input.maxPace
        const fitted = fitPace(length(spoken), slot, input.pace, maxPace)
        if (fitted.pace > input.pace + 0.005) {
          pace = fitted.pace
          spoken = await speak({ ...options, pace }, call)
          costInr += spoken.costInr
        }
        // A voice does not speed up in proportion to its pace: filmed speech still too long gets one more try.
        const again = Math.min(maxPace, Math.ceil(((pace * length(spoken)) / slot) * 100) / 100)
        if (take.footage && length(spoken) > slot && again > pace + 0.005) {
          pace = again
          spoken = await speak({ ...options, pace }, call)
          costInr += spoken.costInr
        }
      }
      if (take.footage) {
        // The new voice on its own track where the old one started; the video plays on without its own sound.
        const at = placed(ctx.project, take)
        const newLayer = await placeTake(spoken, compId, at.startMs, call)
        voiceLayer[take.layerId] = newLayer
        for (const piece of takePieces(findComp(ctx.project, compId), take.layerId)) {
          await must(call('layer.patch', { id: piece.id, ops: [{ op: 'set', path: 'volume', value: 0 }] }))
        }
        const voiceEnd = layerEnd(locateLayer(ctx.project, newLayer).layer)
        const compEnd = findComp(ctx.project, compId).durationMs
        if (voiceEnd > compEnd) {
          addedMs += voiceEnd - compEnd
          await must(call('frame.update', { id: compId, durationMs: voiceEnd }))
          // The last shot plays on into the file it was cut from, so the picture lasts as long as the voice where it can.
          const pieces = takePieces(findComp(ctx.project, compId), take.layerId)
          const last = pieces.reduce<(typeof pieces)[number] | undefined>((a, p) => (!a || layerEnd(p) > layerEnd(a) ? p : a), undefined)
          const media = ctx.project.media.find((m) => m.id === take.mediaId)
          if (last && media?.durationMs && layerEnd(last) >= compEnd - 1) {
            const left = (media.durationMs - (last.sourceStartMs + last.durationMs * last.playbackRate)) / last.playbackRate
            if (left > 1) await must(call('timeline.trim', { id: last.id, endMs: Math.round(layerEnd(last) + Math.min(left, voiceEnd - compEnd)) }))
          }
        }
        speakers[take.layerId] = spoken
        lines.push({ layerId: take.layerId, text: translated.text, oldMs: Math.round(at.endMs - at.startMs), newMs: Math.round(length(spoken)), pace, roomMs })
        continue
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
      voiceLayer[take.layerId] = take.layerId
      lines.push({ layerId: take.layerId, text: translated.text, oldMs: Math.round(length({ speech: take.speech } as Take)), newMs: Math.round(length(spoken)), pace, roomMs })
    }

    // Captions: the new words of the takes they cover, in comp time. Several
    // captions over one take share its words: each word goes to the last
    // caption that starts at or before it.
    const captions: string[] = []
    const emptied: string[] = []
    const captionsOver = (take: VoiceTake) =>
      [...captionTakes].filter(([, over]) => over.includes(take)).map(([id]) => locateLayer(ctx.project, id).layer).sort((a, b) => a.startMs - b.startMs)
    // A take under several captions of its own (one per phrase) gets new phrase captions from its new words, in the look of the first.
    const remade = new Set<string>()
    for (const take of takes) {
      const spoken = speakers[take.layerId]
      const playing = voiceLayer[take.layerId]
      const shared = captionsOver(take)
      if (!spoken || !playing || shared.length < 2 || shared.some((c) => (captionTakes.get(c.id)?.length ?? 0) > 1)) continue
      const look = lookOf(shared[0]!)
      await must(call('layers.delete', { ids: shared.map((c) => c.id) }))
      for (const c of shared) remade.add(c.id)
      const lineHeight = Math.max(CAPTION_LINE_HEIGHT, shared[0]!.kind === 'text' ? shared[0]!.style.lineHeight : 0)
      for (const id of await captionTake(playing, spoken.speech, call, ctx.project)) {
        await must(call('layer.patch', { id, ops: [...look, { op: 'set', path: 'style.lineHeight', value: lineHeight }] }))
        captions.push(id)
      }
    }
    for (const [captionId, over] of captionTakes) {
      if (remade.has(captionId)) continue
      const words = over.flatMap((t) => {
        const spoken = speakers[t.layerId]
        const playing = voiceLayer[t.layerId]
        if (!spoken || !playing) return []
        const { layer } = locateLayer(ctx.project, playing)
        const all = spoken.speech.words.map((w) => ({ ...w, startMs: w.startMs + layer.startMs, endMs: w.endMs + layer.startMs }))
        const shared = captionsOver(t)
        if (shared.length < 2) return all
        const i = shared.findIndex((c) => c.id === captionId)
        const next = shared[i + 1]
        return all.filter((w) => (i === 0 || w.startMs >= shared[i]!.startMs) && (!next || w.startMs < next.startMs))
      })
      if (words.length === 0) {
        if (over.some((t) => speakers[t.layerId])) emptied.push(captionId)
        continue
      }
      const { layer: caption, track } = locateLayer(ctx.project, captionId)
      const first = words[0]!.startMs
      const last = words.at(-1)!.endMs
      if (caption.startMs > first || layerEnd(caption) < last) {
        // Grow over the new words, never into the captions next to it on its lane.
        const before = track.layers.filter((l) => l.id !== caption.id && layerEnd(l) <= caption.startMs).reduce((m, l) => Math.max(m, layerEnd(l)), 0)
        const after = track.layers.filter((l) => l.id !== caption.id && l.startMs >= layerEnd(caption)).reduce((m, l) => Math.min(m, l.startMs), Number.POSITIVE_INFINITY)
        await must(
          call('timeline.trim', {
            id: captionId,
            startMs: Math.max(before, Math.min(caption.startMs, first - 100)),
            endMs: Math.min(after, findComp(ctx.project, compId).durationMs, Math.max(layerEnd(caption), last + 300)),
          }),
        )
      }
      await must(call('text.set', { id: captionId, text: words.map((w) => w.text).join(' ') }))
      await must(call('caption.set', { id: captionId, words, timesIn: 'comp' }))
      captions.push(captionId)
    }
    if (emptied.length > 0) await must(call('layers.delete', { ids: emptied }))

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

