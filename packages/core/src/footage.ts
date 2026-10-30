// Understanding raw footage (a talking head) and planning cuts: loudness and a
// speech gate, shots, words and fillers, a tighten plan, search, b-roll
// placement. Pure, so every rule can be tested without media. Times in ms.

export type Span = { startMs: number; endMs: number }
export type Word = { text: string; startMs: number; endMs: number }
export const TIGHTNESS = ['generous', 'balanced', 'tight'] as const
export type Tightness = (typeof TIGHTNESS)[number]

const round = (n: number): number => Math.round(n)

// ---------------------------------------------------------------- loudness

/** RMS of each frame in dBFS, floor -100 (silence is -100). */
export function loudnessDb(samples: Float32Array, rate: number, frameMs = 20): Float32Array {
  const size = Math.max(1, Math.round((rate * frameMs) / 1000))
  const frames = Math.ceil(samples.length / size)
  const out = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    const from = f * size
    const to = Math.min(samples.length, from + size)
    let sum = 0
    for (let i = from; i < to; i++) {
      const s = samples[i] as number
      sum += s * s
    }
    const rms = Math.sqrt(sum / (to - from))
    out[f] = rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100
  }
  return out
}

function percentile(sorted: readonly number[], p: number): number {
  const pos = (sorted.length - 1) * p
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  const a = sorted[lo] as number
  const b = sorted[hi] as number
  return a + (b - a) * (pos - lo)
}

/**
 * Where speech starts being louder than the room: 60% of the way from the
 * quiet parts (10th percentile) to the loud ones (95th), kept in -60...-24 dB.
 * Refuses when the two are too close to tell apart.
 */
export function calibrateGate(
  db: ArrayLike<number>,
): { gateDb: number; troughDb: number; peakDb: number } | { refused: string; troughDb: number; peakDb: number } {
  const live: number[] = []
  for (let i = 0; i < db.length; i++) {
    const v = db[i] as number
    if (v > -99) live.push(v)
  }
  if (live.length === 0) return { refused: 'no sound to measure; leaving it whole', troughDb: -100, peakDb: -100 }
  live.sort((a, b) => a - b)
  const troughDb = percentile(live, 0.1)
  const peakDb = percentile(live, 0.95)
  const spread = peakDb - troughDb
  if (spread < 12) {
    return {
      refused: `only ${Math.round(spread)} dB between the quiet and the loud parts; leaving it whole`,
      troughDb,
      peakDb,
    }
  }
  const gateDb = Math.min(-24, Math.max(-60, troughDb + 0.6 * spread))
  return { gateDb, troughDb, peakDb }
}

/** Spans of speech: frames at or above the gate, short silences filled, short bursts dropped. */
export function speechRanges(
  db: ArrayLike<number>,
  gateDb: number,
  frameMs = 20,
  opts: { minSilenceMs?: number; minSpeechMs?: number } = {},
): Span[] {
  const minSilenceMs = opts.minSilenceMs ?? 300
  const minSpeechMs = opts.minSpeechMs ?? 60
  // Runs of [startFrame, endFrame) that are loud.
  let runs: [number, number][] = []
  let from = -1
  for (let i = 0; i <= db.length; i++) {
    const loud = i < db.length && (db[i] as number) >= gateDb
    if (loud && from < 0) from = i
    if (!loud && from >= 0) {
      runs.push([from, i])
      from = -1
    }
  }
  const filled: [number, number][] = []
  for (const run of runs) {
    const last = filled[filled.length - 1]
    if (last && (run[0] - last[1]) * frameMs < minSilenceMs) last[1] = run[1]
    else filled.push([run[0], run[1]])
  }
  runs = filled.filter(([a, b]) => (b - a) * frameMs >= minSpeechMs)
  return runs.map(([a, b]) => ({ startMs: round(a * frameMs), endMs: round(b * frameMs) }))
}

// ------------------------------------------------------------------- shots

/** A cut-detection threshold from the scores themselves: mean + 2.5 sd, kept in 0.15...0.40. */
export function sceneThreshold(scores: readonly number[]): number {
  if (scores.length === 0) return 0.4
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length
  const variance = scores.reduce((a, b) => a + (b - mean) * (b - mean), 0) / scores.length
  return Math.min(0.4, Math.max(0.15, mean + 2.5 * Math.sqrt(variance)))
}

/** Shots from scene-change scores: one cut per sample over the threshold, cuts closer than minShotMs keep the stronger one. */
export function shotsFromScores(
  samples: readonly { timeMs: number; score: number }[],
  durationMs: number,
  opts: { threshold?: number; minShotMs?: number } = {},
): { threshold: number; shots: (Span & { score: number })[] } {
  const threshold = opts.threshold ?? sceneThreshold(samples.map((s) => s.score))
  const minShotMs = opts.minShotMs ?? 600
  const cuts: { timeMs: number; score: number }[] = []
  const sorted = [...samples].sort((a, b) => a.timeMs - b.timeMs)
  for (const s of sorted) {
    if (s.score <= threshold) continue
    if (s.timeMs < minShotMs || durationMs - s.timeMs < minShotMs) continue
    const last = cuts[cuts.length - 1]
    if (last && s.timeMs - last.timeMs < minShotMs) {
      if (s.score > last.score) cuts[cuts.length - 1] = s
    } else cuts.push(s)
  }
  const shots: (Span & { score: number })[] = []
  let start = 0
  let score = 0
  for (const c of cuts) {
    shots.push({ startMs: round(start), endMs: round(c.timeMs), score })
    start = c.timeMs
    score = c.score
  }
  shots.push({ startMs: round(start), endMs: round(durationMs), score })
  return { threshold, shots }
}

// ------------------------------------------------------------------- words

/** A word as compared: NFC, lower case, only letters, combining marks (Indic vowel signs) and digits. */
export function normalizeWord(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '')
}

/** Ends with . ? ! । or ॥, possibly followed by closing quotes or brackets. */
export function endsSentence(text: string): boolean {
  return /[.?!।॥]["'”’)\]»]*$/u.test(text.trim())
}

/** Ends with , ; : or a dash, possibly followed by closing quotes or brackets. */
export function endsClause(text: string): boolean {
  return /[,;:—–]["'”’)\]»]*$/u.test(text.trim())
}

/**
 * Hesitation sounds (hard: always cut) and discourse fillers (soft: cut only when
 * the tightness allows) by base language. Entries are normalized; multi-word
 * entries are separated by one space.
 */
export const FILLERS: Record<string, { hard: readonly string[]; soft: readonly string[] }> = {
  en: {
    hard: ['um', 'umm', 'uh', 'uhh', 'er', 'erm', 'ah', 'eh', 'hmm', 'hm', 'mm', 'mhm'],
    soft: ['like', 'so', 'basically', 'actually', 'literally', 'you know', 'i mean', 'kind of', 'sort of', 'okay so', 'right'],
  },
  hi: {
    hard: ['अं', 'अम्म', 'उम्म', 'हम्म', 'umm', 'ummm', 'uhm', 'ahm', 'hmm', 'hmmm', 'aaa'],
    soft: [
      'matlab', 'मतलब', 'toh', 'तो', 'haan', 'han', 'हाँ', 'हां', 'accha', 'acha', 'achha', 'अच्छा',
      'basically', 'बेसिकली', 'you know', 'kya bolte hain', 'क्या बोलते हैं', 'jaise ki', 'जैसे कि',
      'na', 'ना', 'bas', 'बस', 'dekho', 'देखो',
    ],
  },
  ta: {
    hard: ['ம்ம்', 'ஹ்ம்', 'அம்', 'umm', 'hmm'],
    soft: ['அப்புறம்', 'அதாவது', 'சரி', 'பாருங்க', 'appuram', 'athavathu', 'sari'],
  },
  te: {
    hard: ['ఉమ్', 'హ్మ్', 'అమ్', 'umm', 'hmm'],
    soft: ['అంటే', 'సరే', 'అయితే', 'చూడు', 'మరి', 'ante', 'sare', 'mari'],
  },
  bn: {
    hard: ['উম', 'উমম', 'হুম', 'হুমম', 'umm', 'hmm'],
    soft: ['মানে', 'তো', 'আচ্ছা', 'দেখো', 'তাহলে', 'mane', 'accha', 'dekho'],
  },
  mr: {
    hard: ['अं', 'अम्म', 'उम्म', 'हम्म', 'umm', 'hmm'],
    soft: ['म्हणजे', 'तर', 'बरं', 'बघा', 'ना', 'mhanje', 'bara', 'tar'],
  },
  kn: {
    hard: ['ಉಮ್', 'ಹ್ಮ್', 'ಅಂ', 'umm', 'hmm'],
    soft: ['ಅಂದರೆ', 'ಅಂದ್ರೆ', 'ಸರಿ', 'ನೋಡಿ', 'ಹಾಗಾದರೆ', 'andre', 'sari', 'nodi'],
  },
  ml: {
    hard: ['ഹും', 'ഉമ്', 'umm', 'hmm'],
    soft: ['അതായത്', 'അപ്പോൾ', 'ശരി', 'നോക്കൂ', 'athayath', 'appo', 'sari'],
  },
  gu: {
    hard: ['અં', 'ઉમ્', 'હમ્મ', 'umm', 'hmm'],
    soft: ['એટલે', 'તો', 'સારું', 'જુઓ', 'મતલબ', 'etle', 'matlab', 'juo'],
  },
  pa: {
    hard: ['ਅੰ', 'ਉਮ', 'ਹਮਮ', 'umm', 'hmm'],
    soft: ['ਮਤਲਬ', 'ਤਾਂ', 'ਅੱਛਾ', 'ਦੇਖੋ', 'ਬੱਸ', 'ਯਾਨੀ', 'matlab', 'achha', 'dekho', 'bas'],
  },
}

function baseLanguage(language: string): string {
  return language.toLowerCase().split(/[-_]/)[0] || 'en'
}

/** Fillers for a BCP-47 language (hi-IN is hi): its own plus English, since speech mixes them. Soft ones as token lists, longest first. */
export function fillersFor(language: string): { hard: Set<string>; soft: string[][] } {
  const own = FILLERS[baseLanguage(language)]
  const en = FILLERS.en as { hard: readonly string[]; soft: readonly string[] }
  const hard = new Set<string>()
  const seen = new Set<string>()
  const soft: string[][] = []
  for (const set of own && own !== en ? [en, own] : [en]) {
    for (const h of set.hard) hard.add(normalizeWord(h))
    for (const s of set.soft) {
      const tokens = s.split(' ').map(normalizeWord).filter(Boolean)
      const key = tokens.join(' ')
      if (tokens.length === 0 || seen.has(key)) continue
      seen.add(key)
      soft.push(tokens)
    }
  }
  hard.delete('')
  return { hard, soft: soft.sort((a, b) => b.length - a.length) }
}

// --------------------------------------------------------------- sentences

export type Sentence = Span & { text: string; first: number; last: number }

/** Sentences: a word that ends one (. ? ! । ॥) closes it, and so does a gap longer than maxGapMs before the next word. */
export function sentencesOf(words: readonly Word[], maxGapMs = 700): Sentence[] {
  const out: Sentence[] = []
  let first = 0
  const close = (last: number): void => {
    const a = words[first] as Word
    const b = words[last] as Word
    out.push({
      startMs: a.startMs,
      endMs: b.endMs,
      text: words.slice(first, last + 1).map((w) => w.text).join(' '),
      first,
      last,
    })
    first = last + 1
  }
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as Word
    const next = words[i + 1]
    if (!next || endsSentence(w.text) || next.startMs - w.endMs > maxGapMs) close(i)
  }
  return out
}

// ----------------------------------------------------------------- tighten

export type CutKind = 'head' | 'tail' | 'pause' | 'filler' | 'false-start' | 'retake'
export type Cut = Span & { kinds: CutKind[]; reason: string }
export type Flag = Span & { kind: 'swallowed-retake' | 'possible-retake'; reason: string }
export type TightenOptions = {
  tightness?: Tightness
  language?: string
  minGapMs?: number
  padMs?: number
  fillers?: boolean
  falseStarts?: boolean
  retakes?: 'cut' | 'flag' | 'off'
}

/** How long a pause may be before it is cut, and how much air stays at each side. */
export function tightnessSettings(t: Tightness): { minGapMs: number; padMs: number } {
  if (t === 'tight') return { minGapMs: 400, padMs: 100 }
  if (t === 'balanced') return { minGapMs: 600, padMs: 150 }
  return { minGapMs: 900, padMs: 180 }
}

const seconds = (ms: number): string => (ms / 1000).toFixed(1)
const RULE_KINDS: readonly CutKind[] = ['filler', 'false-start', 'retake']

function speechSpans(words: readonly Word[], speech: readonly Span[] | null | undefined): Span[] {
  if (speech && speech.length > 0) return [...speech].sort((a, b) => a.startMs - b.startMs)
  const out: Span[] = []
  for (const w of words) {
    const last = out[out.length - 1]
    if (last && w.startMs - last.endMs < 150) last.endMs = Math.max(last.endMs, w.endMs)
    else out.push({ startMs: w.startMs, endMs: w.endMs })
  }
  return out
}

/**
 * What to cut from a talking head: dead air at the head and tail, long pauses
 * (longer after a sentence than inside one), hesitation sounds, false starts,
 * retakes. Words that stay are never cut into. Retakes that may hide inside one
 * long word are flagged, never cut.
 */
export function planTighten(
  input: { words: readonly Word[]; speech?: readonly Span[] | null; durationMs: number },
  options: TightenOptions = {},
): {
  cuts: Cut[]
  flags: Flag[]
  removedMs: number
  keptMs: number
  settings: { tightness: Tightness; minGapMs: number; padMs: number; language: string }
} {
  const tightness = options.tightness ?? 'generous'
  const preset = tightnessSettings(tightness)
  const minGapMs = options.minGapMs ?? preset.minGapMs
  const pad = options.padMs ?? preset.padMs
  const language = baseLanguage(options.language ?? 'en')
  const retakes = options.retakes ?? 'cut'
  const { words, durationMs } = input
  const settings = { tightness, minGapMs, padMs: pad, language }
  const speech = speechSpans(words, input.speech)
  if (speech.length === 0) return { cuts: [], flags: [], removedMs: 0, keptMs: durationMs, settings }

  const raw: Cut[] = []
  const flags: Flag[] = []
  const add = (startMs: number, endMs: number, kind: CutKind, reason: string): void => {
    raw.push({ startMs, endMs, kinds: [kind], reason })
  }
  const norm = words.map((w) => normalizeWord(w.text))
  const word = (i: number): Word => words[i] as Word

  const firstStart = (speech[0] as Span).startMs
  const lastEnd = (speech[speech.length - 1] as Span).endMs
  if (firstStart - pad >= 100) add(0, firstStart - pad, 'head', `${seconds(firstStart)} s before the first word`)
  if (durationMs - (lastEnd + 2 * pad) >= 100) add(lastEnd + 2 * pad, durationMs, 'tail', `${seconds(durationMs - lastEnd)} s after the last word`)

  for (let i = 0; i + 1 < speech.length; i++) {
    const a = speech[i] as Span
    const b = speech[i + 1] as Span
    const gap = b.startMs - a.endMs
    const before = words.findLast((w) => w.endMs <= a.endMs + 300)
    const m = before && endsSentence(before.text) ? 2.5 : before && endsClause(before.text) ? 1.5 : 1
    if (gap <= minGapMs * m) continue
    const from = a.endMs + pad * m
    const to = b.startMs - pad
    if (to - from < 100) continue
    const where = m === 2.5 ? ' after a sentence' : m === 1.5 ? ' after a clause' : ''
    add(from, to, 'pause', `pause of ${seconds(gap)} s${where}`)
  }

  if (options.fillers ?? true) {
    const { hard, soft } = fillersFor(language)
    for (let i = 0; i < words.length; ) {
      let n = 0
      let isHard = false
      if (norm[i] && hard.has(norm[i] as string)) {
        n = 1
        isHard = true
      } else {
        for (const tokens of soft) {
          if (i + tokens.length <= words.length && tokens.every((t, k) => norm[i + k] === t)) {
            n = tokens.length
            break
          }
        }
      }
      if (n === 0) {
        i++
        continue
      }
      const last = i + n - 1
      const prev = words[i - 1]
      const next = words[last + 1]
      const roomed = !prev || !next || word(i).startMs - prev.endMs >= 150 || next.startMs - word(last).endMs >= 150
      // Soft fillers are often grammar too ("I like it", "मैं तो"), so a single word
      // goes only next to a pause; tight also takes multi-word ones anywhere.
      if (isHard || (tightness !== 'generous' && (roomed || (tightness === 'tight' && n > 1)))) {
        const lo = Math.min(word(i).startMs, Math.max(prev ? prev.endMs : -Infinity, word(i).startMs - pad / 2))
        const hi = Math.max(word(last).endMs, Math.min(next ? next.startMs : Infinity, word(last).endMs + pad / 2))
        add(lo, hi, 'filler', `filler "${norm.slice(i, last + 1).join(' ')}"`)
      }
      i += n
    }
  }

  if (options.falseStarts ?? true) {
    for (let i = 0; i < words.length; ) {
      let hit = 0
      for (let n = 4; n >= 1 && !hit; n--) {
        if (i + 2 * n > words.length) continue
        if (n === 1 && (language !== 'en' || [...(norm[i] as string)].length <= 1)) continue
        let same = true
        for (let k = 0; k < n; k++) if (!norm[i + k] || norm[i + k] !== norm[i + n + k]) same = false
        if (same && word(i + n).startMs - word(i + n - 1).endMs <= 600) hit = n
      }
      if (!hit) {
        i++
        continue
      }
      const prev = words[i - 1]
      const lo = Math.min(word(i).startMs, Math.max(prev ? prev.endMs : -Infinity, word(i).startMs - pad / 2))
      const hi = Math.min(word(i + hit).startMs, Math.max(word(i + hit - 1).endMs, word(i + hit).startMs - pad / 2))
      add(lo, hi, 'false-start', `false start "${words.slice(i, i + hit).map((w) => w.text).join(' ')}" said again`)
      i += hit
    }
  }

  if (retakes !== 'off') {
    const sentences = sentencesOf(words)
    for (let s = 0; s < sentences.length; s++) {
      const S = sentences[s] as Sentence
      const sWords = norm.slice(S.first, S.last + 1)
      const open = !endsSentence(word(S.last).text)
      let found = -1
      for (let t = s + 1; t <= s + 2 && t < sentences.length && found < 0; t++) {
        const T = sentences[t] as Sentence
        const tWords = norm.slice(T.first, T.last + 1)
        let k = 0
        while (k < sWords.length && k < tWords.length && sWords[k] && sWords[k] === tWords[k]) k++
        if (k >= 3 || (open && k >= 2)) found = t
      }
      if (found < 0) continue
      const T = sentences[found] as Sentence
      const opening = S.text.split(' ').slice(0, 5).join(' ')
      if (retakes === 'flag') {
        flags.push({ startMs: S.startMs, endMs: S.endMs, kind: 'possible-retake', reason: `possible retake: "${opening}…" said again at ${seconds(T.startMs)} s` })
        continue
      }
      const prev = words[S.first - 1]
      const lo = Math.min(S.startMs, Math.max(prev ? prev.endMs : -Infinity, S.startMs - pad / 2))
      const hi = Math.min(T.startMs, Math.max(word(T.first - 1).endMs, T.startMs - pad / 2))
      add(lo, hi, 'retake', `retake: "${opening}…" said again at ${seconds(T.startMs)} s`)
      s = found - 1
    }
  }

  for (const w of words) {
    if (w.endMs - w.startMs >= 1200) {
      flags.push({ startMs: w.startMs, endMs: w.endMs, kind: 'swallowed-retake', reason: `"${w.text}" lasts ${seconds(w.endMs - w.startMs)} s: a retake may be hidden inside it` })
    }
  }

  // A word stays unless a filler, false-start or retake cut covers all of it.
  const removed = words.map((w) => raw.some((c) => c.kinds.some((k) => RULE_KINDS.includes(k)) && c.startMs <= w.startMs && w.endMs <= c.endMs))
  // Word times are estimates and the gate's speech is not, so a staying word
  // is kept clear only where it overlaps heard speech.
  const heard = input.speech && input.speech.length > 0 ? speech : null
  const staying = words
    .filter((_, i) => !removed[i])
    .flatMap((w) => {
      const parts = (heard ?? []).flatMap((h) => (h.endMs > w.startMs && h.startMs < w.endMs ? [{ ...w, startMs: Math.max(w.startMs, h.startMs), endMs: Math.min(w.endMs, h.endMs) }] : []))
      // A word heard nowhere by the gate is a quiet one: keep it whole.
      return parts.length > 0 ? parts : [w]
    })

  const clamped = raw
    .map((c) => ({ ...c, startMs: Math.max(0, c.startMs), endMs: Math.min(durationMs, c.endMs) }))
    .filter((c) => c.endMs > c.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
  const merged: Cut[] = []
  for (const c of clamped) {
    const last = merged[merged.length - 1]
    if (last && c.startMs - last.endMs < 150) {
      last.endMs = Math.max(last.endMs, c.endMs)
      for (const k of c.kinds) if (!last.kinds.includes(k)) last.kinds.push(k)
      if (!last.reason.split('; ').includes(c.reason)) last.reason += `; ${c.reason}`
    } else merged.push({ ...c, kinds: [...c.kinds] })
  }

  const cuts: Cut[] = []
  for (const c of merged) {
    let pieces: Span[] = [{ startMs: c.startMs, endMs: c.endMs }]
    for (const w of staying) {
      if (w.startMs - 20 >= c.endMs || w.endMs + 20 <= c.startMs) continue
      const clearFrom = w.startMs - 20
      const clearTo = w.endMs + 20
      pieces = pieces.flatMap((p) => {
        if (clearTo <= p.startMs || clearFrom >= p.endMs) return [p]
        const out: Span[] = []
        if (clearFrom > p.startMs) out.push({ startMs: p.startMs, endMs: clearFrom })
        if (clearTo < p.endMs) out.push({ startMs: clearTo, endMs: p.endMs })
        return out
      })
    }
    for (const p of pieces) {
      const startMs = round(p.startMs)
      const endMs = round(p.endMs)
      if (endMs - startMs >= 80) cuts.push({ startMs, endMs, kinds: [...c.kinds], reason: c.reason })
    }
  }

  const removedMs = cuts.reduce((sum, c) => sum + (c.endMs - c.startMs), 0)
  const rounded = flags.map((f) => ({ ...f, startMs: round(f.startMs), endMs: round(f.endMs) }))
  return { cuts, flags: rounded, removedMs, keptMs: durationMs - removedMs, settings }
}

// ------------------------------------------------------------------ search

export type FootageEntry = {
  mediaId: string
  name: string
  words: readonly Word[]
  shots: readonly (Span & { description?: string | null })[]
}
export type SearchHit = {
  mediaId: string
  name: string
  kind: 'words' | 'shot'
  text: string
  startMs: number
  endMs: number
  inMs: number
  outMs: number
  score: number
}

function tokenMatches(q: string, w: string): boolean {
  if (q === w) return true
  return q.length >= 4 && w.length >= 4 && (w.startsWith(q) || q.startsWith(w))
}

/** Finds what was said (a phrase, or most of the words of a sentence) and shots whose description fits, with an in and out point around the sentence. */
export function searchFootage(
  entries: readonly FootageEntry[],
  query: string,
  options: { kind?: 'all' | 'words' | 'shots'; limit?: number; padMs?: number } = {},
): SearchHit[] {
  const kind = options.kind ?? 'all'
  const limit = options.limit ?? 10
  const pad = options.padMs ?? 150
  const q = query.split(/\s+/).map(normalizeWord).filter(Boolean)
  if (q.length === 0) return []
  const share = (tokens: readonly string[]): number => q.filter((t) => tokens.some((w) => tokenMatches(t, w))).length / q.length
  const hits: SearchHit[] = []

  for (const e of entries) {
    if (kind !== 'shots') {
      const norm = e.words.map((w) => normalizeWord(w.text))
      const mine: SearchHit[] = []
      for (const S of sentencesOf(e.words)) {
        const inMs = Math.max(0, S.startMs - pad)
        const outMs = S.endMs + pad
        const phrases: SearchHit[] = []
        for (let i = S.first; i + q.length - 1 <= S.last; i++) {
          if (!q.every((t, k) => tokenMatches(t, norm[i + k] as string))) continue
          const a = e.words[i] as Word
          const b = e.words[i + q.length - 1] as Word
          const text = e.words.slice(i, i + q.length).map((w) => w.text).join(' ')
          phrases.push({ mediaId: e.mediaId, name: e.name, kind: 'words', text, startMs: round(a.startMs), endMs: round(b.endMs), inMs: round(inMs), outMs: round(outMs), score: 1 })
        }
        if (phrases.length > 0) {
          mine.push(...phrases)
          continue
        }
        const score = share(norm.slice(S.first, S.last + 1))
        if (score >= 0.5) {
          mine.push({ mediaId: e.mediaId, name: e.name, kind: 'words', text: S.text, startMs: round(S.startMs), endMs: round(S.endMs), inMs: round(inMs), outMs: round(outMs), score })
        }
      }
      mine.sort((a, b) => b.score - a.score || a.startMs - b.startMs)
      const kept: SearchHit[] = []
      for (const h of mine) if (!kept.some((k) => h.startMs < k.endMs && k.startMs < h.endMs)) kept.push(h)
      hits.push(...kept)
    }
    if (kind !== 'words') {
      for (const s of e.shots) {
        if (!s.description) continue
        const score = share(s.description.split(/\s+/).map(normalizeWord).filter(Boolean))
        if (score < 0.34) continue
        hits.push({ mediaId: e.mediaId, name: e.name, kind: 'shot', text: s.description, startMs: round(s.startMs), endMs: round(s.endMs), inMs: round(s.startMs), outMs: round(s.endMs), score })
      }
    }
  }
  hits.sort((a, b) => b.score - a.score || (a.mediaId < b.mediaId ? -1 : a.mediaId > b.mediaId ? 1 : 0) || a.startMs - b.startMs)
  return hits.slice(0, limit)
}

// ----------------------------------------------------------------- b-roll

export type BrollRequest = { startMs: number; endMs?: number; relevance?: number }

function subtract(piece: Span, blocks: readonly Span[]): Span[] {
  let free: Span[] = [piece]
  for (const b of blocks) {
    free = free.flatMap((p) => {
      if (b.endMs <= p.startMs || b.startMs >= p.endMs) return [p]
      const out: Span[] = []
      if (b.startMs > p.startMs) out.push({ startMs: p.startMs, endMs: b.startMs })
      if (b.endMs < p.endMs) out.push({ startMs: b.endMs, endMs: p.endMs })
      return out
    })
  }
  return free
}

function longest(spans: readonly Span[]): Span | null {
  let best: Span | null = null
  for (const s of spans) if (!best || s.endMs - s.startMs > best.endMs - best.startMs) best = s
  return best
}

/**
 * Where cutaways may go: inside the sentence they illustrate (inset so the
 * speaker's start and end stay on screen), clear of protected beats, existing
 * layers and each other.
 */
export function placeBroll(
  input: { sentences: readonly Span[]; requests: readonly BrollRequest[]; protected?: readonly Span[]; existing?: readonly Span[] },
  options: { insetMs?: number; minMs?: number; minRelevance?: number } = {},
): { placed: { index: number; startMs: number; endMs: number }[]; rejected: { index: number; reason: string }[] } {
  const inset = options.insetMs ?? 150
  const minMs = options.minMs ?? 800
  const minRelevance = options.minRelevance ?? 0.35
  const sentences = [...input.sentences].sort((a, b) => a.startMs - b.startMs)
  const protectedSpans = input.protected ?? []
  const existing = input.existing ?? []
  const placed: { index: number; startMs: number; endMs: number }[] = []
  const rejected: { index: number; reason: string }[] = []

  input.requests.forEach((req, index) => {
    const relevance = req.relevance ?? 1
    if (relevance < minRelevance) {
      rejected.push({ index, reason: `relevance ${relevance} is below ${minRelevance}` })
      return
    }
    const sentence =
      sentences.find((s) => s.startMs <= req.startMs && req.startMs <= s.endMs) ??
      sentences.find((s) => s.startMs > req.startMs && s.startMs - req.startMs <= 1000)
    if (!sentence) {
      rejected.push({ index, reason: 'not inside a sentence' })
      return
    }
    const winStart = sentence.startMs + inset
    const winEnd = sentence.endMs - inset
    const window: Span = { startMs: Math.max(req.startMs, winStart), endMs: Math.min(req.endMs ?? winEnd, winEnd) }
    if (window.endMs - window.startMs < minMs) {
      rejected.push({ index, reason: `too short: ${seconds(Math.max(0, window.endMs - window.startMs))} s inside the sentence, needs ${seconds(minMs)} s` })
      return
    }
    const clearOfBeats = subtract(window, protectedSpans)
    const best = longest(subtract(window, [...protectedSpans, ...existing, ...placed]))
    if (!best || best.endMs - best.startMs < minMs) {
      const beats = longest(clearOfBeats)
      const reason = !beats || beats.endMs - beats.startMs < minMs ? 'covers a protected beat' : 'overlaps another cutaway'
      rejected.push({ index, reason })
      return
    }
    placed.push({ index, startMs: round(best.startMs), endMs: round(best.endMs) })
  })
  return { placed, rejected }
}

// ------------------------------------------------------------ time mapping

export type MediaTiming = { startMs: number; durationMs: number; sourceStartMs: number; playbackRate: number }

/** Where a moment of the source file lands on the comp's clock. */
export function mediaToComp(layer: MediaTiming, mediaMs: number): number {
  return layer.startMs + (mediaMs - layer.sourceStartMs) / layer.playbackRate
}

/** Which moment of the source file plays at a comp time. */
export function compToMedia(layer: MediaTiming, compMs: number): number {
  return layer.sourceStartMs + (compMs - layer.startMs) * layer.playbackRate
}

/** Source spans on the comp's clock, clipped to the layer; spans outside it are dropped. */
export function spansToComp(layer: MediaTiming, spans: readonly Span[]): Span[] {
  const lo = layer.startMs
  const hi = layer.startMs + layer.durationMs
  const out: Span[] = []
  for (const s of spans) {
    const a = mediaToComp(layer, s.startMs)
    const b = mediaToComp(layer, s.endMs)
    const startMs = round(Math.max(lo, Math.min(a, b)))
    const endMs = round(Math.min(hi, Math.max(a, b)))
    if (endMs > startMs) out.push({ startMs, endMs })
  }
  return out
}
