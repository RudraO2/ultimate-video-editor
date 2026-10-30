import { z } from 'zod'
import { findAnimationPreset } from '../animationPresets'
import { CommandError } from '../errors'
import { findComp } from '../doc'
import { defineCommand } from '../registry'
import { ColorSchema, IdSchema, LayerOriginSchema } from '../schema'
import { formatSvgPath, type PathCommand, parseSvgPath, svgPathBounds } from '../svgPath'
import { parseSvg, type SvgPaint, type SvgShape } from '../svgImport'

// Places SVG markup as vector layers: one path layer for each run of outlines
// painted alike, grouped when there are several. Icons come through here.

/** One layer's worth of outlines: neighbours painted the same way, joined into one path. */
interface Run {
  shape: SvgShape
  ds: string[]
}

const paintKey = (shape: SvgShape) => JSON.stringify([shape.fill, shape.stroke, shape.fillRule, shape.opacity])

function runsOf(shapes: readonly SvgShape[], merge: boolean): Run[] {
  const runs: Run[] = []
  for (const shape of shapes) {
    const last = runs[runs.length - 1]
    if (merge && last && paintKey(last.shape) === paintKey(shape)) last.ds.push(shape.d)
    else runs.push({ shape, ds: [shape.d] })
  }
  return runs
}

/** A readable name from an SVG id: emoji and punctuation go, words are spaced ("🖍-Ink" is "Ink"). A group's "category/Name" is its category, a layer's is its last part. */
function readable(id: string | undefined, part: 'category' | 'last'): string {
  if (!id) return ''
  const parts = id.split('/').filter((p) => p.trim() !== '')
  const picked = (part === 'category' ? parts[0] : parts[parts.length - 1]) ?? ''
  return picked
    .replace(/[\p{Extended_Pictographic}‍️]/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

type Leaf = { shape: SvgShape }

/** A named group of the SVG with what it draws, in drawing order. */
interface SvgNode {
  /** The group's raw name; empty for the root. */
  label: string
  items: (SvgNode | Leaf)[]
}

const isNode = (item: SvgNode | Leaf): item is SvgNode => 'items' in item

/** The named groups of an SVG as a tree with its shapes as leaves. A wrapper holding only one group is skipped (Sketch's page, artboard and layer wrappers). */
function treeOf(shapes: readonly SvgShape[]): SvgNode {
  const root: SvgNode = { label: '', items: [] }
  const byKey = new Map<number, SvgNode>()
  for (const shape of shapes) {
    let at = root
    shape.groups.forEach((label, depth) => {
      const key = shape.groupKeys[depth] as number
      let node = byKey.get(key)
      if (!node) {
        node = { label, items: [] }
        byKey.set(key, node)
        at.items.push(node)
      }
      at = node
    })
    at.items.push({ shape })
  }
  const unwrap = (node: SvgNode): SvgNode => {
    const only = node.items[0]
    return node.items.length === 1 && only && isNode(only) ? unwrap(only) : node
  }
  const clean = (node: SvgNode): SvgNode => {
    node.items = node.items.map((item) => (isNode(item) ? clean(unwrap(item)) : item))
    return node
  }
  return clean(unwrap(root))
}

/** One layer made by svg.place, with the layers inside a group. */
interface TreeEntry {
  id: string
  name: string
  kind: 'group' | 'path'
  children?: TreeEntry[]
}

/** Moves path commands to the layer's own space: relative to the picture's centre and scaled to its size. */
function toSpace(commands: readonly PathCommand[], cx: number, cy: number, s: number): PathCommand[] {
  const point = (x: number, y: number): [number, number] => [(x - cx) * s, (y - cy) * s]
  return commands.map((cmd): PathCommand => {
    if (cmd.c === 'Z') return cmd
    if (cmd.c === 'C') return { c: 'C', p: [...point(cmd.p[0], cmd.p[1]), ...point(cmd.p[2], cmd.p[3]), ...point(cmd.p[4], cmd.p[5])] }
    if (cmd.c === 'Q') return { c: 'Q', p: [...point(cmd.p[0], cmd.p[1]), ...point(cmd.p[2], cmd.p[3])] }
    return { c: cmd.c, p: point(cmd.p[0], cmd.p[1]) }
  })
}

/** A paint as layer.create takes it; gradient ends become fractions of the layer's box. */
function paintInput(paint: SvgPaint, box: { left: number; top: number; width: number; height: number }, cx: number, cy: number, s: number): unknown {
  if (paint.type === 'solid') return paint.opacity < 0.999 ? { type: 'solid', color: paint.color, opacity: paint.opacity } : paint.color
  const fraction = (p: [number, number]) => ({ x: ((p[0] - cx) * s - box.left) / (box.width || 1), y: ((p[1] - cy) * s - box.top) / (box.height || 1) })
  return { type: paint.type, stops: paint.stops, start: fraction(paint.start), end: fraction(paint.end), ...(paint.opacity < 0.999 ? { opacity: paint.opacity } : {}) }
}

export const svgPlace = defineCommand({
  name: 'svg.place',
  summary: 'Place SVG markup as vector layers: paths, rectangles, circles, lines and polygons become path layers, with their fills, strokes and gradients.',
  details:
    'Pass the SVG text (a whole <svg> with its viewBox, or just its elements). The picture is scaled so its longer side is size px and centred on x, y (comp space). Outlines painted alike next to each other join into one layer; several layers are grouped under name. currentColor takes color. strokeWidth replaces the picture\'s line width (in the picture\'s own units, such as 2 on a 24 grid). animIn and animOut are animation presets (catalog.list animations): "draw" draws the lines on, whether the picture has strokes or only fills. Not drawn: masks, clip paths, filters, text and images; the result lists what was left out. groups: true builds a group for each named <g> of the SVG (a wrapper holding only one group is skipped), with layers named after their ids ("Ink", "Background"); a group with nothing to draw is not made; tree in the result lists what was made. One undo step.',
  effect: 'write',
  input: z.strictObject({
    svg: z.string().min(1).describe('SVG markup, or just its elements'),
    name: z.string().min(1).optional().describe('The layer, or the group of layers, is named this; default "SVG"'),
    x: z.number().default(0).describe("Where the picture's centre goes, comp x"),
    y: z.number().default(0).describe("Where the picture's centre goes, comp y"),
    size: z.number().positive().max(16384).default(128).describe('The longer side of the picture, in px'),
    color: ColorSchema.optional().describe('What currentColor stands for (default white-ish #F4F2ED)'),
    strokeWidth: z.number().min(0).optional().describe("Replaces the picture's line width, in the picture's own units"),
    merge: z.boolean().default(true).describe('Join neighbouring outlines painted alike into one layer'),
    groups: z
      .boolean()
      .default(false)
      .describe('Keep the SVG\'s named <g> groups as nested groups of layers (a character\'s body, head, face and accessories apart), named by their category: "head/Bangs" is "head". Outlines join only inside one group'),
    compId: IdSchema.optional().describe('Default the comp open in the editor'),
    startMs: z.number().min(0).optional().describe('Comp time; default the playhead'),
    durationMs: z.number().positive().optional().describe('Default the rest of the comp'),
    animIn: z.string().min(1).nullable().optional().describe('An entrance preset, such as "draw", "fade-up", "pop-in"'),
    animOut: z.string().min(1).nullable().optional().describe('An exit preset'),
    origin: LayerOriginSchema.nullable().optional().describe('Where the picture came from, for credit: {kind: "icon", id, license, author}'),
  }),
  run: async (input, ctx) => {
    const color = input.color ?? '#F4F2ED'
    const parsed = parseSvg(input.svg, { color })
    if (parsed.shapes.length === 0) {
      throw new CommandError(
        'Nothing in that SVG can be drawn' + (parsed.skipped.length > 0 ? ' (left out: ' + parsed.skipped.join(', ') + ')' : '') + '.',
        'Paths, rectangles, circles, ellipses, lines, polylines and polygons with a fill or a stroke are drawn.',
      )
    }
    for (const slot of [input.animIn, input.animOut]) {
      if (slot && !findAnimationPreset(slot)) throw new CommandError('No animation preset "' + slot + '".', 'catalog.list {"catalog": "animations"} lists them.')
    }
    const comp = findComp(ctx.project, input.compId ?? ctx.view.compId)
    const startMs = Math.round(input.startMs ?? ctx.view.playheadMs ?? 0)
    const vb = parsed.viewBox
    const s = input.size / Math.max(vb.width, vb.height)
    const cx = vb.x + vb.width / 2
    const cy = vb.y + vb.height / 2
    const name = input.name ?? 'SVG'

    const makeLayer = async (run: Run, layerName: string): Promise<TreeEntry> => {
      // The path relative to the picture's centre, scaled; the layer is centred on its own box.
      const local = toSpace(run.ds.flatMap((d) => parseSvgPath(d)), cx, cy, s)
      const box = svgPathBounds(local)
      const { shape } = run
      const fills = shape.fill ? [paintInput(shape.fill, box, cx, cy, s)] : []
      const strokes = shape.stroke
        ? [
            {
              paint: paintInput(shape.stroke.paint, box, cx, cy, s),
              width: (input.strokeWidth ?? shape.stroke.width) * s,
              cap: shape.stroke.cap,
              join: shape.stroke.join,
              ...(shape.stroke.dash.length > 0 ? { dash: shape.stroke.dash.map((n) => n * s), dashOffset: shape.stroke.dashOffset * s } : {}),
            },
          ]
        : []
      const created = await ctx.call('layer.create', {
        kind: 'path',
        compId: comp.id,
        name: layerName,
        d: formatSvgPath(local),
        fillRule: shape.fillRule,
        fills,
        strokes,
        x: input.x + box.left + box.width / 2,
        y: input.y + box.top + box.height / 2,
        startMs,
        ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
        ...(shape.opacity < 0.999 ? { transform: { opacity: shape.opacity } } : {}),
        ...(input.origin ? { origin: input.origin } : {}),
      })
      if (!created.ok) throw new CommandError(created.error, created.hint)
      return { id: (created.value as { id: string }).id, name: layerName, kind: 'path' }
    }
    const makeGroup = async (members: readonly TreeEntry[], groupName: string): Promise<TreeEntry> => {
      const grouped = await ctx.call('layers.group', { ids: members.map((m) => m.id), name: groupName })
      if (!grouped.ok) throw new CommandError(grouped.error, grouped.hint)
      return { id: (grouped.value as { groupId: string }).groupId, name: groupName, kind: 'group', children: [...members] }
    }

    const ids: string[] = []
    let tree: TreeEntry[] = []
    if (!input.groups) {
      const runs = runsOf(parsed.shapes, input.merge)
      for (const [index, run] of runs.entries()) tree.push(await makeLayer(run, runs.length === 1 ? name : name + ' ' + (index + 1)))
      ids.push(...tree.map((t) => t.id))
      if (tree.length > 1) tree = [await makeGroup(tree, name)]
    } else {
      // Items come in drawing order, so each new layer lands in front of the last; a group is made once its members exist.
      const build = async (node: SvgNode, groupName: string, isRoot: boolean): Promise<TreeEntry[]> => {
        const out: TreeEntry[] = []
        const used = new Map<string, number>()
        let leaves = 0
        for (let i = 0; i < node.items.length; ) {
          const item = node.items[i] as SvgNode | Leaf
          if (isNode(item)) {
            const label = readable(item.label, 'category') || groupName + ' part'
            out.push(await makeGroup(await build(item, label, false), label))
            i++
            continue
          }
          // Consecutive outlines of this group: runs join across them, never across a child group.
          const chunk: SvgShape[] = []
          for (let next = node.items[i]; next && !isNode(next); next = node.items[i]) {
            chunk.push(next.shape)
            i++
          }
          const runs = runsOf(chunk, input.merge)
          const sole = isRoot && out.length === 0 && i === node.items.length && runs.length === 1
          for (const run of runs) {
            leaves++
            let layerName = sole ? groupName : readable(run.shape.id, 'last') || groupName + ' ' + leaves
            const seen = (used.get(layerName) ?? 0) + 1
            used.set(layerName, seen)
            if (seen > 1) layerName += ' ' + seen
            out.push(await makeLayer(run, layerName))
          }
        }
        return out
      }
      tree = await build(treeOf(parsed.shapes), name, true)
      const collect = (entries: readonly TreeEntry[]) => {
        for (const e of entries) {
          if (e.kind === 'path') ids.push(e.id)
          else collect(e.children ?? [])
        }
      }
      collect(tree)
      if (tree.length > 1) tree = [await makeGroup(tree, name)]
    }
    const top = tree[0]
    const groupId = top?.kind === 'group' ? top.id : null
    // A draw-on plays on the path layers themselves; any other preset plays on the picture as one piece.
    for (const [slot, preset] of [['in', input.animIn], ['out', input.animOut]] as const) {
      if (!preset) continue
      const targets = findAnimationPreset(preset)?.drawOn ? ids : [groupId ?? (ids[0] as string)]
      for (const id of targets) {
        const animated = await ctx.call('animation.set', { id, slot, preset, target: 'layer' })
        if (!animated.ok) throw new CommandError(animated.error, animated.hint)
      }
    }
    return {
      ids,
      groupId,
      layers: ids.length,
      tree,
      size: input.size,
      viewBox: [vb.x, vb.y, vb.width, vb.height],
      ...(parsed.skipped.length > 0 ? { skipped: parsed.skipped } : {}),
    }
  },
})
