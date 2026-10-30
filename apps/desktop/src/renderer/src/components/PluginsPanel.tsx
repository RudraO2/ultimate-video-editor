import { Search, Shapes, Type } from 'lucide-react'
import { useState } from 'react'
import { type PluginId, useEditor } from '../store'

// The Plugins tab: tools that open a window of their own over the editor.

const PLUGINS: { id: PluginId; name: string; blurb: string; icon: typeof Type }[] = [
  { id: 'icons', name: 'Icons', blurb: 'Every open-source icon set, placed as vector layers that draw on', icon: Shapes },
  { id: 'fonts', name: 'Fonts', blurb: 'Every Google font, your own files, set big and starred', icon: Type },
]

export function PluginsPanel() {
  const [query, setQuery] = useState('')
  const open = useEditor((s) => s.plugin)
  const q = query.trim().toLowerCase()
  const shown = PLUGINS.filter((p) => !q || (p.name + ' ' + p.blurb).toLowerCase().includes(q))
  return (
    <div className="flex h-full flex-col">
      <div className="p-3 pb-2">
        <label className="flex h-8 items-center gap-2 rounded-lg bg-field px-2.5 text-muted focus-within:ring-1 focus-within:ring-accent">
          <Search size={14} aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search plugins"
            aria-label="Search plugins"
            className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-muted"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-3">
        <p className="px-1 pt-1 pb-1 text-[10px] font-semibold tracking-wide text-muted uppercase">Library</p>
        {shown.map(({ id, name, blurb, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => useEditor.setState({ plugin: id, pluginFolded: false })}
            aria-pressed={open === id}
            className={`flex w-full items-center gap-3 rounded-panel p-2 text-left ${open === id ? 'active-tint' : 'hover:bg-hover'}`}
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-field text-muted">
              <Icon size={18} aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="block text-[12px] font-semibold">{name}</span>
              <span className="block truncate text-[11px] text-muted">{blurb}</span>
            </span>
          </button>
        ))}
        {shown.length === 0 && <p className="px-1 text-[11px] text-muted">No plugin matches “{query}”.</p>}
      </div>
    </div>
  )
}
