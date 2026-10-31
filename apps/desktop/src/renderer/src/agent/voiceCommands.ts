import { type Comp, CommandError, type CommandResult, defineCommand, findComp, locateLayer, type MediaAsset, type SpeechInfo, type TakePiece, wordsOnTimeline } from '@uve/core'
import { alignWords, layoutText, scriptFontsOf, speechSpan, splitWords } from '@uve/engine'
import { z } from 'zod'
import { mediaUrl } from '../../../shared/media'
import { BULBUL_V3_SPEAKERS, BULBUL_V4_FLASH_SPEAKERS, DEFAULT_SPEAKER, languageCode, SARVAM_LANGUAGES, SARVAM_PRICES, STT_MAX_SECONDS, STT_MODES, CLONE_LIMITS, type SttRequest, TRANSLATE_MODES, TTS_MODELS } from '../../../shared/sarvam'
import { mediaInput } from '../media/import'
import { probeMedia } from '../media/probe'
import { loadFont } from '../library/fonts'
import { useEditor } from '../store'
import { retimeWords } from './footageCommands'

// Voices in Indian languages (Sarvam: Bulbul speaks, Saaras listens, Sarvam
// Translate translates). Each phrase is its own take, so the timeline gets its
// timing from each take's real length; inside a take, words are timed by our
// own alignment of the known script to the audio (Sarvam gives no word times).
// Every take keeps what it says on its media (media.speech), so captions and
// other languages follow the words.

type Call = (name: string, input: unknown) => Promise<CommandResult>
type SttMode = NonNullable<SttRequest['mode']>

/** The rate takes are decoded at for timing: plenty for speech, small in memory. */
export const DECODE_RATE = 16000

/** A Sarvam failure as a command error: the main process's message without Electron's wrapping. */
function sarvamError(error: unknown): CommandError {
  const raw = error instanceof Error ? error.message : String(error)
  const message = raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  const hint = /key/i.test(message)
    ? 'Set the key in the Voice tab, or the SARVAM_API_KEY environment variable before starting the editor.'
    : /credits/i.test(message)
      ? 'sarvam_usage shows what this editor has spent.'
      : 'Try again; a take or translation that worked once is kept and costs nothing the next time.'
  return new CommandError(message, hint)
}

async function sarvam<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw error instanceof CommandError ? error : sarvamError(error)
  }
}

/** A sound file mixed to mono at DECODE_RATE. */
export async function decodeMono(path: string): Promise<Float32Array> {
  const response = await fetch(mediaUrl(path)).catch(() => null)
  if (!response?.ok) throw new CommandError('Could not read the sound file.', 'Check that the file is still where the project says.')
  let buffer: AudioBuffer
  try {
    buffer = await new OfflineAudioContext(1, 1, DECODE_RATE).decodeAudioData(await response.arrayBuffer())
  } catch {
    throw new CommandError('Could not decode the sound file.', 'Use a WAV, MP3, M4A or video file with sound.')
  }
  const mono = new Float32Array(buffer.length)
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c)
    for (let i = 0; i < mono.length; i++) mono[i]! += data[i]! / buffer.numberOfChannels
  }
  return mono
}

/** 16-bit PCM WAV bytes of mono samples. */
export function encodeWav(samples: Float32Array, rate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const text = (at: number, s: string) => [...s].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)))
  text(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  text(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  samples.forEach((v, i) => view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, v)) * 32767), true))
  return bytes
}

/** The language of a text from its script: Devanagari reads as Hindi, Latin as Indian English. */
export function languageOfText(text: string): string {
  const script = scriptFontsOf(text)[0]?.script
  const byScript: Record<string, string> = { Devanagari: 'hi-IN', Bengali: 'bn-IN', Gurmukhi: 'pa-IN', Gujarati: 'gu-IN', Oriya: 'od-IN', Tamil: 'ta-IN', Telugu: 'te-IN', Kannada: 'kn-IN', Malayalam: 'ml-IN' }
  return (script && byScript[script]) || 'en-IN'
}

function requireLanguage(input: string | undefined, text?: string): string {
  if (input === undefined) return text ? languageOfText(text) : 'en-IN'
  const code = languageCode(input)
  if (!code) throw new CommandError(`Unknown language "${input}".`, `Languages: ${SARVAM_LANGUAGES.map((l) => `${l.code} (${l.name})`).join(', ')}.`)
  return code
}

/** Where the voice is in a take and when each word of its script is spoken, ms from the file's start. */
export function timeWords(samples: Float32Array, text: string): Pick<SpeechInfo, 'startMs' | 'endMs' | 'words'> {
  const span = speechSpan(samples, DECODE_RATE)
  const words = alignWords(samples, DECODE_RATE, splitWords(text), span ? { span } : {})
  const durationMs = Math.round((samples.length / DECODE_RATE) * 1000)
  return { startMs: span?.startMs ?? 0, endMs: span?.endMs ?? durationMs, words }
}

export interface Take {
  mediaId: string
  durationMs: number
  speech: SpeechInfo
  cached: boolean
  costInr: number
}

export interface SpeakOptions {
  text: string
  language: string
  voice?: string
  model?: (typeof TTS_MODELS)[number]
  pace?: number
  temperature?: number
  name?: string
  source?: string | null
  /** The speaker's own voice (a WAV of ≤ 15 s, from voiceReference): the take is spoken in it (Sarvam instant voice cloning). */
  reference?: Uint8Array
}

/** Seconds of a speaker's own voice sent as the cloning reference (Sarvam takes up to 15; 10–15 is best). */
const REFERENCE_MS = 12_000

/**
 * A clip of a speaker's own voice for cloning: the 12 s of the take (`id`, a
 * layer or media id) with the most speech in it (from its analysed speech
 * spans when it has them), or from startMs (ms in the file) when given.
 */
export async function voiceReference(project: Parameters<typeof locateLayer>[0], id: string, startMs?: number): Promise<Uint8Array> {
  const { media } = soundOf(project, id)
  const samples = await decodeMono(media.path)
  const fileMs = Math.round((samples.length / DECODE_RATE) * 1000)
  let from = startMs ?? 0
  const spans = media.footage?.speech ?? (media.speech ? [{ startMs: media.speech.startMs, endMs: media.speech.endMs }] : [])
  if (startMs === undefined && spans.length > 0) {
    // The window richest in speech, starting where speech starts.
    let best = -1
    for (const s of spans) {
      const end = s.startMs + REFERENCE_MS
      const heard = spans.reduce((sum, t) => sum + Math.max(0, Math.min(end, t.endMs) - Math.max(s.startMs, t.startMs)), 0)
      if (heard > best) {
        best = heard
        from = s.startMs
      }
    }
  }
  from = Math.max(0, Math.min(from, fileMs - Math.min(fileMs, REFERENCE_MS)))
  const a = Math.floor((from / 1000) * DECODE_RATE)
  const b = Math.min(samples.length, a + Math.floor((REFERENCE_MS / 1000) * DECODE_RATE))
  if (b - a < DECODE_RATE * 3) throw new CommandError(`${media.name} has under 3 seconds of voice to clone.`, 'Give a longer take of the speaker.')
  return encodeWav(samples.subarray(a, b), DECODE_RATE)
}

/** One take: Sarvam speaks the text, the file becomes project media with its words timed. */
export async function speak(options: SpeakOptions, call: Call): Promise<Take> {
  const voice = options.reference ? 'clone' : (options.voice ?? DEFAULT_SPEAKER)
  const result = await sarvam(() =>
    window.uve.sarvam.tts({
      text: options.text,
      language: options.language,
      ...(options.reference ? { reference: options.reference } : { speaker: voice }),
      ...(options.model && !options.reference ? { model: options.model } : {}),
      ...(options.pace !== undefined ? { pace: options.pace } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    }),
  )
  const probed = await probeMedia(result.file)
  const samples = await decodeMono(result.file.path)
  const speech: SpeechInfo = {
    text: options.text,
    language: options.language,
    voice,
    provider: options.reference ? 'sarvam:voice-clone' : `sarvam:${options.model ?? 'bulbul:v3'}`,
    ...(options.pace !== undefined ? { pace: options.pace } : {}),
    ...timeWords(samples, options.text),
    source: options.source ?? null,
  }
  const words = options.text.trim().split(/\s+/).slice(0, 5).join(' ')
  const added = await call('media.add', {
    ...mediaInput(probed),
    name: options.name ?? `voice ${options.language} ${voice} – ${words}.wav`,
    speech,
  })
  if (!added.ok) throw new CommandError(added.error, added.hint)
  const mediaId = (added.value as { id: string }).id
  // A take generated before is the same file: its media entry is reused, so its speech is set again.
  if ((added.value as { reused?: boolean }).reused) await call('media.speech', { mediaId, speech })
  return { mediaId, durationMs: probed.durationMs ?? Math.round((samples.length / DECODE_RATE) * 1000), speech, cached: result.cached, costInr: result.costInr }
}

/** Puts a take on the timeline so its voice (not its file) starts at `speechAtMs`. Returns the layer id. */
export async function placeTake(take: Take, compId: string, speechAtMs: number, call: Call, trackId?: string): Promise<string> {
  const startMs = Math.max(0, Math.round(speechAtMs - take.speech.startMs))
  const created = await call('layer.create', { compId, kind: 'audio', mediaId: take.mediaId, startMs, ...(trackId ? { trackId } : {}) })
  if (!created.ok) throw new CommandError(created.error, created.hint)
  return (created.value as { id: string }).id
}

const languageField = z.string().min(2).describe('hi-IN, ta-IN, bn-IN, te-IN, kn-IN, ml-IN, mr-IN, gu-IN, pa-IN, od-IN or en-IN (a name like "Hindi" works too)')

export const voicesList = defineCommand({
  name: 'voices.list',
  summary: 'The voices generate_speech can use: Sarvam Bulbul speakers, the 11 languages they speak, and whether a Sarvam key is set.',
  details:
    'Every Bulbul v3 speaker speaks every language (Hindi, Bengali, Tamil, Telugu, Kannada, Malayalam, Marathi, Gujarati, Punjabi, Odia, Indian English). gender is given where Sarvam states it, else null: listen before choosing. Bulbul v4 Flash (model "bulbul:v4-flash", Sarvam’s newest: more natural, cheaper) has its own speakers named name_language_style (kavya_hi_conversational, a narrator, a documentary or ads voice; enhi speaks Hinglish): v4Voices lists those for the language; without a v4 voice, generate_speech picks a narrator of the language. Prices are in rupees; sarvam_usage shows what this editor has spent.',
  effect: 'read',
  input: z.strictObject({
    language: z.string().optional().describe('Only check that this language is spoken'),
    gender: z.enum(['male', 'female']).optional(),
  }),
  run: async ({ language, gender }) => {
    if (language !== undefined) requireLanguage(language)
    const status = await sarvam(() => window.uve.sarvam.status())
    return {
      provider: 'sarvam',
      models: TTS_MODELS,
      defaultVoice: DEFAULT_SPEAKER,
      languages: SARVAM_LANGUAGES.map((l) => ({ code: l.code, name: l.name, native: l.native })),
      voices: BULBUL_V3_SPEAKERS.filter((s) => !gender || s.gender === gender),
      v4Voices: BULBUL_V4_FLASH_SPEAKERS.filter((s) => !language || s.split('_')[1] === language.toLowerCase().split('-')[0] || s.split('_')[1] === 'enhi').map((id) => ({ id, language: id.split('_')[1], style: id.split('_').slice(2).join(' ') })),
      key: status.hasKey ? `set (${status.source})` : 'missing: set it in the Voice tab',
      pricesInr: SARVAM_PRICES,
    }
  },
})

export const generateSpeech = defineCommand({
  name: 'generate.speech',
  summary:
    'Speak a line in an Indian language (or Indian English) with a Sarvam Bulbul voice: a new audio take with every word timed, optionally placed. One take per phrase or scene; lines makes several in a row.',
  details:
    'text: one phrase or scene (≤ 2,500 characters); lines: several, one take each, placed one after another with gapMs of silence between voices. Write numbers and names the way they should be said. language defaults from the script (Devanagari reads as hi-IN; use mr-IN for Marathi); voice from voices_list (default shubh). pace 0.5 to 2 (1 normal). place: {compId?, startMs?, trackId?}: the voice (not the silence at the head of the file) starts at startMs (default the playhead). The take keeps its script, language, voice and word times (media.speech): media_transcribe {captions} turns it into a caption, comp_localize re-speaks it in another language. The same text, voice and settings again reuse the file and cost nothing. Returns mediaId (and layerId when placed), durationMs, speechStartMs/speechEndMs (in the file), words [{text, startMs, endMs}], costInr.',
  effect: 'write',
  input: z
    .strictObject({
      text: z.string().min(1).max(2500).optional(),
      lines: z.array(z.string().min(1).max(2500)).min(1).max(50).optional(),
      language: languageField.optional(),
      voice: z.string().min(1).optional().describe('A speaker from voices_list (default shubh; with model bulbul:v4-flash, a v4 voice or a narrator of the language), or "clone": the voice of reference'),
      reference: z.string().min(1).optional().describe('voice "clone": a layer or media id of the speaker’s own voice (12 s of it are the sample; analyse footage first so the clearest stretch is picked)'),
      referenceStartMs: z.number().min(0).optional().describe('Where in the reference file the sample starts, ms (default: the stretch with the most speech)'),
      model: z.enum(TTS_MODELS).optional(),
      pace: z.number().min(0.5).max(2).optional(),
      temperature: z.number().min(0.01).max(1).optional().describe('Lower is steadier, higher more expressive (default 0.6)'),
      name: z.string().min(1).optional(),
      gapMs: z.number().min(0).max(5000).default(300).describe('lines: silence between one voice ending and the next starting'),
      place: z
        .union([z.boolean(), z.strictObject({ compId: z.string().optional(), startMs: z.number().min(0).optional(), trackId: z.string().optional() })])
        .optional(),
      provider: z.literal('sarvam').optional().describe('Only Sarvam for now'),
    })
    .refine((v) => (v.text === undefined) !== (v.lines === undefined), { message: 'Give text or lines, not both.' }),
  run: async (input, ctx) => {
    const call: Call = (name, value) => ctx.call(name, value)
    const lines = input.lines ?? [input.text as string]
    const language = requireLanguage(input.language, lines.join(' '))
    const place = input.place === true ? {} : input.place || null
    const compId = place ? findComp(ctx.project, place.compId ?? useEditor.getState().activeCompId).id : null
    let cursor = place?.startMs ?? useEditor.getState().timeMs
    let reference: Uint8Array | undefined
    if (input.voice === 'clone') {
      if (!input.reference) throw new CommandError('voice "clone" needs reference: a layer or media id of the speaker’s own voice.', 'Use only a voice the person has agreed to have cloned (their own).')
      const long = lines.find((l) => l.length > CLONE_LIMITS.maxChars)
      if (long) throw new CommandError(`A cloned voice speaks ${CLONE_LIMITS.maxChars} characters at a time; one line has ${long.length}.`, 'Split it with lines.')
      reference = await voiceReference(ctx.project, input.reference, input.referenceStartMs)
    }
    const takes = []
    for (const [i, text] of lines.entries()) {
      const take = await speak(
        {
          text,
          language,
          ...(reference ? { reference } : input.voice ? { voice: input.voice } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.pace !== undefined ? { pace: input.pace } : {}),
          ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
          ...(input.name ? { name: lines.length > 1 ? `${input.name} ${i + 1}` : input.name } : {}),
        },
        call,
      )
      let layerId: string | undefined
      if (compId) {
        layerId = await placeTake(take, compId, cursor, call, place?.trackId)
        cursor += take.speech.endMs - take.speech.startMs + input.gapMs
      }
      takes.push({
        mediaId: take.mediaId,
        ...(layerId ? { layerId } : {}),
        durationMs: take.durationMs,
        speechStartMs: take.speech.startMs,
        speechEndMs: take.speech.endMs,
        words: take.speech.words,
        cached: take.cached,
        costInr: take.costInr,
      })
    }
    const costInr = Math.round(takes.reduce((sum, t) => sum + t.costInr, 0) * 100) / 100
    return lines.length === 1 ? { ...takes[0], language, voice: input.voice ?? DEFAULT_SPEAKER } : { takes, language, voice: input.voice ?? DEFAULT_SPEAKER, costInr }
  },
})

/** Sarvam's speech to text over a whole file: pieces of at most STT_MAX_SECONDS cut at the quietest moment, each with its phrases. */
async function transcribeSamples(samples: Float32Array, language: string | undefined, mode?: SttMode): Promise<{ text: string; language: string | null; phrases: { text: string; startMs: number; endMs: number }[]; costInr: number }> {
  const limit = Math.floor((STT_MAX_SECONDS - 1) * DECODE_RATE)
  const phrases: { text: string; startMs: number; endMs: number }[] = []
  let detected: string | null = null
  let costInr = 0
  let from = 0
  while (from < samples.length) {
    let to = Math.min(samples.length, from + limit)
    if (to < samples.length) {
      // Cut in the quietest 20 ms of the last third, so no word is split.
      const frame = DECODE_RATE / 50
      let best = to
      let quietest = Number.POSITIVE_INFINITY
      for (let at = from + Math.floor(limit * 0.66); at + frame <= to; at += frame) {
        let sum = 0
        for (let i = at; i < at + frame; i++) sum += samples[i]! * samples[i]!
        if (sum < quietest) {
          quietest = sum
          best = at + frame / 2
        }
      }
      to = best
    }
    const piece = samples.subarray(from, to)
    const answer = await sarvam(() => window.uve.sarvam.stt({ wav: encodeWav(piece, DECODE_RATE), ...(language ? { language } : {}), ...(mode ? { mode } : {}) }))
    detected ??= answer.language
    costInr += answer.costInr
    const offset = Math.round((from / DECODE_RATE) * 1000)
    for (const p of answer.segments) if (p.text.trim()) phrases.push({ text: p.text.trim(), startMs: p.startMs + offset, endMs: p.endMs + offset })
    from = to
  }
  return { text: phrases.map((p) => p.text).join(' '), language: detected, phrases, costInr: Math.round(costInr * 100) / 100 }
}

/** The media a layer or media id refers to, and the audio layer when a layer was given. */
function soundOf(project: Parameters<typeof locateLayer>[0], id: string): { media: MediaAsset; layerId: string | null } {
  const direct = project.media.find((m) => m.id === id)
  if (direct) return { media: direct, layerId: null }
  const { layer } = locateLayer(project, id)
  const mediaId = 'mediaId' in layer && typeof layer.mediaId === 'string' ? layer.mediaId : null
  const media = mediaId ? project.media.find((m) => m.id === mediaId) : undefined
  if (!media || (media.kind !== 'audio' && media.kind !== 'video')) throw new CommandError(`"${layer.name}" has no sound to transcribe.`, 'Give an audio or video layer, or a media id (media.list).')
  return { media, layerId: layer.id }
}

/** Every piece of a take in its comp: the audio and video layers that play the same file as this layer. */
export function takePieces(comp: Comp, layerId: string): (TakePiece & { id: string })[] {
  const layers = comp.tracks.flatMap((t) => t.layers)
  const layer = layers.find((l) => l.id === layerId)
  if (!layer || (layer.kind !== 'audio' && layer.kind !== 'video')) return []
  return layers.filter((l): l is typeof layer => (l.kind === 'audio' || l.kind === 'video') && l.mediaId === layer.mediaId)
}

/** Line height of captions: room for tall Indian scripts and the focus word's highlight. */
export const CAPTION_LINE_HEIGHT = 1.35

/** Common Hindi words as they are written in Latin letters (Hinglish). */
const HINDI_IN_LATIN = new Set(['hai', 'hain', 'ke', 'ka', 'ki', 'ko', 'se', 'aur', 'bhi', 'nahi', 'nahin', 'kya', 'kar', 'karte', 'karna', 'raha', 'rahe', 'rahi', 'sab', 'koi', 'yeh', 'ye', 'woh', 'wo', 'matlab', 'jaise', 'bahut', 'zyada', 'mein', 'hum', 'aap', 'tum', 'tha', 'thi', 'ho', 'hota', 'kuch', 'gaye', 'abhi', 'accha', 'acha', 'upar', 'aaj', 'aajkal', 'lekin', 'kyunki'])

/** Whether a transcript in Latin letters is mostly Hindi spoken with English (one word in eight or more is Hindi). */
export function soundsHindi(text: string): boolean {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? []
  return words.length > 0 && words.filter((w) => HINDI_IN_LATIN.has(w)).length / words.length >= 0.125
}

/** Words grouped into caption lines: a new line after a phrase-ending mark, a pause of gapMs, or maxWords words. */
export function captionChunks<W extends { text: string; startMs: number; endMs: number }>(words: readonly W[], maxWords = 7, gapMs = 300): W[][] {
  const chunks: W[][] = []
  let current: W[] = []
  words.forEach((word, i) => {
    current.push(word)
    const next = words[i + 1]
    const ends = /[,.!?;:।॥]["'”’)]*$/u.test(word.text) && current.length >= 2
    if (!next || ends || current.length >= maxWords || next.startMs - word.endMs >= gapMs) {
      chunks.push(current)
      current = []
    }
  })
  return chunks
}

/** Makes word-synced captions for a take on the timeline, one per phrase (or re-times one existing text layer to all its words). Returns their ids. */
export async function captionTake(audioLayerId: string, speech: SpeechInfo, call: Call, project: Parameters<typeof locateLayer>[0], existing?: string): Promise<string[]> {
  const { comp } = locateLayer(project, audioLayerId)
  // After a cut the take is several layers: every piece of it places its own words.
  const words = wordsOnTimeline(takePieces(comp, audioLayerId), speech.words).map((w) => ({ text: w.text, startMs: w.startMs, endMs: w.endMs }))
  if (words.length === 0) throw new CommandError('None of the words of this take are on the timeline.', 'The cut removed them all, or the take has no words.')
  const time = async (id: string, chunk: typeof words) => {
    const timed = await call('caption.set', { id, words: chunk, timesIn: 'comp' })
    if (!timed.ok) throw new CommandError(timed.error, timed.hint)
  }
  if (existing) {
    const set = await call('text.set', { id: existing, text: words.map((w) => w.text).join(' ') || speech.text })
    if (!set.ok) throw new CommandError(set.error, set.hint)
    await time(existing, words)
    return [existing]
  }
  const chunks = captionChunks(words)
  const ids: string[] = []
  let trackId: string | undefined
  let free = 0
  for (const [i, chunk] of chunks.entries()) {
    const text = chunk.map((w) => w.text).join(' ')
    // Each line shows from just before its first word until the next line takes over.
    const startMs = Math.max(free, chunk[0]!.startMs - 150)
    const next = chunks[i + 1]
    const endMs = next ? Math.max(startMs + 200, next[0]!.startMs - 150) : chunk.at(-1)!.endMs + 400
    const created = await call('layer.create', {
      compId: comp.id,
      kind: 'text',
      name: `Caption – ${text.slice(0, 24)}`,
      text,
      startMs,
      durationMs: endMs - startMs,
      ...(trackId ? { trackId } : {}),
      transform: { x: 0, y: Math.round(comp.height * 0.32) },
      style: { fontSize: Math.round(Math.min(comp.width, comp.height) / 16), fontWeight: 700, align: 'center', lineHeight: CAPTION_LINE_HEIGHT },
      maxWidth: Math.round(comp.width * 0.84),
    })
    if (!created.ok) throw new CommandError(created.error, created.hint)
    const made = created.value as { id: string; trackId?: string }
    trackId ??= made.trackId
    free = endMs
    await time(made.id, chunk)
    ids.push(made.id)
  }
  return ids
}

export const mediaTranscribe = defineCommand({
  name: 'media.transcribe',
  summary:
    'Time every word of a voice take: give its script (free, our own alignment) or let Sarvam Saaras hear it; the words are kept on the media, and captions makes or re-times a word-synced caption.',
  details:
    'id: an audio or video layer (needed for captions) or a media id. text: the script, which gives exact words (alignment is far more reliable than listening; always give it when you have it). Without text, Sarvam speech to text (₹0.49 a minute) hears it in language (default: detected), phrase by phrase, and the words inside each phrase are aligned. A take from generate_speech already has its words: captions alone uses them. captions: true makes word-synced caption text layers over the take, one per phrase (a new line at a full stop or comma, a pause, or 7 words), on one lane, placed through every piece a cut left of the take; {id} re-times that one text layer to all the words. Captions over a verbatim transcript (from media_analyze, made for cutting) hear the take again as clean text first (codemix for an Indian language: Hindi in Devanagari, English words in English). Returns text, language, words, phrases (when heard), captionIds, costInr.',
  effect: 'write',
  input: z.strictObject({
    id: z.string().min(1).describe('An audio or video layer, or a media id'),
    text: z.string().min(1).optional().describe('The script as spoken'),
    language: languageField.optional(),
    captions: z.union([z.boolean(), z.strictObject({ id: z.string().min(1).describe('A text layer to re-time') })]).optional(),
    force: z.boolean().default(false).describe('Hear or align again although the take already has words'),
    mode: z.enum(STT_MODES).default('transcribe').describe('verbatim keeps every filler and false start (for cutting footage); transcribe gives clean text'),
  }),
  run: async ({ id, text, language, captions, force, mode }, ctx) => {
    const call: Call = (name, value) => ctx.call(name, value)
    const { media, layerId } = soundOf(ctx.project, id)
    if (captions && !layerId) throw new CommandError('Captions need the take on the timeline.', 'Give the audio layer id instead of the media id.')
    // A verbatim transcript is for cutting (every filler, Hindi in Latin letters): captions hear the take again as clean text,
    // in codemix for an Indian language, so Hindi reads in Devanagari and English words stay English.
    const verbatim = media.speech?.provider?.endsWith(':verbatim') ?? false
    const recaption = captions && verbatim && text === undefined && !force
    if (recaption) {
      // Hinglish is often heard as English: its Hindi words in Latin letters say otherwise.
      const spoken = media.speech?.language ?? null
      const indian = language && !language.startsWith('en') ? language : spoken && !spoken.startsWith('en') ? spoken : soundsHindi(media.speech?.text ?? '') ? 'hi-IN' : null
      language = indian ?? language ?? spoken ?? undefined
      mode = indian ? 'codemix' : 'transcribe'
    }
    let speech = media.speech && !force && text === undefined && !(captions && verbatim) ? media.speech : null
    let phrases: { text: string; startMs: number; endMs: number }[] | undefined
    let costInr = 0
    if (!speech) {
      const samples = await decodeMono(media.path)
      if (text !== undefined) {
        speech = { text, language: requireLanguage(language, text), voice: media.speech?.voice ?? null, provider: media.speech?.provider ?? null, ...timeWords(samples, text), source: media.speech?.source ?? null }
      } else {
        const heard = await transcribeSamples(samples, language ? requireLanguage(language) : undefined, mode)
        if (!heard.text) throw new CommandError(`No speech was heard in ${media.name}.`, 'Check the file has a voice in it, or give its text.')
        phrases = heard.phrases
        costInr = heard.costInr
        // Words inside each phrase are aligned to that phrase's stretch of the audio.
        let words = heard.phrases.flatMap((p) => {
          const from = Math.floor((p.startMs / 1000) * DECODE_RATE)
          const to = Math.min(samples.length, Math.ceil((p.endMs / 1000) * DECODE_RATE))
          return alignWords(samples.subarray(from, to), DECODE_RATE, splitWords(p.text)).map((w) => ({ ...w, startMs: w.startMs + p.startMs, endMs: w.endMs + p.startMs }))
        })
        // Fitted to the speech gate like the words the cut was made from, so captions keep to the cut.
        const gate = media.footage?.gate ? media.footage.speech : []
        if (recaption && gate.length > 0) words = retimeWords(samples, words, gate)
        const span = speechSpan(samples, DECODE_RATE)
        speech = {
          text: heard.text,
          language: (recaption ? language : undefined) ?? heard.language ?? requireLanguage(language, heard.text),
          voice: null,
          provider: mode === 'verbatim' ? 'sarvam:saaras:v4:verbatim' : `sarvam:saaras:v4${mode === 'codemix' ? ':codemix' : ''}`,
          startMs: span?.startMs ?? 0,
          endMs: span?.endMs ?? Math.round((samples.length / DECODE_RATE) * 1000),
          words,
          source: null,
        }
      }
      const kept = await call('media.speech', { mediaId: media.id, speech })
      if (!kept.ok) throw new CommandError(kept.error, kept.hint)
    }
    let captionIds: string[] = []
    if (captions && layerId) captionIds = await captionTake(layerId, speech, call, ctx.project, typeof captions === 'object' ? captions.id : undefined)
    return { mediaId: media.id, text: speech.text, language: speech.language, words: speech.words, ...(phrases ? { phrases } : {}), ...(captionIds.length > 0 ? { captionIds } : {}), costInr }
  },
})

/** Splits words into `count` lines of about equal length (a title broken over lines keeps its shape). */
export function balanceLines(text: string, count: number): string {
  const words = text.trim().split(/\s+/)
  if (count <= 1 || words.length <= 1) return text.trim()
  const lines: string[][] = [[]]
  const each = text.trim().length / Math.min(count, words.length)
  let used = 0
  for (const word of words) {
    const line = lines.at(-1) as string[]
    // A new line once this one has its share, while lines and words remain for the rest.
    if (line.length > 0 && used + word.length / 2 > each * lines.length && lines.length < count) lines.push([word])
    else line.push(word)
    used += word.length + 1
  }
  return lines.map((l) => l.join(' ')).join('\n')
}

/** Translates one text with Sarvam (cached on disk), keeping its line breaks. */
export async function translateText(text: string, to: string, from?: string, mode?: (typeof TRANSLATE_MODES)[number]): Promise<{ text: string; costInr: number }> {
  const lines = text.split('\n')
  // A title broken over lines is one sentence: translated whole (word order changes), then broken again.
  if (lines.length > 1 && lines.every((l) => /\p{L}/u.test(l))) {
    const joined = lines.map((l) => l.trim()).join(' ')
    const result = await sarvam(() => window.uve.sarvam.translate({ text: joined, to, from: from ?? languageOfText(joined), ...(mode ? { mode } : {}) }))
    return { text: balanceLines(result.text, lines.length), costInr: result.costInr }
  }
  let costInr = 0
  const out: string[] = []
  for (const line of lines) {
    // Lines with no letters (numbers, prices, symbols) stay as they are.
    if (!/\p{L}/u.test(line)) {
      out.push(line)
      continue
    }
    // Sarvam Translate wants the source language named: read it from the script when not given.
    const result = await sarvam(() => window.uve.sarvam.translate({ text: line, to, from: from ?? languageOfText(line), ...(mode ? { mode } : {}) }))
    costInr += result.costInr
    out.push(result.text)
  }
  return { text: out.join('\n'), costInr }
}

export const textTranslate = defineCommand({
  name: 'text.translate',
  summary: 'Translate text layers into an Indian language (or English) with Sarvam Translate; the type falls back to a Noto family that has the script.',
  details:
    'ids: text layers; or compId: every text layer of that comp (default the open one when ids is left out). to: the language. keep: words to leave untranslated (brand and product names): a layer whose whole text is one of them is skipped. Lines without letters (prices, numbers) stay. Styled ranges follow their words where the edit allows; a caption keeps its look and its words are spread evenly over its old span (media_transcribe {captions: {id}} re-times it to a voice). Translations are cached, so the same text costs nothing again. Returns each layer\'s old and new text and costInr.',
  effect: 'write',
  input: z.strictObject({
    ids: z.array(z.string().min(1)).min(1).optional(),
    compId: z.string().optional(),
    to: languageField,
    from: z.string().optional().describe('Default detected'),
    mode: z.enum(TRANSLATE_MODES).optional().describe('formal (default), modern-colloquial, classic-colloquial or code-mixed'),
    keep: z.array(z.string().min(1)).optional(),
    fit: z.boolean().default(true).describe("Shrink a text without a fixed box whose translation runs wider than the original and off the frame"),
  }),
  run: async ({ ids, compId, to, from, mode, keep, fit }, ctx) => {
    const target = requireLanguage(to)
    const source = from ? requireLanguage(from) : undefined
    const layers = ids
      ? ids.map((id) => locateLayer(ctx.project, id).layer)
      : findComp(ctx.project, compId ?? useEditor.getState().activeCompId).tracks.flatMap((t) => t.layers)
    const texts = layers.filter((l) => l.kind === 'text')
    if (texts.length === 0) throw new CommandError('No text layers to translate.', ids ? 'Give text layer ids.' : 'The comp has no text layers.')
    const kept = new Set((keep ?? []).map((k) => k.trim().toLowerCase()))
    const changed = []
    const shrunk: string[] = []
    let costInr = 0
    for (const layer of texts) {
      if (layer.kind !== 'text' || kept.has(layer.text.trim().toLowerCase())) continue
      const result = await translateText(layer.text, target, source, mode)
      costInr += result.costInr
      if (result.text === layer.text) continue
      const before = inkWidth(ctx.project, layer.id)
      const set = await ctx.call('text.set', { id: layer.id, text: result.text })
      if (!set.ok) throw new CommandError(set.error, set.hint)
      // A translation whose longest line runs past its box (or, with no box, wider than it was and off the frame) gets smaller type.
      if (fit && before) {
        await Promise.all(scriptFontsOf(result.text).map((s) => loadFont(s.family, layer.style.fontWeight)))
        const after = inkWidth(ctx.project, layer.id)
        const room = layer.maxWidth ?? Math.max(before.width, before.compWidth * 0.9)
        if (after && after.width > room * 1.01) {
          const fontSize = Math.max(8, Math.floor((layer.style.fontSize * room) / after.width))
          const patched = await ctx.call('layer.patch', { id: layer.id, ops: [{ op: 'set', path: 'style.fontSize', value: fontSize }] })
          if (patched.ok) shrunk.push(layer.id)
        }
      }
      if (layer.caption && layer.caption.cues.length > 0) {
        const first = layer.caption.cues[0]!
        const last = layer.caption.cues.at(-1)!
        const even = await ctx.call('caption.set', { id: layer.id, even: { unit: 'word', fromMs: first.startMs, toMs: last.endMs } })
        if (!even.ok) throw new CommandError(even.error, even.hint)
      }
      changed.push({ id: layer.id, from: layer.text, to: result.text })
    }
    return { language: target, layers: changed, ...(shrunk.length > 0 ? { shrunk } : {}), costInr: Math.round(costInr * 100) / 100 }
  },
})

export const sarvamUsage = defineCommand({
  name: 'sarvam.usage',
  summary: 'What this editor has spent on Sarvam (voices, translation, speech to text), estimated in rupees, and whether a key is set.',
  details: 'Sarvam has no balance endpoint: check the balance at dashboard.sarvam.ai. Cached takes and translations cost nothing and are not counted. When credits run out, calls fail with a message saying so.',
  effect: 'read',
  input: z.strictObject({}),
  run: async () => {
    const [usage, status] = await Promise.all([sarvam(() => window.uve.sarvam.usage()), sarvam(() => window.uve.sarvam.status())])
    return { ...usage, key: status.hasKey ? { source: status.source, hint: status.hint } : null, pricesInr: SARVAM_PRICES }
  },
})

/** The width of a text layer's longest line as laid out in its box (layer px), and the comp's width. */
function inkWidth(project: Parameters<typeof locateLayer>[0], id: string): { width: number; compWidth: number } | null {
  const { comp, layer } = locateLayer(project, id)
  if (layer.kind !== 'text') return null
  const measure = new OffscreenCanvas(1, 1).getContext('2d')
  if (!measure) return null
  const layout = layoutText(measure, layer.text, layer.style, { maxWidth: layer.maxWidth, maxHeight: layer.maxHeight, verticalAlign: layer.verticalAlign }, layer.ranges)
  return { width: Math.max(0, ...layout.lines.map((l) => l.width)), compWidth: comp.width }
}
