import { describe, expect, it } from 'vitest'
import { alignWords, speechSpan, splitWords, wordWeight } from './speechAlign'

const RATE = 48000

/** A take made of silences (0) and 400 Hz bursts (amplitude), each with its length in ms. */
function makeTake(parts: readonly (readonly [number, number])[]): Float32Array {
  const total = parts.reduce((sum, [ms]) => sum + Math.round((ms * RATE) / 1000), 0)
  const out = new Float32Array(total)
  let at = 0
  for (const [ms, amplitude] of parts) {
    const n = Math.round((ms * RATE) / 1000)
    if (amplitude > 0) for (let i = 0; i < n; i++) out[at + i] = amplitude * Math.sin((2 * Math.PI * 400 * i) / RATE)
    at += n
  }
  return out
}

/** 200 ms lead, bursts of the given lengths with 120 ms gaps, 100 ms tail. Returns the audio and each burst's [start, end]. */
function burstTake(lengths: readonly number[]): { audio: Float32Array; bursts: [number, number][] } {
  const parts: [number, number][] = [[200, 0]]
  const bursts: [number, number][] = []
  let t = 200
  lengths.forEach((ms, i) => {
    if (i > 0) {
      parts.push([120, 0])
      t += 120
    }
    parts.push([ms, 0.5])
    bursts.push([t, t + ms])
    t += ms
  })
  parts.push([100, 0])
  return { audio: makeTake(parts), bursts }
}

describe('speechSpan', () => {
  it('finds the lead and the tail of the voice', () => {
    const { audio, bursts } = burstTake([300, 500, 200, 400])
    const span = speechSpan(audio, RATE)
    expect(span).not.toBeNull()
    expect(Math.abs(span!.startMs - bursts[0]![0]!)).toBeLessThanOrEqual(15)
    expect(Math.abs(span!.endMs - bursts[3]![1]!)).toBeLessThanOrEqual(15)
  })

  it('returns null for silence and for a voice under the threshold', () => {
    expect(speechSpan(new Float32Array(RATE), RATE)).toBeNull()
    expect(speechSpan(new Float32Array(0), RATE)).toBeNull()
    // Amplitude 0.001 is about −63 dBFS RMS: quieter than −45, louder than −80
    const quiet = makeTake([
      [100, 0],
      [300, 0.001],
      [100, 0],
    ])
    expect(speechSpan(quiet, RATE)).toBeNull()
    const span = speechSpan(quiet, RATE, { thresholdDb: -80 })
    expect(span).not.toBeNull()
    expect(Math.abs(span!.startMs - 100)).toBeLessThanOrEqual(15)
    expect(Math.abs(span!.endMs - 400)).toBeLessThanOrEqual(15)
  })
})

describe('wordWeight', () => {
  // Intl.Segmenter (Node 22, Unicode 15.1) keeps a conjunct with its vowel sign in one cluster:
  // नमस्ते → न | म | स्ते, बैटरी → बै | ट | री, தமிழ் → த | மி | ழ். Each cluster is one syllable.
  it('counts grapheme clusters in Indic scripts', () => {
    expect(wordWeight('नमस्ते')).toBe(3)
    expect(wordWeight('बैटरी')).toBe(3)
    expect(wordWeight('தமிழ்')).toBe(3)
    expect(wordWeight('नमस्कार')).toBe(4)
  })

  it('counts vowel groups in Latin words', () => {
    expect(wordWeight('battery')).toBe(3)
    expect(wordWeight('the')).toBe(1)
    expect(wordWeight('hmm')).toBe(1)
    expect(wordWeight('café')).toBe(2)
    expect(wordWeight('Hello,')).toBe(2)
  })

  it('counts digits one each, and punctuation alone as nothing', () => {
    expect(wordWeight('30')).toBe(2)
    expect(wordWeight('2026.')).toBe(4)
    expect(wordWeight('—')).toBe(0)
    expect(wordWeight('...')).toBe(0)
  })

  it('splits text on whitespace and keeps punctuation on its word', () => {
    expect(splitWords('  नमस्ते, दुनिया!\n Hello  world. ')).toEqual(['नमस्ते,', 'दुनिया!', 'Hello', 'world.'])
    expect(splitWords('')).toEqual([])
  })
})

describe('alignWords', () => {
  it('puts each word on its burst', () => {
    const { audio, bursts } = burstTake([300, 500, 200, 400])
    const aligned = alignWords(audio, RATE, ['go', 'battery', 'is', 'low'])
    expect(aligned.map((w) => w.text)).toEqual(['go', 'battery', 'is', 'low'])
    aligned.forEach((word, i) => {
      expect(Math.abs(word.startMs - bursts[i]![0]!)).toBeLessThanOrEqual(25)
      expect(Math.abs(word.endMs - bursts[i]![1]!)).toBeLessThanOrEqual(25)
    })
  })

  it('works for Devanagari words too', () => {
    const { audio, bursts } = burstTake([600, 200, 400])
    const aligned = alignWords(audio, RATE, ['नमस्ते', 'तुम', 'कैसे'])
    aligned.forEach((word, i) => {
      expect(Math.abs(word.startMs - bursts[i]![0]!)).toBeLessThanOrEqual(25)
      expect(Math.abs(word.endMs - bursts[i]![1]!)).toBeLessThanOrEqual(25)
    })
  })

  it('stays monotonic and inside the span when there are more words than bursts', () => {
    const { audio, bursts } = burstTake([300, 500, 200, 400])
    const span = speechSpan(audio, RATE)!
    const aligned = alignWords(audio, RATE, ['one', 'two', 'three', 'four', 'five', 'six', 'seven'])
    expect(aligned).toHaveLength(7)
    expect(aligned[0]!.startMs).toBe(span.startMs)
    expect(aligned[6]!.endMs).toBe(span.endMs)
    let previousEnd = span.startMs
    for (const word of aligned) {
      expect(Number.isInteger(word.startMs)).toBe(true)
      expect(Number.isInteger(word.endMs)).toBe(true)
      expect(word.startMs).toBeGreaterThanOrEqual(previousEnd)
      expect(word.endMs - word.startMs).toBeGreaterThanOrEqual(40)
      previousEnd = word.endMs
    }
    expect(previousEnd).toBeLessThanOrEqual(span.endMs)
    // No word straddles a long gap: the gaps are anchored boundaries
    for (const word of aligned) {
      for (let g = 0; g < 3; g++) {
        const gapStart = bursts[g]![1]!
        const gapEnd = bursts[g + 1]![0]!
        expect(word.startMs < gapStart - 15 && word.endMs > gapEnd + 15).toBe(false)
      }
    }
  })

  it('prefers a boundary after a comma when a pause is equally near two boundaries', () => {
    // Span 0 to 1600 ms, four one-syllable words: ideal boundaries at 400, 800, 1200 ms.
    // The pause (540 to 660 ms, centre 600) is exactly 200 ms from both the first and the second.
    const audio = makeTake([
      [540, 0.5],
      [120, 0],
      [940, 0.5],
    ])
    const span = { startMs: 0, endMs: 1600 }
    const plain = alignWords(audio, RATE, ['ka', 'ba', 'ka', 'ba'], { span })
    expect(plain[0]!.endMs).toBe(540)
    expect(plain[1]!.startMs).toBe(660)
    const comma = alignWords(audio, RATE, ['ka', 'ba,', 'ka', 'ba'], { span })
    expect(comma[1]!.endMs).toBe(540)
    expect(comma[2]!.startMs).toBe(660)
    const danda = alignWords(audio, RATE, ['का', 'बा।', 'का', 'बा'], { span })
    expect(danda[1]!.endMs).toBe(540)
    expect(danda[2]!.startMs).toBe(660)
  })

  it('does not take a short gap far from any boundary (a stop consonant inside a word) as a pause', () => {
    // "your music": the voice runs 0–1000 ms (after a 100 ms lead) with a 70 ms closure near its end.
    const audio = makeTake([
      [100, 0],
      [830, 0.5],
      [70, 0],
      [100, 0.5],
      [100, 0],
    ])
    const [your, music] = alignWords(audio, RATE, ['your', 'music'])
    // "your" is one syllable, "music" two: the boundary sits a third of the way in, not at the gap.
    expect(your!.endMs).toBeGreaterThan(350)
    expect(your!.endMs).toBeLessThan(600)
    expect(music!.endMs - music!.startMs).toBeGreaterThan(400)
  })

  it('spreads words evenly over a silent file', () => {
    const silent = new Float32Array(RATE * 2)
    const aligned = alignWords(silent, RATE, ['a', 'bb', 'ccc', 'dddd'])
    expect(aligned.map((w) => [w.startMs, w.endMs])).toEqual([
      [0, 500],
      [500, 1000],
      [1000, 1500],
      [1500, 2000],
    ])
  })

  it('handles no words and one word', () => {
    const { audio } = burstTake([300, 500])
    expect(alignWords(audio, RATE, [])).toEqual([])
    const span = speechSpan(audio, RATE)!
    expect(alignWords(audio, RATE, ['hello'])).toEqual([{ text: 'hello', startMs: span.startMs, endMs: span.endMs }])
  })

  it('is deterministic', () => {
    const { audio } = burstTake([300, 500, 200, 400])
    const words = ['go', 'battery', 'is', 'low', 'now']
    expect(alignWords(audio, RATE, words)).toEqual(alignWords(audio, RATE, words))
  })
})
