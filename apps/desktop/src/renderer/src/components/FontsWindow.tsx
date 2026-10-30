import type { Comp, InstalledFont } from '@uve/core'
import { Clock, FileText, HardDrive, Search, Sparkles, Star, Trash2, Type, Upload } from 'lucide-react'
import { type ReactNode, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { type Catalogue, filterFamilies, type FontSort, googleCatalogue } from '../library/googleFonts'
import { loadFont, previewFamily } from '../library/fonts'
import { installFonts } from '../library/installFonts'
import { findLayer, run, useEditor } from '../store'
import { PluginWindow } from './PluginWindow'

// The Fonts plugin: every Google family (searched by name, designer and
// feeling), the fonts installed in the project, and the fonts on this
// computer, each shown in its own face. Clicking a family puts it on the
// selected text layer, or makes a new text layer in it.

interface FontRow {
  family: string
  source: 'google' | 'installed' | 'device'
  category?: string
  weights: number[]
  variable: { min: number; max: number } | null
  italic: boolean
  designer?: string
  styles: string[]
  feelings: string[]
}

type Source = 'all' | 'starred' | 'recent' | 'project' | 'installed' | 'device' | 'google'

const FEELINGS = ['Calm', 'Business', 'Playful', 'Sophisticated', 'Futuristic', 'Vintage', 'Loud', 'Happy']
const SAMPLE = 'Sphinx of black quartz, judge my vow'
const ALL_WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900]

/** State that outlives the window (and the session): starred and recent fonts. */
function usePersisted<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw === null ? initial : (JSON.parse(raw) as T)
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

/** The weight of a row nearest to a wanted one. */
function nearestWeight(row: FontRow, wanted: number): number {
  if (row.variable) return Math.min(row.variable.max, Math.max(row.variable.min, wanted))
  if (row.weights.length === 0) return wanted
  return row.weights.reduce((best, w) => (Math.abs(w - wanted) < Math.abs(best - wanted) ? w : best))
}

function installedRows(fonts: readonly InstalledFont[]): FontRow[] {
  const families = new Map<string, InstalledFont[]>()
  for (const font of fonts) families.set(font.family, [...(families.get(font.family) ?? []), font])
  return [...families].map(([family, files]) => {
    const variable = files.find((f) => f.variable)?.variable ?? null
    const weights = variable ? ALL_WEIGHTS.filter((w) => w >= variable.min && w <= variable.max) : [...new Set(files.map((f) => f.weight))].sort((a, b) => a - b)
    return { family, source: 'installed', weights, variable, italic: files.some((f) => f.italic), styles: [], feelings: [] }
  })
}

/** The families the project's text layers use, including their styled ranges. */
function usedFamilies(comps: readonly Comp[]): Set<string> {
  const used = new Set<string>()
  for (const comp of comps) {
    for (const track of comp.tracks) {
      for (const layer of track.layers) {
        if (layer.kind !== 'text') continue
        used.add(layer.style.fontFamily)
        for (const range of layer.ranges) if (range.style.fontFamily) used.add(range.style.fontFamily)
      }
    }
  }
  return used
}

/** A family drawn in its own face, loaded when the row scrolls into view. */
function Preview({ row, weight, sample, size }: { row: FontRow; weight: number; sample: string; size: number }) {
  const [alias, setAlias] = useState<string | null>(null)
  useEffect(() => {
    if (row.source !== 'google') {
      setAlias(row.family)
      return
    }
    let live = true
    setAlias(null)
    void previewFamily(row.family, weight, [...new Set(sample)].join('')).then((name) => live && setAlias(name))
    return () => {
      live = false
    }
  }, [row.family, row.source, weight, sample])
  return (
    <div
      className="truncate whitespace-nowrap leading-tight text-ink"
      style={{ fontFamily: alias ? '"' + alias + '", system-ui' : 'system-ui', fontWeight: weight, fontSize: size, opacity: alias ? 1 : 0.25 }}
    >
      {sample || row.family}
    </div>
  )
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`h-7 shrink-0 rounded-full px-3 text-[11px] ${on ? 'active-tint' : 'bg-field text-muted hover:bg-hover hover:text-ink'}`}
    >
      {children}
    </button>
  )
}

function SourceButton({ on, onClick, icon: Icon, label, count }: { on: boolean; onClick: () => void; icon: typeof Type; label: string; count?: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[12px] ${on ? 'active-tint' : 'text-muted hover:bg-hover hover:text-ink'}`}
    >
      <Icon size={14} aria-hidden />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && <span className="text-[10px] opacity-70">{count}</span>}
    </button>
  )
}

export function FontsWindow() {
  const project = useEditor((s) => s.project)
  const selectedId = useEditor((s) => s.selectedLayerId)
  const selected = selectedId ? findLayer(project, selectedId) : undefined
  const target = selected?.kind === 'text' ? selected : undefined

  const [catalogue, setCatalogue] = useState<Catalogue | null>(null)
  const [device, setDevice] = useState<string[] | null>(null)
  const [source, setSource] = useState<Source>('all')
  const [category, setCategory] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<FontSort>('popular')
  const [sample, setSample] = useState('')
  const [size, setSize] = useState(44)
  const [weight, setWeight] = useState<number | null>(null)
  const [feeling, setFeeling] = useState<string | null>(null)
  const [style, setStyle] = useState('')
  const [script, setScript] = useState('')
  const [variable, setVariable] = useState(false)
  const [italic, setItalic] = useState(false)
  const [starred, setStarred] = usePersisted<string[]>('uve-fonts-starred', [])
  const [recent, setRecent] = usePersisted<string[]>('uve-fonts-recent', [])
  const [rowWeights, setRowWeights] = useState<Record<string, number>>({})
  const [dropping, setDropping] = useState(false)

  useEffect(() => {
    void googleCatalogue().then(setCatalogue)
  }, [])

  // The fonts on this computer, by the browser's Local Font Access API, when it is there.
  useEffect(() => {
    const query = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts
    if (!query) {
      setDevice([])
      return
    }
    void query
      .call(window)
      .then((fonts) => setDevice([...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b))))
      .catch(() => setDevice([]))
  }, [])

  const deferredSample = useDeferredValue(sample)
  const text = deferredSample.trim() === '' ? SAMPLE : deferredSample

  const installed = useMemo(() => installedRows(project.fonts), [project.fonts])
  const used = useMemo(() => usedFamilies(project.comps), [project.comps])
  const filtering = category !== null || feeling !== null || style !== '' || script !== '' || variable || italic

  const rows = useMemo<FontRow[]>(() => {
    if (!catalogue) return []
    const google = filterFamilies(
      catalogue.families,
      { query, category: category ?? undefined, feeling: feeling ?? undefined, style: style || undefined, script: script || undefined, variable, italic },
      sort,
    ).map(
      (f): FontRow => ({
        family: f.family,
        source: 'google',
        category: f.category,
        weights: f.weights,
        variable: f.variable,
        italic: f.italicWeights.length > 0,
        designer: f.designer,
        styles: f.styles,
        feelings: f.feelings,
      }),
    )
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const byName = (r: FontRow) => words.every((w) => r.family.toLowerCase().includes(w))
    const own = filtering ? [] : installed.filter(byName)
    const local = filtering || !device ? [] : device.filter((f) => words.every((w) => f.toLowerCase().includes(w))).map((family): FontRow => ({ family, source: 'device', weights: [400], variable: null, italic: false, styles: [], feelings: [] }))
    const all = [...own, ...google, ...local]
    const pick = (families: readonly string[]) => families.flatMap((f) => all.filter((r) => r.family === f).slice(0, 1))
    switch (source) {
      case 'google':
        return google
      case 'installed':
        return own
      case 'device':
        return local
      case 'starred':
        return pick(starred)
      case 'recent':
        return pick(recent)
      case 'project':
        return all.filter((r) => used.has(r.family))
      default:
        return all
    }
  }, [catalogue, query, category, feeling, style, script, variable, italic, sort, source, installed, device, starred, recent, used, filtering])

  // A windowed list: only the rows in view exist, so 2,000 families stay light.
  const rowHeight = Math.round(46 + size * 1.3)
  const scroller = useRef<HTMLDivElement>(null)
  const [scroll, setScroll] = useState({ top: 0, height: 480 })
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const measure = () => setScroll({ top: el.scrollTop, height: el.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0
    setScroll((s) => ({ ...s, top: 0 }))
  }, [query, category, feeling, style, script, variable, italic, sort, source])
  const first = Math.max(0, Math.floor(scroll.top / rowHeight) - 2)
  const last = Math.min(rows.length, Math.ceil((scroll.top + scroll.height) / rowHeight) + 3)

  const weightOf = (row: FontRow) => rowWeights[row.family] ?? nearestWeight(row, weight ?? 400)

  async function apply(row: FontRow) {
    const state = useEditor.getState()
    const chosen = weightOf(row)
    const explicit = weight !== null || rowWeights[row.family] !== undefined
    if (row.source === 'google') await loadFont(row.family, chosen)
    if (target) {
      const current = target.style.fontWeight
      const ops: Record<string, unknown>[] = [{ op: 'set', path: 'style.fontFamily', value: row.family }]
      // The weight changes when it was asked for, or when the family has no such face.
      if (explicit || nearestWeight(row, current) !== current) ops.push({ op: 'set', path: 'style.fontWeight', value: Math.round(explicit ? chosen : nearestWeight(row, current)) })
      await run('layer.patch', { id: target.id, ops })
    } else {
      const created = await run('layer.create', {
        compId: state.activeCompId,
        startMs: Math.round(state.timeMs),
        kind: 'text',
        text: row.family,
        style: { fontFamily: row.family, fontWeight: Math.round(chosen), fontSize: 120 },
      })
      if (created.ok) state.select((created.value as { id: string }).id)
    }
    setRecent([row.family, ...recent.filter((f) => f !== row.family)].slice(0, 30))
  }

  const toggleStar = (family: string) => setStarred(starred.includes(family) ? starred.filter((f) => f !== family) : [family, ...starred])

  async function install(files: Awaited<ReturnType<typeof window.uve.fonts.pick>>) {
    const { notify } = useEditor.getState()
    if (files.length === 0) {
      notify('No readable font files: use TrueType, OpenType, WOFF or WOFF2.', 'error')
      return
    }
    try {
      const done = await installFonts(files)
      const families = [...new Set(done.map((d) => d.family))]
      notify('Installed ' + families.join(', ') + '.')
      setSource('installed')
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDropping(false)
    const files = [...e.dataTransfer.files]
    if (files.length === 0) return
    const granted = await window.uve.media.grantFiles(files)
    await install(await window.uve.fonts.inspect(granted.map((g) => g.path)))
  }

  const total = catalogue?.families.length ?? 0
  const count = (n: number) => (catalogue ? n : undefined)
  const categories = catalogue?.categories ?? []

  return (
    <PluginWindow title="Fonts" icon={Type}>
      <aside className="flex w-52 shrink-0 flex-col gap-0.5 overflow-y-auto rounded-panel bg-field/40 p-2">
        <SourceButton on={source === 'all'} onClick={() => setSource('all')} icon={Type} label="All fonts" count={count(total + installed.length + (device?.length ?? 0))} />
        <SourceButton on={source === 'starred'} onClick={() => setSource('starred')} icon={Star} label="Starred" count={starred.length} />
        <SourceButton on={source === 'recent'} onClick={() => setSource('recent')} icon={Clock} label="Recent" />
        <SourceButton on={source === 'project'} onClick={() => setSource('project')} icon={FileText} label="In this project" count={used.size} />
        <p className="px-2 pt-3 pb-1 text-[10px] font-semibold tracking-wide text-muted uppercase">Sources</p>
        <SourceButton on={source === 'installed'} onClick={() => setSource('installed')} icon={Upload} label="Installed" count={installed.length} />
        <SourceButton on={source === 'device'} onClick={() => setSource('device')} icon={HardDrive} label="On this computer" count={device?.length} />
        <SourceButton on={source === 'google'} onClick={() => setSource('google')} icon={Sparkles} label="Google Fonts" count={count(total)} />
        <p className="px-2 pt-3 pb-1 text-[10px] font-semibold tracking-wide text-muted uppercase">Categories</p>
        {categories.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setCategory(category === c ? null : c)}
            aria-pressed={category === c}
            className={`flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[12px] ${category === c ? 'active-tint' : 'text-muted hover:bg-hover hover:text-ink'}`}
          >
            <span className="w-5 text-[11px] font-semibold">Aa</span>
            <span className="min-w-0 flex-1 truncate">{c}</span>
            <span className="text-[10px] opacity-70">{catalogue?.families.filter((f) => f.category === c).length}</span>
          </button>
        ))}
      </aside>
      <section
        className={`relative flex min-w-0 flex-1 flex-col rounded-panel bg-field/40 ${dropping ? 'ring-2 ring-accent' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setDropping(true)
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(e) => void onDrop(e)}
      >
        <div className="space-y-2 p-2.5 pb-2">
          <div className="flex gap-2">
            <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg bg-field px-2.5 text-muted focus-within:ring-1 focus-within:ring-accent">
              <Search size={14} aria-hidden />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search fonts, designers, feelings"
                aria-label="Search fonts"
                className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-muted"
              />
            </label>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as FontSort)}
              aria-label="Sort"
              className="h-9 rounded-lg bg-field px-2 text-[12px] text-ink outline-none"
            >
              <option value="popular">Popular</option>
              <option value="name">Name</option>
              <option value="newest">Newest</option>
            </select>
          </div>
          <div className="flex gap-2">
            <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg bg-field px-2.5 text-muted focus-within:ring-1 focus-within:ring-accent">
              <Type size={14} aria-hidden />
              <input
                value={sample}
                onChange={(e) => setSample(e.target.value)}
                placeholder="Type something"
                aria-label="Preview text"
                className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-muted"
              />
            </label>
            <label className="flex h-9 w-44 items-center gap-2 rounded-lg bg-field px-2.5 text-[11px] text-muted">
              Size
              <input type="range" min={16} max={96} value={size} onChange={(e) => setSize(Number(e.target.value))} aria-label="Preview size" className="min-w-0 flex-1 accent-accent" />
              <span className="w-9 text-right text-ink tabular-nums">{size} px</span>
            </label>
            <label className="flex h-9 items-center gap-2 rounded-lg bg-field px-2.5 text-[11px] text-muted">
              Weight
              <select
                value={weight ?? ''}
                onChange={(e) => {
                  setWeight(e.target.value === '' ? null : Number(e.target.value))
                  setRowWeights({})
                }}
                aria-label="Preview weight"
                className="bg-transparent text-ink outline-none"
              >
                <option value="">Auto</option>
                {ALL_WEIGHTS.map((w) => (
                  <option key={w} value={w}>
                    {w}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
            {FEELINGS.map((f) => (
              <Chip key={f} on={feeling === f} onClick={() => setFeeling(feeling === f ? null : f)}>
                {f}
              </Chip>
            ))}
            <select value={style} onChange={(e) => setStyle(e.target.value)} aria-label="Style" className="h-7 shrink-0 rounded-full bg-field px-2.5 text-[11px] text-muted outline-none">
              <option value="">Any style</option>
              {(catalogue?.styles ?? []).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select value={script} onChange={(e) => setScript(e.target.value)} aria-label="Language" className="h-7 shrink-0 rounded-full bg-field px-2.5 text-[11px] text-muted outline-none">
              <option value="">Any language</option>
              {(catalogue?.scripts ?? []).slice(0, 40).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <Chip on={variable} onClick={() => setVariable(!variable)}>
              Variable
            </Chip>
            <Chip on={italic} onClick={() => setItalic(!italic)}>
              Italic
            </Chip>
          </div>
        </div>
        <div ref={scroller} onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })} className="min-h-0 flex-1 overflow-y-auto border-t border-line/60">
          {!catalogue ? (
            <p className="p-4 text-[12px] text-muted">Loading the catalogue…</p>
          ) : rows.length === 0 ? (
            <p className="p-4 text-[12px] text-muted">
              {source === 'starred' ? 'Star a font to keep it here.' : source === 'recent' ? 'Fonts you use show here.' : source === 'installed' ? 'No installed fonts yet: drop font files here, or upload them.' : 'No font matches.'}
            </p>
          ) : (
            <div style={{ height: rows.length * rowHeight, position: 'relative' }}>
              {rows.slice(first, last).map((row, i) => {
                const w = weightOf(row)
                const at = (first + i) * rowHeight
                const starredNow = starred.includes(row.family)
                return (
                  <div
                    key={row.source + row.family}
                    style={{ position: 'absolute', top: at, left: 0, right: 0, height: rowHeight }}
                    className="group cursor-pointer border-b border-line/40 px-4 py-2 hover:bg-hover/60"
                    onClick={() => void apply(row)}
                    title={target ? 'Use ' + row.family + ' on ' + target.name : 'Add a text layer in ' + row.family}
                  >
                    <div className="flex items-center gap-2 text-[11px]">
                      <span className="text-[12px] font-semibold">{row.family}</span>
                      {row.variable && <span className="text-muted">Variable</span>}
                      {row.source !== 'google' && <span className="rounded bg-field px-1.5 text-muted">{row.source === 'installed' ? 'installed' : 'this computer'}</span>}
                      {row.designer && <span className="min-w-0 truncate text-muted">{row.designer}</span>}
                      <span className="flex-1" />
                      {row.styles.slice(0, 2).map((s) => (
                        <span key={s} className="shrink-0 rounded-full bg-field px-2 py-0.5 text-[10px] text-muted">
                          {s}
                        </span>
                      ))}
                      <span className="flex shrink-0 gap-1 text-[10px]">
                        {(row.variable ? ALL_WEIGHTS.filter((x) => x >= (row.variable?.min ?? 0) && x <= (row.variable?.max ?? 0)) : row.weights).map((x) => (
                          <button
                            key={x}
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              setRowWeights({ ...rowWeights, [row.family]: x })
                            }}
                            title={'Show ' + x}
                            className={Math.round(w) === x ? 'font-semibold text-accent' : 'text-muted hover:text-ink'}
                            style={{ fontWeight: x }}
                          >
                            Aa
                          </button>
                        ))}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleStar(row.family)
                        }}
                        aria-label={starredNow ? 'Unstar ' + row.family : 'Star ' + row.family}
                        className={starredNow ? 'text-accent' : 'text-muted opacity-0 group-hover:opacity-100 hover:text-ink'}
                      >
                        <Star size={13} className={starredNow ? 'fill-current' : ''} />
                      </button>
                      {row.source === 'installed' && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            void run('fonts.remove', { family: row.family })
                          }}
                          aria-label={'Remove ' + row.family}
                          title="Take it out of the project"
                          className="text-muted opacity-0 group-hover:opacity-100 hover:text-ink"
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                    <Preview row={row} weight={Math.round(w)} sample={text} size={size} />
                  </div>
                )
              })}
            </div>
          )}
        </div>
        <div className="flex h-9 shrink-0 items-center gap-3 border-t border-line/60 px-3 text-[11px] text-muted">
          <span>{rows.length.toLocaleString()} families</span>
          <span className="flex-1" />
          <span className="min-w-0 truncate">{target ? 'Applies to ' + target.name : 'Select text to apply a font to it'}</span>
          <button
            type="button"
            onClick={() => void window.uve.fonts.pick().then(install)}
            className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-ink hover:bg-hover"
          >
            <Upload size={13} aria-hidden />
            Upload fonts
          </button>
        </div>
      </section>
    </PluginWindow>
  )
}
