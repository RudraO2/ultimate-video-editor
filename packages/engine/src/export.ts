import { type Comp, frameToMs } from '@uve/core'

/** What rendering a comp to a video file produces: the picture size, the frame clock and the length. */
export interface RenderPlan {
  width: number
  height: number
  /** The scale asked for: output pixels per comp pixel (1 draws at the comp's own size). Used to draw. */
  scale: number
  /** The output frame rate: the comp's own unless the export asked for another. */
  fps: number
  /** The comp frame that output frame 0 shows: 0 for a whole comp, later for a span. */
  firstFrame: number
  /** The comp time of output frame 0, in ms: `frameToMs(firstFrame, fps)`. */
  startMs: number
  /** Output frame n shows the comp at `frameToMs(firstFrame + n, fps)`. */
  frameCount: number
  /** The file's length in ms: whole frames, so it can pass the comp's end by less than one frame. */
  durationMs: number
}

/**
 * Plans a render of a comp (or of a span of it) at its own size, or at an
 * output `scale` and frame rate. H.264 with 4:2:0 colour needs even sides, so
 * an odd side loses its last pixel row or column; a side is at least 2.
 */
export function renderPlan(
  comp: Comp,
  span?: { startMs: number; endMs: number },
  output?: { scale?: number; fps?: number },
): RenderPlan {
  const even = (side: number) => side - (side % 2)
  const scale = output?.scale ?? 1
  const fps = output?.fps ?? comp.fps
  const size = (side: number) => Math.max(2, even(Math.round(side * scale)))
  const frameAt = (ms: number) => Math.ceil((ms * fps) / 1000 - 1e-6)
  // Every frame that starts inside the span (before the comp's end) is shown, as in the preview.
  const firstFrame = span ? Math.max(0, frameAt(span.startMs)) : 0
  const frameCount = Math.max(1, frameAt(span ? span.endMs : comp.durationMs) - firstFrame)
  return {
    width: size(comp.width),
    height: size(comp.height),
    scale,
    fps,
    firstFrame,
    startMs: frameToMs(firstFrame, fps),
    frameCount,
    durationMs: frameToMs(frameCount, fps),
  }
}
