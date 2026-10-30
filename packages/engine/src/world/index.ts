import type { Comp, Layer } from '@uve/core'
import type { SceneNode, SceneSource } from '../scene'
import { buildWorldFrame, pickPlane, planeCorners, worldScene as proxyScene } from './frame'
import type { WorldHost } from './host'
import { orbitPick } from './orbitPick'
import { orbitBounds, releaseOrbit, renderOrbit } from './orbitView'
import { drawWorld, releaseWorlds as releaseScenes, setForceTargets } from './stage'
import { frameBuilder, planWorldBlur } from './worldBlur'

// The 3D world renderer's entry point. Everything that imports three.js lives
// under this folder, and the rest of the engine reaches it only through a
// dynamic import (see ../worldLoader.ts), so flat projects never load it.

export type { WorldHost } from './host'

/**
 * Draws a world at a time onto the shared WebGL canvas, at the given size, and
 * returns that canvas to be drawn over right away; null when WebGL is not
 * available. `source` builds the pictures (its `worlds` painter draws worlds
 * nested in flat comps that the pictures nest). With the comp's motion blur on
 * (and `options.motionBlur` not false) a frame whose pictures or camera move
 * is drawn at several moments of the live camera's shutter, at most
 * `options.maxSamples`.
 */
export function renderWorld(host: WorldHost, comp: Comp, source: SceneSource, timeMs: number, width: number, height: number, options: WorldRenderOptions = {}): OffscreenCanvas | null {
  const frame = buildWorldFrame(comp, source, timeMs)
  const samples = planWorldBlur(frame, frameBuilder(comp, source), timeMs, width, options)
  return drawWorld(host, frame, width, height, samples ?? undefined)
}

/** What a caller may ask of a world render. */
export interface WorldRenderOptions {
  /** false draws no motion blur. */
  motionBlur?: boolean
  /** Caps the moments drawn (a draft while playing). */
  maxSamples?: number
}

/** The world's pictures as the flat renderer sees them (their flat equivalents), for placements. */
export function worldScene(comp: Comp, source: SceneSource, timeMs: number): SceneNode[] {
  return proxyScene(comp, source, timeMs)
}

/** A picture layer's four corners in comp pixels through the world's camera, or null when it is not visible. */
export function worldCorners(comp: Comp, source: SceneSource, timeMs: number, layerId: string): [number, number][] | null {
  const frame = buildWorldFrame(comp, source, timeMs)
  const plane = frame.planes.find((p) => p.id === layerId)
  return plane ? planeCorners(frame, plane) : null
}

/** The picture layer under a point in comp pixels, nearest to the world's camera first. */
export function worldPick(comp: Comp, source: SceneSource, timeMs: number, point: [number, number], includeLocked = false): Layer | null {
  const frame = buildWorldFrame(comp, source, timeMs)
  return pickPlane(frame, point, includeLocked)?.layer ?? null
}

/** Reading model files (see models.ts). */
export { preloadModels, probeModel } from './models'

/** The orbit view (editor only; see orbitView.ts and orbitPick.ts). */
export { orbitBounds, orbitPick, renderOrbit }

/** Lets go of every texture and scene a host holds, the orbit views' included (the host is going away). */
export function releaseWorlds(host: WorldHost): void {
  releaseOrbit(host)
  releaseScenes(host)
}

/** For checks: sends every frame through the render targets (see stage.ts). */
export { setForceTargets }
