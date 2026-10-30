import { compsOnPage, type Comp, type Page } from '@uve/core'
import { Box, ChevronDown, ChevronRight, CopyPlus, FileText, Frame, Image as ImageIcon, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { newWorld, openFrame, run, useEditor } from '../store'

// Pages and their frames, at the top of the Layers tab: switch frames, add,
// rename, duplicate or delete them, make one static (a thumbnail, a poster) or
// a timeline, and keep them on pages. Every action is a command.

/** A name that edits in place: double-click to type, Enter to keep, Escape to leave. */
function NameField({ value, onCommit, className }: { value: string; onCommit: (name: string) => void; className?: string }) {
  const [draft, setDraft] = useState<string | null>(null)
  if (draft === null) {
    return (
      <span className={`min-w-0 flex-1 truncate ${className ?? ''}`} onDoubleClick={() => setDraft(value)} title="Double-click to rename">
        {value}
      </span>
    )
  }
  const finish = (keep: boolean) => {
    const name = draft.trim()
    setDraft(null)
    if (keep && name !== '' && name !== value) onCommit(name)
  }
  return (
    <input
      // biome-ignore lint/a11y/noAutofocus: the field appears because the user asked to rename
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(true)
        else if (e.key === 'Escape') finish(false)
        e.stopPropagation()
      }}
      aria-label="Name"
      className="min-w-0 flex-1 rounded bg-field px-1 text-[11px] text-ink outline-none ring-1 ring-accent"
    />
  )
}

const Icon = ({ children, label, onClick, danger }: { children: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) => (
  <button
    type="button"
    onClick={(e) => {
      e.stopPropagation()
      onClick()
    }}
    aria-label={label}
    title={label}
    className={`flex size-6 shrink-0 items-center justify-center rounded-md text-muted opacity-0 group-hover:opacity-100 hover:bg-hover ${danger ? 'hover:text-red-300' : 'hover:text-ink'}`}
  >
    {children}
  </button>
)

function FrameRow({ comp, active, onlyFrame }: { comp: Comp; active: boolean; onlyFrame: boolean }) {
  const isStatic = comp.mode === 'static'
  return (
    <li
      onClick={() => openFrame(comp.id)}
      className={`group flex h-8 cursor-default items-center gap-2 rounded-lg pr-1 pl-3 ${active ? 'active-tint' : 'hover:bg-hover'}`}
    >
      {isStatic ? <ImageIcon size={13} className="shrink-0 text-muted" aria-hidden /> : <Frame size={13} className="shrink-0 text-muted" aria-hidden />}
      <NameField value={comp.name} onCommit={(name) => void run('frame.update', { id: comp.id, name })} className={`text-[11px] ${active ? 'font-medium' : 'text-ink'}`} />
      <span className="shrink-0 text-[10px] text-muted tabular-nums">
        {comp.width}×{comp.height}
      </span>
      <Icon
        label={isStatic ? 'Make ' + comp.name + ' a timeline again' : 'Make ' + comp.name + ' a static frame at the playhead'}
        onClick={() => void run('frame.update', { id: comp.id, mode: isStatic ? 'timeline' : 'static' })}
      >
        {isStatic ? <Frame size={13} /> : <ImageIcon size={13} />}
      </Icon>
      <Icon label={'Duplicate ' + comp.name} onClick={() => void run('frame.duplicate', { id: comp.id }).then((r) => r.ok && openFrame((r.value as { id: string }).id))}>
        <CopyPlus size={13} />
      </Icon>
      {!onlyFrame && (
        <Icon label={'Delete ' + comp.name} danger onClick={() => void run('frame.delete', { id: comp.id })}>
          <Trash2 size={13} />
        </Icon>
      )}
    </li>
  )
}

function PageBlock({ page, frames, activeId, pageCount, open, onToggle, others }: { page: Page; frames: Comp[]; activeId: string; pageCount: number; open: boolean; onToggle: () => void; others: Page[] }) {
  const Chevron = open ? ChevronDown : ChevronRight
  const total = useEditor((s) => s.project.comps.filter((c) => !c.embedded).length)
  return (
    <section>
      <div className="group flex h-8 items-center gap-1.5 rounded-lg pr-1 pl-1.5 hover:bg-hover/60">
        <button type="button" onClick={onToggle} aria-expanded={open} aria-label={(open ? 'Fold ' : 'Open ') + page.name} className="flex size-5 items-center justify-center text-muted hover:text-ink">
          <Chevron size={13} />
        </button>
        <FileText size={13} className="shrink-0 text-muted" aria-hidden />
        <NameField value={page.name} onCommit={(name) => void run('page.update', { id: page.id, name })} className="text-[11px] font-semibold" />
        <span className="shrink-0 text-[10px] text-muted">{frames.length}</span>
        <Icon label={'Add a frame to ' + page.name} onClick={() => void run('frame.create', { pageId: page.id }).then((r) => r.ok && openFrame((r.value as { id: string }).id))}>
          <Plus size={13} />
        </Icon>
        {pageCount > 1 && (
          <Icon
            label={'Delete ' + page.name + (frames.length > 0 ? ' (its frames move to ' + (others[0]?.name ?? 'another page') + ')' : '')}
            danger
            onClick={() => void run('page.delete', frames.length > 0 ? { id: page.id, moveTo: others[0]?.id } : { id: page.id })}
          >
            <Trash2 size={13} />
          </Icon>
        )}
      </div>
      {open && (
        <ul>
          {frames.map((comp) => (
            <FrameRow key={comp.id} comp={comp} active={comp.id === activeId} onlyFrame={total === 1} />
          ))}
          {frames.length === 0 && <li className="pl-8 text-[10px] text-muted">No frames on this page.</li>}
        </ul>
      )}
    </section>
  )
}

/** The pages of the project, each with its frames. */
export function PagesSection() {
  const project = useEditor((s) => s.project)
  const activeId = useEditor((s) => s.activeCompId)
  // What the user opened or folded; a page they did not touch is open when it holds the frame in view or is the only one.
  const [opened, setOpened] = useState<Record<string, boolean>>({})
  return (
    <div className="border-b border-line px-2 pb-2">
      <div className="flex h-9 items-center gap-1 pl-2">
        <h3 className="min-w-0 flex-1 truncate text-[11px] font-semibold tracking-wider text-muted uppercase">Pages</h3>
        <button
          type="button"
          onClick={() => void newWorld()}
          aria-label="Add a 3D world"
          title="Add a 3D world: a frame where layers have depth, with a camera and lights"
          className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[10px] font-medium text-muted hover:bg-hover hover:text-ink"
        >
          <Box size={13} aria-hidden />
          3D world
        </button>
        <button
          type="button"
          onClick={() => void run('page.create', { name: 'Page ' + (project.pages.length + 1) })}
          aria-label="Add a page"
          title="Add a page"
          className="flex size-6 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-ink"
        >
          <Plus size={14} />
        </button>
      </div>
      <div className="space-y-0.5">
        {project.pages.map((page) => {
          const frames = compsOnPage(project, page)
          const open = opened[page.id] ?? (frames.some((c) => c.id === activeId) || project.pages.length === 1)
          return (
            <PageBlock
              key={page.id}
              page={page}
              frames={frames}
              activeId={activeId}
              pageCount={project.pages.length}
              open={open}
              onToggle={() => setOpened({ ...opened, [page.id]: !open })}
              others={project.pages.filter((p) => p.id !== page.id)}
            />
          )
        })}
      </div>
    </div>
  )
}
