import type { Comp, Layer, Project } from '@uve/core'

// What the editor tells OpenCode with every message: where the person is, so
// "this" and "here" in the prompt mean something. Pure: takes the store state.

/** The part of the editor store this reads. */
export interface ContextState {
  project: Project
  activeCompId: string
  timeMs: number
  selectedLayerId: string | null
}

/** Longest stretch of a text layer's words that is passed on. */
const TEXT_MAX = 200

const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** The comp holding the layer, and the index of the track it sits on. */
function whereIs(comps: readonly Comp[], id: string, first: Comp | undefined): { comp: Comp; layer: Layer; track: number } | null {
  // The open comp first: ids are unique, but it is where the selection normally is.
  for (const comp of first ? [first, ...comps.filter((c) => c !== first)] : comps) {
    for (const [track, lane] of comp.tracks.entries()) {
      const layer = lane.layers.find((l) => l.id === id)
      if (layer) return { comp, layer, track }
    }
  }
  return null
}

/** A short plain-text block about the open comp, the playhead and the selection. */
export function editorContext(state: ContextState): string {
  const comps = state.project.comps
  const comp = comps.find((c) => c.id === state.activeCompId) ?? comps[0]
  const lines = ['Editor context (where the person is; "this" and "here" mean the selection and the playhead):']
  if (!comp) {
    lines.push('Open comp: none')
    return lines.join('\n')
  }
  lines.push(`Open comp: "${comp.name}" (id ${comp.id}), ${comp.width}x${comp.height}, ${comp.fps} fps, ${Math.round(comp.durationMs)} ms long`)
  lines.push(`Playhead: ${Math.round(state.timeMs)} ms`)
  const found = state.selectedLayerId ? whereIs(comps, state.selectedLayerId, comp) : null
  if (found) {
    const { layer, track } = found
    const end = Math.round(layer.startMs + layer.durationMs)
    const where = found.comp.id === comp.id ? '' : ` in comp "${found.comp.name}" (id ${found.comp.id})`
    lines.push(`Selected layer: "${layer.name}" (id ${layer.id}), ${layer.kind}, ${Math.round(layer.startMs)}-${end} ms, track ${track}${where}`)
    if (layer.kind === 'text') lines.push(`Selected text: "${oneLine(layer.text, TEXT_MAX)}"`)
  } else {
    lines.push('Selected layer: nothing selected')
  }
  const mode = (state as { uiMode?: string }).uiMode
  if (mode) lines.push(`Editor mode: ${mode}`)
  return lines.join('\n')
}
