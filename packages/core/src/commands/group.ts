import { z } from 'zod'
import type { Draft } from 'immer'
import { findComp, layerEnd, locateLayer, newTrack } from '../doc'
import { CommandError, parseOrThrow } from '../errors'
import { ancestorGroups, groupBlock, groupLaneIndex, groupMembers } from '../groups'
import { type Measure, type Placement, defineCommand } from '../registry'
import {
  type Comp,
  GROUP_MODES,
  type GroupLayer,
  IdSchema,
  type Layer,
  type Layout,
  LayerSchema,
  LayoutSchema,
  optionalFields,
  PaddingSchema,
  type Project,
  type Track,
} from '../schema'

const PaddingInputSchema = z.union([z.number().min(0), optionalFields(PaddingSchema)]).describe('One number for every side, or {top, right, bottom, left}')

/** A layout as callers write it: any subset of its fields; padding may be one number. */
export const LayoutInputSchema = optionalFields(LayoutSchema)
  .extend({ padding: PaddingInputSchema.optional() })
  .describe('flow row | column | wrap | grid, columns, gap, lineGap, spaceBetween, padding, alignX, alignY (start | center | end), width and height (null hugs), min and max sizes, x and y (the top-left corner), clipContent')

type LayoutInput = z.infer<typeof LayoutInputSchema>

function padding(input: LayoutInput['padding'], base: Layout['padding']): Layout['padding'] {
  if (input === undefined) return base
  if (typeof input === 'number') return { top: input, right: input, bottom: input, left: input }
  return { ...base, ...input }
}

/** A moment to measure a group at: the playhead while it shows, else its start. */
function measureTime(group: Pick<Layer, 'startMs' | 'durationMs'>, playheadMs: number | undefined): number {
  return playheadMs !== undefined && playheadMs >= group.startMs && playheadMs < layerEnd(group) ? playheadMs : group.startMs
}

function needMeasure(measure: Measure | undefined, why: string): Measure {
  if (!measure) throw new CommandError(`${why} needs the editor to measure the layers, and this session cannot.`, 'Run it in the editor.')
  return measure
}

const isIdentity = (layer: Layer) => {
  const t = layer.transform
  const keyed = Object.keys(layer.animations).length > 0
  return !keyed && t.x === 0 && t.y === 0 && t.z === 0 && t.rotation === 0 && t.rotationX === 0 && t.rotationY === 0 && t.scaleX === 1 && t.scaleY === 1 && t.opacity === 1
}

interface Unit {
  /** The layer the unit stands for (a group's unit also carries its lanes). */
  layer: Layer
  /** The lanes that move as one: a whole lane, or a group's lane and its block. Empty when the layer must leave a shared lane. */
  lanes: Track[]
  index: number
}

/** The axis-aligned box around several placements. */
function unionBounds(placements: Placement[]) {
  const left = Math.min(...placements.map((p) => p.bounds.left))
  const top = Math.min(...placements.map((p) => p.bounds.top))
  const right = Math.max(...placements.map((p) => p.bounds.left + p.bounds.width))
  const bottom = Math.max(...placements.map((p) => p.bounds.top + p.bounds.height))
  return { left, top, right, bottom }
}

export const layersGroup = defineCommand({
  name: 'layers.group',
  summary: 'Group layers of one comp, optionally as an auto layout that arranges them (rows, columns, wrap, grid).',
  details:
    'The members must be visual layers at the same level (all top-level, or all in the same group). The group moves, turns, scales and fades them as one: its transform is a change from where they are. layout makes it a container that places them by flow, gap, padding and alignment, and hugs them unless width or height is fixed; its box is placed by its top-left corner (layout.x, layout.y). layout: {} infers the flow and gap from how they sit. With a layout, a rectangle behind all the others becomes the container: its paints and corner radius move to the group and the padding is taken from it. Members keep their order: the front-most is first in the flow; with a layout they are first sorted by position along it.',
  effect: 'write',
  input: z.strictObject({
    ids: z.array(IdSchema).min(1),
    name: z.string().min(1).optional(),
    layout: LayoutInputSchema.optional(),
    mode: z
      .enum(GROUP_MODES)
      .optional()
      .describe('How the members combine: pass, union (one picture), mask (show the rest only inside the stencils), subtract (cut the stencils out), intersect, exclude. Stencils are members with isStencil, or the front-most member when none is marked.'),
  }),
  run: ({ ids, name, layout, mode }, ctx) => {
    const project = ctx.project
    const located = [...new Set(ids.map((ref) => locateLayer(project, ref).layer.id))].map((id) => locateLayer(project, id))
    const comp = located[0]?.comp as Comp
    for (const l of located) {
      if (l.comp.id !== comp.id) throw new CommandError('Group layers of one comp at a time.', `"${l.layer.name}" is in another comp.`)
      if (l.layer.kind === 'audio') throw new CommandError(`"${l.layer.name}" is audio; only visual layers can be grouped.`)
    }
    const parent = located[0]?.track.groupId ?? null
    const stray = located.find((l) => l.track.groupId !== parent)
    if (stray) {
      throw new CommandError(
        `"${stray.layer.name}" is at another level: group layers that are all top-level, or all in the same group.`,
        'Ungroup or move it first.',
      )
    }

    const time = measureTime(
      { startMs: Math.min(...located.map((l) => l.layer.startMs)), durationMs: Math.max(...located.map((l) => layerEnd(l.layer))) - Math.min(...located.map((l) => l.layer.startMs)) },
      ctx.view.playheadMs,
    )
    const wantsLayout = layout !== undefined
    const placements = wantsLayout && ctx.measure ? ctx.measure(comp, time) : undefined

    // Units: a whole lane when every layer on it is chosen, a group with its lanes, or a layer that must leave a shared lane.
    const chosen = new Set(located.map((l) => l.layer.id))
    const units: Unit[] = located.map((l) => {
      if (l.layer.kind === 'group') {
        const [start, end] = groupBlock(comp, l.layer.id)
        return { layer: l.layer, lanes: [l.track, ...comp.tracks.slice(start, end)], index: l.trackIndex }
      }
      const whole = l.track.layers.every((x) => chosen.has(x.id))
      return { layer: l.layer, lanes: whole ? [l.track] : [], index: l.trackIndex }
    })
    // Several chosen layers on one whole lane share that lane: keep one unit per lane.
    const seenLanes = new Set<string>()
    const unique = units.filter((u) => {
      const lane = u.lanes[0]
      if (!lane) return true
      if (seenLanes.has(lane.id)) return false
      seenLanes.add(lane.id)
      return true
    })

    // Order: lane order, or position along the flow for a layout.
    const flow = layout?.flow ?? (placements ? inferFlow(unique.map((u) => placements.get(u.layer.id)).filter((p) => p !== undefined)) : 'column')
    const position = (u: Unit) => {
      const p = placements?.get(u.layer.id)
      const x = p ? p.bounds.left : u.layer.transform.x
      const y = p ? p.bounds.top : u.layer.transform.y
      return flow === 'column' ? [y, x] : flow === 'row' ? [x, y] : [y, x]
    }
    unique.sort((a, b) => {
      if (!wantsLayout) return a.index - b.index
      const [a1, a2] = position(a) as [number, number]
      const [b1, b2] = position(b) as [number, number]
      return Math.abs(a1 - b1) > 1 ? a1 - b1 : a2 - b2
    })

    // A rectangle behind everything else becomes the container.
    let background: Extract<Layer, { kind: 'shape' }> | undefined
    if (wantsLayout && placements && unique.length > 1) {
      const back = [...unique].sort((a, b) => b.index - a.index)[0]
      const candidate = back?.layer
      const box = candidate ? placements.get(candidate.id) : undefined
      const others = unique.filter((u) => u !== back).map((u) => placements.get(u.layer.id))
      if (candidate?.kind === 'shape' && candidate.shape.type === 'rect' && box && others.every((p) => p !== undefined)) {
        const inner = unionBounds(others as Placement[])
        const b = box.bounds
        const contains = b.left <= inner.left + 0.5 && b.top <= inner.top + 0.5 && b.left + b.width >= inner.right - 0.5 && b.top + b.height >= inner.bottom - 0.5
        if (contains && Object.keys(candidate.animations).length === 0 && candidate.transform.rotation === 0) background = candidate
      }
    }
    const members = unique.filter((u) => u.layer.id !== background?.id)
    if (members.length === 0) throw new CommandError('Nothing is left to group once the background rectangle becomes the container.')

    // The layout, with what was not given inferred from how the members sit.
    let spec: Layout | null = null
    if (layout) {
      const memberPlacements = members.map((u) => placements?.get(u.layer.id)).filter((p): p is Placement => p !== undefined)
      const content = memberPlacements.length === members.length && memberPlacements.length > 0 ? unionBounds(memberPlacements) : null
      const box = background && placements?.get(background.id)?.bounds
      const inferredPadding =
        box && content
          ? {
              top: Math.max(0, content.top - box.top),
              right: Math.max(0, box.left + box.width - content.right),
              bottom: Math.max(0, box.top + box.height - content.bottom),
              left: Math.max(0, content.left - box.left),
            }
          : PaddingSchema.parse({})
      spec = parseOrThrow(
        LayoutSchema,
        {
          ...layout,
          flow,
          gap: layout.gap ?? (memberPlacements.length === members.length ? inferGap(flow, memberPlacements) : 16),
          padding: padding(layout.padding, inferredPadding),
          x: layout.x ?? (box ? box.left : (content?.left ?? 0)),
          y: layout.y ?? (box ? box.top : (content?.top ?? 0)),
        },
        'The layout',
      )
    }

    const start = Math.min(...members.map((u) => u.layer.startMs))
    const end = Math.max(...members.map((u) => layerEnd(u.layer)))
    const group = parseOrThrow(
      LayerSchema,
      {
        id: ctx.ids('layer'),
        name: name ?? 'Group',
        kind: 'group',
        startMs: start,
        durationMs: Math.max(1, end - start),
        layout: spec,
        ...(mode ? { mode } : {}),
        ...(background ? { fills: background.fills, strokes: background.strokes, cornerRadius: background.shape.cornerRadius } : {}),
      },
      'The group',
    ) as GroupLayer

    const laneIds = members.map(() => ctx.ids('track'))
    const groupLaneId = ctx.ids('track')
    ctx.write('Group', (draft) => {
      const target = findComp(draft, comp.id)
      const lanes = target.tracks
      const insertAt = Math.min(...unique.map((u) => u.index))
      const moving = new Set(unique.flatMap((u) => u.lanes.map((l) => l.id)))
      const taken = new Set(unique.filter((u) => u.lanes.length === 0).map((u) => u.layer.id))
      if (background) taken.add(background.id)
      // Lanes before the insertion point that are leaving shift it.
      const before = lanes.slice(0, insertAt).filter((t) => moving.has(t.id)).length
      const pulled = new Map<string, Draft<Track>>()
      for (const track of lanes) if (moving.has(track.id)) pulled.set(track.id, track)
      const singles = new Map<string, Draft<Layer>>()
      for (const track of lanes) {
        for (const layer of track.layers) if (taken.has(layer.id)) singles.set(layer.id, layer)
        track.layers = track.layers.filter((l) => !taken.has(l.id))
      }
      const kept = lanes.filter((t) => !moving.has(t.id))
      const block: Draft<Track>[] = [newTrack(groupLaneId, [group], group.name, parent) as Draft<Track>]
      members.forEach((u, i) => {
        if (u.lanes.length > 0) {
          const [top, ...rest] = u.lanes.map((l) => pulled.get(l.id) as Draft<Track>)
          if (top) {
            top.groupId = group.id
            block.push(top, ...rest)
          }
        } else {
          const layer = singles.get(u.layer.id)
          if (layer) block.push(newTrack(laneIds[i] as string, [layer as Layer], undefined, group.id) as Draft<Track>)
        }
      })
      kept.splice(Math.max(0, Math.min(insertAt - before, kept.length)), 0, ...block)
      target.tracks = kept
    })
    return {
      groupId: group.id,
      members: located.map((l) => l.layer.id).filter((id) => id !== background?.id),
      ...(spec ? { layout: { flow: spec.flow, gap: spec.gap, x: spec.x, y: spec.y } } : {}),
      ...(background ? { background: `"${background.name}" became the container and was removed` } : {}),
    }
  },
})

/** A first layout for a group that has none: placed and spaced the way its members sit, when they can be measured. */
function inferredLayout(comp: Comp, group: GroupLayer, measure: Measure | undefined, playheadMs: number | undefined, flow?: Layout['flow']): Layout {
  const placements = measure?.(comp, measureTime(group, playheadMs))
  const members = groupMembers(comp, group.id)
    .map((m) => placements?.get(m.id))
    .filter((p): p is Placement => p !== undefined)
  if (members.length === 0) return LayoutSchema.parse({ flow: flow ?? 'column' })
  const box = unionBounds(members)
  const chosen = flow ?? inferFlow(members)
  return LayoutSchema.parse({ flow: chosen, gap: inferGap(chosen, members), x: box.left, y: box.top })
}

/** Row when the members spread wider than tall, else column. */
function inferFlow(placements: Placement[]): Layout['flow'] {
  if (placements.length < 2) return 'column'
  const b = unionBounds(placements)
  const centres = placements.map((p) => [p.bounds.left + p.bounds.width / 2, p.bounds.top + p.bounds.height / 2] as const)
  const spreadX = Math.max(...centres.map((c) => c[0])) - Math.min(...centres.map((c) => c[0]))
  const spreadY = Math.max(...centres.map((c) => c[1])) - Math.min(...centres.map((c) => c[1]))
  return spreadX > spreadY && b.right - b.left > 0 ? 'row' : 'column'
}

/** The average space between neighbours along the flow, never below 0. */
function inferGap(flow: Layout['flow'], placements: Placement[]): number {
  if (placements.length < 2 || flow === 'grid') return 16
  const horizontal = flow !== 'column'
  const sorted = [...placements].sort((a, b) => (horizontal ? a.bounds.left - b.bounds.left : a.bounds.top - b.bounds.top))
  let total = 0
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1] as Placement
    const next = sorted[i] as Placement
    total += horizontal ? next.bounds.left - (prev.bounds.left + prev.bounds.width) : next.bounds.top - (prev.bounds.top + prev.bounds.height)
  }
  return Math.max(0, Math.round(total / (sorted.length - 1)))
}

/**
 * Writes where a group's direct members really are into their own values, so
 * they stay put when the group's layout (and, when `withTransform`, the group
 * itself) stops placing them. Returns the members whose keyed values could
 * not be baked.
 */
function bakeMembers(draftComp: Draft<Comp>, comp: Comp, group: GroupLayer, placements: ReadonlyMap<string, Placement>, withTransform: boolean): string[] {
  const unbaked: string[] = []
  for (const member of groupMembers(comp, group.id)) {
    const placed = placements.get(member.id)
    const target = draftComp.tracks.flatMap((t) => t.layers).find((l) => l.id === member.id)
    if (!placed || !target) continue
    const keyed = Object.keys(member.animations).some((p) => p.startsWith('transform.'))
    if (keyed) unbaked.push(member.name)
    target.transform.x = placed.x
    target.transform.y = placed.y
    if (withTransform) {
      target.transform.rotation = placed.rotation
      target.transform.scaleX = placed.scaleX
      target.transform.scaleY = placed.scaleY
      target.transform.opacity = Math.min(1, Math.max(0, placed.opacity))
    }
    if (placed.width !== undefined && target.kind === 'shape') target.shape.width = Math.max(1, placed.width)
    if (placed.height !== undefined && target.kind === 'shape') target.shape.height = Math.max(1, placed.height)
    if (placed.width !== undefined && target.kind === 'text') target.maxWidth = Math.max(1, placed.width)
    if (target.kind === 'group' && target.layout && placed.width !== undefined) target.layout.width = placed.width
    if (target.kind === 'group' && target.layout && placed.height !== undefined) target.layout.height = placed.height
  }
  return unbaked
}

/** A rectangle that keeps a container's look (its paints and corners) where the container was. */
function containerRect(group: GroupLayer, placed: Placement | undefined, ids: (prefix: string) => string): Layer | null {
  if (!placed || !(group.fills.some((f) => f.enabled) || group.strokes.some((s) => s.enabled))) return null
  const b = placed.bounds
  return parseOrThrow(
    LayerSchema,
    {
      id: ids('layer'),
      name: `${group.name} background`,
      kind: 'shape',
      startMs: group.startMs,
      durationMs: group.durationMs,
      transform: { x: b.left + b.width / 2, y: b.top + b.height / 2 },
      shape: { type: 'rect', width: Math.max(1, b.width), height: Math.max(1, b.height), cornerRadius: group.cornerRadius },
      fills: group.fills,
      strokes: group.strokes,
    },
    'The container rectangle',
  )
}

/** Refuses to bake when a group around this one moves its contents, which baking would apply twice. */
function assertNoMovingAncestor(comp: Comp, group: GroupLayer): void {
  const moving = ancestorGroups(comp, group.id).find((g) => !isIdentity(g))
  if (moving) throw new CommandError(`"${group.name}" is inside "${moving.name}", which moves or fades what it holds.`, `Ungroup "${moving.name}" first.`)
}

export const layersUngroup = defineCommand({
  name: 'layers.ungroup',
  summary: 'Dissolve groups, keeping their members where they are on screen.',
  details:
    "ids are groups, or members (their innermost group is dissolved). A layout's positions and the group's own move, turn, scale and fade are written into the members; a container's paints become a rectangle behind them. Keys on the group are dropped.",
  effect: 'write',
  input: z.strictObject({ ids: z.union([IdSchema, z.array(IdSchema).min(1)]) }),
  run: ({ ids }, ctx) => {
    const refs = typeof ids === 'string' ? [ids] : ids
    const groups: { comp: Comp; group: GroupLayer }[] = []
    for (const ref of refs) {
      const { comp, layer, track } = locateLayer(ctx.project, ref)
      const group = layer.kind === 'group' ? layer : track.groupId ? (ancestorGroups(comp, layer.id)[0] ?? null) : null
      if (!group) throw new CommandError(`"${layer.name}" is not a group or in one.`)
      if (!groups.some((g) => g.group.id === group.id)) groups.push({ comp, group })
    }
    const dropped: string[] = []
    const unbaked: string[] = []
    for (const { group } of groups) {
      const comp = locateLayer(ctx.project, group.id).comp
      const current = locateLayer(ctx.project, group.id).layer as GroupLayer
      const bake = current.layout !== null || !isIdentity(current)
      const placements = bake ? needMeasure(ctx.measure, `Ungrouping "${current.name}"`)(comp, measureTime(current, ctx.view.playheadMs)) : undefined
      if (bake) assertNoMovingAncestor(comp, current)
      const rect = current.layout ? containerRect(current, placements?.get(current.id), ctx.ids) : null
      const rectLane = ctx.ids('track')
      dropped.push(...Object.keys(current.animations).map((p) => `${current.name}: ${p}`))
      ctx.write('Ungroup', (draft) => {
        const target = findComp(draft, comp.id)
        if (placements) unbaked.push(...bakeMembers(target, comp, current, placements, !isIdentity(current)))
        const lane = groupLaneIndex(target as Comp, current.id)
        const parent = target.tracks[lane]?.groupId ?? null
        const [, end] = groupBlock(target as Comp, current.id)
        if (rect) target.tracks.splice(end, 0, newTrack(rectLane, [rect], undefined, parent) as Draft<Track>)
        for (const track of target.tracks) if (track.groupId === current.id) track.groupId = parent
        target.tracks.splice(lane, 1)
      })
    }
    return {
      ungrouped: groups.map((g) => g.group.id),
      ...(dropped.length > 0 ? { droppedKeys: dropped } : {}),
      ...(unbaked.length > 0 ? { note: `Animated members keep their own keys, so they may jump: ${unbaked.join(', ')}` } : {}),
    }
  },
})

export const layoutSet = defineCommand({
  name: 'layout.set',
  summary: "Turn a group's auto layout on, change it, or turn it off (members stay where they are).",
  details:
    'layout merges into the current layout (flow, gap, padding, alignX, alignY, width and height with null hugging, x and y the top-left corner). layout: null removes it: the members keep their positions, and a container look becomes a rectangle. A member\'s own sizing is its layoutItem (layer.patch): fillX, fillY, absolute, min and max.',
  effect: 'write',
  input: z.strictObject({ id: IdSchema, layout: LayoutInputSchema.nullable() }),
  run: ({ id, layout }, ctx) => {
    const { comp, layer } = locateLayer(ctx.project, id)
    if (layer.kind !== 'group') throw new CommandError(`"${layer.name}" is not a group.`, 'layers.group makes one (with layout for an auto layout).')
    if (layout === null) {
      if (!layer.layout) return { id: layer.id, layout: null }
      assertNoMovingAncestor(comp, layer)
      const placements = needMeasure(ctx.measure, 'Turning a layout off')(comp, measureTime(layer, ctx.view.playheadMs))
      const rect = containerRect(layer, placements.get(layer.id), ctx.ids)
      const rectLane = ctx.ids('track')
      let unbaked: string[] = []
      ctx.write('Remove layout', (draft) => {
        const target = findComp(draft, comp.id)
        unbaked = bakeMembers(target, comp, layer, placements, false)
        const group = target.tracks.flatMap((t) => t.layers).find((l) => l.id === layer.id)
        if (group?.kind === 'group') {
          group.layout = null
          group.fills = []
          group.strokes = []
        }
        const [, end] = groupBlock(target as Comp, layer.id)
        if (rect) target.tracks.splice(end, 0, newTrack(rectLane, [rect], undefined, layer.id) as Draft<Track>)
      })
      return { id: layer.id, layout: null, ...(unbaked.length > 0 ? { note: `Animated members keep their own keys: ${unbaked.join(', ')}` } : {}) }
    }
    const base = layer.layout ?? inferredLayout(comp, layer, ctx.measure, ctx.view.playheadMs, layout.flow)
    const next = parseOrThrow(LayoutSchema, { ...base, ...layout, padding: padding(layout.padding, base.padding) }, 'The layout')
    ctx.write('Change layout', (draft) => {
      const group = locateLayer(draft as Project, layer.id).layer
      if (group.kind === 'group') group.layout = next
    })
    return { id: layer.id, layout: next }
  },
})
