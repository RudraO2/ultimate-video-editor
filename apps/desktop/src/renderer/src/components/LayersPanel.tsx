import { groupOnLane, laneDepth, type Layer } from '@uve/core'
import { BringToFront, CopyPlus, Eye, EyeOff, Group, Layers, SendToBack, Ungroup } from 'lucide-react'
import { useCallback, useState } from 'react'
import { duplicateSelection, groupSelection, nestSelection, restackSelection, run, ungroupSelection, useActiveComp, useEditor } from '../store'
import { KIND_COLORS, KIND_ICONS, LIVE_PILL, useIsLiveCamera } from './kindIcons'
import { selectedLifeTarget } from './CharacterSections'
import { PagesSection } from './PagesSection'
import { PhysicsMenu, selectedBodyTargets } from './PhysicsSections'
import { trackLabel, TrackToggles } from './TrackToggles'

function LayerRow({ layer, dimmed, onMenu }: { layer: Layer; dimmed: boolean; onMenu: (at: { x: number; y: number }) => void }) {
  const selected = useEditor((s) => s.selectedLayerId === layer.id || s.alsoSelected.includes(layer.id))
  const Icon = KIND_ICONS[layer.kind]
  const live = useIsLiveCamera(layer)
  return (
    <li
      onPointerDown={(e) => {
        // A right-click on a selected layer keeps the selection, so the menu can act on all of it.
        if (e.button === 2 && selected) return
        useEditor.getState().select(layer.id, e.shiftKey)
      }}
      onContextMenu={(e) => {
        const { selectedLayerId, alsoSelected } = useEditor.getState()
        if (selectedLayerId !== layer.id && !alsoSelected.includes(layer.id)) useEditor.getState().select(layer.id)
        // Only layers that can be physics bodies or characters have a menu; the rest keep the default.
        if (selectedBodyTargets().length === 0 && selectedLifeTarget() === null) return
        e.preventDefault()
        onMenu({ x: e.clientX, y: e.clientY })
      }}
      title="Shift-click to select several (Ctrl+G groups them)"
      className={`group flex h-8 cursor-default items-center gap-2 rounded-lg pr-1 pl-2.5 ${
        selected ? 'active-tint' : 'hover:bg-hover'
      } ${dimmed || !layer.enabled ? 'opacity-50' : ''}`}
    >
      <Icon size={14} className={selected ? '' : KIND_COLORS[layer.kind]} aria-hidden />
      <span className={`min-w-0 flex-1 truncate text-[11px] ${selected ? 'font-medium' : 'text-ink'}`}>{layer.name}</span>
      {live && (
        <span title="The camera this world is seen through at the playhead" className={LIVE_PILL}>
          Live
        </span>
      )}
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => void run('layer.patch', { id: layer.id, ops: [{ op: 'set', path: 'enabled', value: !layer.enabled }] })}
        aria-label={layer.enabled ? `Hide ${layer.name}` : `Show ${layer.name}`}
        title={layer.enabled ? 'Hide this layer' : 'Show this layer'}
        className={`flex size-6 items-center justify-center rounded-md hover:bg-hover ${
          layer.enabled ? 'text-muted opacity-0 group-hover:opacity-100' : 'text-accent'
        }`}
      >
        {layer.enabled ? <Eye size={13} /> : <EyeOff size={13} />}
      </button>
    </li>
  )
}

/** The layers tab: the active comp's tracks, front first, and their layers; a group's lanes sit indented under it. */
export function LayersPanel() {
  const comp = useActiveComp()
  const { tracks, name } = comp
  const selection = useEditor((s) => (s.selectedLayerId === null ? 0 : 1 + s.alsoSelected.length))
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  return (
    <div className="flex h-full flex-col">
      {menu && <PhysicsMenu x={menu.x} y={menu.y} onClose={closeMenu} />}
      <div className="flex h-11 shrink-0 items-center gap-1 pr-2 pl-4">
        <h2 className="min-w-0 flex-1 truncate text-[11px] font-semibold tracking-wider text-muted uppercase">Layers · {name}</h2>
        {(
          [
            ['Duplicate the selected layers (Ctrl+D)', CopyPlus, () => void duplicateSelection()],
            ['Bring the selected layers to the front of their group (Ctrl+Shift+])', BringToFront, () => void restackSelection('front')],
            ['Send the selected layers to the back of their group (Ctrl+Shift+[)', SendToBack, () => void restackSelection('back')],
            ['Nest the selected layers in a comp of their own (precompose); double-click it to edit inside', Layers, () => void nestSelection()],
          ] as const
        ).map(([title, Icon, onClick]) => (
          <button
            key={title}
            type="button"
            onClick={onClick}
            disabled={selection === 0}
            aria-label={title.split(' (')[0]}
            title={title}
            className="flex size-7 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-ink disabled:opacity-40"
          >
            <Icon size={14} />
          </button>
        ))}
        <button
          type="button"
          onClick={() => void groupSelection()}
          disabled={selection === 0}
          aria-label="Group the selected layers"
          title="Group the selected layers (Ctrl+G); Shift-click to select several"
          className="flex size-7 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-ink disabled:opacity-40"
        >
          <Group size={14} />
        </button>
        <button
          type="button"
          onClick={() => void ungroupSelection()}
          disabled={selection === 0}
          aria-label="Ungroup"
          title="Dissolve the selected group, keeping its layers where they are (Ctrl+Shift+G)"
          className="flex size-7 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-ink disabled:opacity-40"
        >
          <Ungroup size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pb-3">
        <PagesSection />
        <div className="space-y-3 px-2">
        {tracks.length === 0 && <p className="px-2 text-[11px] text-muted">No layers yet. Add one from the Library.</p>}
        {tracks.map((track, index) => (
          <section key={track.id} style={{ paddingLeft: laneDepth(comp, track) * 14 }}>
            <div className={`flex items-center justify-between pr-1 pl-2.5 ${groupOnLane(track) ? 'h-0 overflow-hidden' : 'h-7'}`}>
              <span className="truncate text-[10px] font-semibold tracking-wider text-muted uppercase">{trackLabel(track, index)}</span>
              <TrackToggles track={track} label={trackLabel(track, index)} />
            </div>
            <ul>
              {[...track.layers].reverse().map((layer) => (
                <LayerRow key={layer.id} layer={layer} dimmed={track.hidden} onMenu={setMenu} />
              ))}
            </ul>
          </section>
        ))}
        </div>
      </div>
    </div>
  )
}
