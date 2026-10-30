import { animationWindow, findAnimationPreset, type Layer, layerEnd, slotAnimation } from '@uve/core'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { activeComp, beginGesture, enterNested, type Gesture, useEditor } from '../store'
import { LIVE_PILL, useIsLiveCamera } from './kindIcons'
import { nearestFreeStart, snapShift, snapTargets, trackOf, trimLimits } from '../timeline/edit'

export const LANE_HEIGHT = 48
/** Edges within this many pixels of a snap target jump to it. Hold Alt to place freely. */
const SNAP_PX = 8
/** A press must move this far before it becomes a drag rather than a click. */
const DRAG_PX = 3

const CLIP_COLORS: Record<Layer['kind'], string> = {
  text: 'border-clip-text/70 bg-clip-text/22',
  shape: 'border-clip-shape/70 bg-clip-shape/22',
  image: 'border-clip-image/70 bg-clip-image/22',
  video: 'border-clip-video/70 bg-clip-video/22',
  audio: 'border-clip-audio/70 bg-clip-audio/22',
  group: 'border-clip-group/70 bg-clip-group/18 border-dashed',
  path: 'border-clip-path/70 bg-clip-path/22',
  nested: 'border-clip-nested/70 bg-clip-nested/22',
  camera: 'border-clip-video/70 bg-clip-video/22',
  light: 'border-clip-shape/70 bg-clip-shape/22',
  empty: 'border-clip-group/70 bg-clip-group/18',
  mesh: 'border-clip-shape/70 bg-clip-shape/22',
}

/** Converts pointer positions to timeline positions. */
export interface TimelineGeometry {
  /** Comp time under a client x. */
  msAt(clientX: number): number
  /** Track index under a client y: below 0 above the first track, `tracks.length` or more below the last. */
  trackAt(clientY: number): number
  /** The element that holds pointer capture during drags; it outlives any one clip. */
  captureTarget(): HTMLElement | null
}

/** Distinct key times of a layer, relative to its start, for the markers on its clip. */
function keyTimes(layer: Layer): number[] {
  const times = new Set<number>()
  for (const keys of Object.values(layer.animations)) for (const key of keys) times.add(key.t)
  return [...times].filter((t) => t >= 0 && t <= layer.durationMs)
}

type Grip = 'move' | 'start' | 'end'

/**
 * Starts dragging a clip's body (move, also to another track) or one of its
 * edges (trim). The edits apply live through commands inside one gesture, so
 * the whole drag is a single undo step.
 */
function startDrag(e: ReactPointerEvent, layer: Layer, grip: Grip, geometry: TimelineGeometry): void {
  const target = geometry.captureTarget()
  if (e.button !== 0 || !target) return
  e.stopPropagation()
  e.preventDefault()
  const state = useEditor.getState()
  if (e.shiftKey) {
    // Shift-click adds to the selection (for grouping) and does not drag.
    state.select(layer.id, true)
    return
  }
  state.select(layer.id)

  const comp = activeComp(state)
  const media = 'mediaId' in layer ? state.project.media.find((m) => m.id === layer.mediaId) : undefined
  const snapTolerance = (SNAP_PX / state.pxPerSecond) * 1000
  const targets = snapTargets(comp, state.timeMs, layer.id)
  const limits = trimLimits(comp, layer, media, 1000 / comp.fps)
  const grabOffsetMs = geometry.msAt(e.clientX) - layer.startMs
  const origin = { x: e.clientX, y: e.clientY }
  let gesture: Gesture | null = null
  let placed = { startMs: layer.startMs, trackId: trackOf(comp, layer.id)?.id ?? '' }
  let newTrack: 'front' | 'back' | null = null

  const move = (ev: PointerEvent) => {
    if (!gesture) {
      if (Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) < DRAG_PX) return
      gesture = beginGesture(grip === 'move' ? 'Move layer' : 'Trim layer')
    }
    const free = ev.altKey || !useEditor.getState().snapping
    if (grip === 'move') {
      const tracks = activeComp(useEditor.getState()).tracks
      const wanted = Math.max(0, geometry.msAt(ev.clientX) - grabOffsetMs)
      const snap = free ? { shift: 0, at: null } : snapShift([wanted, wanted + layer.durationMs], targets, snapTolerance)
      // A group keeps its lane, and no other layer can land on a group's lane.
      const index = layer.kind === 'group' ? tracks.findIndex((t) => t.id === placed.trackId) : geometry.trackAt(ev.clientY)
      newTrack = index < 0 ? 'front' : index >= tracks.length ? 'back' : null
      const lane = (newTrack ? tracks.find((t) => t.id === placed.trackId) : tracks[index]) ?? tracks[0]
      if (layer.kind !== 'group' && lane?.layers.some((l) => l.kind === 'group')) return
      const fit = lane ? nearestFreeStart(lane, Math.max(0, wanted + snap.shift), layer.durationMs, layer.id, snapTolerance * 3) : null
      useEditor.getState().setGuide({
        snapMs: fit !== null && snap.at !== null && (fit === snap.at || fit + layer.durationMs === snap.at) ? snap.at : null,
        trackIndex: newTrack ? null : index,
        newTrack,
      })
      if (!lane || fit === null || (fit === placed.startMs && lane.id === placed.trackId)) return
      placed = { startMs: fit, trackId: lane.id }
      gesture.request('timeline.move', layer.kind === 'group' ? { id: layer.id, startMs: fit } : { id: layer.id, startMs: fit, trackId: lane.id })
      return
    }
    const [min, max] = grip === 'start' ? limits.start : limits.end
    const wanted = geometry.msAt(ev.clientX)
    const snap = free ? { shift: 0, at: null } : snapShift([wanted], targets, snapTolerance)
    const edge = Math.min(max, Math.max(min, wanted + snap.shift))
    useEditor.getState().setGuide({ snapMs: snap.at === edge ? edge : null, trackIndex: null, newTrack: null })
    gesture.request('timeline.trim', grip === 'start' ? { id: layer.id, startMs: edge } : { id: layer.id, endMs: edge })
  }

  const finish = async () => {
    target.removeEventListener('pointermove', move)
    target.removeEventListener('pointerup', finish)
    target.removeEventListener('pointercancel', finish)
    target.removeEventListener('lostpointercapture', finish)
    if (target.hasPointerCapture(e.pointerId)) target.releasePointerCapture(e.pointerId)
    useEditor.getState().setGuide(null)
    const done = gesture
    gesture = null
    if (!done) return
    if (grip === 'move' && newTrack) {
      // Dropped above or below every track: the clip gets a track of its own there.
      const tracks = activeComp(useEditor.getState()).tracks
      const created = await done.call('track.create', { compId: comp.id, index: newTrack === 'front' ? 0 : tracks.length })
      if (created.ok) {
        const trackId = (created.value as { id: string }).id
        await done.call('timeline.move', { id: layer.id, startMs: placed.startMs, trackId })
      }
    }
    await done.end()
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

/** The clip's entrance and exit presets: where each runs in the layer, and its name. */
function animationBands(layer: Layer) {
  return (['text', 'layer'] as const).flatMap((target) =>
    (['in', 'out'] as const).flatMap((slot) => {
      const spec = slotAnimation(layer, target, slot)
      const window = spec ? animationWindow(layer, target, slot) : null
      if (!spec || !window) return []
      const name = findAnimationPreset(spec.preset)?.label ?? spec.preset
      return [{ key: `${target}-${slot}`, ...window, label: target === 'text' ? `${name} · ${spec.unit}` : name }]
    }),
  )
}

/** A layer on its lane. On a locked track it can be selected but not moved or trimmed. */
export function TimelineClip({ layer, geometry, locked }: { layer: Layer; geometry: TimelineGeometry; locked: boolean }) {
  const pxPerSecond = useEditor((s) => s.pxPerSecond)
  const selected = useEditor((s) => s.selectedLayerId === layer.id || s.alsoSelected.includes(layer.id))
  const thumbnail = useEditor((s) => {
    if (layer.kind !== 'video' && layer.kind !== 'image') return undefined
    const path = s.project.media.find((m) => m.id === layer.mediaId)?.path
    return path ? s.thumbnails[path] : undefined
  })
  const px = (ms: number) => (ms / 1000) * pxPerSecond
  const width = Math.max(4, px(layer.durationMs))
  const bands = animationBands(layer)
  const live = useIsLiveCamera(layer)

  return (
    <div
      role="button"
      tabIndex={-1}
      onPointerDown={(e) => {
        if (!locked) startDrag(e, layer, 'move', geometry)
        else {
          e.stopPropagation()
          useEditor.getState().select(layer.id)
        }
      }}
      onDoubleClick={layer.kind === 'nested' ? () => enterNested(layer.id) : undefined}
      title={`${layer.name} · ${(layer.startMs / 1000).toFixed(2)}–${(layerEnd(layer) / 1000).toFixed(2)} s\nDrag to move, drag an edge to trim. Hold Alt to turn off snapping.${layer.kind === 'nested' ? ' Double-click to edit the comp inside.' : ''}`}
      className={`group absolute top-1 bottom-1 flex items-start overflow-hidden pt-1 rounded-lg border text-left text-[11px] font-medium ${locked ? 'cursor-not-allowed' : 'cursor-grab active:cursor-grabbing'} ${CLIP_COLORS[layer.kind]} ${
        selected ? 'ring-2 ring-accent' : ''
      } ${layer.enabled ? '' : 'opacity-40'}`}
      style={{ left: px(layer.startMs), width }}
    >
      {thumbnail && width > 48 && (
        <img src={thumbnail} alt="" draggable={false} className="h-full w-auto max-w-16 shrink-0 object-cover opacity-80" />
      )}
      <span className="flex min-w-0 flex-col px-2 leading-tight">
        <span className="flex min-w-0 items-center gap-1">
          <span className="truncate">{layer.name}</span>
          {live && (
            <span title="The camera this world is seen through at the playhead" className={LIVE_PILL}>
              Live
            </span>
          )}
        </span>
        {/* A second line, as in AtomCut: the entrance ("TYPEWRITER · LETTER") or the kind, and how many properties are animated. */}
        <span className="truncate font-mono text-[9px] font-normal tracking-wide text-ink/50 uppercase">
          {bands[0]?.label ?? layer.kind}
          {Object.keys(layer.animations).length > 0 && ` · ${Object.keys(layer.animations).length} animated`}
        </span>
      </span>
      {bands.map((band) => (
        <span
          key={band.key}
          title={band.label}
          className="pointer-events-none absolute top-0 h-1 rounded-full bg-accent/70"
          style={{ left: px(band.startMs), width: Math.max(2, px(band.endMs - band.startMs)) }}
        />
      ))}
      {keyTimes(layer).map((t) => (
        <span
          key={t}
          className="pointer-events-none absolute bottom-0.5 size-1.5 -translate-x-1/2 rotate-45 bg-ink/80"
          style={{ left: px(t) }}
        />
      ))}
      {!locked && (['start', 'end'] as const).map((edge) => (
        <span
          key={edge}
          onPointerDown={(e) => startDrag(e, layer, edge, geometry)}
          className={`absolute inset-y-0 w-1.5 cursor-ew-resize bg-ink/0 group-hover:bg-ink/25 hover:!bg-accent ${
            edge === 'start' ? 'left-0' : 'right-0'
          }`}
        />
      ))}
    </div>
  )
}
