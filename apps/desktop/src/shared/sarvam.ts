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
/** Bulbul v4 Flash speakers (name_language_style), as Sarvam's API listed them on 2026-10-30. enhi speaks Hinglish. */
export const BULBUL_V4_FLASH_SPEAKERS: readonly string[] = [
  'aayan_hi_conversational', 'amit_hi_conversational', 'ashutosh_hi_conversational', 'kabir_hi_conversational', 'kavya_hi_conversational', 'manan_hi_conversational',
  'rahul_hi_conversational', 'sumit_hi_conversational', 'kangkana_as_conversational', 'mouchumi_as_conversational', 'arnab_bn_conversation', 'roopa_bn_conversational',
  'aditi_en_stories', 'aparna_en_companion', 'aparna_en_edtech', 'ashwin_en_sports', 'ashwin_en_sports_energetic', 'chandrika_en_stories',
  'dev_en_recovery', 'dev_en_conversational', 'deven_en_conversation', 'ishita_en_customer', 'ishita_en_medical', 'ishita_en_numbers',
  'ishita_en_social', 'ishita_en_stories', 'kalpit_en_edtech', 'nachiket_en_ads', 'neha_en_customer', 'neha_en_latenight',
  'nupur_en_kids', 'ojas_en_social', 'ritu_en_edtech', 'ritu_en_latenight', 'ritu_en_medical', 'ritu_en_reels',
  'rohan_en_recovery', 'roopa_en_conversational', 'rustom_en_suspense', 'sanchita_en_companion', 'sanchita_en_insurance', 'sanchita_en_recovery',
  'sanchita_en_market', 'sanchita_en_social', 'shabana_en_edtech', 'shalini_en_companion', 'shalini_en_customer', 'shubh_en_narration',
  'shubh_en_numbers', 'shubh_en_ads', 'shubh_en_recovery', 'shubh_en_audiobook', 'shubh_en_narration_gentle', 'shubh_en_sports',
  'simran_en_narration', 'simran_en_automobile', 'simran_en_conversation', 'simran_en_customer', 'simran_en_edtech', 'simran_en_edtech_bot',
  'simran_en_sales', 'simran_en_recovery', 'simran_en_ads', 'simran_en_therapist', 'sunny_en_social', 'varun_en_ads',
  'varun_en_suspense', 'zarina_en_conversation', 'ishita_enhi_companion', 'ishita_enhi_customer', 'ishita_enhi_customer_expressive', 'sanchita_enhi_companion',
  'shalini_enhi_companion', 'shalini_enhi_customer', 'shubh_enhi_companion', 'shubh_enhi_ads', 'shubh_enhi_banking', 'simran_enhi_companion',
  'simran_enhi_customer', 'simran_enhi_banking_expressive', 'sunny_enhi_customer', 'bhavik_gu_conversation', 'pooja_gu_conversational', 'pooja_gu_customer',
  'aditya_hi_conversational', 'aditya_hi_sales', 'anand_hi_documentary', 'anand_hi_news', 'aparna_hi_customer', 'aparna_hi_kyc',
  'ashok_hi_character', 'ashok_hi_news', 'chhavi_hi_kids', 'ishita_hi_ads', 'ishita_hi_edtech', 'ishita_hi_banking',
  'ishita_hi_ads_informal', 'ishita_hi_devotional', 'ishita_hi_numbers', 'ishita_hi_social', 'kunal_hi_kids', 'mahesh_hi_documentary',
  'mani_hi_devotional', 'mani_hi_conversational', 'mohit_hi_conversational', 'nachiket_hi_devotional', 'priya_hi_recovery', 'ratan_hi_latenight',
  'ratan_hi_customer_expressive', 'ratan_hi_documentary', 'ratan_hi_devotional', 'ratan_hi_recovery', 'ratan_hi_social', 'ratan_hi_sports',
  'ratan_hi_latenight_warm', 'rehan_hi_social', 'ritu_hi_customer_utility', 'ritu_hi_kids', 'ritu_hi_conversation', 'ritu_hi_customer',
  'ritu_hi_edtech', 'ritu_hi_ads_formal', 'ritu_hi_banking', 'ritu_hi_ads_informal', 'ritu_hi_insurance', 'ritu_hi_edtech_bot',
  'ritu_hi_medical', 'ritu_hi_sales', 'ritu_hi_reels', 'ritu_hi_social', 'ritu_hi_customer_warm', 'ritu_hi_social_lively',
  'roopa_hi_companion', 'roopa_hi_narration', 'roopa_hi_recovery', 'roopa_hi_market', 'roopa_hi_conversational', 'sanchita_hi_assistant',
  'sanchita_hi_edtech', 'sanchita_hi_banking', 'sanchita_hi_feedback', 'sanchita_hi_ads_formal', 'sanchita_hi_ads_informal', 'sanchita_hi_interview',
  'sanchita_hi_romantic', 'sanchita_hi_market', 'sanchita_hi_social', 'sanchita_hi_kyc', 'sarika_hi_conversation', 'shalini_hi_companion',
  'shalini_hi_social', 'shreya_hi_conversational', 'shreya_hi_news', 'shruti_hi_edtech', 'shubh_hi_customer', 'shubh_hi_ecomm',
  'shubh_hi_stories_mixed', 'shubh_hi_devotional', 'shubh_hi_ads', 'shubh_hi_recovery', 'shubh_hi_stories_dramatic', 'simran_hi_assistant',
  'simran_hi_narration', 'simran_hi_automobile', 'simran_hi_conversation', 'simran_hi_news_breaking', 'simran_hi_social_energetic', 'simran_hi_social_excited',
  'simran_hi_latenight', 'simran_hi_news', 'simran_hi_recovery', 'simran_hi_sales', 'suchitra_hi_ecomm', 'suhani_hi_social',
  'sunny_hi_ads', 'sunny_hi_reels', 'tarun_hi_conversational', 'tarun_hi_sales', 'chaitra_hi_customer', 'shilpa_hi_narration',
  'tanya_hi_narration', 'chaitra_kn_conversation', 'chaitra_kn_narration', 'chetan_kn_conversation', 'suchitra_kn_narration', 'ishita_mr_conversational',
  'mrunal_mr_narration', 'neha_mr_narration', 'nilesh_mr_conversation', 'ritu_mr_insurance', 'ritu_mr_narration', 'rupali_mr_stories',
  'soham_mr_narration', 'anand_pa_conversation', 'anand_pa_customer', 'harpreet_pa_narration', 'jaspal_pa_banking', 'gokul_ta_narration',
  'aravind_ta_ads', 'aravind_ta_suspense', 'vijay_ta_narration', 'kavitha_te_conversation', 'kavitha_te_narration', 'pooja_te_conversation',
  'tarun_te_narration', 'amelia_en_conversational', 'sophia_en_conversational', 'bimal_bn_suspense', 'girish_en_documentary', 'girish_en_devotional',
  'payal_en_edtech', 'sarang_en_narration', 'aarti_hi_customer', 'advait_hi_character', 'aryaman_hi_ads', 'chirag_hi_social',
  'girish_hi_devotional', 'mukul_hi_ads', 'mukul_hi_suspense', 'suman_hi_companion', 'vaibhav_hi_social', 'vandana_hi_ecomm',
  'vipul_hi_social', 'mukul_mr_stories',
]

/** Styles to prefer for a narrator, best first. */
const V4_NARRATOR_STYLES = ['narration', 'documentary', 'stories', 'conversational', 'conversation', 'social']

/** A Bulbul v4 Flash speaker for a language: the given one when it is a v4 speaker, else a narrator of that language (Hinglish for hi-IN), else shubh_enhi_ads. */
export function v4SpeakerFor(language: string, speaker?: string): string {
  if (speaker && BULBUL_V4_FLASH_SPEAKERS.includes(speaker)) return speaker
  const lang = language.toLowerCase().split('-')[0] ?? 'hi'
  const own = BULBUL_V4_FLASH_SPEAKERS.filter((s) => s.split('_')[1] === lang)
  for (const style of V4_NARRATOR_STYLES) {
    const hit = own.find((s) => s.split('_').slice(2).join('_') === style)
    if (hit) return hit
  }
  return own[0] ?? 'shubh_enhi_ads'
}

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
  /** A WAV of the speaker's own voice (≤ 15 s): Sarvam's instant voice cloning speaks the text in that voice instead of a stock speaker. */
  reference?: Uint8Array
}

/** Instant voice cloning: text per request, the reference clip's length and rupees per 1,000 characters (beta, 2026-10). */
export const CLONE_LIMITS = { maxChars: 1000, maxReferenceSeconds: 15, per1000Chars: 2 } as const

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

/** Saaras modes: transcribe (clean text), verbatim (every filler and false start kept) or codemix (mixed speech such as Hinglish, each word in its own script). */
export const STT_MODES = ['transcribe', 'verbatim', 'codemix'] as const

export interface SttRequest {
  /** A WAV file, 30 seconds at most. */
  wav: Uint8Array
  language?: string
  model?: string
  mode?: (typeof STT_MODES)[number]
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
    // v3 speakers are not v4 Flash speakers: a v4 take gets a v4 voice of its language.
    speaker: req.model === 'bulbul:v4-flash' ? v4SpeakerFor(language, req.speaker) : (req.speaker ?? DEFAULT_SPEAKER),
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
