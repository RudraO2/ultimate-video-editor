import { ArrowLeft, ArrowRightFromLine, ArrowRightToLine, Clock, LayoutGrid, Plus, Search, Shapes, Star } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { type IconData, type IconSet, ICON_GROUPS, iconGroup, iconIdParts, iconStyleOf, iconSvg, iconTitle } from '../../../shared/icons'
import { DEFAULT_ICON_COLOR, iconPictures, iconSets, placeIcon } from '../library/icons'
import { useEditor } from '../store'
import { PluginWindow } from './PluginWindow'

// The Icons plugin: every open-source icon set, browsed by set or searched
// across all of them, placed as vector layers that draw on. Pictures are
// fetched when they come into view and kept on disk, so what has been seen
// works offline.

type View = { kind: 'all' } | { kind: 'starred' } | { kind: 'recent' } | { kind: 'set'; prefix: string }
type StyleFilter = 'all' | 'line' | 'solid' | 'color'

/** State that outlives the window: choices, stars and recent icons. */
function usePersisted<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      if (raw === null) return initial
      const stored = JSON.parse(raw) as unknown
      // Choices are objects whose new fields keep their defaults; lists come back as they were.
      return Array.isArray(initial) || typeof initial !== 'object' || initial === null ? (stored as T) : ({ ...initial, ...(stored as object) } as T)
    } catch {
      return initial
    }
  })
  return [
    value,
    (next) => {
      setValue(next)
      try {
        localStorage.setItem(key, JSON.stringify(next))
      } catch {
        // Storage may be unavailable: the choice then lasts only this session.
      }
    },
  ]
}

interface Options {
  color: string
  size: number
  /** The line width in the icon's own units, or null for the set's own. */
  strokeWidth: number | null
  drawIn: boolean
  drawOut: boolean
}

const DEFAULT_OPTIONS: Options = { color: DEFAULT_ICON_COLOR, size: 128, strokeWidth: null, drawIn: true, drawOut: false }

/** The pictures of icons, loaded as the ids change; an icon not loaded yet is undefined. */
function usePictures(ids: readonly string[]): Record<string, IconData | null | undefined> {
  const [, bump] = useState(0)
  const [seen] = useState(() => new Map<string, IconData | null>())
  const key = ids.join(',')
  useEffect(() => {
    const missing = ids.filter((id) => !seen.has(id))
    if (missing.length === 0) return
    let live = true
    const timer = setTimeout(() => {
      void iconPictures(missing)
        .then((loaded) => {
          if (!live) return
          for (const id of missing) seen.set(id, loaded[id] ?? null)
          bump((n) => n + 1)
        })
        .catch(() => undefined)
    }, 60)
    return () => {
      live = false
      clearTimeout(timer)
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: the key stands for the list of ids
  }, [key])
  return Object.fromEntries(ids.map((id) => [id, seen.get(id)]))
}

/** An icon drawn as a picture (a data URL, so nothing in it can run). */
function Glyph({ data, size, color }: { data: IconData | null | undefined; size: number; color: string }) {
  if (!data) return <span className="block rounded bg-field/60" style={{ width: size * 0.6, height: size * 0.6, opacity: data === null ? 0.2 : 0.6 }} />
  const src = 'data:image/svg+xml,' + encodeURIComponent(iconSvg(data, { size, color }))
  return <img src={src} width={size} height={size} alt="" draggable={false} className="block object-contain" style={{ width: size, height: size }} />
}

/** A virtualized grid of icons: only the rows in view exist. */
function IconGrid({ ids, cell, selected, onPick, ink, empty }: { ids: readonly string[]; cell: number; selected: string | null; onPick: (id: string) => void; ink: string; empty: string }) {
  const scroller = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ top: 0, width: 600, height: 400 })
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const measure = () => setBox({ top: el.scrollTop, width: el.clientWidth, height: el.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const key = ids.length + ':' + (ids[0] ?? '') + ':' + (ids[ids.length - 1] ?? '')
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0
    setBox((b) => ({ ...b, top: 0 }))
    // biome-ignore lint/correctness/useExhaustiveDependencies: a new list starts at the top
  }, [key])
  const columns = Math.max(1, Math.floor(box.width / cell))
  const firstRow = Math.max(0, Math.floor(box.top / cell) - 1)
  const lastRow = Math.ceil((box.top + box.height) / cell) + 1
  const visible = ids.slice(firstRow * columns, lastRow * columns)
  const pictures = usePictures(visible)
  return (
    <div ref={scroller} onScroll={(e) => setBox({ top: e.currentTarget.scrollTop, width: e.currentTarget.clientWidth, height: e.currentTarget.clientHeight })} className="min-h-0 flex-1 overflow-y-auto">
      {ids.length === 0 ? (
        <p className="p-4 text-[12px] text-muted">{empty}</p>
      ) : (
        <div style={{ height: Math.ceil(ids.length / columns) * cell, position: 'relative' }}>
          {visible.map((id, i) => {
            const at = firstRow * columns + i
            const picture = pictures[id]
            return (
              <button
                key={id}
                type="button"
                title={id}
                onClick={() => onPick(id)}
                aria-pressed={selected === id}
                className={`absolute flex items-center justify-center rounded-lg ${selected === id ? 'active-tint' : 'hover:bg-hover'}`}
                style={{ left: (at % columns) * cell, top: Math.floor(at / columns) * cell, width: cell, height: cell }}
              >
                <Glyph data={picture} size={Math.round(cell * 0.5)} color={ink} />
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function SetCard({ set, onOpen, ink }: { set: IconSet; onOpen: () => void; ink: string }) {
  const samples = useMemo(() => set.samples.slice(0, 4).map((n) => set.prefix + ':' + n), [set])
  const pictures = usePictures(samples)
  return (
    <button type="button" onClick={onOpen} className="flex flex-col gap-2 rounded-panel bg-field/60 p-3 text-left ring-1 ring-line hover:ring-accent/50">
      <span className="flex h-9 items-center gap-2">
        {samples.map((id) => (
          <span key={id} className="flex size-8 items-center justify-center rounded-md bg-field">
            <Glyph data={pictures[id]} size={20} color={ink} />
          </span>
        ))}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[12px] font-semibold">{set.name}</span>
        <span className="block truncate text-[10px] text-muted">
          {set.total.toLocaleString()} · {set.licenseTitle}
        </span>
      </span>
    </button>
  )
}

function Toggle({ on, onClick, label, icon: Icon }: { on: boolean; onClick: () => void; label: string; icon: typeof Plus }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[11px] ${on ? 'active-tint' : 'bg-field text-muted hover:bg-hover hover:text-ink'}`}
    >
      <Icon size={13} aria-hidden />
      {label}
    </button>
  )
}

export function IconsWindow() {
  const [sets, setSets] = useState<IconSet[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<View>({ kind: 'all' })
  const [find, setFind] = useState('')
  const [query, setQuery] = useState('')
  const [style, setStyle] = useState<StyleFilter>('all')
  const [cell, setCell] = useState(56)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [picked, setPicked] = useState<string | null>(null)
  const [options, setOptions] = usePersisted<Options>('uve-icons-options', DEFAULT_OPTIONS)
  const [starred, setStarred] = usePersisted<string[]>('uve-icons-starred', [])
  const [recent, setRecent] = usePersisted<string[]>('uve-icons-recent', [])
  const [names, setNames] = useState<{ prefix: string; names: string[] } | null>(null)
  const [found, setFound] = useState<{ key: string; ids: string[] } | null>(null)
  const ink = '#d8d8e4'

  useEffect(() => {
    iconSets().then(setSets, (e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  const byPrefix = useMemo(() => new Map((sets ?? []).map((s) => [s.prefix, s])), [sets])
  const current = view.kind === 'set' ? byPrefix.get(view.prefix) : undefined

  // The names of the open set.
  useEffect(() => {
    if (view.kind !== 'set') return
    let live = true
    setNames(null)
    window.uve.icons.names(view.prefix).then(
      (list) => live && setNames({ prefix: view.prefix, names: list }),
      () => live && setNames({ prefix: view.prefix, names: [] }),
    )
    return () => {
      live = false
    }
  }, [view])

  // Searching every set (or the colour sets, for the Colour chip), after a pause in typing.
  const searchKey = view.kind === 'all' ? query.trim() + '|' + style : ''
  useEffect(() => {
    const words = query.trim()
    if (view.kind !== 'all' || words === '' || !sets) {
      setFound(null)
      return
    }
    let live = true
    const timer = setTimeout(() => {
      const colour = sets.filter((s) => s.palette).map((s) => s.prefix)
      void window.uve.icons.search(words, style === 'color' ? colour : null, 999).then(
        (ids) => live && setFound({ key: searchKey, ids }),
        () => live && setFound({ key: searchKey, ids: [] }),
      )
    }, 250)
    return () => {
      live = false
      clearTimeout(timer)
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: searchKey stands for the query and the style
  }, [searchKey, sets])

  const shownIds = useMemo<string[]>(() => {
    let ids: string[] = []
    if (view.kind === 'starred') ids = starred
    else if (view.kind === 'recent') ids = recent
    else if (view.kind === 'set') {
      const all = names && names.prefix === view.prefix ? names.names : []
      const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
      ids = all.filter((n) => words.every((w) => n.includes(w))).map((n) => view.prefix + ':' + n)
    } else if (found && found.key === searchKey) ids = found.ids
    return ids
  }, [view, starred, recent, names, query, found, searchKey])

  // Line and solid are told apart by the icons themselves, once their pictures are in.
  const pictureOfShown = usePictures(style === 'line' || style === 'solid' ? shownIds.slice(0, 600) : [])
  const filtered = useMemo(() => {
    if (style === 'all') return shownIds
    return shownIds.filter((id) => {
      const set = byPrefix.get(iconIdParts(id)?.prefix ?? '')
      if (style === 'color') return set?.palette === true
      if (set?.palette) return false
      const data = pictureOfShown[id]
      return data ? iconStyleOf(data.body, false) === style : true
    })
  }, [shownIds, style, byPrefix, pictureOfShown])

  const pickedSet = picked ? byPrefix.get(iconIdParts(picked)?.prefix ?? '') : undefined
  const pickedPicture = usePictures(picked ? [picked] : [])[picked ?? '']
  const pickedName = picked ? iconTitle(iconIdParts(picked)?.name ?? picked) : null
  const isStarred = picked ? starred.includes(picked) : false

  async function insert() {
    if (!picked || !pickedSet) return
    const { notify, select } = useEditor.getState()
    try {
      const result = await placeIcon(picked, {
        size: options.size,
        color: options.color,
        ...(options.strokeWidth === null ? {} : { strokeWidth: options.strokeWidth }),
        animIn: options.drawIn ? 'draw' : null,
        animOut: options.drawOut ? 'draw' : null,
        startMs: Math.round(useEditor.getState().timeMs),
      })
      if (!result.ok) {
        notify(result.error, 'error')
        return
      }
      const value = result.value as { ids: string[]; groupId: string | null }
      select(value.groupId ?? value.ids[0] ?? null)
      setRecent([picked, ...recent.filter((id) => id !== picked)].slice(0, 48))
      notify(pickedName + ' added')
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  const visibleSets = (sets ?? []).filter((s) => find.trim() === '' || (s.name + ' ' + s.prefix).toLowerCase().includes(find.trim().toLowerCase()))
  const grouped = ICON_GROUPS.map((group) => ({ group, sets: visibleSets.filter((s) => iconGroup(s.category) === group) })).filter((g) => g.sets.length > 0)
  const searching = view.kind === 'all' && query.trim() !== ''

  return (
    <PluginWindow title="Icons" icon={Shapes}>
      <aside className="flex w-56 shrink-0 flex-col gap-0.5 overflow-y-auto rounded-panel bg-field/40 p-2">
        <label className="mb-1 flex h-8 items-center gap-2 rounded-lg bg-field px-2.5 text-muted focus-within:ring-1 focus-within:ring-accent">
          <Search size={13} aria-hidden />
          <input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a set" aria-label="Find a set" className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-muted" />
        </label>
        <p className="px-2 pt-1 pb-1 text-[10px] font-semibold tracking-wide text-muted uppercase">Browse</p>
        {(
          [
            ['all', 'All icons', LayoutGrid, undefined],
            ['starred', 'Starred', Star, starred.length],
            ['recent', 'Recent', Clock, undefined],
          ] as const
        ).map(([kind, label, Icon, count]) => (
          <button
            key={kind}
            type="button"
            onClick={() => {
              setView({ kind })
              setQuery('')
            }}
            aria-pressed={view.kind === kind}
            className={`flex h-8 items-center gap-2 rounded-lg px-2 text-left text-[12px] ${view.kind === kind ? 'active-tint' : 'text-muted hover:bg-hover hover:text-ink'}`}
          >
            <Icon size={14} aria-hidden />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {count !== undefined && <span className="text-[10px] opacity-70">{count}</span>}
          </button>
        ))}
        {grouped.map(({ group, sets: list }) => (
          <div key={group}>
            <p className="px-2 pt-3 pb-1 text-[10px] font-semibold tracking-wide text-muted uppercase">{group}</p>
            {list.map((s) => (
              <button
                key={s.prefix}
                type="button"
                onClick={() => {
                  setView({ kind: 'set', prefix: s.prefix })
                  setQuery('')
                }}
                aria-pressed={view.kind === 'set' && view.prefix === s.prefix}
                className={`flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[12px] ${view.kind === 'set' && view.prefix === s.prefix ? 'active-tint' : 'text-muted hover:bg-hover hover:text-ink'}`}
                title={s.name + ' · ' + s.licenseTitle + (s.author ? ' · ' + s.author : '')}
              >
                <span className="min-w-0 flex-1 truncate">{s.name}</span>
                <span className="text-[10px] opacity-70">{s.total}</span>
              </button>
            ))}
          </div>
        ))}
        {sets && grouped.length === 0 && <p className="px-2 text-[11px] text-muted">No set matches.</p>}
      </aside>
      <section className="flex min-w-0 flex-1 flex-col rounded-panel bg-field/40">
        <div className="flex items-center gap-2 p-2.5 pb-2">
          {view.kind === 'set' ? (
            <button type="button" onClick={() => { setView({ kind: 'all' }); setQuery('') }} className="flex items-center gap-1 text-[12px] text-muted hover:text-ink">
              <ArrowLeft size={13} aria-hidden /> All
            </button>
          ) : null}
          <span className="shrink-0 text-[13px] font-semibold">{view.kind === 'set' ? (current?.name ?? view.prefix) : view.kind === 'starred' ? 'Starred' : view.kind === 'recent' ? 'Recent' : 'All icons'}</span>
          {view.kind !== 'starred' && view.kind !== 'recent' && (
            <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg bg-field px-2.5 text-muted focus-within:ring-1 focus-within:ring-accent">
              <Search size={13} aria-hidden />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={view.kind === 'set' ? 'Search ' + (current?.name ?? 'this set') : 'Search every set'}
                aria-label="Search icons"
                className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-muted"
              />
            </label>
          )}
          <span className="flex-1" />
          {(['all', 'line', 'solid', 'color'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStyle(s)}
              aria-pressed={style === s}
              className={`h-7 shrink-0 rounded-full px-3 text-[11px] ${style === s ? 'active-tint' : 'text-muted hover:bg-hover hover:text-ink'}`}
            >
              {s === 'all' ? 'All' : s === 'line' ? 'Line' : s === 'solid' ? 'Solid' : 'Colour'}
            </button>
          ))}
          <input type="range" min={44} max={96} value={cell} onChange={(e) => setCell(Number(e.target.value))} aria-label="Icon size in the grid" className="w-20 accent-accent" />
        </div>
        <div className="flex min-h-0 flex-1 flex-col border-t border-line/60 px-2 pt-1">
          {error ? (
            <p className="p-4 text-[12px] text-muted">Could not reach the icon server, and no icons were kept from before: {error}</p>
          ) : !sets ? (
            <p className="p-4 text-[12px] text-muted">Loading the icon sets…</p>
          ) : view.kind === 'all' && !searching ? (
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-2">
              {(style === 'all' ? grouped : grouped.map((g) => ({ ...g, sets: g.sets.filter((s) => (style === 'color' ? s.palette : !s.palette)) }))).filter((g) => g.sets.length > 0).map(({ group, sets: list }) => (
                <section key={group} className="space-y-2">
                  <div className="flex items-baseline gap-2">
                    <h3 className="text-[11px] font-semibold tracking-wide text-muted uppercase">{group}</h3>
                    <span className="text-[10px] text-muted">{list.length}</span>
                    <span className="flex-1" />
                    {list.length > 8 && (
                      <button type="button" onClick={() => setExpanded({ ...expanded, [group]: !expanded[group] })} className="text-[11px] text-muted hover:text-ink">
                        {expanded[group] ? 'Show fewer' : 'View all'}
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
                    {(expanded[group] ? list : list.slice(0, 8)).map((s) => (
                      <SetCard key={s.prefix} set={s} ink={ink} onOpen={() => setView({ kind: 'set', prefix: s.prefix })} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <IconGrid
              ids={filtered}
              cell={cell}
              selected={picked}
              onPick={setPicked}
              ink={ink}
              empty={view.kind === 'starred' ? 'Star an icon to keep it here.' : view.kind === 'recent' ? 'Icons you insert show here.' : view.kind === 'set' && !names ? 'Loading the set…' : searching && !found ? 'Searching…' : 'No icon matches.'}
            />
          )}
          <p className="px-2 py-1 text-[10px] text-muted">{view.kind === 'all' && !searching ? (sets ?? []).reduce((n, s) => n + s.total, 0).toLocaleString() + ' icons in ' + (sets ?? []).length + ' sets' : filtered.length.toLocaleString() + ' icons'}</p>
        </div>
        <div className="space-y-2 border-t border-line/60 p-2.5">
          <div className="flex items-center gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-field">
              {picked ? <Glyph data={pickedPicture} size={28} color={options.color} /> : <Plus size={16} className="text-muted" aria-hidden />}
            </span>
            <div className="min-w-0 flex-1">
              {picked && pickedName ? (
                <>
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[12px] font-medium">{pickedName}</span>
                    <button
                      type="button"
                      onClick={() => setStarred(isStarred ? starred.filter((id) => id !== picked) : [picked, ...starred])}
                      aria-label={isStarred ? 'Unstar' : 'Star'}
                      aria-pressed={isStarred}
                      className={isStarred ? 'text-accent' : 'text-muted hover:text-ink'}
                    >
                      <Star size={13} className={isStarred ? 'fill-current' : ''} />
                    </button>
                  </div>
                  <p className="truncate text-[10px] text-muted">
                    #{iconIdParts(picked)?.prefix}
                    {pickedPicture ? ' #' + iconStyleOf(pickedPicture.body, pickedSet?.palette === true) : ''}
                  </p>
                  {pickedSet && (
                    <p className="truncate text-[10px] text-muted/80">
                      {pickedSet.name} · {pickedSet.licenseTitle}
                      {pickedSet.needsCredit && pickedSet.author ? ' · credit ' + pickedSet.author : ''}
                    </p>
                  )}
                </>
              ) : (
                <span className="text-[11px] text-muted">Pick an icon</span>
              )}
            </div>
            <button
              type="button"
              onClick={() => void insert()}
              disabled={!picked || !pickedPicture}
              className="flex h-8 items-center gap-1.5 rounded-lg bg-accent/15 px-3 text-[12px] font-medium text-accent hover:bg-accent/25 disabled:opacity-40"
            >
              <Plus size={14} aria-hidden /> Insert
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex h-8 items-center gap-2 rounded-lg bg-field px-2 text-[11px] text-muted" title="What currentColor stands for; icons in their own colours keep them">
              <input type="color" value={options.color.slice(0, 7)} onChange={(e) => setOptions({ ...options, color: e.target.value })} aria-label="Icon colour" className="size-5 cursor-pointer rounded border-0 bg-transparent p-0" />
              <input value={options.color} onChange={(e) => setOptions({ ...options, color: e.target.value })} aria-label="Icon colour as hex" className="w-[4.5rem] bg-transparent font-mono text-[11px] text-ink uppercase outline-none" />
            </label>
            <label className="flex h-8 items-center gap-1.5 rounded-lg bg-field px-2 text-[11px] text-muted" title="The longer side of the icon">
              <input
                type="number"
                min={8}
                max={2048}
                step={4}
                value={options.size}
                onChange={(e) => setOptions({ ...options, size: Math.max(8, Math.min(2048, Number(e.target.value) || 128)) })}
                aria-label="Icon size in px"
                className="w-14 bg-transparent text-ink outline-none"
              />
              px
            </label>
            <label className="flex h-8 items-center gap-1.5 rounded-lg bg-field px-2 text-[11px] text-muted" title="Line width of line icons, in the icon's own units; Auto keeps the set's own">
              Pen
              <select
                value={options.strokeWidth === null ? '' : String(options.strokeWidth)}
                onChange={(e) => setOptions({ ...options, strokeWidth: e.target.value === '' ? null : Number(e.target.value) })}
                aria-label="Pen width"
                className="bg-transparent text-ink outline-none"
              >
                <option value="">auto</option>
                {[0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4].map((w) => (
                  <option key={w} value={w}>
                    {w}
                  </option>
                ))}
              </select>
            </label>
            <Toggle on={options.drawIn} onClick={() => setOptions({ ...options, drawIn: !options.drawIn })} label="Draw on" icon={ArrowRightToLine} />
            <Toggle on={options.drawOut} onClick={() => setOptions({ ...options, drawOut: !options.drawOut })} label="Out" icon={ArrowRightFromLine} />
          </div>
        </div>
      </section>
    </PluginWindow>
  )
}
