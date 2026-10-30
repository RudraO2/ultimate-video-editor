import { z } from 'zod'
import { locateLayer } from '../doc'
import { ease, splitEasing } from '../easing'
import { CommandError } from '../errors'
import { KEY_EPSILON_MS, pruneSpatial, upsertKey } from '../keys'
import {
  bendHandles,
  type MotionKey,
  motionKeysOf,
  motionPointAt,
  segmentOf,
  smoothTangents,
  splitSegment,
  type Vec2,
} from '../motionPath'
import { evaluateProperty, readProperty, resolveProperty, writeProperty } from '../properties'
import { defineCommand } from '../registry'
import { type Easing, IdSchema, type Keyframe, type Layer } from '../schema'

const OPS = ['move', 'insert', 'delete', 'smooth', 'corner', 'bend', 'handle'] as const
type Op = (typeof OPS)[number]

const Point = z.tuple([z.number(), z.number()])

/** The optional fields each op takes: required ones first, then allowed extras. */
const FIELDS: Record<Op, { required: readonly string[]; optional: readonly string[] }> = {
  move: { required: ['value'], optional: [] },
  insert: { required: [], optional: [] },
  delete: { required: [], optional: [] },
  smooth: { required: [], optional: [] },
  corner: { required: [], optional: [] },
  bend: { required: ['u', 'point'], optional: [] },
  handle: { required: ['side', 'value'], optional: ['mirror'] },
}
const FIELD_NAMES = ['value', 'u', 'point', 'side', 'mirror'] as const

const LABELS: Record<Op, string> = {
  move: 'Move motion point',
  insert: 'Insert motion point',
  delete: 'Delete motion point',
  smooth: 'Smooth motion point',
  corner: 'Corner motion point',
  bend: 'Bend motion path',
  handle: 'Set motion handle',
}

const round = (n: number) => Math.round(n * 1000) / 1000

/** The key of a track at layer time `t` (within the key epsilon), if any. */
function keyAt(keys: readonly Keyframe[] | undefined, t: number): Keyframe | undefined {
  return keys?.find((k) => Math.abs(k.t - t) < KEY_EPSILON_MS)
}

/** An x key's handles with some sides replaced. */
function withHandles(key: MotionKey, change: { in?: Vec2 | null; out?: Vec2 | null }) {
  return { in: change.in !== undefined ? change.in : key.in, out: change.out !== undefined ? change.out : key.out }
}

export const motionEdit = defineCommand({
  name: 'motion.edit',
  summary: "Edit a layer's motion path point by point: move, insert, delete, smooth, corner, bend a segment or set a handle.",
  details:
    'A motion path is the layer\'s position keyed at two times or more (keyframes.set property "position"). atMs is COMP time, as keyframes.inspect prints it (layer time is atMs minus the layer start); the point ops need a motion key there (within half a millisecond). move {value: [x, y]} puts the point somewhere else; its handles travel with it. insert adds a point on the segment at atMs, exactly on the path and with the timing unchanged (a curved segment stays curved). delete removes the point and its handles. smooth gives the point handles that flow through its neighbours (an end point gets one); corner removes its handles. bend {u, point: [x, y]} reshapes the segment that starts at atMs (or contains it) so the curve passes through point at u (0 to 1, exclusive) of the way along it. handle {side: "in" | "out", value: [dx, dy] | null, mirror?} sets one handle (null clears it); mirror sets the other side to the opposite so the point stays smooth. Handles are px relative to their point; "in" leans toward the previous point, "out" toward the next. keyframes.inspect marks keys of a curved path with ↷. A segment with no handles is a straight line (with the keys\' easing); a handle on one side bends it, the other side defaults to a third of the chord.',
  effect: 'write',
  input: z.strictObject({
    id: IdSchema,
    atMs: z.number().describe('Comp time in ms, as keyframes.inspect prints it (layer time = atMs minus the layer start)'),
    op: z.enum(OPS).describe('move, insert, delete, smooth, corner, bend or handle'),
    value: Point.nullable().optional().describe('move: the new [x, y]. handle: the [dx, dy] handle, px relative to the point, or null to clear'),
    u: z.number().optional().describe('bend: how far along the segment the curve is bent through point, 0 to 1 exclusive'),
    point: Point.optional().describe('bend: the [x, y] the curve passes through at u'),
    side: z.enum(['in', 'out']).optional().describe('handle: "in" (toward the previous point) or "out" (toward the next)'),
    mirror: z.boolean().optional().describe('handle: also set the other side to the opposite of this one (null clears both)'),
  }),
  run: (input, ctx) => {
    const { id, atMs, op } = input
    checkFields(input)
    const { layer } = locateLayer(ctx.project, id)
    const rows = motionKeysOf(layer)
    if (rows.length < 2) {
      throw new CommandError(
        `${layer.name} has no motion path.`,
        'Key position at two times or more: keyframes.set property "position" with keys [x, y].',
      )
    }
    const timesHint = `Motion keys at ${rows.map((r) => round(layer.startMs + r.t)).join(', ')} ms (comp time).`
    const t = atMs - layer.startMs
    const index = rows.findIndex((r) => Math.abs(r.t - t) < KEY_EPSILON_MS)
    const label = LABELS[op]

    if (op === 'insert') {
      const plan = planInsert(layer, rows, t, atMs, index, timesHint)
      ctx.write(label, (draft) => {
        const target = locateLayer(draft, layer.id).layer
        for (const track of plan.tracks) {
          const keys = target.animations[track.path] as Keyframe[]
          const before = keyAt(keys, track.beforeT)
          if (before) before.ease = track.first
          upsertKey(keys, { t, v: track.value, ease: track.second, ...(track.spatial ? { spatial: track.spatial } : {}) }, false)
        }
        if (plan.neighbours) {
          const xs = target.animations['transform.x'] as Keyframe[]
          const a = keyAt(xs, plan.neighbours.a.t)
          const b = keyAt(xs, plan.neighbours.b.t)
          if (a) a.spatial = plan.neighbours.a.spatial
          if (b) b.spatial = plan.neighbours.b.spatial
        }
        pruneSpatial(target.animations)
      })
      return { id: layer.id, op, atMs, motionKeys: rows.length + 1, point: plan.point }
    }

    if (index < 0 && op !== 'bend') {
      throw new CommandError(`${layer.name} has no motion key at ${round(atMs)} ms.`, timesHint)
    }
    let count = rows.length

    if (op === 'bend') {
      const { u, point } = input as { u: number; point: Vec2 }
      if (!(u > 0 && u < 1)) throw new CommandError(`u must be between 0 and 1 (exclusive), not ${u}.`, 'u is how far along the segment the curve passes through point, e.g. 0.5 for the middle.')
      const i = index >= 0 ? index : rows.findIndex((r, k) => r.t < t && (rows[k + 1]?.t ?? Number.NEGATIVE_INFINITY) > t)
      const a = rows[i]
      const b = rows[i + 1]
      if (!a || !b) {
        throw new CommandError(
          `${layer.name} has no segment at ${round(atMs)} ms to bend.`,
          `${timesHint} A segment runs from one motion key to the next; bend at a key but the last, or between two.`,
        )
      }
      const h = bendHandles(segmentOf(a, b), u, point)
      const sa = withHandles(a, { out: h.out })
      const sb = withHandles(b, { in: h.in })
      ctx.write(label, (draft) => {
        const xs = locateLayer(draft, layer.id).layer.animations['transform.x'] as Keyframe[]
        const ka = keyAt(xs, a.t)
        const kb = keyAt(xs, b.t)
        if (ka) ka.spatial = sa
        if (kb) kb.spatial = sb
        pruneSpatial(locateLayer(draft, layer.id).layer.animations)
      })
    } else {
      const row = rows[index] as MotionKey
      if (op === 'move') {
        const [x, y] = input.value as Vec2
        ctx.write(label, (draft) => {
          const target = locateLayer(draft, layer.id).layer
          const kx = keyAt(target.animations['transform.x'], row.t)
          const ky = keyAt(target.animations['transform.y'], row.t)
          if (kx) kx.v = x
          if (ky) ky.v = y
        })
      } else if (op === 'delete') {
        count = rows.length - 1
        ctx.write(label, (draft) => {
          const target = locateLayer(draft, layer.id).layer
          for (const name of ['x', 'y'] as const) {
            const spec = resolveProperty(target, name)[0]
            if (!spec) continue
            const keys = target.animations[spec.path]
            if (!keys) continue
            const hit = (k: Keyframe) => Math.abs(k.t - row.t) < KEY_EPSILON_MS
            const gone = keys.filter(hit)
            const kept = keys.filter((k) => !hit(k))
            if (kept.length > 0) {
              target.animations[spec.path] = kept
              continue
            }
            const last = gone.at(-1)
            if (last !== undefined && readProperty(target, spec) !== undefined) writeProperty(target, spec, last.v)
            delete target.animations[spec.path]
          }
          pruneSpatial(target.animations)
        })
      } else if (op === 'smooth') {
        const prev = rows[index - 1]
        const next = rows[index + 1]
        const tangents = smoothTangents(prev ? [prev.x, prev.y] : null, [row.x, row.y], next ? [next.x, next.y] : null)
        ctx.write(label, (draft) => {
          const target = locateLayer(draft, layer.id).layer
          const kx = keyAt(target.animations['transform.x'], row.t)
          if (kx) kx.spatial = { in: tangents.in, out: tangents.out }
          pruneSpatial(target.animations)
        })
      } else if (op === 'corner') {
        ctx.write(label, (draft) => {
          const kx = keyAt(locateLayer(draft, layer.id).layer.animations['transform.x'], row.t)
          if (kx) delete kx.spatial
        })
      } else {
        // handle
        const side = input.side as 'in' | 'out'
        const value = input.value as Vec2 | null
        const faces = (s: 'in' | 'out') => (s === 'in' ? index > 0 : index < rows.length - 1)
        if (!faces(side)) {
          throw new CommandError(
            side === 'in' ? 'The first motion key has no segment before it.' : 'The last motion key has no segment after it.',
            side === 'in' ? 'Use side "out" here: it leans toward the next key.' : 'Use side "in" here: it leans toward the previous key.',
          )
        }
        const other = side === 'in' ? 'out' : 'in'
        const change: { in?: Vec2 | null; out?: Vec2 | null } = { [side]: value }
        if (input.mirror && faces(other)) change[other] = value ? [-value[0], -value[1]] : null
        const spatial = withHandles(row, change)
        ctx.write(label, (draft) => {
          const target = locateLayer(draft, layer.id).layer
          const kx = keyAt(target.animations['transform.x'], row.t)
          if (kx) kx.spatial = spatial
          pruneSpatial(target.animations)
        })
      }
    }
    return { id: layer.id, op, atMs, motionKeys: count }
  },
})

/** Refuses a missing or extra field for the op. */
function checkFields(input: Record<string, unknown> & { op: Op }): void {
  const { required, optional } = FIELDS[input.op]
  const takes = [...required, ...optional]
  const takesText = takes.length > 0 ? `${input.op} takes ${takes.join(', ')}` : `${input.op} takes only id, atMs and op`
  for (const name of FIELD_NAMES) {
    const given = input[name] !== undefined
    if (given && !takes.includes(name)) {
      throw new CommandError(`${name} does not apply to op "${input.op}".`, `${takesText}.`)
    }
    if (!given && required.includes(name)) {
      throw new CommandError(`op "${input.op}" needs ${name}.`, `${takesText}.`)
    }
  }
  if (input.op === 'move' && input.value === null) {
    throw new CommandError('op "move" needs value [x, y], not null.', 'null clears a handle; it cannot move a point.')
  }
}

interface TrackPlan {
  path: 'transform.x' | 'transform.y'
  /** Layer time of the key just before the new one on this track. */
  beforeT: number
  first: Easing
  second: Easing
  value: number
  spatial?: { in: Vec2 | null; out: Vec2 | null }
}

interface InsertPlan {
  tracks: TrackPlan[]
  point: Vec2
  /** New handles for the points each side of a curved segment. */
  neighbours?: {
    a: { t: number; spatial: { in: Vec2 | null; out: Vec2 | null } }
    b: { t: number; spatial: { in: Vec2 | null; out: Vec2 | null } }
  }
}

/** Works out an insert from plain data, refusing before anything is written. */
function planInsert(layer: Layer, rows: readonly MotionKey[], t: number, atMs: number, index: number, timesHint: string): InsertPlan {
  if (index >= 0) {
    throw new CommandError(`${layer.name} already has a motion key at ${round(atMs)} ms.`, `${timesHint} Insert between two of them, or use move.`)
  }
  const i = rows.findIndex((r, k) => r.t < t && (rows[k + 1]?.t ?? Number.NEGATIVE_INFINITY) > t)
  const a = rows[i]
  const b = rows[i + 1]
  if (!a || !b) {
    throw new CommandError(`${round(atMs)} ms is outside the motion path.`, `${timesHint} Insert between two of them.`)
  }

  const specX = resolveProperty(layer, 'x')[0]
  const specY = resolveProperty(layer, 'y')[0]
  if (!specX || !specY) throw new CommandError(`${layer.name} has no position to edit.`)

  // Where the new point sits, and the handles that keep the path as it was.
  let point: Vec2
  let neighbours: InsertPlan['neighbours']
  let spatial: { in: Vec2 | null; out: Vec2 | null } | undefined
  if (motionPointAt(layer, t) !== undefined) {
    const u = ease(a.ease, (t - a.t) / (b.t - a.t))
    const [left, right] = splitSegment(segmentOf(a, b), u)
    point = left.p3
    const rel = (p: Vec2, from: Vec2): Vec2 => [p[0] - from[0], p[1] - from[1]]
    spatial = { in: rel(left.p2, point), out: rel(right.p1, point) }
    neighbours = {
      a: { t: a.t, spatial: { in: a.in, out: rel(left.p1, left.p0) } },
      b: { t: b.t, spatial: { in: rel(right.p2, right.p3), out: b.out } },
    }
  } else {
    point = [evaluateProperty(layer, specX, t) as number, evaluateProperty(layer, specY, t) as number]
  }

  // Timing: each track's easing is cut at that track's own progress.
  const tracks: TrackPlan[] = []
  for (const [path, value] of [
    ['transform.x', point[0]],
    ['transform.y', point[1]],
  ] as const) {
    const keys = layer.animations[path] ?? []
    const before = [...keys].reverse().find((k) => k.t < t - KEY_EPSILON_MS)
    const after = keys.find((k) => k.t > t + KEY_EPSILON_MS)
    if (!before || !after) throw new CommandError(`${path} has no keys each side of ${round(atMs)} ms.`, timesHint)
    const [first, second] = splitEasing(before.ease, (t - before.t) / (after.t - before.t))
    tracks.push({ path, beforeT: before.t, first, second, value, ...(path === 'transform.x' && spatial ? { spatial } : {}) })
  }
  return { tracks, point, ...(neighbours ? { neighbours } : {}) }
}
