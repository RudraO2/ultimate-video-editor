import { sampleKeys } from './interpolate'
import type { Keyframe, Layer, Transform } from './schema'
import {
  decomposeXYZ,
  mat4Compose,
  mat4Invert,
  mat4RotateX,
  mat4RotateY,
  mat4RotateZ,
  mat4Scale,
  mat4TransformPoint,
  PICTURE_AXES,
  type Vec3,
  type WorldMat4,
} from './world'

// Moving a flat layer into a 3D world without a visible jump. The change of
// axes is P(x, y, z) = (x, z, -y): a flat layer's matrix M becomes P·M·P⁻¹
// (see `PICTURE_AXES`; a picture then carries the P in its own world matrix).
// Pure data in, data out: the command in `commands/worldMove.ts` applies it.

const RAD = Math.PI / 180
const UNSWAP = mat4Invert(PICTURE_AXES) as WorldMat4

/** A group's box before its own transform, in its parent's space (the editor measures it). */
export interface GroupBox {
  left: number
  top: number
  width: number
  height: number
}

/** The flat turns (Rz·Ry·Rx) as a standard right-handed matrix: our flat X and Y turns are the transposes of the standard ones. */
export function flatTurns(t: Pick<Transform, 'rotation' | 'rotationX' | 'rotationY'>): WorldMat4 {
  return mat4Compose(mat4RotateZ(t.rotation * RAD), mat4RotateY(-t.rotationY * RAD), mat4RotateX(-t.rotationX * RAD))
}

/** The world turns (degrees) that equal a flat layer's turns after the change of axes: P·R·P⁻¹, split into Rz·Ry·Rx. Exact for any turns. */
export function worldTurnsOf(t: Pick<Transform, 'rotation' | 'rotationX' | 'rotationY'>): Pick<Transform, 'rotation' | 'rotationX' | 'rotationY'> {
  return decomposeXYZ(mat4Compose(PICTURE_AXES, flatTurns(t), UNSWAP)).rotation
}

/**
 * The inverse of the static conversion: the flat transform F of a picture
 * whose world transform is W, so that P·flatMatrix(F, box) = worldMatrix(W, box)
 * (P is PICTURE_AXES). The position swaps back (x, -z, y), the turns are
 * P⁻¹·R_world·P split into Rz·Ry·Rx and written in our flat convention
 * (rotationY and rotationX negated), and scales, anchors and opacity are
 * copied. A picture is flat, so a depth scale (scaleZ) cannot change where its
 * points land: F.scaleZ is 1 and the matrices agree entrywise when W.scaleZ is 1.
 */
export function flatEquivalent(w: Transform): Transform {
  const turns = mat4Compose(mat4RotateZ(w.rotation * RAD), mat4RotateY(w.rotationY * RAD), mat4RotateX(w.rotationX * RAD))
  const d = decomposeXYZ(mat4Compose(UNSWAP, turns, PICTURE_AXES)).rotation
  return {
    ...w,
    x: w.x + 0,
    y: -w.z + 0,
    z: w.y + 0,
    rotation: d.rotation + 0,
    rotationY: -d.rotationY + 0,
    rotationX: -d.rotationX + 0,
    scaleZ: 1,
  }
}

/** Where each flat key track goes: the world path and the sign of its values. */
const RENAMES: Record<string, { to: string; sign: 1 | -1 }> = {
  'transform.x': { to: 'transform.x', sign: 1 },
  'transform.y': { to: 'transform.z', sign: -1 },
  'transform.z': { to: 'transform.y', sign: 1 },
  'transform.rotationX': { to: 'transform.rotationX', sign: -1 },
  'transform.rotation': { to: 'transform.rotationY', sign: 1 },
  'transform.rotationY': { to: 'transform.rotation', sign: 1 },
}

const TURNS = ['rotation', 'rotationX', 'rotationY'] as const
const SHAPE = ['scaleX', 'scaleY', 'anchorX', 'anchorY', ...TURNS] as const

const isKeyed = (layer: Layer, name: keyof Transform): boolean => (layer.animations[`transform.${name}`]?.length ?? 0) > 0

/** A transform value at a layer time: sampled when keyed, else as stored. */
function valueAt(layer: Layer, name: keyof Transform, layerMs: number): number {
  const keys = layer.animations[`transform.${name}`]
  const v = keys && keys.length > 0 ? sampleKeys(keys, layerMs) : undefined
  return typeof v === 'number' && Number.isFinite(v) ? v : layer.transform[name]
}

/** Whether a group's box can change over time: a member is keyed (position, scale, turns) or the members do not all cover the same span. */
export function membersMove(members: readonly Layer[]): boolean {
  const moving = members.some((m) => Object.entries(m.animations).some(([path, keys]) => path.startsWith('transform.') && keys.length > 0))
  const span = (m: Layer) => `${m.startMs}:${m.startMs + m.durationMs}`
  return moving || new Set(members.map(span)).size > 1
}

export interface ConvertOptions {
  /** A group's measured box (parent space) at `atMs`; without it a group's pivot cannot be baked. */
  box?: GroupBox | null
  /** The layer time (ms from its start) the box was measured at. */
  atMs?: number
  /** The group's box may change over time (its members move): a non-zero pivot bake is then only right at `atMs`. */
  boxMoves?: boolean
}

const near0 = (v: number) => (Math.abs(v) < 1e-12 ? 0 : v)

/**
 * Converts a flat layer to world values, in place: its position (x, y, z →
 * x, z, -y), its turns, its key tracks and nothing else (scales, anchors and
 * opacity read the same in a world). Returns whether the result is only
 * approximate for some moment.
 *
 * - No turn keyed: the turns are P·R·P⁻¹ decomposed, exact for any turns.
 * - A turn keyed: the values are swapped (rotationX ← -rotationX, rotationY ←
 *   rotation, rotation ← rotationY), exact only while rotation or rotationY is 0.
 * - Key tracks are renamed and negated the same way; x keys lose their
 *   motion-path handles.
 * - A group is a parent about the world origin in a world, not about its box
 *   pivot: the pivot's share of its matrix is added to its position (the
 *   position tracks too), and its depth scale becomes 1 (a flat group has none).
 */
export function convertToWorld(layer: Layer, options: ConvertOptions = {}): { approximate: boolean } {
  const flat = { ...layer.transform }
  const group = layer.kind === 'group'
  const turnsKeyed = TURNS.some((name) => isKeyed(layer, name))
  let approximate = false

  let turns: Pick<Transform, 'rotation' | 'rotationX' | 'rotationY'>
  if (turnsKeyed) {
    turns = { rotationX: -flat.rotationX + 0, rotationY: flat.rotation, rotation: flat.rotationY }
    const aboutZ = isKeyed(layer, 'rotation') || flat.rotation !== 0
    const aboutY = isKeyed(layer, 'rotationY') || flat.rotationY !== 0
    if (aboutZ && aboutY) approximate = true
  } else {
    turns = worldTurnsOf(flat)
  }

  // A group's pivot: its matrix is T(t + p)·R·S·T(-p), the world's is T(t')·R'·S'. The difference is p - R·S·p, carried over by P.
  let shift: Vec3 = [0, 0, 0]
  if (group) {
    const ms = options.atMs ?? 0
    const at = (name: keyof Transform) => valueAt(layer, name, ms)
    const m3 = mat4Compose(flatTurns({ rotation: at('rotation'), rotationX: at('rotationX'), rotationY: at('rotationY') }), mat4Scale(at('scaleX'), at('scaleY'), 1))
    const identity = m3.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-12)
    const animated = SHAPE.some((name) => isKeyed(layer, name))
    const box = options.box
    if (box && [box.left, box.top, box.width, box.height].every(Number.isFinite)) {
      const px = box.left + at('anchorX') * box.width
      const py = box.top + at('anchorY') * box.height
      const [qx, qy, qz] = mat4TransformPoint(m3, px, py, 0)
      const v: Vec3 = [px - qx, py - qy, -qz]
      shift = [near0(v[0]), near0(v[2]), near0(-v[1])]
      const baked = Math.hypot(...v) > 1e-9
      if (baked && (animated || options.boxMoves)) approximate = true
    } else if (!identity || animated) {
      approximate = true
    }
    if (layer.kind === 'group' && layer.layout) approximate = true
  }

  layer.transform = {
    ...flat,
    x: flat.x + shift[0],
    y: flat.z + shift[1],
    z: -flat.y + shift[2] + 0,
    ...turns,
    ...(group ? { scaleZ: 1 } : {}),
  }

  const out: Record<string, Keyframe[]> = {}
  for (const [path, keys] of Object.entries(layer.animations)) {
    const rename = RENAMES[path]
    if (!rename) {
      if (!(group && path === 'transform.scaleZ')) out[path] = keys
      continue
    }
    const added = { 'transform.x': shift[0], 'transform.y': shift[1], 'transform.z': shift[2] }[rename.to as 'transform.x'] ?? 0
    out[rename.to] = keys.map((key) => {
      const { spatial: _handles, ...rest } = key
      return typeof key.v === 'number' ? { ...rest, v: rename.sign * key.v + added + 0 } : rest
    })
  }
  layer.animations = out
  return { approximate }
}
