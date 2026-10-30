import type { Draft } from 'immer'
import { z } from 'zod'
import { idList } from '../compat'
import { findComp, isSpatialKind, layerEnd, locateLayer, newTrack } from '../doc'
import { CommandError, parseOrThrow } from '../errors'
import { stripMaterial } from '../materials'
import { nestedInside } from '../nest'
import { type CommandContext, defineCommand, type Placement } from '../registry'
import { type Comp, CompSchema, type Layer, LayerSchema, type NestedLayer, type Track } from '../schema'
import { copyLanes, IdsSchema, resolveUnits, unitLanes } from './arrange'

/** The largest side a comp may have. */
const MAX_SIDE = 8192

/** A moment to measure a layer at: the playhead while it shows, else its start. */
export const measureTime = (layer: Layer, playheadMs: number | undefined) =>
  playheadMs !== undefined && playheadMs >= layer.startMs && playheadMs < layerEnd(layer) ? playheadMs : layer.startMs

/** Moves a layer by (-dx, -dy) in comp space and by -dt in time: its position, its x and y keys, a group's layout box. */
function shiftLayer(layer: Layer, dx: number, dy: number, dt: number): void {
  layer.startMs -= dt
  if (layer.kind === 'group') {
    // A group's transform is a change from where its members are; only a layout's box is placed in comp space.
    if (layer.layout) {
      layer.layout.x -= dx
      layer.layout.y -= dy
    }
    return
  }
  layer.transform.x -= dx
  layer.transform.y -= dy
  for (const [path, d] of [
    ['transform.x', dx],
    ['transform.y', dy],
  ] as const) {
    for (const key of layer.animations[path] ?? []) if (typeof key.v === 'number') key.v -= d
  }
}

export const layersNest = defineCommand({
  name: 'layers.nest',
  summary: 'Precompose layers into a nested comp: one layer on the outside, their own timeline inside. Nothing moves on screen.',
  details:
    'The layers must be at one level (all top-level, or all in one group); a group goes with everything in it. The new comp hugs the layers (it needs the editor to measure them) and is transparent, so what moves past its box still shows; fullFrame: true makes it this comp\'s size and centre instead. Its timeline starts at the layers\' earliest start. The nested layer takes the place of the front-most one. Animate the nested layer to move the whole piece as one, or give it its own speed and loop (layer.patch playback). Open the inside by entering the layer in the editor; layers.list on its sourceCompId lists it.',
  effect: 'write',
  input: z.strictObject({
    ids: IdsSchema,
    name: z.string().min(1).optional(),
    fullFrame: z.boolean().default(false).describe("The comp takes this comp's size and centre instead of hugging the layers"),
  }),
  run: ({ ids, name, fullFrame }, ctx) => {
    const { comp, layers } = resolveUnits(ctx.project, idList(undefined, ids), 'Nest')
    return nestLayers(ctx, comp, layers, { fullFrame, ...(name !== undefined ? { name } : {}) })
  },
})

export interface NestOptions {
  /** The comp takes the source comp's size and centre instead of hugging the layers. */
  fullFrame: boolean
  /** The nested layer's name: given, or made from the front-most unit; default that layer's name. */
  name?: string | ((front: Layer) => string)
  /** The undo step's label when this is the first write; default "Nest layers". */
  label?: string
  /** Makes the new comp a 3D world (`world` with its defaults). */
  world?: boolean
  /** Edits the new comp's layers before it is stored (the layers are already shifted into its time). */
  convert?: (inside: Comp) => void
}

/** The body of `layers.nest`: nests resolved units of one comp into a new embedded comp. */
export function nestLayers(ctx: CommandContext, comp: Comp, layers: Layer[], { fullFrame, name, label, world, convert }: NestOptions) {
  const laneOf = (layer: Layer) => comp.tracks.find((t) => t.layers.some((l) => l.id === layer.id)) as Track
  const parent = laneOf(layers[0] as Layer).groupId
  const stray = layers.find((l) => laneOf(l).groupId !== parent)
  if (stray) throw new CommandError(`"${stray.name}" is at another level: nest layers that are all top-level, or all in the same group.`)

  // Cameras, lights, controllers and meshes live only in a 3D world; the new comp is flat.
  for (const layer of layers) {
    const inside = layer.kind === 'group' ? unitLanes(comp, layer).flatMap((t) => t.layers) : [layer]
    const spatial = inside.find((l) => isSpatialKind(l.kind))
    if (spatial) throw new CommandError(`"${spatial.name}" is a ${spatial.kind} and cannot be nested.`, 'Cameras, lights, controllers and meshes stay in their 3D world.')
  }

  // Front first, so the nested layer takes the front-most one's place.
  const units = layers
    .map((layer) => ({ layer, lanes: unitLanes(comp, layer), top: comp.tracks.indexOf(laneOf(layer)) }))
    .sort((a, b) => a.top - b.top)
  const start = Math.min(...layers.map((l) => l.startMs))
  const end = Math.max(...layers.map(layerEnd))

  let box = { cx: 0, cy: 0, width: comp.width, height: comp.height }
  if (!fullFrame) {
    if (!ctx.measure) {
      throw new CommandError('layers.nest needs the editor to measure the layers, and this session cannot.', 'Pass fullFrame: true to nest at this comp\'s own size, or run it in the editor.')
    }
    const found: Placement[] = []
    const byTime = new Map<number, Layer[]>()
    for (const layer of layers) {
      if (layer.kind === 'audio') continue
      const at = measureTime(layer, ctx.view.playheadMs)
      byTime.set(at, [...(byTime.get(at) ?? []), layer])
    }
    for (const [at, list] of byTime) {
      const placements = ctx.measure(comp, at)
      for (const layer of list) {
        const p = placements.get(layer.id)
        if (p) found.push(p)
      }
    }
    if (found.length > 0) {
      const left = Math.min(...found.map((p) => p.bounds.left))
      const top = Math.min(...found.map((p) => p.bounds.top))
      const right = Math.max(...found.map((p) => p.bounds.left + p.bounds.width))
      const bottom = Math.max(...found.map((p) => p.bounds.top + p.bounds.height))
      box = {
        cx: Math.round((left + right) / 2),
        cy: Math.round((top + bottom) / 2),
        width: Math.min(MAX_SIDE, Math.max(16, Math.round(right - left))),
        height: Math.min(MAX_SIDE, Math.max(16, Math.round(bottom - top))),
      }
    }
  }

  const front = units[0]?.layer as Layer
  const sourceId = ctx.ids('comp')
  const nested = parseOrThrow(
    LayerSchema,
    {
      id: ctx.ids('layer'),
      name: typeof name === 'function' ? name(front) : (name ?? front.name),
      kind: 'nested',
      sourceCompId: sourceId,
      startMs: start,
      durationMs: Math.max(1, end - start),
      transform: { x: box.cx, y: box.cy },
    },
    'The nested layer',
  ) as NestedLayer
  const fresh = units.map(() => ctx.ids('track'))
  const nestedLane = ctx.ids('track')
  ctx.write(label ?? 'Nest layers', (draft) => {
    const target = findComp(draft, comp.id)
    // Take the units out, as whole lanes or the layer alone on a new lane.
    const moved: Draft<Track>[] = []
    for (const [i, unit] of units.entries()) {
      const lanes = unit.lanes.map((t) => target.tracks.find((d) => d.id === t.id) as Draft<Track>)
      const own = lanes[0] as Draft<Track>
      if (unit.layer.kind === 'group' || own.layers.length === 1) {
        moved.push(...lanes)
        continue
      }
      const [taken] = own.layers.splice(
        own.layers.findIndex((l) => l.id === unit.layer.id),
        1,
      )
      moved.push(newTrack(fresh[i] as string, [taken as Layer], undefined, own.groupId) as Draft<Track>)
    }
    const at = target.tracks.findIndex((t) => t.id === units[0]?.lanes[0]?.id)
    const leaving = new Set(moved)
    const before = target.tracks.slice(0, Math.max(0, at)).filter((t) => leaving.has(t)).length
    target.tracks = target.tracks.filter((t) => !leaving.has(t))
    for (const lane of moved) {
      if (lane.groupId === parent) lane.groupId = null
      for (const layer of lane.layers) {
        shiftLayer(layer as Layer, box.cx, box.cy, start)
        // The new comp is flat unless a world was asked for: a material cannot go with the layer.
        if (!world) stripMaterial(layer)
      }
    }
    const inside = parseOrThrow(
      CompSchema,
      {
        id: sourceId,
        name: nested.name,
        width: box.width,
        height: box.height,
        fps: comp.fps,
        durationMs: nested.durationMs,
        background: '#00000000',
        tracks: moved,
        embedded: true,
        ...(world ? { world: {} } : {}),
      },
      'The nested comp',
    )
    convert?.(inside)
    draft.comps.push(inside as Draft<Comp>)
    target.tracks.splice(Math.max(0, at - before), 0, newTrack(nestedLane, [nested], undefined, parent) as Draft<Track>)
  })
  return { id: nested.id, sourceCompId: sourceId, nested: layers.map((l) => l.id), box: { width: box.width, height: box.height, x: box.cx, y: box.cy } }
}

export const layersMakeUnique = defineCommand({
  name: 'layers.makeUnique',
  summary: 'Give nested layers their own copy of the comp they show, so editing it stops changing the other places it shows.',
  details:
    "A nested layer's inside is embedded (its own comp, made by layers.nest) or linked (a comp of the project, or one other layers show too); layers.list shows it as inside. makeUnique copies a linked source into a new embedded comp for this layer; the original stays as it is. A layer that is already embedded is skipped. Returns each layer's new source comp id.",
  effect: 'write',
  input: z.strictObject({ ids: IdsSchema }),
  run: ({ ids }, ctx) => {
    const layers = idList(undefined, ids).map((ref) => locateLayer(ctx.project, ref).layer)
    const wrong = layers.find((l) => l.kind !== 'nested')
    if (wrong) throw new CommandError(`"${wrong.name}" is not a nested comp.`, 'makeUnique works on nested layers (kind nested).')
    const made: Record<string, string> = {}
    const skipped: string[] = []
    const copies: Comp[] = []
    for (const layer of layers as NestedLayer[]) {
      if (nestedInside(ctx.project, layer) === 'embedded') {
        skipped.push(layer.id)
        continue
      }
      const source = findComp(ctx.project, layer.sourceCompId)
      const tracks = copyLanes(source.tracks, ctx.ids, new Map()).map((t, i) => {
        const name = source.tracks[i]?.name
        const { name: _copyName, ...rest } = t
        return name === undefined ? rest : { ...rest, name }
      })
      const copy: Comp = { ...source, id: ctx.ids('comp'), name: layer.name, tracks, embedded: true }
      copies.push(copy)
      made[layer.id] = copy.id
    }
    if (copies.length > 0) {
      ctx.write('Make unique', (draft) => {
        for (const copy of copies) draft.comps.push(copy as Draft<Comp>)
        for (const [layerId, compId] of Object.entries(made)) {
          const target = locateLayer(draft, layerId).layer
          if (target.kind === 'nested') target.sourceCompId = compId
        }
      })
    }
    return skipped.length > 0 ? { made, skipped } : { made }
  },
})
