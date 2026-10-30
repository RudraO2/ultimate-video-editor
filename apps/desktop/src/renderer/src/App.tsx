import { activeWorkRange } from '@uve/core'
import { type ReactNode, useEffect } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { ExportDialog } from './components/ExportDialog'
import { InspectorPanel } from './components/InspectorPanel'
import { AgentsPanel } from './components/AgentsPanel'
import { ChatPanel } from './components/ChatPanel'
import { LayersPanel } from './components/LayersPanel'
import { FontsWindow } from './components/FontsWindow'
import { IconsWindow } from './components/IconsWindow'
import { LibraryPanel } from './components/LibraryPanel'
import { PluginsPanel } from './components/PluginsPanel'
import { ScriptsPanel } from './components/ScriptsPanel'
import { VoicePanel } from './components/VoicePanel'
import { MediaPanel } from './components/MediaPanel'
import { deleteSelectedKey } from './components/KeyViews'
import { BottomTabs } from './components/PanelViews'
import { LeftRail, RightRail } from './components/Rail'
import { splitAtPlayhead, Timeline } from './components/Timeline'
import { orbitKeyDown, Viewport } from './components/Viewport'
import { ExportSetupDialog, openExportSetup } from './components/ExportSetupDialog'
import { askNewProject, askOpenProject, askSaveProject } from './project/file'
import {
  activeComp,
  copySelection,
  duplicateSelection,
  finishPen,
  groupSelection,
  pasteClipboard,
  restackSelection,
  rippleDeleteSelection,
  run,
  session,
  type Tool,
  ungroupSelection,
  useEditor,
} from './store'

/** Viewport tools by key. */
const TOOL_KEYS: Record<string, Tool> = { v: 'move', h: 'hand', t: 'text', r: 'rect', e: 'ellipse', p: 'pen' }

/**
 * Editor-wide shortcuts: project files (Ctrl+N, Ctrl+O, Ctrl+S, Ctrl+Shift+S), duplicate, copy and paste (Ctrl+D, Ctrl+C, Ctrl+V), front and back (Ctrl+Shift+] and Ctrl+Shift+[), tools (V, H, T, R, E), fit the view (Shift+1), undo and redo, export (Ctrl+E), play, delete, split
 * (S), the working range's in and out at the playhead ([ and ]), frame steps (arrows; with Shift a second) and Home/End. Ignored while
 * typing in a field, and while the export dialog is open.
 */
function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Project files work even while typing: the field is committed first by leaving it.
      const fileKey = e.key.toLowerCase()
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (fileKey === 's' || fileKey === 'o' || fileKey === 'n')) {
        e.preventDefault()
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
        if (fileKey === 's') void askSaveProject({ saveAs: e.shiftKey })
        else if (fileKey === 'o') void askOpenProject()
        else void askNewProject()
        return
      }
      if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable="true"]')) return
      const mod = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      const state = useEditor.getState()
      if (state.exportJob || state.exportSetupOpen) return
      const comp = activeComp(state)
      // The orbit view's keys (0, the numpad, Home) come first: in it the orbit meaning wins.
      if (orbitKeyDown(e)) {
        e.preventDefault()
        return
      }
      if (mod && key === 'z') {
        e.preventDefault()
        if (e.shiftKey) session.redo()
        else session.undo()
      } else if (mod && key === 'y') {
        e.preventDefault()
        session.redo()
      } else if (mod && key === 'e') {
        e.preventDefault()
        openExportSetup()
      } else if (mod && key === 'g') {
        e.preventDefault()
        void (e.shiftKey ? ungroupSelection() : groupSelection())
      } else if (mod && key === 'd') {
        e.preventDefault()
        void duplicateSelection()
      } else if (mod && key === 'c') {
        e.preventDefault()
        copySelection()
      } else if (mod && key === 'v') {
        e.preventDefault()
        void pasteClipboard()
      } else if (mod && e.shiftKey && (e.code === 'BracketRight' || e.code === 'BracketLeft')) {
        e.preventDefault()
        void restackSelection(e.code === 'BracketRight' ? 'front' : 'back')
      } else if (mod) {
        return
      } else if (state.pen && (key === 'enter' || key === 'escape')) {
        // The Pen: Enter keeps the path drawn so far (open), Escape drops it.
        e.preventDefault()
        if (key === 'enter') void finishPen(false)
        else useEditor.setState({ pen: null })
      } else if (e.shiftKey && e.code === 'Digit1') {
        e.preventDefault()
        state.setView(null)
      } else if (!e.shiftKey && !e.altKey && key in TOOL_KEYS) {
        e.preventDefault()
        useEditor.setState({ tool: TOOL_KEYS[key], pen: null })
      } else if (e.code === 'Space') {
        e.preventDefault()
        state.togglePlay()
      } else if (key === 'delete' || key === 'backspace') {
        // In the key views, a picked key goes first.
        if ((state.bottomView === 'keyframes' || state.bottomView === 'curves') && deleteSelectedKey()) {
          e.preventDefault()
          return
        }
        if (!state.selectedLayerId) return
        e.preventDefault()
        // Shift: ripple delete, closing the gap it leaves.
        if (e.shiftKey) void rippleDeleteSelection()
        else void run('layers.delete', { ids: [state.selectedLayerId] })
      } else if (key === 's') {
        e.preventDefault()
        void splitAtPlayhead()
      } else if ((e.code === 'BracketLeft' || e.code === 'BracketRight') && !e.shiftKey && !e.altKey) {
        // AtomCut's range.in and range.out: an end of the working range at the playhead.
        e.preventDefault()
        if (comp.mode !== 'static') state.setWorkRangeEdge(e.code === 'BracketLeft' ? 'start' : 'end', state.timeMs)
      } else if (key === 'arrowleft' || key === 'arrowright') {
        e.preventDefault()
        // Step to the neighbouring frame boundary, so the playhead stays on frames.
        const frame = Math.round((state.timeMs * comp.fps) / 1000)
        const step = e.shiftKey ? comp.fps : 1
        state.seek(((frame + (key === 'arrowleft' ? -step : step)) * 1000) / comp.fps)
      } else if (key === 'home' || key === 'end') {
        e.preventDefault()
        state.seek(key === 'home' ? 0 : comp.durationMs)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/**
 * While playing, advances the playhead by the real time between animation
 * frames. Playback stops when the window is hidden, since animation frames
 * stop too and the media would run on alone.
 */
function usePlaybackClock() {
  const playing = useEditor((s) => s.playing)
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') useEditor.setState({ playing: false })
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])
  useEffect(() => {
    if (!playing) return
    let last = performance.now()
    let frame = 0
    const tick = (now: number) => {
      const state = useEditor.getState()
      const comp = activeComp(state)
      const range = activeWorkRange(state.workRange, state.workRangeEnabled, comp.id)
      const end = range?.endMs ?? comp.durationMs
      const next = Math.min(end, state.timeMs + (now - last))
      last = now
      if (next >= end) {
        // With loop on, playback carries on from the start; a working range always loops, as in AtomCut.
        if (state.loop || range) {
          useEditor.setState({ timeMs: range?.startMs ?? 0 })
          frame = requestAnimationFrame(tick)
          return
        }
        useEditor.setState({ timeMs: end, playing: false })
        return
      }
      useEditor.setState({ timeMs: next })
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing])
}

/** Files dropped outside a drop zone are ignored instead of being opened by the window. */
function useDropGuard() {
  useEffect(() => {
    const ignore = (e: DragEvent) => {
      if (!e.defaultPrevented) e.preventDefault()
    }
    window.addEventListener('dragover', ignore)
    window.addEventListener('drop', ignore)
    return () => {
      window.removeEventListener('dragover', ignore)
      window.removeEventListener('drop', ignore)
    }
  }, [])
}

function NoticeToast() {
  const notice = useEditor((s) => s.notice)
  if (!notice) return null
  return (
    <div
      role="status"
      className={`pointer-events-none fixed right-14 bottom-4 z-50 max-w-md rounded-panel border px-3.5 py-2.5 text-[12px] shadow-xl ${
        notice.tone === 'error' ? 'border-red-400/40 bg-red-950/90 text-red-100' : 'glass border-line text-ink'
      }`}
    >
      {notice.text}
    </div>
  )
}

/** A gap between panels that also resizes them. */
function ResizeHandle({ between }: { between: 'columns' | 'rows' }) {
  return (
    <Separator
      className={`${between === 'columns' ? 'w-gap' : 'h-gap'} rounded-full transition-colors hover:bg-accent/40 data-[separator=active]:bg-accent/60`}
    />
  )
}

/** A floating panel. Each panel's content manages its own scrolling, so the panel clips. */
function Card({ children }: { children: ReactNode }) {
  return <div className="h-full overflow-hidden rounded-panel bg-panel shadow-panel">{children}</div>
}

const clip = { overflow: 'hidden' } as const

function LeftPanel() {
  const tab = useEditor((s) => s.leftTab)
  if (tab === 'chat') return <ChatPanel />
  if (tab === 'media') return <MediaPanel />
  if (tab === 'layers') return <LayersPanel />
  if (tab === 'agents') return <AgentsPanel />
  if (tab === 'scripts') return <ScriptsPanel />
  if (tab === 'voice') return <VoicePanel />
  if (tab === 'plugins') return <PluginsPanel />
  return <LibraryPanel />
}

/** The plugin window that is open, over everything else. */
function PluginLayer() {
  const plugin = useEditor((s) => s.plugin)
  if (plugin === 'fonts') return <FontsWindow />
  if (plugin === 'icons') return <IconsWindow />
  return null
}

export function App() {
  useShortcuts()
  usePlaybackClock()
  useDropGuard()
  const easy = useEditor((s) => s.uiMode === 'easy')
  const inspectorOpen = useEditor((s) => s.inspectorOpen) && !easy
  // Easy mode gives the chat more room and the preview more height. Each mode keeps its own layout,
  // so the groups are remounted (with that mode's sizes) when the mode changes.
  const mode = easy ? 'easy' : 'advanced'
  return (
    <div className="flex h-full gap-gap bg-app p-gap pb-0 pl-0">
      <LeftRail />
      <div className="flex min-w-0 flex-1 flex-col">
        <Group key={mode} orientation="vertical" className="min-h-0 flex-1">
          <Panel id="top" defaultSize={easy ? '70' : '64'} minSize={240} style={clip}>
            <Group orientation="horizontal">
              <Panel id="left" defaultSize={easy ? 380 : 280} minSize={220} maxSize={easy ? 560 : 440} style={clip}>
                <Card>
                  <LeftPanel />
                </Card>
              </Panel>
              <ResizeHandle between="columns" />
              <Panel id="viewport" minSize={320} style={clip}>
                <Card>
                  <Viewport />
                </Card>
              </Panel>
              {inspectorOpen && (
                <>
                  <ResizeHandle between="columns" />
                  <Panel id="inspector" defaultSize={320} minSize={260} maxSize={460} style={clip}>
                    <Card>
                      <InspectorPanel />
                    </Card>
                  </Panel>
                </>
              )}
            </Group>
          </Panel>
          <ResizeHandle between="rows" />
          <Panel id="timeline" defaultSize={easy ? '30' : '36'} minSize={easy ? 140 : 180} style={clip}>
            <Card>
              <Timeline simple={easy} />
            </Card>
          </Panel>
        </Group>
        {easy ? <div className="h-gap shrink-0" /> : <BottomTabs />}
      </div>
      <RightRail />
      <PluginLayer />
      <ExportDialog />
      <ExportSetupDialog />
      <NoticeToast />
    </div>
  )
}
