import { ArrowLeft, ArrowLeftRight, LibraryBig, type IconComponent, Music, Play, Plus, Search, Shapes, Sparkles, Sticker as StickerIcon, Type } from '../icons'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import type { AnimationPreset, TransitionPreset } from '@uve/core'
import { mediaUrl } from '../../../shared/media'
import { type Sticker, type StickerStyle, searchStickers } from '../../../shared/stickers'
import { ANIMATIONS, TEXT_LOOKS, type TextLook, TRANSITIONS } from '../library/catalog'
import { loadFont } from '../library/fonts'
import { previewPack, SOUND_PACKS, type SoundPack } from '../library/sounds'
import { placeSticker, stickerIndex } from '../library/stickers'
import { TITLE_CARD } from '../library/titleCard'
import { STICKER_DRAG_TYPE } from '../media/import'
import { findLayer, run, useEditor, useSelectedLayer } from '../store'

// The library: things to add and animations to put on the selected layer.
// Text looks, animations and transitions come from AtomCut's catalog (see
// library/catalog.ts). Every item runs through the command API as one undo step.

type Category = 'all' | 'looks' | 'animations' | 'transitions' | 'sounds' | 'stickers'

interface Item {
  key: string
  name: string
  title: string
  preview: ReactNode
  add: () => void
  /** What clicking the picture does, when it is not the plus: a look goes on the selected text. */
  use?: () => void
  /** A play button before the plus, for sounds. */
  play?: () => void
}

function Card({ item, wide }: { item: Item; wide?: boolean }) {
  return (
    <div
      className={`group flex shrink-0 items-center gap-2.5 rounded-panel bg-card p-1.5 pr-1 ring-1 ring-line hover:ring-accent/50 ${wide ? 'w-full' : 'w-[176px]'}`}
      title={item.title}
    >
      <button
        type="button"
        onClick={item.use ?? item.add}
        tabIndex={-1}
        className="flex h-9 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-stage"
      >
        {item.preview}
      </button>
      <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{item.name}</span>
      {item.play && (
        <button
          type="button"
          onClick={item.play}
          aria-label={`Play ${item.name}`}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-ink"
        >
          <Play size={13} />
        </button>
      )}
      <button
        type="button"
        onClick={item.add}
        aria-label={`Add ${item.name}`}
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-ink"
      >
        <Plus size={14} />
      </button>
    </div>
  )
}

/** A text look's preview: its sample text in its own font and palette. */
function LookPreview({ look }: { look: TextLook }) {
  useEffect(() => {
    void loadFont(look.style.fontFamily, look.style.fontWeight ?? 400)
  }, [look])
  const color = look.style.color.startsWith('@') ? look.palette[look.style.color.slice(1) as 'ink'] : look.style.color
  return (
    <span
      className="flex h-full w-full items-center justify-center overflow-hidden px-1 text-[9px] leading-none whitespace-nowrap"
      style={{ background: look.palette.shade, color, fontFamily: `"${look.style.fontFamily}"`, fontWeight: look.style.fontWeight ?? 400 }}
    >
      {look.sampleText}
    </span>
  )
}

/** Adds a layer at the playhead and selects it. */
async function create(input: Record<string, unknown>) {
  const { activeCompId, timeMs, select } = useEditor.getState()
  const result = await run('layer.create', { compId: activeCompId, startMs: Math.round(timeMs), ...input })
  if (result.ok) select((result.value as { id: string }).id)
}

async function addTitleCard() {
  const result = await run('api.batch', { calls: TITLE_CARD })
  if (!result.ok) return
  const { seek, togglePlay, playing } = useEditor.getState()
  seek(0)
  if (!playing) togglePlay()
}

/** A text look as a new text layer with its entrance, in one undo step. */
async function addLook(look: TextLook) {
  await loadFont(look.style.fontFamily, look.style.fontWeight ?? 400)
  const { activeCompId, timeMs, select } = useEditor.getState()
  const result = await run('layer.create', { compId: activeCompId, startMs: Math.round(timeMs), kind: 'text', template: look.id })
  if (result.ok) select((result.value as { id: string }).id)
}

/** A look on the selected text layer (keeping its words and place); on anything else, a new text layer. */
async function useLook(look: TextLook) {
  const { project, selectedLayerId, notify } = useEditor.getState()
  const layer = selectedLayerId ? findLayer(project, selectedLayerId) : undefined
  if (layer?.kind !== 'text') return addLook(look)
  await loadFont(look.style.fontFamily, look.style.fontWeight ?? 400)
  const result = await run('template.apply', { ids: layer.id, templateId: look.id })
  if (result.ok) notify(`${look.name} → “${layer.text.split('\n')[0]?.slice(0, 40) ?? ''}”`)
}

function animate(preset: AnimationPreset) {
  const { project, selectedLayerId, notify } = useEditor.getState()
  const layer = selectedLayerId ? findLayer(project, selectedLayerId) : undefined
  if (!layer) {
    notify('Select a layer to animate.')
    return
  }
  // Text animates per unit when the preset can; anything else (and text with a whole-layer preset) as one piece.
  void run('animation.set', { id: layer.id, slot: 'in', preset: preset.id })
}

const notify = (text: string) => () => useEditor.getState().notify(text)

const BASICS: Item[] = [
  {
    key: 'text',
    name: 'Text',
    title: 'Add a text layer at the playhead (or pick the Text tool and click the picture)',
    preview: <span className="text-[13px] font-bold">Aa</span>,
    add: () => void create({ kind: 'text', text: 'Your title' }),
  },
  {
    key: 'rect',
    name: 'Rectangle',
    title: 'Add a rectangle at the playhead',
    preview: <span className="h-5 w-7 rounded-[3px] bg-clip-shape" />,
    add: () => void create({ kind: 'shape', shape: { type: 'rect', cornerRadius: 24 } }),
  },
  {
    key: 'ellipse',
    name: 'Ellipse',
    title: 'Add an ellipse at the playhead',
    preview: <span className="size-6 rounded-full bg-clip-shape" />,
    add: () => void create({ kind: 'shape', shape: { type: 'ellipse' } }),
  },
  {
    key: 'title-card',
    name: 'Title card',
    title: 'A title card with a 3D fly-in, built through the command API',
    preview: (
      <span className="flex h-6 w-9 items-center justify-center rounded-[3px] bg-[#1d1930] text-[7px] font-bold ring-1 ring-[#7c5cff]">
        TITLE
      </span>
    ),
    add: () => void addTitleCard(),
  },
]

const LOOK_ITEMS: Item[] = TEXT_LOOKS.map((look) => ({
  key: look.id,
  name: look.name,
  title: `${look.name} (${look.category}): ${look.tagline}. ${look.style.fontFamily}, ${look.style.fontSize} px. Click: onto the selected text, or a new text layer. Plus: a new text layer.`,
  preview: <LookPreview look={look} />,
  add: () => void addLook(look),
  use: () => void useLook(look),
}))

const ANIMATION_ITEMS: Item[] = ANIMATIONS.map((preset) => ({
  key: preset.id,
  name: preset.label,
  title: `${preset.label}: ${preset.tagline}. The selected layer's entrance${preset.scope === 'layer' ? ' (whole layer)' : preset.scope === 'text' ? ` (text, per ${preset.defaultUnit})` : ` (per ${preset.defaultUnit} on text, whole layer otherwise)`}.`,
  preview: <Sparkles size={15} className="text-accent" />,
  add: () => animate(preset),
}))

const transitionPreview = (t: TransitionPreset) => (
  <span className="flex h-full w-full overflow-hidden text-[10px] font-bold text-white" title={t.category}>
    <span className="flex flex-1 items-center justify-center bg-[#ff8732]">A</span>
    <span className="flex flex-1 items-center justify-center bg-[#ff2885]">B</span>
  </span>
)

/** Puts a transition on the selected layer's cuts: between it and the layers it touches on its lane, or on its own head and tail. */
function transition(preset: TransitionPreset) {
  const { selectedLayerId, notify } = useEditor.getState()
  if (!selectedLayerId) {
    notify('Select a layer: the transition goes on its cuts.')
    return
  }
  void run('transition.add', { ids: [selectedLayerId], preset: preset.id, edge: 'any' })
}

const TRANSITION_ITEMS: Item[] = TRANSITIONS.map((t) => ({
  key: t.id,
  name: t.label,
  title: `${t.label}: ${t.tagline}. Goes on the selected layer's cuts (both ends).`,
  preview: transitionPreview(t),
  add: () => transition(t),
}))

/** Gives the selected layer a sound from its entrance: per unit of a text entrance, or once for a whole-layer one. */
function addSound(pack: SoundPack) {
  const { project, selectedLayerId, notify } = useEditor.getState()
  const layer = selectedLayerId ? findLayer(project, selectedLayerId) : undefined
  if (!layer) {
    notify('Select a layer: the sound fires from its entrance.')
    return
  }
  const trigger = layer.kind === 'text' && layer.textIn ? 'text' : 'layer'
  void run('layer.patch', { id: layer.id, ops: [{ op: 'insert', path: 'sounds[-]', value: { pack: pack.id, volume: 0.3, trigger: { kind: trigger }, phase: 'in' } }] }).then((r) => {
    if (r.ok) useEditor.setState({ inspectorOpen: true, rightTab: 'sound' })
  })
}

const SOUND_ITEMS: Item[] = SOUND_PACKS.map((pack) => ({
  key: pack.id,
  name: pack.name,
  title: `${pack.name}: ${pack.tagline}. Fires from the selected layer's entrance (per letter, word or line on text).`,
  preview: <Music size={15} className="text-clip-audio" />,
  play: () => previewPack(pack),
  add: () => addSound(pack),
}))

const CATEGORIES: { id: Category; label: string; icon: IconComponent; items: Item[] }[] = [
  { id: 'all', label: 'Everything', icon: LibraryBig, items: BASICS },
  { id: 'looks', label: 'Text looks', icon: Type, items: LOOK_ITEMS },
  { id: 'animations', label: 'Animations', icon: Sparkles, items: ANIMATION_ITEMS },
  { id: 'transitions', label: 'Transitions', icon: ArrowLeftRight, items: TRANSITION_ITEMS },
  { id: 'sounds', label: 'Sounds', icon: Music, items: SOUND_ITEMS },
  // Stickers are a searchable grid of their own (StickerGrid), not a list of cards.
  { id: 'stickers', label: 'Stickers', icon: StickerIcon, items: [] },
]

/** How many stickers show at first, and how many each "Show more" adds. */
const STICKER_PAGE = 120

const STICKER_CHIPS: { id: StickerStyle | undefined; label: string }[] = [
  { id: undefined, label: 'All' },
  { id: '3d', label: '3D' },
  { id: 'flat', label: 'Flat' },
  { id: 'drawn', label: 'Drawn' },
]

/** The sticker library: search, style chips and a grid. Click places one at the playhead; drag drops it on the picture or timeline. */
function StickerGrid() {
  const [stickers, setStickers] = useState<Sticker[] | null>(null)
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [style, setStyle] = useState<StickerStyle | undefined>(undefined)
  const [shown, setShown] = useState(STICKER_PAGE)

  // The index is asked for when the tab first opens (once per run).
  useEffect(() => {
    let live = true
    stickerIndex().then(
      (all) => live && setStickers(all),
      () => live && setStickers([]),
    )
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 150)
    return () => clearTimeout(timer)
  }, [query])

  const found = useMemo(() => (stickers ? searchStickers(stickers, { query: debounced, style }) : []), [stickers, debounced, style])
  useEffect(() => setShown(STICKER_PAGE), [debounced, style])
  const visible = found.slice(0, shown)

  return (
    <div className="space-y-2">
      <label className="flex h-8 items-center gap-2 rounded-lg bg-field px-2.5 text-muted focus-within:ring-1 focus-within:ring-accent">
        <Search size={14} aria-hidden />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search stickers"
          aria-label="Search stickers"
          className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-muted"
        />
      </label>
      <div className="flex flex-wrap gap-1">
        {STICKER_CHIPS.map((chip) => (
          <button
            key={chip.label}
            type="button"
            aria-pressed={style === chip.id}
            onClick={() => setStyle(chip.id)}
            className={`h-6 rounded-lg px-2.5 text-[11px] font-medium ${style === chip.id ? 'active-tint' : 'bg-field text-muted hover:bg-hover hover:text-ink'}`}
          >
            {chip.label}
          </button>
        ))}
      </div>
      {stickers === null ? null : stickers.length === 0 ? (
        <p className="px-1 text-[11px] text-muted">No stickers found. The library lives in ~/uve-assets.</p>
      ) : (
        <>
          <p className="px-1 text-[10px] text-muted">
            {found.length.toLocaleString('en-US')} {found.length === 1 ? 'sticker' : 'stickers'}
          </p>
          <div className="grid grid-cols-4 gap-1.5">
            {visible.map((sticker) => (
              <button
                key={sticker.id}
                type="button"
                title={sticker.name}
                aria-label={`Add ${sticker.name}`}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(STICKER_DRAG_TYPE, sticker.id)
                  e.dataTransfer.effectAllowed = 'copy'
                }}
                onClick={() => void placeSticker(sticker.id)}
                className="flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-stage p-1 ring-1 ring-line hover:ring-accent/50"
              >
                <img src={mediaUrl(sticker.path)} alt="" loading="lazy" decoding="async" draggable={false} className="size-full object-contain" />
              </button>
            ))}
          </div>
          {found.length > shown && (
            <button
              type="button"
              onClick={() => setShown((n) => n + STICKER_PAGE)}
              className="h-7 w-full rounded-lg bg-field text-[11px] font-medium text-muted hover:bg-hover hover:text-ink"
            >
              Show more
            </button>
          )}
        </>
      )}
    </div>
  )
}

/** How many cards a row shows before "open the category" takes over. */
const ROW_LIMIT = 24

function Section({
  title,
  icon: Icon,
  items,
  note,
  onOpen,
}: {
  title: string
  icon: IconComponent
  items: Item[]
  note?: string
  onOpen?: () => void
}) {
  return (
    <section className="space-y-2">
      <button
        type="button"
        onClick={onOpen}
        disabled={!onOpen}
        title={onOpen ? `Show all ${title.toLowerCase()}` : undefined}
        className="flex items-center gap-2 px-1 text-[12px] font-semibold enabled:hover:text-accent"
      >
        <Icon size={15} className="text-muted" aria-hidden />
        {title}
        <span className="font-normal text-muted">{items.length}</span>
      </button>
      {note && <p className="px-1 text-[10px] text-muted">{note}</p>}
      <div className="-mx-3 flex gap-2 overflow-x-auto px-3 pb-1">
        {items.slice(0, ROW_LIMIT).map((item) => (
          <Card key={item.key} item={item} />
        ))}
      </div>
    </section>
  )
}

export function LibraryPanel() {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<Category>('all')
  const selected = useSelectedLayer()
  const q = query.trim().toLowerCase()
  const match = (items: Item[]) => (q ? items.filter((i) => `${i.name} ${i.title}`.toLowerCase().includes(q)) : items)
  const animationNote = selected ? `Plays on “${selected.name}” from its start.` : 'Select a layer, then pick one.'
  const current = CATEGORIES.find((c) => c.id === category)
  const nothing = q !== '' && CATEGORIES.every((c) => match(c.items).length === 0)

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 p-3 pb-2">
        {category !== 'stickers' && (
          <label className="flex h-8 items-center gap-2 rounded-lg bg-field px-2.5 text-muted focus-within:ring-1 focus-within:ring-accent">
            <Search size={14} aria-hidden />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              aria-label="Search the library"
              className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-muted"
            />
          </label>
        )}
        <div role="tablist" className="flex gap-1">
          {CATEGORIES.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={category === id}
              aria-label={label}
              title={label}
              onClick={() => setCategory(id)}
              className={`flex h-9 flex-1 items-center justify-center rounded-panel ${
                category === id ? 'active-tint' : 'text-muted hover:bg-hover hover:text-ink'
              }`}
            >
              <Icon size={17} />
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-1 pb-3">
        {category === 'all' ? (
          <div className="space-y-5">
            {match(BASICS).length > 0 && <Section title="Basics" icon={Shapes} items={match(BASICS)} />}
            {CATEGORIES.slice(1).map((c) =>
              match(c.items).length > 0 ? (
                <Section
                  key={c.id}
                  title={c.label}
                  icon={c.icon}
                  items={match(c.items)}
                  note={c.id === 'animations' ? animationNote : undefined}
                  onOpen={() => setCategory(c.id)}
                />
              ) : null,
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setCategory('all')}
              className="flex items-center gap-1.5 px-1 text-[12px] font-semibold hover:text-accent"
            >
              <ArrowLeft size={14} />
              {current?.label}
              {category !== 'stickers' && <span className="font-normal text-muted">{match(current?.items ?? []).length}</span>}
            </button>
            {category === 'stickers' && <StickerGrid />}
            {category === 'animations' && <p className="px-1 text-[10px] text-muted">{animationNote}</p>}
            {match(current?.items ?? []).map((item) => (
              <Card key={item.key} item={item} wide />
            ))}
          </div>
        )}
        {nothing && <p className="px-1 text-[11px] text-muted">Nothing matches “{query}”.</p>}
      </div>
    </div>
  )
}
