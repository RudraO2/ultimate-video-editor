import { motionKeysOf } from '@uve/core'
import { useEffect, useRef } from 'react'
import { findLayer, useEditor } from '../store'
import { isSmooth, setMotionPoint } from './motionGestures'

const ITEMS = [
  { op: 'smooth', label: 'Make smooth (curved)' },
  { op: 'corner', label: 'Make corner (straight)' },
  { op: 'delete', label: 'Delete motion point' },
] as const

/** The context menu of a motion point, opened by right-clicking its diamond on the viewport. */
export function MotionMenu() {
  const menu = useEditor((s) => s.motionMenu)
  const project = useEditor((s) => s.project)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return
    const close = () => useEditor.setState({ motionMenu: null })
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  if (!menu) return null
  const layer = findLayer(project, menu.layerId)
  const row = layer && motionKeysOf(layer).find((r) => Math.abs(layer.startMs + r.t - menu.atMs) < 0.5)
  if (!layer || !row) return null
  const smooth = isSmooth(row)

  return (
    <div
      ref={root}
      role="menu"
      aria-label="Motion point"
      className="fixed z-50 min-w-52 rounded-panel border border-line bg-card p-1 shadow-float"
      style={{ left: menu.x, top: menu.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {ITEMS.map(({ op, label }) => (
        <button
          key={op}
          type="button"
          role="menuitem"
          // A corner has no handles to take off; smoothing a smooth point again refits its handles to the neighbours.
          disabled={op === 'corner' && !smooth}
          onClick={() => {
            useEditor.setState({ motionMenu: null })
            void setMotionPoint(menu.layerId, menu.atMs, op)
          }}
          className="flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-[12px] text-ink hover:bg-hover disabled:text-muted disabled:hover:bg-transparent"
        >
          {label}
        </button>
      ))}
    </div>
  )
}
