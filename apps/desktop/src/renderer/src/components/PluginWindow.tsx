import { Minus, Square, X } from '../icons'
import type { IconComponent } from '../icons'
import type { ReactNode } from 'react'
import { useEditor } from '../store'

/**
 * A plugin's window, floating over the editor: a title bar with fold and
 * close, and the plugin's own content below. One plugin is open at a time
 * (`plugin` in the store); folding keeps it open as just its title bar.
 */
export function PluginWindow({ title, icon: Icon, children }: { title: string; icon: IconComponent; children: ReactNode }) {
  const folded = useEditor((s) => s.pluginFolded)
  return (
    <div
      role="dialog"
      aria-label={title}
      className={`glass fixed top-12 left-[76px] z-40 flex flex-col overflow-hidden rounded-panel border border-line shadow-2xl ${
        folded ? 'w-72' : 'right-[96px] bottom-8 max-w-[1040px]'
      }`}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 px-3">
        <span className="flex size-6 items-center justify-center rounded-md bg-field text-muted">
          <Icon size={14} aria-hidden />
        </span>
        <h2 className="min-w-0 flex-1 truncate text-[12px] font-semibold">{title}</h2>
        <button
          type="button"
          onClick={() => useEditor.setState((s) => ({ pluginFolded: !s.pluginFolded }))}
          aria-label={folded ? 'Unfold' : 'Fold'}
          title={folded ? 'Unfold' : 'Fold to the title bar'}
          className="flex size-6 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-ink"
        >
          {folded ? <Square size={12} /> : <Minus size={13} />}
        </button>
        <button
          type="button"
          onClick={() => useEditor.setState({ plugin: null, pluginFolded: false })}
          aria-label={`Close ${title}`}
          title="Close"
          className="flex size-6 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-ink"
        >
          <X size={14} />
        </button>
      </div>
      {!folded && <div className="flex min-h-0 flex-1 gap-2 p-2 pt-0">{children}</div>}
    </div>
  )
}
