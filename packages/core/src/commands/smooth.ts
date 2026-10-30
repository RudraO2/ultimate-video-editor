import { z } from 'zod'
import { locateLayer } from '../doc'
import { CommandError } from '../errors'
import { KEY_EPSILON_MS, pruneSpatial } from '../keys'
import { type MotionKey, motionKeysOf } from '../motionPath'
import { type PropertySpec, propertiesOf, resolveProperty } from '../properties'
import { defineCommand } from '../registry'
import { type Easing, IdSchema, type Keyframe, type Layer } from '../schema'
import { pathEasings, pathHandles, scalarEasings } from '../smooth'

const round = (n: number) => Math.round(n * 1000) / 1000

/** What smoothing changes on one track: easings by key index, and handles on x keys of a path. */
interface TrackPlan {
  path: string
  keys: number
  easings: Map<number, Easing>
  spatial?: Map<number, { in: MotionKey['in']; out: MotionKey['out'] }>
}

const isNumeric = (keys: readonly Keyframe[]) => keys.every((k) => typeof k.v === 'number')

export const keyframesSmooth = defineCommand({
  name: 'keyframes.smooth',
  summary: 'Make keyed motion flow: easing that keeps the speed steady through each key instead of stopping at it.',
  details:
    'Rewrites the easing of the keys (and, for position, the path handles) so the value moves through its keys without stopping or jerking at each one, like a spline. Without properties: every numeric track of the layer (position, scale, rotation, opacity, sizes, numeric effect fields); colours, paths and switches are skipped. With properties: those names ("position" is x and y together); a name that is not numeric is an error. fromMs and toMs (COMP time, as keyframes.inspect prints it: layer time is the time minus the layer start) limit the keys that change, inclusive; default the whole track. Only the keys inside the range are used, and the easing of the last one in the range is left as it is. A track needs two keys or more in the range. When x and y of the position are both smoothed and every key in the range has both, the path itself is smoothed: the keys get Catmull-Rom handles (the first key in the range only an out handle, the last only an in handle, when the range holds three keys or more; two keys stay a straight line) and the easing keeps the speed along the curve the same either side of each key. Existing easing in the range is replaced; undo restores it. Use keyframes.inspect to see the result.',
  effect: 'write',
  input: z.strictObject({
    id: IdSchema,
    properties: z.array(z.string().min(1)).min(1).optional().describe('Only these properties (default every numeric track); "position" is x and y'),
    fromMs: z.number().optional().describe('Comp time in ms: keys from here on (default the first key)'),
    toMs: z.number().optional().describe('Comp time in ms: keys up to here (default the last key)'),
  }),
  run: ({ id, properties, fromMs, toMs }, ctx) => {
    if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) {
      throw new CommandError(`fromMs (${round(fromMs)}) is after toMs (${round(toMs)}).`, 'Give the range as fromMs <= toMs, both in comp time.')
    }
    const { layer } = locateLayer(ctx.project, id)
    const lo = fromMs === undefined ? Number.NEGATIVE_INFINITY : fromMs - layer.startMs - KEY_EPSILON_MS
    const hi = toMs === undefined ? Number.POSITIVE_INFINITY : toMs - layer.startMs + KEY_EPSILON_MS
    const inRange = (k: Keyframe) => k.t >= lo && k.t <= hi

    const paths = pickTracks(layer, properties)
    const plans: TrackPlan[] = []
    let curved = 0

    // A motion path: both axes, every key in range paired with the other axis.
    const motion = paths.includes('transform.x') && paths.includes('transform.y') ? planMotion(layer, inRange) : undefined
    if (motion) {
      plans.push(...motion.plans)
      curved = motion.curved
    }
    for (const path of paths) {
      if (motion && (path === 'transform.x' || path === 'transform.y')) continue
      const keys = layer.animations[path] ?? []
      const picked = keys.map((k, index) => ({ k, index })).filter(({ k }) => inRange(k))
      if (picked.length < 2) continue
      const easings = scalarEasings(
        picked.map(({ k }) => k.t),
        picked.map(({ k }) => k.v as number),
      )
      plans.push({ path, keys: picked.length, easings: new Map(easings.map((e, i) => [(picked[i] as { index: number }).index, e])) })
    }

    if (plans.length === 0) {
      const span = fromMs !== undefined || toMs !== undefined ? ` between ${fromMs === undefined ? 'the start' : `${round(fromMs)} ms`} and ${toMs === undefined ? 'the end' : `${round(toMs)} ms`}` : ''
      throw new CommandError(
        `${layer.name} has no keys to smooth${span}.`,
        "keyframes.inspect id lists each track's keys with their comp times; smoothing needs two keys or more on a track inside the range.",
      )
    }

    ctx.write('Smooth keys', (draft) => {
      const target = locateLayer(draft, layer.id).layer
      for (const plan of plans) {
        const keys = target.animations[plan.path] as Keyframe[]
        for (const [index, easing] of plan.easings) (keys[index] as Keyframe).ease = easing
        for (const [index, spatial] of plan.spatial ?? []) (keys[index] as Keyframe).spatial = spatial
      }
      pruneSpatial(target.animations)
    })
    return { id: layer.id, tracks: plans.map(({ path, keys }) => ({ path, keys })), ...(curved > 0 ? { curved } : {}) }
  },
})

/** The numeric track paths to smooth; refuses a named property that is not numeric. */
function pickTracks(layer: Layer, properties: readonly string[] | undefined): string[] {
  if (properties) {
    const specs: PropertySpec[] = []
    for (const name of properties) {
      for (const spec of resolveProperty(layer, name)) {
        if (specs.some((s) => s.path === spec.path)) continue
        if (spec.type !== 'number' || !isNumeric(layer.animations[spec.path] ?? [])) {
          throw new CommandError(
            `${name} is not a numeric property.`,
            'Smooth works on numbers (position, scale, rotation, opacity…); colours, paths and switches keep their easing.',
          )
        }
        specs.push(spec)
      }
    }
    return specs.map((s) => s.path)
  }
  const specs = propertiesOf(layer)
  return Object.entries(layer.animations)
    .filter(([path, keys]) => keys.length > 0 && isNumeric(keys) && specs.some((s) => s.path === path && s.type === 'number'))
    .map(([path]) => path)
}

/** Handles and easing for a position path, or undefined when its keys do not pair up in the range. */
function planMotion(layer: Layer, inRange: (k: Keyframe) => boolean): { plans: TrackPlan[]; curved: number } | undefined {
  const xs = layer.animations['transform.x'] ?? []
  const ys = layer.animations['transform.y'] ?? []
  const xIndex = xs.flatMap((k, i) => (inRange(k) ? [i] : []))
  const yIndex = ys.flatMap((k, i) => (inRange(k) ? [i] : []))
  const rows = motionKeysOf(layer).filter((r) => inRange({ t: r.t } as Keyframe))
  if (rows.length < 2 || xIndex.length !== rows.length || yIndex.length !== rows.length) return undefined

  const run = pathHandles(rows)
  const easings = pathEasings(run)
  const spatial: NonNullable<TrackPlan['spatial']> = new Map()
  if (rows.length >= 3) {
    run.forEach((row, i) => {
      spatial.set(xIndex[i] as number, { in: row.in, out: row.out })
    })
  }
  const easingsOf = (index: number[]) => new Map(easings.map((e, i) => [index[i] as number, e]))
  return {
    plans: [
      { path: 'transform.x', keys: rows.length, easings: easingsOf(xIndex), ...(spatial.size > 0 ? { spatial } : {}) },
      { path: 'transform.y', keys: rows.length, easings: easingsOf(yIndex) },
    ],
    curved: spatial.size,
  }
}
