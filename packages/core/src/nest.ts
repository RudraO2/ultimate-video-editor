import type { Comp, Layer, NestedLayer, Project } from './schema'

// Nested comps: a layer that shows another comp, with its own clock.

/** Where a nested layer's clock is at a comp time: the source time, and which pass of a loop it is. */
export interface NestedTime {
  /** Source comp time, ms. */
  timeMs: number
  /** 0 for the first pass; loops count up. A pingpong pass that runs back is odd. */
  cycle: number
}

/** The length of one pass in source ms: `loopLengthMs`, or the source from `trimInMs` to its end. */
export function nestedCycleMs(layer: NestedLayer, sourceDurationMs: number): number {
  return layer.playback.loopLengthMs ?? Math.max(0, sourceDurationMs - layer.trimInMs)
}

/**
 * The source time a nested layer shows at comp time `timeMs`, or null when it
 * shows nothing then (before its start, after its end, or past the end of a
 * source that plays once).
 */
export function nestedTime(layer: NestedLayer, sourceDurationMs: number, timeMs: number): NestedTime | null {
  if (timeMs < layer.startMs || timeMs >= layer.startMs + layer.durationMs) return null
  const elapsed = (timeMs - layer.startMs) * layer.playback.speed
  const cycle = nestedCycleMs(layer, sourceDurationMs)
  if (cycle <= 0) return null
  switch (layer.playback.loop) {
    case 'none':
      return elapsed < cycle ? { timeMs: layer.trimInMs + elapsed, cycle: 0 } : null
    case 'loop': {
      const pass = Math.floor(elapsed / cycle)
      return { timeMs: layer.trimInMs + (elapsed - pass * cycle), cycle: pass }
    }
    case 'pingpong': {
      const pass = Math.floor(elapsed / cycle)
      const within = elapsed - pass * cycle
      return { timeMs: layer.trimInMs + (pass % 2 === 0 ? within : cycle - within), cycle: pass }
    }
  }
}

/** Every nested layer, in any comp, that shows `compId`. */
export function layersShowing(project: Project, compId: string): NestedLayer[] {
  return project.comps.flatMap((c) =>
    c.tracks.flatMap((t) => t.layers.filter((l): l is NestedLayer => l.kind === 'nested' && l.sourceCompId === compId)),
  )
}

/** How a nested layer holds its source: its own (embedded, shown nowhere else) or linked (a comp of the project, or one others show too). */
export function nestedInside(project: Project, layer: NestedLayer): 'embedded' | 'linked' {
  const source = project.comps.find((c) => c.id === layer.sourceCompId)
  return source?.embedded && layersShowing(project, source.id).length === 1 ? 'embedded' : 'linked'
}

/** The comps a comp shows through nested layers, directly or deeper. */
export function compsInside(project: Project, compId: string): Set<string> {
  const found = new Set<string>()
  const walk = (id: string) => {
    const comp = project.comps.find((c) => c.id === id)
    for (const layer of comp?.tracks.flatMap((t) => t.layers) ?? []) {
      if (layer.kind === 'nested' && !found.has(layer.sourceCompId)) {
        found.add(layer.sourceCompId)
        walk(layer.sourceCompId)
      }
    }
  }
  walk(compId)
  return found
}

/** Whether showing `sourceId` inside `hostId` would make a comp show itself. */
export function nestingLoops(project: Project, hostId: string, sourceId: string): boolean {
  return hostId === sourceId || compsInside(project, sourceId).has(hostId)
}

/** Embedded comps no nested layer shows any more (their layer was deleted). */
export function orphanedEmbeddedComps(project: Project): Comp[] {
  const shown = new Set(project.comps.flatMap((c) => c.tracks.flatMap((t) => t.layers)).flatMap((l: Layer) => (l.kind === 'nested' ? [l.sourceCompId] : [])))
  return project.comps.filter((c) => c.embedded && !shown.has(c.id))
}
