import type { Bone } from '@uve/core'
import { solveRig } from '@uve/engine'

// The bones of a selected rig, drawn on the viewport and turned by dragging.
// Pure geometry: sizes are CSS px (the artboard's screen space, origin top-left)
// and rig space is the group's own space before its transform (comp px, y down).

export type Pt = [x: number, y: number]

/** Pointer distance that grabs a bone's tail or body. */
export const BONE_HIT_RADIUS = 8
/** A bone's drawn width is this fraction of its length, up to `BONE_MAX_WIDTH`. */
export const BONE_WIDTH_RATIO = 0.1
export const BONE_MAX_WIDTH = 10
/** The widest point of the diamond sits this far along the bone. */
const BONE_SHOULDER = 0.2
export const JOINT_RADIUS = 3.5
export const CONTROL_RADIUS = 4

/** Colours of the drawing, defined once. The picked bone uses the theme's accent token instead. */
export const BONE_COLORS = {
  neutral: '#e8e4ee',
  left: '#ff6b6b',
  right: '#5aa9ff',
  control: '#ffd166',
  halo: 'rgb(10 10 14 / 62%)',
  /** Fallback for `--color-accent`. */
  accent: '#ff4e6a',
} as const

export type BoneSide = 'left' | 'right' | null

/** Which side a bone's name says it is on (".L", "_L", "Left Arm", "arm.R"…). */
export function sideOf(name: string): BoneSide {
  if (/left/i.test(name) || /(?:^|[._\s-])l(?:$|[._\s-])/i.test(name)) return 'left'
  if (/right/i.test(name) || /(?:^|[._\s-])r(?:$|[._\s-])/i.test(name)) return 'right'
  return null
}

/** A column-major 4x4 (or anything with 16 numbers): only its x and y columns and its translation count. */
type Matrix = readonly number[]

/** The 2D map [a, b, c, d, e, f] of a matrix: x' = a x + c y + e, y' = b x + d y + f. */
function affineOf(m: Matrix): [number, number, number, number, number, number] {
  return [m[0] ?? 1, m[1] ?? 0, m[4] ?? 0, m[5] ?? 1, m[12] ?? 0, m[13] ?? 0]
}

/** Rig space to the artboard's screen, and back. */
export interface RigSpace {
  toScreen: (x: number, y: number) => Pt
  fromScreen: (point: Pt) => Pt
  /** Rig space to comp space (the group's matrix), for points. */
  toComp: (x: number, y: number) => Pt
}

/**
 * Chains the group's matrix with the viewport's comp-to-screen map (which must
 * be affine: the viewport's is a scale and a shift). A singular chain maps back to the origin.
 */
export function rigSpace(groupMatrix: Matrix, compToScreen: (x: number, y: number) => Pt): RigSpace {
  const [a, b, c, d, e, f] = affineOf(groupMatrix)
  const toComp = (x: number, y: number): Pt => [a * x + c * y + e, b * x + d * y + f]
  const to = (x: number, y: number): Pt => {
    const [cx, cy] = toComp(x, y)
    return compToScreen(cx, cy)
  }
  const o = to(0, 0)
  const ex = to(1, 0)
  const ey = to(0, 1)
  const A = ex[0] - o[0]
  const B = ex[1] - o[1]
  const C = ey[0] - o[0]
  const D = ey[1] - o[1]
  const det = A * D - B * C
  const k = Math.abs(det) < 1e-12 ? 0 : 1 / det
  return {
    toScreen: to,
    toComp,
    fromScreen: ([x, y]) => {
      const dx = x - o[0]
      const dy = y - o[1]
      return [(D * dx - C * dy) * k, (-B * dx + A * dy) * k]
    },
  }
}

/** The bone's drawing, in screen px, with what a drag needs. */
export interface BoneShape {
  id: string
  name: string
  side: BoneSide
  /** A control (deform false): moved, not turned by hand. */
  control: boolean
  /** Posed head and tail on screen. */
  head: Pt
  tail: Pt
  /** The tapered body: head, shoulder, tail, shoulder. */
  outline: [Pt, Pt, Pt, Pt]
  /** Posed head and tail in rig space. */
  headRig: Pt
  tailRig: Pt
  /** Its pose at this moment. */
  pose: Bone['pose']
  /** Where the bone's own x axis points in rig space when it has no pose of its own (radians): the frame `pose.x` and `pose.y` are in. */
  baseAngle: number
}

export interface RigOverlay {
  rigId: string
  space: RigSpace
  bones: BoneShape[]
}

/**
 * The shapes of a rig's bones at a moment. `bones` are the group's resolved
 * bones (keyed poses sampled), `groupMatrix` maps the group's own space to
 * comp space and `toScreen` comp space to the artboard's screen px.
 */
export function rigOverlay(group: { id: string }, bones: readonly Bone[], toScreen: (x: number, y: number) => Pt, groupMatrix: Matrix): RigOverlay {
  const space = rigSpace(groupMatrix, toScreen)
  const poses = new Map(bones.map((b) => [b.id, b.pose]))
  const solved = solveRig(bones, poses)
  const shapes: BoneShape[] = []
  for (const bone of bones) {
    const s = solved.get(bone.id)
    const headRig: Pt = s ? s.head : bone.head
    const tailRig: Pt = s ? s.tail : bone.tail
    const head = space.toScreen(headRig[0], headRig[1])
    const tail = space.toScreen(tailRig[0], tailRig[1])
    const dx = tail[0] - head[0]
    const dy = tail[1] - head[1]
    const length = Math.hypot(dx, dy)
    const half = Math.min(BONE_MAX_WIDTH, length * BONE_WIDTH_RATIO) / 2
    const ux = length > 0 ? dx / length : 1
    const uy = length > 0 ? dy / length : 0
    const shoulder: Pt = [head[0] + dx * BONE_SHOULDER, head[1] + dy * BONE_SHOULDER]
    const outline: BoneShape['outline'] = [head, [shoulder[0] - uy * half, shoulder[1] + ux * half], tail, [shoulder[0] + uy * half, shoulder[1] - ux * half]]
    shapes.push({
      id: bone.id,
      name: bone.name,
      side: sideOf(bone.name),
      control: !bone.deform,
      head,
      tail,
      outline,
      headRig,
      tailRig,
      pose: bone.pose,
      baseAngle: Math.atan2(tailRig[1] - headRig[1], tailRig[0] - headRig[0]) - (bone.pose.rotation * Math.PI) / 180,
    })
  }
  return { rigId: group.id, space, bones: shapes }
}

export type BoneHit = { boneId: string; part: 'tail' | 'body' }

/** Distance from a point to the segment a-b. */
function segmentDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  const s = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2))
  return Math.hypot(p[0] - (a[0] + dx * s), p[1] - (a[1] + dy * s))
}

/**
 * The bone part under a screen point (within `BONE_HIT_RADIUS`): a tail wins over
 * any body, then the nearest body; later bones (children) win ties.
 */
export function hitBone(overlay: RigOverlay, point: Pt): BoneHit | null {
  let tail: { id: string; d: number } | null = null
  let body: { id: string; d: number } | null = null
  for (const bone of overlay.bones) {
    const dt = Math.hypot(point[0] - bone.tail[0], point[1] - bone.tail[1])
    if (dt <= BONE_HIT_RADIUS && (!tail || dt <= tail.d)) tail = { id: bone.id, d: dt }
    const db = segmentDistance(point, bone.head, bone.tail)
    if (db <= BONE_HIT_RADIUS && (!body || db <= body.d)) body = { id: bone.id, d: db }
  }
  if (tail) return { boneId: tail.id, part: 'tail' }
  if (body) return { boneId: body.id, part: 'body' }
  return null
}

/** An angle in degrees brought into (-180, 180]. */
export function wrapDeg(d: number): number {
  const w = ((((d + 180) % 360) + 360) % 360) - 180
  return w === -180 ? 180 : w
}

/**
 * The angle (degrees, clockwise on a y-down plane, in (-180, 180]) swept around
 * `center` going from point `from` to point `to`. A point on the centre sweeps nothing.
 */
export function sweepDeg(center: Pt, from: Pt, to: Pt): number {
  const ax = from[0] - center[0]
  const ay = from[1] - center[1]
  const bx = to[0] - center[0]
  const by = to[1] - center[1]
  if ((ax === 0 && ay === 0) || (bx === 0 && by === 0)) return 0
  return wrapDeg((Math.atan2(by, bx) - Math.atan2(ay, ax)) * (180 / Math.PI))
}

/**
 * A bone's pose channels `x` and `y` move it along and across its own rest direction;
 * this turns a move in rig space into those.
 */
export function poseDelta(bone: Pick<BoneShape, 'baseAngle'>, rigDelta: Pt): Pt {
  const cos = Math.cos(-bone.baseAngle)
  const sin = Math.sin(-bone.baseAngle)
  return [rigDelta[0] * cos - rigDelta[1] * sin, rigDelta[0] * sin + rigDelta[1] * cos]
}

export interface RigDrawOptions {
  /** Screen px per CSS px of the canvas (the canvas is drawn in screen px). */
  scale: number
  /** The bone being posed. */
  picked: string | null
  /** The theme's accent colour. */
  accent?: string
}

/** The minimal 2D context the drawing needs. */
type DrawContext = Pick<
  CanvasRenderingContext2D,
  'save' | 'restore' | 'setTransform' | 'beginPath' | 'moveTo' | 'lineTo' | 'closePath' | 'arc' | 'fill' | 'stroke' | 'fillStyle' | 'strokeStyle' | 'lineWidth' | 'globalAlpha' | 'lineJoin'
>

const colorOf = (bone: BoneShape, picked: boolean, accent: string): string =>
  picked ? accent : bone.control ? BONE_COLORS.control : bone.side === 'left' ? BONE_COLORS.left : bone.side === 'right' ? BONE_COLORS.right : BONE_COLORS.neutral

/** Draws the bones, in CSS px from the artboard's top-left (the context is scaled by `scale`). */
export function drawRigOverlay(ctx: DrawContext, overlay: RigOverlay, options: RigDrawOptions): void {
  const accent = options.accent || BONE_COLORS.accent
  ctx.save()
  ctx.setTransform(options.scale, 0, 0, options.scale, 0, 0)
  ctx.lineJoin = 'round'
  const path = (points: readonly Pt[]) => {
    ctx.beginPath()
    for (const [i, p] of points.entries()) {
      if (i === 0) ctx.moveTo(p[0], p[1])
      else ctx.lineTo(p[0], p[1])
    }
    ctx.closePath()
  }
  const disc = (p: Pt, r: number) => {
    ctx.beginPath()
    ctx.arc(p[0], p[1], r, 0, Math.PI * 2)
  }
  // The picked bone is drawn last, so it is on top.
  const order = [...overlay.bones].sort((a, b) => Number(a.id === options.picked) - Number(b.id === options.picked))
  for (const bone of order) {
    const picked = bone.id === options.picked
    const color = colorOf(bone, picked, accent)
    // Dark halo first so the bone reads on any picture.
    path(bone.outline)
    ctx.lineWidth = 3.5
    ctx.strokeStyle = BONE_COLORS.halo
    ctx.stroke()
    path(bone.outline)
    ctx.globalAlpha = bone.control ? 0.25 : 0.55
    ctx.fillStyle = color
    ctx.fill()
    ctx.globalAlpha = 1
    ctx.lineWidth = 1.25
    ctx.strokeStyle = color
    ctx.stroke()
    // The head joint.
    disc(bone.head, JOINT_RADIUS)
    ctx.fillStyle = BONE_COLORS.halo
    ctx.fill()
    disc(bone.head, JOINT_RADIUS - 1)
    ctx.fillStyle = color
    ctx.fill()
    if (bone.control) {
      // A control carries a small diamond at its tail: the thing to move.
      path([
        [bone.tail[0], bone.tail[1] - CONTROL_RADIUS],
        [bone.tail[0] + CONTROL_RADIUS, bone.tail[1]],
        [bone.tail[0], bone.tail[1] + CONTROL_RADIUS],
        [bone.tail[0] - CONTROL_RADIUS, bone.tail[1]],
      ])
      ctx.fillStyle = color
      ctx.fill()
      ctx.lineWidth = 1
      ctx.strokeStyle = BONE_COLORS.halo
      ctx.stroke()
    }
  }
  ctx.restore()
}
