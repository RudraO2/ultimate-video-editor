import { activeWorkRange, formatTimecode, groupOnLane, laneDepth, layerEnd, type Marker, MIN_WORK_RANGE_MS, type Track, transitionWindows } from '@uve/core'
import { ArrowLeftRight, ArrowLeftToLine, AudioLines, BetweenHorizontalStart, Group, Magnet, Maximize2, Minus, Pause, Play, Plus, Repeat, Scissors, SkipBack, Trash2, X } from 'lucide-react'
import { type DragEvent, type PointerEvent, type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from 'react'
import { placeSticker } from '../library/stickers'
import { dragHasFiles, importDrop, MEDIA_DRAG_TYPE, placeMedia, STICKER_DRAG_TYPE } from '../media/import'
import { activeComp, closeGapsOfSelection, MAX_PX_PER_SECOND, MIN_PX_PER_SECOND, run, useActiveComp, useEditor } from '../store'
import { snapShift, snapTargets } from '../timeline/edit'
import { LANE_HEIGHT, type TimelineGeometry, TimelineClip } from './TimelineClip'
import { CurvesView, DopeSheet } from './KeyViews'
import { ColorView, Mixer, NodesView } from './PanelViews'
import { KIND_COLORS, KIND_ICONS } from './kindIcons'
import { trackLabel, TrackToggles } from './TrackToggles'

export const RULER_HEIGHT = 28
const HEADER_WIDTH = 188
const ZOOM_STEP = 1.25
/** Ruler steps, in ms; the smallest one that leaves room for its labels is used. */
const RULER_STEPS = [100, 200, 500, 1000, 2000, 5000, 10_000, 30_000, 60_000, 300_000]

/** Splits the selected layer at the playhead. */
export async function splitAtPlayhead(): Promise<void> {
  const { selectedLayerId, timeMs, notify } = useEditor.getState()
  if (!selectedLayerId) {
    notify('Select a layer to split.')
    return
  }
  await run('timeline.split', { id: selectedLayerId, atMs: timeMs })
}

function deleteSelected(): void {
  const { selectedLayerId } = useEditor.getState()
  if (selectedLayerId) void run('layers.delete', { ids: [selectedLayerId] })
}

function ToolButton({
  label,
  onClick,
  active,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  active?: boolean
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={`flex size-7 items-center justify-center rounded-lg disabled:opacity-40 ${active ? 'active-tint' : 'text-muted hover:bg-hover hover:text-ink'}`}
    >
      {children}
    </button>
  )
}

const Divider = () => <div className="mx-1.5 h-5 w-px bg-line" />

/** The comp's length, typed in seconds next to the timecode. */
function DurationField() {
  const { id, durationMs } = useActiveComp()
  const [draft, setDraft] = useState<string | null>(null)
  const shown = String(Number((durationMs / 1000).toFixed(2)))
  const commit = (text: string) => {
    setDraft(null)
    const seconds = Number(text)
    if (text.trim() !== '' && Number.isFinite(seconds) && seconds > 0 && seconds * 1000 !== durationMs) {
      void run('frame.update', { id, durationMs: Math.round(seconds * 1000) })
    }
  }
  return (
    <label className="flex h-7 items-center gap-1 rounded-lg px-1.5 font-mono text-[12px] hover:bg-hover" title="Comp duration">
      <span className="text-muted">/</span>
      <input
        aria-label="Comp duration in seconds"
        value={draft ?? shown}
        onFocus={(e) => {
          setDraft(shown)
          e.currentTarget.select()
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => draft !== null && commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            setDraft(null)
            e.currentTarget.blur()
          }
        }}
        className="w-10 bg-transparent font-semibold tabular-nums outline-none"
      />
      <span className="text-muted">s</span>
    </label>
  )
}

/** A lane's transitions: a pill over each one's window, named, with a button to take it off. */
/** The icon of a camera, light or controller lane (a group's lane has its own). */
function WorldLaneIcon({ track }: { track: Track }) {
  const kind = track.layers[0]?.kind
  if (kind !== 'camera' && kind !== 'light' && kind !== 'empty') return null
  const Icon = KIND_ICONS[kind]
  return <Icon size={13} className={`shrink-0 ${KIND_COLORS[kind]}`} aria-hidden />
}

function TransitionMarkers({ track }: { track: Track }) {
  const pxPerSecond = useEditor((s) => s.pxPerSecond)
  if (track.transitions.length === 0) return null
  const px = (ms: number) => (ms / 1000) * pxPerSecond
  return (
    <>
      {transitionWindows(track).map((w) => (
        <div
          key={w.transition.id}
          className="group absolute top-1 z-10 flex h-4 items-center justify-center gap-1 overflow-hidden rounded-full bg-accent/80 px-1.5 text-[9px] font-semibold text-white shadow"
          style={{ left: px(w.startMs), width: Math.max(14, px(w.endMs - w.startMs)) }}
          title={`${w.preset.label} · ${Math.round(w.transition.durationMs)} ms${w.a && w.b ? '' : w.a ? ' (out)' : ' (in)'}`}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <ArrowLeftRight size={9} aria-hidden className="shrink-0" />
          <span className="truncate">{w.preset.label}</span>
          <button
            type="button"
            aria-label={`Remove the ${w.preset.label} transition`}
            onClick={() => void run('transition.remove', { transitionId: w.transition.id })}
            className="hidden shrink-0 rounded-full px-0.5 leading-none group-hover:block hover:bg-white/25"
          >
            ×
          </button>
        </div>
      ))}
    </>
  )
}

/** Timeline zoom as a slider, on a log scale so every step feels the same. */
function ZoomSlider() {
  const pxPerSecond = useEditor((s) => s.pxPerSecond)
  const lo = Math.log(MIN_PX_PER_SECOND)
  const hi = Math.log(MAX_PX_PER_SECOND)
  return (
    <input
      type="range"
      min={0}
      max={1000}
      value={Math.round(((Math.log(pxPerSecond) - lo) / (hi - lo)) * 1000)}
      onChange={(e) => useEditor.getState().setZoom(Math.exp(lo + (Number(e.target.value) / 1000) * (hi - lo)))}
      aria-label="Timeline zoom"
      title="Timeline zoom (Ctrl+wheel)"
      className="w-24 accent-accent"
    />
  )
}

/** The timeline's toolbar; `simple` (Easy mode) keeps play, loop, time, split, delete and zoom. */
function Toolbar({ onFit, mixerHidden, onShowMixer, simple }: { onFit: () => void; mixerHidden: boolean; onShowMixer: () => void; simple: boolean }) {
  const { id: compId, fps, mode } = useActiveComp()
  const timeMs = useEditor((s) => s.timeMs)
  const playing = useEditor((s) => s.playing)
  const snapping = useEditor((s) => s.snapping)
  const recordKeys = useEditor((s) => s.recordKeys)
  const loop = useEditor((s) => s.loop)
  const rangeOn = useEditor((s) => s.workRangeEnabled)
  const { seek, togglePlay, setZoom } = useEditor.getState()
  const zoom = (factor: number) => setZoom(useEditor.getState().pxPerSecond * factor)
  return (
    <div className="flex h-12 shrink-0 items-center gap-1 px-3">
      <ToolButton label="Go to start (Home)" onClick={() => seek(0)}>
        <SkipBack size={15} />
      </ToolButton>
      <button
        type="button"
        onClick={togglePlay}
        disabled={mode === 'static'}
        className="mx-1 flex size-8 items-center justify-center rounded-full bg-accent/30 text-accent hover:bg-accent/45 disabled:opacity-40"
        aria-label={playing ? 'Pause' : 'Play'}
        title={mode === 'static' ? 'A static frame is one picture: nothing to play' : `${playing ? 'Pause' : 'Play'} (Space)`}
      >
        {playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" className="translate-x-px" />}
      </button>
      {!simple && (
        <ToolButton
          label={recordKeys ? 'Record keyframes is on: every edit keys at the playhead' : 'Record keyframes'}
          active={recordKeys}
          onClick={() => useEditor.setState({ recordKeys: !recordKeys })}
        >
          <span className={`size-3 rounded-full ${recordKeys ? 'bg-accent' : 'bg-muted'}`} />
        </ToolButton>
      )}
      <ToolButton label={loop ? 'Loop is on' : 'Loop playback'} active={loop} onClick={() => useEditor.setState({ loop: !loop })}>
        <Repeat size={15} />
      </ToolButton>
      {!simple && (
        <ToolButton
          label="Working range — loop & export just a section"
          active={rangeOn}
          disabled={mode === 'static'}
          onClick={() => useEditor.getState().setWorkRangeEnabled(!rangeOn)}
        >
          <BetweenHorizontalStart size={15} />
        </ToolButton>
      )}
      {!simple && rangeOn && mode !== 'static' && (
        <>
          <ToolButton label="Set range in ([)" onClick={() => useEditor.getState().setWorkRangeEdge('start', useEditor.getState().timeMs)}>
            <span className="font-mono text-[13px] font-semibold">[</span>
          </ToolButton>
          <ToolButton label="Set range out (])" onClick={() => useEditor.getState().setWorkRangeEdge('end', useEditor.getState().timeMs)}>
            <span className="font-mono text-[13px] font-semibold">]</span>
          </ToolButton>
        </>
      )}
      <Divider />
      <span className="px-1.5 font-mono text-[12px] text-accent tabular-nums" title="Playhead (hours:minutes:seconds:frames)">
        {formatTimecode(timeMs, fps)}
      </span>
      <DurationField />
      <Divider />
      <ToolButton label="Split the selected layer at the playhead (S)" onClick={() => void splitAtPlayhead()}>
        <Scissors size={15} />
      </ToolButton>
      <ToolButton label="Delete the selected layer (Delete; Shift+Delete also closes the gap)" onClick={deleteSelected}>
        <Trash2 size={15} />
      </ToolButton>
      {!simple && (
        <>
          <ToolButton label="Close the gaps on the selected layer's lane" onClick={() => void closeGapsOfSelection()}>
            <ArrowLeftToLine size={15} />
          </ToolButton>
          <ToolButton
            label={snapping ? 'Snapping is on (hold Alt to place freely)' : 'Snapping is off'}
            active={snapping}
            onClick={() => useEditor.setState({ snapping: !snapping })}
          >
            <Magnet size={15} />
          </ToolButton>
        </>
      )}
      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          onClick={() => void run('track.create', { compId, index: 0 })}
          className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-medium text-muted hover:bg-hover hover:text-ink"
          title="Add an empty track in front"
        >
          <Plus size={14} />
          Track
        </button>
        <Divider />
        <ToolButton label="Zoom out (Ctrl+wheel)" onClick={() => zoom(1 / ZOOM_STEP)}>
          <Minus size={14} />
        </ToolButton>
        <ZoomSlider />
        <ToolButton label="Zoom in (Ctrl+wheel)" onClick={() => zoom(ZOOM_STEP)}>
          <Plus size={14} />
        </ToolButton>
        <ToolButton label="Fit the comp" onClick={onFit}>
          <Maximize2 size={13} />
        </ToolButton>
        {mixerHidden && (
          <ToolButton label="Show the mixer" onClick={onShowMixer}>
            <AudioLines size={15} />
          </ToolButton>
        )}
      </div>
    </div>
  )
}

/** Ruler labels: minutes, seconds and tenths, such as 0:01.5. */
export function rulerLabel(ms: number): string {
  const tenths = Math.round(ms / 100)
  const minutes = Math.floor(tenths / 600)
  const seconds = Math.floor((tenths % 600) / 10)
  return `${minutes}:${String(seconds).padStart(2, '0')}.${tenths % 10}`
}

/** Colours of review marks: a planned cut, a flag for a person, a note. */
const MARKER_COLOUR: Record<Marker['kind'], string> = { cut: 'bg-accent', flag: 'bg-clip-image', note: 'bg-clip-text' }

export function Ruler({ endMs, onScrub, markers = [] }: { endMs: number; onScrub: (clientX: number) => void; markers?: readonly Marker[] }) {
  const pxPerSecond = useEditor((s) => s.pxPerSecond)
  const step = RULER_STEPS.find((s) => (s / 1000) * pxPerSecond >= 64) ?? 600_000
  const ticks = Math.floor(endMs / (step / 2)) + 1
  return (
    <div
      className="relative cursor-pointer border-b border-line"
      style={{ height: RULER_HEIGHT, width: (endMs / 1000) * pxPerSecond }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        onScrub(e.clientX)
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) onScrub(e.clientX)
      }}
    >
      {Array.from({ length: ticks }, (_, i) => {
        const ms = (i * step) / 2
        const major = i % 2 === 0
        return (
          <div
            key={ms}
            className="absolute bottom-0 w-px bg-line"
            style={{ left: (ms / 1000) * pxPerSecond, height: major ? 10 : 5 }}
          >
            {major && <span className="absolute -top-4 left-1.5 font-mono text-[10px] whitespace-nowrap text-muted">{rulerLabel(ms)}</span>}
          </div>
        )
      })}
      {markers.map((m) => (
        <div
          key={m.id}
          title={`${rulerLabel(m.startMs)}${m.durationMs > 0 ? `–${rulerLabel(m.startMs + m.durationMs)}` : ''} ${m.label}`.trim()}
          className={`absolute top-0 h-1.5 rounded-sm opacity-80 hover:opacity-100 ${MARKER_COLOUR[m.kind]}`}
          style={{ left: (m.startMs / 1000) * pxPerSecond, width: Math.max(3, (m.durationMs / 1000) * pxPerSecond) }}
        />
      ))}
    </div>
  )
}

/** The playhead line; while playing it keeps itself in view. */
export function Playhead({ scroller }: { scroller: RefObject<HTMLDivElement | null> }) {
  const timeMs = useEditor((s) => s.timeMs)
  const pxPerSecond = useEditor((s) => s.pxPerSecond)
  const playing = useEditor((s) => s.playing)
  const left = (timeMs / 1000) * pxPerSecond
  useEffect(() => {
    const el = scroller.current
    if (!playing || !el) return
    if (left > el.scrollLeft + el.clientWidth - 32 || left < el.scrollLeft) el.scrollLeft = Math.max(0, left - 32)
  }, [left, playing, scroller])
  return (
    <div className="pointer-events-none absolute inset-y-0 z-20 w-px bg-accent" style={{ left }}>
      <div className="-ml-[5px] h-2.5 w-[11px] rounded-b bg-accent" />
    </div>
  )
}

/** One end of the working range: a full-height line with a flag, dragged to move that end. Store state only, so no undo step. */
function RangeHandle({ edge, ms, geometry, compId }: { edge: 'start' | 'end'; ms: number; geometry: TimelineGeometry; compId: string }) {
  const pxPerSecond = useEditor((s) => s.pxPerSecond)
  const move = (clientX: number) => {
    const { workRange, setWorkRange } = useEditor.getState()
    if (!workRange || workRange.compId !== compId) return
    const at = Math.round(geometry.msAt(clientX))
    if (edge === 'start') {
      const startMs = Math.abs(at) < 50 ? 0 : Math.min(at, workRange.endMs - MIN_WORK_RANGE_MS)
      setWorkRange({ ...workRange, startMs: Math.max(0, startMs) })
    } else {
      setWorkRange({ ...workRange, endMs: Math.max(at, workRange.startMs + MIN_WORK_RANGE_MS) })
    }
  }
  // The pointer dragging this end; capture keeps its events coming, but is best-effort.
  const dragging = useRef<number | null>(null)
  const release = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging.current !== e.pointerId) return
    dragging.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }
  return (
    <div
      className="group absolute inset-y-0 z-[15] w-3 -translate-x-1/2 cursor-ew-resize touch-none"
      style={{ left: (ms / 1000) * pxPerSecond }}
      title={edge === 'start' ? 'Range start: drag to move' : 'Range end: drag to move'}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.stopPropagation()
        e.preventDefault()
        dragging.current = e.pointerId
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          // The pointer is already gone: moves still arrive while it is over the handle.
        }
      }}
      onPointerMove={(e) => {
        if (dragging.current === e.pointerId) move(e.clientX)
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
    >
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-accent/80 group-hover:bg-accent" />
      <div
        className={`absolute top-0 h-3.5 w-1.5 bg-accent ${edge === 'start' ? 'left-1/2 rounded-r-sm' : 'right-1/2 rounded-l-sm'}`}
      />
    </div>
  )
}

/** The working range on the lanes: time outside it is dimmed, and its two ends can be dragged. */
function WorkRangeBand({ geometry }: { geometry: TimelineGeometry }) {
  const { id: compId, mode } = useActiveComp()
  const range = useEditor((s) => s.workRange)
  const enabled = useEditor((s) => s.workRangeEnabled)
  const pxPerSecond = useEditor((s) => s.pxPerSecond)
  const active = mode === 'static' ? null : activeWorkRange(range, enabled, compId)
  if (!active) return null
  const px = (ms: number) => (ms / 1000) * pxPerSecond
  return (
    <>
      {active.startMs > 0 && <div className="pointer-events-none absolute inset-y-0 z-10 bg-app/60" style={{ left: 0, width: px(active.startMs) }} />}
      <div className="pointer-events-none absolute inset-y-0 right-0 z-10 bg-app/60" style={{ left: px(active.endMs) }} />
      <RangeHandle edge="start" ms={active.startMs} geometry={geometry} compId={compId} />
      <RangeHandle edge="end" ms={active.endMs} geometry={geometry} compId={compId} />
    </>
  )
}

/** Snap line and target-track marks drawn during drags and drops. */
function Guides({ tracks }: { tracks: number }) {
  const guide = useEditor((s) => s.guide)
  const pxPerSecond = useEditor((s) => s.pxPerSecond)
  if (!guide) return null
  return (
    <>
      {guide.trackIndex !== null && guide.trackIndex >= 0 && guide.trackIndex < tracks && (
        <div
          className="pointer-events-none absolute inset-x-0 bg-accent/10"
          style={{ top: RULER_HEIGHT + guide.trackIndex * LANE_HEIGHT, height: LANE_HEIGHT }}
        />
      )}
      {guide.newTrack && (
        <div
          className="pointer-events-none absolute inset-x-0 z-10 h-0.5 bg-accent"
          style={{ top: RULER_HEIGHT + (guide.newTrack === 'front' ? 0 : tracks * LANE_HEIGHT) - 1 }}
        />
      )}
      {guide.snapMs !== null && (
        <div
          className="pointer-events-none absolute inset-y-0 z-10 w-px bg-amber-300"
          style={{ left: (guide.snapMs / 1000) * pxPerSecond }}
        />
      )}
    </>
  )
}

/** The timeline panel; `simple` (Easy mode) shows only the timeline view, without the mixer or the track toggles. */
export function Timeline({ simple = false }: { simple?: boolean }) {
  const comp = useActiveComp()
  const chosenView = useEditor((s) => s.bottomView)
  const view = simple ? 'timeline' : chosenView
  const [mixer, setMixer] = useState(true)
  const pxPerSecond = useEditor((s) => s.pxPerSecond)
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const lanesRef = useRef<HTMLDivElement>(null)
  const { tracks, durationMs } = comp

  const geometry = useMemo<TimelineGeometry>(
    () => ({
      msAt: (clientX) => {
        const rect = contentRef.current?.getBoundingClientRect()
        return rect ? Math.max(0, ((clientX - rect.left) / useEditor.getState().pxPerSecond) * 1000) : 0
      },
      trackAt: (clientY) => {
        const rect = lanesRef.current?.getBoundingClientRect()
        return rect ? Math.floor((clientY - rect.top) / LANE_HEIGHT) : 0
      },
      captureTarget: () => contentRef.current,
    }),
    [],
  )

  // Ctrl+wheel zooms around the pointer. React's wheel listener is passive, so this one is added by hand.
  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const { pxPerSecond: before, setZoom } = useEditor.getState()
      const anchorMs = geometry.msAt(e.clientX)
      setZoom(before * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP))
      const after = useEditor.getState().pxPerSecond
      const offset = e.clientX - scroller.getBoundingClientRect().left
      requestAnimationFrame(() => {
        scroller.scrollLeft = (anchorMs / 1000) * after - offset
      })
    }
    scroller.addEventListener('wheel', onWheel, { passive: false })
    return () => scroller.removeEventListener('wheel', onWheel)
    // The lanes' scroller is only mounted in the timeline view.
  }, [geometry, view])

  const fit = () => {
    const width = scrollRef.current?.clientWidth ?? 800
    useEditor.getState().setZoom(((width - 48) / Math.max(1, durationMs)) * 1000)
    if (scrollRef.current) scrollRef.current.scrollLeft = 0
  }

  // Files from the OS and items from the library can be dropped on a track, at the time under the pointer.
  const accepts = (e: DragEvent) =>
    dragHasFiles(e.dataTransfer) || e.dataTransfer.types.includes(MEDIA_DRAG_TYPE) || e.dataTransfer.types.includes(STICKER_DRAG_TYPE)
  const dropPoint = (e: DragEvent) => {
    const state = useEditor.getState()
    const current = activeComp(state)
    const tolerance = (8 / state.pxPerSecond) * 1000
    const raw = geometry.msAt(e.clientX)
    const startMs = Math.max(0, raw + snapShift([raw], snapTargets(current, state.timeMs), tolerance).shift)
    const index = geometry.trackAt(e.clientY)
    const track = index >= 0 && index < current.tracks.length ? current.tracks[index] : undefined
    return { startMs, index, track, compId: current.id }
  }
  const onDragOver = (e: DragEvent) => {
    if (!accepts(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    const { startMs, index, track } = dropPoint(e)
    const count = activeComp(useEditor.getState()).tracks.length
    useEditor.getState().setGuide({
      snapMs: startMs,
      trackIndex: track ? index : null,
      newTrack: track ? null : index < 0 ? 'front' : index >= count ? 'back' : null,
    })
  }
  const onDrop = (e: DragEvent) => {
    useEditor.getState().setGuide(null)
    if (!accepts(e)) return
    e.preventDefault()
    const { startMs, track, compId } = dropPoint(e)
    const placement = { compId, startMs, ...(track ? { trackId: track.id } : {}) }
    // stickers.use takes no track: the layer goes to the time under the pointer, in the open comp.
    const stickerId = e.dataTransfer.getData(STICKER_DRAG_TYPE)
    if (stickerId) {
      void placeSticker(stickerId, { compId, startMs })
      return
    }
    const mediaId = e.dataTransfer.getData(MEDIA_DRAG_TYPE)
    const media = useEditor.getState().project.media.find((m) => m.id === mediaId)
    if (media) void placeMedia(media, placement)
    else void importDrop(e.dataTransfer, placement)
  }

  // The ruler covers the comp and any layer that runs past its end.
  const endMs = Math.max(durationMs, ...tracks.flatMap((t) => t.layers.map(layerEnd)))
  const px = (ms: number) => (ms / 1000) * pxPerSecond

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <Toolbar onFit={fit} mixerHidden={!simple && !mixer} onShowMixer={() => setMixer(true)} simple={simple} />
        {view === 'keyframes' && <DopeSheet />}
        {view === 'curves' && <CurvesView />}
        {view === 'color' && <ColorView />}
        {view === 'nodes' && <NodesView />}
        {view === 'timeline' && (
          <div className="flex min-h-0 flex-1 overflow-y-auto border-t border-line">
            <div className="shrink-0 border-r border-line" style={{ width: HEADER_WIDTH }}>
              <div className="border-b border-line" style={{ height: RULER_HEIGHT }} />
              {tracks.map((track, index) => (
                <div
                  key={track.id}
                  className={`group flex items-center gap-1 border-b border-app pr-1.5 ${track.hidden ? 'opacity-60' : ''}`}
                  style={{ height: LANE_HEIGHT, paddingLeft: 12 + laneDepth(comp, track) * 14 }}
                >
                  {groupOnLane(track) && <Group size={13} className="shrink-0 text-clip-group" aria-hidden />}
                  <WorldLaneIcon track={track} />
                  <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{trackLabel(track, index)}</span>
                  {track.layers.length === 0 && (
                    <button
                      type="button"
                      onClick={() => void run('track.delete', { id: track.id })}
                      className="flex size-6 items-center justify-center rounded-md text-muted opacity-0 hover:bg-hover hover:text-ink group-hover:opacity-100"
                      aria-label={`Delete empty ${trackLabel(track, index)}`}
                      title="Delete this empty track"
                    >
                      <X size={13} />
                    </button>
                  )}
                  {!simple && <TrackToggles track={track} label={trackLabel(track, index)} />}
                </div>
              ))}
            </div>

            <div ref={scrollRef} className="relative min-w-0 flex-1 overflow-x-auto">
              <div
                ref={contentRef}
                className="relative min-h-full"
                style={{ width: px(endMs) + 160 }}
                onDragOver={onDragOver}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) useEditor.getState().setGuide(null)
                }}
                onDrop={onDrop}
              >
                <Ruler endMs={endMs} markers={comp.markers} onScrub={(clientX) => useEditor.getState().seek(geometry.msAt(clientX))} />
                <div ref={lanesRef}>
                  {tracks.map((track) => (
                    <div
                      key={track.id}
                      className={`relative border-b border-app bg-lane ${track.hidden ? 'opacity-50' : ''}`}
                      style={{ height: LANE_HEIGHT }}
                      onPointerDown={() => useEditor.getState().select(null)}
                    >
                      {track.layers.map((layer) => (
                        <TimelineClip key={layer.id} layer={layer} geometry={geometry} locked={track.locked} />
                      ))}
                      <TransitionMarkers track={track} />
                    </div>
                  ))}
                </div>
                <p className="px-3 py-2.5 text-[11px] text-muted">
                  {tracks.length === 0
                    ? 'Drop video, images or audio here, or add a layer from the Library.'
                    : 'Drop files here for a new track.'}
                </p>

                {/* Comp end marker, drag guides and playhead */}
                <div className="pointer-events-none absolute inset-y-0 w-px bg-muted/40" style={{ left: px(durationMs) }} />
                <WorkRangeBand geometry={geometry} />
                <Guides tracks={tracks.length} />
                <Playhead scroller={scrollRef} />
              </div>
            </div>
          </div>
        )}
      </div>
      {mixer && !simple && <Mixer onClose={() => setMixer(false)} />}
    </div>
  )
}
