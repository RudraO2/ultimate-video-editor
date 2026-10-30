import type { Comp } from '@uve/core'

/** The 3D world renderer (three.js), loaded the first time a world is drawn. */
export type WorldModule = typeof import('./world/index')

/**
 * Loads `./world/` on demand. It is the only way the rest of the engine
 * reaches three.js, so a flat project never pays for it. `load` is the
 * import itself, replaceable in tests.
 */
export const worldLoader = {
  load: (): Promise<WorldModule> => import('./world/index'),
  /** The module once loaded. */
  module: null as WorldModule | null,
  pending: null as Promise<WorldModule> | null,
  /** Loads the module (once); resolves with it. */
  ensure(): Promise<WorldModule> {
    if (this.module) return Promise.resolve(this.module)
    this.pending ??= this.load().then(
      (m) => {
        this.module = m
        return m
      },
      (error) => {
        this.pending = null
        throw error
      },
    )
    return this.pending
  },
}

/** Whether drawing a comp needs the world renderer: it is a world, or it nests one (at any depth). */
export function usesWorld(comp: Comp, comps: readonly Comp[], seen: Set<string> = new Set()): boolean {
  if (comp.world !== undefined) return true
  if (seen.has(comp.id)) return false
  seen.add(comp.id)
  for (const track of comp.tracks) {
    for (const layer of track.layers) {
      if (layer.kind !== 'nested') continue
      const source = comps.find((c) => c.id === layer.sourceCompId)
      if (source && usesWorld(source, comps, seen)) return true
    }
  }
  return false
}
