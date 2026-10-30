import type { Draft } from 'immer'
import { z } from 'zod'
import { findComp, layerEnd } from '../doc'
import { CommandError } from '../errors'
import { defineCommand } from '../registry'
import { type Comp, IdSchema } from '../schema'

// Making room in a comp: the inverse of timeline.cut_ranges. Everything at or
// after a moment slides later; what spans it holds on longer, its keys and
// caption cues after the moment sliding with the rest. A longer voice take in
// another language makes room this way (comp_localize).

/** Times closer than this are the same moment. */
const EPS = 0.5

/** Opens `addMs` of time at comp time `atMs`, in place. Returns how many layers moved and how many held longer. */
export function insertTime(comp: Draft<Comp>, atMs: number, addMs: number): { moved: number; extended: number } {
  let moved = 0
  let extended = 0
  if (addMs <= 0) return { moved, extended }
  for (const track of comp.tracks) {
    for (const layer of track.layers) {
      if (layer.startMs >= atMs - EPS) {
        layer.startMs += addMs
        moved++
      } else if (layerEnd(layer) > atMs + EPS) {
        // Spans the moment: it lasts longer, and what it does after the moment happens later.
        const split = atMs - layer.startMs
        layer.durationMs += addMs
        for (const keys of Object.values(layer.animations)) for (const key of keys) if (key.t > split + EPS) key.t += addMs
        if (layer.kind === 'text' && layer.caption) {
          for (const cue of layer.caption.cues) {
            if (cue.startMs >= split - EPS) {
              cue.startMs += addMs
              cue.endMs += addMs
            } else if (cue.endMs > split) cue.endMs += addMs
          }
        }
        extended++
      }
    }
  }
  if (comp.physics && comp.physics.startMs >= atMs - EPS) comp.physics.startMs += addMs
  comp.durationMs += addMs
  return { moved, extended }
}

export const timelineInsertTime = defineCommand({
  name: 'timeline.insert_time',
  summary: 'Open a stretch of time in a comp at a moment: everything after slides later, what spans it holds on longer (the inverse of timeline.cut_ranges).',
  details:
    'atMs is comp time; durationMs is how much room to make. Layers starting at or after atMs move later by durationMs on every lane (locked ones too: the comp stays in sync). A layer that spans atMs (a background, a music bed, a caption) lasts durationMs longer; its keys and caption cues after the moment move with the rest. The comp grows by durationMs. Use it to make room for a longer line, a pause, or an insert.',
  effect: 'write',
  input: z.strictObject({
    compId: IdSchema.optional().describe('Default the comp open in the editor (AtomCut: frameId)'),
    atMs: z.number().min(0),
    durationMs: z.number().positive().max(600_000),
  }),
  run: ({ compId, atMs, durationMs }, ctx) => {
    const comp = findComp(ctx.project, compId ?? ctx.view.compId)
    if (atMs > comp.durationMs + EPS) throw new CommandError(`${atMs} ms is past the end of "${comp.name}" (${comp.durationMs} ms).`, 'Give a moment inside the comp, or lengthen it with frame.update.')
    let result = { moved: 0, extended: 0 }
    ctx.write('Insert time', (draft) => {
      result = insertTime(findComp(draft, comp.id), atMs, durationMs)
    })
    return { compId: comp.id, atMs, addedMs: durationMs, durationMs: comp.durationMs + durationMs, ...result }
  },
})
