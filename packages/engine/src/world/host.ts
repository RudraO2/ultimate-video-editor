import type { Comp } from '@uve/core'
import type { Rect, SceneNode } from '../scene'

/**
 * What the 3D world renderer needs from the 2D renderer: the reach of a
 * picture past its box, and a picture drawn alone onto a canvas (effects
 * included). `CompRenderer` implements it, so nested comps, effects and blur
 * draw exactly as they do in a flat comp.
 */
export interface WorldHost {
  /** How far a node's pixels reach past its box in its own space, px (strokes, effect cards, blur). */
  reach(node: SceneNode): number
  /**
   * Draws a stand-alone node (see `standAlone`) onto a canvas of `width` ×
   * `height` texels that stands for `rect` of the node's own space at
   * `raster` texels per px. `into` is reused when it has that size.
   */
  drawAlone(node: SceneNode, comp: Comp, rect: Rect, raster: number, width: number, height: number, into?: OffscreenCanvas): OffscreenCanvas
  /** Called when a 3D model file finishes loading after a frame was drawn without it: draw again. */
  modelLoaded?: () => void
}
