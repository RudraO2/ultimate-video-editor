import { activeWorkRange, type Comp, formatClock, isWorld, type Layer, transformAt } from '@uve/core'
import { CompRenderer, DEFAULT_ORBIT_VIEW, type OrbitShading, resolveLayer } from '@uve/engine'
import { ChevronDown, Circle, Grid3x3, Hand, type IconComponent, Maximize, Minus, MousePointer2, PenTool, Plus, Square, Type } from '../icons'
import { type DragEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { placeSticker } from '../library/stickers'
import { dragHasFiles, importDrop, MEDIA_DRAG_TYPE, placeMedia, STICKER_DRAG_TYPE } from '../media/import'
import { preview } from '../media/preview'
import { motionDoubleClick, openMotionMenu, startMotionDrag } from './motionGestures'
import { MotionMenu } from './MotionMenu'
import { worldDragAt, worldDragDelta } from './worldDrag'
import { drawMotionPaths, motionHitAt, motionHoverChanged, motionHoverValid, updateMotionPaths } from './motionPaths'
import { drawRigOverlay } from './rigOverlay'
import { pickedBone, rigHitAt, startRigDrag, updateRigOverlay } from './rigPoser'
import { clickSelection, dragModeOf, dragView, firstView, framedView, isClick, orbitKey, wheelView } from './orbitControls'
import { activeComp, beginGesture, currentTrail, enterNested, findLayer, finishPen, leaveNested, MAX_VIEW_ZOOM, MIN_VIEW_ZOOM, type PenPoint, penPathData, propertyEdit, run, selectionIds, type Tool, useActiveComp, useEditor, worldViewOf } from '../store'
import { cssColor } from '../theme'

const renderer = new CompRenderer()

/** Never render the preview above twice the comp's own resolution. */
const MAX_PREVIEW_SCALE = 2
/** Room kept around the fitted artboard, in screen pixels; the top leaves space for its label. */
const FIT_MARGIN = { x: 72, top: 44, bottom: 28 }
const ZOOM_STEP = 1.25
const ZOOM_PRESETS = [0.25, 0.5, 1, 2]
/** A press must move this far before it becomes a drag rather than a click. */
const DRAG_PX = 3

const TOOLS: { id: Tool; label: string; key: string; icon: IconComponent }[] = [
  { id: 'move', label: 'Move', key: 'V', icon: MousePointer2 },
  { id: 'hand', label: 'Hand', key: 'H', icon: Hand },
  { id: 'text', label: 'Text', key: 'T', icon: Type },
  { id: 'rect', label: 'Rectangle', key: 'R', icon: Square },
  { id: 'ellipse', label: 'Ellipse', key: 'E', icon: Circle },
  { id: 'pen', label: 'Pen: click for corners, drag for curves, click the first point to close, Enter to finish', key: 'P', icon: PenTool },
]

/** What the creation tools put down where the picture is clicked. */
const CREATE: Partial<Record<Tool, Record<string, unknown>>> = {
  text: { kind: 'text', text: 'Your title' },
  rect: { kind: 'shape', shape: { type: 'rect', cornerRadius: 24 } },
  ellipse: { kind: 'shape', shape: { type: 'ellipse' } },
}

/** The zoom that fits the whole comp in a stage of this size. */
function fitZoom(comp: Pick<Comp, 'width' | 'height'>, stage: { width: number; height: number }): number {
  const w = Math.max(1, stage.width - 2 * FIT_MARGIN.x)
  const h = Math.max(1, stage.height - FIT_MARGIN.top - FIT_MARGIN.bottom)
  return Math.max(0.01, Math.min(w / comp.width, h / comp.height))
}

/**
 * The Pen: a press adds a point (a click on the first point closes the path),
 * and dragging from it pulls out its handle, making the curve through it.
 */
function startPenPoint(e: ReactPointerEvent<HTMLElement>, point: { x: number; y: number; inside: boolean }, zoom: number): void {
  const { pen } = useEditor.getState()
  const first = pen?.points[0]
  if (pen && first && pen.points.length > 1 && Math.hypot(point.x - first.x, point.y - first.y) * zoom < 8) {
    void finishPen(true)
    return
  }
  const added: PenPoint = { x: Math.round(point.x), y: Math.round(point.y) }
  const points = [...(pen?.points ?? []), added]
  useEditor.setState({ pen: { points, hover: null }, selectedLayerId: null })
  const target = e.currentTarget
  const origin = { x: e.clientX, y: e.clientY }
  const move = (ev: PointerEvent) => {
    const dx = (ev.clientX - origin.x) / zoom
    const dy = (ev.clientY - origin.y) / zoom
    if (Math.hypot(dx, dy) * zoom < DRAG_PX) return
    const current = useEditor.getState().pen
    if (!current) return
    const last = { ...added, out: { x: added.x + dx, y: added.y + dy } }
    useEditor.setState({ pen: { points: [...current.points.slice(0, -1), last], hover: null } })
  }
  const up = () => {
    target.removeEventListener('pointermove', move)
    target.removeEventListener('pointerup', up)
    target.removeEventListener('pointercancel', up)
  }
  target.addEventListener('pointermove', move)
  target.addEventListener('pointerup', up)
  target.addEventListener('pointercancel', up)
}

/** Drags a layer across the picture. The moves apply live and the drag is one undo step. */
function startMove(e: ReactPointerEvent<HTMLElement>, layer: Layer, zoom: number): void {
  const target = e.currentTarget
  const { timeMs } = useEditor.getState()
  const comp = activeComp(useEditor.getState())
  // In a world the layer moves in the plane that faces the live camera (see worldDrag.ts); a flat comp moves x and y.
  const world = isWorld(comp) ? worldDragAt(comp, layer.id, timeMs) : null
  const start = world ? transformAt(layer, timeMs - layer.startMs) : resolveLayer(layer, timeMs).transform
  const origin = { x: e.clientX, y: e.clientY }
  let gesture: ReturnType<typeof beginGesture> | null = null

  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - origin.x
    const dy = ev.clientY - origin.y
    if (!gesture) {
      if (Math.hypot(dx, dy) < DRAG_PX) return
      gesture = beginGesture('Move layer')
    }
    const current = findLayer(useEditor.getState().project, layer.id) ?? layer
    // Shift keeps the move horizontal or vertical.
    const lockAxis = ev.shiftKey ? (Math.abs(dx) > Math.abs(dy) ? 'x' : 'y') : null
    const sx = lockAxis === 'y' ? 0 : dx / zoom
    const sy = lockAxis === 'x' ? 0 : dy / zoom
    if (world) {
      const delta = worldDragDelta(world, comp, [sx, sy])
      if (!delta) return
      const round = (v: number) => Math.round(v * 10) / 10
      const calls = (['x', 'y', 'z'] as const).flatMap((axis, i) => {
        const value = round(start[axis] + (delta[i] ?? 0))
        if (value === start[axis]) return []
        const [command, input] = propertyEdit(current, axis, `transform.${axis}`, value)
        return [{ command, input }]
      })
      if (calls.length > 0) gesture.request('api.batch', { calls })
      return
    }
    const x = Math.round(start.x + sx)
    const y = Math.round(start.y + sy)
    const calls = (['x', 'y'] as const).map((axis) => {
      const [command, input] = propertyEdit(current, axis, `transform.${axis}`, axis === 'x' ? x : y)
      return { command, input }
    })
    gesture.request('api.batch', { calls })
  }
  const finish = () => {
    target.removeEventListener('pointermove', move)
    target.removeEventListener('pointerup', finish)
    target.removeEventListener('pointercancel', finish)
    target.removeEventListener('lostpointercapture', finish)
    if (target.hasPointerCapture(e.pointerId)) target.releasePointerCapture(e.pointerId)
    void gesture?.end()
    gesture = null
  }
  try {
    target.setPointerCapture(e.pointerId)
  } catch {
    // The pointer is already gone (or synthetic); events sent to the target still work.
  }
  target.addEventListener('pointermove', move)
  target.addEventListener('pointerup', finish)
  target.addEventListener('pointercancel', finish)
  target.addEventListener('lostpointercapture', finish)
}

/** Pans the view while the pointer is held. */
function startPan(e: ReactPointerEvent<HTMLElement>, zoom: number): void {
  const target = e.currentTarget
  const { viewPan, viewZoom, setView } = useEditor.getState()
  // Panning a fitted view freezes the zoom it has.
  if (viewZoom === null) setView(zoom, viewPan)
  const origin = { x: e.clientX - viewPan.x, y: e.clientY - viewPan.y }
  const move = (ev: PointerEvent) => {
    const state = useEditor.getState()
    state.setView(state.viewZoom, { x: ev.clientX - origin.x, y: ev.clientY - origin.y })
  }
  const finish = () => {
    target.removeEventListener('pointermove', move)
    target.removeEventListener('pointerup', finish)
    target.removeEventListener('pointercancel', finish)
    target.removeEventListener('lostpointercapture', finish)
    if (target.hasPointerCapture(e.pointerId)) target.releasePointerCapture(e.pointerId)
  }
  try {
    target.setPointerCapture(e.pointerId)
  } catch {
    // See startMove.
  }
  target.addEventListener('pointermove', move)
  target.addEventListener('pointerup', finish)
  target.addEventListener('pointercancel', finish)
  target.addEventListener('lostpointercapture', finish)
}

/** Whether the open comp is a world seen through the orbit view (read from the store, so a key pressed a moment ago counts). */
function inOrbit(): boolean {
  const state = useEditor.getState()
  const comp = activeComp(state)
  return isWorld(comp) && worldViewOf(state, comp.id).orbit
}

/** The stage colour the orbit view clears to outside the world's own background (read once). */
let stageColour: string | null = null
function stageColor(): string {
  stageColour ??= getComputedStyle(document.documentElement).getPropertyValue('--color-stage').trim() || 'black'
  return stageColour
}

/** Frames the selection or everything in the orbit view, keeping its angles. */
function frameOrbit(what: 'selection' | 'all'): void {
  const state = useEditor.getState()
  const comp = activeComp(state)
  const ids = what === 'selection' ? selectionIds() : undefined
  if (ids?.length === 0) return
  const bounds = renderer.orbitBounds(comp, state.project, state.timeMs, ids)
  const view = framedView(worldViewOf(state, comp.id).view ?? DEFAULT_ORBIT_VIEW, bounds, comp.width / comp.height)
  state.setWorldView(comp.id, { view })
}

/**
 * Keys of the orbit view: 0 toggles it for a world; while it is on, the numpad
 * sets axis views and turns, zooms and frames, and Home frames everything.
 * Returns true when the key was used (the shortcut handler in App.tsx calls this first).
 */
export function orbitKeyDown(e: KeyboardEvent): boolean {
  if (e.altKey || e.metaKey) return false
  const state = useEditor.getState()
  const comp = activeComp(state)
  if (!isWorld(comp)) return false
  if ((e.code === 'Digit0' || e.code === 'Numpad0') && !e.ctrlKey && !e.shiftKey) {
    state.toggleOrbit(comp.id)
    return true
  }
  const { orbit, view } = worldViewOf(state, comp.id)
  if (!orbit || !view) return false
  const result = orbitKey(view, e.code, e.ctrlKey)
  if (!result) return false
  if ('view' in result) state.setWorldView(comp.id, { view: result.view })
  else frameOrbit(result.frame)
  return true
}

/**
 * A press in the orbit view. The middle button (or Alt + left) orbits; with
 * Shift it pans, with Ctrl it zooms; the Hand tool pans. A left click with the
 * Move tool selects what is under the pointer through the orbit camera
 * (Shift or Ctrl toggles). Nothing is dragged: the document never changes.
 */
function startOrbitPointer(e: ReactPointerEvent<HTMLElement>, frame: HTMLElement | null): void {
  // The middle button would start the browser's autoscroll.
  if (e.button === 1) e.preventDefault()
  const mode = dragModeOf(e, useEditor.getState().tool)
  if (!mode || !frame) return
  const target = e.currentTarget
  const origin = { x: e.clientX, y: e.clientY }
  let last = origin
  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - last.x
    const dy = ev.clientY - last.y
    last = { x: ev.clientX, y: ev.clientY }
    if (mode === 'select') return
    const state = useEditor.getState()
    const comp = activeComp(state)
    const view = worldViewOf(state, comp.id).view
    if (view) state.setWorldView(comp.id, { view: dragView(view, mode, dx, dy, frame.getBoundingClientRect().height) })
  }
  const release = () => {
    target.removeEventListener('pointermove', move)
    target.removeEventListener('pointerup', up)
    target.removeEventListener('pointercancel', release)
    target.removeEventListener('lostpointercapture', release)
    if (target.hasPointerCapture(e.pointerId)) target.releasePointerCapture(e.pointerId)
  }
  const up = (ev: PointerEvent) => {
    release()
    if (mode !== 'select' || !isClick(ev.clientX - origin.x, ev.clientY - origin.y)) return
    const state = useEditor.getState()
    const comp = activeComp(state)
    const view = worldViewOf(state, comp.id).view
    const rect = frame.getBoundingClientRect()
    if (!view || rect.width === 0) return
    const u = (ev.clientX - rect.left) / rect.width
    const v = (ev.clientY - rect.top) / rect.height
    const inside = u >= 0 && u <= 1 && v >= 0 && v <= 1
    const hit = inside ? renderer.orbitPick(comp, state.project, state.timeMs, view, [u * comp.width, v * comp.height], { pxPerComp: rect.width / comp.width }) : null
    const next = clickSelection(hit?.id ?? null, ev.shiftKey || ev.ctrlKey || ev.metaKey)
    if (next) state.select(next.id, next.additive)
  }
  try {
    target.setPointerCapture(e.pointerId)
  } catch {
    // See startMove.
  }
  target.addEventListener('pointermove', move)
  target.addEventListener('pointerup', up)
  target.addEventListener('pointercancel', release)
  target.addEventListener('lostpointercapture', release)
}

const SHADINGS: { id: OrbitShading; label: string; title: string }[] = [
  { id: 'solid', label: 'Solid', title: 'Solid: flat shading, no lights' },
  { id: 'material', label: 'Material', title: 'Material preview: materials with a neutral studio light' },
  { id: 'rendered', label: 'Rendered', title: 'Rendered: the world as it exports, with its own lights and look' },
]

/** One option of a segmented control: `active-tint` when chosen. */
function Segment({ on, title, onClick, children }: { on: boolean; title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      title={title}
      className={`flex h-7 items-center justify-center gap-1 rounded-lg px-2.5 text-[11px] font-medium ${on ? 'active-tint' : 'text-muted hover:bg-hover hover:text-ink'}`}
    >
      {children}
    </button>
  )
}

/** The orbit view's shading as a small menu, so the pill stays clear of the zoom pill. */
function ShadingMenu({ compId, shading }: { compId: string; shading: OrbitShading }) {
  const [open, setOpen] = useState(false)
  const current = SHADINGS.find((s) => s.id === shading) ?? SHADINGS[0]
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-label="Shading"
        aria-expanded={open}
        title={`Shading: ${current?.title ?? ''}`}
        className="flex h-7 items-center gap-1 rounded-lg px-2 text-[12px] hover:bg-hover"
      >
        {current?.label}
        <ChevronDown size={12} className="text-muted" />
      </button>
      {open && (
        <div className="glass absolute top-9 left-0 w-44 rounded-panel p-1" onPointerLeave={() => setOpen(false)}>
          {SHADINGS.map(({ id, label, title }) => (
            <button
              key={id}
              type="button"
              title={title}
              onClick={() => {
                useEditor.getState().setWorldView(compId, { shading: id })
                setOpen(false)
              }}
              className={`flex h-7 w-full items-center rounded-lg px-2.5 text-[12px] hover:bg-hover ${id === shading ? 'text-accent' : ''}`}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Look through the live camera or from the orbit view (shown for worlds only); the orbit view adds shading, grid and Frame all. */
function OrbitPill() {
  const comp = useActiveComp()
  const wv = useEditor((s) => worldViewOf(s, comp.id))
  if (!isWorld(comp)) return null
  const setOrbit = (on: boolean) => {
    if (wv.orbit !== on) useEditor.getState().toggleOrbit(comp.id)
  }
  return (
    <div className="glass absolute top-2 left-14 z-10 flex h-9 items-center gap-0.5 rounded-panel px-1">
      <Segment on={!wv.orbit} title="Look through the camera (0)" onClick={() => setOrbit(false)}>
        Camera
      </Segment>
      <Segment on={wv.orbit} title="Orbit view (0): look around the world freely; the camera and the export stay as they are" onClick={() => setOrbit(true)}>
        Orbit
      </Segment>
      {wv.orbit && (
        <>
          <div className="mx-1 h-4 w-px bg-line" />
          <ShadingMenu compId={comp.id} shading={wv.shading} />
          <div className="mx-1 h-4 w-px bg-line" />
          <button
            type="button"
            onClick={() => useEditor.getState().setWorldView(comp.id, { showGrid: !wv.showGrid })}
            aria-label="Ground grid"
            aria-pressed={wv.showGrid}
            title="Ground grid"
            className={`flex size-7 items-center justify-center rounded-lg ${wv.showGrid ? 'active-tint' : 'text-muted hover:bg-hover hover:text-ink'}`}
          >
            <Grid3x3 size={14} />
          </button>
          <button
            type="button"
            onClick={() => frameOrbit('all')}
            aria-label="Frame all"
            title="Frame all (Home)"
            className="flex size-7 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-ink"
          >
            <Maximize size={14} />
          </button>
        </>
      )}
    </div>
  )
}

function ToolPalette() {
  const tool = useEditor((s) => s.tool)
  return (
    <div className="tool-palette glass absolute top-2 left-2 z-10 flex flex-col gap-1 rounded-panel p-1">
      {TOOLS.map(({ id, label, key, icon: Icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => useEditor.setState({ tool: id, pen: null })}
          aria-label={label}
          aria-pressed={tool === id}
          title={`${label} (${key})`}
          className={`flex size-8 items-center justify-center rounded-lg ${tool === id ? 'active-tint' : 'text-muted hover:bg-hover hover:text-ink'}`}
        >
          <Icon size={16} />
        </button>
      ))}
    </div>
  )
}

function ZoomPill({ zoom, fitted, onZoom }: { zoom: number; fitted: boolean; onZoom: (zoom: number | null) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="glass absolute top-2 right-2 z-10 flex h-9 items-center gap-0.5 rounded-panel px-1 text-[12px]">
      <button
        type="button"
        onClick={() => onZoom(zoom / ZOOM_STEP)}
        aria-label="Zoom out"
        title="Zoom out (Ctrl+wheel)"
        className="flex size-7 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-ink"
      >
        <Minus size={14} />
      </button>
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-label="Zoom"
          aria-expanded={open}
          title="Zoom presets"
          className="flex h-7 min-w-16 items-center justify-center gap-1 rounded-lg px-1.5 font-semibold tabular-nums hover:bg-hover"
        >
          {Math.round(zoom * 100)}%
          <ChevronDown size={12} className="text-muted" />
        </button>
        {open && (
          <div className="glass absolute top-9 right-0 w-36 rounded-panel p-1" onPointerLeave={() => setOpen(false)}>
            {[null, ...ZOOM_PRESETS].map((preset) => (
              <button
                key={preset ?? 'fit'}
                type="button"
                onClick={() => {
                  onZoom(preset)
                  setOpen(false)
                }}
                className={`flex h-7 w-full items-center justify-between rounded-lg px-2.5 hover:bg-hover ${
                  (preset === null ? fitted : !fitted && Math.abs(zoom - preset) < 1e-6) ? 'text-accent' : ''
                }`}
              >
                {preset === null ? 'Fit' : `${preset * 100}%`}
                {preset === null && <span className="text-[10px] text-muted">Shift+1</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={() => onZoom(zoom * ZOOM_STEP)}
        aria-label="Zoom in"
        title="Zoom in (Ctrl+wheel)"
        className="flex size-7 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-ink"
      >
        <Plus size={14} />
      </button>
      <div className="mx-1 h-4 w-px bg-line" />
      <button
        type="button"
        onClick={() => onZoom(null)}
        title="Fit the comp in the view (Shift+1)"
        className={`h-7 rounded-lg px-2 font-medium hover:bg-hover ${fitted ? 'text-accent' : 'text-muted hover:text-ink'}`}
      >
        Fit
      </button>
    </div>
  )
}

export function Viewport() {
  const comp = useActiveComp()
  const { name, width, height, mode, stillMs } = comp
  const project = useEditor((s) => s.project)
  const trail = useEditor(currentTrail)
  const tool = useEditor((s) => s.tool)
  const viewZoom = useEditor((s) => s.viewZoom)
  const viewPan = useEditor((s) => s.viewPan)
  const wv = useEditor((s) => worldViewOf(s, comp.id))
  const stageRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const [stage, setStage] = useState({ width: 0, height: 0 })

  const fit = fitZoom(comp, stage)
  const zoom = viewZoom ?? fit
  const frame = {
    left: stage.width / 2 + viewPan.x - (width * zoom) / 2,
    top: (stage.height + FIT_MARGIN.top - FIT_MARGIN.bottom) / 2 + viewPan.y - (height * zoom) / 2,
    width: width * zoom,
    height: height * zoom,
  }

  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return
    const observer = new ResizeObserver(() => setStage({ width: el.clientWidth, height: el.clientHeight }))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Redraw when the project, playhead, selection, size, fonts or media frames change: at most once per frame.
  useEffect(() => {
    let pending = 0

    const draw = () => {
      pending = 0
      const frame = frameRef.current
      const canvas = canvasRef.current
      const overlay = overlayRef.current
      if (!frame || !canvas || !overlay) return
      const state = useEditor.getState()
      const comp = activeComp(state)
      const dpr = window.devicePixelRatio || 1
      const pixelWidth = Math.max(1, Math.round(Math.min(frame.clientWidth * dpr, comp.width * MAX_PREVIEW_SCALE)))
      const pixelHeight = Math.max(1, Math.round((pixelWidth * comp.height) / comp.width))
      for (const c of [canvas, overlay]) {
        if (c.width !== pixelWidth || c.height !== pixelHeight) {
          c.width = pixelWidth
          c.height = pixelHeight
        }
      }

      const ctx = canvas.getContext('2d')
      const octx = overlay.getContext('2d')
      if (!ctx || !octx) return
      const scale = pixelWidth / comp.width
      preview.sync(comp, state.project, state.timeMs, state.playing, activeWorkRange(state.workRange, state.workRangeEnabled, comp.id) ?? undefined)

      // A world seen from the orbit view: drawn by the engine with its own gizmos and motion path, so none of the 2D overlays apply.
      const looking = worldViewOf(state, comp.id)
      if (isWorld(comp) && looking.orbit) {
        // The first time, frame everything (the view is kept from then on).
        // The first view frames everything; it is kept only once there are bounds (the world renderer may still be loading).
        const bounds = looking.view ? null : renderer.orbitBounds(comp, state.project, state.timeMs)
        const view = looking.view ?? firstView(bounds, comp.width / comp.height)
        if (!looking.view && bounds) state.setWorldView(comp.id, { view })
        renderer.renderOrbit(ctx, comp, state.project, state.timeMs, scale, preview, {
          view,
          shading: looking.shading,
          grid: { show: looking.showGrid, size: looking.gridSize, divisions: looking.gridDivisions },
          voidColor: stageColor(),
          selectedIds: selectionIds(),
          motionPaths: state.motionPaths,
          playing: state.playing,
        })
        octx.setTransform(1, 0, 0, 1, 0, 0)
        octx.clearRect(0, 0, pixelWidth, pixelHeight)
        if (state.motionHover) useEditor.setState({ motionHover: null })
        return
      }
      // While playing, motion blur draws fewer moments so playback keeps up; a still frame gets them all.
      renderer.render(ctx, comp, state.project, state.timeMs, scale, preview, state.playing ? { maxMotionSamples: 6 } : {})

      // Selection outline, drawn on its own canvas so it never ends up in exports.
      octx.setTransform(1, 0, 0, 1, 0, 0)
      octx.clearRect(0, 0, pixelWidth, pixelHeight)
      const selected = comp.tracks.flatMap((t) => t.layers).find((l) => l.id === state.selectedLayerId)
      const corners = selected ? renderer.outline(comp, state.project, selected, state.timeMs) : null
      if (corners) {
        octx.setTransform(scale, 0, 0, scale, 0, 0)
        octx.beginPath()
        for (const [i, [x, y]] of corners.entries()) {
          if (i === 0) octx.moveTo(x, y)
          else octx.lineTo(x, y)
        }
        octx.closePath()
        octx.lineWidth = (1.5 * dpr) / scale
        octx.strokeStyle = cssColor('accent')
        octx.stroke()
        // Corner handles show the layer can be dragged.
        const size = (6 * dpr) / scale
        octx.fillStyle = '#f1eaee'
        for (const [x, y] of corners) {
          octx.fillRect(x - size / 2, y - size / 2, size, size)
          octx.strokeRect(x - size / 2, y - size / 2, size, size)
        }
      }

      // Motion paths of the selected layers (Move tool only), on top of the outline.
      const paths = updateMotionPaths(renderer, state, comp, frame.clientWidth)
      if (!motionHoverValid(state.motionHover, paths)) useEditor.setState({ motionHover: null })
      drawMotionPaths(octx, paths, { scale: pixelWidth / frame.clientWidth, hover: state.motionHover, selectedKey: state.selectedKey })

      // Bones of the selected rig (or of the rig a selected member is in), for posing by hand.
      const rig = updateRigOverlay(renderer, state, comp, frame.clientWidth)
      if (rig) {
        const accent = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim()
        drawRigOverlay(octx, rig, { scale: pixelWidth / frame.clientWidth, picked: pickedBone(rig), accent })
      }

      // The path the Pen is drawing, with the segment to the pointer.
      if (state.pen && state.pen.points.length > 0) {
        const toPx = (p: { x: number; y: number }) => [p.x + comp.width / 2, p.y + comp.height / 2] as const
        const shifted = state.pen.points.map((p) => ({
          x: toPx(p)[0],
          y: toPx(p)[1],
          ...(p.out ? { out: { x: toPx(p.out)[0], y: toPx(p.out)[1] } } : {}),
        }))
        const hover = state.pen.hover ? { x: toPx(state.pen.hover)[0], y: toPx(state.pen.hover)[1] } : null
        octx.setTransform(scale, 0, 0, scale, 0, 0)
        octx.lineWidth = (1.5 * dpr) / scale
        octx.strokeStyle = cssColor('accent')
        octx.stroke(new Path2D(penPathData(hover ? [...shifted, hover] : shifted, false)))
        const size = (6 * dpr) / scale
        octx.fillStyle = '#f1eaee'
        for (const p of shifted) {
          octx.fillRect(p.x - size / 2, p.y - size / 2, size, size)
          octx.strokeRect(p.x - size / 2, p.y - size / 2, size, size)
          if (p.out) {
            octx.beginPath()
            octx.moveTo(2 * p.x - p.out.x, 2 * p.y - p.out.y)
            octx.lineTo(p.out.x, p.out.y)
            octx.stroke()
          }
        }
      }
    }

    const schedule = () => {
      if (!pending) pending = requestAnimationFrame(draw)
    }
    const unsubscribe = useEditor.subscribe(schedule)
    const unsubscribeMedia = preview.onChange(schedule)
    const observer = new ResizeObserver(schedule)
    if (frameRef.current) observer.observe(frameRef.current)
    document.fonts.addEventListener('loadingdone', schedule)
    window.addEventListener('uve-outline-font-ready', schedule)
    // A 3D world draws once three.js has loaded (on first sight of a world).
    renderer.onWorldReady = schedule
    schedule()
    return () => {
      unsubscribe()
      unsubscribeMedia()
      observer.disconnect()
      document.fonts.removeEventListener('loadingdone', schedule)
      window.removeEventListener('uve-outline-font-ready', schedule)
      renderer.onWorldReady = undefined
      cancelAnimationFrame(pending)
    }
  }, [])

  // Ctrl+wheel zooms around the pointer; the wheel alone pans. React's wheel listener is passive, so this one is added by hand.
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const state = useEditor.getState()
      const comp = activeComp(state)
      // In the orbit view the wheel moves the orbit camera, not the artboard.
      const looking = worldViewOf(state, comp.id)
      if (isWorld(comp) && looking.orbit) {
        const height = frameRef.current?.getBoundingClientRect().height ?? 1
        if (looking.view) state.setWorldView(comp.id, { view: wheelView(looking.view, e, height) })
        return
      }
      const rect = el.getBoundingClientRect()
      const size = { width: rect.width, height: rect.height }
      const before = state.viewZoom ?? fitZoom(comp, size)
      if (!e.ctrlKey) {
        state.setView(before, { x: state.viewPan.x - e.deltaX, y: state.viewPan.y - e.deltaY })
        return
      }
      const after = Math.min(MAX_VIEW_ZOOM, Math.max(MIN_VIEW_ZOOM, before * Math.exp(-e.deltaY * 0.0025)))
      // Keep the point under the pointer still: offsets are measured from the stage's frame centre.
      const cx = rect.width / 2
      const cy = (rect.height + FIT_MARGIN.top - FIT_MARGIN.bottom) / 2
      const px = e.clientX - rect.left - cx
      const py = e.clientY - rect.top - cy
      const k = after / before
      state.setView(after, { x: px - (px - state.viewPan.x) * k, y: py - (py - state.viewPan.y) * k })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  /** Comp coordinates (centre origin) of a client point. */
  const compPoint = (clientX: number, clientY: number) => {
    const rect = frameRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0, inside: false }
    const u = (clientX - rect.left) / rect.width
    const v = (clientY - rect.top) / rect.height
    return { x: (u - 0.5) * width, y: (v - 0.5) * height, inside: u >= 0 && u <= 1 && v >= 0 && v <= 1 }
  }

  /** A client point in CSS px from the artboard's top-left (the motion overlay's space). */
  const artboardPoint = (e: { clientX: number; clientY: number }): [number, number] => {
    const rect = frameRef.current?.getBoundingClientRect()
    return rect ? [e.clientX - rect.left, e.clientY - rect.top] : [Number.NaN, Number.NaN]
  }
  /** The editable part of a motion path under a client point (Move tool only). */
  const motionAt = (e: { clientX: number; clientY: number }) => (useEditor.getState().tool === 'move' ? motionHitAt(artboardPoint(e)) : null)

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest('button')) return
    // Read from the store: a tool key pressed a moment ago may not have re-rendered yet.
    const { tool } = useEditor.getState()
    if (inOrbit()) {
      startOrbitPointer(e, frameRef.current)
      return
    }
    const panning = tool === 'hand' || e.button === 1
    if (panning) {
      e.preventDefault()
      startPan(e, zoom)
      return
    }
    if (e.button !== 0) return
    const state = useEditor.getState()
    const current = activeComp(state)
    const point = compPoint(e.clientX, e.clientY)
    if (tool === 'pen') {
      startPenPoint(e, point, zoom)
      return
    }
    const create = CREATE[tool]
    if (create) {
      if (!point.inside) return
      void run('layer.create', {
        compId: current.id,
        startMs: Math.round(state.timeMs),
        ...create,
        transform: { x: Math.round(point.x), y: Math.round(point.y) },
      }).then((result) => {
        if (result.ok) useEditor.getState().select((result.value as { id: string }).id)
      })
      useEditor.setState({ tool: 'move' })
      return
    }
    // A press on a motion path edits the path, and keeps the selection.
    const onPath = motionAt(e)
    if (onPath && startMotionDrag(e.nativeEvent, onPath, artboardPoint, e.currentTarget)) return
    // A press on a bone of the shown rig poses the bone, and neither moves nor selects a layer.
    const onBone = tool === 'move' ? rigHitAt(artboardPoint(e)) : null
    if (onBone && startRigDrag(e, onBone, artboardPoint)) return
    const hit = renderer.pick(current, state.project, state.timeMs, [point.x + width / 2, point.y + height / 2])
    state.select(hit?.id ?? null)
    if (hit) startMove(e, hit, zoom)
  }

  // Files dropped on the picture are centred where they land (in comp space), starting at the playhead.
  const [dropping, setDropping] = useState(false)
  const accepts = (e: DragEvent) =>
    dragHasFiles(e.dataTransfer) || e.dataTransfer.types.includes(MEDIA_DRAG_TYPE) || e.dataTransfer.types.includes(STICKER_DRAG_TYPE)
  const drop = (e: DragEvent) => {
    setDropping(false)
    if (!accepts(e)) return
    e.preventDefault()
    const state = useEditor.getState()
    const point = compPoint(e.clientX, e.clientY)
    const placement = {
      compId: activeComp(state).id,
      startMs: state.timeMs,
      x: point.inside ? Math.round(point.x) : 0,
      y: point.inside ? Math.round(point.y) : 0,
    }
    const stickerId = e.dataTransfer.getData(STICKER_DRAG_TYPE)
    if (stickerId) {
      void placeSticker(stickerId, placement)
      return
    }
    const mediaId = e.dataTransfer.getData(MEDIA_DRAG_TYPE)
    const media = state.project.media.find((m) => m.id === mediaId)
    if (media) void placeMedia(media, placement)
    else void importDrop(e.dataTransfer, placement)
  }

  // Pointer over part of a motion path; while a button is held, the part being dragged keeps the hover.
  const hoverMotion = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 0) return
    const found = motionHitAt(artboardPoint(e))
    if (motionHoverChanged(useEditor.getState().motionHover, found)) useEditor.setState({ motionHover: found })
  }
  const overMotion = useEditor((s) => s.motionHover !== null)

  const orbiting = isWorld(comp) && wv.orbit
  const cursor = orbiting
    ? tool === 'hand'
      ? 'cursor-grab active:cursor-grabbing'
      : 'cursor-default'
    : overMotion && tool === 'move' ? 'cursor-pointer' : tool === 'hand' ? 'cursor-grab active:cursor-grabbing' : CREATE[tool] || tool === 'pen' ? 'cursor-crosshair' : 'cursor-default'

  return (
    <div
      ref={stageRef}
      className={`relative h-full overflow-hidden bg-panel ${cursor} ${dropping ? 'ring-2 ring-accent/60 ring-inset' : ''}`}
      onPointerDown={onPointerDown}
      onDoubleClick={(e) => {
        // Double-click a nested comp to edit what is inside it.
        if ((e.target as Element).closest('button') || useEditor.getState().tool !== 'move' || inOrbit()) return
        // On a motion path: add a point on a segment, or turn a point smooth or corner.
        if (motionDoubleClick(motionAt(e))) return
        const state = useEditor.getState()
        const point = compPoint(e.clientX, e.clientY)
        const hit = renderer.pick(activeComp(state), state.project, state.timeMs, [point.x + width / 2, point.y + height / 2])
        if (hit?.kind === 'nested') enterNested(hit.id)
      }}
      onPointerMove={(e) => {
        if (inOrbit()) return
        const { pen } = useEditor.getState()
        if (!pen) {
          hoverMotion(e)
          return
        }
        const p = compPoint(e.clientX, e.clientY)
        useEditor.setState({ pen: { ...pen, hover: { x: p.x, y: p.y } } })
      }}
      onContextMenu={(e) => {
        // A middle-button press in the orbit view is no menu, and there are no motion points to edit.
        if (inOrbit()) return
        if (openMotionMenu(motionAt(e), { x: e.clientX, y: e.clientY })) e.preventDefault()
      }}
      onPointerLeave={() => {
        if (useEditor.getState().motionHover) useEditor.setState({ motionHover: null })
      }}
      onDragOver={(e) => {
        if (!accepts(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDropping(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
      }}
      onDrop={drop}
    >
      <ToolPalette />
      <OrbitPill />
      <ZoomPill zoom={zoom} fitted={viewZoom === null} onZoom={(z) => useEditor.getState().setView(z)} />
      {/* The artboard's label sits above its top-left corner. */}
      <div
        className="pointer-events-none absolute flex items-baseline gap-2 text-[11px] whitespace-nowrap"
        style={{ left: frame.left, top: frame.top - 22 }}
      >
        {trail.map((step, i) => (
          <span key={step.layerId} className="flex items-baseline gap-2">
            <button
              type="button"
              onClick={() => leaveNested(i)}
              title="Back out to this comp"
              className="pointer-events-auto font-semibold text-muted hover:text-ink"
            >
              {project.comps.find((c) => c.id === step.compId)?.name ?? 'Comp'}
            </button>
            <span className="text-muted">›</span>
          </span>
        ))}
        <span className="font-semibold text-ink/80">{name}</span>
        <span className="text-muted tabular-nums">
          {width} × {height}
        </span>
        {mode === 'static' && <span className="rounded bg-field px-1.5 text-[10px] text-muted">static · {formatClock(stillMs)}</span>}
      </div>
      <div
        ref={frameRef}
        className="absolute shadow-[0_8px_40px_rgb(0_0_0/60%)] ring-1 ring-line"
        style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }}
      >
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
        <canvas ref={overlayRef} className="absolute inset-0 h-full w-full" />
      </div>
      <MotionMenu />
    </div>
  )
}
