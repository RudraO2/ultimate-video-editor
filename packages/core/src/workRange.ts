// The working range: a span of one comp that playback and export are limited to.
// It is editor state (not document data): never undone, never saved in the project file.

/** A span of the comp with this id, in ms. */
export interface WorkRange {
  compId: string
  startMs: number
  endMs: number
}

/** The shortest span that counts as a working range. */
export const MIN_WORK_RANGE_MS = 100

/** The range in force on a comp: null unless it is on, on this comp, and at least `MIN_WORK_RANGE_MS` long. */
export function activeWorkRange(
  range: WorkRange | null,
  enabled: boolean,
  compId: string,
): { startMs: number; endMs: number } | null {
  if (!enabled || range === null || range.compId !== compId) return null
  if (!(range.endMs - range.startMs >= MIN_WORK_RANGE_MS)) return null
  return { startMs: range.startMs, endMs: range.endMs }
}

/** Fits a range inside a comp of `durationMs`: whole ms, start ≤ end − 100. A comp under 100 ms gets its whole length. */
export function clampWorkRange(range: WorkRange, durationMs: number): WorkRange {
  const duration = Math.max(0, Math.round(durationMs))
  if (duration < MIN_WORK_RANGE_MS) return { compId: range.compId, startMs: 0, endMs: duration }
  const startMs = Math.min(duration - MIN_WORK_RANGE_MS, Math.max(0, Math.round(range.startMs)))
  const endMs = Math.min(duration, Math.max(startMs + MIN_WORK_RANGE_MS, Math.round(range.endMs)))
  return { compId: range.compId, startMs, endMs }
}

/** The span playback and export cover: the active working range, else the whole comp. */
export function workRangeSpan(
  range: WorkRange | null,
  enabled: boolean,
  compId: string,
  durationMs: number,
): { startMs: number; endMs: number } {
  return activeWorkRange(range, enabled, compId) ?? { startMs: 0, endMs: durationMs }
}
