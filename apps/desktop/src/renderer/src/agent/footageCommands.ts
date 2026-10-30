import {
  calibrateGate,
  CommandError,
  type CommandResult,
  type Comp,
  defineCommand,
  findComp,
  fitWordsToSpans,
  type FootageInfo,
  layerEnd,
  locateLayer,
  loudnessDb,
  type MediaAsset,
  type MediaTiming,
  placeBroll,
  planTighten,
  type Project,
  searchFootage,
  sentencesOf,
  shotsFromScores,
  type Span,
  spansToComp,
  speechRanges,
  TIGHTNESS,
  type Word,
} from '@uve/core'
import { alignWords, wordWeight } from '@uve/engine'
import { z } from 'zod'
import { sceneScores } from '../media/footageFrames'
import { DECODE_RATE, decodeMono } from './voiceCommands'

// Raw footage, understood and cut: media.analyze reads a file once (where the
// voice is, its words, where the shots change) and keeps it on the media;
// media.remove_pauses plans a tighter cut from that, with a reason for every
// removal, and applies it as one undo step; media.search finds lines and
// shots; timeline.place_broll lays cutaways inside the sentences they belong to.

type Call = (name: string, input: unknown) => Promise<CommandResult>

/** Loudness frames for the speech gate. */
const FRAME_MS = 20
/** Sentences listed in an analysis before it points at media.search instead. */
const MAX_SENTENCES = 120

async function must<T>(call: Call, name: string, input: unknown): Promise<T> {
  const result = await call(name, input)
  if (!result.ok) throw new CommandError(result.error, result.hint)
  return result.value as T
}

type MediaLayer = { id: string; startMs: number; durationMs: number; sourceStartMs: number; playbackRate: number; mediaId: string; name: string }

function isMediaLayer<L>(layer: L): layer is L & MediaLayer {
  const l = layer as { kind?: string; mediaId?: unknown }
  return (l.kind === 'video' || l.kind === 'audio') && typeof l.mediaId === 'string'
}

/** The footage `id` names (a video or audio layer, or a media id), and its layer and comp when a layer was given. */
function footageOf(project: Project, id: string): { media: MediaAsset; layer: MediaLayer | null; comp: Comp | null } {
  const direct = project.media.find((m) => m.id === id)
  if (direct) {
    if (direct.kind !== 'video' && direct.kind !== 'audio') throw new CommandError(`${direct.name} is not footage.`, 'Give a video or audio layer or media id.')
    return { media: direct, layer: null, comp: null }
  }
  const { comp, layer } = locateLayer(project, id)
  if (!isMediaLayer(layer)) throw new CommandError(`"${layer.name}" is not a video or audio layer.`, 'Give a video or audio layer (layers.list) or a media id (media.list).')
  const media = project.media.find((m) => m.id === layer.mediaId)
  if (!media) throw new CommandError(`The media of "${layer.name}" is missing.`)
  return { media, layer, comp }
}

function timingOf(layer: MediaLayer): MediaTiming {
  return { startMs: layer.startMs, durationMs: layer.durationMs, sourceStartMs: layer.sourceStartMs, playbackRate: layer.playbackRate }
}

const round = (ms: number): number => Math.round(ms)

/** Reads where the voice is and where the shots change (no words). */
async function readFootage(media: MediaAsset, shots: boolean, samples: Float32Array | null): Promise<FootageInfo> {
  const durationMs = media.durationMs ?? 0
  let gate: FootageInfo['gate'] = null
  let speech: Span[] = []
  if (samples) {
    const db = loudnessDb(samples, DECODE_RATE, FRAME_MS)
    const calibrated = calibrateGate(db)
    if ('gateDb' in calibrated) {
      gate = { gateDb: round1(calibrated.gateDb), troughDb: round1(calibrated.troughDb), peakDb: round1(calibrated.peakDb) }
      speech = speechRanges(db, calibrated.gateDb, FRAME_MS)
    }
  }
  let sceneThreshold: number | null = null
  let cuts: FootageInfo['shots'] = [{ startMs: 0, endMs: round(durationMs), score: 0, description: null }]
  if (shots && media.kind === 'video') {
    const read = await sceneScores(media.path)
    if (read.samples.length > 1) {
      const found = shotsFromScores(read.samples, durationMs || read.durationMs)
      sceneThreshold = Math.round(found.threshold * 1000) / 1000
      cuts = found.shots.map((s) => ({ startMs: s.startMs, endMs: s.endMs, score: Math.round(s.score * 1000) / 1000, description: null }))
    }
  }
  // Descriptions written earlier stay on shots that did not move.
  for (const shot of cuts) {
    const before = media.footage?.shots.find((s) => Math.abs(s.startMs - shot.startMs) < 50 && Math.abs(s.endMs - shot.endMs) < 50)
    if (before?.description) shot.description = before.description
  }
  return { gate, speech, sceneThreshold, shots: cuts }
}

/**
 * Word times fitted to the speech gate: speech to text hears the words but
 * times them loosely (a phrase may straddle a pause), while the gate knows
 * exactly where the voice is. Each stretch of voice gets the words that fit
 * it, and they are aligned inside it.
 */
function retimeWords(samples: Float32Array, words: readonly Word[], spans: readonly Span[]): Word[] {
  const owner = fitWordsToSpans(
    words.map((w) => ({ text: w.text, weight: wordWeight(w.text), nearMs: w.startMs, heardMs: w.endMs - w.startMs })),
    spans,
  )
  const out: Word[] = []
  spans.forEach((span, s) => {
    const group = words.filter((_, i) => owner[i] === s)
    if (group.length === 0) return
    const from = Math.floor((span.startMs / 1000) * DECODE_RATE)
    const to = Math.min(samples.length, Math.ceil((span.endMs / 1000) * DECODE_RATE))
    const timed = alignWords(samples.subarray(from, to), DECODE_RATE, group.map((w) => w.text))
    timed.forEach((t, k) => out.push({ text: group[k]!.text, startMs: round(t.startMs + span.startMs), endMs: round(t.endMs + span.startMs) }))
  })
  return out
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

/** A take heard by Saaras in its default mode has lost its fillers; footage needs every word. */
function needsWords(media: MediaAsset): boolean {
  return !media.speech || media.speech.provider === 'sarvam:saaras:v3'
}

/** Every piece of `media` in `comp` (a clip cut in pieces is still one take). */
function piecesOf(comp: Comp, mediaId: string): MediaLayer[] {
  return comp.tracks.flatMap((t) => t.layers.filter(isMediaLayer).filter((l) => l.mediaId === mediaId))
}

/** A span of the file in comp time through the pieces that show it: from the first shown moment to the last; null when none shows it. */
function shownSpan(pieces: readonly MediaLayer[], span: Span): Span | null {
  const shown = pieces.flatMap((p) => spansToComp(timingOf(p), [span]))
  if (shown.length === 0) return null
  return { startMs: round(Math.min(...shown.map((s) => s.startMs))), endMs: round(Math.max(...shown.map((s) => s.endMs))) }
}

/** The words of `media` that its pieces in `comp` still show, in comp time and order. */
function compWordsOf(comp: Comp, media: MediaAsset): Word[] {
  const pieces = piecesOf(comp, media.id)
  return pieces
    .flatMap((piece) =>
      (media.speech?.words ?? []).flatMap((w) => {
        const [span] = spansToComp(timingOf(piece), [w])
        // A word is shown when most of it is.
        return span && (span.endMs - span.startMs) * piece.playbackRate >= 0.5 * (w.endMs - w.startMs) ? [{ text: w.text, startMs: span.startMs, endMs: span.endMs }] : []
      }),
    )
    .sort((a, b) => a.startMs - b.startMs)
}

/** What an analysis tells the agent: sentences and shots, in comp time (as cut) when a layer was given. */
function summary(media: MediaAsset, layer: MediaLayer | null, comp: Comp | null, notes: string[]) {
  const footage = media.footage
  const pieces = layer && comp ? piecesOf(comp, media.id) : []
  const words = media.speech?.words ?? []
  const sentences = sentencesOf(layer && comp ? compWordsOf(comp, media) : words)
  const shots = (footage?.shots ?? []).flatMap((s, index) => {
    const span = layer ? shownSpan(pieces, s) : { startMs: round(s.startMs), endMs: round(s.endMs) }
    return span ? [{ index, ...span, ...(s.score ? { score: s.score } : {}), description: s.description }] : []
  })
  const speechMs = (footage?.speech ?? []).reduce((sum, s) => sum + s.endMs - s.startMs, 0)
  return {
    mediaId: media.id,
    name: media.name,
    kind: media.kind,
    durationMs: media.durationMs ?? null,
    times: layer && comp ? `comp ms in ${comp.id}, as cut` : 'ms from the start of the file',
    language: media.speech?.language ?? null,
    gate: footage?.gate ?? { refused: 'The quiet and loud parts are too close to tell speech from silence; silence is not cut.' },
    speechMs: round(speechMs),
    words: words.length,
    sentences: sentences.slice(0, MAX_SENTENCES).map((s, index) => ({ index, startMs: round(s.startMs), endMs: round(s.endMs), text: s.text })),
    ...(sentences.length > MAX_SENTENCES ? { moreSentences: sentences.length - MAX_SENTENCES } : {}),
    shots,
    ...(notes.length > 0 ? { notes } : {}),
  }
}

const languageField = z.string().min(2).optional().describe('BCP-47 code of the speech (hi-IN, en-IN, ta-IN…); default detected')

export const mediaAnalyze = defineCommand({
  name: 'media.analyze',
  summary:
    'Understand a piece of footage once: where the voice is (a speech gate calibrated for the file), every word with its time (Sarvam, verbatim, any Indian language or English), and where the shots change. Kept on the media and reused.',
  details:
    'id: a video or audio layer (times come back in comp ms) or a media id (ms in the file). Returns sentences with times and text, shots with times and descriptions, the gate and how much is speech. Then: media_inspect {id, shot} to look at shots and media_describe_shots to note what each shows; media_remove_pauses to tighten the speech; media_search to find lines and shots; timeline_place_broll for cutaways. words: false skips speech to text (silence and shots only, free). force reads again. Speech to text costs ₹0.49 a minute (a file heard before is free).',
  effect: 'write',
  input: z.strictObject({
    id: z.string().min(1).describe('A video or audio layer, or a media id'),
    words: z.boolean().default(true).describe('Hear the words (Sarvam speech to text)'),
    shots: z.boolean().default(true).describe('Find where the shots change (video)'),
    language: languageField,
    force: z.boolean().default(false).describe('Read the file again, although it was read before'),
  }),
  run: async ({ id, words, shots, language, force }, ctx) => {
    const call: Call = (name, value) => ctx.call(name, value)
    let { media, layer, comp } = footageOf(ctx.project, id)
    const notes: string[] = []
    let samples: Float32Array | null = null
    const sound = async () => (samples ??= await decodeMono(media.path))
    if (!media.footage || force) {
      const footage = await readFootage(media, shots, media.hasAudio !== false ? await sound() : null)
      if (!footage.gate && media.hasAudio !== false) notes.push('Its quiet and loud parts are too close to tell speech from silence, so silence is left alone.')
      await must(call, 'media.footage', { mediaId: media.id, footage })
    }
    let costInr = 0
    if (words && media.hasAudio !== false && (force || needsWords(media))) {
      const heard = await call('media.transcribe', { id: media.id, ...(language ? { language } : {}), force: true, mode: 'verbatim' })
      if (heard.ok) {
        costInr = (heard.value as { costInr?: number }).costInr ?? 0
        const fresh = ctx.project.media.find((m) => m.id === media.id)
        if (fresh?.speech && fresh.footage?.gate && fresh.footage.speech.length > 0) {
          const words = retimeWords(await sound(), fresh.speech.words, fresh.footage.speech)
          await must(call, 'media.speech', { mediaId: media.id, speech: { ...fresh.speech, words } })
        }
      } else notes.push(`No words: ${heard.error}${heard.hint ? ` ${heard.hint}` : ''} Pauses can still be cut from the speech gate.`)
    }
    media = ctx.project.media.find((m) => m.id === media.id) ?? media
    if (comp) comp = findComp(ctx.project, comp.id)
    return { ...summary(media, layer, comp, notes), costInr }
  },
})

const TightenInput = z.strictObject({
  id: z.string().min(1).describe('A video or audio layer'),
  dryRun: z.boolean().default(false).describe('Return the plan without cutting (show it, mark it, or hand-pick ranges into timeline_cut_ranges)'),
  tightness: z.enum(TIGHTNESS).default('generous').describe('generous (default): long pauses, ums and false starts only; balanced: also fillers like "basically", "matlab" next to a pause; tight: every filler, short pauses'),
  minGapMs: z.number().min(150).max(5000).optional().describe("Pauses longer than this are cut (×2.5 after a sentence, ×1.5 after a comma); default from tightness: 900, 600, 400"),
  padMs: z.number().min(0).max(500).optional().describe('Air left around words; default from tightness: 180, 150, 100'),
  language: languageField,
  fillers: z.boolean().default(true).describe('Cut filler words (um, uh, matlab, accha…)'),
  falseStarts: z.boolean().default(true).describe('Cut a word or few said twice in a row: the first copy goes'),
  retakes: z.enum(['cut', 'flag', 'off']).default('cut').describe('A sentence restarted with the same words: cut the first try, flag it, or leave it'),
  ripple: z.enum(['sync', 'lane', 'none']).default('sync').describe('As timeline_cut_ranges: sync keeps captions and titles on their words'),
  markers: z.boolean().default(false).describe('Put the planned cuts and flags on the ruler as review marks (replaces earlier cut and flag marks)'),
  variant: z.boolean().default(false).describe('Cut a copy of the frame (a new frame) and leave this one as it was'),
})

type PlannedCut = Span & { kinds: string[]; reason: string }

/** The plan of media.remove_pauses in comp time. */
function planFor(media: MediaAsset, layer: MediaLayer, input: z.output<typeof TightenInput>) {
  const footage = media.footage
  const words: Word[] = media.speech?.words ?? []
  if (!footage?.gate && words.length === 0) {
    throw new CommandError(`Speech and silence in ${media.name} are too close to tell apart, and it has no words.`, 'Run media_analyze with words (Sarvam speech to text), or cut by hand with timeline_cut_ranges.')
  }
  const plan = planTighten(
    { words, speech: footage?.gate ? footage.speech : null, durationMs: media.durationMs ?? layer.sourceStartMs + layer.durationMs * layer.playbackRate },
    {
      tightness: input.tightness,
      language: input.language ?? media.speech?.language ?? 'en',
      ...(input.minGapMs !== undefined ? { minGapMs: input.minGapMs } : {}),
      ...(input.padMs !== undefined ? { padMs: input.padMs } : {}),
      fillers: input.fillers,
      falseStarts: input.falseStarts,
      retakes: input.retakes,
    },
  )
  const timing = timingOf(layer)
  const toComp = <T extends Span>(spans: readonly T[]) =>
    spans.flatMap((s) => spansToComp(timing, [s]).map((c) => ({ ...s, startMs: round(c.startMs), endMs: round(c.endMs) })))
  const cuts: PlannedCut[] = toComp(plan.cuts).filter((c) => c.endMs - c.startMs >= 1)
  const flags = toComp(plan.flags)
  const removedMs = cuts.reduce((sum, c) => sum + c.endMs - c.startMs, 0)
  return { cuts, flags, settings: plan.settings, removedMs, keptMs: Math.max(0, layer.durationMs - removedMs) }
}

/** Where comp time `t` lands once `cuts` are taken out. */
function afterCuts(t: number, cuts: readonly Span[]): number {
  let shift = 0
  for (const c of cuts) {
    if (c.startMs >= t) break
    shift += Math.min(t, c.endMs) - c.startMs
  }
  return t - shift
}

export const mediaRemovePauses = defineCommand({
  name: 'media.remove_pauses',
  summary:
    'Tighten raw speech in one undo step: long pauses, dead air at the head and tail, filler words in any language (um, uh, matlab, accha…), false starts and restarted sentences, each cut with a reason; generous by default.',
  details:
    'Reads the footage first if it was not (media_analyze). dryRun returns the plan (comp ms, a reason per cut, flags such as a swallowed retake for a person to judge) and markers: true puts it on the ruler for review; apply cuts the layer in place with timeline_cut_ranges (ripple sync keeps captions, titles and music in step) and shortens the frame to its new end, or with variant: true cuts a copy of the frame and leaves the original. Breathing room: a pause after a sentence keeps 2.5× the air of one mid-sentence. Returns cuts, flags, removedMs and the pieces left.',
  effect: 'write',
  input: TightenInput,
  run: async (input, ctx) => {
    const call: Call = (name, value) => ctx.call(name, value)
    let { media, layer, comp } = footageOf(ctx.project, input.id)
    if (!layer || !comp) throw new CommandError('Give the video or audio layer to cut, not a media id.', 'layers_list gives layer ids.')
    if (!media.footage || needsWords(media)) {
      await must(call, 'media.analyze', { id: media.id, ...(input.language ? { language: input.language } : {}) })
      media = ctx.project.media.find((m) => m.id === media.id) ?? media
    }
    const plan = planFor(media, layer, input)
    const marks = (cuts: readonly PlannedCut[], flags: readonly (Span & { reason: string })[]) => [
      ...cuts.map((c) => ({ startMs: c.startMs, endMs: c.endMs, kind: 'cut', label: c.reason })),
      ...flags.map((f) => ({ startMs: f.startMs, endMs: f.endMs, kind: 'flag', label: f.reason })),
    ]
    const report = { cuts: plan.cuts.map(({ startMs, endMs, kinds, reason }) => ({ startMs, endMs, kinds, reason })), flags: plan.flags, removedMs: round(plan.removedMs), settings: plan.settings }
    if (input.dryRun) {
      if (input.markers) {
        await must(call, 'timeline.markers', { compId: comp.id, remove: 'cut' })
        await must(call, 'timeline.markers', { compId: comp.id, remove: 'flag', ...(plan.cuts.length + plan.flags.length > 0 ? { add: marks(plan.cuts, plan.flags) } : {}) })
      }
      return { dryRun: true, compId: comp.id, layerId: layer.id, ...report, keptMs: round(plan.keptMs), next: 'Apply with the same input and dryRun false, or pass chosen ranges to timeline_cut_ranges.' }
    }
    if (plan.cuts.length === 0) return { compId: comp.id, layerId: layer.id, ...report, pieces: [layer.id], note: 'Nothing to cut at this tightness.' }
    let target = comp
    let targetLayer = layer.id
    if (input.variant) {
      const copy = await must<{ id: string }>(call, 'frame.duplicate', { id: comp.id, name: `${comp.name} (tight)` })
      target = findComp(ctx.project, copy.id)
      // A copy keeps the structure: the same lane and place on it.
      const lane = comp.tracks.findIndex((t) => t.layers.some((l) => l.id === layer!.id))
      const at = comp.tracks[lane]!.layers.findIndex((l) => l.id === layer!.id)
      targetLayer = target.tracks[lane]!.layers[at]!.id
    }
    const contentEnd = (c: Comp) => Math.max(0, ...c.tracks.flatMap((t) => t.layers.map((l) => layerEnd(l))))
    const endBefore = contentEnd(target)
    const durationBefore = target.durationMs
    const cut = await must<{ removedMs: number; pieces: string[] }>(call, 'timeline.cut_ranges', { id: targetLayer, ranges: plan.cuts.map(({ startMs, endMs }) => ({ startMs, endMs })), ripple: input.ripple })
    target = findComp(ctx.project, target.id)
    // Review marks: planned cuts are done; flags move with the time around them.
    const flags = plan.flags.map((f) => ({ ...f, startMs: round(afterCuts(f.startMs, plan.cuts)), endMs: round(afterCuts(f.endMs, plan.cuts)) }))
    if (target.markers.length > 0 || (input.markers && flags.length > 0)) {
      await must(call, 'timeline.markers', { compId: target.id, remove: 'cut' })
      await must(call, 'timeline.markers', { compId: target.id, remove: 'flag', ...(input.markers && flags.length > 0 ? { add: marks([], flags) } : {}) })
    }
    // A frame whose footage reached (or ran past) its end ends with the footage again.
    const endAfter = contentEnd(target)
    if (endBefore >= durationBefore - 50 && Math.abs(endAfter - durationBefore) >= 1 && endAfter > 0) {
      await must(call, 'frame.update', { id: target.id, durationMs: Math.round(endAfter) })
    }
    return {
      compId: target.id,
      ...(input.variant ? { variantOf: comp.id } : {}),
      layerId: cut.pieces[0] ?? targetLayer,
      ...report,
      flags,
      removedMs: cut.removedMs,
      pieces: cut.pieces,
      durationMs: findComp(ctx.project, target.id).durationMs,
    }
  },
})

export const mediaSearch = defineCommand({
  name: 'media.search',
  summary: 'Find footage by what is said in it (word for word or by meaning words) or by what its shots show (their descriptions), with in and out points for a select.',
  details:
    'Searches every analysed media (media_analyze; describe shots with media_describe_shots). kind: words, shots or all. Each hit: mediaId, kind, text, startMs/endMs of the match and inMs/outMs of its sentence or shot (ms in the file), score, and the layers that show it (comp ms) so it can be placed or trimmed.',
  effect: 'read',
  input: z.strictObject({
    query: z.string().min(1),
    kind: z.enum(['all', 'words', 'shots']).default('all'),
    mediaIds: z.array(z.string().min(1)).max(100).optional().describe('Only these media'),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  run: ({ query, kind, mediaIds, limit }, ctx) => {
    const entries = ctx.project.media
      .filter((m) => (m.kind === 'video' || m.kind === 'audio') && (!mediaIds || mediaIds.includes(m.id)) && (m.speech || m.footage))
      .map((m) => ({ mediaId: m.id, name: m.name, words: m.speech?.words ?? [], shots: m.footage?.shots ?? [] }))
    if (entries.length === 0) throw new CommandError('No footage has been analysed yet.', 'Run media_analyze on each clip first.')
    const hits = searchFootage(entries, query, { kind, limit })
    return {
      hits: hits.map((hit) => {
        const layers = ctx.project.comps.flatMap((comp) =>
          comp.tracks.flatMap((t) =>
            t.layers.filter(isMediaLayer).flatMap((l) => {
              if (l.mediaId !== hit.mediaId) return []
              const [span] = spansToComp(timingOf(l), [{ startMs: hit.startMs, endMs: hit.endMs }])
              return span ? [{ id: l.id, compId: comp.id, startMs: round(span.startMs), endMs: round(span.endMs) }] : []
            }),
          ),
        )
        return { ...hit, ...(layers.length > 0 ? { layers } : {}) }
      }),
    }
  },
})

const SpanInput = z.strictObject({ startMs: z.number().min(0), endMs: z.number().min(0) })

export const timelinePlaceBroll = defineCommand({
  name: 'timeline.place_broll',
  summary:
    'Lay B-roll (screen recordings, cutaways, pictures) over a speaker as cutaways that sit inside the sentence they illustrate, on a lane above the voice, as one undo step.',
  details:
    'voiceId: the speaking layer (any piece of it after a cut). cutaways: [{mediaId, startMs, endMs?, sourceStartMs?, relevance?}] in comp ms: where you want each one (pick spots from media_analyze sentences or media_search). Each is kept inside its sentence, 150 ms in from each end (insetMs), at least 800 ms long (minMs), never over a protected beat ([{startMs, endMs}]: a punchline, a face reveal) or another cutaway; relevance under 0.35 (your own judgement, 0..1) is refused. sourceStartMs: where in the B-roll file to start (media_search gives inMs). Video is muted and scaled to cover the frame (fit: "contain" to fit inside). Returns placed (layer ids and times) and rejected with reasons.',
  effect: 'write',
  input: z.strictObject({
    voiceId: z.string().min(1).describe('The speaking video or audio layer'),
    cutaways: z
      .array(
        z.strictObject({
          mediaId: z.string().min(1).describe('A video or image media id'),
          startMs: z.number().min(0).describe('Comp ms'),
          endMs: z.number().min(0).optional().describe('Comp ms; default the end of the sentence'),
          sourceStartMs: z.number().min(0).default(0).describe('Where in the file to start, ms'),
          relevance: z.number().min(0).max(1).optional().describe('How well it fits what is said, 0..1 (your judgement)'),
        }),
      )
      .min(1)
      .max(100),
    protected: z.array(SpanInput).max(100).default([]).describe('Comp spans no cutaway may cover'),
    insetMs: z.number().min(0).max(2000).default(150),
    minMs: z.number().min(100).max(10_000).default(800),
    trackId: z.string().min(1).optional().describe('Put them on this lane; default a new "B-roll" lane right above the voice'),
    fit: z.enum(['cover', 'contain']).default('cover'),
    muted: z.boolean().default(true).describe('Mute the sound of B-roll video'),
  }),
  run: async (input, ctx) => {
    const call: Call = (name, value) => ctx.call(name, value)
    const { media: voice, layer, comp } = footageOf(ctx.project, input.voiceId)
    if (!layer || !comp) throw new CommandError('voiceId must be a layer on the timeline.', 'Give the speaking video or audio layer.')
    const words = voice.speech?.words ?? []
    if (words.length === 0) throw new CommandError(`${voice.name} has no words yet, so there are no sentences to place cutaways in.`, 'Run media_analyze on it first.')
    // Every piece of the voice in this comp (it may have been cut): its sentences in comp time.
    const sentences = sentencesOf(compWordsOf(comp, voice))
    const medias = input.cutaways.map((c, index) => {
      const m = ctx.project.media.find((x) => x.id === c.mediaId)
      if (!m) throw new CommandError(`Cutaway ${index}: there is no media ${c.mediaId}.`, 'media_list gives media ids.')
      if (m.kind !== 'video' && m.kind !== 'image') throw new CommandError(`Cutaway ${index}: ${m.name} is not a video or picture.`)
      return m
    })
    let trackId = input.trackId
    const laneIndex = comp.tracks.findIndex((t) => t.layers.some((l) => l.id === layer.id))
    const existing = trackId ? (comp.tracks.find((t) => t.id === trackId)?.layers ?? []).map((l) => ({ startMs: l.startMs, endMs: layerEnd(l) })) : []
    if (input.trackId && !comp.tracks.some((t) => t.id === input.trackId)) throw new CommandError(`${comp.name} has no lane ${input.trackId}.`)
    const requests = input.cutaways.map((c, index) => {
      // A video cutaway is no longer than what is left of its file.
      const left = medias[index]!.kind === 'video' && medias[index]!.durationMs ? medias[index]!.durationMs! - c.sourceStartMs : Number.POSITIVE_INFINITY
      const endMs = Math.min(c.endMs ?? Number.POSITIVE_INFINITY, c.startMs + left)
      return { startMs: c.startMs, ...(Number.isFinite(endMs) ? { endMs } : {}), ...(c.relevance !== undefined ? { relevance: c.relevance } : {}) }
    })
    const plan = placeBroll({ sentences, requests, protected: input.protected, existing }, { insetMs: input.insetMs, minMs: input.minMs })
    const placed: { index: number; layerId: string; mediaId: string; startMs: number; endMs: number }[] = []
    if (plan.placed.length > 0 && !trackId) {
      trackId = (await must<{ id: string }>(call, 'track.create', { compId: comp.id, index: Math.max(0, laneIndex), name: 'B-roll' })).id
    }
    for (const p of plan.placed) {
      const media = medias[p.index]!
      const cutaway = input.cutaways[p.index]!
      const w = media.width ?? comp.width
      const h = media.height ?? comp.height
      const scale = input.fit === 'cover' ? Math.max(comp.width / w, comp.height / h) : Math.min(comp.width / w, comp.height / h)
      const startMs = round(p.startMs)
      const made = await must<{ id: string }>(call, 'layer.create', {
        compId: comp.id,
        kind: media.kind,
        mediaId: media.id,
        startMs,
        durationMs: round(p.endMs) - startMs,
        trackId,
        transform: { scaleX: scale, scaleY: scale },
      })
      const ops = [
        ...(media.kind === 'video' && cutaway.sourceStartMs > 0 ? [{ op: 'set', path: 'sourceStartMs', value: round(cutaway.sourceStartMs) }] : []),
        ...(media.kind === 'video' && input.muted ? [{ op: 'set', path: 'muted', value: true }] : []),
      ]
      if (ops.length > 0) await must(call, 'layer.patch', { id: made.id, ops })
      placed.push({ index: p.index, layerId: made.id, mediaId: media.id, startMs, endMs: round(p.endMs) })
    }
    return { compId: comp.id, ...(trackId ? { trackId } : {}), placed, rejected: plan.rejected, sentences: sentences.length }
  },
})
