import {
  type Bone,
  type Comp,
  compTimeFor,
  type GroupLayer,
  groupMembers,
  isWorld,
  type Layer,
  type Layout,
  type MediaAsset,
  type NestedLayer,
  nestedTime,
  parseColor,
  type Placement,
  solveLayout,
  type Track,
  type TransitionSide,
  transitionSides,
  type TransitionWipe,
} from '@uve/core'
import { type BehaviourResult, evaluateBehaviours } from './character'
import { type Content, type Ctx2D, containerContent, type FrameProvider, layerContent } from './content'
import { isActiveAt, layerMatrix, pivotOffset, type ResolvedLayer, resolveLayer } from './evaluate'
import { compose, degToRad, type Mat4, multiply, rotateX, rotateY, rotateZ, scale, transformPoint, translate } from './math'
import { MAX_NESTING, nestedKey } from './nested'
import { type Simulation, simulationFor } from './physics/simulate'
import { affineToMat4, autoBone, type BonePose, solveRig } from './rig'

// A comp at one moment as a tree: groups hold their members, every node
// knows the matrix that takes it to comp space, and layouts have placed
// their members. Rendering, outlines, picking and measuring all read it, so
// they agree on where everything is.

/** An axis-aligned box in comp space (origin at the comp centre). */
export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

interface NodeBase {
  /** Maps the node's own space to comp space, every group above it included. */
  matrix: Mat4
  /** The matrix of everything above the node (its groups and their layouts), without its own transform. */
  above: Mat4
  /** The lane it is on, and whether that lane or one of its groups' lanes is locked. */
  track: Track
  locked: boolean
  /** A size a layout stretched it to, in its own unscaled pixels. */
  stretched?: { width?: number; height?: number }
  /** A cutter in a group that masks or cuts: it shapes the others and is not drawn (nor picked) itself. */
  stencil?: boolean
  /** A side of a transition being played: drawn together with its partner when a wipe, veil or tear joins them. */
  transition?: NodeTransition
}

export interface NodeTransition {
  id: string
  role: 'a' | 'b'
  wipe: TransitionWipe | null
  veil: number
  color: string
  tear?: { amount: number; seed: number }
}

export interface LeafNode extends NodeBase {
  kind: 'leaf'
  layer: Layer
  resolved: ResolvedLayer
  content: Content
}

export interface GroupNode extends NodeBase {
  kind: 'group'
  layer: GroupLayer
  resolved: ResolvedLayer
  /** The group's box before its own transform, comp space: the layout's box, or the members' bounds. */
  box: Rect
  /** The container (a layout with paints), drawn behind the members in the group's space. */
  container: Content | null
  clip: boolean
  /** How the members combine (see the group schema); for cutting modes, `stencil` marks the cutters. */
  mode: GroupLayer['mode']
  /** Members, back to front. */
  children: SceneNode[]
}

/**
 * A nested comp: its inside, built at the nested layer's own clock and
 * placed through the layer's transform, drawn as one piece. It is a unit:
 * picking, outlines and placements stop at it.
 */
export interface NestedNode extends NodeBase {
  kind: 'nested'
  layer: NestedLayer
  resolved: ResolvedLayer
  /** The source comp's box, centred on the layer's own origin. */
  box: Rect
  /** The source comp's background, when it can be seen. */
  container: Content | null
  clip: boolean
  /** The inside, back to front, placed in comp space. */
  children: SceneNode[]
}

export type SceneNode = LeafNode | GroupNode | NestedNode

const IDENTITY: Mat4 = translate(0, 0, 0)

/**
 * Draws a 3D world (a comp with `world`) into a picture: how a nested layer
 * whose source is a world shows it. The context's origin is the picture's
 * centre in layer px; the painter reads its resolution from the transform.
 */
export interface WorldPainter {
  paint(ctx: Ctx2D, world: Comp, source: SceneSource, timeMs: number, width: number, height: number): void
}

/** What building a scene needs: something to measure text with, and media frames for pictures. */
export interface SceneSource {
  measure: Ctx2D
  media: readonly MediaAsset[]
  /** The project's comps, for nested layers to show; without them nested layers show nothing. */
  comps?: readonly Comp[]
  frames?: FrameProvider
  /** Draws nested worlds; without it a nested layer whose source is a world shows nothing. */
  worlds?: WorldPainter
  /** Build without physics: how the simulation sees the comp at a body's entry. */
  noPhysics?: boolean
}

/** A comp's background as a picture, or null when it is fully transparent. */
function backgroundContent(width: number, height: number, color: string): Content | null {
  const alpha = parseColor(color)?.[3] ?? 255
  if (alpha <= 0) return null
  return {
    box: { width, height },
    draw(ctx) {
      ctx.fillStyle = color
      ctx.fillRect(-width / 2, -height / 2, width, height)
    },
  }
}

/** The frames of media inside a nested layer, asked for under their keys in the comp being played (see nested.ts). */
function nestedFrames(frames: FrameProvider, nestedId: string, pass: number): FrameProvider {
  return { frame: (media, sourceTimeMs, layerId) => frames.frame(media, sourceTimeMs, nestedKey(nestedId, layerId, pass)) }
}

/** The four corners of a box centred on the origin. */
const centredCorners = (w: number, h: number) =>
  [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ] as const

/** The axis-aligned comp-space bounds of points mapped by a matrix (depth is ignored). */
function boundsOf(matrix: Mat4, corners: readonly (readonly [number, number])[]): Rect {
  const points = corners.map(([x, y]) => transformPoint(matrix, x, y, 0))
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  const left = Math.min(...xs)
  const top = Math.min(...ys)
  return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top }
}

/** A node's comp-space bounds. */
export function nodeBounds(node: SceneNode): Rect {
  if (node.kind === 'leaf') return boundsOf(node.matrix, centredCorners(node.content.box.width, node.content.box.height))
  const { left, top, width, height } = node.box
  return boundsOf(node.matrix, [
    [left, top],
    [left + width, top],
    [left + width, top + height],
    [left, top + height],
  ])
}

/** Marks a node, and everything in it, as a cutter. */
function markStencil(node: SceneNode): void {
  node.stencil = true
  if (node.kind === 'group') for (const child of node.children) markStencil(child)
}

/** Moves a node, and everything in it, by a matrix applied on the comp side. */
function prefix(node: SceneNode, m: Mat4): void {
  node.matrix = multiply(m, node.matrix)
  node.above = multiply(m, node.above)
  if (node.kind !== 'leaf') for (const child of node.children) prefix(child, m)
}

function unionRect(rects: Rect[]): Rect {
  if (rects.length === 0) return { left: 0, top: 0, width: 0, height: 0 }
  const left = Math.min(...rects.map((r) => r.left))
  const top = Math.min(...rects.map((r) => r.top))
  const right = Math.max(...rects.map((r) => r.left + r.width))
  const bottom = Math.max(...rects.map((r) => r.top + r.height))
  return { left, top, width: right - left, height: bottom - top }
}

/** Sizes a layout imposes on a member before it is built. */
interface Stretch {
  width?: number
  height?: number
}

class SceneBuilder {
  /** The comp's physics: from its start, a top-level body's x, y and rotation come from it. */
  private readonly physics: Simulation | null
  /** Behaviours (blink, talk) that decide which member of a switch shows, set before the switch is built. Shared with the builders of transition sides. */
  private switchOverrides = new Map<string, number>()

  constructor(
    private readonly comp: Comp,
    private readonly source: SceneSource,
    private readonly timeMs: number,
    /** The comps being built, outermost first, so a comp never shows itself. */
    private readonly stack: readonly string[] = [comp.id],
    physics?: Simulation | null,
  ) {
    this.physics =
      physics !== undefined
        ? physics
        : source.noPhysics
          ? null
          : physicsOf(comp, source, stack)
  }

  /** Puts a top-level body where the simulation has it now. A group's x, y are offset from its box pivot by `pivot`. */
  private simulated(layer: Layer, track: Track, resolved: ResolvedLayer, pivot: readonly [number, number] = [0, 0]): void {
    if (!this.physics || track.groupId !== null) return
    const pose = this.physics.poseAt(layer.id, this.timeMs)
    if (!pose) return
    resolved.transform.x = pose.x - pivot[0]
    resolved.transform.y = pose.y - pivot[1]
    resolved.transform.rotation = pose.rotation
  }

  /** The members of a level (`groupId` null for the top level), back to front. */
  level(groupId: string | null, lockedAbove: boolean): SceneNode[] {
    const lanes = this.comp.tracks.filter((t) => t.groupId === groupId)
    const nodes: SceneNode[] = []
    for (let i = lanes.length - 1; i >= 0; i--) {
      const track = lanes[i] as Track
      if (track.hidden) continue
      // Inside a transition's window a layer shows past its own span too (held at its first or last moment), posed by the transition.
      const sides = track.transitions.length > 0 ? transitionSides(track, this.timeMs) : null
      for (const layer of track.layers) {
        const side = sides?.get(layer.id)
        if (layer.kind === 'audio' || !layer.enabled || (!side && !isActiveAt(layer, this.timeMs))) continue
        const builder = side && side.drawAtMs !== this.timeMs ? new SceneBuilder(this.comp, this.source, side.drawAtMs, this.stack, this.physics) : this
        builder.switchOverrides = this.switchOverrides
        const node = builder.node(layer, track, lockedAbove || track.locked)
        if (!node) continue
        if (side) pose(node, side, this.comp)
        nodes.push(node)
      }
    }
    return nodes
  }

  node(layer: Layer, track: Track, locked: boolean, stretch?: Stretch): SceneNode | null {
    if (layer.kind === 'group') return this.group(layer, track, locked, stretch)
    if (layer.kind === 'nested') return this.nested(layer, track, locked)
    return this.leaf(layer, track, locked, stretch)
  }

  nested(layer: NestedLayer, track: Track, locked: boolean): NestedNode | LeafNode | null {
    const source = this.source.comps?.find((c) => c.id === layer.sourceCompId)
    if (!source || this.stack.includes(source.id) || this.stack.length > MAX_NESTING) return null
    const at = nestedTime(layer, source.durationMs, this.timeMs)
    if (!at) return null
    if (isWorld(source)) return this.nestedWorld(layer, source, at, track, locked)
    // A static frame holds its still wherever it is shown.
    const insideMs = compTimeFor(source, at.timeMs)
    const resolved = resolveLayer(layer, this.timeMs)
    this.simulated(layer, track, resolved)
    const box = { width: source.width, height: source.height }
    const matrix = layerMatrix(resolved.transform, box)
    const frames = this.source.frames && nestedFrames(this.source.frames, layer.id, at.cycle)
    const inside = new SceneBuilder(source, { ...this.source, frames }, insideMs, [...this.stack, source.id])
    const children = inside.level(null, locked)
    for (const child of children) prefix(child, matrix)
    const container = backgroundContent(source.width, source.height, source.background)
    return {
      kind: 'nested',
      layer,
      resolved,
      box: { left: -box.width / 2, top: -box.height / 2, width: box.width, height: box.height },
      container,
      // Auto: the frame's own overflow (0 crops, 1 never crops), else a comp with a visible background is a scene and crops, and a transparent one is a part and spills.
      clip: layer.clipContent ?? (source.overflow === null ? container !== null : source.overflow < 0.5),
      children,
      matrix,
      above: IDENTITY,
      track,
      locked,
    }
  }

  /**
   * A nested layer whose source is a world: one picture (the world as its
   * camera sees it, at the resolution it is shown at), so its transform,
   * opacity, effects, transitions and motion blur work as for any picture.
   * A world inside a world draws nothing yet (phase E): the 3D renderer drops
   * such layers before it builds its scene.
   */
  private nestedWorld(layer: NestedLayer, world: Comp, at: { timeMs: number; cycle: number }, track: Track, locked: boolean): LeafNode | null {
    const painter = this.source.worlds
    if (!painter) return null
    const insideMs = compTimeFor(world, at.timeMs)
    const resolved = resolveLayer(layer, this.timeMs)
    this.simulated(layer, track, resolved)
    const box = { width: world.width, height: world.height }
    const frames = this.source.frames && nestedFrames(this.source.frames, layer.id, at.cycle)
    const inner: SceneSource = { ...this.source, frames }
    const content: Content = { box, draw: (ctx) => painter.paint(ctx, world, inner, insideMs, box.width, box.height) }
    const matrix = layerMatrix(resolved.transform, box)
    return { kind: 'leaf', layer, resolved, content, matrix, above: IDENTITY, track, locked }
  }

  leaf(layer: Layer, track: Track, locked: boolean, stretch?: Stretch): LeafNode | null {
    const resolved = resolveLayer(layer, this.timeMs)
    this.simulated(layer, track, resolved)
    const t = resolved.transform
    let stretched: Stretch | undefined
    if (stretch && (stretch.width !== undefined || stretch.height !== undefined)) {
      // A layout's size is in comp pixels; the layer's own size is before its scale.
      const w = stretch.width === undefined ? undefined : stretch.width / Math.max(1e-6, Math.abs(t.scaleX))
      const h = stretch.height === undefined ? undefined : stretch.height / Math.max(1e-6, Math.abs(t.scaleY))
      if (resolved.shape) resolved.shape = { ...resolved.shape, ...(w !== undefined ? { width: w } : {}), ...(h !== undefined ? { height: h } : {}) }
      if (resolved.textBox) {
        resolved.textBox = { maxWidth: w ?? resolved.textBox.maxWidth, maxHeight: h ?? resolved.textBox.maxHeight }
      }
      stretched = { width: w, height: h }
    }
    const content = layerContent(this.source.measure, resolved, this.mediaFor(layer), this.timeMs, this.source.frames)
    if (!content) return null
    const matrix = layerMatrix(t, content.box)
    return { kind: 'leaf', layer, resolved, content, matrix, above: IDENTITY, track, locked, ...(stretched ? { stretched } : {}) }
  }

  group(layer: GroupLayer, track: Track, locked: boolean, stretch?: Stretch): GroupNode {
    const resolved = resolveLayer(layer, this.timeMs)
    const t = resolved.transform
    const life = layer.behaviors.length > 0 ? evaluateBehaviours(this.comp, this.source.media, layer, this.timeMs, resolved.layerTimeMs) : null
    if (life) for (const [id, index] of life.switches) this.switchOverrides.set(id, index)
    let children = this.level(layer.id, locked)
    let box: Rect
    let layout: Layout | null = layer.layout
    let stretched: Stretch | undefined
    if (layout) {
      if (stretch?.width !== undefined || stretch?.height !== undefined) {
        layout = { ...layout, width: stretch.width ?? layout.width, height: stretch.height ?? layout.height }
        stretched = { ...stretch }
      }
      box = this.arrange(layout, children, locked)
    } else {
      box = unionRect(children.map(nodeBounds))
    }
    // A switch keeps the box of all its members, and shows one.
    if (resolved.switch !== undefined && resolved.switch !== null) children = this.shown(layer, resolved.switch, children)
    // Pieces ride their bones by where they rest; then life moves layers, then bones carry their pieces.
    const bound = layer.rig && layer.rig.bones.length > 0 ? this.bindings(layer, children) : null
    if (life) this.applyOps(layer, children, box, life)
    if (bound) this.carry(resolved.bones ?? layer.rig?.bones ?? [], life, bound)
    // The group's own transform is a change from where its members are, around a point of its box.
    const [px, py] = [box.left + t.anchorX * box.width, box.top + t.anchorY * box.height]
    this.simulated(layer, track, resolved, [px, py])
    const own = compose(
      translate(t.x + px, t.y + py, t.z),
      rotateZ(degToRad(t.rotation)),
      rotateY(degToRad(t.rotationY)),
      rotateX(degToRad(t.rotationX)),
      scale(t.scaleX, t.scaleY, 1),
      translate(-px, -py, 0),
    )
    for (const child of children) prefix(child, own)
    if (layer.mode !== 'pass' && layer.mode !== 'union' && children.length > 0) {
      // The cutters: members marked as stencils, or else the front-most one.
      const marked = children.filter((c) => c.layer.isStencil)
      for (const cutter of marked.length > 0 ? marked : [children[children.length - 1] as SceneNode]) markStencil(cutter)
    }
    const paints = { fills: resolved.fills ?? layer.fills, strokes: resolved.strokes ?? layer.strokes }
    const hasPaint = paints.fills.some((f) => f.enabled) || paints.strokes.some((s) => s.enabled && s.width > 0)
    const container = layout && hasPaint ? containerContent(box.width, box.height, layer.cornerRadius, paints) : null
    return {
      kind: 'group',
      layer,
      resolved,
      box,
      container,
      clip: layout?.clipContent ?? false,
      mode: layer.mode,
      children,
      matrix: own,
      above: IDENTITY,
      track,
      locked,
      ...(stretched ? { stretched } : {}),
    }
  }

  /** The one member a switch shows (an override from a behaviour, else the value; clamped to the members). */
  private shown(layer: GroupLayer, value: number, children: SceneNode[]): SceneNode[] {
    const members = groupMembers(this.comp, layer.id)
    if (members.length === 0) return children
    const index = Math.min(members.length - 1, Math.max(0, Math.floor(this.switchOverrides.get(layer.id) ?? value)))
    const id = (members[index] as Layer).id
    return children.filter((c) => c.layer.id === id)
  }

  /** The bone each direct member of a rig rides, by where it rests. */
  private bindings(layer: GroupLayer, children: SceneNode[]): Map<SceneNode, string> {
    const bones = layer.rig?.bones ?? []
    const out = new Map<SceneNode, string>()
    for (const child of children) {
      if (child.track.groupId !== layer.id) continue
      const bind = child.layer.bind
      if (bind?.mode === 'none') continue
      const rigid = bind?.mode === 'rigid' && bind.bone !== undefined ? bones.find((b) => b.id === bind.bone) : undefined
      const bone = rigid ?? autoBone(bones, nodeBounds(child))
      if (bone) out.set(child, bone.id)
    }
    return out
  }

  /** Puts the matrices of a group's behaviours on the layers they target. */
  private applyOps(layer: GroupLayer, children: SceneNode[], box: Rect, life: BehaviourResult): void {
    for (const op of life.ops) {
      if (op.target === layer.id) {
        const m = op.make(box)
        for (const child of children) prefix(child, m)
        continue
      }
      const node = findNode(children, op.target)
      if (node) prefix(node, op.make(nodeBounds(node)))
    }
  }

  /** Solves the rig at this moment and moves each bound member by its bone's change. */
  private carry(bones: readonly Bone[], life: BehaviourResult | null, bound: Map<SceneNode, string>): void {
    const poses = new Map<string, BonePose>()
    for (const b of bones) {
      const add = life?.bones.get(b.id)
      poses.set(b.id, { rotation: b.pose.rotation + (add?.rotation ?? 0), x: b.pose.x, y: b.pose.y, scale: b.pose.scale * (add?.scale ?? 1) })
    }
    const solved = solveRig(bones, poses)
    for (const [child, id] of bound) {
      const delta = solved.get(id)
      if (delta) prefix(child, affineToMat4(delta.matrix))
    }
  }

  /**
   * Places a layout's members: measure them, solve, rebuild the ones that
   * fill at the size they get (a stretched text re-wraps, so it is measured
   * again), solve once more, and move each into its slot.
   */
  arrange(layout: Layout, children: SceneNode[], locked: boolean): Rect {
    // The flow runs front to back (children are back to front).
    const order = () => [...children].reverse().filter((n) => !n.layer.layoutItem.absolute)
    const solve = (nodes: SceneNode[]) =>
      solveLayout(
        layout,
        nodes.map((n) => {
          const b = nodeBounds(n)
          return { id: n.layer.id, width: b.width, height: b.height, item: n.layer.layoutItem }
        }),
      )
    let result = solve(order())
    let rebuilt = false
    for (const [i, slot] of result.slots.entries()) {
      const node = order()[i] as SceneNode
      const item = node.layer.layoutItem
      if (!item.fillX && !item.fillY) continue
      const stretch: Stretch = {}
      if (item.fillX) stretch.width = slot.width
      if (item.fillY) stretch.height = slot.height
      const fresh = this.node(node.layer, node.track, locked, stretch)
      if (fresh) {
        children[children.indexOf(node)] = fresh
        rebuilt = true
      }
    }
    if (rebuilt) result = solve(order())
    const placed = order()
    for (const [i, slot] of result.slots.entries()) {
      const node = placed[i] as SceneNode
      const b = nodeBounds(node)
      prefix(node, translate(slot.x - b.left, slot.y - b.top, 0))
    }
    return { left: result.x, top: result.y, width: result.width, height: result.height }
  }

  private mediaFor(layer: Layer): MediaAsset | undefined {
    return 'mediaId' in layer ? this.source.media.find((m) => m.id === layer.mediaId) : undefined
  }
}

/** Applies a transition side's pose to a node: offset by a fraction of the comp, turned and scaled about its centre, faded and blurred. */
function pose(node: SceneNode, side: TransitionSide, comp: Comp): void {
  const { pose: p, mix, window } = side
  node.resolved = { ...node.resolved, transform: { ...node.resolved.transform, opacity: node.resolved.transform.opacity * p.opacity } }
  if (p.blur > 0) node.resolved.blur = (node.resolved.blur ?? 0) + p.blur
  if (p.dx !== 0 || p.dy !== 0 || p.rotation !== 0 || p.scale !== 1) {
    const b = nodeBounds(node)
    const cx = b.left + b.width / 2
    const cy = b.top + b.height / 2
    prefix(node, compose(translate(cx + p.dx * comp.width, cy + p.dy * comp.height, 0), rotateZ(degToRad(p.rotation)), scale(p.scale, p.scale, 1), translate(-cx, -cy, 0)))
  }
  node.transition = { id: window.transition.id, role: side.role, wipe: mix.wipe, veil: mix.veil, color: side.color, ...(mix.tear ? { tear: mix.tear } : {}) }
}

/** The comp's physics simulation (null without bodies): it reads bodies from the comp built with physics off. */
export function physicsOf(comp: Comp, source: SceneSource, stack: readonly string[] = [comp.id]): Simulation | null {
  return simulationFor(comp, source, (t) => new SceneBuilder(comp, { ...source, noPhysics: true }, t, stack, null).level(null, false))
}

/** The comp at `timeMs` as a tree of nodes, back to front. */
export function buildScene(comp: Comp, source: SceneSource, timeMs: number): SceneNode[] {
  return new SceneBuilder(comp, source, compTimeFor(comp, timeMs)).level(null, false)
}

/** Every node in a scene, depth first, back to front. */
export function flattenScene(nodes: readonly SceneNode[]): SceneNode[] {
  return nodes.flatMap((n) => (n.kind === 'group' ? [n, ...flattenScene(n.children)] : [n]))
}

/** A node by layer id, anywhere in a subtree. */
function findNode(nodes: readonly SceneNode[], id: string): SceneNode | undefined {
  for (const node of nodes) {
    if (node.layer.id === id) return node
    if (node.kind !== 'leaf') {
      const inner = findNode(node.children, id)
      if (inner) return inner
    }
  }
  return undefined
}

/** Whether a matrix keeps everything in the picture plane (no depth, no tilt), so Canvas2D can draw it directly. */
export function isFlat(m: Mat4): boolean {
  const near = (i: number, v = 0) => Math.abs((m[i] as number) - v) < 1e-9
  return near(2) && near(3) && near(6) && near(7) && near(8) && near(9) && near(11) && near(14) && near(10, 1) && near(15, 1)
}

const radToDeg = (r: number) => (r * 180) / Math.PI

/**
 * Where every node really is (see core's `Placement`): leaves by their pivot
 * and total rotation, scale and opacity; groups by the move their own
 * transform makes plus what the groups above them add.
 */
export function placementsOf(nodes: readonly SceneNode[], opacityAbove = 1, out = new Map<string, Placement>()): Map<string, Placement> {
  for (const node of nodes) {
    const t = node.resolved.transform
    const opacity = opacityAbove * t.opacity
    const m = node.matrix
    const det = (m[0] as number) * (m[5] as number) - (m[1] as number) * (m[4] as number)
    const base = {
      rotation: radToDeg(Math.atan2(m[1] as number, m[0] as number)),
      scaleX: Math.hypot(m[0] as number, m[1] as number) * (det < 0 ? -1 : 1),
      scaleY: Math.hypot(m[4] as number, m[5] as number),
      opacity,
      bounds: nodeBounds(node),
      ...(node.stretched?.width !== undefined ? { width: node.stretched.width } : {}),
      ...(node.stretched?.height !== undefined ? { height: node.stretched.height } : {}),
    }
    if (node.kind !== 'group') {
      const [px, py] = pivotOffset(t, node.kind === 'leaf' ? node.content.box : node.box)
      const [x, y] = transformPoint(m, px, py, 0)
      out.set(node.layer.id, { ...base, x, y })
    } else {
      // A group's placement is its own move plus how far the groups above it carry its pivot.
      const pivot: [number, number] = [node.box.left + t.anchorX * node.box.width, node.box.top + t.anchorY * node.box.height]
      const [ax, ay] = transformPoint(node.above, pivot[0], pivot[1], 0)
      const { left, top, width, height } = node.box
      out.set(node.layer.id, { ...base, x: t.x + ax - pivot[0], y: t.y + ay - pivot[1], box: { left, top, width, height } })
      placementsOf(node.children, opacity, out)
    }
  }
  return out
}
