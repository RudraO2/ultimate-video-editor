import { describe, expect, it } from 'vitest'
import {
  FILLERS,
  calibrateGate,
  compToMedia,
  endsClause,
  endsSentence,
  fillersFor,
  loudnessDb,
  mediaToComp,
  normalizeWord,
  placeBroll,
  planTighten,
  sceneThreshold,
  searchFootage,
  sentencesOf,
  shotsFromScores,
  speechRanges,
  spansToComp,
  tightnessSettings,
  type Word,
} from './footage'

// Words of 300 ms with 80 ms between; a number sets the gap before the next word.
function say(items: (string | number)[], start = 0): Word[] {
  const out: Word[] = []
  let t = start
  let gap = 80
  for (const item of items) {
    if (typeof item === 'number') {
      gap = item
      continue
    }
    if (out.length > 0) t += gap
    out.push({ text: item, startMs: t, endMs: t + 300 })
    t += 300
    gap = 80
  }
  return out
}
const endOf = (words: Word[]): number => (words[words.length - 1] as Word).endMs

describe('loudness and gate', () => {
  it('measures dBFS per frame with a floor', () => {
    const samples = new Float32Array(80).fill(1, 0, 40)
    const db = loudnessDb(samples, 1000, 40)
    expect(Array.from(db)).toEqual([0, -100])
  })

  it('calibrates the gate between trough and peak', () => {
    const db = [...Array(100).fill(-50), ...Array(100).fill(-20), -100]
    const g = calibrateGate(db)
    expect('gateDb' in g && g.gateDb).toBeCloseTo(-32, 5)
    expect(g.troughDb).toBeCloseTo(-50, 5)
  })

  it('clamps the gate', () => {
    const quiet = calibrateGate([...Array(50).fill(-90), ...Array(50).fill(-60)])
    expect('gateDb' in quiet && quiet.gateDb).toBe(-60)
    const loud = calibrateGate([...Array(50).fill(-30), ...Array(50).fill(-3)])
    expect('gateDb' in loud && loud.gateDb).toBe(-24)
  })

  it('refuses flat or empty sound', () => {
    const flat = calibrateGate([...Array(50).fill(-30), ...Array(50).fill(-25)])
    expect('refused' in flat && flat.refused).toMatch(/only 5 dB between the quiet and the loud parts/)
    expect('refused' in calibrateGate([-100, -100])).toBe(true)
  })

  it('fills short silences and drops short bursts', () => {
    const l = -10
    const s = -80
    const db = [...Array(5).fill(l), ...Array(3).fill(s), ...Array(5).fill(l), ...Array(20).fill(s), l, l, ...Array(10).fill(s)]
    expect(speechRanges(db, -40)).toEqual([{ startMs: 0, endMs: 260 }])
    expect(speechRanges(db, -40, 20, { minSilenceMs: 40, minSpeechMs: 20 })).toEqual([
      { startMs: 0, endMs: 100 },
      { startMs: 160, endMs: 260 },
      { startMs: 660, endMs: 700 },
    ])
  })
})

describe('shots', () => {
  it('derives and clamps the threshold', () => {
    expect(sceneThreshold([])).toBe(0.4)
    expect(sceneThreshold([0, 0, 0])).toBe(0.15)
    expect(sceneThreshold([0.1, 0.1, 0.1, 0.1, 0.9])).toBe(0.4)
  })

  it('cuts at peaks, spaced by the minimum shot length', () => {
    const r = shotsFromScores(
      [
        { timeMs: 200, score: 0.8 },
        { timeMs: 1000, score: 0.9 },
        { timeMs: 1300, score: 0.5 },
        { timeMs: 3000, score: 0.35 },
        { timeMs: 3500, score: 0.1 },
        { timeMs: 5900, score: 0.9 },
      ],
      6000,
      { threshold: 0.3 },
    )
    expect(r.shots).toEqual([
      { startMs: 0, endMs: 1000, score: 0 },
      { startMs: 1000, endMs: 3000, score: 0.9 },
      { startMs: 3000, endMs: 6000, score: 0.35 },
    ])
    const later = shotsFromScores([{ timeMs: 1000, score: 0.5 }, { timeMs: 1300, score: 0.9 }], 6000, { threshold: 0.3 })
    expect(later.shots.map((s) => s.endMs)).toEqual([1300, 6000])
  })
})

describe('words and fillers', () => {
  it('normalizes Devanagari with danda, quotes and ellipsis', () => {
    expect(normalizeWord('नमस्ते।')).toBe('नमस्ते')
    expect(normalizeWord('हाँ॥')).toBe('हाँ')
    expect(normalizeWord('“Hello,”')).toBe('hello')
    expect(normalizeWord('wait…')).toBe('wait')
    expect(normalizeWord('2026!')).toBe('2026')
  })

  it('tells sentence ends from clause ends', () => {
    expect(endsSentence('done.')).toBe(true)
    expect(endsSentence('क्या?”')).toBe(true)
    expect(endsSentence('है।')).toBe(true)
    expect(endsSentence('done,')).toBe(false)
    expect(endsClause('so,')).toBe(true)
    expect(endsClause('well—')).toBe(true)
    expect(endsClause('done.')).toBe(false)
  })

  it('keeps filler entries normalized', () => {
    for (const set of Object.values(FILLERS)) {
      for (const e of [...set.hard, ...set.soft]) expect(e.split(' ').map(normalizeWord).join(' ')).toBe(e)
    }
  })

  it('merges English into Hindi, longest soft first, Hindi spellings only for Hindi', () => {
    const hi = fillersFor('hi-IN')
    expect(hi.hard.has('um')).toBe(true)
    expect(hi.hard.has('हम्म')).toBe(true)
    expect(hi.soft[0]).toHaveLength(3)
    expect(hi.soft).toContainEqual(['kya', 'bolte', 'hain'])
    expect(hi.soft).toContainEqual(['मतलब'])
    expect(hi.soft).toContainEqual(['you', 'know'])
    const ta = fillersFor('ta')
    expect(ta.soft).toContainEqual(['சரி'])
    expect(ta.soft).not.toContainEqual(['toh'])
    expect(fillersFor('xx').hard.has('um')).toBe(true)
  })

  it('splits sentences on punctuation and long gaps', () => {
    const s = sentencesOf(say(['Hi', 'there.', 'How', 'are', 900, 'you']))
    expect(s.map((x) => x.text)).toEqual(['Hi there.', 'How are', 'you'])
    expect(s[1]).toMatchObject({ first: 2, last: 3, startMs: 760, endMs: 1440 })
  })
})

describe('planTighten', () => {
  it('has presets', () => {
    expect(tightnessSettings('generous')).toEqual({ minGapMs: 900, padMs: 180 })
    expect(tightnessSettings('tight')).toEqual({ minGapMs: 400, padMs: 100 })
  })

  it('does nothing without words or speech', () => {
    const r = planTighten({ words: [], durationMs: 5000 })
    expect(r.cuts).toEqual([])
    expect(r.keptMs).toBe(5000)
  })

  it('cuts dead air at the head and tail', () => {
    const words = say(['Hello', 'there.'], 2000)
    const r = planTighten({ words, durationMs: 6000 })
    expect(r.settings).toEqual({ tightness: 'generous', minGapMs: 900, padMs: 180, language: 'en' })
    expect(r.cuts).toEqual([
      { startMs: 0, endMs: 1820, kinds: ['head'], reason: expect.any(String) },
      { startMs: endOf(words) + 360, endMs: 6000, kinds: ['tail'], reason: expect.any(String) },
    ])
    expect(r.removedMs + r.keptMs).toBe(6000)
  })

  it('lets a sentence end breathe longer than a mid-phrase pause', () => {
    const base = ['One', 'two.']
    const short = say([...base, 1500, 'three', 'four'])
    expect(planTighten({ words: short, durationMs: endOf(short) }).cuts).toEqual([])
    const long = say([...base, 2400, 'three', 'four'])
    const r = planTighten({ words: long, durationMs: endOf(long) })
    expect(r.cuts).toHaveLength(1)
    expect(r.cuts[0]).toMatchObject({ startMs: 680 + 450, endMs: 3080 - 180, kinds: ['pause'] })
    expect(r.cuts[0]?.reason).toBe('pause of 2.4 s after a sentence')
    const mid = say(['One', 'two', 1000, 'three'])
    expect(planTighten({ words: mid, durationMs: endOf(mid) }).cuts).toHaveLength(1)
    const comma = say(['One', 'two,', 1000, 'three'])
    expect(planTighten({ words: comma, durationMs: endOf(comma) }).cuts).toEqual([])
  })

  it('cuts hard fillers always and soft ones by tightness', () => {
    const hard = say(['so', 'um', 'we', 'go'])
    const r = planTighten({ words: hard, durationMs: endOf(hard) })
    expect(r.cuts).toHaveLength(1)
    expect(r.cuts[0]).toMatchObject({ kinds: ['filler'], reason: 'filler "um"' })
    expect(r.cuts[0]?.startMs).toBeLessThanOrEqual(380 + 0)

    const soft = say(['I', 'like', 'it'])
    expect(planTighten({ words: soft, durationMs: endOf(soft), }, { tightness: 'generous' }).cuts).toEqual([])
    expect(planTighten({ words: soft, durationMs: endOf(soft) }, { tightness: 'balanced' }).cuts).toEqual([])
    // A lone soft filler is often grammar ("I like it"): only next to a pause, even when tight.
    expect(planTighten({ words: soft, durationMs: endOf(soft) }, { tightness: 'tight' }).cuts).toEqual([])
    const knowing = say(['it', 'you', 'know', 'works'])
    const tight = planTighten({ words: knowing, durationMs: endOf(knowing) }, { tightness: 'tight' })
    expect(tight.cuts).toHaveLength(1)
    expect(tight.cuts[0]?.reason).toBe('filler "you know"')

    const spaced = say(['I', 200, 'like', 'it'])
    const balanced = planTighten({ words: spaced, durationMs: endOf(spaced) }, { tightness: 'balanced' })
    expect(balanced.cuts).toHaveLength(1)
    expect(planTighten({ words: soft, durationMs: endOf(soft) }, { tightness: 'tight', fillers: false }).cuts).toEqual([])
  })

  it('cuts Hindi fillers in both scripts', () => {
    const words = say(['यह', 'हम्म', 'ठीक', 'है', 'umm', 'चलो'])
    const r = planTighten({ words, durationMs: endOf(words) }, { language: 'hi-IN' })
    expect(r.cuts.map((c) => c.reason)).toEqual(['filler "हम्म"', 'filler "umm"'])
    const soft = say(['yaar', 200, 'matlab', 'chalo'])
    const t = planTighten({ words: soft, durationMs: endOf(soft) }, { language: 'hi', tightness: 'tight' })
    expect(t.cuts[0]?.reason).toBe('filler "matlab"')
  })

  it('cuts the first try of a false start', () => {
    const words = say(['we', 'we', 'should', 'go'], 3000)
    const r = planTighten({ words, durationMs: endOf(words) })
    expect(r.cuts).toHaveLength(1)
    expect(r.cuts[0]).toMatchObject({ startMs: 0, endMs: 3300, kinds: ['head', 'false-start'] })
    expect(r.cuts[0]?.reason).toContain('false start "we" said again')

    const phrase = say(['let', 'me', 'show', 'let', 'me', 'show', 'you'])
    const p = planTighten({ words: phrase, durationMs: endOf(phrase) })
    expect(p.cuts).toHaveLength(1)
    expect(p.cuts[0]?.endMs).toBe((phrase[2] as Word).endMs)
    expect(planTighten({ words: phrase, durationMs: endOf(phrase) }, { falseStarts: false }).cuts).toEqual([])
  })

  it('keeps Indic reduplication', () => {
    const words = say(['jaldi', 'jaldi', 'chalo'])
    expect(planTighten({ words, durationMs: endOf(words) }, { language: 'hi' }).cuts).toEqual([])
    expect(planTighten({ words, durationMs: endOf(words) }, { language: 'en' }).cuts).toHaveLength(1)
  })

  it('cuts a retake or flags it', () => {
    const words = say(['Welcome', 'everyone.', 500, 'Here', 'is', 'how', 'it', 'works.', 500, 'Here', 'is', 'how', 'it', 'really', 'works.'])
    const S = (words[2] as Word).startMs
    const T = (words[7] as Word).startMs
    const r = planTighten({ words, durationMs: endOf(words) })
    expect(r.cuts).toHaveLength(1)
    expect(r.cuts[0]).toMatchObject({ startMs: S - 90, endMs: T - 90, kinds: ['retake'] })
    expect(r.cuts[0]?.reason).toMatch(/^retake: "Here is how it works\.…" said again at /)

    const f = planTighten({ words, durationMs: endOf(words) }, { retakes: 'flag' })
    expect(f.cuts).toEqual([])
    expect(f.flags).toEqual([expect.objectContaining({ kind: 'possible-retake', startMs: S, endMs: (words[6] as Word).endMs })])
    expect(planTighten({ words, durationMs: endOf(words) }, { retakes: 'off' }).cuts).toEqual([])

    const open = say(['the', 'plan', 800, 'the', 'plan', 'is', 'simple.'])
    expect(planTighten({ words: open, durationMs: endOf(open) }).cuts.map((c) => c.kinds)).toEqual([['retake']])
  })

  it('flags a word that swallows a retake, never cuts it', () => {
    const words: Word[] = [
      { text: 'Hello', startMs: 0, endMs: 300 },
      { text: 'so', startMs: 380, endMs: 1800 },
      { text: 'then', startMs: 1880, endMs: 2180 },
    ]
    const r = planTighten({ words, durationMs: 2180 })
    expect(r.cuts).toEqual([])
    expect(r.flags).toEqual([expect.objectContaining({ kind: 'swallowed-retake', startMs: 380, endMs: 1800 })])
  })

  it('absorbs slivers between cuts and keeps a clear margin from staying words', () => {
    const words: Word[] = [
      { text: 'Hello', startMs: 0, endMs: 300 },
      { text: 'um', startMs: 1800, endMs: 2100 },
      { text: 'world', startMs: 2180, endMs: 2480 },
    ]
    const r = planTighten({ words, durationMs: 2480 })
    expect(r.cuts).toEqual([{ startMs: 480, endMs: 2160, kinds: ['pause', 'filler'], reason: expect.stringContaining('; filler "um"') }])
  })

  it('never cuts into a word that stays', () => {
    const words: Word[] = [
      { text: 'a', startMs: 0, endMs: 900 },
      { text: 'word', startMs: 1500, endMs: 1900 },
      { text: 'b', startMs: 3100, endMs: 3900 },
    ]
    const speech = [{ startMs: 0, endMs: 1000 }, { startMs: 3000, endMs: 4000 }]
    const r = planTighten({ words, speech, durationMs: 4000 })
    expect(r.cuts.map((c) => [c.startMs, c.endMs])).toEqual([[1180, 1480], [1920, 2820]])
    expect(r.removedMs).toBe(300 + 900)
  })
})

describe('searchFootage', () => {
  const words = say(['The', 'quick', 'brown', 'fox', 'jumps.', 600, 'We', 'love', 'editing', 'videos', 'together.'], 100)
  const entries = [
    {
      mediaId: 'm1',
      name: 'interview.mp4',
      words,
      shots: [{ startMs: 0, endMs: 4000, description: 'A woman waving at the camera' }, { startMs: 4000, endMs: 9000, description: null }],
    },
  ]

  it('finds a phrase with in and out around its sentence', () => {
    const [hit] = searchFootage(entries, 'brown fox')
    expect(hit).toMatchObject({ kind: 'words', text: 'brown fox', score: 1, startMs: (words[2] as Word).startMs, endMs: (words[3] as Word).endMs })
    expect(hit?.inMs).toBe(0)
    expect(hit?.outMs).toBe((words[4] as Word).endMs + 150)
  })

  it('scores a sentence by the share of query words, with stems', () => {
    const hits = searchFootage(entries, 'edit love cats', { kind: 'words' })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.score).toBeCloseTo(2 / 3, 5)
    expect(hits[0]?.text).toBe('We love editing videos together.')
    expect(searchFootage(entries, 'cats dogs')).toEqual([])
  })

  it('matches shot descriptions', () => {
    const hits = searchFootage(entries, 'woman camera', { kind: 'shots' })
    expect(hits).toEqual([expect.objectContaining({ kind: 'shot', startMs: 0, endMs: 4000, inMs: 0, outMs: 4000, score: 1, text: 'A woman waving at the camera' })])
    expect(searchFootage(entries, 'woman camera', { kind: 'words' })).toEqual([])
    expect(searchFootage(entries, 'fox', { limit: 1 })).toHaveLength(1)
  })
})

describe('placeBroll', () => {
  const sentences = [{ startMs: 0, endMs: 5000 }, { startMs: 6000, endMs: 9000 }]

  it('insets from the sentence and keeps the asked span', () => {
    const r = placeBroll({ sentences, requests: [{ startMs: 1000, endMs: 4000 }, { startMs: 4000 }, { startMs: 5200 }] })
    expect(r.placed.map((p) => [p.startMs, p.endMs])).toEqual([[1000, 4000], [4000, 4850], [6150, 8850]])
    expect(r.rejected).toEqual([])
  })

  it('rejects by relevance, place and length', () => {
    const r = placeBroll({
      sentences,
      requests: [{ startMs: 1000, relevance: 0.2 }, { startMs: 9500 }, { startMs: 8700 }, { startMs: 1000, endMs: 1500 }],
    })
    expect(r.placed).toEqual([])
    expect(r.rejected.map((x) => x.index)).toEqual([0, 1, 2, 3])
    expect(r.rejected[1]?.reason).toBe('not inside a sentence')
    expect(r.rejected[2]?.reason).toMatch(/^too short/)
  })

  it('stays off protected beats and other cutaways', () => {
    const r = placeBroll({
      sentences,
      protected: [{ startMs: 1000, endMs: 2000 }],
      requests: [{ startMs: 500, endMs: 2500 }, { startMs: 2000, endMs: 4000 }, { startMs: 2500, endMs: 4500 }],
    })
    expect(r.placed).toEqual([{ index: 1, startMs: 2000, endMs: 4000 }])
    expect(r.rejected).toEqual([
      { index: 0, reason: 'covers a protected beat' },
      { index: 2, reason: 'overlaps another cutaway' },
    ])
  })
})

describe('time mapping', () => {
  const layer = { startMs: 1000, durationMs: 2000, sourceStartMs: 4000, playbackRate: 2 }

  it('maps both ways at double speed', () => {
    expect(mediaToComp(layer, 5000)).toBe(1500)
    expect(compToMedia(layer, 1500)).toBe(5000)
    expect(compToMedia(layer, mediaToComp(layer, 7777))).toBeCloseTo(7777, 6)
  })

  it('clips spans to the layer and drops those outside', () => {
    const spans = [{ startMs: 4000, endMs: 10000 }, { startMs: 0, endMs: 3000 }, { startMs: 4200, endMs: 4600 }]
    expect(spansToComp(layer, spans)).toEqual([{ startMs: 1000, endMs: 3000 }, { startMs: 1100, endMs: 1300 }])
  })
})
