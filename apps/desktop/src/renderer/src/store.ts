import {
  type CallFn,
  type CommandResult,
  type Comp,
  createDefaultProject,
  isSpatialKind,
  isWorld,
  type Layer,
  nestedTime,
  parseSvgPath,
  type Project,
  Session,
  svgPathBounds,
  activeWorkRange,
  clampWorkRange,
  MIN_WORK_RANGE_MS,
  type WorkRange,
  workRangeSpan,
} from '@uve/core'
import { CompRenderer, type MotionHit, type OrbitShading, type OrbitView, physicsMeasuresChanged } from '@uve/engine'
import { create } from 'zustand'
import type { AgentStatus } from '../../shared/agent'
import { type ChatItem, type OpenCodeStatus, initialOpenCodeStatus } from '../../shared/opencode'
import type { RecentProject } from '../../shared/project'
import type { RenderResult } from './export/render'
import { envelopeOfMedia } from './media/envelope'
import { silhouetteOfMedia } from './media/silhouette'
import { type LeftTab, MODE_TABS, readUiMode, tabForMode, UI_MODE_KEY, type UiMode } from './uiMode'

/**
 * The open project. Every edit goes through `session.call`: the same command
 * API that agents will use, so the UI and agents can never drift apart.
 */
export const session = new Session({ project: createDefaultProject() })

// Commands that bake a layout, or infer one, measure layers the way the picture draws them.
const measurer = new CompRenderer()
session.measure = (comp, timeMs) => measurer.placements(comp, session.project, timeMs)
// physics.body traces pictures imported before silhouettes were kept.
session.silhouette = silhouetteOfMedia
// character.bringToLife reads a voice's loudness for talk and nod.
session.envelope = envelopeOfMedia
// Text bodies are measured again once their fonts have loaded.
document.fonts.addEventListener('loadingdone', physicsMeasuresChanged)

/** An export running or just finished, shown in the export dialog. */
export interface ExportJob {
  fileName: string
  path: string
  status: 'rendering' | 'done' | 'failed'
  /** Frames rendered so far, of `frameCount` (seconds mixed, for a sound-only file). */
  frame: number
  /** A file with no picture: progress counts seconds. */
  soundOnly?: boolean
  frameCount: number
  /** Date.now() when the export started and when it ended. */
  startedAt: number
  finishedAt: number | null
  /** Size of the file written so far. */
  bytes: number
  error: string | null
  /** Something the user should know about a finished export, such as clipped sound. */
  note: string | null
  /** What a finished export wrote: size, frame rate, codecs and bitrates. */
  result?: RenderResult
}

/** A short message shown in the corner, such as the result of an import. */
export interface Notice {
  id: number
  text: string
  tone: 'info' | 'error'
}

interface EditorState {
  project: Project
  /** The session's change count (see `Session.revision`). */
  revision: number
  /** The revision at the last save or open; any other value means unsaved changes. */
  savedRevision: number
  /** The project file, or null before the first save. */
  projectPath: string | null
  /** Recent projects for the main menu, newest first. */
  recentProjects: RecentProject[]
  canUndo: boolean
  canRedo: boolean
  undoLabel: string | undefined
  redoLabel: string | undefined
  activeCompId: string
  /** The nested layers entered to reach the open comp, outermost first (see `enterNested`). */
  compTrail: TrailStep[]
  selectedLayerId: string | null
  /** The path being drawn with the Pen, or null. */
  pen: PenDraft | null
  /** Layers selected with the main one (Shift-click), for commands on several such as grouping. */
  alsoSelected: string[]
  /** Playhead position in comp time. */
  timeMs: number
  playing: boolean
  notice: Notice | null
  /** Library thumbnails (object URLs), by media file path. */
  thumbnails: Record<string, string>
  /** Timeline zoom. */
  pxPerSecond: number
  /** What a timeline drag would do, drawn while it runs. */
  guide: TimelineGuide | null
  /** The export in progress or just finished; the editor waits while one runs. */
  exportJob: ExportJob | null
  /** Whether the export settings dialog is open (it comes before the save dialog). */
  exportSetupOpen: boolean
  /** Easy (the chat, the preview, a simple timeline, export) or Advanced (every panel); remembered across launches. */
  uiMode: UiMode
  /** What the left panel shows, picked in the rail. */
  leftTab: LeftTab
  /** The plugin window open over the editor (icons, fonts), or null. */
  plugin: PluginId | null
  /** Whether that window is folded to its title bar. */
  pluginFolded: boolean
  /** Whether the inspector panel is open. */
  inspectorOpen: boolean
  /** What the inspector shows for a layer: its design, or its entrances and exits. */
  rightTab: RightTab
  /** The viewport tool. Creation tools go back to Move after placing one layer. */
  tool: Tool
  /** Viewport zoom: screen pixels per comp pixel, or null to fit the comp in the panel. */
  viewZoom: number | null
  /** Viewport pan from the centre, in screen pixels. */
  viewPan: { x: number; y: number }
  /** The working range (a span of one comp that playback and export are limited to); editor state, not saved. */
  workRange: WorkRange | null
  /** Whether the working range is in force (see `activeWorkRange`). */
  workRangeEnabled: boolean
  /** Whether timeline drags snap to edges, the playhead and keys (Alt turns it off for one drag). */
  snapping: boolean
  /** Whether the selected layers' motion paths are drawn on the viewport (View menu); remembered across launches. */
  motionPaths: boolean
  /** How each world comp is looked at in the viewport, by comp id (see `worldViewOf`); editor state, not saved or undoable. */
  worldView: Record<string, WorldViewState>
  /** The part of a motion path under the pointer, or null. */
  motionHover: { layerId: string; hit: MotionHit } | null
  /** The context menu of a motion point (right-click on its diamond): where it opens, in client px, and which point. */
  motionMenu: { x: number; y: number; layerId: string; atMs: number } | null
  /** What the timeline panel shows. */
  bottomView: BottomView
  /** Record keyframes: every edit of an animatable property keys it at the playhead. */
  recordKeys: boolean
  /** Playback starts again from the beginning at the end. */
  loop: boolean
  /** Property paths whose curves are hidden in the Curves view. */
  hiddenCurves: Record<string, boolean>
  /** The key picked in the Keyframes or Curves view. */
  selectedKey: SelectedKey | null
  /** The agent server's address, token and connected sessions, or null before the first answer. */
  agentStatus: AgentStatus | null
  /** Agents' recent tool calls, newest first. */
  agentLog: AgentLogEntry[]
  /** OpenCode's state in the app's own chat (running, model, key, usage). */
  opencodeStatus: OpenCodeStatus
  /** The OpenCode chat transcript, oldest first. */
  chat: ChatItem[]
  /** Selects a layer; `additive` (Shift-click) adds it to or takes it out of the selection instead. */
  select: (id: string | null, additive?: boolean) => void
  /** Shows or hides the motion paths, and remembers the choice. */
  setMotionPaths: (on: boolean) => void
  /** Switches between Easy and Advanced, and remembers the choice; the left panel moves to a tab the mode has. */
  setUiMode: (mode: UiMode) => void
  /** Changes how a world comp is looked at (the orbit view, its shading and grid). */
  setWorldView: (compId: string, patch: Partial<WorldViewState>) => void
  /** Switches a world comp between looking through its camera and the orbit view; a flat comp has none. */
  toggleOrbit: (compId: string) => void
  seek: (ms: number) => void
  togglePlay: () => void
  notify: (text: string, tone?: Notice['tone']) => void
  setZoom: (pxPerSecond: number) => void
  setGuide: (guide: TimelineGuide | null) => void
  setView: (zoom: number | null, pan?: { x: number; y: number }) => void
  /** Sets the working range, clamped to its comp's duration; null forgets it. */
  setWorkRange: (range: WorkRange | null) => void
  /** Turns the working range on or off; on with none for the open comp seeds the whole comp. */
  setWorkRangeEnabled: (on: boolean) => void
  /**
   * Sets one end of the open comp's working range at `ms` (the playhead for the in and out
   * shortcuts) and turns the range on. An end set within 50 ms of where it is goes back to
   * the comp's start or end.
   */
  setWorkRangeEdge: (edge: 'start' | 'end', ms: number) => void
}

export type RightTab = 'design' | 'effects' | 'animate' | 'sound'

export type { LeftTab, UiMode } from './uiMode'
export { MODE_TABS } from './uiMode'

/** The plugins that open a window of their own. */
export type PluginId = 'icons' | 'fonts'

/** One tool call by an agent, for the Agents panel. */
export interface AgentLogEntry {
  at: number
  client: string
  tool: string
  ok: boolean
  /** How long the call took. */
  ms: number
}
export type BottomView = 'timeline' | 'keyframes' | 'curves' | 'color' | 'nodes'
/** A key, by its layer, property path and time relative to the layer start. */
export interface SelectedKey {
  layerId: string
  path: string
  t: number
}
export type Tool = 'move' | 'hand' | 'text' | 'rect' | 'ellipse' | 'pen'

/** How the viewport looks at a world: through its live camera, or from a free orbit view that never touches the document. */
export interface WorldViewState {
  /** Looking from the orbit view instead of the live camera. */
  orbit: boolean
  /** Where the orbit view looks from; null until the first time it is opened (then everything is framed). */
  view: OrbitView | null
  shading: OrbitShading
  showGrid: boolean
  /** The ground grid: its size in px and how many cells it has across. */
  gridSize: number
  gridDivisions: number
}

/** What a world comp is looked at with before anything is changed. One shared object, so selectors on it stay stable. */
export const DEFAULT_WORLD_VIEW: WorldViewState = { orbit: false, view: null, shading: 'solid', showGrid: true, gridSize: 100, gridDivisions: 10 }

/** The view state of a comp: the defaults when it has none yet. */
export function worldViewOf(state: Pick<EditorState, 'worldView'>, compId: string): WorldViewState {
  return state.worldView[compId] ?? DEFAULT_WORLD_VIEW
}

/** A point of a path being drawn with the Pen, comp space; `out` is the handle dragged from it (the curve leaving it). */
export interface PenPoint {
  x: number
  y: number
  out?: { x: number; y: number }
}

/** The path the Pen is drawing: its points so far, and where the pointer is (for the next segment). */
export interface PenDraft {
  points: PenPoint[]
  hover: { x: number; y: number } | null
}

/** Feedback for a timeline drag: the time an edge snapped to, and the track it would land on. */
export interface TimelineGuide {
  snapMs: number | null
  trackIndex: number | null
  /** A new track would be made in front of all others, or behind them. */
  newTrack: 'front' | 'back' | null
}

export const MIN_PX_PER_SECOND = 10
export const MAX_PX_PER_SECOND = 1000
export const MIN_VIEW_ZOOM = 0.02
export const MAX_VIEW_ZOOM = 16
const NOTICE_MS = 4000
let lastNoticeId = 0

const fromSession = () => ({
  project: session.project,
  revision: session.revision,
  canUndo: session.canUndo,
  canRedo: session.canRedo,
  undoLabel: session.undoLabel,
  redoLabel: session.redoLabel,
})

function activeComp(state: Pick<EditorState, 'project' | 'activeCompId'>): Comp {
  return (state.project.comps.find((c) => c.id === state.activeCompId) ?? state.project.comps[0]) as Comp
}

const MOTION_PATHS_KEY = 'uve.motionPaths'

/** Motion paths are on unless the user turned them off. */
function readMotionPaths(): boolean {
  try {
    return localStorage.getItem(MOTION_PATHS_KEY) !== '0'
  } catch {
    return true
  }
}

const initialUiMode = readUiMode()

export const useEditor = create<EditorState>()((set, get) => ({
  ...fromSession(),
  savedRevision: session.revision,
  projectPath: null,
  recentProjects: [],
  activeCompId: session.project.comps[0]?.id ?? '',
  compTrail: [],
  selectedLayerId: null,
  alsoSelected: [],
  pen: null,
  timeMs: 0,
  playing: false,
  notice: null,
  thumbnails: {},
  pxPerSecond: 80,
  guide: null,
  exportJob: null,
  exportSetupOpen: false,
  uiMode: initialUiMode,
  leftTab: MODE_TABS[initialUiMode][0] as LeftTab,
  plugin: null,
  pluginFolded: false,
  inspectorOpen: true,
  rightTab: 'design',
  tool: 'move',
  viewZoom: null,
  viewPan: { x: 0, y: 0 },
  workRange: null,
  workRangeEnabled: false,
  snapping: true,
  motionPaths: readMotionPaths(),
  worldView: {},
  motionHover: null,
  motionMenu: null,
  bottomView: 'timeline',
  recordKeys: false,
  loop: false,
  hiddenCurves: {},
  selectedKey: null,
  agentStatus: null,
  agentLog: [],
  opencodeStatus: initialOpenCodeStatus(),
  chat: [],
  select: (id, additive = false) =>
    set((s) => {
      if (!additive || id === null || s.selectedLayerId === null) return { selectedLayerId: id, alsoSelected: [], selectedKey: null }
      if (id === s.selectedLayerId) {
        const [next = null, ...rest] = s.alsoSelected
        return { selectedLayerId: next, alsoSelected: rest }
      }
      const also = s.alsoSelected.includes(id) ? s.alsoSelected.filter((x) => x !== id) : [...s.alsoSelected, id]
      return { alsoSelected: also }
    }),
  setMotionPaths: (on) => {
    try {
      localStorage.setItem(MOTION_PATHS_KEY, on ? '1' : '0')
    } catch {
      // Storage can be blocked; the choice then lasts for this session only.
    }
    set({ motionPaths: on, ...(on ? {} : { motionHover: null }) })
  },
  setUiMode: (mode) => {
    try {
      localStorage.setItem(UI_MODE_KEY, mode)
    } catch {
      // Storage can be blocked; the choice then lasts for this session only.
    }
    // Easy has no key, colour or node views: the timeline comes back.
    set((s) => ({ uiMode: mode, leftTab: tabForMode(mode, s.leftTab), ...(mode === 'easy' ? { bottomView: 'timeline' as const, plugin: null } : {}) }))
  },
  setWorldView: (compId, patch) => set((s) => ({ worldView: { ...s.worldView, [compId]: { ...worldViewOf(s, compId), ...patch } } })),
  toggleOrbit: (compId) => {
    const s = get()
    const comp = s.project.comps.find((c) => c.id === compId)
    if (!comp || !isWorld(comp)) return
    const on = !worldViewOf(s, compId).orbit
    // The orbit view has no 2D gizmos: drop what only the flat view uses.
    set({ worldView: { ...s.worldView, [compId]: { ...worldViewOf(s, compId), orbit: on } }, ...(on ? { motionHover: null, pen: null } : {}) })
  },
  seek: (ms) => {
    const comp = activeComp(get())
    // A static frame shows one moment: the playhead stays on it.
    set({ timeMs: comp.mode === 'static' ? Math.min(comp.stillMs, comp.durationMs) : Math.min(comp.durationMs, Math.max(0, ms)) })
  },
  togglePlay: () => {
    const state = get()
    if (activeComp(state).mode === 'static') {
      state.notify('A static frame is one picture: it has nothing to play.')
      return
    }
    const comp = activeComp(state)
    const span = workRangeSpan(state.workRange, state.workRangeEnabled, comp.id, comp.durationMs)
    // Playing from the very end, or from outside the working range, starts again at its start.
    if (!state.playing && (state.timeMs < span.startMs || state.timeMs >= span.endMs)) set({ timeMs: span.startMs })
    set({ playing: !state.playing })
  },
  notify: (text, tone = 'info') => {
    const id = ++lastNoticeId
    set({ notice: { id, text, tone } })
    setTimeout(() => {
      if (get().notice?.id === id) set({ notice: null })
    }, NOTICE_MS)
  },
  setZoom: (px) => set({ pxPerSecond: Math.min(MAX_PX_PER_SECOND, Math.max(MIN_PX_PER_SECOND, px)) }),
  setGuide: (guide) => set({ guide }),
  setView: (zoom, pan) =>
    set({
      viewZoom: zoom === null ? null : Math.min(MAX_VIEW_ZOOM, Math.max(MIN_VIEW_ZOOM, zoom)),
      viewPan: zoom === null ? { x: 0, y: 0 } : (pan ?? get().viewPan),
    }),
  setWorkRange: (range) => {
    if (range === null) return set({ workRange: null })
    const comp = get().project.comps.find((c) => c.id === range.compId)
    set({ workRange: comp ? clampWorkRange(range, comp.durationMs) : null })
  },
  setWorkRangeEnabled: (on) => {
    if (!on) return set({ workRangeEnabled: false })
    const state = get()
    const comp = activeComp(state)
    const seeded = state.workRange?.compId === comp.id ? state.workRange : { compId: comp.id, startMs: 0, endMs: comp.durationMs }
    set({ workRange: clampWorkRange(seeded, comp.durationMs), workRangeEnabled: true })
  },
  setWorkRangeEdge: (edge, ms) => {
    const state = get()
    const comp = activeComp(state)
    const range = state.workRange?.compId === comp.id ? { ...state.workRange } : { compId: comp.id, startMs: 0, endMs: comp.durationMs }
    const at = Math.max(0, Math.round(ms))
    if (edge === 'start') range.startMs = Math.abs(range.startMs - at) < 50 ? 0 : Math.min(at, range.endMs - MIN_WORK_RANGE_MS)
    else range.endMs = Math.abs(range.endMs - at) < 50 ? comp.durationMs : Math.max(at, range.startMs + MIN_WORK_RANGE_MS)
    set({ workRange: clampWorkRange(range, comp.durationMs), workRangeEnabled: true })
  },
}))

export function findLayer(project: Project, id: string): Layer | undefined {
  for (const comp of project.comps) {
    for (const track of comp.tracks) {
      const layer = track.layers.find((l) => l.id === id)
      if (layer) return layer
    }
  }
  return undefined
}

// Commands read where the user is: the playhead and the open comp default omitted times and comps.
session.view = () => {
  const { timeMs, activeCompId, workRange, workRangeEnabled } = useEditor.getState()
  const active = activeWorkRange(workRange, workRangeEnabled, activeCompId)
  return { playheadMs: timeMs, compId: activeCompId, ...(active ? { workRange: active } : {}) }
}

session.subscribe(() => {
  const next = fromSession()
  const { selectedLayerId, alsoSelected, activeCompId, timeMs, playing } = useEditor.getState()
  const keep = selectedLayerId !== null && findLayer(next.project, selectedLayerId) !== undefined
  const also = alsoSelected.filter((id) => findLayer(next.project, id) !== undefined)
  // The open frame may be gone (deleted); fall back to the first one.
  const open = next.project.comps.find((c) => c.id === activeCompId)
  const fallback = open ?? (next.project.comps.find((c) => !c.embedded) ?? next.project.comps[0])
  const view =
    fallback && fallback.id !== activeCompId
      ? { activeCompId: fallback.id, compTrail: NO_TRAIL, timeMs: fallback.mode === 'static' ? fallback.stillMs : 0, playing: false, pen: null }
      : fallback?.mode === 'static' && timeMs !== fallback.stillMs
        ? { timeMs: fallback.stillMs, playing: false }
        : playing && fallback?.mode === 'static'
          ? { playing: false }
          : {}
  const stale = fallback !== undefined && fallback.id !== activeCompId
  useEditor.setState({ ...next, ...view, selectedLayerId: keep && !stale ? selectedLayerId : null, alsoSelected: keep && !stale ? also : [] })
})

/** Opens a frame (a comp of a page) in the editor: a static one with the playhead on its still. */
export function openFrame(id: string): void {
  const { project } = useEditor.getState()
  const comp = project.comps.find((c) => c.id === id)
  if (!comp || comp.embedded) return
  useEditor.setState({
    activeCompId: comp.id,
    compTrail: NO_TRAIL,
    selectedLayerId: null,
    alsoSelected: [],
    selectedKey: null,
    pen: null,
    playing: false,
    timeMs: comp.mode === 'static' ? Math.min(comp.stillMs, comp.durationMs) : 0,
  })
}

/** Every selected layer: the main one first. */
export function selectionIds(): string[] {
  const { selectedLayerId, alsoSelected } = useEditor.getState()
  return selectedLayerId === null ? [] : [selectedLayerId, ...alsoSelected]
}

/** SVG path data for Pen points: lines between plain points, curves where a handle was dragged (mirrored on the way in). */
export function penPathData(points: readonly PenPoint[], closed: boolean): string {
  const first = points[0]
  if (!first) return ''
  const r = (n: number) => Math.round(n * 100) / 100
  const handleIn = (p: PenPoint) => (p.out ? { x: 2 * p.x - p.out.x, y: 2 * p.y - p.out.y } : p)
  const segment = (a: PenPoint, b: PenPoint) => {
    if (!a.out && !b.out) return `L${r(b.x)} ${r(b.y)}`
    const c1 = a.out ?? a
    const c2 = handleIn(b)
    return `C${r(c1.x)} ${r(c1.y)} ${r(c2.x)} ${r(c2.y)} ${r(b.x)} ${r(b.y)}`
  }
  const parts = [`M${r(first.x)} ${r(first.y)}`]
  for (let i = 1; i < points.length; i++) parts.push(segment(points[i - 1] as PenPoint, points[i] as PenPoint))
  if (closed && points.length > 2) {
    const last = points[points.length - 1] as PenPoint
    if (last.out || first.out) parts.push(segment(last, first))
    parts.push('Z')
  }
  return parts.join(' ')
}

/**
 * Turns the Pen's points into a path layer (closed: filled; open: a line) and
 * selects it. The layer is centred on the path, where it was drawn.
 */
export async function finishPen(closed: boolean): Promise<void> {
  const { pen, timeMs } = useEditor.getState()
  useEditor.setState({ pen: null, tool: 'move' })
  if (!pen || pen.points.length < 2) return
  const d = penPathData(pen.points, closed)
  const result = await run('layer.create', {
    kind: 'path',
    d,
    startMs: Math.round(timeMs),
    ...(closed ? { fill: '#7c5cff' } : {}),
  })
  if (!result.ok) return
  const { id } = result.value as { id: string }
  const layer = findLayer(useEditor.getState().project, id)
  if (layer?.kind === 'path') {
    // Put the drawn outline back where it was drawn: the layer is centred on its box.
    const bounds = svgPathBounds(parseSvgPath(layer.geometry))
    await run('layer.set', { id, values: { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }, mode: 'base' })
  }
  useEditor.getState().select(id)
}

/** Groups the selection (Ctrl+G) and selects the new group. */
export async function groupSelection(): Promise<void> {
  const ids = selectionIds()
  if (ids.length === 0) return
  const result = await run('layers.group', { ids })
  if (result.ok) useEditor.getState().select((result.value as { groupId: string }).groupId)
}

/** Dissolves the selected group, or the group the selected layer is in (Ctrl+Shift+G). */
export async function ungroupSelection(): Promise<void> {
  const ids = selectionIds()
  if (ids.length > 0) await run('layers.ungroup', { ids })
}

/** A nested layer entered from a comp: where to come back to. */
export interface TrailStep {
  compId: string
  layerId: string
  timeMs: number
}

/** The trail to the open comp, or an empty one when the open comp was reached some other way. */
export function currentTrail(state: Pick<EditorState, 'project' | 'activeCompId' | 'compTrail'>): TrailStep[] {
  const last = state.compTrail.at(-1)
  const layer = last ? findLayer(state.project, last.layerId) : undefined
  return layer?.kind === 'nested' && layer.sourceCompId === state.activeCompId ? state.compTrail : NO_TRAIL
}

const NO_TRAIL: TrailStep[] = []

/** Opens a nested layer's comp, at the moment the layer shows at the playhead, to edit what is inside. */
export function enterNested(layerId: string): void {
  const state = useEditor.getState()
  const layer = findLayer(state.project, layerId)
  if (layer?.kind !== 'nested') return
  const source = state.project.comps.find((c) => c.id === layer.sourceCompId)
  if (!source) return
  const inside = nestedTime(layer, source.durationMs, state.timeMs)
  const step = { compId: state.activeCompId, layerId, timeMs: state.timeMs }
  useEditor.setState({
    compTrail: [...currentTrail(state), step],
    activeCompId: source.id,
    timeMs: inside?.timeMs ?? layer.trimInMs,
    selectedLayerId: null,
    alsoSelected: [],
    selectedKey: null,
    playing: false,
    pen: null,
  })
}

/** Goes back out to the comp of trail step `index` (0 the outermost), with the nested layer selected. */
export function leaveNested(index: number): void {
  const state = useEditor.getState()
  const trail = currentTrail(state)
  const step = trail[index]
  if (!step) return
  useEditor.setState({ compTrail: trail.slice(0, index), activeCompId: step.compId, timeMs: step.timeMs, playing: false, pen: null })
  useEditor.getState().select(step.layerId)
}

/** Nests the selection into a comp of its own (precompose) and selects the nested layer. */
export async function nestSelection(): Promise<void> {
  const ids = selectionIds()
  if (ids.length === 0) return
  const result = await run('layers.nest', { ids })
  if (result.ok) useEditor.getState().select((result.value as { id: string }).id)
}

/** Makes a 3D world the size of the open frame and opens it (Main menu, Layers tab). */
export async function newWorld(): Promise<void> {
  const comp = activeComp(useEditor.getState())
  const result = await run('world.create', { width: comp.width, height: comp.height, fps: comp.fps, durationMs: comp.durationMs })
  if (result.ok) openFrame((result.value as { frameId: string }).frameId)
}

/** Whether the selection has 2D layers that can move into a 3D world: the open comp is flat and one selected layer is a picture. */
export function canMoveIntoWorld(): boolean {
  const state = useEditor.getState()
  if (isWorld(activeComp(state))) return false
  return selectionIds().some((id) => {
    const layer = findLayer(state.project, id)
    return layer !== undefined && layer.kind !== 'audio' && !isSpatialKind(layer.kind)
  })
}

/** Moves the selected layers into a new 3D world: the same picture, now with depth. The nested layer stays selected; double-click it to enter the world. */
export async function moveSelectionIntoWorld(): Promise<void> {
  const ids = selectionIds()
  if (ids.length === 0) return
  const result = await run('world.move_into', { ids })
  if (!result.ok) return
  useEditor.getState().select((result.value as { nestedId: string }).nestedId)
  useEditor.getState().notify('In 3D: the same picture, now with depth')
}

/** The lanes the selected layers are on, by id. */
function selectionLanes(): string[] {
  const { project } = useEditor.getState()
  return [...new Set(selectionIds().flatMap((id) => project.comps.flatMap((c) => c.tracks.filter((t) => t.layers.some((l) => l.id === id)).map((t) => t.id))))]
}

/** A layer on each of these lanes (as they are now), to name the lanes to `timeline.close_gaps`. */
function layerOnEachLane(laneIds: readonly string[]): string[] {
  const tracks = session.project.comps.flatMap((c) => c.tracks)
  return laneIds.flatMap((id) => {
    const first = tracks.find((t) => t.id === id)?.layers[0]
    return first ? [first.id] : []
  })
}

/** Closes the gaps on the lanes of the selected layers. */
export async function closeGapsOfSelection(): Promise<void> {
  const ids = layerOnEachLane(selectionLanes())
  if (ids.length === 0) {
    useEditor.getState().notify('Select a layer on the lane to close up.')
    return
  }
  const result = await run('timeline.close_gaps', { ids })
  if (result.ok && (result.value as { lanesClosed: number }).lanesClosed === 0) useEditor.getState().notify('No gaps on this lane.')
}

/** Deletes the selection and closes the gaps it leaves on its lanes (Shift+Delete), as one undo step. */
export async function rippleDeleteSelection(): Promise<void> {
  const ids = selectionIds()
  if (ids.length === 0) return
  const lanes = selectionLanes()
  await session.transact('Ripple delete', async (call) => {
    const deleted = await call('layers.delete', { ids })
    if (!deleted.ok) {
      useEditor.getState().notify(deleted.error, 'error')
      return
    }
    const rest = layerOnEachLane(lanes)
    if (rest.length > 0) await call('timeline.close_gaps', { ids: rest })
  })
}

/** Selects a list of layers: the first is the primary one. */
function selectAll(ids: readonly string[]): void {
  const [first = null, ...rest] = ids
  useEditor.setState({ selectedLayerId: first, alsoSelected: rest, selectedKey: null })
}

/** Duplicates the selection in place (Ctrl+D) and selects the copies. */
export async function duplicateSelection(): Promise<void> {
  const ids = selectionIds()
  if (ids.length === 0) return
  const result = await run('layers.duplicate', { ids })
  if (result.ok) selectAll((result.value as { ids: string[] }).ids)
}

/** The layers on the editor's clipboard (Ctrl+C), by id: pasting copies them as they are then. */
let clipboard: string[] = []

/** Puts the selection on the clipboard (Ctrl+C). */
export function copySelection(): void {
  const ids = selectionIds()
  if (ids.length === 0) return
  clipboard = ids
  useEditor.getState().notify(ids.length === 1 ? 'Copied' : `Copied ${ids.length} layers`, 'info')
}

/** Pastes the clipboard's layers into the open comp at the playhead (Ctrl+V) and selects them. */
export async function pasteClipboard(): Promise<void> {
  const state = useEditor.getState()
  const ids = clipboard.filter((id) => findLayer(state.project, id) !== undefined)
  if (ids.length === 0) return
  const result = await run('layers.copy', { ids, toCompId: activeComp(state).id, atMs: Math.round(state.timeMs) })
  if (result.ok) selectAll((result.value as { ids: string[] }).ids)
}

/** Restacks the selection: to the front or back of its group (Ctrl+Shift+] and Ctrl+Shift+[). */
export async function restackSelection(to: 'front' | 'back'): Promise<void> {
  const ids = selectionIds()
  if (ids.length > 0) await run('layers.restack', { ids, to })
}

/** Runs a command; failures are shown as a notice and logged with the command's hint. */
export async function run(name: string, input?: unknown) {
  const result = await session.call(name, input)
  if (!result.ok) {
    console.warn(`${name} failed: ${result.error}${result.hint ? ` (${result.hint})` : ''}`)
    useEditor.getState().notify(result.error, 'error')
  }
  return result
}

/** A pointer gesture, such as a drag or a scrub, that edits through commands as it goes. */
export interface Gesture {
  /** Applies a command soon. While one runs, only the newest request waits, so fast pointer moves never pile up. */
  request(name: string, input: unknown): void
  /** Runs a command after every earlier one and returns its result. */
  call(name: string, input: unknown): Promise<CommandResult>
  /** Waits for the commands in flight, then closes the gesture's undo step. */
  end(): Promise<void>
}

/**
 * Starts a gesture whose edits show live and become one undo step named
 * `label`. It holds one session transaction open until `end`, so it must
 * always be ended (on pointer up, cancel or lost capture).
 */
export function beginGesture(label: string): Gesture {
  let finish = () => {}
  const finished = new Promise<void>((resolve) => {
    finish = resolve
  })
  let open: (call: CallFn) => void = () => {}
  const opened = new Promise<CallFn>((resolve) => {
    open = resolve
  })
  const closed = session.transact(label, async (call) => {
    open(call)
    await finished
  })
  let queue: Promise<unknown> = opened
  let latest: [name: string, input: unknown] | null = null
  let scheduled = false

  return {
    request(name, input) {
      latest = [name, input]
      if (scheduled) return
      scheduled = true
      queue = queue.then(async () => {
        const call = await opened
        try {
          while (latest) {
            const [next, nextInput] = latest
            latest = null
            await call(next, nextInput)
          }
        } finally {
          scheduled = false
        }
      })
    },
    call(name, input) {
      const result = queue.then(async () => (await opened)(name, input))
      queue = result.catch(() => undefined)
      return result
    },
    async end() {
      await queue
      finish()
      await closed
    },
  }
}

export { activeComp }

export function useActiveComp(): Comp {
  return useEditor(activeComp)
}

export function useSelectedLayer(): Layer | undefined {
  return useEditor((s) => (s.selectedLayerId ? findLayer(s.project, s.selectedLayerId) : undefined))
}

/**
 * The command that edits one animatable property of a layer at the playhead:
 * a key there when the property is animated or Record keyframes is on (the
 * first key goes through keyframes.set, since layer.set only keys animated
 * properties), otherwise a static value.
 */
export function propertyEdit(layer: Layer, alias: string, path: string, value: number | string): [name: string, input: unknown] {
  const { timeMs, recordKeys } = useEditor.getState()
  const animated = (layer.animations[path]?.length ?? 0) > 0
  if (!animated && recordKeys) {
    return ['keyframes.set', { id: layer.id, path: alias, mode: 'merge', keys: [{ t: timeMs - layer.startMs, v: value }] }]
  }
  return ['layer.set', { id: layer.id, values: { [alias]: value }, ...(animated ? { atMs: timeMs } : {}) }]
}
