import { type Comp, evaluateProperty, type Layer, propertiesOf, type Vec3, type WorldObject } from '@uve/core'
import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  EdgesGeometry,
  Group,
  LinearSRGBColorSpace,
  Line,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  type OrthographicCamera,
  PlaneGeometry,
  type PerspectiveCamera,
  Points,
  PointsMaterial,
  Scene,
  ShaderMaterial,
  type WebGLRenderer,
} from 'three'
import type { OrbitRenderOptions } from '../orbit'
import type { WorldFrame } from './frame'
import {
  boxEdges,
  GRID_AXIS_ALPHA,
  GRID_MAJOR_ALPHA,
  GRID_MINOR_FACTOR,
  GRID_X_COLOR,
  GRID_Y_COLOR,
  gridReach,
  gridSpacing,
  gizmoOf,
  rigid,
  type Segment,
  SELECT_OTHER,
  SELECT_PRIMARY,
  WIRE_COLOR,
} from './gizmos'
import { type OrbitPath, pathOf } from './orbitPath'
import type { View } from './stage'
import { WORLD_UNIT } from './threeCamera'

// What the orbit view draws besides the world: the ground grid, camera,
// light and controller gizmos, the selection's outline and the 3D motion
// path of the selected layers. They live in a scene of their own (a root
// scaled like the world's, so everything here is in world px) that is drawn
// over the world's picture in a second pass: they never reach the bloom, the
// ambient occlusion or an export. Shapes come from gizmos.ts and orbitPath.ts.

const GRID_VERTEX = /* glsl */ `
uniform vec2 uCenter;
uniform float uSize;
varying vec2 vPos;
void main() {
  vPos = uCenter + position.xy * uSize;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`

/**
 * Lines of a grid over the plane z = 0 in world px: a thin line wherever a
 * coordinate is a multiple of the spacing, faded out where lines come closer
 * than a few screen px (they would shimmer), the two axes drawn over them,
 * and the whole grid faded out with the distance from `uFadeCenter`.
 * The colours are written as they are (the canvas takes them raw).
 */
const GRID_FRAGMENT = /* glsl */ `
uniform float uMinor;
uniform float uMajor;
uniform vec2 uFadeCenter;
uniform float uFadeStart;
uniform float uFadeEnd;
uniform float uMajorAlpha;
uniform float uMinorFactor;
uniform float uAxisAlpha;
uniform vec3 uLine;
uniform vec3 uXColor;
uniform vec3 uYColor;
varying vec2 vPos;

float lines(vec2 p, float spacing, out float onScreen) {
  vec2 w = fwidth(p);
  vec2 g = abs(fract(p / spacing - 0.5) - 0.5) / max(w / spacing, vec2(1e-6));
  onScreen = spacing / max(max(w.x, w.y), 1e-6);
  return 1.0 - min(min(g.x, g.y), 1.0);
}

void main() {
  float onMinor;
  float onMajor;
  float minor = lines(vPos, uMinor, onMinor) * smoothstep(3.0, 8.0, onMinor);
  float major = lines(vPos, uMajor, onMajor) * smoothstep(3.0, 8.0, onMajor);
  float a = max(minor * uMajorAlpha * uMinorFactor, major * uMajorAlpha);
  vec3 colour = uLine;
  vec2 w = fwidth(vPos);
  float alongX = (1.0 - min(abs(vPos.y) / max(w.y, 1e-6), 1.0)) * uAxisAlpha;
  float alongY = (1.0 - min(abs(vPos.x) / max(w.x, 1e-6), 1.0)) * uAxisAlpha;
  if (alongX > a) { a = alongX; colour = uXColor; }
  if (alongY > a) { a = alongY; colour = uYColor; }
  a *= 1.0 - smoothstep(uFadeStart, uFadeEnd, distance(vPos, uFadeCenter));
  if (a < 0.004) discard;
  gl_FragColor = vec4(colour, a);
}`

/** A colour written to the canvas as given (no sRGB conversion): for the grid shader. */
const raw = (hex: string): Color => new Color().setHex(Number.parseInt(hex.slice(1, 7), 16), LinearSRGBColorSpace)

function makeGrid(): Mesh<PlaneGeometry, ShaderMaterial> {
  const material = new ShaderMaterial({
    uniforms: {
      uCenter: { value: [0, 0] },
      uSize: { value: 1 },
      uMinor: { value: 10 },
      uMajor: { value: 100 },
      uFadeCenter: { value: [0, 0] },
      uFadeStart: { value: 1 },
      uFadeEnd: { value: 2 },
      uMajorAlpha: { value: GRID_MAJOR_ALPHA },
      uMinorFactor: { value: GRID_MINOR_FACTOR },
      uAxisAlpha: { value: GRID_AXIS_ALPHA },
      uLine: { value: raw('#ffffff') },
      uXColor: { value: raw(GRID_X_COLOR) },
      uYColor: { value: raw(GRID_Y_COLOR) },
    },
    vertexShader: GRID_VERTEX,
    fragmentShader: GRID_FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: DoubleSide,
    // Pushed back a little so a mesh lying on the floor is not striped by it.
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 4,
    toneMapped: false,
    fog: false,
  })
  const mesh = new Mesh(new PlaneGeometry(1, 1), material)
  mesh.frustumCulled = false
  mesh.renderOrder = -1
  return mesh
}

type Tone = 'wire' | 'primary' | 'other'

/** The line materials: depth-tested (gizmos, mesh edges) and drawn over everything (outlines of pictures and boxes). */
function lineMaterial(color: string, overlay: boolean, opacity = 1): LineBasicMaterial {
  return new LineBasicMaterial({ color, transparent: opacity < 1 || overlay, opacity, depthTest: !overlay, depthWrite: !overlay, toneMapped: false, fog: false })
}

/** Line segments whose buffer is rewritten each frame: it grows when it must and draws only what was set. */
class DynamicLines {
  readonly line: LineSegments
  private capacity = 0
  private geometry = new BufferGeometry()

  constructor(material: LineBasicMaterial, order: number) {
    this.line = new LineSegments(this.geometry, material)
    this.line.frustumCulled = false
    this.line.renderOrder = order
    this.line.visible = false
  }

  set(segments: readonly Segment[]): void {
    if (segments.length === 0) {
      this.line.visible = false
      return
    }
    if (segments.length * 6 > this.capacity) {
      this.geometry.dispose()
      this.capacity = Math.max(64, segments.length * 12)
      this.geometry = new BufferGeometry()
      this.geometry.setAttribute('position', new BufferAttribute(new Float32Array(this.capacity), 3))
      this.line.geometry = this.geometry
    }
    const position = this.geometry.getAttribute('position') as BufferAttribute
    const data = position.array as Float32Array
    segments.forEach(([a, b], i) => data.set([a[0], a[1], a[2], b[0], b[1], b[2]], i * 6))
    position.needsUpdate = true
    this.geometry.setDrawRange(0, segments.length * 2)
    this.line.visible = true
  }

  dispose(): void {
    this.geometry.dispose()
  }
}

/** The geometry of a list of segments. */
function geometryOf(segments: readonly Segment[]): BufferGeometry {
  const data = new Float32Array(segments.length * 6)
  segments.forEach(([a, b], i) => data.set([a[0], a[1], a[2], b[0], b[1], b[2]], i * 6))
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(data, 3))
  return geometry
}

interface GizmoEntry {
  key: string
  line: LineSegments
}

interface EdgesEntry {
  source: BufferGeometry
  edges: EdgesGeometry
  line: LineSegments
}

interface PathEntry {
  path: OrbitPath
  line: Line
  keys: Points
}

/** What a sync needs to know. */
export interface HelperInput {
  comp: Comp
  /** The orbit frame (its camera is the orbit camera). */
  frame: WorldFrame
  /** Comp time as the world's objects are read (a static comp's still moment). */
  timeMs: number
  objects: readonly WorldObject[]
  options: OrbitRenderOptions
  /** The orbit view's three.js scene, for the meshes' edges and models' boxes; absent before the first draw. */
  view: View | undefined
}

const edgesOf = (source: BufferGeometry): EdgesGeometry => new EdgesGeometry(source, 30)

/** The orbit view's helper objects for one world. */
export class OrbitHelpers {
  readonly scene = new Scene()
  private readonly root = new Group()
  private readonly grid = makeGrid()
  private readonly materials: { depth: Record<Tone, LineBasicMaterial>; overlay: Record<'primary' | 'other', LineBasicMaterial>; path: LineBasicMaterial; keys: PointsMaterial }
  private readonly outlines: { primary: DynamicLines; other: DynamicLines }
  private readonly gizmos = new Map<string, GizmoEntry>()
  private readonly edges = new Map<string, EdgesEntry>()
  private readonly paths = new Map<string, PathEntry>()
  private wire = WIRE_COLOR

  constructor() {
    this.root.scale.setScalar(WORLD_UNIT)
    this.scene.add(this.root)
    this.root.add(this.grid)
    this.materials = {
      depth: { wire: lineMaterial(WIRE_COLOR, false), primary: lineMaterial(SELECT_PRIMARY, false), other: lineMaterial(SELECT_OTHER, false) },
      overlay: { primary: lineMaterial(SELECT_PRIMARY, true), other: lineMaterial(SELECT_OTHER, true) },
      path: lineMaterial(WIRE_COLOR, true, 0.85),
      keys: new PointsMaterial({ color: SELECT_PRIMARY, size: 7, sizeAttenuation: false, depthTest: false, depthWrite: false, toneMapped: false, fog: false }),
    }
    this.outlines = { primary: new DynamicLines(this.materials.overlay.primary, 3), other: new DynamicLines(this.materials.overlay.other, 3) }
    this.root.add(this.outlines.primary.line, this.outlines.other.line)
  }

  /** Brings every helper to the frame, the selection and the options. */
  sync(input: HelperInput): void {
    const { options } = input
    if ((options.wireColor ?? WIRE_COLOR) !== this.wire) {
      this.wire = options.wireColor ?? WIRE_COLOR
      this.materials.depth.wire.color.set(this.wire)
      this.materials.path.color.set(this.wire)
    }
    this.syncGrid(options)
    const toneOf = (id: string): Tone => {
      const at = options.selectedIds.indexOf(id)
      return at < 0 ? 'wire' : at === 0 ? 'primary' : 'other'
    }
    this.syncGizmos(input, toneOf)
    this.syncSelection(input, toneOf)
    this.syncPaths(input)
    this.root.updateMatrixWorld(true)
  }

  private syncGrid(options: OrbitRenderOptions): void {
    const { grid, view } = options
    this.grid.visible = grid.show
    if (!grid.show) return
    const { minor, major } = gridSpacing(grid)
    const reach = gridReach(view.distance)
    const u = this.grid.material.uniforms
    u.uMinor!.value = minor
    u.uMajor!.value = major
    // The grid is a square as wide as it fades, centred under the target, so it never ends inside the view.
    const size = reach.end * 2
    this.grid.position.set(view.target[0], view.target[1], 0)
    this.grid.scale.set(size, size, 1)
    this.grid.updateMatrix()
    u.uSize!.value = size
    u.uCenter!.value = [view.target[0], view.target[1]]
    u.uFadeCenter!.value = [view.target[0], view.target[1]]
    u.uFadeStart!.value = reach.start
    u.uFadeEnd!.value = reach.end
  }

  private syncGizmos(input: HelperInput, toneOf: (id: string) => Tone): void {
    const { comp, objects, timeMs } = input
    const seen = new Set<string>()
    for (const object of objects) {
      const layer = object.layer
      const key = gizmoKey(layer, comp, timeMs)
      if (!key) continue
      seen.add(layer.id)
      let entry = this.gizmos.get(layer.id)
      if (!entry || entry.key !== key) {
        if (entry) this.dropGizmo(layer.id, entry)
        const segments = gizmoOf(sampled(layer, timeMs), comp) ?? []
        const line = new LineSegments(geometryOf(segments), this.materials.depth.wire)
        line.matrixAutoUpdate = false
        line.frustumCulled = false
        this.root.add(line)
        entry = { key, line }
        this.gizmos.set(layer.id, entry)
      }
      entry.line.material = this.materials.depth[toneOf(layer.id)]
      entry.line.matrix.fromArray(rigid(object.matrix))
      entry.line.matrixWorldNeedsUpdate = true
    }
    for (const [id, entry] of this.gizmos) {
      if (!seen.has(id)) this.dropGizmo(id, entry)
    }
  }

  private dropGizmo(id: string, entry: GizmoEntry): void {
    this.root.remove(entry.line)
    entry.line.geometry.dispose()
    this.gizmos.delete(id)
  }

  /** Outlines of the selected pictures and models (drawn over everything), and the crease edges of selected meshes (depth-tested). */
  private syncSelection(input: HelperInput, toneOf: (id: string) => Tone): void {
    const { frame, view, options } = input
    const overlay: Record<'primary' | 'other', Segment[]> = { primary: [], other: [] }
    const seen = new Set<string>()
    for (const id of options.selectedIds) {
      const tone = toneOf(id)
      if (tone === 'wire') continue
      const plane = frame.planes.find((p) => p.id === id)
      if (plane) {
        const { left, top, width, height } = plane.local
        const corner = (x: number, y: number): Vec3 => {
          const m = plane.matrix
          return [(m[0] as number) * x + (m[4] as number) * y + (m[12] as number), (m[1] as number) * x + (m[5] as number) * y + (m[13] as number), (m[2] as number) * x + (m[6] as number) * y + (m[14] as number)]
        }
        const ring = [corner(left, top), corner(left + width, top), corner(left + width, top + height), corner(left, top + height)]
        overlay[tone].push(...ring.map((p, i) => [p, ring[(i + 1) % 4] as Vec3] as const))
        continue
      }
      const item = frame.meshes.find((m) => m.id === id)
      if (!item || !view) continue
      const model = view.models.get(id)
      if (model) {
        const box = new Box3().setFromObject(model.instance.group)
        if (!box.isEmpty()) {
          const k = 1 / WORLD_UNIT
          overlay[tone].push(...boxEdges([box.min.x * k, box.min.y * k, box.min.z * k], [box.max.x * k, box.max.y * k, box.max.z * k]))
        }
        continue
      }
      const entry = view.meshes.get(id)
      if (!entry) continue
      seen.add(id)
      let edges = this.edges.get(id)
      if (!edges || edges.source !== entry.mesh.geometry) {
        if (edges) this.dropEdges(id, edges)
        const geometry = edgesOf(entry.mesh.geometry)
        const line = new LineSegments(geometry, this.materials.depth.wire)
        line.matrixAutoUpdate = false
        line.frustumCulled = false
        this.root.add(line)
        edges = { source: entry.mesh.geometry, edges: geometry, line }
        this.edges.set(id, edges)
      }
      edges.line.material = this.materials.depth[tone]
      edges.line.matrix.fromArray(item.matrix)
      edges.line.matrixWorldNeedsUpdate = true
    }
    for (const [id, edges] of this.edges) {
      if (!seen.has(id)) this.dropEdges(id, edges)
    }
    this.outlines.primary.set(overlay.primary)
    this.outlines.other.set(overlay.other)
  }

  private dropEdges(id: string, entry: EdgesEntry): void {
    this.root.remove(entry.line)
    entry.edges.dispose()
    this.edges.delete(id)
  }

  /** The selected layers' motion paths, rebuilt only when the comp (a new object per change) or the selection changes. */
  private syncPaths(input: HelperInput): void {
    const { comp, options } = input
    const wanted = new Set<string>()
    if (options.motionPaths) {
      for (const id of options.selectedIds) {
        const path = pathOf(comp, id)
        if (!path) continue
        wanted.add(id)
        let entry = this.paths.get(id)
        if (entry && entry.path !== path) {
          this.dropPath(id, entry)
          entry = undefined
        }
        if (!entry) {
          const line = new Line(pointsGeometry(path.points), this.materials.path)
          line.frustumCulled = false
          line.renderOrder = 4
          const keys = new Points(pointsGeometry(path.keys), this.materials.keys)
          keys.frustumCulled = false
          keys.renderOrder = 5
          this.root.add(line, keys)
          this.paths.set(id, { path, line, keys })
        }
      }
    }
    for (const [id, entry] of this.paths) {
      if (!wanted.has(id)) this.dropPath(id, entry)
    }
  }

  private dropPath(id: string, entry: PathEntry): void {
    this.root.remove(entry.line, entry.keys)
    entry.line.geometry.dispose()
    entry.keys.geometry.dispose()
    this.paths.delete(id)
  }

  /** Draws the helpers over what is on the canvas; `depthKept` says whether the canvas still holds the world's depth (the helpers hide behind it). */
  draw(gl: WebGLRenderer, camera: PerspectiveCamera | OrthographicCamera, depthKept: boolean): void {
    const autoClear = gl.autoClear
    gl.autoClear = false
    gl.setRenderTarget(null)
    // With no depth from the world, a stale depth buffer must not hide them.
    if (!depthKept) gl.clearDepth()
    gl.render(this.scene, camera)
    gl.autoClear = autoClear
  }

  dispose(): void {
    for (const [id, entry] of this.gizmos) this.dropGizmo(id, entry)
    for (const [id, entry] of this.edges) this.dropEdges(id, entry)
    for (const [id, entry] of this.paths) this.dropPath(id, entry)
    this.outlines.primary.dispose()
    this.outlines.other.dispose()
    this.grid.geometry.dispose()
    this.grid.material.dispose()
    for (const m of [...Object.values(this.materials.depth), ...Object.values(this.materials.overlay), this.materials.path, this.materials.keys]) m.dispose()
  }
}

function pointsGeometry(points: readonly Vec3[]): BufferGeometry {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(points.flat()), 3))
  return geometry
}

/** A layer with its keyed lens sampled at a comp time, so a camera's frustum follows its focal length. */
function sampled(layer: Layer, timeMs: number): Layer {
  if (layer.kind !== 'camera') return layer
  const spec = propertiesOf(layer).find((s) => s.path === 'camera.focalLength')
  const value = spec ? evaluateProperty(layer, spec, timeMs - layer.startMs) : undefined
  return typeof value === 'number' && Number.isFinite(value) ? { ...layer, camera: { ...layer.camera, focalLength: Math.min(5000, Math.max(1, value)) } } : layer
}

/** What a gizmo's shape depends on, as a string; null for layers that have none. */
export function gizmoKey(layer: Layer, comp: Pick<Comp, 'width' | 'height'>, timeMs: number): string | null {
  switch (layer.kind) {
    case 'camera': {
      const { projection, focalLength, sensorWidth, orthoScale } = (sampled(layer, timeMs) as Layer & { kind: 'camera' }).camera
      return ['camera', projection, focalLength, sensorWidth, orthoScale, comp.width, comp.height].join('|')
    }
    case 'light':
      return ['light', layer.light.type, layer.light.spotAngle, layer.light.width, layer.light.height].join('|')
    case 'empty':
      return ['empty', layer.empty.display, layer.empty.size].join('|')
    default:
      return null
  }
}
