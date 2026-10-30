// Word timing inside one text-to-speech take. A TTS engine returns audio only, so we
// know the words and the sound and look for when each word is said: find where the
// voice is, find the pauses inside it, and give each word a share of the time in
// proportion to how long it takes to say. Pauses pin the word boundaries they fall
// on; the other boundaries snap to the quietest nearby moment. Latin and Indic
// scripts, deterministic, no DOM or Node types.

/** Where the voice is in a take, ms. */
export interface SpeechSpan {
  startMs: number
  endMs: number
}

/** One word and when it is said, ms from the start of the take. */
export interface AlignedWord {
  text: string
  startMs: number
  endMs: number
}

/** Length of one level frame, ms. */
const FRAME_MS = 10
/** Level of a silent frame, dBFS (also the floor of every level). */
const SILENCE_DB = -120
/** Frames at or below this level are not voice, dBFS RMS. */
const DEFAULT_THRESHOLD_DB = -45
/** A pause is quieter than this many dB under the loudest frame of the voice. */
const PAUSE_BELOW_PEAK_DB = 30
/** A pause lasts at least this many frames (60 ms). */
const PAUSE_MIN_FRAMES = 6
/** A free word boundary moves at most this far to find a quiet frame, ms. */
const SNAP_MS = 60
/** How far (ms) a pause may sit from a boundary's ideal time and still be given to it: at least this, */
const MIN_REACH_MS = 150
/** or this share of an average word; twice as far for a pause this long (ms) or longer. */
const REACH_OF_WORD = 0.6
const LONG_PAUSE_MS = 150
/** Levels within this many dB of the quietest count as equally quiet, so the nearest one wins. */
const SNAP_TIE_DB = 0.25
/** No word is shorter than this, ms. */
const MIN_WORD_MS = 40
/** A boundary after punctuation counts this much of its real distance to a pause. */
const PUNCTUATION_PULL = 0.6
/** A word that is only punctuation still takes this much of the time, in syllables. */
const MIN_ALIGN_WEIGHT = 0.5

/** A word whose last letter is followed by a mark that ends a phrase (closing quotes and brackets are looked through). */
const PHRASE_END = /[,.!?;:।॥—…]["'”’»)\]]*$/u

let graphemes: Intl.Segmenter | null = null

/** RMS level of each 10 ms frame in dBFS (the last frame may be shorter), and the frame length in ms. */
function frameLevels(samples: Float32Array, sampleRate: number): { db: Float64Array; frameMs: number } {
  const size = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000))
  const count = Math.ceil(samples.length / size)
  const db = new Float64Array(count)
  for (let f = 0; f < count; f++) {
    const from = f * size
    const to = Math.min(samples.length, from + size)
    let sum = 0
    for (let i = from; i < to; i++) sum += samples[i]! * samples[i]!
    const rms = Math.sqrt(sum / (to - from))
    db[f] = rms <= 1e-6 ? SILENCE_DB : Math.max(SILENCE_DB, 20 * Math.log10(rms))
  }
  return { db, frameMs: (size * 1000) / sampleRate }
}

/** Where the voice is in a take: the first and last 10 ms frame louder than the threshold (default −45 dBFS RMS), or null for silence. */
export function speechSpan(samples: Float32Array, sampleRate: number, options: { thresholdDb?: number } = {}): SpeechSpan | null {
  const threshold = options.thresholdDb ?? DEFAULT_THRESHOLD_DB
  const { db, frameMs } = frameLevels(samples, sampleRate)
  let first = -1
  let last = -1
  for (let f = 0; f < db.length; f++) {
    if (db[f]! > threshold) {
      if (first < 0) first = f
      last = f
    }
  }
  if (first < 0) return null
  const durationMs = (samples.length * 1000) / sampleRate
  return { startMs: Math.round(first * frameMs), endMs: Math.round(Math.min(durationMs, (last + 1) * frameMs)) }
}

/** The syllables of the Latin letters in a word: vowel groups (accents ignored), at least 1 when the word has any Latin letter. */
function latinSyllables(word: string): number {
  const runs = word.match(/\p{Script=Latin}+/gu)
  if (!runs) return 0
  let groups = 0
  for (const run of runs) {
    const plain = run
      .normalize('NFD')
      .replace(/\p{M}+/gu, '')
      .toLowerCase()
    groups += plain.match(/[aeiouyæœø]+/g)?.length ?? 0
  }
  return Math.max(1, groups)
}

/**
 * How long a word takes to say, in rough syllables (≥ 1). Latin letters count
 * vowel groups (a e i o u y, accented letters included). Every other script
 * counts the grapheme clusters that hold a letter: an Indic syllable is one
 * cluster ("नमस्ते" is न|म|स्ते, 3). Each digit is one. Punctuation alone is 0.
 */
export function wordWeight(word: string): number {
  const text = word.normalize('NFC')
  let total = latinSyllables(text)
  const rest = text.replace(/\p{Script=Latin}+/gu, '')
  graphemes ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  for (const { segment } of graphemes.segment(rest)) {
    if (/[\p{L}\p{N}]/u.test(segment)) total++
  }
  if (total === 0 && /[\p{L}\p{N}]/u.test(text)) total = 1
  return total
}

/** Splits text into words on whitespace (punctuation stays attached to its word). */
export function splitWords(text: string): string[] {
  return text.split(/\s+/u).filter((word) => word.length > 0)
}

interface Pause {
  startMs: number
  endMs: number
}

/** One pause that sits on a word boundary: boundary k lies between word k − 1 and word k. */
interface Anchor {
  boundary: number
  pause: Pause
}

/** Runs of frames inside the span quieter than max(threshold, peak − 30 dB) lasting at least 60 ms; runs that touch the span's edge are not pauses. */
function findPauses(db: Float64Array, frameMs: number, span: SpeechSpan, thresholdDb: number): Pause[] {
  const first = Math.max(0, Math.floor(span.startMs / frameMs + 1e-9))
  const end = Math.min(db.length, Math.ceil(span.endMs / frameMs - 1e-9))
  let peak = Number.NEGATIVE_INFINITY
  for (let f = first; f < end; f++) peak = Math.max(peak, db[f]!)
  const limit = Math.max(thresholdDb, peak - PAUSE_BELOW_PEAK_DB)
  const pauses: Pause[] = []
  let runFrom = -1
  for (let f = first; f <= end; f++) {
    const quiet = f < end && db[f]! < limit
    if (quiet) {
      if (runFrom < 0) runFrom = f
      continue
    }
    if (runFrom >= 0 && f - runFrom >= PAUSE_MIN_FRAMES) {
      const pause = { startMs: runFrom * frameMs, endMs: f * frameMs }
      if (pause.startMs > span.startMs + 1e-6 && pause.endMs < span.endMs - 1e-6) pauses.push(pause)
    }
    runFrom = -1
  }
  return pauses
}

/** Whether every stretch between the span edges and the anchored pauses is long enough for the words in it. */
function roomForWords(anchors: readonly Anchor[], wordCount: number, span: SpeechSpan): boolean {
  let fromWord = 0
  let fromMs = span.startMs
  for (const anchor of anchors) {
    if (anchor.pause.startMs - fromMs < MIN_WORD_MS * (anchor.boundary - fromWord)) return false
    fromWord = anchor.boundary
    fromMs = anchor.pause.endMs
  }
  return span.endMs - fromMs >= MIN_WORD_MS * (wordCount - fromWord)
}

/**
 * Gives pauses to word boundaries, longest pause first. A pause takes the nearest
 * boundary (by its ideal time) that keeps order: boundaries grow with time. A boundary
 * after a phrase-ending mark counts as 40 % nearer. A pause with no such boundary, or
 * one that leaves too little room for the words around it, is skipped.
 */
function anchorPauses(pauses: readonly Pause[], ideal: readonly number[], phraseEnd: readonly boolean[], span: SpeechSpan): Anchor[] {
  const wordCount = ideal.length - 1
  const order = [...pauses].sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs) || a.startMs - b.startMs)
  let anchors: Anchor[] = []
  for (const pause of order) {
    if (anchors.length >= wordCount - 1) break
    let lo = 0
    let hi = wordCount
    for (const other of anchors) {
      if (other.pause.startMs < pause.startMs) lo = Math.max(lo, other.boundary)
      else hi = Math.min(hi, other.boundary)
    }
    const centre = (pause.startMs + pause.endMs) / 2
    // A short gap far from any boundary is a stop consonant inside a word (the k of "music"), not a pause between words.
    const reach = Math.max(MIN_REACH_MS, REACH_OF_WORD * ((span.endMs - span.startMs) / wordCount)) * (pause.endMs - pause.startMs >= LONG_PAUSE_MS ? 2 : 1)
    const candidates: { boundary: number; score: number }[] = []
    for (let k = lo + 1; k < hi; k++) {
      const score = Math.abs(ideal[k]! - centre) * (phraseEnd[k - 1]! ? PUNCTUATION_PULL : 1)
      if (score <= reach) candidates.push({ boundary: k, score })
    }
    candidates.sort((a, b) => a.score - b.score || a.boundary - b.boundary)
    for (const { boundary } of candidates) {
      const next = [...anchors, { boundary, pause }].sort((a, b) => a.boundary - b.boundary)
      if (roomForWords(next, wordCount, span)) {
        anchors = next
        break
      }
    }
  }
  return anchors
}

/** The centre of the quietest frame within ±60 ms of `at` that lies in [lo, hi]; the nearest of equally quiet ones. */
function snapToQuiet(db: Float64Array, frameMs: number, at: number, lo: number, hi: number): number {
  const target = Math.min(hi, Math.max(lo, at))
  const from = Math.max(lo, target - SNAP_MS)
  const to = Math.min(hi, target + SNAP_MS)
  const firstFrame = Math.max(0, Math.ceil(from / frameMs - 0.5))
  const lastFrame = Math.min(db.length - 1, Math.floor(to / frameMs - 0.5))
  let quietest = Number.POSITIVE_INFINITY
  for (let f = firstFrame; f <= lastFrame; f++) quietest = Math.min(quietest, db[f]!)
  if (quietest === Number.POSITIVE_INFINITY) return target
  let best = target
  let bestDistance = Number.POSITIVE_INFINITY
  for (let f = firstFrame; f <= lastFrame; f++) {
    if (db[f]! > quietest + SNAP_TIE_DB) continue
    const centre = (f + 0.5) * frameMs
    const distance = Math.abs(centre - target)
    if (distance < bestDistance) {
      best = centre
      bestDistance = distance
    }
  }
  return best
}

/** Times each word inside the take. */
export function alignWords(
  samples: Float32Array,
  sampleRate: number,
  words: readonly string[],
  options: { span?: SpeechSpan; thresholdDb?: number } = {},
): AlignedWord[] {
  const count = words.length
  if (count === 0) return []
  const thresholdDb = options.thresholdDb ?? DEFAULT_THRESHOLD_DB
  const { db, frameMs } = frameLevels(samples, sampleRate)
  const span = options.span ?? speechSpan(samples, sampleRate, { thresholdDb })
  const result = (left: readonly number[], right: readonly number[]): AlignedWord[] =>
    words.map((text, i) => ({ text, startMs: Math.round(left[i]!), endMs: Math.round(right[i]!) }))

  // No voice found: spread the words evenly over the whole file
  if (!span) {
    const total = (samples.length * 1000) / sampleRate
    return result(
      words.map((_, i) => (total * i) / count),
      words.map((_, i) => (total * (i + 1)) / count),
    )
  }

  const length = span.endMs - span.startMs
  const weights = words.map((word) => Math.max(MIN_ALIGN_WEIGHT, wordWeight(word)))
  const left: number[] = new Array(count).fill(span.startMs)
  const right: number[] = new Array(count).fill(span.endMs)
  if (count === 1) return result(left, right)

  // Ideal boundaries: boundary k (between word k − 1 and word k) after its share of the weight
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
  const ideal: number[] = [span.startMs]
  let cumulative = 0
  for (let k = 1; k < count; k++) {
    cumulative += weights[k - 1]!
    ideal.push(span.startMs + (length * cumulative) / totalWeight)
  }
  ideal.push(span.endMs)

  const phraseEnd = words.map((word) => PHRASE_END.test(word))
  const anchors = anchorPauses(findPauses(db, frameMs, span, thresholdDb), ideal, phraseEnd, span)

  // Stretches between the span edges and the anchored pauses, each with the words in it
  interface Segment {
    from: number
    to: number
    startMs: number
    endMs: number
  }
  const segments: Segment[] = []
  let from = 0
  let fromMs = span.startMs
  for (const anchor of anchors) {
    segments.push({ from, to: anchor.boundary, startMs: fromMs, endMs: anchor.pause.startMs })
    from = anchor.boundary
    fromMs = anchor.pause.endMs
  }
  segments.push({ from, to: count, startMs: fromMs, endMs: span.endMs })

  for (const segment of segments) {
    const n = segment.to - segment.from
    left[segment.from] = segment.startMs
    right[segment.to - 1] = segment.endMs
    if (n === 1) continue
    const segmentLength = segment.endMs - segment.startMs
    let segmentWeight = 0
    for (let i = segment.from; i < segment.to; i++) segmentWeight += weights[i]!
    // Too short to give every word its minimum: share it out evenly
    const crowded = segmentLength < MIN_WORD_MS * n
    let shared = 0
    let previous = segment.startMs
    for (let j = segment.from + 1; j < segment.to; j++) {
      shared += weights[j - 1]!
      let boundary: number
      if (crowded) {
        boundary = segment.startMs + (segmentLength * (j - segment.from)) / n
      } else {
        const wanted = segment.startMs + (segmentLength * shared) / segmentWeight
        boundary = snapToQuiet(db, frameMs, wanted, previous + MIN_WORD_MS, segment.endMs - MIN_WORD_MS * (segment.to - j))
      }
      right[j - 1] = boundary
      left[j] = boundary
      previous = boundary
    }
  }
  return result(left, right)
}
