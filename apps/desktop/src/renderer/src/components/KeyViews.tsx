import {
  type Easing,
  EASING_PRESETS,
  ease,
  evaluateProperty,
  hasCurves,
  type Keyframe,
  type Layer,
  layerEnd,
  type PropertySpec,
  graphemes,
  propertiesOf,
  sampleKeys,
} from '@uve/core'
import { ChevronDown, ChevronRight, Diamond, Eye, EyeOff, ListMinus, Spline } from 'lucide-react'
import { type PointerEvent as ReactPointerEvent, type ReactNode, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { activeComp, beginGesture, type Gesture, run, useActiveComp, useEditor, useSelectedLayer } from '../store'
import { Playhead, Ruler, RULER_HEIGHT } from './Timeline'

// The key editors under the timeline: the dope sheet (Keyframes) and the
// graph editor (Curves). Both edit the selected layer's keys through
// keyframes.set and keyframes.remove, one undo step per click or drag.

const ROW = 28
const HEAD = 188
/** A press must move this far before it becomes a drag rather than a click. */
const DRAG_PX = 3

/** Colours by property, as in the dope sheet's dots and the curves. */
const COLORS: Record<string, string> = {
  'transform.x': '#f5a524',
  'transform.y': '#4cc3e0',
  'transform.z': '#7c9dff',
  'transform.scaleX': '#9d8bff',
  'transform.scaleY': '#ff6bb5',
  'transform.rotation': '#46d39a',
  'transform.rotationX': '#e8b04b',
  'transform.rotationY': '#5ee0b0',
  'transform.opacity': '#f1eaee',
  'transform.anchorX': '#b9c2d6',
  'transform.anchorY': '#8c818a',
}
const FALLBACK_COLORS = ['#ff9d3d', '#b48cff', '#5ee0b0', '#ff86c8', '#9db4ff']

const LABELS: Record<string, string> = {
  'transform.x': 'X',
  'transform.y': 'Y',
  'transform.z': 'Depth',
  'transform.scaleX': 'Scale X',
  'transform.scaleY': 'Scale Y',
  'transform.rotation': 'Rotation',
  'transform.rotationX': 'Tilt',
  'transform.rotationY': 'Turn',
  'transform.opacity': 'Opacity',
  'transform.anchorX': 'Pivot X',
  'transform.anchorY': 'Pivot Y',
}

const PAINT_PARTS: Record<string, string> = {
  color: 'colour',
  opacity: 'opacity',
  width: 'width',
  dashLength: 'dash',
  dashGap: 'gap',
  dashOffset: 'dash offset',
  'trim.start': 'trim start',
  'trim.end': 'trim end',
  'trim.offset': 'trim offset',
}

/** "Fill 2 opacity", "Stroke trim end", "Fill stop 1": paint keys named by position, not id. */
function paintLabel(layer: Layer, path: string): string | undefined {
  const range = /^range\.([^.]+)\.(color|opacity|fontSize)$/.exec(path)
  if (range && layer.kind === 'text') {
    const r = layer.ranges.find((x) => x.id === range[1])
    const words = r ? graphemes(layer.text).slice(r.start, r.end).join('') : '…'
    return `“${words}” ${range[2] === 'fontSize' ? 'size' : range[2] === 'color' ? 'colour' : 'opacity'}`
  }
  const match = /^(fill|stroke)\.([^.]+)(?:\.(.+))?$/.exec(path)
  if (!match || !('fills' in layer)) return undefined
  const [, kind, id, rest] = match
  const strokes = 'strokes' in layer ? layer.strokes : []
  const list: { id: string }[] = kind === 'fill' ? layer.fills : strokes
  const index = list.findIndex((p) => p.id === id)
  const name = `${kind === 'fill' ? 'Fill' : 'Stroke'}${list.length > 1 ? ` ${index + 1}` : ''}`
  if (!rest) return name
  const stop = /^stop\.([^.]+)\.(color|offset)$/.exec(rest)
  if (stop) {
    const paint = kind === 'fill' ? layer.fills[index] : strokes[index]?.paint
    const stops = paint && paint.type !== 'solid' ? paint.stops : []
    return `${name} stop ${stops.findIndex((s) => s.id === stop[1]) + 1}${stop[2] === 'offset' ? ' position' : ''}`
  }
  return `${name} ${PAINT_PARTS[rest] ?? rest}`
}

interface Prop {
  spec: PropertySpec
  keys: Keyframe[]
  color: string
  label: string
  group: 'Transform' | 'Other'
}

/** The selected layer's animated properties, in the inspector's order. */
function animatedProps(layer: Layer): Prop[] {
  let other = 0
  return propertiesOf(layer)
    .filter((spec) => (layer.animations[spec.path]?.length ?? 0) > 0)
    .map((spec) => {
      const transform = spec.path.startsWith('transform.')
      const color = COLORS[spec.path] ?? FALLBACK_COLORS[other++ % FALLBACK_COLORS.length] ?? '#fff'
      const label = LABELS[spec.path] ?? paintLabel(layer, spec.path) ?? spec.alias.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())
      return { spec, keys: layer.animations[spec.path] ?? [], color, label, group: transform ? 'Transform' : 'Other' }
    })
}

/** The command that replaces a property's keys; motion-path handles go along (a key moved off its y partner loses them). */
function setKeys(layerId: string, path: string, keys: Keyframe[]) {
  const sorted = [...keys].sort((a, b) => a.t - b.t)
  const shaped = sorted.map(({ t, v, ease, spatial }) => ({ t, v, ...(ease ? { ease } : {}), ...(spatial ? { spatial } : {}) }))
  return { command: 'keyframes.set', input: { id: layerId, path, mode: 'replace', keys: shaped } }
}

/** Retimes the keys at `times` (layer time) by `delta` ms on each property, as batch calls. */
function moveKeyCalls(layer: Layer, paths: string[], from: number, to: number) {
  // x goes last: moving y first drops x's handles, and the x call writes them back from this snapshot.
  const ordered = [...paths.filter((p) => p !== 'transform.x'), ...paths.filter((p) => p === 'transform.x')]
  return ordered.flatMap((path) => {
    const keys = layer.animations[path] ?? []
    if (!keys.some((k) => Math.abs(k.t - from) < 0.5)) return []
    // A key moved onto another one replaces it.
    const rest = keys.filter((k) => Math.abs(k.t - from) >= 0.5 && Math.abs(k.t - to) >= 0.5)
    const moved = keys.filter((k) => Math.abs(k.t - from) < 0.5).map((k) => ({ ...k, t: to }))
    return [setKeys(layer.id, path, [...rest, ...moved])]
  })
}

/** A layer time moved onto the nearest comp frame, inside the layer, without float noise. */
function onFrame(layer: Layer, t: number, frameMs: number): number {
  const snapped = Math.round((layer.startMs + t) / frameMs) * frameMs - layer.startMs
  return Math.round(Math.max(0, Math.min(layer.durationMs, snapped)) * 1000) / 1000
}

/** Drags a key (or a group key, which moves its children's keys) along time, snapped to frames. */
function startKeyDrag(e: ReactPointerEvent, layer: Layer, paths: string[], t: number, pxPerMs: number) {
  if (e.button !== 0) return
  e.stopPropagation()
  e.preventDefault()
  const target = e.currentTarget as HTMLElement
  const state = useEditor.getState()
  const fps = activeComp(state).fps
  const frameMs = 1000 / fps
  state.seek(layer.startMs + t)
  useEditor.setState({ selectedKey: { layerId: layer.id, path: paths[0] ?? '', t } })
  const origin = e.clientX
  let gesture: Gesture | null = null
  let at = t

  const move = (ev: PointerEvent) => {
    if (!gesture) {
      if (Math.abs(ev.clientX - origin) < DRAG_PX) return
      gesture = beginGesture('Move key')
    }
    const raw = t + (ev.clientX - origin) / pxPerMs
    // Keys land on frames, inside the layer.
    const next = onFrame(layer, raw, frameMs)
    if (Math.abs(next - at) < 0.5) return
    // Always rewrite from the keys as they were when the drag began: queued moves may not have applied yet.
    gesture.request('api.batch', { calls: moveKeyCalls(layer, paths, t, next) })
    at = next
    useEditor.setState({ selectedKey: { layerId: layer.id, path: paths[0] ?? '', t: next } })
    useEditor.getState().seek(layer.startMs + next)
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

/** Deletes the key picked in the Keyframes or Curves view. Returns false when there is none. */
export function deleteSelectedKey(): boolean {
  const { selectedKey } = useEditor.getState()
  if (!selectedKey) return false
  void run('keyframes.remove', { id: selectedKey.layerId, path: selectedKey.path, times: [selectedKey.t] })
  useEditor.setState({ selectedKey: null })
  return true
}

/** A tiny drawing of an easing, shown between two keys. */
function EaseGlyph({ easing, color }: { easing: Easing | undefined; color: string }) {
  const d = useMemo(() => {
    if (easing === 'hold') return 'M1 13 H8 V3 H15'
    const points = Array.from({ length: 9 }, (_, i) => {
      const p = i / 8
      return `${(1 + p * 14).toFixed(1)} ${(13 - ease(easing ?? 'linear', p) * 10).toFixed(1)}`
    })
    return `M${points.join(' L')}`
  }, [easing])
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="pointer-events-none">
      <path d={d} fill="none" stroke={color} strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function EmptyState({ children }: { children: ReactNode }) {
  return <div className="flex h-full items-center justify-center text-[12px] text-muted">{children}</div>
}

/** Simplify: rewrites the layer's tracks of 3 or more keys as the fewest keys that play the same. */
async function simplifyKeys(layerId: string): Promise<void> {
  const result = await run('keyframes.simplify', { id: layerId })
  if (!result.ok) return
  const { tracks } = result.value as { tracks: { before: number; after: number }[] }
  const changed = tracks.filter((t) => t.after < t.before)
  const notify = useEditor.getState().notify
  if (changed.length === 0) {
    notify('Nothing to simplify: every track is already as small as it gets.')
    return
  }
  const before = changed.reduce((sum, t) => sum + t.before, 0)
  const after = changed.reduce((sum, t) => sum + t.after, 0)
  notify(`Simplified ${before} keys to ${after} on ${changed.length} ${changed.length === 1 ? 'property' : 'properties'}.`)
}

/** Smooth: continuous motion through every key of the layer (Catmull-Rom handles and monotone easings). */
async function smoothKeys(layerId: string): Promise<void> {
  const result = await run('keyframes.smooth', { id: layerId })
  if (!result.ok) return
  const { tracks } = result.value as { tracks: { path: string }[] }
  useEditor.getState().notify(`Smoothed ${tracks.length} ${tracks.length === 1 ? 'property' : 'properties'}.`)
}

/** The shared frame of both key views: a property column and a scrolling time area with a ruler and playhead. */
function KeyFrame({
  layer,
  left,
  children,
  height,
}: {
  layer: Layer
  left: ReactNode
  children: (px: (ms: number) => number) => ReactNode
  height: number
}) {
  const comp = useActiveComp()
  const pxPerSecond = useEditor((s) => s.pxPerSecond)
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const endMs = Math.max(comp.durationMs, layerEnd(layer))
  const px = (ms: number) => (ms / 1000) * pxPerSecond
  const scrub = (clientX: number) => {
    const rect = contentRef.current?.getBoundingClientRect()
    if (rect) useEditor.getState().seek(((clientX - rect.left) / pxPerSecond) * 1000)
  }
  return (
    <div className="flex min-h-0 flex-1 overflow-y-auto border-t border-line">
      <div className="shrink-0 border-r border-line" style={{ width: HEAD }}>
        <div className="flex items-center justify-end gap-1 border-b border-line px-2" style={{ height: RULER_HEIGHT }}>
          <button
            type="button"
            onClick={() => void smoothKeys(layer.id)}
            className="flex h-6 items-center gap-1 rounded-lg px-2 text-[11px] font-medium text-muted hover:bg-hover hover:text-ink"
            title="Continuous motion across the selection — removes the pause at every keyframe"
          >
            <Spline size={13} />
            Smooth
          </button>
          <button
            type="button"
            onClick={() => void simplifyKeys(layer.id)}
            className="flex h-6 items-center gap-1 rounded-lg px-2 text-[11px] font-medium text-muted hover:bg-hover hover:text-ink"
            title="Simplify keys: keep the fewest keys that play the same"
          >
            <ListMinus size={13} />
            Simplify
          </button>
        </div>
        {left}
      </div>
      <div ref={scrollRef} className="relative min-w-0 flex-1 overflow-x-auto">
        <div ref={contentRef} className="relative" style={{ width: px(endMs) + 160, minHeight: '100%' }}>
          <Ruler endMs={endMs} onScrub={scrub} />
          {/* The layer's own time range. */}
          <div
            className="pointer-events-none absolute bg-accent/[0.07]"
            style={{ left: px(layer.startMs), width: px(layer.durationMs), top: RULER_HEIGHT, height }}
          />
          <div
            className="relative"
            style={{ height }}
            onPointerDown={(e) => {
              if (e.button === 0) {
                useEditor.setState({ selectedKey: null })
                scrub(e.clientX)
              }
            }}
          >
            {children(px)}
          </div>
          <div className="pointer-events-none absolute inset-y-0 w-px bg-muted/40" style={{ left: px(comp.durationMs) }} />
          <Playhead scroller={scrollRef} />
        </div>
      </div>
    </div>
  )
}

function KeyDiamond({
  x,
  color,
  selected,
  title,
  onPointerDown,
  hollow,
}: {
  x: number
  color: string
  selected: boolean
  title: string
  onPointerDown: (e: ReactPointerEvent) => void
  hollow?: boolean
}) {
  return (
    <button
      type="button"
      title={title}
      onPointerDown={onPointerDown}
      className="absolute top-1/2 flex size-4 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize items-center justify-center"
      style={{ left: x }}
    >
      <Diamond
        size={11}
        strokeWidth={2.2}
        style={{ color: selected ? '#ff4e6a' : color, fill: selected ? '#ff4e6a' : hollow ? 'transparent' : color }}
      />
    </button>
  )
}

/** Keyframes: every key of the selected layer as a grid, one row per property, grouped. */
export function DopeSheet() {
  const layer = useSelectedLayer()
  const selectedKey = useEditor((s) => s.selectedKey)
  const [closed, setClosed] = useState<Record<string, boolean>>({})
  if (!layer) return <EmptyState>Select a layer to see its keyframes.</EmptyState>
  const props = animatedProps(layer)
  if (props.length === 0) return <EmptyState>No keyframes yet. Click a ◇ in the inspector, or turn on Record keyframes.</EmptyState>

  type Row = { kind: 'layer' } | { kind: 'group'; name: string; props: Prop[] } | { kind: 'prop'; prop: Prop }
  const rows: Row[] = [{ kind: 'layer' }]
  for (const name of ['Transform', 'Other'] as const) {
    const members = props.filter((p) => p.group === name)
    if (members.length === 0) continue
    rows.push({ kind: 'group', name, props: members })
    if (!closed[name]) for (const prop of members) rows.push({ kind: 'prop', prop })
  }
  const pxPerMs = useEditor.getState().pxPerSecond / 1000
  const isSelected = (path: string | null, t: number) =>
    selectedKey?.layerId === layer.id && Math.abs(selectedKey.t - t) < 0.5 && (path === null || selectedKey.path === path)

  return (
    <KeyFrame
      layer={layer}
      height={rows.length * ROW}
      left={rows.map((row, i) => {
        if (row.kind === 'layer') {
          return (
            <div key="layer" className="flex items-center truncate border-b border-app px-3 text-[11px] font-semibold" style={{ height: ROW }}>
              {layer.name}
            </div>
          )
        }
        if (row.kind === 'group') {
          const Icon = closed[row.name] ? ChevronRight : ChevronDown
          return (
            <button
              key={`g-${row.name}`}
              type="button"
              onClick={() => setClosed({ ...closed, [row.name]: !closed[row.name] })}
              className="flex w-full items-center gap-1.5 border-b border-app px-3 text-[11px] text-ink/90 hover:bg-hover"
              style={{ height: ROW }}
            >
              <Icon size={13} className="text-muted" />
              {row.name}
            </button>
          )
        }
        return (
          <div key={`p-${row.prop.spec.path}-${i}`} className="flex items-center gap-2 border-b border-app pl-8 text-[11px]" style={{ height: ROW }}>
            <span className="size-1.5 rounded-full" style={{ background: row.prop.color }} />
            {row.prop.label}
          </div>
        )
      })}
    >
      {(px) =>
        rows.map((row, i) => {
          const top = i * ROW
          if (row.kind === 'layer') return <div key="layer" className="absolute inset-x-0 border-b border-app" style={{ top, height: ROW }} />
          const props = row.kind === 'group' ? row.props : [row.prop]
          const paths = props.map((p) => p.spec.path)
          const times = [...new Set(props.flatMap((p) => p.keys.map((k) => k.t)))].sort((a, b) => a - b)
          const prop = row.kind === 'prop' ? row.prop : null
          return (
            <div key={`${row.kind}-${i}`} className="absolute inset-x-0 border-b border-app" style={{ top, height: ROW }}>
              {/* Easing glyphs between a property's keys. */}
              {prop?.keys.slice(0, -1).map((key, k) => {
                const next = prop.keys[k + 1]
                if (!next || px(next.t - key.t) < 36) return null
                return (
                  <div
                    key={`e-${key.t}`}
                    className="absolute top-1/2 flex h-px -translate-y-1/2 items-center justify-center"
                    style={{ left: px(layer.startMs + key.t) + 8, width: px(next.t - key.t) - 16, background: `${prop.color}55` }}
                  >
                    <span className="rounded bg-panel px-0.5">
                      <EaseGlyph easing={key.ease} color={prop.color} />
                    </span>
                  </div>
                )
              })}
              {times.map((t) => (
                <KeyDiamond
                  key={t}
                  x={px(layer.startMs + t)}
                  color={prop ? prop.color : '#c9bfc7'}
                  hollow={!prop}
                  selected={isSelected(prop ? prop.spec.path : null, t)}
                  title={`${prop ? prop.label : row.kind === 'group' ? row.name : ''} key at ${((layer.startMs + t) / 1000).toFixed(2)} s. Drag to move, Delete removes it.`}
                  onPointerDown={(e) => startKeyDrag(e, layer, paths, t, pxPerMs)}
                />
              ))}
            </div>
          )
        })
      }
    </KeyFrame>
  )
}

const EASE_LABELS: Record<(typeof EASING_PRESETS)[number], string> = {
  linear: 'Linear',
  hold: 'Hold',
  'ease-in': 'Ease in',
  'ease-out': 'Ease out',
  'ease-in-out': 'Ease in-out',
  'ease-in-back': 'Back in',
  'ease-out-back': 'Back out',
  'ease-out-quart': 'Quart out',
  'ease-out-expo': 'Expo out',
  'ease-in-out-back': 'Back in-out',
  'ease-out-elastic': 'Elastic out',
}

/**
 * The value of a curve at layer time t. A position curve on a layer with motion-path
 * handles is the Bezier's x(t) or y(t), so it comes from evaluateProperty; every other
 * curve is the plain interpolation of its keys.
 */
function curveValue(layer: Layer, p: Prop, t: number) {
  if (hasCurves(layer) && (p.spec.path === 'transform.x' || p.spec.path === 'transform.y')) return evaluateProperty(layer, p.spec, t)
  return sampleKeys(p.keys, t)
}

/** The value range a curve is drawn in: its keys' and its sampled values', padded when flat. */
function rangeOf(layer: Layer, p: Prop): [number, number] {
  const keys = p.keys
  const values: number[] = []
  if (keys.length > 0) {
    const first = keys[0]?.t ?? 0
    const last = keys[keys.length - 1]?.t ?? 0
    for (let i = 0; i <= 64; i++) {
      const v = curveValue(layer, p, first + ((last - first) * i) / 64)
      if (typeof v === 'number') values.push(v)
    }
  }
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  if (!Number.isFinite(lo)) return [0, 1]
  return hi - lo < 1e-6 ? [lo - 1, hi + 1] : [lo, hi]
}

/** Curves: each animated number as a curve, normalised to its own range, with draggable keys. */
export function CurvesView() {
  const layer = useSelectedLayer()
  const hidden = useEditor((s) => s.hiddenCurves)
  const selectedKey = useEditor((s) => s.selectedKey)
  // The plot fills the panel's height.
  const [root, rootRef] = useState<HTMLDivElement | null>(null)
  const [available, setAvailable] = useState(0)
  useLayoutEffect(() => {
    if (!root) return
    const observer = new ResizeObserver(() => setAvailable(root.clientHeight))
    observer.observe(root)
    return () => observer.disconnect()
  }, [root])
  const props = layer ? animatedProps(layer).filter((p) => p.spec.type === 'number') : []
  if (!layer || props.length === 0) {
    return (
      <div ref={rootRef} className="min-h-0 flex-1">
        <EmptyState>{layer ? 'No animated numbers yet. Key a property to draw its curve.' : 'Select a layer to see its curves.'}</EmptyState>
      </div>
    )
  }
  const height = Math.max(120, available - RULER_HEIGHT - 2, props.length * ROW + 2 * ROW)
  const pad = 18
  const y = (v: number, [lo, hi]: [number, number]) => pad + (1 - (v - lo) / (hi - lo)) * (height - 2 * pad)
  const selected = props.find((p) => selectedKey?.layerId === layer.id && p.spec.path === selectedKey.path)
  const selectedFrame = selected?.keys.find((k) => Math.abs(k.t - (selectedKey?.t ?? -1)) < 0.5)

  const setEase = (easing: Easing) => {
    if (!selected || !selectedFrame) return
    void run('api.batch', {
      calls: [setKeys(layer.id, selected.spec.path, selected.keys.map((k) => (k === selectedFrame ? { ...k, ease: easing } : k)))],
    })
  }

  /** Drags a key in time and value; the value scale is the one the drag started with. */
  const dragValue = (e: ReactPointerEvent, prop: Prop, key: Keyframe, range: [number, number]) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const target = e.currentTarget as HTMLElement
    const state = useEditor.getState()
    const pxPerMs = state.pxPerSecond / 1000
    const frameMs = 1000 / activeComp(state).fps
    state.seek(layer.startMs + key.t)
    useEditor.setState({ selectedKey: { layerId: layer.id, path: prop.spec.path, t: key.t } })
    const origin = { x: e.clientX, y: e.clientY }
    const perPx = (range[1] - range[0]) / (height - 2 * pad)
    let gesture: Gesture | null = null
    let at = key.t
    const move = (ev: PointerEvent) => {
      if (!gesture) {
        if (Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) < DRAG_PX) return
        gesture = beginGesture('Edit key')
      }
      const t = onFrame(layer, key.t + (ev.clientX - origin.x) / pxPerMs, frameMs)
      const raw = (key.v as number) - (ev.clientY - origin.y) * perPx
      const v = Number(raw.toFixed(prop.spec.max !== undefined && prop.spec.max <= 1 ? 3 : 1))
      const others = prop.keys.filter((k) => k !== key && Math.abs(k.t - t) >= 0.5)
      gesture.request('api.batch', { calls: [setKeys(layer.id, prop.spec.path, [...others, { ...key, t, v }])] })
      at = t
      useEditor.setState({ selectedKey: { layerId: layer.id, path: prop.spec.path, t: at } })
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
      // See startKeyDrag.
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', finish)
    target.addEventListener('pointercancel', finish)
    target.addEventListener('lostpointercapture', finish)
  }

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
      <KeyFrame
        layer={layer}
        height={height}
        left={
          <div>
            <div className="flex h-7 items-center px-3 text-[10px] font-semibold tracking-wider text-muted uppercase">Transform</div>
            {props.map((p, i) => (
              <div key={p.spec.path}>
                {p.group === 'Other' && props[i - 1]?.group !== 'Other' && (
                  <div className="flex h-7 items-center px-3 text-[10px] font-semibold tracking-wider text-muted uppercase">Other</div>
                )}
                <div className={`group flex items-center gap-2 pr-1.5 pl-3 text-[11px] ${hidden[p.spec.path] ? 'text-muted' : ''}`} style={{ height: ROW }}>
                  <span className="size-2 rounded-full" style={{ background: hidden[p.spec.path] ? 'transparent' : p.color, boxShadow: `inset 0 0 0 1.5px ${p.color}` }} />
                  <span className="flex-1 truncate">{p.label}</span>
                  <button
                    type="button"
                    onClick={() => useEditor.setState({ hiddenCurves: { ...hidden, [p.spec.path]: !hidden[p.spec.path] } })}
                    aria-label={hidden[p.spec.path] ? `Show the ${p.label} curve` : `Hide the ${p.label} curve`}
                    className="flex size-6 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-ink"
                  >
                    {hidden[p.spec.path] ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                </div>
              </div>
            ))}
            {selected && selectedFrame && (
              <label className="mt-2 flex items-center gap-2 px-3 text-[11px] text-muted" title="How the value moves towards the next key">
                Ease
                <select
                  aria-label="Ease of the selected key"
                  value={typeof selectedFrame.ease === 'string' ? selectedFrame.ease : 'linear'}
                  onChange={(e) => setEase(e.target.value as Easing)}
                  className="h-7 min-w-0 flex-1 rounded-lg bg-field px-1.5 text-[11px] text-ink outline-none"
                >
                  {EASING_PRESETS.map((name) => (
                    <option key={name} value={name}>
                      {EASE_LABELS[name]}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        }
      >
        {(px) => (
          <div className="absolute inset-0">
            <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
              {[0.25, 0.5, 0.75].map((f) => (
                <line key={f} x1="0" x2="100%" y1={pad + f * (height - 2 * pad)} y2={pad + f * (height - 2 * pad)} stroke="rgb(255 255 255 / 4%)" />
              ))}
              {props
                .filter((p) => !hidden[p.spec.path])
                .map((p) => {
                  const range = rangeOf(layer, p)
                  const first = p.keys[0]?.t ?? 0
                  const last = p.keys[p.keys.length - 1]?.t ?? 0
                  const steps = Math.max(2, Math.ceil(px(last - first) / 3))
                  const pts: string[] = []
                  for (let i = 0; i <= steps; i++) {
                    const t = first + ((last - first) * i) / steps
                    const v = curveValue(layer, p, t)
                    if (typeof v === 'number') pts.push(`${px(layer.startMs + t).toFixed(1)},${y(v, range).toFixed(1)}`)
                  }
                  const v0 = p.keys[0]?.v as number
                  const v1 = p.keys[p.keys.length - 1]?.v as number
                  return (
                    <g key={p.spec.path}>
                      <polyline points={pts.join(' ')} fill="none" stroke={p.color} strokeWidth="1.6" />
                      {/* Held before the first key and after the last. */}
                      <line x1={px(layer.startMs)} x2={px(layer.startMs + first)} y1={y(v0, range)} y2={y(v0, range)} stroke={p.color} strokeOpacity="0.35" strokeDasharray="3 3" />
                      <line x1={px(layer.startMs + last)} x2={px(layerEnd(layer))} y1={y(v1, range)} y2={y(v1, range)} stroke={p.color} strokeOpacity="0.35" strokeDasharray="3 3" />
                    </g>
                  )
                })}
            </svg>
            {props
              .filter((p) => !hidden[p.spec.path])
              .flatMap((p) => {
                const range = rangeOf(layer, p)
                return p.keys.map((key) => {
                  const on = selectedKey?.layerId === layer.id && selectedKey.path === p.spec.path && Math.abs(selectedKey.t - key.t) < 0.5
                  return (
                    <button
                      key={`${p.spec.path}-${key.t}`}
                      type="button"
                      title={`${p.label}: ${Number((key.v as number).toFixed(3))} at ${((layer.startMs + key.t) / 1000).toFixed(2)} s. Drag to move, Delete removes it.`}
                      onPointerDown={(e) => dragValue(e, p, key, range)}
                      className="absolute size-3 -translate-x-1/2 -translate-y-1/2 cursor-move rounded-full border-2"
                      style={{ left: px(layer.startMs + key.t), top: y(key.v as number, range), borderColor: on ? '#ff4e6a' : p.color, background: on ? '#ff4e6a' : '#100c11' }}
                    />
                  )
                })
              })}
          </div>
        )}
      </KeyFrame>
    </div>
  )
}
