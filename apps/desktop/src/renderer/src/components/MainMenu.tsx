import { isWorld } from '@uve/core'
import { Check, ChevronRight, Menu } from '../icons'
import { useEffect, useRef, useState } from 'react'
import { importFiles } from '../media/import'
import { askNewProject, askOpenProject, askSaveProject, refreshRecentProjects } from '../project/file'
import { activeComp, canMoveIntoWorld, moveSelectionIntoWorld, newWorld, session, useEditor, worldViewOf } from '../store'
import { openExportSetup } from './ExportSetupDialog'

// The main menu, as in AtomCut: a button under the app mark that opens File,
// Edit and View submenus. Only commands that work are listed.

interface Item {
  label: string
  shortcut?: string
  title?: string
  disabled?: boolean
  /** Set on a toggle: shows a check mark when on. */
  checked?: boolean
  onSelect?: () => void
  submenu?: Entry[]
}
type Entry = Item | 'separator'

const SEP = 'separator' as const

async function pickAndImport(): Promise<void> {
  const files = await window.uve.media.pickFiles()
  if (files.length > 0) await importFiles(files)
}

function fileMenu(): Entry[] {
  const { recentProjects } = useEditor.getState()
  const recent: Entry[] =
    recentProjects.length > 0
      ? recentProjects.map((r) => ({ label: r.name, title: r.path, onSelect: () => void askOpenProject(r.path) }))
      : [{ label: 'No recent projects', disabled: true }]
  return [
    { label: 'New project', shortcut: 'Ctrl+N', onSelect: () => void askNewProject() },
    { label: 'Open project…', shortcut: 'Ctrl+O', onSelect: () => void askOpenProject() },
    { label: 'Open recent', submenu: recent },
    SEP,
    { label: 'Save project', shortcut: 'Ctrl+S', onSelect: () => void askSaveProject() },
    { label: 'Save project as…', shortcut: 'Ctrl+Shift+S', onSelect: () => void askSaveProject({ saveAs: true }) },
    SEP,
    { label: 'New 3D world', title: 'A frame where layers have depth, with a camera and lights', onSelect: () => void newWorld() },
    SEP,
    { label: 'Import media…', onSelect: () => void pickAndImport() },
    { label: 'Export…', shortcut: 'Ctrl+E', onSelect: openExportSetup },
  ]
}

function editMenu(): Entry[] {
  const { canUndo, canRedo, undoLabel, redoLabel } = useEditor.getState()
  return [
    { label: canUndo ? `Undo ${undoLabel}` : 'Undo', shortcut: 'Ctrl+Z', disabled: !canUndo, onSelect: () => session.undo() },
    { label: canRedo ? `Redo ${redoLabel}` : 'Redo', shortcut: 'Ctrl+Shift+Z', disabled: !canRedo, onSelect: () => session.redo() },
  ]
}

function layerMenu(): Entry[] {
  return [
    {
      label: 'Move into 3D world',
      title: 'The selected 2D layers stand in a new 3D world; the picture stays the same',
      disabled: !canMoveIntoWorld(),
      onSelect: () => void moveSelectionIntoWorld(),
    },
  ]
}

function viewMenu(): Entry[] {
  const state = useEditor.getState()
  const comp = activeComp(state)
  return [
    { label: 'Easy mode', shortcut: 'chat, preview, export', checked: state.uiMode === 'easy', onSelect: () => useEditor.getState().setUiMode('easy') },
    { label: 'Advanced mode', shortcut: 'every panel', checked: state.uiMode === 'advanced', onSelect: () => useEditor.getState().setUiMode('advanced') },
    { label: 'Light theme', shortcut: 'cream', checked: state.theme === 'light', onSelect: () => useEditor.getState().setTheme('light') },
    { label: 'Dark theme', checked: state.theme === 'dark', onSelect: () => useEditor.getState().setTheme('dark') },
    { label: 'Motion paths', shortcut: 'on selection', checked: useEditor.getState().motionPaths, onSelect: () => useEditor.getState().setMotionPaths(!useEditor.getState().motionPaths) },
    {
      label: 'Orbit view',
      shortcut: '0',
      title: 'Look around a 3D world freely instead of through its camera; the document and exports stay as they are',
      disabled: !isWorld(comp),
      checked: worldViewOf(state, comp.id).orbit,
      onSelect: () => state.toggleOrbit(comp.id),
    },
  ]
}

function MenuList({ entries, close, className }: { entries: Entry[]; close: () => void; className: string }) {
  const [open, setOpen] = useState<number | null>(null)
  // Checkable items keep a fixed slot on the left so labels line up.
  const checkable = entries.some((e) => e !== SEP && e.checked !== undefined)
  return (
    <div role="menu" className={`min-w-52 rounded-panel border border-line bg-card p-1 shadow-float ${className}`}>
      {entries.map((entry, i) => {
        if (entry === SEP) return <div key={`sep-${i}`} role="separator" className="mx-2 my-1 h-px bg-line" />
        const hasSub = entry.submenu !== undefined
        return (
          <div key={entry.label} className="relative" onPointerEnter={() => setOpen(hasSub ? i : null)}>
            <button
              type="button"
              role={entry.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
              aria-checked={entry.checked}
              aria-haspopup={hasSub ? 'menu' : undefined}
              aria-expanded={hasSub ? open === i : undefined}
              disabled={entry.disabled}
              title={entry.title}
              onClick={() => {
                if (hasSub) setOpen(open === i ? null : i)
                else {
                  close()
                  entry.onSelect?.()
                }
              }}
              className={`flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-[12px] text-ink hover:bg-hover disabled:text-muted disabled:hover:bg-transparent ${checkable ? 'gap-2' : 'gap-6'}`}
            >
              {checkable && <span className="flex w-[13px] shrink-0 text-accent">{entry.checked && <Check size={13} aria-hidden />}</span>}
              <span className="max-w-64 flex-1 truncate">{entry.label}</span>
              {entry.shortcut && <span className={`font-mono text-[10px] text-muted ${checkable ? 'ml-4' : ''}`}>{entry.shortcut}</span>}
              {hasSub && <ChevronRight size={13} className="text-muted" aria-hidden />}
            </button>
            {hasSub && open === i && entry.submenu && (
              <MenuList entries={entry.submenu} close={close} className="absolute top-[-5px] left-full ml-1" />
            )}
          </div>
        )
      })}
    </div>
  )
}

/** The Main menu button and its menu. */
export function MainMenu() {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  // Re-render when the recent list or undo state changes while the menu is open.
  useEditor((s) => (open ? `${s.recentProjects.length}|${s.undoLabel}|${s.redoLabel}|${s.motionPaths}|${s.uiMode}|${s.selectedLayerId}|${s.alsoSelected.length}|${s.activeCompId}` : ''))

  useEffect(() => {
    if (!open) return
    void refreshRecentProjects()
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onPointer)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const close = () => setOpen(false)
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-label="Main menu"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Main menu"
        onClick={() => setOpen(!open)}
        className={`flex size-10 items-center justify-center rounded-panel ${open ? 'active-tint' : 'text-muted hover:bg-hover hover:text-ink'}`}
      >
        <Menu size={17} aria-hidden />
      </button>
      {open && (
        <MenuList
          close={close}
          className="absolute top-0 left-full z-50 ml-2"
          entries={[
            { label: 'File', submenu: fileMenu() },
            { label: 'Edit', submenu: editMenu() },
            { label: 'Layer', submenu: layerMenu() },
            { label: 'View', submenu: viewMenu() },
          ]}
        />
      )}
    </div>
  )
}
