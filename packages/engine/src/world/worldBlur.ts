import { type Comp, mat4TransformPoint, type MotionBlurSettings, primitiveSize, projectWorldPoint, shutterSamples, shutterWindow } from '@uve/core'
import { buildWorldFrame, type FrameCamera, planeCorners, type WorldFrame, type WorldMesh } from './frame'
import type { SceneSource } from '../scene'

// Motion blur in a world. The shutter is the live camera's: the comp's master
// switch must be on, the camera layer may switch blur off or bring its own
// shutter, and the default camera uses the comp's master settings. The frame
// is drawn at several moments of that shutter (each a full world frame, so a
// moving camera blurs everything) and the pictures are averaged by their
// weights. A layer whose own motion blur is off is held at the frame time
// (it still moves with a moving camera). Not applied in worlds: the shutter
// `combine` modes other than average, and `sampling` (every sample is a
// whole new frame, which is the exact "content" kind), and a layer's own
// shutter override (the camera's shutter rules the whole frame).

/** Below this, in output px, nothing moves enough to be worth blurring. */
export const BLUR_THRESHOLD_PX = 0.5
/** Moments are about this far apart, output px. */
export const BLUR_STEP_PX = 1.5

/** What can be drawn at a moment: a frame with its weight in the average. */
export interface WorldSample {
  frame: WorldFrame
  weight: number
}

/** The shutter a world uses, or null when its blur is off. */
export function worldShutter(comp: Pick<Comp, 'motionBlur'>, camera: Pick<FrameCamera, 'motionBlur'>): MotionBlurSettings | null {
  if (!comp.motionBlur.enabled) return null
  if (camera.motionBlur && !camera.motionBlur.enabled) return null
  const { enabled: _, ...master } = comp.motionBlur
  const settings = camera.motionBlur?.override ?? master
  if (settings.shutterAngle <= 0 || settings.amount <= 0 || settings.strength <= 0) return null
  return settings
}

/** How many moments a travel of `most` output px needs, at most the shutter's `maxSamples` and the caller's `cap`. */
export function sampleCount(most: number, settings: Pick<MotionBlurSettings, 'maxSamples'>, cap?: number): number {
  return Math.max(2, Math.min(settings.maxSamples, cap ?? Number.POSITIVE_INFINITY, Math.ceil(most / BLUR_STEP_PX) + 1))
}

type Pt = [number, number]

/** A mesh's box in its own space, px: a primitive's size, a model's size from its file, else 200 on a side. */
function meshSize(frame: WorldFrame, mesh: WorldMesh): [number, number, number] {
  const geometry = mesh.geometry
  if (geometry.type === 'primitive') return primitiveSize(geometry.primitive, geometry.params)
  return frame.media.find((m) => m.id === geometry.assetId)?.model?.size ?? [200, 200, 200]
}

/** A mesh's eight bounding-box corners in comp pixels through the frame's camera, or null when one is behind it. */
export function meshCorners(frame: WorldFrame, mesh: WorldMesh): Pt[] | null {
  const [sx, sy, sz] = meshSize(frame, mesh)
  const out: Pt[] = []
  for (const x of [-0.5, 0.5]) {
    for (const y of [-0.5, 0.5]) {
      for (const z of [-0.5, 0.5]) {
        const [wx, wy, wz] = mat4TransformPoint(mesh.matrix, x * sx, y * sy, z * sz)
        const p = projectWorldPoint({ matrix: frame.camera.matrix, spec: frame.camera.lens }, frame.comp.width, frame.comp.height, [wx, wy, wz])
        if (!p) return null
        out.push(p)
      }
    }
  }
  return out
}

const farthest = (from: readonly Pt[], to: readonly Pt[]): number => Math.max(...from.map(([x, y], i) => Math.hypot((to[i] as Pt)[0] - x, (to[i] as Pt)[1] - y)))

/**
 * The most any picture plane's corner or mesh's bounding-box corner moves
 * between two frames of the same world, in output px (`scale` is output px
 * per comp px), each seen through its own frame's camera.
 */
export function worldTravel(a: WorldFrame, b: WorldFrame, scale: number): number {
  let most = 0
  const planes = new Map(b.planes.map((p) => [p.id, p]))
  for (const plane of a.planes) {
    const other = planes.get(plane.id)
    if (!other || plane.opacity <= 0 || other.opacity <= 0) continue
    const from = planeCorners(a, plane)
    const to = planeCorners(b, other)
    if (from && to) most = Math.max(most, farthest(from, to))
  }
  const meshes = new Map(b.meshes.map((m) => [m.id, m]))
  for (const mesh of a.meshes) {
    const other = meshes.get(mesh.id)
    if (!other || mesh.opacity <= 0 || other.opacity <= 0) continue
    const from = meshCorners(a, mesh)
    const to = meshCorners(b, other)
    if (from && to) most = Math.max(most, farthest(from, to))
  }
  return most * scale
}

/** A sample frame where every layer that has its own motion blur off stands where it does in the frame-time frame. */
export function holdUnblurred(sample: WorldFrame, base: WorldFrame): WorldFrame {
  const planes = new Map(base.planes.map((p) => [p.id, p]))
  const meshes = new Map(base.meshes.map((m) => [m.id, m]))
  return {
    ...sample,
    planes: sample.planes.map((p) => (p.layer.motionBlur.enabled ? p : (planes.get(p.id) ?? p))),
    meshes: sample.meshes.map((m) => (m.layer.motionBlur.enabled ? m : (meshes.get(m.id) ?? m))),
  }
}

/**
 * The moments to draw a world frame at, with their weights (summing to 1),
 * or null when it needs no blur: blur is off, or nothing moves more than half
 * an output px while the shutter is open. `build` makes the world at a comp
 * time; `base` is the frame at `timeMs`. A strength under 1 keeps the sharp
 * frame in the mix.
 */
export function planWorldBlur(
  base: WorldFrame,
  build: (timeMs: number) => WorldFrame,
  timeMs: number,
  outWidth: number,
  options: { motionBlur?: boolean; maxSamples?: number } = {},
): WorldSample[] | null {
  const { comp } = base
  if (options.motionBlur === false || comp.mode === 'static') return null
  const settings = worldShutter(comp, base.camera)
  if (!settings) return null
  const [open, close] = shutterWindow(settings, timeMs, comp.fps)
  const first = build(open)
  const last = build(close)
  const scale = outWidth / comp.width
  const most = Math.max(worldTravel(first, base, scale), worldTravel(base, last, scale), worldTravel(first, last, scale))
  if (most <= BLUR_THRESHOLD_PX) return null
  const count = sampleCount(most, settings, options.maxSamples)
  const moments = shutterSamples(settings, timeMs, comp.fps, count)
  const kept = settings.strength
  const samples = moments.map((m): WorldSample => ({ frame: holdUnblurred(build(m.timeMs), base), weight: m.weight * kept }))
  if (kept < 1) samples.push({ frame: base, weight: 1 - kept })
  return samples
}

/** The world at a comp time, as `planWorldBlur` builds its moments. */
export const frameBuilder =
  (comp: Comp, source: SceneSource) =>
  (timeMs: number): WorldFrame =>
    buildWorldFrame(comp, source, timeMs)
