import type { RecordingSource } from '../../../shared/recording'

export type SourceMatch = { ok: true; source: RecordingSource } | { ok: false; error: string }

const MAIN_WORDS = new Set(['screen', 'display', 'main', 'primary'])

/**
 * Picks what to record from the agent's words: nothing or "screen", "display",
 * "main" = the main display; an exact id; else a name (exact, then a
 * case-insensitive substring). No match lists the names there are.
 */
export function matchSource(sources: readonly RecordingSource[], query?: string): SourceMatch {
  const q = query?.trim().toLowerCase() ?? ''
  if (q === '' || MAIN_WORDS.has(q)) {
    const main = sources.find((s) => s.kind === 'display' && s.primary) ?? sources.find((s) => s.kind === 'display')
    return main ? { ok: true, source: main } : { ok: false, error: 'No display found to record.' }
  }
  const found =
    sources.find((s) => s.id.toLowerCase() === q) ?? sources.find((s) => s.name.toLowerCase() === q) ?? sources.find((s) => s.name.toLowerCase().includes(q))
  if (found) return { ok: true, source: found }
  const names = sources.map((s) => `"${s.name}" (${s.kind})`).join(', ')
  return { ok: false, error: `No screen or window matches "${query}". Available: ${names || 'none'}.` }
}
