// Timing a comp in another language: each voice take keeps its own phrase,
// and a take that runs longer than the room it had is either read a little
// faster or given more room. Pure, so comp_localize's plan can be tested.

/** A voice take on the timeline: where its speech starts and ends, comp ms. */
export interface PlacedTake {
  id: string
  speechStartMs: number
  speechEndMs: number
}

/** How long each take may speak before the next one starts (less a breath), or before the comp ends. */
export function takeSlots(takes: readonly PlacedTake[], compEndMs: number, breathMs = 250): { id: string; slotMs: number }[] {
  const sorted = [...takes].sort((a, b) => a.speechStartMs - b.speechStartMs)
  return sorted.map((take, i) => {
    const next = sorted[i + 1]
    const limit = next ? next.speechStartMs - breathMs : compEndMs - breathMs
    // Never less than the take had: the original already fitted there.
    return { id: take.id, slotMs: Math.max(take.speechEndMs - take.speechStartMs, limit - take.speechStartMs) }
  })
}

/**
 * The pace to read a take at so it fits its slot, no faster than maxPace;
 * overflowMs is what still does not fit (room to make after it). Speech length
 * goes as 1 / pace.
 */
export function fitPace(newSpeechMs: number, slotMs: number, pace = 1, maxPace = 1.25): { pace: number; overflowMs: number } {
  if (newSpeechMs <= slotMs || slotMs <= 0) return { pace, overflowMs: Math.max(0, newSpeechMs - Math.max(0, slotMs)) }
  const wanted = (pace * newSpeechMs) / slotMs
  const chosen = Math.min(Math.max(pace, maxPace), Math.ceil(wanted * 100 - 1e-6) / 100)
  const predicted = (newSpeechMs * pace) / chosen
  return { pace: chosen, overflowMs: Math.max(0, Math.round(predicted - slotMs)) }
}

/** A piece of a take on the timeline: where it sits in the comp and which part of the file it plays. */
export interface TakePiece {
  startMs: number
  durationMs: number
  sourceStartMs: number
  playbackRate: number
}

/**
 * A take's words (file time) in comp time, through every piece of it on the
 * timeline: after a cut the take is several layers, each playing its own part
 * of the file. A word whose middle falls in no piece was cut and is left out;
 * the rest are clipped to their piece.
 */
export function wordsOnTimeline<W extends { startMs: number; endMs: number }>(pieces: readonly TakePiece[], words: readonly W[]): W[] {
  const out: W[] = []
  for (const word of words) {
    const middle = (word.startMs + word.endMs) / 2
    const piece = pieces.find((p) => middle >= p.sourceStartMs && middle < p.sourceStartMs + p.durationMs * p.playbackRate)
    if (!piece) continue
    const at = (ms: number) => piece.startMs + (ms - piece.sourceStartMs) / piece.playbackRate
    const startMs = Math.max(piece.startMs, at(word.startMs))
    const endMs = Math.min(piece.startMs + piece.durationMs, at(word.endMs))
    out.push({ ...word, startMs: Math.round(startMs), endMs: Math.round(Math.max(startMs, endMs)) })
  }
  return out.sort((a, b) => a.startMs - b.startMs)
}
