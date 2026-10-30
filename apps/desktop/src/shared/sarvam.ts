import type { GrantedFile } from './media'

// Sarvam AI (Indian-language speech and translation): what main and renderer
// exchange about it, plus the pure helpers (language names, request bodies,
// prices, error texts). Plain TypeScript only: no Node, DOM or Electron APIs.

export interface SarvamLanguage {
  code: string
  name: string
  native: string
  script: string
}

export const SARVAM_LANGUAGES: readonly SarvamLanguage[] = [
  { code: 'hi-IN', name: 'Hindi', native: 'हिन्दी', script: 'Devanagari' },
  { code: 'bn-IN', name: 'Bengali', native: 'বাংলা', script: 'Bengali' },
  { code: 'ta-IN', name: 'Tamil', native: 'தமிழ்', script: 'Tamil' },
  { code: 'te-IN', name: 'Telugu', native: 'తెలుగు', script: 'Telugu' },
  { code: 'kn-IN', name: 'Kannada', native: 'ಕನ್ನಡ', script: 'Kannada' },
  { code: 'ml-IN', name: 'Malayalam', native: 'മലയാളം', script: 'Malayalam' },
  { code: 'mr-IN', name: 'Marathi', native: 'मराठी', script: 'Devanagari' },
  { code: 'gu-IN', name: 'Gujarati', native: 'ગુજરાતી', script: 'Gujarati' },
  { code: 'pa-IN', name: 'Punjabi', native: 'ਪੰਜਾਬੀ', script: 'Gurmukhi' },
  { code: 'od-IN', name: 'Odia', native: 'ଓଡ଼ିଆ', script: 'Oriya' },
  { code: 'en-IN', name: 'English (India)', native: 'English', script: 'Latin' },
]

// Every spelling a language goes by, lower case: the code, its short form,
// the English and native names, and Odia's old names.
const LANGUAGE_LOOKUP: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>()
  for (const lang of SARVAM_LANGUAGES) {
    const lower = lang.code.toLowerCase()
    map.set(lower, lang.code)
    map.set(lower.split('-')[0]!, lang.code)
    map.set(lang.name.toLowerCase(), lang.code)
    map.set(lang.native.normalize('NFC').toLowerCase(), lang.code)
  }
  map.set('english', 'en-IN')
  map.set('or', 'od-IN')
  map.set('or-in', 'od-IN')
  map.set('oriya', 'od-IN')
  return map
})()

/** Sarvam's code for a language given as a code, short code or name, in any case; null when unknown. */
export function languageCode(input: string): string | null {
  return LANGUAGE_LOOKUP.get(input.trim().normalize('NFC').toLowerCase()) ?? null
}

export interface SarvamSpeaker {
  id: string
  gender: 'male' | 'female' | null
}

// Gender only where Sarvam's docs state it.
const MALE = new Set(['shubh', 'aditya', 'rahul', 'rohan', 'amit', 'dev', 'varun'])
const FEMALE = new Set(['ritu', 'priya', 'neha', 'pooja', 'simran', 'kavya', 'ishita'])

export const BULBUL_V3_SPEAKERS: readonly SarvamSpeaker[] = [
  'shubh', 'aditya', 'ritu', 'priya', 'neha', 'rahul', 'pooja', 'rohan', 'simran', 'kavya',
  'amit', 'dev', 'ishita', 'shreya', 'ratan', 'varun', 'manan', 'sumit', 'roopa', 'kabir',
  'aayan', 'ashutosh', 'advait', 'anand', 'tanya', 'tarun', 'sunny', 'mani', 'gokul', 'vijay',
  'shruti', 'suhani', 'mohit', 'kavitha', 'rehan', 'soham', 'rupali',
].map((id) => ({ id, gender: MALE.has(id) ? 'male' : FEMALE.has(id) ? 'female' : null }))

export const DEFAULT_SPEAKER = 'shubh'
export const TTS_MODELS = ['bulbul:v3', 'bulbul:v4-flash'] as const
export type TtsModel = (typeof TTS_MODELS)[number]

export const TTS_SAMPLE_RATES = [8000, 16000, 22050, 24000, 32000, 44100, 48000] as const
export const TTS_MAX_CHARS = 2500
export const TRANSLATE_MAX_CHARS = 2000
export const TRANSLATE_MODES = ['formal', 'modern-colloquial', 'classic-colloquial', 'code-mixed'] as const
export const STT_MAX_SECONDS = 30

/** Prices in rupees (INR). */
export const SARVAM_PRICES = {
  ttsPer1000Chars: { 'bulbul:v3': 3, 'bulbul:v4-flash': 1 } as Record<TtsModel, number>,
  translatePer1000Chars: 2,
  sttPerMinute: 0.49,
  dubPerMinutePerLanguage: 40,
}

const rupees = (value: number) => Math.round(value * 100) / 100

export function ttsCost(chars: number, model: TtsModel = 'bulbul:v3'): number {
  return rupees((chars / 1000) * (SARVAM_PRICES.ttsPer1000Chars[model] ?? SARVAM_PRICES.ttsPer1000Chars['bulbul:v3']))
}

export function translateCost(chars: number): number {
  return rupees((chars / 1000) * SARVAM_PRICES.translatePer1000Chars)
}

export function sttCost(seconds: number): number {
  return rupees((seconds / 60) * SARVAM_PRICES.sttPerMinute)
}

/** Sarvam's own dubbing, for comparison: per source minute, for each language (a count or a list). */
export function dubCost(seconds: number, languages: number | readonly string[]): number {
  const count = typeof languages === 'number' ? languages : languages.length
  return rupees((seconds / 60) * SARVAM_PRICES.dubPerMinutePerLanguage * count)
}

export interface TtsRequest {
  text: string
  language: string
  speaker?: string
  model?: TtsModel
  /** Speed, 0.5 to 2. */
  pace?: number
  /** Variation, 0.01 to 1. */
  temperature?: number
  sampleRate?: number
}

export interface TtsResult {
  file: GrantedFile
  cached: boolean
  chars: number
  costInr: number
  requestId: string | null
}

export interface TranslateRequest {
  text: string
  to: string
  from?: string
  mode?: (typeof TRANSLATE_MODES)[number]
  speakerGender?: 'Male' | 'Female'
}

export interface TranslateResult {
  text: string
  from: string | null
  cached: boolean
  chars: number
  costInr: number
}

export interface SttRequest {
  /** A WAV file, 30 seconds at most. */
  wav: Uint8Array
  language?: string
  model?: string
}

export interface SttSegment {
  text: string
  startMs: number
  endMs: number
}

export interface SttResult {
  transcript: string
  language: string | null
  segments: SttSegment[]
  cached: boolean
  seconds: number
  costInr: number
}

export interface SarvamUsage {
  tts: { chars: number; costInr: number }
  translate: { chars: number; costInr: number }
  stt: { seconds: number; costInr: number }
  totalInr: number
  /** The day counting began (ISO date). */
  since: string
}

export interface SarvamStatus {
  hasKey: boolean
  source: 'settings' | 'environment' | null
  /** The key's last characters, for showing which one is in use. Never the key. */
  hint: string | null
}

export const NO_KEY_MESSAGE = 'No Sarvam API key. Set it in the Voice tab or the SARVAM_API_KEY environment variable.'

/** The JSON body for a text-to-speech call. Throws on text or numbers Sarvam would refuse. */
export function ttsBody(req: TtsRequest): Record<string, unknown> {
  const text = req.text
  if (typeof text !== 'string' || text.trim() === '') throw new Error('There is no text to speak.')
  if (text.length > TTS_MAX_CHARS) throw new Error(`Sarvam speaks at most ${TTS_MAX_CHARS} characters at a time; this text has ${text.length}.`)
  const language = languageCode(req.language)
  if (!language) throw new Error(`Unknown language "${req.language}".`)
  if (req.pace !== undefined && !(req.pace >= 0.5 && req.pace <= 2)) throw new Error('Pace must be between 0.5 and 2.')
  if (req.temperature !== undefined && !(req.temperature >= 0.01 && req.temperature <= 1)) {
    throw new Error('Temperature must be between 0.01 and 1.')
  }
  const sampleRate = req.sampleRate ?? 48000
  if (!(TTS_SAMPLE_RATES as readonly number[]).includes(sampleRate)) {
    throw new Error(`Sample rate must be one of ${TTS_SAMPLE_RATES.join(', ')}.`)
  }
  const body: Record<string, unknown> = {
    text,
    language_code: language,
    speaker: req.speaker ?? DEFAULT_SPEAKER,
    model: req.model ?? 'bulbul:v3',
    speech_sample_rate: sampleRate,
  }
  if (req.pace !== undefined) body.pace = req.pace
  if (req.temperature !== undefined) body.temperature = req.temperature
  return body
}

/** The JSON body for translating one chunk of a text. */
export function translateBody(req: TranslateRequest, chunk: string): Record<string, unknown> {
  const target = languageCode(req.to)
  if (!target) throw new Error(`Unknown language "${req.to}".`)
  const from = req.from === undefined || req.from === '' || req.from.toLowerCase() === 'auto' ? 'auto' : languageCode(req.from)
  if (!from) throw new Error(`Unknown language "${req.from}".`)
  const body: Record<string, unknown> = {
    input: chunk,
    source_language_code: from,
    target_language_code: target,
    // Sarvam Translate takes the formal register only; the spoken registers need Mayura (same languages, 1,000 characters a call).
    model: req.mode !== undefined && req.mode !== 'formal' ? 'mayura:v1' : 'sarvam-translate:v1',
  }
  if (req.mode !== undefined) body.mode = req.mode
  if (req.speakerGender !== undefined) body.speaker_gender = req.speakerGender
  return body
}

/**
 * Cuts a text into pieces of at most `max` characters, at sentence ends (. ! ?
 * and the Hindi danda), else at spaces; a word is cut only when it alone is
 * longer than `max`. Rejoin the pieces with a space.
 */
export function splitForTranslate(text: string, max = TRANSLATE_MAX_CHARS): string[] {
  const sentences = text.trim().split(/(?<=[.!?।])\s+/).filter((s) => s !== '')
  const chunks: string[] = []
  let current = ''
  const push = (piece: string) => {
    if (current === '') current = piece
    else if (current.length + 1 + piece.length <= max) current += ' ' + piece
    else {
      chunks.push(current)
      current = piece
    }
  }
  for (const sentence of sentences) {
    if (sentence.length <= max) {
      push(sentence)
      continue
    }
    // Too long for one chunk: pack its words, and cut a single word only as a last resort.
    for (const word of sentence.split(/\s+/)) {
      if (word.length <= max) push(word)
      else {
        for (let i = 0; i < word.length; i += max) push(word.slice(i, i + max))
      }
    }
  }
  if (current !== '') chunks.push(current)
  return chunks
}

/** A readable error for a failed Sarvam call, from its status and parsed body. */
export function sarvamErrorMessage(status: number, body: unknown): string {
  if (status === 401 || status === 403) return 'Sarvam rejected the API key. Set it in the Voice tab or the SARVAM_API_KEY environment variable.'
  if (status === 402) return 'Your Sarvam credits are used up. Top up at https://dashboard.sarvam.ai, then try again.'
  if (status === 429) return 'Sarvam is limiting requests right now. Wait a moment and try again.'
  const error = (body as { error?: { message?: unknown } } | null | undefined)?.error
  const message = typeof error?.message === 'string' && error.message !== '' ? error.message : null
  return message ? `Sarvam answered ${status}: ${message}` : `Sarvam answered ${status}.`
}

/** JSON with object keys in sorted order, so equal requests give equal text (for cache keys). */
export function stableKey(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  )
}

/** Which key is in use, without showing it. */
export function keyHint(key: string): string {
  return 'sk_…' + key.slice(-3)
}

/** A WAV file's length in seconds (data size over byte rate), read from its header; null when it is not a readable WAV. */
export function wavSeconds(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 44) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (at: number) => String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!)
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null
  let byteRate = 0
  let pos = 12
  while (pos + 8 <= bytes.byteLength) {
    const id = tag(pos)
    const size = view.getUint32(pos + 4, true)
    if (id === 'fmt ' && pos + 20 <= bytes.byteLength) byteRate = view.getUint32(pos + 16, true)
    if (id === 'data') {
      // A streamed file may say 0 or 0xFFFFFFFF: the rest of the file is the sound.
      const available = bytes.byteLength - (pos + 8)
      const dataSize = size === 0 || size > available ? available : size
      return byteRate > 0 ? dataSize / byteRate : null
    }
    pos += 8 + size + (size % 2)
  }
  return null
}
