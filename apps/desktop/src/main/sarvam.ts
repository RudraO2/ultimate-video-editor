import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { app, ipcMain } from 'electron'
import {
  NO_KEY_MESSAGE,
  STT_MAX_SECONDS,
  type SarvamStatus,
  type SarvamUsage,
  type SttRequest,
  type SttResult,
  CLONE_LIMITS,
  STT_MODES,
  TRANSLATE_MODES,
  TTS_MODELS,
  type TranslateRequest,
  type TranslateResult,
  type TtsRequest,
  type TtsResult,
  keyHint,
  languageCode,
  sarvamErrorMessage,
  splitForTranslate,
  sttCost,
  stableKey,
  translateBody,
  translateCost,
  ttsBody,
  ttsCost,
  wavSeconds,
} from '../shared/sarvam'
import { grant } from './media'

// Sarvam AI (Indian-language voices, translation, speech to text), called from
// here so the key never reaches the renderer. Everything that comes back is
// kept in the app's data folder, so asking again costs nothing; only real
// calls are added to the usage ledger. The key is read from settings.json
// (set in the Voice tab) or else the SARVAM_API_KEY environment variable.

const BASE = 'https://api.sarvam.ai'
const dir = () => join(app.getPath('userData'), 'sarvam')
const TIMEOUT_MS = 60_000
const MAX_TRIES = 3
const RETRY_WAIT_MS = 1500
const MAX_WAV_BYTES = 16 * 1024 * 1024

// ---- Files ----

/** Writes a file whole or not at all: a temp file, then a rename. */
async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  await fs.writeFile(temp, data)
  await fs.rename(temp, path)
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(join(dir(), file), 'utf8')) as T
  } catch {
    return fallback
  }
}

// Read-then-write changes to one JSON file are queued, so two calls at once
// cannot lose each other's entry.
let queue: Promise<unknown> = Promise.resolve()
function update<T>(file: string, fallback: T, change: (value: T) => void): Promise<void> {
  const next = queue.then(async () => {
    const value = await readJson(file, fallback)
    change(value)
    await writeAtomic(join(dir(), file), JSON.stringify(value))
  })
  queue = next.catch(() => undefined)
  return next
}

const sha = (...parts: (string | Uint8Array)[]) => {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part)
  return hash.digest('hex')
}

// ---- Key ----

/** The Sarvam key, for OpenCode's Sarvam provider (main process only). */
export async function sarvamKey(): Promise<string | null> {
  return (await currentKey())?.key ?? null
}

async function currentKey(): Promise<{ key: string; source: 'settings' | 'environment' } | null> {
  const saved = (await readJson<{ key?: unknown }>('settings.json', {})).key
  if (typeof saved === 'string' && saved !== '') return { key: saved, source: 'settings' }
  const env = process.env.SARVAM_API_KEY?.trim()
  return env ? { key: env, source: 'environment' } : null
}

async function status(): Promise<SarvamStatus> {
  const found = await currentKey()
  return { hasKey: found !== null, source: found?.source ?? null, hint: found ? keyHint(found.key) : null }
}

async function setKey(value: unknown): Promise<SarvamStatus> {
  if (value !== null && typeof value !== 'string') throw new Error('The key must be text.')
  const key = (value ?? '').trim()
  if (key === '') {
    await fs.rm(join(dir(), 'settings.json'), { force: true })
  } else {
    // A header value: printable characters only, nothing that could add a header line.
    if (key.length > 200 || !/^[\x21-\x7e]+$/.test(key)) throw new Error('That does not look like a Sarvam API key.')
    await writeAtomic(join(dir(), 'settings.json'), JSON.stringify({ key }))
  }
  return status()
}

// ---- Calls ----

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** One call to Sarvam: its parsed JSON. Waits and tries again on a rate limit; any other failure throws a readable error. */
async function call(path: string, body: string | FormData): Promise<Record<string, unknown>> {
  const found = await currentKey()
  if (!found) throw new Error(NO_KEY_MESSAGE)
  const headers: Record<string, string> = { 'api-subscription-key': found.key }
  if (typeof body === 'string') headers['Content-Type'] = 'application/json'
  for (let attempt = 1; ; attempt++) {
    let response: Response
    try {
      response = await fetch(BASE + path, { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
      throw new Error(timedOut ? 'Sarvam took too long to answer. Try again.' : 'Could not reach Sarvam. Check the internet connection.')
    }
    const text = await response.text()
    let parsed: unknown = null
    try {
      parsed = JSON.parse(text)
    } catch {
      // Not JSON: the status alone tells what went wrong.
    }
    if (response.ok) {
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
      throw new Error('Sarvam sent an answer the editor cannot read.')
    }
    if (response.status === 429 && attempt < MAX_TRIES) {
      await sleep(RETRY_WAIT_MS)
      continue
    }
    throw new Error(sarvamErrorMessage(response.status, parsed))
  }
}

// ---- Usage ----

const emptyUsage = (): SarvamUsage => ({
  tts: { chars: 0, costInr: 0 },
  translate: { chars: 0, costInr: 0 },
  stt: { seconds: 0, costInr: 0 },
  totalInr: 0,
  since: new Date().toISOString().slice(0, 10),
})

const round2 = (n: number) => Math.round(n * 100) / 100

async function addUsage(kind: 'tts' | 'translate' | 'stt', amount: number, costInr: number): Promise<void> {
  await update<SarvamUsage>('usage.json', emptyUsage(), (usage) => {
    const entry = usage[kind]
    if (kind === 'stt') (entry as SarvamUsage['stt']).seconds = round2((entry as SarvamUsage['stt']).seconds + amount)
    else (entry as SarvamUsage['tts']).chars += amount
    entry.costInr = round2(entry.costInr + costInr)
    usage.totalInr = round2(usage.tts.costInr + usage.translate.costInr + usage.stt.costInr)
  })
}

// ---- Text to speech ----

/** The text spoken in the voice of a reference clip (instant voice cloning, beta), at a pace. Cached by text, language, pace and reference. */
async function cloneSpeak(req: TtsRequest & { reference: Uint8Array }): Promise<TtsResult> {
  const text = req.text.trim()
  if (!text) throw new Error('There is no text to speak.')
  if (text.length > CLONE_LIMITS.maxChars) throw new Error(`A cloned voice speaks ${CLONE_LIMITS.maxChars} characters at a time; this line has ${text.length}.`)
  const seconds = wavSeconds(req.reference)
  if (seconds === null) throw new Error('The voice reference must be a WAV file.')
  if (seconds > CLONE_LIMITS.maxReferenceSeconds + 0.5) throw new Error(`The voice reference must be ${CLONE_LIMITS.maxReferenceSeconds} seconds at most; this is ${Math.round(seconds)}.`)
  const language = languageCode(req.language) ?? req.language
  if (req.pace !== undefined && !(req.pace >= 0.5 && req.pace <= 2)) throw new Error('Pace must be between 0.5 and 2.')
  // A take at another pace is another file (pace 1 keeps the key takes made before had).
  const pace = req.pace !== undefined && req.pace !== 1 ? { pace: req.pace } : {}
  const path = join(dir(), 'voice', `clone ${sha(req.reference, stableKey({ text, language, ...pace })).slice(0, 12)}.wav`)
  const chars = text.length
  if (await fs.stat(path).catch(() => null)) {
    const [file] = await grant([path])
    if (file) return { file, cached: true, chars, costInr: 0, requestId: null }
  }
  const form = new FormData()
  form.append('text', text)
  form.append('language_code', language)
  if (pace.pace !== undefined) form.append('pace', String(pace.pace))
  form.append('ref_audio', new Blob([req.reference as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }), 'reference.wav')
  const answer = await call('/voices/clone', form)
  const audio = typeof answer.audio_b64 === 'string' ? answer.audio_b64 : typeof answer.audio === 'string' ? answer.audio : null
  if (!audio) throw new Error('Sarvam sent no audio.')
  const wav = Buffer.from(audio, 'base64')
  if (wav.subarray(0, 4).toString('latin1') !== 'RIFF') throw new Error('Sarvam sent audio the editor cannot read.')
  await writeAtomic(path, wav)
  const [file] = await grant([path])
  if (!file) throw new Error('The voice file could not be opened.')
  const costInr = Math.round((chars / 1000) * CLONE_LIMITS.per1000Chars * 100) / 100
  await addUsage('tts', chars, costInr)
  return { file, cached: false, chars, costInr, requestId: typeof answer.request_id === 'string' ? answer.request_id : null }
}

async function tts(req: TtsRequest): Promise<TtsResult> {
  if (req.reference) return cloneSpeak({ ...req, reference: req.reference })
  const body = ttsBody(req)
  const speaker = String(body.speaker)
  if (!/^[\w-]{1,40}$/.test(speaker)) throw new Error(`Unknown voice "${speaker}".`)
  const model = body.model as (typeof TTS_MODELS)[number]
  const chars = req.text.length
  const path = join(dir(), 'voice', `${speaker} ${sha(stableKey(body)).slice(0, 12)}.wav`)
  if (await fs.stat(path).catch(() => null)) {
    const [file] = await grant([path])
    if (file) return { file, cached: true, chars, costInr: 0, requestId: null }
  }
  const answer = await call('/text-to-speech', JSON.stringify(body))
  const audios = answer.audios
  if (!Array.isArray(audios) || audios.length === 0 || !audios.every((a) => typeof a === 'string')) {
    throw new Error('Sarvam sent no audio.')
  }
  const wav = Buffer.from((audios as string[]).join(''), 'base64')
  if (wav.subarray(0, 4).toString('latin1') !== 'RIFF') throw new Error('Sarvam sent audio the editor cannot read.')
  await writeAtomic(path, wav)
  const [file] = await grant([path])
  if (!file) throw new Error('The voice file could not be opened.')
  const costInr = ttsCost(chars, model)
  await addUsage('tts', chars, costInr)
  return { file, cached: false, chars, costInr, requestId: typeof answer.request_id === 'string' ? answer.request_id : null }
}

// ---- Translation ----

async function translate(req: TranslateRequest): Promise<TranslateResult> {
  // Checks the languages before anything is sent.
  translateBody(req, '')
  const chars = req.text.length
  const key = sha(stableKey(req))
  const cache = await readJson<Record<string, { text: string; from: string | null }>>('translate.json', {})
  const hit = cache[key]
  if (hit) return { text: hit.text, from: hit.from, cached: true, chars, costInr: 0 }
  const chunks = splitForTranslate(req.text, req.mode !== undefined && req.mode !== 'formal' ? 1000 : undefined)
  if (chunks.length === 0) throw new Error('There is no text to translate.')
  const parts: string[] = []
  let from: string | null = null
  for (const chunk of chunks) {
    const answer = await call('/translate', JSON.stringify(translateBody(req, chunk)))
    if (typeof answer.translated_text !== 'string') throw new Error('Sarvam sent no translation.')
    parts.push(answer.translated_text)
    if (from === null && typeof answer.source_language_code === 'string') from = answer.source_language_code
  }
  const text = parts.join(' ')
  const costInr = translateCost(chars)
  await update<Record<string, { text: string; from: string | null }>>('translate.json', {}, (map) => {
    map[key] = { text, from }
  })
  await addUsage('translate', chars, costInr)
  return { text, from, cached: false, chars, costInr }
}

// ---- Speech to text ----

type SttCached = Omit<SttResult, 'cached' | 'costInr'>

async function stt(req: SttRequest): Promise<SttResult> {
  const seconds = wavSeconds(req.wav)
  if (seconds === null) throw new Error('Speech to text needs a WAV file.')
  if (seconds > STT_MAX_SECONDS + 0.5) throw new Error(`Speech to text takes ${STT_MAX_SECONDS} seconds at most; this is ${Math.round(seconds)}.`)
  const language = req.language && req.language !== 'unknown' ? (languageCode(req.language) ?? req.language) : 'unknown'
  const model = req.model ?? 'saaras:v4'
  // Verbatim keeps fillers and false starts (what footage cutting needs); the cache key
  // leaves the default mode out so earlier entries still hit.
  const mode = req.mode && req.mode !== 'transcribe' ? req.mode : undefined
  const key = sha(req.wav, stableKey({ language, model, ...(mode ? { mode } : {}) }))
  const cache = await readJson<Record<string, SttCached>>('stt.json', {})
  const hit = cache[key]
  if (hit) return { ...hit, cached: true, costInr: 0 }
  const form = new FormData()
  form.append('file', new Blob([req.wav as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }), 'speech.wav')
  form.append('model', model)
  form.append('language_code', language)
  form.append('with_timestamps', 'true')
  if (mode) form.append('mode', mode)
  const answer = await call('/speech-to-text', form)
  const transcript = typeof answer.transcript === 'string' ? answer.transcript : ''
  const stamps = answer.timestamps as { words?: unknown; start_time_seconds?: unknown; end_time_seconds?: unknown } | null | undefined
  const words = Array.isArray(stamps?.words) ? (stamps.words as unknown[]) : []
  const starts = Array.isArray(stamps?.start_time_seconds) ? (stamps.start_time_seconds as unknown[]) : []
  const ends = Array.isArray(stamps?.end_time_seconds) ? (stamps.end_time_seconds as unknown[]) : []
  let segments = words.flatMap((text, i) => {
    const start = starts[i]
    const end = ends[i]
    return typeof text === 'string' && typeof start === 'number' && typeof end === 'number'
      ? [{ text, startMs: Math.round(start * 1000), endMs: Math.round(end * 1000) }]
      : []
  })
  if (segments.length === 0) segments = [{ text: transcript, startMs: 0, endMs: Math.round(seconds * 1000) }]
  const result: SttCached = {
    transcript,
    language: typeof answer.language_code === 'string' ? answer.language_code : null,
    segments,
    seconds: round2(seconds),
  }
  const costInr = sttCost(seconds)
  await update<Record<string, SttCached>>('stt.json', {}, (map) => {
    map[key] = result
  })
  await addUsage('stt', seconds, costInr)
  return { ...result, cached: false, costInr }
}

// ---- Argument checks: everything from the renderer is unknown until here ----

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const optString = (v: unknown, name: string): string | undefined => {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new Error(`${name} must be text.`)
  return v
}
const optNumber = (v: unknown, name: string): number | undefined => {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name} must be a number.`)
  return v
}

function parseTts(v: unknown): TtsRequest {
  if (!isObject(v)) throw new Error('A voice request is needed.')
  if (typeof v.text !== 'string') throw new Error('text must be text.')
  if (typeof v.language !== 'string') throw new Error('language must be text.')
  const model = optString(v.model, 'model')
  if (model !== undefined && !(TTS_MODELS as readonly string[]).includes(model)) throw new Error(`Unknown voice model "${model}".`)
  return {
    text: v.text,
    language: v.language,
    speaker: optString(v.speaker, 'speaker'),
    model: model as TtsRequest['model'],
    pace: optNumber(v.pace, 'pace'),
    temperature: optNumber(v.temperature, 'temperature'),
    sampleRate: optNumber(v.sampleRate, 'sampleRate'),
    ...(v.reference instanceof Uint8Array && v.reference.byteLength <= MAX_WAV_BYTES ? { reference: v.reference } : {}),
  }
}

function parseTranslate(v: unknown): TranslateRequest {
  if (!isObject(v)) throw new Error('A translation request is needed.')
  if (typeof v.text !== 'string') throw new Error('text must be text.')
  if (typeof v.to !== 'string') throw new Error('to must be text.')
  const mode = optString(v.mode, 'mode')
  if (mode !== undefined && !(TRANSLATE_MODES as readonly string[]).includes(mode)) throw new Error(`Unknown translation mode "${mode}".`)
  const gender = optString(v.speakerGender, 'speakerGender')
  if (gender !== undefined && gender !== 'Male' && gender !== 'Female') throw new Error('speakerGender must be Male or Female.')
  return {
    text: v.text,
    to: v.to,
    from: optString(v.from, 'from'),
    mode: mode as TranslateRequest['mode'],
    speakerGender: gender as TranslateRequest['speakerGender'],
  }
}

function parseStt(v: unknown): SttRequest {
  if (!isObject(v)) throw new Error('A speech request is needed.')
  const wav = v.wav
  if (!(wav instanceof Uint8Array)) throw new Error('wav must be the bytes of a WAV file.')
  if (wav.byteLength > MAX_WAV_BYTES) throw new Error('That sound file is too large.')
  const mode = optString(v.mode, 'mode')
  if (mode !== undefined && !(STT_MODES as readonly string[]).includes(mode)) throw new Error(`Unknown speech to text mode "${mode}".`)
  return { wav, language: optString(v.language, 'language'), model: optString(v.model, 'model'), ...(mode ? { mode: mode as SttRequest['mode'] } : {}) }
}

export function handleSarvam(): void {
  ipcMain.handle('sarvam:status', () => status())
  ipcMain.handle('sarvam:set-key', (_event, key: unknown) => setKey(key))
  ipcMain.handle('sarvam:usage', () => readJson<SarvamUsage>('usage.json', emptyUsage()))
  ipcMain.handle('sarvam:tts', (_event, req: unknown) => tts(parseTts(req)))
  ipcMain.handle('sarvam:translate', (_event, req: unknown) => translate(parseTranslate(req)))
  ipcMain.handle('sarvam:stt', (_event, req: unknown) => stt(parseStt(req)))
}
