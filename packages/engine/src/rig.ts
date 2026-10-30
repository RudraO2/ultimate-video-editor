import type { Bone } from '@uve/core'
import { clampToLimits } from '@uve/core'

// Rigs (Q7): FK, two-bone IK, limits and binding, as pure functions of the
// bones and a pose. Comp space (y down), a bone's frame has its origin at the
// head and its x axis along head to tail. A positive rotation is clockwise on
// screen, which is the usual rotation matrix in y-down coordinates.

/** A 2D affine map [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f. */
export type Affine = readonly [a: number, b: number, c: number, d: number, e: number, f: number]

/** A·B (B first). */
export function affMul(A: Affine, B: Affine): Affine {
  return [
    A[0] * B[0] + A[2] * B[1],
    A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3],
    A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4],
    A[1] * B[4] + A[3] * B[5] + A[5],
  ]
}

export function affInv(A: Affine): Affine {
  const det = A[0] * A[3] - A[1] * A[2]
  const k = Math.abs(det) < 1e-12 ? 0 : 1 / det
  const a = A[3] * k
  const b = -A[1] * k
  const c = -A[2] * k
  const d = A[0] * k
  return [a, b, c, d, -(a * A[4] + c * A[5]), -(b * A[4] + d * A[5])]
}

export const affApply = (A: Affine, x: number, y: number): [number, number] => [A[0] * x + A[2] * y + A[4], A[1] * x + A[3] * y + A[5]]

const translation = (x: number, y: number): Affine => [1, 0, 0, 1, x, y]
const rotation = (rad: number): Affine => [Math.cos(rad), Math.sin(rad), -Math.sin(rad), Math.cos(rad), 0, 0]
const stretch = (sx: number): Affine => [sx, 0, 0, 1, 0, 0]

/** A 2D affine as a column-major 4×4 (what the scene's `prefix` takes). */
export const affineToMat4 = (A: Affine): number[] => [A[0], A[1], 0, 0, A[2], A[3], 0, 0, 0, 0, 1, 0, A[4], A[5], 0, 1]

const rad = (deg: number) => (deg * Math.PI) / 180
const deg = (r: number) => (r * 180) / Math.PI
/** An angle in degrees brought into (-180, 180]. */
const wrap = (d: number) => {
  const w = ((((d + 180) % 360) + 360) % 360) - 180
  return w === -180 ? 180 : w
}

/** A bone's pose: deltas from rest. */
export interface BonePose {
  rotation: number
  x: number
  y: number
  scale: number
}

export const REST_POSE: BonePose = { rotation: 0, x: 0, y: 0, scale: 1 }

export interface SolvedBone {
  /** Maps comp points at rest to comp points posed: a piece riding the bone is moved by this. */
  matrix: Affine
  head: [number, number]
  tail: [number, number]
}

interface Prep {
  bone: Bone
  parent: Bone | null
  /** Rest world frame R: origin at the head, x along the bone. */
  rest: Affine
  /** The rest frame relative to the parent's rest frame (the rest frame itself for a root). */
  rel: Affine
  len: number
  angle: number
}

/** Bones parent first, each once; a bone whose parent chain loops, or names a missing bone, is treated as a root. */
function ordered(bones: readonly Bone[]): Prep[] {
  const byId = new Map(bones.map((b) => [b.id, b]))
  const preps = new Map<string, Prep>()
  const out: Prep[] = []
  const visit = (bone: Bone, trail: Set<string>): Prep => {
    const known = preps.get(bone.id)
    if (known) return known
    trail.add(bone.id)
    const parentBone = bone.parent !== null && !trail.has(bone.parent) ? byId.get(bone.parent) : undefined
    const parent = parentBone ? visit(parentBone, trail) : null
    const dx = bone.tail[0] - bone.head[0]
    const dy = bone.tail[1] - bone.head[1]
    const angle = Math.atan2(dy, dx)
    const rest = affMul(translation(bone.head[0], bone.head[1]), rotation(angle))
    const prep: Prep = { bone, parent: parent?.bone ?? null, rest, rel: parent ? affMul(affInv(parent.rest), rest) : rest, len: Math.hypot(dx, dy), angle }
    preps.set(bone.id, prep)
    out.push(prep)
    return prep
  }
  for (const bone of bones) visit(bone, new Set())
  return out
}

const poseOf = (poses: ReadonlyMap<string, BonePose>, id: string): BonePose => poses.get(id) ?? REST_POSE

interface Frame {
  /** The posed frame without the bone's own stretch. */
  rigid: Affine
  /** With the stretch: maps the bone's own frame (rest lengths) to comp. */
  full: Affine
  rot: number
}

/** Forward kinematics of every bone with the given (already clamped) poses. */
function forward(preps: readonly Prep[], poses: ReadonlyMap<string, BonePose>): Map<string, Frame> {
  const frames = new Map<string, Frame>()
  for (const p of preps) {
    const pose = poseOf(poses, p.bone.id)
    const parent = p.parent ? frames.get(p.parent.id) : undefined
    let base: Affine
    if (parent) {
      // Turns and moves with the parent, but the parent's stretch only carries the joint along.
      const linear = affMul(parent.rigid, p.rel)
      const joint = affApply(parent.full, p.rel[4], p.rel[5])
      base = [linear[0], linear[1], linear[2], linear[3], joint[0], joint[1]]
    } else {
      base = p.rel
    }
    const rigid = affMul(base, affMul(translation(pose.x, pose.y), rotation(rad(pose.rotation))))
    frames.set(p.bone.id, { rigid, full: affMul(rigid, stretch(pose.scale)), rot: pose.rotation })
  }
  return frames
}

const angleOf = (A: Affine) => Math.atan2(A[1], A[0])

/** The pose with every channel held to the bone's limits. */
function limited(bone: Bone, pose: BonePose): BonePose {
  return {
    rotation: clampToLimits(bone, 'rotation', pose.rotation),
    x: clampToLimits(bone, 'x', pose.x),
    y: clampToLimits(bone, 'y', pose.y),
    scale: clampToLimits(bone, 'scale', pose.scale),
  }
}

/** Mixes two angles (degrees) the short way round. */
const mixAngle = (from: number, to: number, mix: number) => from + wrap(to - from) * mix

/** Solves the chain of an IK bone for the target point; returns new rotations (degrees) for the bones it turns. */
function solveIk(preps: readonly Prep[], poses: Map<string, BonePose>, p: Prep, target: [number, number], bones: ReadonlyMap<string, Prep>): void {
  const ik = p.bone.ik
  if (!ik) return
  const frames = forward(preps, poses)
  const lower = frames.get(p.bone.id) as Frame
  const mix = ik.mix
  if (mix <= 0) return
  const apply = (bone: Bone, ikRot: number) => {
    const current = poseOf(poses, bone.id)
    const held = clampToLimits(bone, 'rotation', ikRot)
    poses.set(bone.id, { ...current, rotation: mixAngle(current.rotation, held, mix) })
  }
  const upperPrep = p.parent ? bones.get(p.parent.id) : undefined
  if (ik.chain === 1 || !upperPrep) {
    const head = affApply(lower.full, 0, 0)
    const base = angleOf(lower.rigid) - rad(lower.rot)
    apply(p.bone, wrap(deg(Math.atan2(target[1] - head[1], target[0] - head[0]) - base)))
    return
  }
  const upper = frames.get(upperPrep.bone.id) as Frame
  const shoulder = affApply(upper.full, 0, 0)
  const sU = poseOf(poses, upperPrep.bone.id).scale
  const sL = poseOf(poses, p.bone.id).scale
  // The joint is where the lower bone starts, in the upper bone's own (stretched) frame.
  const qx = p.rel[4] * sU
  const qy = p.rel[5]
  const a = Math.hypot(qx, qy)
  const b = p.len * sL
  const phi = Math.atan2(qy, qx)
  const rho = p.angle - upperPrep.angle
  const baseU = angleOf(upper.rigid) - rad(upper.rot)
  const dx = target[0] - shoulder[0]
  const dy = target[1] - shoulder[1]
  const reach = Math.hypot(dx, dy)
  const dist = Math.min(a + b, Math.max(Math.abs(a - b) + 1e-9, reach))
  const toward = Math.atan2(dy, dx)
  let alphaJoint = toward
  if (a > 1e-9 && dist > 1e-9) {
    const cosB = Math.min(1, Math.max(-1, (a * a + dist * dist - b * b) / (2 * a * dist)))
    alphaJoint = toward + (ik.flip ? -1 : 1) * Math.acos(cosB)
  }
  const tx = Math.cos(toward) * dist
  const ty = Math.sin(toward) * dist
  const alphaLower = Math.atan2(ty - a * Math.sin(alphaJoint), tx - a * Math.cos(alphaJoint))
  const rotU = alphaJoint - baseU - phi
  // The upper bone turns first, so the lower bone's turn is measured from where it ends up.
  apply(upperPrep.bone, wrap(deg(rotU)))
  const turned = poseOf(poses, upperPrep.bone.id).rotation
  apply(p.bone, wrap(deg(alphaLower - baseU - rad(turned) - rho)))
}

/**
 * Poses a skeleton. `poses` holds deltas from rest per bone id (missing is
 * rest). Limits clamp every channel first, then IK bones reach for their
 * target's posed head (their chain's rotations are clamped again and mixed
 * with the plain pose). Returns, per bone, the map from rest to posed comp
 * points and the posed head and tail.
 */
export function solveRig(bones: readonly Bone[], poses: ReadonlyMap<string, BonePose> = new Map()): Map<string, SolvedBone> {
  const preps = ordered(bones)
  const byId = new Map(preps.map((p) => [p.bone.id, p]))
  const held = new Map<string, BonePose>()
  for (const p of preps) held.set(p.bone.id, limited(p.bone, poseOf(poses, p.bone.id)))
  // IK bones one by one, parents first; each solve sees the targets as the earlier ones left them.
  for (const p of preps) {
    const ik = p.bone.ik
    if (!ik) continue
    const targetPrep = byId.get(ik.target)
    if (!targetPrep) continue
    const target = affApply((forward(preps, held).get(ik.target) as Frame).full, 0, 0)
    solveIk(preps, held, p, target, byId)
  }
  const frames = forward(preps, held)
  const out = new Map<string, SolvedBone>()
  for (const p of preps) {
    const f = frames.get(p.bone.id) as Frame
    out.set(p.bone.id, {
      matrix: affMul(f.full, affInv(p.rest)),
      head: affApply(f.full, 0, 0),
      tail: affApply(f.full, p.len, 0),
    })
  }
  return out
}

// ---------------------------------------------------------------- binding

interface Box {
  left: number
  top: number
  width: number
  height: number
}

const inside = (box: Box, x: number, y: number) => x >= box.left && x <= box.left + box.width && y >= box.top && y <= box.top + box.height

const distToSegment = (px: number, py: number, a: readonly [number, number], b: readonly [number, number]) => {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const l2 = dx * dx + dy * dy
  const u = l2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - a[0]) * dx + (py - a[1]) * dy) / l2))
  return Math.hypot(px - (a[0] + u * dx), py - (a[1] + u * dy))
}

/**
 * The bone a piece with this rest box rides when bound automatically: the
 * deform bone running furthest through the box (it must run through at least
 * a quarter of its length and two cells, a cell being 1/40 of the box's longer
 * side); else a bone whose tail is in the box (nearest the centre); else the
 * parent of a bone whose head is in it; else the nearest bone. Null for a rig
 * without bones.
 */
export function autoBone(bones: readonly Bone[], box: Box): Bone | null {
  const deforming = bones.filter((b) => b.deform)
  const pool = deforming.length > 0 ? deforming : [...bones]
  if (pool.length === 0) return null
  const cell = Math.max(box.width, box.height) / 40
  let best: Bone | null = null
  let bestRun = 0
  for (const bone of pool) {
    const len = Math.hypot(bone.tail[0] - bone.head[0], bone.tail[1] - bone.head[1])
    let run = 0
    const steps = 32
    for (let i = 0; i < steps; i++) {
      const u = (i + 0.5) / steps
      if (inside(box, bone.head[0] + (bone.tail[0] - bone.head[0]) * u, bone.head[1] + (bone.tail[1] - bone.head[1]) * u)) run += len / steps
    }
    if (run >= Math.max(0.25 * len, 2 * cell) && run > bestRun) {
      best = bone
      bestRun = run
    }
  }
  if (best) return best
  const cx = box.left + box.width / 2
  const cy = box.top + box.height / 2
  const centreDist = (x: number, y: number) => Math.hypot(x - cx, y - cy)
  let tailIn: Bone | null = null
  for (const bone of pool) {
    if (inside(box, bone.tail[0], bone.tail[1]) && (!tailIn || centreDist(bone.tail[0], bone.tail[1]) < centreDist(tailIn.tail[0], tailIn.tail[1]))) tailIn = bone
  }
  if (tailIn) return tailIn
  const byId = new Map(bones.map((b) => [b.id, b]))
  const candidate = new Set(pool.map((b) => b.id))
  for (const bone of pool) {
    if (!inside(box, bone.head[0], bone.head[1])) continue
    // The parent, or the nearest ancestor that can be ridden; a root rides itself.
    const seen = new Set<string>()
    for (let at = bone.parent === null ? undefined : byId.get(bone.parent); at && !seen.has(at.id); at = at.parent === null ? undefined : byId.get(at.parent)) {
      seen.add(at.id)
      if (candidate.has(at.id)) return at
    }
    return bone
  }
  let nearest = pool[0] as Bone
  let nearestDist = Number.POSITIVE_INFINITY
  for (const bone of pool) {
    const d = distToSegment(cx, cy, bone.head, bone.tail)
    if (d < nearestDist) {
      nearest = bone
      nearestDist = d
    }
  }
  return nearest
}
