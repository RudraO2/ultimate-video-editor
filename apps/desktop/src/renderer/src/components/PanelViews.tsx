import { type Layer, type PropertySpec, propertiesOf } from '@uve/core'
import { resolveLayer } from '@uve/engine'
import { AudioLines, Network, Palette, PanelBottom, SlidersHorizontal, Spline, X } from '../icons'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { preview } from '../media/preview'
import { type BottomView, useEditor, useSelectedLayer } from '../store'

const TABS: { id: BottomView; label: string; icon: typeof PanelBottom; title: string }[] = [
  { id: 'timeline', label: 'Timeline', icon: PanelBottom, title: 'Tracks and clips' },
  { id: 'keyframes', label: 'Keyframes', icon: SlidersHorizontal, title: 'Dope sheet: every keyframe as a grid' },
  { id: 'curves', label: 'Curves', icon: Spline, title: 'Graph editor: values and easing over time' },
  { id: 'color', label: 'Color', icon: Palette, title: 'Colour grading' },
  { id: 'nodes', label: 'Nodes', icon: Network, title: 'The selected layer as a node graph' },
]

/** The tabs under the timeline panel that pick its view. Keyframes and Curves keep Timeline lit, as they edit its keys. */
export function BottomTabs() {
  const view = useEditor((s) => s.bottomView)
  return (
    <div role="tablist" className="flex h-11 shrink-0 items-center justify-center gap-1">
      {TABS.map(({ id, label, icon: Icon, title }) => {
        const on = view === id || (id === 'timeline' && (view === 'keyframes' || view === 'curves'))
        return (
          <div key={id} className="flex items-center">
            {id === 'color' && <div className="mx-2 h-5 w-px bg-line" />}
            <button
              type="button"
              role="tab"
              aria-selected={view === id}
              title={title}
              onClick={() => useEditor.setState({ bottomView: id })}
              className={`flex h-8 items-center gap-2 rounded-panel px-3 text-[12px] ${
                on ? `active-tint ${view === id ? 'ring-1 ring-accent/40' : ''}` : 'text-muted hover:bg-hover hover:text-ink'
              }`}
            >
              <Icon size={15} aria-hidden />
              {label}
            </button>
          </div>
        )
      })}
    </div>
  )
}

/** Colour: grading arrives with the effects work; until then the view says so plainly. */
export function ColorView() {
  const layer = useSelectedLayer()
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 border-t border-line text-center">
      <Palette size={26} className="text-muted" aria-hidden />
      <p className="text-[12px] text-muted">{layer ? `No grade on “${layer.name}” yet.` : 'Select a layer to grade it.'}</p>
      <button
        type="button"
        disabled
        title="Colour grading (lift, gamma, gain, white balance, LUTs) arrives with the effects step"
        className="h-8 rounded-panel bg-accent/25 px-4 text-[12px] font-medium text-accent opacity-60"
      >
        Start grading
      </button>
      <p className="text-[10px] text-muted/70">Grading nodes come with the effects step (see docs/atomcut-parity.md).</p>
    </div>
  )
}

interface GraphNode {
  title: string
  rows: [label: string, value: string][]
}

function formatValue(spec: PropertySpec | undefined, value: unknown): string {
  if (typeof value === 'number') return String(Number(value.toFixed(spec?.max === 1 ? 2 : 1)))
  if (typeof value === 'string') return value.length > 18 ? `${value.slice(0, 17)}…` : value
  if (typeof value === 'boolean') return value ? 'on' : 'off'
  return '—'
}

/** The selected layer's values, gathered into nodes: the layer, its transform and its content. */
function layerNodes(layer: Layer, timeMs: number): GraphNode[] {
  const resolved = resolveLayer(layer, timeMs)
  const specs = new Map(propertiesOf(layer).map((s) => [s.path, s]))
  const transform = Object.entries(resolved.transform).map(([k, v]) => [k, formatValue(specs.get(`transform.${k}`), v)] as [string, string])
  const nodes: GraphNode[] = [
    {
      title: 'Layer',
      rows: [
        ['name', layer.name],
        ['kind', layer.kind],
        ['start', `${(layer.startMs / 1000).toFixed(2)} s`],
        ['duration', `${(layer.durationMs / 1000).toFixed(2)} s`],
        ['shown', layer.enabled ? 'on' : 'off'],
      ],
    },
    { title: 'Transform', rows: transform },
  ]
  if (layer.kind === 'text' && resolved.style) {
    nodes.push({ title: 'Typography', rows: Object.entries(resolved.style).map(([k, v]) => [k, formatValue(specs.get(`style.${k}`), v)]) })
  }
  if (layer.kind === 'shape' && resolved.shape) {
    nodes.push({ title: 'Shape', rows: Object.entries(resolved.shape).map(([k, v]) => [k, formatValue(specs.get(`shape.${k}`), v)]) })
  }
  if (layer.kind === 'video' || layer.kind === 'audio') {
    nodes.push({
      title: 'Playback',
      rows: [
        ['in point', `${(layer.sourceStartMs / 1000).toFixed(2)} s`],
        ['speed', `${layer.playbackRate}×`],
        ['volume', formatValue(undefined, resolved.volume ?? layer.volume)],
        ['muted', layer.muted ? 'on' : 'off'],
      ],
    })
  }
  return nodes
}

const NODE_W = 188

/** Nodes: the selected layer as a small read-only graph, its values live at the playhead. */
export function NodesView() {
  const layer = useSelectedLayer()
  const timeMs = useEditor((s) => s.timeMs)
  // The graph scales down to fit the panel.
  const [box, boxRef] = useState<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    if (!box) return
    const observer = new ResizeObserver(() => setSize({ width: box.clientWidth, height: box.clientHeight }))
    observer.observe(box)
    return () => observer.disconnect()
  }, [box])
  if (!layer) {
    return (
      <div ref={boxRef} className="flex h-full items-center justify-center border-t border-line text-[12px] text-muted">
        Select a layer to see its nodes.
      </div>
    )
  }
  const [source, ...outputs] = layerNodes(layer, timeMs)
  const rowH = 17
  const nodeH = (n: GraphNode) => 30 + n.rows.length * rowH + 8
  const outputsTop = outputs.reduce<number[]>((tops, n, i) => [...tops, i === 0 ? 16 : (tops[i - 1] ?? 0) + nodeH(outputs[i - 1] as GraphNode) + 16], [])
  const totalH = Math.max(nodeH(source as GraphNode) + 32, (outputsTop[outputsTop.length - 1] ?? 0) + nodeH(outputs[outputs.length - 1] as GraphNode) + 16)
  const sourceTop = Math.max(16, (totalH - nodeH(source as GraphNode)) / 2)
  const node = (n: GraphNode, x: number, y: number) => (
    <div key={n.title} className="absolute rounded-lg bg-card ring-1 ring-line" style={{ left: x, top: y, width: NODE_W }}>
      <div className="flex h-7 items-center gap-1.5 border-b border-line px-2.5 text-[11px] font-semibold">
        <span className="size-1.5 rounded-full bg-accent" />
        {n.title}
      </div>
      <div className="py-1">
        {n.rows.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between gap-2 px-2.5 font-mono text-[10px]" style={{ height: rowH }}>
            <span className="truncate text-muted">{label}</span>
            <span className="truncate text-ink/90">{value}</span>
          </div>
        ))}
      </div>
    </div>
  )
  const graphWidth = NODE_W * 2 + 120
  const scale = Math.min(1, (size.width - 32) / graphWidth, (size.height - 60) / totalH) || 1
  return (
    <div
      ref={boxRef}
      className="relative h-full overflow-hidden border-t border-line"
      style={{ backgroundImage: 'radial-gradient(rgb(255 255 255 / 9%) 1px, transparent 1px)', backgroundSize: '14px 14px' }}
    >
      <div className="glass absolute top-2 left-2 z-10 flex h-8 items-center gap-2 rounded-panel px-3 text-[11px]">
        <span className="size-2 rounded-full bg-accent" />
        <span className="text-muted">Layer</span>
        <span className="font-semibold">{layer.name}</span>
      </div>
      <div
        className="absolute left-1/2 origin-top"
        style={{ width: graphWidth, height: totalH, top: 48, transform: `translateX(-50%) scale(${Math.max(0.2, scale)})` }}
      >
        <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
          {outputs.map((n, i) => {
            const x1 = NODE_W
            const y1 = sourceTop + 14
            const x2 = NODE_W + 120
            const y2 = (outputsTop[i] ?? 0) + 14
            return <path key={n.title} d={`M${x1} ${y1} C${x1 + 60} ${y1}, ${x2 - 60} ${y2}, ${x2} ${y2}`} fill="none" style={{ stroke: 'var(--color-accent)' }} strokeOpacity="0.6" strokeWidth="1.5" />
          })}
        </svg>
        {source && node(source, 0, sourceTop)}
        {outputs.map((n, i) => node(n, NODE_W + 120, outputsTop[i] ?? 0))}
      </div>
    </div>
  )
}

const METER_FLOOR_DB = -60

/** The mixer column: the preview's master level, metered while it plays. */
export function Mixer({ onClose }: { onClose: () => void }) {
  const playing = useEditor((s) => s.playing)
  const [db, setDb] = useState(Number.NEGATIVE_INFINITY)
  const [peak, setPeak] = useState(Number.NEGATIVE_INFINITY)
  const peakAt = useRef(0)
  useEffect(() => {
    if (!playing) {
      setDb(Number.NEGATIVE_INFINITY)
      return
    }
    let frame = 0
    const tick = () => {
      const level = preview.level()
      setDb(level)
      const now = performance.now()
      // The peak mark holds for a second, then falls back.
      setPeak((p) => {
        if (level >= p || now - peakAt.current > 1000) {
          peakAt.current = now
          return level
        }
        return p
      })
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing])
  const fill = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, (v - METER_FLOOR_DB) / -METER_FLOOR_DB)) : 0)
  return (
    <div className="flex w-36 shrink-0 flex-col border-l border-line">
      <div className="flex h-12 items-center gap-1 px-3">
        <span className="text-[11px] font-semibold tracking-wider text-muted">MIX</span>
        <span className="active-tint ml-1 flex h-6 items-center gap-1 rounded-panel px-2 text-[11px]" title="Master level of the preview">
          <AudioLines size={12} aria-hidden />
          Level
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Hide the mixer"
          title="Hide the mixer"
          className="ml-auto flex size-6 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-ink"
        >
          <X size={13} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center gap-2 border-t border-line px-3 py-3">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold">
          <span className="h-2.5 w-1 rounded-full bg-ink" />
          Master
        </span>
        <div className="relative min-h-0 w-4 flex-1 overflow-hidden rounded-full bg-field" title="Preview level (dBFS)">
          <div
            className="absolute inset-x-0 bottom-0 rounded-full bg-gradient-to-t from-clip-audio via-clip-image to-accent"
            style={{ height: `${fill(db) * 100}%` }}
          />
          <div className="absolute inset-x-0 h-0.5 bg-accent" style={{ bottom: `${fill(peak) * 100}%` }} />
        </div>
        <span className="font-mono text-[11px] text-muted tabular-nums">{Number.isFinite(peak) ? peak.toFixed(1) : '-∞'}</span>
      </div>
    </div>
  )
}
