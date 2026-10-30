import { z } from 'zod'
import { type Handle, KeyInputSchema, type ParsedKey, toKey } from '../compat'
import { findComp, locateLayer } from '../doc'
import { CommandError } from '../errors'
import { KEY_EPSILON_MS, pruneSpatial, upsertKey } from '../keys'
import { arcHandles, hasCurves, motionKeysOf } from '../motionPath'
import { checkValue, evaluateProperty, propertiesOf, readProperty, resolveProperty, spreadValue, writeProperty } from '../properties'
import { defineCommand } from '../registry'
import { type Easing, IdSchema, type Keyframe, type KeyValue, type Layer, type TextRange } from '../schema'
import { simplifiableTracks, simplifyTracks } from '../simplify'
import { graphemes, isolateRange } from '../textRanges'
import { closedPath } from './worldExtrude'

export const keyframesSet = defineCommand({
  name: 'keyframes.set',
  summary: 'Animate a property by writing its keys: time, value and easing.',
  details:
    'Key times are relative to the layer start, or comp time with clock "comp". mode "replace" (default) replaces every key of the property; "merge" adds keys or replaces the ones at the same times. A key\'s ease shapes the move towards the next key: ease-out to land, ease-in to leave, ease-in-out between two rests, hold for a cut. "scale" keys both scale axes (one value, or [sx, sy]); "position" keys x and y as [x, y]. On position, a key may bend the path: arc (px the segment leaving it peaks above the higher end, negative sags; easing defaults to linear) or in/out handles (px relative to the key; null clears one; our {t, v, spatial: {in, out}} replaces both). keyframes.inspect prints a curved key as ↷(out dx,dy in dx,dy): paste those numbers back as out and in. AtomCut\'s shape works too: property instead of path, keys as {at, value, easing} (easing may be "cubic-bezier(x1, y1, x2, y2)"), and replace: false for merge.',
  effect: 'write',
  input: z.strictObject({
    id: IdSchema,
    path: z.string().min(1).optional().describe('Property name or path, e.g. "x", "transform.x", "scale" or "position"'),
    property: z.string().min(1).optional().describe("Same as path (AtomCut's name)"),
    keys: z.array(KeyInputSchema).min(1).describe('{t, v, ease} or {at, value, easing}'),
    clock: z.enum(['layer', 'comp']).default('layer'),
    mode: z.enum(['replace', 'merge']).optional().describe('Default replace'),
    replace: z.boolean().optional().describe('AtomCut\'s switch: true is mode "replace", false is "merge"'),
    range: z
      .strictObject({ start: z.number().int().min(0), end: z.number().int().min(1) })
      .optional()
      .describe('Keys on part of a text (character indices): color, opacity or fontSize of those characters only'),
  }),
  run: (input, ctx) => {
    const { id, clock } = input
    const requested = propertyName(input.path, input.property)

    if (input.mode !== undefined && input.replace !== undefined && (input.mode === 'replace') !== input.replace) {
      throw new CommandError(`mode "${input.mode}" and replace: ${input.replace} disagree.`, 'Give one of them.')
    }
    const mode = input.mode ?? (input.replace === false ? 'merge' : 'replace')
    let { layer } = locateLayer(ctx.project, id)
    let name = requested
    const keys = input.keys.map(toKey)
    if (input.range && keys.some(shapesPath)) throw shapeError()
    // AtomCut's range: key some characters' colour, opacity or size through a styled range of their own.
    let isolated: TextRange[] | undefined
    if (input.range) {
      if (layer.kind !== 'text') throw new CommandError('range keys part of a text; this is not a text layer.')
      const field = RANGE_FIELDS[name]
      if (!field) {
        throw new CommandError(
          `"${name}" cannot be keyed on part of a text.`,
          'On part of a text: color, opacity and fontSize. Movement per letter or word comes with the per-unit animator (step A9).',
        )
      }
      const total = graphemes(layer.text).length
      const end = Math.min(input.range.end, total)
      if (end <= input.range.start) throw new CommandError(`The range ${input.range.start}…${input.range.end} is outside the text (${total} characters).`)
      const fill = field === 'color' ? { color: layer.style.color } : field === 'fontSize' ? { fontSize: layer.style.fontSize } : { opacity: 1 }
      const made = isolateRange(layer.ranges, input.range.start, end, fill, () => ctx.ids('range'))
      isolated = made.ranges
      layer = { ...layer, ranges: made.ranges }
      name = `range.${made.id}.${field}`
    }
    const offset = clock === 'comp' ? layer.startMs : 0
    const specs = resolveProperty(layer, name)
    const positional = specs.every((s) => POSITION_PATHS.includes(s.path))
    if (!positional && keys.some(shapesPath)) throw shapeError()
    // An arc is a thrown segment: linear easing unless the caller says otherwise.
    const easeOf = (k: ParsedKey): Easing | undefined => k.ease ?? (k.arc !== undefined ? 'linear' : undefined)
    const spread = keys.map((k) => spreadValue(specs, name, k.v))
    const tracks = specs.map((spec, member) => ({
      spec,
      keys: keys.map((k, i) => ({
        key: { t: k.t - offset, v: checkValue(spec, spread[i]?.[member]), ease: easeOf(k) ?? (spec.path === 'switch' ? 'hold' : 'ease-in-out') } satisfies Keyframe,
        explicitEase: easeOf(k) !== undefined,
      })),
    }))
    if (layer.kind === 'path' && layer.extrude && tracks.some(({ spec, keys }) => spec.path === 'geometry' && keys.some(({ key }) => typeof key.v === 'string' && !closedPath(key.v)))) {
      throw new CommandError('An extruded path cannot have open geometry keys.', 'Close every contour with Z, or remove extrude first.')
    }
    // Every track is worked out before anything is written, so a refusal leaves no trace.
    const lists = new Map<string, Keyframe[]>()
    for (const { spec, keys: incoming } of tracks) {
      const list = mode === 'replace' ? [] : copyKeys(layer.animations[spec.path])
      for (const { key, explicitEase } of incoming) upsertKey(list, key, mode === 'merge' && !explicitEase)
      lists.set(spec.path, list)
    }
    if (positional && keys.some(touchesPath)) shapeMotion(layer, specs[0]?.path ?? '', lists, keys, offset)
    const written = new Set(specs.map((s) => s.path))
    let curved = 0
    ctx.write('Set keys', (draft) => {
      const target = locateLayer(draft, layer.id).layer
      if (isolated && target.kind === 'text') target.ranges = isolated
      for (const [path, list] of lists) {
        if (written.has(path) || list.length > 0) target.animations[path] = list
      }
      // Replacing one axis of a motion path drops the handles that lost their partner.
      pruneSpatial(target.animations)
      curved = (target.animations['transform.x'] ?? []).filter(hasHandle).length
    })
    return { id: layer.id, paths: tracks.map((t) => t.spec.path), keys: keys.length, mode, ...(curved > 0 ? { curved } : {}) }
  },
})

const POSITION_PATHS = ['transform.x', 'transform.y']

const nonNull = (h: Handle | null | undefined): h is Handle => h !== undefined && h !== null

/** A key that asks for a curve: an arc, or a handle that is not null. */
const shapesPath = (k: ParsedKey) => k.arc !== undefined || nonNull(k.in) || nonNull(k.out)

/** A key that says something about handles, null (clear) included. */
const touchesPath = (k: ParsedKey) => k.arc !== undefined || k.in !== undefined || k.out !== undefined

const hasHandle = (k: Keyframe) => k.spatial !== undefined && (k.spatial.in !== null || k.spatial.out !== null)

const shapeError = () =>
  new CommandError('`arc`, `in` and `out` shape a motion path.', 'They work on position ([x, y]); key it with keyframes.set property "position".')

const copyKeys = (keys: readonly Keyframe[] | undefined): Keyframe[] =>
  (keys ?? []).map((k) => ({ ...k, ...(k.spatial ? { spatial: { ...k.spatial } } : {}) }))

const findKey = (list: readonly Keyframe[], t: number) => list.find((k) => Math.abs(k.t - t) < KEY_EPSILON_MS)

function setSpatial(key: Keyframe, spatial: { in: Handle | null; out: Handle | null }): void {
  if (spatial.in === null && spatial.out === null) delete key.spatial
  else key.spatial = { in: spatial.in && [spatial.in[0], spatial.in[1]], out: spatial.out && [spatial.out[0], spatial.out[1]] }
}

/**
 * Writes the handles of a position write onto the x keys (in `lists`, which it
 * completes with both axes): an arc becomes the out and in handles of its
 * segment, in and out are kept or replaced side by side, and a key that has
 * only one axis gets the other at its value on the path now.
 */
function shapeMotion(layer: Layer, primary: string, lists: Map<string, Keyframe[]>, keys: readonly ParsedKey[], offset: number): void {
  const xs = lists.get('transform.x') ?? copyKeys(layer.animations['transform.x'])
  const ys = lists.get('transform.y') ?? copyKeys(layer.animations['transform.y'])
  lists.set('transform.x', xs)
  lists.set('transform.y', ys)
  const axes = [
    { list: xs, spec: resolveProperty(layer, 'transform.x')[0] },
    { list: ys, spec: resolveProperty(layer, 'transform.y')[0] },
  ]
  const own = lists.get(primary) ?? xs
  const touched = keys.filter(touchesPath).map((k) => ({ k, t: k.t - offset }))

  // Both axes need a key wherever a curve is asked for (every written key, when an arc needs both its ends);
  // the missing one is added where the layer is now.
  const arcing = touched.some(({ k }) => k.arc !== undefined)
  for (const { k, t } of keys.map((k) => ({ k, t: k.t - offset }))) {
    if (!shapesPath(k) && !arcing) continue
    const ease = findKey(own, t)?.ease ?? 'ease-in-out'
    for (const { list, spec } of axes) {
      const key = findKey(list, t)
      if (key) {
        if (k.arc !== undefined) key.ease = ease
        continue
      }
      const now = spec ? evaluateProperty(layer, spec, t) : undefined
      upsertKey(list, { t, v: typeof now === 'number' ? now : 0, ease }, false)
    }
  }

  // in and out: a side that is not given stays as it was; null clears it.
  for (const { k, t } of touched) {
    if (k.in === undefined && k.out === undefined) continue
    const key = findKey(xs, t)
    if (!key) continue
    setSpatial(key, {
      in: k.in !== undefined ? k.in : (key.spatial?.in ?? null),
      out: k.out !== undefined ? k.out : (key.spatial?.out ?? null),
    })
  }

  // An arc wins over an out on the same key; its segment ends at the next position key.
  const rows = motionKeysOf({ ...layer, animations: { ...layer.animations, 'transform.x': xs, 'transform.y': ys } })
  for (const { k, t } of touched) {
    if (k.arc === undefined) continue
    const index = rows.findIndex((r) => Math.abs(r.t - t) < KEY_EPSILON_MS)
    const from = rows[index]
    const to = rows[index + 1]
    if (!from || !to) {
      throw new CommandError(
        `arc shapes the segment leaving the key at ${t + offset} ms; there is no later position key.`,
        'Key the position the layer lands on (keyframes.set property "position", mode "merge"), then set the arc.',
      )
    }
    const clash = touched.find((o) => Math.abs(o.t - to.t) < KEY_EPSILON_MS && nonNull(o.k.in))
    if (clash) {
      throw new CommandError(
        'One curve per segment: keep the arc or the handle.',
        `The arc at ${t + offset} ms and the in handle at ${clash.t + offset} ms both shape the segment between them.`,
      )
    }
    const handles = arcHandles([from.x, from.y], [to.x, to.y], k.arc)
    const start = findKey(xs, from.t)
    const end = findKey(xs, to.t)
    if (start) setSpatial(start, { in: start.spatial?.in ?? null, out: handles.out })
    if (end) setSpatial(end, { in: handles.in, out: end.spatial?.out ?? null })
  }
}

/** Properties that can be keyed on part of a text, and the range style field each becomes. */
const RANGE_FIELDS: Readonly<Record<string, 'color' | 'opacity' | 'fontSize'>> = {
  color: 'color',
  'style.color': 'color',
  opacity: 'opacity',
  'transform.opacity': 'opacity',
  fontSize: 'fontSize',
  'style.fontSize': 'fontSize',
}

/** The property named by path or by AtomCut's property, which must agree when both are given. */
function propertyName(path: string | undefined, property: string | undefined): string {
  if (path !== undefined && property !== undefined && path !== property) {
    throw new CommandError(`path "${path}" and property "${property}" disagree.`, 'Give one of them.')
  }
  const name = path ?? property
  if (name === undefined) throw new CommandError('Say which property: path (or property), e.g. "x" or "opacity".')
  return name
}

export const keyframesRemove = defineCommand({
  name: 'keyframes.remove',
  summary: "Remove a property's keys at given times. When no key is left, the property keeps its first key's value.",
  details:
    'times are relative to the layer start, or comp time with clock "comp". A key matches a time within half a millisecond. "scale" removes the keys of both scale axes.',
  effect: 'write',
  input: z.strictObject({
    id: IdSchema,
    path: z.string().min(1).describe('Property name or path, e.g. "x" or "transform.x"'),
    times: z.array(z.number()).min(1),
    clock: z.enum(['layer', 'comp']).default('layer'),
  }),
  run: ({ id, path, times, clock }, ctx) => {
    const { layer } = locateLayer(ctx.project, id)
    const offset = clock === 'comp' ? layer.startMs : 0
    const hit = (t: number) => times.some((time) => Math.abs(time - offset - t) < KEY_EPSILON_MS)
    const specs = resolveProperty(layer, path)
    const paths = specs.map((spec) => spec.path)
    const removed = paths.reduce((count, p) => count + (layer.animations[p] ?? []).filter((k) => hit(k.t)).length, 0)
    if (removed === 0) {
      throw new CommandError(
        `"${path}" has no key at ${times.join(', ')} ms${clock === 'comp' ? ' comp time' : ' from the layer start'}.`,
        'layer.get lists the keys under animations, with times relative to the layer start.',
      )
    }
    ctx.write('Remove keys', (draft) => {
      const target = locateLayer(draft, layer.id).layer
      for (const spec of specs) {
        const p = spec.path
        const keys = target.animations[p]
        if (!keys) continue
        const kept = keys.filter((k) => !hit(k.t))
        if (kept.length > 0) {
          target.animations[p] = kept
          continue
        }
        const first = keys[0]
        if (first !== undefined && readProperty(target, spec) !== undefined) writeProperty(target, spec, first.v)
        delete target.animations[p]
      }
      // A removed x key takes its handles; a removed y key breaks its x key's.
      pruneSpatial(target.animations)
    })
    return { id: layer.id, paths, removed }
  },
})

export const keyframesClear = defineCommand({
  name: 'keyframes.clear',
  summary: 'Remove the keys of some properties, or of every property of a layer, freezing each at its value at atMs so nothing jumps.',
  details:
    'atMs is comp time and defaults to the playhead; without an editor (and no atMs) each property keeps its first key\'s value. path names one property; properties (AtomCut\'s shape) several; neither clears every keyed property.',
  effect: 'write',
  input: z.strictObject({
    id: IdSchema,
    path: z.string().min(1).optional(),
    properties: z.array(z.string().min(1)).min(1).optional().describe('Several properties; omitted with path: every keyed property'),
    atMs: z.number().optional().describe('Comp time to freeze at; default the playhead'),
  }),
  run: ({ id, path, properties, atMs }, ctx) => {
    const { layer } = locateLayer(ctx.project, id)
    const names = [...(path !== undefined ? [path] : []), ...(properties ?? [])]
    const specs = names.length > 0 ? names.flatMap((n) => resolveProperty(layer, n)) : propertiesOf(layer)
    const keyed = specs.filter((s, i) => (layer.animations[s.path]?.length ?? 0) > 0 && specs.indexOf(s) === i)
    // When everything is cleared, keyed paths that no property names are dropped too.
    const stray = names.length > 0 ? [] : Object.keys(layer.animations).filter((p) => !keyed.some((s) => s.path === p))
    const freezeAt = atMs ?? ctx.view.playheadMs
    const frozen = keyed.map((spec) => ({
      spec,
      path: spec.path,
      value: freezeAt === undefined ? layer.animations[spec.path]?.[0]?.v : evaluateProperty(layer, spec, freezeAt - layer.startMs),
    }))
    const cleared = [...frozen.map((f) => f.path), ...stray]
    if (cleared.length === 0) return { cleared }
    ctx.write('Clear keys', (draft) => {
      const target = locateLayer(draft, layer.id).layer
      for (const { spec, path: p, value } of frozen) {
        if (value !== undefined && readProperty(target, spec) !== undefined) writeProperty(target, spec, value)
        delete target.animations[p]
      }
      for (const p of stray) delete target.animations[p]
      pruneSpatial(target.animations)
    })
    return freezeAt === undefined ? { cleared } : { cleared, frozenAtMs: freezeAt }
  },
})

const round = (n: number) => Math.round(n * 1000) / 1000

const round1 = (n: number) => Math.round(n * 10) / 10

/** A curved motion key's handles, "↷(out dx,dy in dx,dy)", in px to 0.1; empty when it has none. */
function formatHandles(key: Keyframe): string {
  const { in: arriving, out: leaving } = key.spatial ?? { in: null, out: null }
  const parts = [
    ...(leaving ? [`out ${round1(leaving[0])},${round1(leaving[1])}`] : []),
    ...(arriving ? [`in ${round1(arriving[0])},${round1(arriving[1])}`] : []),
  ]
  return parts.length > 0 ? ` ↷(${parts.join(' ')})` : ''
}

function formatValue(v: KeyValue): string {
  if (typeof v === 'number') return String(round(v))
  if (Array.isArray(v)) return `[${v.map(round).join(', ')}]`
  return String(v)
}

/** An easing as keyframes.set accepts it back. */
function formatEase(ease: Easing): string {
  return typeof ease === 'string' ? ease : `cubic-bezier(${ease.x1}, ${ease.y1}, ${ease.x2}, ${ease.y2})`
}

/** A track keyed on half the frames it spans or more: a sampled formula rather than poses. */
function isBaked(keys: readonly Keyframe[], fps: number): boolean {
  if (keys.length < 12) return false
  const spanMs = (keys.at(-1)?.t ?? 0) - (keys[0]?.t ?? 0)
  return keys.length >= 0.5 * Math.max(1, (spanMs * fps) / 1000)
}

export const keyframesSimplify = defineCommand({
  name: 'keyframes.simplify',
  summary: 'Turn sampled, frame-by-frame keys into the fewest eased keys that play the same, within a tolerance.',
  details:
    'With id: every numeric track of the layer that has 3 or more keys, or only properties. With compId (or neither id nor compId: the comp open in the editor): every baked track of every layer in it. Each track keeps its first and last key and gets eased keys in between, fitted to what plays now, with linear, hold, the presets or a fitted curve; position (x and y) is reduced together. tolerance is the largest error in the property\'s own units; the defaults are 0.5 px for position and size, 0.25 degrees for rotation, 0.3 % of the range otherwise. A track is rewritten only when it ends up with fewer keys. Colours, paths and switches are left alone. Simplify keeps the timing, not the intent: for new motion write a few poses with easing instead.',
  effect: 'write',
  input: z.strictObject({
    id: IdSchema.optional().describe('One layer: its numeric tracks with 3 or more keys'),
    compId: IdSchema.optional().describe("A comp: its baked tracks (AtomCut's frameId works too); default the one open in the editor"),
    properties: z.array(z.string().min(1)).min(1).optional().describe('Only these properties of the layer (needs id)'),
    tolerance: z.number().positive().optional().describe("Largest error in the property's own units; overrides the defaults"),
  }),
  run: ({ id, compId, properties, tolerance }, ctx) => {
    if (properties !== undefined && id === undefined) throw new CommandError('properties needs id: the layer whose tracks to simplify.')
    const jobs: { layerId: string; layer: Layer; fps: number; tracks: ReturnType<typeof simplifiableTracks> }[] = []
    // A curved motion path is a few hand-placed keys with handles; resampling it would lose the curve.
    const skipped: { layerId: string; path: string; reason: string }[] = []
    const leaveCurves = (layer: Layer, tracks: ReturnType<typeof simplifiableTracks>) => {
      if (!hasCurves(layer)) return tracks
      return tracks.filter((t) => {
        const curved = t.spec.path === 'transform.x' || t.spec.path === 'transform.y'
        if (curved) skipped.push({ layerId: layer.id, path: t.spec.path, reason: 'curved motion path' })
        return !curved
      })
    }
    if (id !== undefined) {
      const { comp, layer } = locateLayer(ctx.project, id)
      const wanted = properties?.flatMap((n) => resolveProperty(layer, n).map((s) => s.path))
      const tracks = leaveCurves(
        layer,
        simplifiableTracks(layer).filter((t) => !wanted || wanted.includes(t.spec.path)),
      )
      if (tracks.length === 0 && skipped.length > 0) {
        return { tracks: [], keysBefore: 0, keysAfter: 0, skipped, note: 'A curved motion path is left as it is.' }
      }
      if (tracks.length === 0) {
        throw new CommandError(
          `${layer.name} has no numeric track with 3 or more keys${wanted ? ' among those properties' : ''}.`,
          'keyframes.inspect id lists the tracks and their keys; a track with fewer keys is already as small as it gets.',
        )
      }
      jobs.push({ layerId: layer.id, layer, fps: comp.fps, tracks })
    } else {
      const comp = findComp(ctx.project, compId ?? ctx.view.compId)
      for (const layer of comp.tracks.flatMap((track) => track.layers)) {
        const tracks = leaveCurves(
          layer,
          simplifiableTracks(layer).filter((t) => isBaked(t.keys, comp.fps)),
        )
        if (tracks.length > 0) jobs.push({ layerId: layer.id, layer, fps: comp.fps, tracks })
      }
      if (jobs.length === 0) {
        return { tracks: [], keysBefore: 0, keysAfter: 0, ...(skipped.length > 0 ? { skipped } : {}), note: 'No baked tracks in this comp.' }
      }
    }

    const tracks: { layerId: string; path: string; before: number; after: number }[] = []
    const writes: { layerId: string; path: string; keys: Keyframe[] }[] = []
    for (const job of jobs) {
      for (const result of simplifyTracks(job.layer, job.tracks, job.fps, tolerance)) {
        tracks.push({ layerId: job.layerId, path: result.spec.path, before: result.before, after: result.after })
        if (result.keys) writes.push({ layerId: job.layerId, path: result.spec.path, keys: result.keys })
      }
    }
    if (writes.length > 0) {
      ctx.write('Simplify keys', (draft) => {
        for (const { layerId, path, keys } of writes) locateLayer(draft, layerId).layer.animations[path] = keys
      })
    }
    return {
      tracks,
      keysBefore: tracks.reduce((sum, t) => sum + t.before, 0),
      keysAfter: tracks.reduce((sum, t) => sum + t.after, 0),
      ...(skipped.length > 0 ? { skipped } : {}),
    }
  },
})

export const keyframesInspect = defineCommand({
  name: 'keyframes.inspect',
  summary: "Keys at a glance: one layer's tracks, one line each, or a comp's key budget with baked tracks flagged.",
  details:
    'With id: each track as "time value easing" per key, in comp ms, separated by " · " (the last key has no easing); the easings paste back into keyframes.set (use clock "comp" for these times). A transform.x key on a curved motion path shows ↷(out dx,dy in dx,dy) after its value: the handles leaving and arriving at it, px relative to the key; they paste back as out and in. Without id: the comp\'s totals and its heaviest tracks. A track keyed on nearly every frame is baked: it plays, but it edits terribly; rewrite it as a few poses with easing.',
  effect: 'read',
  input: z.strictObject({
    id: IdSchema.optional().describe('A layer: list its tracks key by key'),
    compId: IdSchema.optional().describe('A comp to audit when no id is given; default the one open in the editor'),
    properties: z.array(z.string().min(1)).min(1).optional().describe('Only these properties of the layer'),
    limit: z.number().int().min(1).max(200).default(20).describe('Comp audit: how many of the heaviest tracks to list'),
  }),
  run: ({ id, compId, properties, limit }, ctx) => {
    if (id !== undefined) {
      const { comp, layer } = locateLayer(ctx.project, id)
      const wanted = properties?.flatMap((n) => resolveProperty(layer, n).map((s) => s.path))
      const tracks = Object.entries(layer.animations)
        .filter(([p, keys]) => keys.length > 0 && (!wanted || wanted.includes(p)))
        .map(([p, keys]) => ({
          path: p,
          alias: propertiesOf(layer).find((s) => s.path === p)?.alias ?? p,
          keys: keys.length,
          baked: isBaked(keys, comp.fps),
          line: keys
            .map(
              (k, i) =>
                `${round(layer.startMs + k.t)} ${formatValue(k.v)}${p === 'transform.x' ? formatHandles(k) : ''}${i < keys.length - 1 ? ` ${formatEase(k.ease)}` : ''}`,
            )
            .join(' · '),
        }))
      const curvedKeys = (layer.animations['transform.x'] ?? []).filter(hasHandle).length
      return { id: layer.id, name: layer.name, startMs: layer.startMs, clock: 'comp', tracks, ...(curvedKeys > 0 ? { curvedKeys } : {}) }
    }
    if (properties !== undefined) throw new CommandError('properties needs id: the layer whose tracks to list.')
    const comp = findComp(ctx.project, compId ?? ctx.view.compId)
    const layers = comp.tracks.flatMap((track) => track.layers)
    const all = layers.flatMap((layer) =>
      Object.entries(layer.animations)
        .filter(([, keys]) => keys.length > 0)
        .map(([p, keys]) => ({ layerId: layer.id, layerName: layer.name, path: p, keys: keys.length, baked: isBaked(keys, comp.fps) })),
    )
    return {
      compId: comp.id,
      layers: layers.length,
      animatedLayers: new Set(all.map((t) => t.layerId)).size,
      tracks: all.length,
      keys: all.reduce((sum, t) => sum + t.keys, 0),
      bakedTracks: all.filter((t) => t.baked).length,
      curvedKeys: layers.reduce((sum, layer) => sum + (layer.animations['transform.x'] ?? []).filter(hasHandle).length, 0),
      heaviest: [...all].sort((a, b) => b.keys - a.keys).slice(0, limit),
    }
  },
})
