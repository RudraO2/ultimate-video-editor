/**
 * Keeping a media element (a <video> or <audio> that decodes a clip) in step
 * with the comp clock. The comp clock leads; each element follows: it seeks
 * when it is far off, and while playing, small drift is absorbed by briefly
 * speeding up or slowing down, which is smoother than seeking.
 */

/** What the element reports now. Times are seconds of source media. */
export interface ElementState {
  currentSec: number
  paused: boolean
  seeking: boolean
  /** The playback rate the element currently plays at. */
  rate: number
}

/** Where the element should be. */
export interface SyncGoal {
  targetSec: number
  playing: boolean
  /** The layer's own speed, the rate to return to once in step. */
  rate: number
  /** Length of one source frame, in seconds; a paused element closer than half a frame is in place. */
  frameSec: number
  /** Expected time a seek takes, in seconds; seeks while playing aim that far ahead. */
  seekLatencySec: number
  /** Expected time from asking a paused element to play until it runs, in seconds; it starts that far ahead. */
  startLatencySec: number
  /** Milliseconds since the last rate change and since the last finished seek. */
  sinceRateChangeMs: number
  sinceSeekMs: number
}

export type SyncStep =
  | { action: 'none' }
  | { action: 'seek'; toSec: number }
  | { action: 'play'; rate: number; seekToSec?: number }
  | { action: 'pause'; seekToSec?: number }
  | { action: 'rate'; rate: number }

/** Drift beyond this, while playing, is fixed by seeking rather than by changing speed. */
export const SEEK_DRIFT_SEC = 0.3
/** Drift below this, while playing, is left alone. */
export const DRIFT_TOLERANCE_SEC = 0.025
/** How strongly drift changes the speed (per second of drift), and the largest change allowed. */
const DRIFT_GAIN = 1.5
const MAX_SPEED_CHANGE = 0.2
/** Minimum spacing of speed changes and of corrective seeks, in ms. */
const RATE_INTERVAL_MS = 200
const SEEK_INTERVAL_MS = 300

/** Decides the one thing to do to bring an element in step with the comp clock. */
export function planSync(state: ElementState, goal: SyncGoal): SyncStep {
  const drift = state.currentSec - goal.targetSec

  if (!goal.playing) {
    const off = Math.abs(drift) > goal.frameSec / 2
    if (!state.paused) return off ? { action: 'pause', seekToSec: goal.targetSec } : { action: 'pause' }
    return off ? { action: 'seek', toSec: goal.targetSec } : { action: 'none' }
  }

  if (state.paused) {
    // Elements start a moment after play() is called, so start them that far ahead.
    const lead = goal.targetSec + goal.startLatencySec * goal.rate
    return Math.abs(state.currentSec - lead) > DRIFT_TOLERANCE_SEC
      ? { action: 'play', rate: goal.rate, seekToSec: lead }
      : { action: 'play', rate: goal.rate }
  }
  if (state.seeking) return { action: 'none' }

  if (Math.abs(drift) > SEEK_DRIFT_SEC) {
    if (goal.sinceSeekMs < SEEK_INTERVAL_MS) return { action: 'none' }
    return { action: 'seek', toSec: goal.targetSec + goal.seekLatencySec * goal.rate }
  }

  if (goal.sinceRateChangeMs < RATE_INTERVAL_MS) return { action: 'none' }
  const correction =
    Math.abs(drift) < DRIFT_TOLERANCE_SEC ? 0 : Math.max(-MAX_SPEED_CHANGE, Math.min(MAX_SPEED_CHANGE, -DRIFT_GAIN * drift))
  const rate = goal.rate * (1 + correction)
  return Math.abs(state.rate - rate) > goal.rate * 0.01 ? { action: 'rate', rate } : { action: 'none' }
}
