// Auto-zoom for screen recordings: zooms on clicks, from the cursor sidecar
// (`<video>.cursor.json`) that the recorder keeps beside each recording.
//
// The shot planner is ported from OpenScreen's
// src/lib/ai-edition/timeline/zoom-suggestions.ts, zoom-scale.ts and
// zoomMath/constants.ts (MIT, copyright Siddharth Vaddem and the OpenScreen
// contributors, https://github.com/getopenscreen/openscreen): clicks close in
// time and space become one shot, each shot starts a little before its first
// click and holds a little after its last, the depth is the deepest that keeps
// every click of the shot in view, the opening and closing stay wide, and shots
// too close to fall back to wide in between are merged or dropped. Our part
// turns the shots into ordinary keyframes on the clip (scale and position).
// Plain TypeScript only.

import type { CursorRecording, CursorSample } from './recording'

/** OpenScreen's zoom depths and their scales. */
export const ZOOM_DEPTH_SCALES = { 1: 1.25, 2: 1.5, 3: 1.8, 4: 2.2, 5: 3.5, 6: 5.0 } as const
export type ZoomDepth = keyof typeof ZOOM_DEPTH_SCALES

export const OPENING_WIDE_MS = 2500
export const CLOSING_WIDE_MS = 1000
export const STOP_CLICK_GUARD_MS = 1000
export const SHOT_MERGE_GAP_MS = 3000
export const SHOT_LEAD_MS = 500
export const SHOT_TAIL_MS = 1500
export const MIN_SHOT_HOLD_MS = 1800
export const MIN_WIDE_BETWEEN_MS = 1500
export const SHOT_FIT_MARGIN = 0.12
const SHOT_DEPTHS: readonly ZoomDepth[] = [1, 2, 3]

/** How long a zoom takes to get in (and out): about 0.7 s at 1.25x, 0.9 s at 1.8x. */
export function zoomTransitionMs(scale: number): number {
  return 600 + 550 * Math.log(Math.max(1, scale))
}

/** A planned zoom, in the recording's own time: fully in from startMs to endMs, ramping in before and out after. */
export interface ZoomShot {
  startMs: number
  endMs: number
  /** Where to look, as fractions of the video (0.5 the middle). */
  cx: number
  cy: number
  scale: number
  clicks: number
}

interface Click {
  timeMs: number
  cx: number
  cy: number
}

interface Box {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

interface Shot {
  start: number
  end: number
  depth: ZoomDepth
  box: Box
  clicks: number
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/**
 * The left clicks of a recording, in video fractions. A window recording's
 * sampler bounds include the window's invisible resize frame (11 px each side
 * when maximised), so positions are moved onto the video's own pixels.
 */
export function recordedClicks(recording: CursorRecording, video?: { width: number; height: number }): Click[] {
  const surface = recording.surface
  let mapX = (cx: number) => cx
  let mapY = (cy: number) => cy
  if (surface && surface.kind === 'window' && video && video.width > 0 && video.height > 0) {
    const padX = (surface.width - video.width) / 2
    const padY = (surface.height - video.height) / 2
    if (padX > 0 && padX < 40) mapX = (cx) => (cx * surface.width - padX) / video.width
    if (padY > 0 && padY < 40) mapY = (cy) => (cy * surface.height - padY) / video.height
  }
  const samples = [...recording.samples].filter((s) => Number.isFinite(s.timeMs) && Number.isFinite(s.cx) && Number.isFinite(s.cy)).sort((a, b) => a.timeMs - b.timeMs)
  const clicks: Click[] = []
  let pending: CursorSample | null = null
  let hiddenAt: number | null = null
  const finish = (released: boolean) => {
    if (!pending) return
    const hidden = hiddenAt !== null && (released || hiddenAt - pending.timeMs <= 150)
    if (!hidden) clicks.push({ timeMs: pending.timeMs, cx: clamp01(mapX(pending.cx)), cy: clamp01(mapY(pending.cy)) })
    pending = null
    hiddenAt = null
  }
  for (const s of samples) {
    if (s.interactionType === 'click') {
      finish(false)
      pending = s.visible === false ? null : s
    } else if (s.interactionType === 'mouseup') finish(true)
    else if (pending && s.visible === false && hiddenAt === null) hiddenAt = s.timeMs
  }
  finish(false)
  return clicks
}

const around = (c: Click): Box => ({ minX: c.cx, maxX: c.cx, minY: c.cy, maxY: c.cy })
const union = (a: Box, b: Box): Box => ({ minX: Math.min(a.minX, b.minX), maxX: Math.max(a.maxX, b.maxX), minY: Math.min(a.minY, b.minY), maxY: Math.max(a.maxY, b.maxY) })

function fitDepth(box: Box): ZoomDepth | null {
  const size = Math.max(box.maxX - box.minX, box.maxY - box.minY) + 2 * SHOT_FIT_MARGIN
  let fit: ZoomDepth | null = null
  for (const depth of SHOT_DEPTHS) if (ZOOM_DEPTH_SCALES[depth] * size <= 1) fit = depth
  return fit
}

function planShots(clicks: Click[], totalMs: number, wideUntilMs: number, wideFromMs: number): Shot[] {
  const groups: { times: number[]; box: Box }[] = []
  for (const click of clicks) {
    const group = groups.at(-1)
    if (group && click.timeMs - group.times.at(-1)! <= SHOT_MERGE_GAP_MS) {
      const box = union(group.box, around(click))
      if (fitDepth(box) !== null) {
        group.times.push(click.timeMs)
        group.box = box
        continue
      }
    }
    groups.push({ times: [click.timeMs], box: around(click) })
  }
  const shots: Shot[] = []
  for (const { times, box } of groups) {
    const depth = fitDepth(box) ?? SHOT_DEPTHS[0]!
    const ramp = zoomTransitionMs(ZOOM_DEPTH_SCALES[depth])
    const earliest = Math.max(0, Math.ceil(wideUntilMs + ramp))
    const latest = Math.min(totalMs, Math.floor(wideFromMs - ramp))
    const first = times[0]!
    const last = times.at(-1)!
    const start = Math.max(Math.min(Math.round(first - SHOT_LEAD_MS), latest - MIN_SHOT_HOLD_MS), earliest)
    const end = Math.min(Math.max(Math.round(last + SHOT_TAIL_MS), start + MIN_SHOT_HOLD_MS), latest)
    if (end - start < MIN_SHOT_HOLD_MS) continue
    if (!times.some((t) => t >= start && t <= end)) continue
    shots.push({ start, end, depth, box, clicks: times.length })
  }
  return shots
}

/** Shots too close to go wide in between: merged when they fit one view, else the one with fewer clicks goes. */
function resolveShots(shots: Shot[]): Shot[] {
  const plan = [...shots].sort((a, b) => a.start - b.start)
  for (;;) {
    let clash: [Shot, Shot] | null = null
    for (let i = 1; i < plan.length; i++) {
      const a = plan[i - 1]!
      const b = plan[i]!
      const wide = b.start - (a.end + zoomTransitionMs(ZOOM_DEPTH_SCALES[a.depth])) - zoomTransitionMs(ZOOM_DEPTH_SCALES[b.depth])
      if (wide < MIN_WIDE_BETWEEN_MS) {
        clash = [a, b]
        break
      }
    }
    if (!clash) return plan
    const [a, b] = clash
    const box = union(a.box, b.box)
    const depth = fitDepth(box)
    if (depth !== null) {
      plan.splice(plan.indexOf(a), 2, { start: a.start, end: Math.max(a.end, b.end), depth, box, clicks: a.clicks + b.clicks })
    } else {
      plan.splice(plan.indexOf(a.clicks >= b.clicks ? b : a), 1)
    }
  }
}

/**
 * Plans the zooms of a recording between fromMs and toMs (recording time; the
 * part a clip shows). `depth` forces one depth for every shot instead of the
 * deepest that fits. Clicks in the last second (the click on Stop) are ignored.
 */
export function planAutoZoom(
  recording: CursorRecording,
  options: { fromMs: number; toMs: number; video?: { width: number; height: number }; depth?: ZoomDepth },
): ZoomShot[] {
  const { fromMs, toMs } = options
  const windowMs = toMs - fromMs
  if (windowMs <= 0 || recording.samples.length === 0) return []
  const lastSample = recording.samples.reduce((m, s) => Math.max(m, s.timeMs), 0)
  const clicks = recordedClicks(recording, options.video)
    .filter((c) => c.timeMs >= fromMs && c.timeMs <= toMs && c.timeMs < lastSample - STOP_CLICK_GUARD_MS)
    .map((c) => ({ ...c, timeMs: c.timeMs - fromMs }))
  const shots = resolveShots(planShots(clicks, windowMs, OPENING_WIDE_MS, windowMs - CLOSING_WIDE_MS))
  return shots.map((shot) => {
    const scale = options.depth ? ZOOM_DEPTH_SCALES[options.depth] : ZOOM_DEPTH_SCALES[shot.depth]
    const half = 1 / (2 * scale)
    const cx = (shot.box.minX + shot.box.maxX) / 2
    const cy = (shot.box.minY + shot.box.maxY) / 2
    return {
      startMs: shot.start + fromMs,
      endMs: shot.end + fromMs,
      // Keep the zoomed view inside the picture.
      cx: Math.min(1 - half, Math.max(half, cx)),
      cy: Math.min(1 - half, Math.max(half, cy)),
      scale,
      clicks: shot.clicks,
    }
  })
}

/** The ease of a zoom ramp: a soft start and a gentle landing, close to OpenScreen's critically damped spring. */
export const ZOOM_EASE = 'cubic-bezier(0.25, 0.8, 0.3, 1)'

export interface ZoomKey {
  t: number
  v: number | [number, number]
  ease: string
}

/**
 * Keyframes for a clip from its zoom shots. The clip's base look (position,
 * uniform scale, pivot, box size) stays the rest pose; a shot fills the clip's
 * own footprint with the part of the video around (cx, cy). Times are layer
 * times: (recording time - sourceStartMs) / playbackRate.
 */
export function zoomKeyframes(
  shots: readonly ZoomShot[],
  clip: { x: number; y: number; scale: number; anchorX: number; anchorY: number; width: number; height: number; sourceStartMs: number; playbackRate: number; durationMs: number },
): { scale: ZoomKey[]; position: ZoomKey[] } {
  const toLayer = (ms: number) => (ms - clip.sourceStartMs) / clip.playbackRate
  // The centre of the clip's footprint, in comp space.
  const centreX = clip.x + clip.scale * (0.5 - clip.anchorX) * clip.width
  const centreY = clip.y + clip.scale * (0.5 - clip.anchorY) * clip.height
  const rest = (t: number): [ZoomKey, ZoomKey] => [
    { t, v: clip.scale, ease: ZOOM_EASE },
    { t, v: [clip.x, clip.y], ease: ZOOM_EASE },
  ]
  const scale: ZoomKey[] = []
  const position: ZoomKey[] = []
  for (const shot of shots) {
    const s = clip.scale * shot.scale
    const at: [number, number] = [centreX - s * (shot.cx - clip.anchorX) * clip.width, centreY - s * (shot.cy - clip.anchorY) * clip.height]
    const ramp = zoomTransitionMs(shot.scale) / clip.playbackRate
    const inAt = toLayer(shot.startMs)
    const outAt = toLayer(shot.endMs)
    const times = [Math.max(0, inAt - ramp), inAt, outAt, Math.min(clip.durationMs, outAt + ramp)]
    const [s0, p0] = rest(Math.round(times[0]!))
    scale.push(s0, { t: Math.round(times[1]!), v: s, ease: 'linear' }, { t: Math.round(times[2]!), v: s, ease: ZOOM_EASE })
    position.push(p0, { t: Math.round(times[1]!), v: at, ease: 'linear' }, { t: Math.round(times[2]!), v: at, ease: ZOOM_EASE })
    const [s3, p3] = rest(Math.round(times[3]!))
    scale.push(s3)
    position.push(p3)
  }
  return { scale, position }
}
