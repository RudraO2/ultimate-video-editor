import { type Comp, type Effect, isWorld, type Layer, type MediaAsset, parseColor, type Placement } from '@uve/core'
import { type FrontCamera, frontCamera, projectionMatrix, projectToPixels } from './camera'
import type { Content, Ctx2D, FrameProvider } from './content'
import { applyEffects, blendPictures, type EffectEnv, effectsReach, mixPictures, smear } from './effects'
import { isActiveAt } from './evaluate'
import { type Mat4, multiply, transformPoint, translate } from './math'
import { applyMix, drawIsolated } from './paint'
import { centreOf, type MotionPlan, type MovingNode, planMotion } from './motion'
import { CardProjector } from './projector'
import { tear, wipeMask } from './transition'
import {
  buildScene,
  flattenScene,
  type GroupNode,
  isFlat,
  type NestedNode,
  nodeBounds,
  physicsOf,
  placementsOf,
  type Rect,
  type SceneNode,
  type SceneSource,
  type WorldPainter,
} from './scene'
import type { Simulation } from './physics/simulate'
import type { WorldHost } from './world/host'
import { modelsUsed } from './models'
import type { Bounds3, OrbitRenderOptions, OrbitView } from './orbit'
import { usesWorld, worldLoader } from './worldLoader'

/** What drawing a comp needs from its project: the media files, and the comps nested layers show. */
export interface SceneDoc {
  media: readonly MediaAsset[]
  comps: readonly Comp[]
}

/** How a cutting group's stencils combine with its other members. */
const CUT: Partial<Record<GroupNode['mode'], GlobalCompositeOperation>> = {
  mask: 'destination-in',
  intersect: 'destination-in',
  subtract: 'destination-out',
  exclude: 'xor',
}

/** Largest side, in pixels, of the bitmap a projected layer is rasterised into. */
const MAX_RASTER = 4096

/** A canvas blur filter for a layer blur given in layer px, or undefined when there is none to see. */
function blurFilter(blur: number | undefined, matrix: Mat4, scale: number): string | undefined {
  if (!blur || blur <= 0) return undefined
  const layerScale = Math.max(Math.hypot(matrix[0] as number, matrix[1] as number), Math.hypot(matrix[4] as number, matrix[5] as number))
  const px = blur * layerScale * scale
  return px >= 0.2 ? `blur(${px.toFixed(2)}px)` : undefined
}

export type Point = [x: number, y: number]

interface Region {
  x: number
  y: number
  width: number
  height: number
}

export interface RenderOptions {
  /** false draws no motion blur (the comp's and layers' settings are ignored). */
  motionBlur?: boolean
  /** Caps the moments drawn per moving layer (a draft while playing). */
  maxMotionSamples?: number
  /** true leaves the comp's background out: the canvas is cleared, so it must have alpha (a transparent export). */
  transparent?: boolean
}

/** Whether a node, and everything inside it, is drawn flat (no depth or tilt). */
function allFlat(node: SceneNode): boolean {
  return isFlat(node.matrix) && (node.kind === 'leaf' || node.children.every(allFlat))
}

function containsPoint(polygon: readonly Point[], [x, y]: Point): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i] as Point
    const [xj, yj] = polygon[j] as Point
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/**
 * Draws comps. Flat layers go straight onto a Canvas2D context; layers with
 * depth or tilt are drawn as perspective cards by a WebGL2 projector and then
 * composited in their place, so stacking order always holds. Groups draw
 * their members as one: a group that fades or clips is drawn on its own
 * surface first.
 */
export class CompRenderer {
  private projector: CardProjector | null = null
  private surface: OffscreenCanvas | null = null
  private measureContext: OffscreenCanvasRenderingContext2D | null = null
  /** Where the canvas being drawn into sits in the output, px: a node drawn apart for its effects gets a canvas of its own size. */
  private origin: Point = [0, 0]
  /** The moving nodes of the frame being drawn and their shutter samples, by layer id. */
  private motion: MotionPlan = new Map()
  /** True while a sample of a moving node is drawn, so what is inside it is not blurred again. */
  private sampling = false
  /** The options of the render in progress, for worlds (nested ones included) drawn while it runs. */
  private options: RenderOptions = {}
  /** Transitions whose sides are being drawn apart, so each side then draws as itself. */
  private pairing = new Set<string>()
  /** Called when the 3D world renderer finishes loading after a world was met before it was ready: draw again. */
  onWorldReady?: () => void
  private awaitingWorlds = false

  /** What the 3D world renderer asks of this renderer (see world/host.ts). */
  private readonly worldHost: WorldHost = {
    reach: (node) => this.reachOf(node) + (node.resolved.blur ?? 0) * 3,
    modelLoaded: () => this.onWorldReady?.(),
    drawAlone: (node, comp, rect, raster, width, height, into) => this.drawAlone(node, comp, rect, raster, width, height, into),
  }

  /** Draws worlds nested in flat comps (see scene.ts `WorldPainter`). */
  private readonly worldPainter: WorldPainter = {
    paint: (ctx, world, source, timeMs, width, height) => this.paintWorld(ctx, world, source, timeMs, width, height),
  }

  /**
   * Loads the 3D world renderer when `comp`, or a comp it nests, is a world.
   * Resolves at once for a flat project (nothing is loaded). Call it before
   * `render` so the first frame of a world is not empty.
   */
  async prepare(comp: Comp, doc: SceneDoc): Promise<void> {
    if (!usesWorld(comp, doc.comps)) return
    const world = await worldLoader.ensure()
    // Every model a world will draw is read first, so a render never misses one.
    await world.preloadModels(modelsUsed(comp, doc.comps, doc.media))
  }

  /** Whether the 3D world renderer has loaded. */
  get worldsReady(): boolean {
    return worldLoader.module !== null
  }

  /** Starts loading the world renderer; `onWorldReady` fires once it is there. */
  private awaitWorlds(): void {
    if (this.awaitingWorlds) return
    this.awaitingWorlds = true
    worldLoader.ensure().then(
      () => {
        this.awaitingWorlds = false
        this.onWorldReady?.()
      },
      (error) => {
        this.awaitingWorlds = false
        console.error('The 3D world renderer failed to load:', error)
      },
    )
  }

  private sourceOf(doc: SceneDoc, frames?: FrameProvider): SceneSource {
    return { measure: this.measure(), media: doc.media, comps: doc.comps, frames, worlds: this.worldPainter }
  }

  /** Draws `comp` at `timeMs`. `scale` is output pixels per comp pixel. */
  render(ctx: Ctx2D, comp: Comp, doc: SceneDoc, timeMs: number, scale: number, frames?: FrameProvider, options: RenderOptions = {}): void {
    const { width, height } = ctx.canvas
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
    // Cleared first: a clear background (a nested comp's or a world's) painted over the last frame would leave it showing.
    ctx.clearRect(0, 0, width, height)
    if (!options.transparent) {
      ctx.fillStyle = comp.background
      ctx.fillRect(0, 0, width, height)
    }
    ctx.restore()

    const source = this.sourceOf(doc, frames)
    const outer = this.options
    this.options = options
    try {
      if (isWorld(comp)) this.renderWorld(ctx, comp, source, timeMs)
      else this.renderFlat(ctx, comp, source, timeMs, scale, options)
    } finally {
      this.options = outer
    }
  }

  /**
   * Draws a world through the orbit view (editor only; never used by exports),
   * over its background (Solid shading: `voidColor`; the others the comp's).
   * A flat comp is drawn by `render` as usual.
   */
  renderOrbit(ctx: Ctx2D, comp: Comp, doc: SceneDoc, timeMs: number, scale: number, frames: FrameProvider | undefined, options: OrbitRenderOptions): void {
    if (!isWorld(comp)) {
      this.render(ctx, comp, doc, timeMs, scale, frames)
      return
    }
    const { width, height } = ctx.canvas
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = options.shading === 'solid' ? options.voidColor : comp.background
    ctx.fillRect(0, 0, width, height)
    ctx.restore()
    const world = worldLoader.module
    if (!world) {
      this.awaitWorlds()
      return
    }
    const canvas = world.renderOrbit(this.worldHost, comp, this.sourceOf(doc, frames), timeMs, width, height, options)
    if (!canvas) return
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
    ctx.drawImage(canvas, 0, 0)
    ctx.restore()
  }

  /**
   * The layer under a point given in comp pixels (the canvas spans the comp's
   * width × height) seen through the orbit view. `pxPerComp` is screen (CSS)
   * px per comp px, for the 16 px and 10 px gizmo radii. Meshes and models
   * are tested as the last `renderOrbit` of the comp drew them; null while
   * the world renderer has not loaded.
   */
  orbitPick(comp: Comp, doc: SceneDoc, timeMs: number, view: OrbitView, point: Point, options: { includeLocked?: boolean; pxPerComp?: number } = {}): Layer | null {
    if (!isWorld(comp)) return null
    return worldLoader.module?.orbitPick(this.worldHost, comp, this.sourceOf(doc), timeMs, view, point, options) ?? null
  }

  /** World bounds (px) of the given layers (every picture, mesh and model when `ids` is omitted) at a time, for framing; null when there is nothing or the world renderer has not loaded. Cameras and lights count as their origin only when `ids` names them. */
  orbitBounds(comp: Comp, doc: SceneDoc, timeMs: number, ids?: readonly string[]): Bounds3 | null {
    if (!isWorld(comp)) return null
    return worldLoader.module?.orbitBounds(this.worldHost, comp, this.sourceOf(doc), timeMs, ids) ?? null
  }

  /** Draws a flat comp (the world case is `renderWorld`). */
  private renderFlat(ctx: Ctx2D, comp: Comp, source: SceneSource, timeMs: number, scale: number, options: RenderOptions): void {
    const camera = frontCamera(comp.width, comp.height)
    const scene = buildScene(comp, source, timeMs)
    this.motion = options.motionBlur === false ? new Map() : planMotion(comp, scene, (t) => buildScene(comp, source, t), timeMs, scale, options.maxMotionSamples)
    try {
      this.drawNodes(ctx, comp, camera, scene, scale)
    } finally {
      this.motion = new Map()
    }
  }

  /**
   * The comp at a moment as a tree (see scene.ts), for callers that need to know where things are.
   * A world's tree holds its pictures as the flat renderer builds them (their flat equivalents);
   * until the world renderer has loaded it is the plain tree.
   */
  scene(comp: Comp, doc: SceneDoc, timeMs: number): SceneNode[] {
    const source = this.sourceOf(doc)
    if (isWorld(comp) && worldLoader.module) return worldLoader.module.worldScene(comp, source, timeMs)
    return buildScene(comp, source, timeMs)
  }

  /** The comp's physics simulation, or null when it has no bodies (or is a world). */
  simulation(comp: Comp, doc: SceneDoc): Simulation | null {
    return physicsOf(comp, this.sourceOf(doc))
  }

  /** The options a world is rendered with: this render's motion blur switch and sample cap (none while a moving layer's samples are drawn: they already blur it). */
  private worldOptions(): { motionBlur?: boolean; maxSamples?: number } {
    return { motionBlur: this.sampling ? false : this.options.motionBlur, maxSamples: this.options.maxMotionSamples }
  }

  /** Draws a world comp: its background is already on `ctx`; the 3D scene goes over it. */
  private renderWorld(ctx: Ctx2D, comp: Comp, source: SceneSource, timeMs: number): void {
    const world = worldLoader.module
    if (!world) {
      this.awaitWorlds()
      return
    }
    const canvas = world.renderWorld(this.worldHost, comp, source, timeMs, ctx.canvas.width, ctx.canvas.height, this.worldOptions())
    if (!canvas) return
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
    ctx.drawImage(canvas, -this.origin[0], -this.origin[1])
    ctx.restore()
  }

  /**
   * Draws a world nested in a flat comp into a picture: at the resolution it
   * is shown at (read from the context's transform, at most twice the comp's
   * size), over the world's own background.
   */
  private paintWorld(ctx: Ctx2D, world: Comp, source: SceneSource, timeMs: number, width: number, height: number): void {
    const module = worldLoader.module
    if (!module) {
      this.awaitWorlds()
      return
    }
    const m = ctx.getTransform()
    const pixels = (layerPx: number, scale: number) => Math.max(1, Math.min(Math.round(layerPx * scale), Math.round(layerPx * 2)))
    const w = pixels(width, Math.hypot(m.a, m.b))
    const h = pixels(height, Math.hypot(m.c, m.d))
    const canvas = module.renderWorld(this.worldHost, world, source, timeMs, w, h, this.worldOptions())
    if (!canvas) return
    if ((parseColor(world.background)?.[3] ?? 255) > 0) {
      ctx.fillStyle = world.background
      ctx.fillRect(-width / 2, -height / 2, width, height)
    }
    ctx.drawImage(canvas, -width / 2, -height / 2, width, height)
  }

  /**
   * Draws a stand-alone node (see world/frame.ts `standAlone`) onto a
   * canvas that stands for `rect` of the node's own space at `raster` texels
   * per px: with its effects and blur, no motion blur, nothing else of the comp.
   */
  private drawAlone(node: SceneNode, comp: Comp, rect: Rect, raster: number, width: number, height: number, into?: OffscreenCanvas): OffscreenCanvas {
    const canvas = into && into.width === width && into.height === height ? into : new OffscreenCanvas(width, height)
    const target = canvas.getContext('2d')
    if (!target) throw new Error('Canvas 2D is not available')
    target.setTransform(1, 0, 0, 1, 0, 0)
    target.clearRect(0, 0, width, height)
    const saved = { origin: this.origin, motion: this.motion, sampling: this.sampling }
    this.origin = [raster * (comp.width / 2 + rect.left), raster * (comp.height / 2 + rect.top)]
    this.motion = new Map()
    this.sampling = false
    try {
      this.drawNodes(target, comp, frontCamera(comp.width, comp.height), [node], raster)
    } finally {
      this.origin = saved.origin
      this.motion = saved.motion
      this.sampling = saved.sampling
    }
    return canvas
  }

  /** Where every visible layer really is at a comp time, groups and layouts applied (core's `Measure`). */
  placements(comp: Comp, doc: SceneDoc, timeMs: number): Map<string, Placement> {
    return placementsOf(this.scene(comp, doc, timeMs))
  }

  /** A layer's four corners in comp pixels at a comp time, or null when it is not visible. */
  outline(comp: Comp, doc: SceneDoc, layer: Layer, timeMs: number): Point[] | null {
    if (!isActiveAt(layer, timeMs) || layer.kind === 'audio') return null
    if (isWorld(comp)) return worldLoader.module?.worldCorners(comp, this.sourceOf(doc), timeMs, layer.id) ?? null
    const node = flattenScene(this.scene(comp, doc, timeMs)).find((n) => n.layer.id === layer.id)
    return node ? this.cornersOf(comp, node) : null
  }

  /** The front-most visible layer under a point given in comp pixels (a nested comp as a whole). Hidden tracks, and locked ones unless asked, are skipped. */
  pick(comp: Comp, doc: SceneDoc, timeMs: number, point: Point, includeLocked = false): Layer | null {
    if (isWorld(comp)) return worldLoader.module?.worldPick(comp, this.sourceOf(doc), timeMs, point, includeLocked) ?? null
    const leaves = flattenScene(this.scene(comp, doc, timeMs)).filter((n) => n.kind !== 'group')
    for (let i = leaves.length - 1; i >= 0; i--) {
      const leaf = leaves[i] as SceneNode
      if ((leaf.locked && !includeLocked) || leaf.stencil) continue
      const corners = this.cornersOf(comp, leaf)
      if (corners && containsPoint(corners, point)) return leaf.layer
    }
    return null
  }

  /** A node's box corners in its own space (top-left, top-right, bottom-right, bottom-left), grown by `grow` px. */
  private localCorners(node: SceneNode, grow = 0): Point[] {
    if (node.kind === 'leaf') {
      const w = node.content.box.width / 2 + grow
      const h = node.content.box.height / 2 + grow
      return [
        [-w, -h],
        [w, -h],
        [w, h],
        [-w, h],
      ]
    }
    const { left, top, width, height } = node.box
    return [
      [left - grow, top - grow],
      [left + width + grow, top - grow],
      [left + width + grow, top + height + grow],
      [left - grow, top + height + grow],
    ]
  }

  private cornersOf(comp: Comp, node: SceneNode, grow = 0): Point[] | null {
    const camera = frontCamera(comp.width, comp.height)
    const corners: Point[] = []
    for (const [x, y] of this.localCorners(node, grow)) {
      const [px, py, pz] = transformPoint(node.matrix, x, y, 0)
      const point = projectToPixels(camera, px, py, pz)
      if (!point) return null
      corners.push(point)
    }
    return corners
  }

  private drawNodes(ctx: Ctx2D, comp: Comp, camera: FrontCamera, nodes: readonly SceneNode[], scale: number): void {
    const paired = new Set<string>()
    for (const node of nodes) {
      // Two sides of a transition that a wipe, a veil or a tear joins are drawn together, once.
      const t = node.transition
      if (t && !this.pairing.has(t.id) && (t.wipe || t.veil > 0.001 || t.tear)) {
        if (!paired.has(t.id)) {
          paired.add(t.id)
          this.drawTransition(ctx, comp, camera, nodes.filter((n) => n.transition?.id === t.id), scale)
        }
        continue
      }
      const moving = this.sampling ? undefined : this.motion.get(node.layer.id)
      if (moving) this.drawMoving(ctx, comp, camera, node, moving, scale)
      else if (node.kind === 'leaf') {
        const opacity = node.resolved.transform.opacity
        if (opacity <= 0) continue
        const blur = blurFilter(node.resolved.blur, node.matrix, scale)
        const draw = (target: Ctx2D, alpha: number) => {
          if (blur) drawIsolated(target, (scratch) => this.drawContent(scratch, comp, camera, node.matrix, node.content, alpha, scale), 1, 'normal', undefined, blur)
          else this.drawContent(target, comp, camera, node.matrix, node.content, alpha, scale)
        }
        ctx.save()
        const effects = node.resolved.effects
        if (effects) this.drawWithEffects(ctx, comp, node, effects, opacity, scale, (target) => draw(target, 1))
        else draw(ctx, opacity)
        ctx.restore()
      } else this.drawGroup(ctx, comp, camera, node, scale)
    }
  }

  /** Draws a group's members, or a nested comp's inside, as one. */
  private drawGroup(ctx: Ctx2D, comp: Comp, camera: FrontCamera, group: GroupNode | NestedNode, scale: number): void {
    const opacity = group.resolved.transform.opacity
    if (opacity <= 0) return
    const mode = group.kind === 'group' ? group.mode : 'pass'
    const cut = CUT[mode]
    const contents = (target: Ctx2D) => {
      const { box } = group
      const centre = multiply(group.matrix, translate(box.left + box.width / 2, box.top + box.height / 2, 0))
      if (group.container) this.drawContent(target, comp, camera, centre, group.container, 1, scale)
      if (group.clip && isFlat(centre)) {
        this.setFlatTransform(target, comp, centre, scale)
        target.beginPath()
        target.rect(-box.width / 2, -box.height / 2, box.width, box.height)
        target.clip()
      }
      if (!cut) {
        this.drawNodes(target, comp, camera, group.children, scale)
        return
      }
      // The members, then the cutters composited onto them: kept inside (mask, intersect), cut out (subtract) or either but not both (exclude).
      this.drawNodes(target, comp, camera, group.children.filter((c) => !c.stencil), scale)
      drawIsolated(target, (scratch) => this.drawNodes(scratch, comp, camera, group.children.filter((c) => c.stencil), scale), 1, 'normal', cut)
    }
    // Fading a group fades it as one picture; a clip, a union or a cut must not touch what is under the group: all draw apart.
    const blur = blurFilter(group.resolved.blur, group.matrix, scale)
    const effects = group.resolved.effects
    if (effects) {
      this.drawWithEffects(ctx, comp, group, effects, opacity, scale, (target) => {
        if (group.clip || mode !== 'pass' || blur) drawIsolated(target, (scratch) => contents(scratch), 1, 'normal', undefined, blur)
        else contents(target)
      })
    } else if (opacity < 1 || group.clip || mode !== 'pass' || blur) drawIsolated(ctx, (scratch) => contents(scratch), opacity, 'normal', undefined, blur)
    else contents(ctx)
  }

  /**
   * The rectangle of `ctx`'s canvas that `nodes` cover, each grown by what
   * `grow` says it reaches past its box (layer px), and no further than a
   * margin past the canvas's edge. A node with depth or tilt anywhere inside
   * takes the whole canvas, which the projector draws into.
   */
  private regionOf(ctx: Ctx2D, comp: Comp, nodes: readonly SceneNode[], scale: number, grow: (node: SceneNode) => number): Region | null {
    const { width: cw, height: ch } = ctx.canvas
    if (!nodes.every(allFlat)) return { x: 0, y: 0, width: cw, height: ch }
    const [ox, oy] = this.origin
    const points = nodes.flatMap((node) => this.cornersOf(comp, node, grow(node)) ?? []).map(([x, y]): Point => [x * scale - ox, y * scale - oy])
    if (points.length === 0) return null
    // Past the output's edge only as far as a blur there could pull pixels back in.
    const margin = 128
    const left = Math.max(-margin, Math.floor(Math.min(...points.map((p) => p[0]))))
    const top = Math.max(-margin, Math.floor(Math.min(...points.map((p) => p[1]))))
    const right = Math.min(cw + margin, Math.ceil(Math.max(...points.map((p) => p[0]))))
    const bottom = Math.min(ch + margin, Math.ceil(Math.max(...points.map((p) => p[1]))))
    return right - left < 1 || bottom - top < 1 ? null : { x: left, y: top, width: right - left, height: bottom - top }
  }

  /** Draws on a canvas of its own that stands for `region` of the current canvas. */
  private drawApart(region: Region, draw: (target: Ctx2D) => void): OffscreenCanvas {
    const canvas = new OffscreenCanvas(region.width, region.height)
    const target = canvas.getContext('2d')
    if (!target) throw new Error('Canvas 2D is not available')
    const [ox, oy] = this.origin
    this.origin = [ox + region.x, oy + region.y]
    try {
      draw(target)
    } finally {
      this.origin = [ox, oy]
    }
    return canvas
  }

  /** What a node reaches past its box: strokes, and its effect cards. */
  private reachOf(node: SceneNode): number {
    const bleed = node.kind === 'leaf' ? (node.content.bleed ?? 0) : 0
    const effects = node.resolved.effects
    return bleed + (effects ? effectsReach(effects, node.kind === 'leaf' ? node.content.box : node.box) : 0)
  }

  /** Composites a picture drawn apart back over `region` of `ctx`. */
  private composite(ctx: Ctx2D, picture: OffscreenCanvas, region: Region, opacity = 1): void {
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    applyMix(ctx, opacity, 'normal')
    ctx.drawImage(picture, region.x, region.y)
    ctx.restore()
  }

  /**
   * Draws a node apart on a canvas just big enough for it and what its effects
   * reach, runs its effect cards over those pixels, then composites the result
   * with the node's opacity.
   */
  private drawWithEffects(ctx: Ctx2D, comp: Comp, node: SceneNode, effects: Effect[], opacity: number, scale: number, draw: (target: Ctx2D) => void): void {
    const m = node.matrix
    const [ox, oy] = this.origin
    const box = this.cornersOf(comp, node)?.map(([x, y]): Point => [x * scale - ox, y * scale - oy])
    const region = box ? this.regionOf(ctx, comp, [node], scale, (n) => this.reachOf(n)) : null
    if (!box || !region) return
    const picture = this.drawApart(region, draw)
    const env: EffectEnv = {
      linear: [(m[0] as number) * scale, (m[1] as number) * scale, (m[4] as number) * scale, (m[5] as number) * scale],
      box: box.map(([x, y]): Point => [x - region.x, y - region.y]) as EffectEnv['box'],
      timeMs: node.resolved.layerTimeMs,
      backdrop: () => {
        const under = new OffscreenCanvas(region.width, region.height)
        under.getContext('2d')?.drawImage(ctx.canvas, -region.x, -region.y)
        return under
      },
    }
    this.composite(ctx, applyEffects(picture, effects, env), region, opacity)
  }

  /**
   * Draws the two sides of a transition together: each apart, the incoming
   * one kept inside the wipe and the outgoing one outside it, the pair torn
   * sideways (glitch) and veiled in the transition's colour (dips, flashes).
   */
  private drawTransition(ctx: Ctx2D, comp: Comp, camera: FrontCamera, pair: SceneNode[], scale: number): void {
    const t = pair[0]?.transition
    if (!t) return
    const region = this.regionOf(ctx, comp, pair, scale, (n) => this.reachOf(n))
    if (!region) return
    this.pairing.add(t.id)
    try {
      const [ox, oy] = this.origin
      const box = pair.map(nodeBounds).reduce((a, b) => {
        const left = Math.min(a.left, b.left)
        const top = Math.min(a.top, b.top)
        return { left, top, width: Math.max(a.left + a.width, b.left + b.width) - left, height: Math.max(a.top + a.height, b.top + b.height) - top }
      })
      const frame = {
        x: (box.left + comp.width / 2) * scale - ox - region.x,
        y: (box.top + comp.height / 2) * scale - oy - region.y,
        width: box.width * scale,
        height: box.height * scale,
      }
      const out = new OffscreenCanvas(region.width, region.height)
      const g = out.getContext('2d')
      if (!g) return
      const mask = t.wipe ? wipeMask(region.width, region.height, frame, t.wipe) : null
      for (const role of ['a', 'b'] as const) {
        const node = pair.find((n) => n.transition?.role === role)
        if (!node) continue
        const picture = this.drawApart(region, (target) => this.drawNodes(target, comp, camera, [node], scale))
        if (mask) {
          const p = picture.getContext('2d')
          if (p) {
            p.globalCompositeOperation = role === 'b' ? 'destination-in' : 'destination-out'
            p.drawImage(mask, 0, 0)
          }
        }
        g.drawImage(picture, 0, 0)
      }
      const result = t.tear ? tear(out, frame, t.tear.amount, t.tear.seed) : out
      if (t.veil > 0.001) {
        const v = result.getContext('2d')
        if (v) {
          v.globalCompositeOperation = 'source-atop'
          v.globalAlpha = Math.min(1, t.veil)
          v.fillStyle = t.color
          v.fillRect(0, 0, result.width, result.height)
        }
      }
      this.composite(ctx, result, region)
    } finally {
      this.pairing.delete(t.id)
    }
  }

  /**
   * Draws a moving node with motion blur: the node at each moment of its
   * shutter (placed there, or drawn anew there), mixed by weight; or, for
   * velocity sampling, its frame smeared along the motion. Strength below 1
   * mixes the sharp frame back in.
   */
  private drawMoving(ctx: Ctx2D, comp: Comp, camera: FrontCamera, node: SceneNode, moving: MovingNode, scale: number): void {
    const { settings, samples } = moving
    const nodes = [node, ...samples.map((s) => s.node)]
    const region = this.regionOf(ctx, comp, nodes, scale, (n) => this.reachOf(n))
    if (!region) return
    const draw = (variant: SceneNode) =>
      this.drawApart(region, (target) => {
        this.sampling = true
        try {
          this.drawNodes(target, comp, camera, [variant], scale)
        } finally {
          this.sampling = false
        }
      })
    const sharp = draw(node)
    let blurred: OffscreenCanvas
    if (settings.sampling === 'velocity') {
      // One smear along the straight line from where the node is when the shutter opens to where it is when it closes.
      const first = samples[0]?.node ?? node
      const last = samples[samples.length - 1]?.node ?? node
      const [ax, ay] = centreOf(first)
      const [bx, by] = centreOf(last)
      const [cx, cy] = centreOf(node)
      const length = Math.hypot(bx - ax, by - ay) * scale
      const dx = length > 0 ? ((bx - ax) * scale) / length : 0
      const dy = length > 0 ? ((by - ay) * scale) / length : 0
      const offset = (((ax + bx) / 2 - cx) * dx + ((ay + by) / 2 - cy) * dy) * scale
      const levels = Math.max(1, Math.min(6, Math.ceil(Math.log2(Math.max(2, length / 1.5)))))
      blurred = smear(sharp, length, levels, (g, t) => g.setTransform(1, 0, 0, 1, dx * t, dy * t), offset)
    } else {
      // Exact: the node as it is now, placed where each moment puts it; full: each moment's own node.
      const variants = samples.map((s) =>
        settings.sampling === 'content' || node.kind !== 'leaf' || s.node.kind !== 'leaf' ? s.node : { ...node, matrix: s.node.matrix },
      )
      blurred = blendPictures(variants.map(draw), samples.map((s) => s.weight), settings.combine)
    }
    this.composite(ctx, mixPictures(sharp, blurred, settings.strength), region)
  }

  private setFlatTransform(ctx: Ctx2D, comp: Comp, m: Mat4, scale: number): void {
    const at = (i: number) => m[i] as number
    const [ox, oy] = this.origin
    ctx.setTransform(scale * at(0), scale * at(1), scale * at(4), scale * at(5), scale * (at(12) + comp.width / 2) - ox, scale * (at(13) + comp.height / 2) - oy)
  }

  private drawContent(ctx: Ctx2D, comp: Comp, camera: FrontCamera, matrix: Mat4, content: Content, opacity: number, scale: number): void {
    if (isFlat(matrix)) {
      this.setFlatTransform(ctx, comp, matrix, scale)
      ctx.globalAlpha *= opacity
      content.draw(ctx)
    } else this.drawProjected(ctx, camera, matrix, content, opacity, scale)
  }

  private measure(): OffscreenCanvasRenderingContext2D {
    if (!this.measureContext) {
      const context = new OffscreenCanvas(1, 1).getContext('2d')
      if (!context) throw new Error('Canvas 2D is not available')
      this.measureContext = context
    }
    return this.measureContext
  }

  private drawProjected(ctx: Ctx2D, camera: FrontCamera, model: Mat4, content: Content, opacity: number, scale: number): void {
    // The card covers the box plus the bleed (strokes past the outline), so nothing is cut off.
    const bleed = content.bleed ?? 0
    const box = { width: content.box.width + bleed * 2, height: content.box.height + bleed * 2 }
    // Rasterise the flat picture at about the size it will be seen at, so cards stay sharp.
    const depth = model[14] as number
    const sx = Math.hypot(model[0] as number, model[1] as number, model[2] as number)
    const sy = Math.hypot(model[4] as number, model[5] as number, model[6] as number)
    const closeness = camera.distance / Math.max(camera.distance + depth, camera.distance * 0.25)
    const wanted = scale * Math.max(sx, sy, 1) * Math.max(1, closeness)
    const raster = Math.min(wanted, MAX_RASTER / Math.max(box.width, box.height, 1))
    const bitmapWidth = Math.max(1, Math.ceil(box.width * raster))
    const bitmapHeight = Math.max(1, Math.ceil(box.height * raster))

    const surface = this.surfaceOf(bitmapWidth, bitmapHeight)
    const sctx = surface.getContext('2d')
    if (!sctx) return
    sctx.setTransform(1, 0, 0, 1, 0, 0)
    sctx.clearRect(0, 0, bitmapWidth, bitmapHeight)
    sctx.setTransform(raster, 0, 0, raster, bitmapWidth / 2, bitmapHeight / 2)
    content.draw(sctx)

    this.projector ??= new CardProjector()
    const matrix = multiply(projectionMatrix(camera), model)
    this.projector.render(surface, matrix, box, opacity * ctx.globalAlpha, ctx.canvas.width, ctx.canvas.height)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
    ctx.drawImage(this.projector.canvas, 0, 0)
  }

  private surfaceOf(width: number, height: number): OffscreenCanvas {
    if (!this.surface) this.surface = new OffscreenCanvas(width, height)
    if (this.surface.width !== width || this.surface.height !== height) {
      this.surface.width = width
      this.surface.height = height
    }
    return this.surface
  }
}
