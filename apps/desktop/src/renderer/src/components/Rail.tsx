import { AudioLines, Clapperboard, Download, Image as ImageIcon, Layers, LibraryBig, type LucideIcon, MessageCircle, Puzzle, Redo2, SlidersHorizontal, Sparkles, SquareCode, Undo2, Volume2, Wand2, Waypoints } from 'lucide-react'
import type { ReactNode } from 'react'
import { openExportSetup } from './ExportSetupDialog'
import { MainMenu } from './MainMenu'
import { type LeftTab, MODE_TABS, type RightTab, session, type UiMode, useEditor } from '../store'

const TABS: { id: LeftTab; label: string; icon: LucideIcon }[] = [
  { id: 'chat', label: 'Chat', icon: MessageCircle },
  { id: 'library', label: 'Library', icon: LibraryBig },
  { id: 'media', label: 'Media', icon: ImageIcon },
  { id: 'layers', label: 'Layers', icon: Layers },
  { id: 'scripts', label: 'Scripts', icon: SquareCode },
  { id: 'voice', label: 'Voice', icon: AudioLines },
  { id: 'plugins', label: 'Plugins', icon: Puzzle },
  { id: 'agents', label: 'Agents', icon: Sparkles },
]

function RailButton({ label, title, onClick, disabled, children }: {
  label: string
  title: string
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={title}
      className="flex size-10 items-center justify-center rounded-panel text-muted hover:bg-hover hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  )
}

const MODES: { id: UiMode; label: string; title: string; icon: LucideIcon }[] = [
  { id: 'easy', label: 'Easy', title: 'Easy: ask the agent in the chat, watch the preview, export', icon: Wand2 },
  { id: 'advanced', label: 'Advanced', title: 'Advanced: every panel (inspector, keyframes, curves, mixer, all tabs)', icon: SlidersHorizontal },
]

/** Easy or Advanced: both edit the same project, so work carries over when switching. */
function ModeSwitch() {
  const mode = useEditor((s) => s.uiMode)
  return (
    <div role="radiogroup" aria-label="Editor mode" className="mb-2 flex flex-col gap-0.5 rounded-panel bg-field p-0.5">
      {MODES.map(({ id, label, title, icon: Icon }) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={mode === id}
          title={title}
          onClick={() => useEditor.getState().setUiMode(id)}
          className={`flex w-12 flex-col items-center gap-0.5 rounded-lg py-1 text-[9px] ${mode === id ? 'active-tint' : 'text-muted hover:bg-hover hover:text-ink'}`}
        >
          <Icon size={14} aria-hidden />
          {label}
        </button>
      ))}
    </div>
  )
}

/** The left rail: the app mark, the main menu, the mode switch, the mode's left tabs, and undo and redo at the bottom. */
export function LeftRail() {
  const leftTab = useEditor((s) => s.leftTab)
  const mode = useEditor((s) => s.uiMode)
  const { canUndo, canRedo, undoLabel, redoLabel } = useEditor()
  const tabs = MODE_TABS[mode].map((id) => TABS.find((tab) => tab.id === id)).filter((tab) => tab !== undefined)
  return (
    <nav className="flex w-14 shrink-0 flex-col items-center gap-1 py-1.5">
      <div className="mb-2 flex size-10 items-center justify-center text-accent" title="Ultimate Video Editor">
        <Clapperboard size={22} aria-hidden />
      </div>
      <MainMenu />
      <ModeSwitch />
      <div role="tablist" aria-orientation="vertical" className="flex flex-col gap-1">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={leftTab === id}
            onClick={() => useEditor.setState({ leftTab: id })}
            className={`flex w-14 flex-col items-center gap-0.5 rounded-panel py-1.5 text-[9px] ${
              leftTab === id ? 'active-tint' : 'text-muted hover:bg-hover hover:text-ink'
            }`}
          >
            <Icon size={17} aria-hidden />
            {label}
          </button>
        ))}
      </div>
      <div className="mt-auto flex flex-col items-center gap-1">
        <div className="mb-1 h-px w-8 bg-line" />
        <RailButton label="Undo" title={canUndo ? `Undo ${undoLabel} (Ctrl+Z)` : 'Nothing to undo'} onClick={() => session.undo()} disabled={!canUndo}>
          <Undo2 size={17} />
        </RailButton>
        <RailButton label="Redo" title={canRedo ? `Redo ${redoLabel} (Ctrl+Shift+Z)` : 'Nothing to redo'} onClick={() => session.redo()} disabled={!canRedo}>
          <Redo2 size={17} />
        </RailButton>
      </div>
    </nav>
  )
}

/** A right-rail tab: it shows its page in the inspector, or hides the inspector when already shown. */
function RightTabButton({ tab, label, icon: Icon }: { tab: RightTab; label: string; icon: LucideIcon }) {
  const shown = useEditor((s) => s.inspectorOpen && s.rightTab === tab)
  return (
    <button
      type="button"
      role="tab"
      aria-selected={shown}
      onClick={() => useEditor.setState(shown ? { inspectorOpen: false } : { inspectorOpen: true, rightTab: tab })}
      aria-label={label}
      title={shown ? 'Hide the inspector' : `Show ${label}`}
      className={`flex w-9 flex-col items-center gap-1.5 rounded-panel py-2.5 text-[11px] ${shown ? 'active-tint' : 'text-muted hover:bg-hover hover:text-ink'}`}
    >
      <Icon size={15} aria-hidden />
      <span className="[writing-mode:vertical-rl]">{label}</span>
    </button>
  )
}

/** The right rail: Export, and the tabs that pick what the inspector shows (Design or Project, and Animate for a layer); Easy mode has Export only. */
export function RightRail() {
  const exporting = useEditor((s) => s.exportJob !== null)
  const advanced = useEditor((s) => s.uiMode === 'advanced')
  const label = useEditor((s) => (s.selectedLayerId ? 'Design' : 'Project'))
  const animatable = useEditor((s) => s.selectedLayerId !== null)
  return (
    <nav className="flex w-10 shrink-0 flex-col items-center gap-2 py-1.5">
      <button
        type="button"
        onClick={openExportSetup}
        disabled={exporting}
        aria-label="Export"
        title="Export the comp (Ctrl+E)"
        className="flex size-9 items-center justify-center rounded-panel bg-accent/35 text-accent hover:bg-accent/50 disabled:opacity-50"
      >
        <Download size={17} />
      </button>
      {advanced && (
        <>
          <RightTabButton tab="design" label={label} icon={SlidersHorizontal} />
          {animatable && <RightTabButton tab="effects" label="Effects" icon={Sparkles} />}
          {animatable && <RightTabButton tab="animate" label="Animate" icon={Waypoints} />}
          <RightTabButton tab="sound" label="Sound" icon={Volume2} />
        </>
      )}
    </nav>
  )
}
