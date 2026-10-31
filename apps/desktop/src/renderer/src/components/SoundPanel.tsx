import { type Layer, slotAnimation, SOUND_PACK_IDS, type SoundVoice, transitionWindows } from '@uve/core'
import { ArrowRightFromLine, ArrowRightToLine, ChevronDown, ChevronRight, Eye, EyeOff, Play, Plus, Search, Shuffle, Trash2 } from '../icons'
import { type ReactNode, useState } from 'react'
import { mediaUrl } from '../../../shared/media'
import type { SoundResult } from '../library/soundLibrary'
import { previewPack, SOUND_PACKS } from '../library/sounds'
import { run, useActiveComp, useEditor } from '../store'
import { NumberField, type NumberSpec, Row, ScrubLabel, SelectField } from './fields'

// The Sound tab, modelled on AtomCut's: a layer's sounds stack as slots (its
// text entrance and exit, its whole-layer entrance and exit, the transitions
// on its cuts), each with the sounds it fires. Every change is a layer.patch.

type Slot = { trigger: SoundVoice['trigger']['kind']; phase: SoundVoice['phase']; title: string }

const SLOTS: Slot[] = [
  { trigger: 'text', phase: 'in', title: 'Text animate in' },
  { trigger: 'text', phase: 'out', title: 'Text animate out' },
  { trigger: 'layer', phase: 'in', title: 'Layer animate in' },
  { trigger: 'layer', phase: 'out', title: 'Layer animate out' },
  { trigger: 'transition', phase: 'in', title: 'Transition in' },
  { trigger: 'transition', phase: 'out', title: 'Transition out' },
]

const UNIT_LABEL = { letter: 'Per letter', word: 'Per word', line: 'Per line' } as const

function patch(layer: Layer, ops: unknown[]) {
  return run('layer.patch', { id: layer.id, ops })
}

/** What fires a slot's sounds, in words: the animation's unit, or what is missing. */
function firesWhat(layer: Layer, slot: Slot, hasTransition: boolean): string {
  if (slot.trigger === 'transition') return hasTransition ? 'On the transition' : 'No transition on this edge'
  const spec = slotAnimation(layer, slot.trigger, slot.phase)
  if (!spec) return slot.trigger === 'text' ? `No text ${slot.phase === 'in' ? 'entrance' : 'exit'} yet` : `No ${slot.phase === 'in' ? 'entrance' : 'exit'} yet`
  return slot.trigger === 'text' ? UNIT_LABEL[spec.unit] : 'Once'
}

function VoiceRow({ layer, voice, index }: { layer: Layer; voice: SoundVoice; index: number }) {
  const allMedia = useEditor((s) => s.project.media)
  const media = allMedia.filter((m) => m.kind === 'audio' || (m.kind === 'video' && m.hasAudio !== false))
  const set = (field: string, value: unknown) => patch(layer, [{ op: 'set', path: `sounds[id=${voice.id}].${field}`, value }])
  const num = (field: 'volume' | 'pitch' | 'randomness' | 'offsetMs', label: string, min: number, max: number, extra: Partial<NumberSpec> = {}): ReactNode => {
    const spec: NumberSpec = { value: voice[field], bind: (v) => ['layer.patch', { id: layer.id, ops: [{ op: 'set', path: `sounds[id=${voice.id}].${field}`, value: v }] }], min, max, step: 0.01, precision: 2, ...extra }
    return (
      <Row label={<ScrubLabel text={label} spec={spec} />}>
        <NumberField spec={spec} label={label} />
      </Row>
    )
  }
  const source = voice.pack ? `pack:${voice.pack}` : `asset:${voice.custom?.assetId ?? ''}`
  const iconButton = 'rounded-md p-1 text-muted hover:bg-hover hover:text-ink'
  return (
    <div className="space-y-1.5 rounded-panel bg-field/50 p-2">
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1">
          <SelectField
            label="Sound"
            value={source}
            options={[
              ...SOUND_PACKS.map((p) => ({ value: `pack:${p.id}`, label: `${p.name} (pack)` })),
              ...media.map((m) => ({ value: `asset:${m.id}`, label: m.name })),
            ]}
            onCommit={(v) => {
              const [kind, id] = v.split(':') as [string, string]
              void patch(layer, [
                { op: 'set', path: `sounds[id=${voice.id}].pack`, value: kind === 'pack' ? id : null },
                { op: 'set', path: `sounds[id=${voice.id}].custom`, value: kind === 'asset' ? { assetId: id, hitMs: 0 } : null },
              ])
            }}
          />
        </div>
        {voice.pack && (
          <button type="button" onClick={() => void previewPack({ id: voice.pack as (typeof SOUND_PACK_IDS)[number] }, 4, voice.volume, voice.pitch)} aria-label="Preview" title="Hear it" className={iconButton}>
            <Play size={12} />
          </button>
        )}
        <button type="button" onClick={() => void set('enabled', !voice.enabled)} aria-label={voice.enabled ? 'Mute this sound' : 'Unmute this sound'} title={voice.enabled ? 'Switch off' : 'Switch on'} className={iconButton}>
          {voice.enabled ? <Eye size={12} /> : <EyeOff size={12} />}
        </button>
        <button type="button" onClick={() => void patch(layer, [{ op: 'remove', path: `sounds[${index}]` }])} aria-label="Remove sound" title="Remove" className={iconButton}>
          <Trash2 size={12} />
        </button>
      </div>
      {num('volume', 'Volume', 0, 1)}
      {num('pitch', 'Pitch', 0.5, 2)}
      {num('randomness', 'Variation', 0, 1)}
      <Row label="On">
        <SelectField
          label="Anchor"
          value={voice.anchor}
          options={[
            { value: 'start', label: 'Start of each motion' },
            { value: 'peak', label: 'Middle (peak)' },
            { value: 'end', label: 'End' },
          ]}
          onCommit={(v) => void set('anchor', v)}
        />
      </Row>
      {num('offsetMs', 'Offset', -2000, 2000, { step: 1, precision: 0, suffix: 'ms' })}
    </div>
  )
}

/**
 * Searches the packs, the project's sounds and the CC0 sound library; a result
 * can be heard (a library sound is fetched first) and used: sounds.use makes
 * it playable here and gives the value for the stack.
 */
function SoundFinder({ onUse }: { onUse: (value: Pick<SoundVoice, 'pack' | 'custom'>) => void }) {
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [found, setFound] = useState<SoundResult[] | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const search = async () => {
    setBusy(true)
    const result = await run('sounds.list', { query, limit: 20 })
    setBusy(false)
    if (!result.ok) return
    const value = result.value as { results: SoundResult[]; offline?: string }
    setFound(value.results)
    setNote(value.offline ?? (value.results.length === 0 ? `Nothing found for "${query}".` : null))
  }
  const hear = async (r: SoundResult) => {
    if (r.id.startsWith('pack:')) {
      void previewPack({ id: r.id.slice(5) as (typeof SOUND_PACK_IDS)[number] }, 3)
      return
    }
    if (r.id.startsWith('library:')) {
      const [packId = '', soundId = ''] = r.id.slice(8).split('/')
      const file = await window.uve.library.fetch(packId, soundId).catch(() => null)
      if (file) void new Audio(mediaUrl(file.path)).play()
    }
  }
  const use = async (r: SoundResult) => {
    setBusy(true)
    const result = await run('sounds.use', { id: r.id })
    setBusy(false)
    if (result.ok) {
      const { pack, custom } = result.value as Pick<SoundVoice, 'pack' | 'custom'>
      onUse({ pack, custom })
    }
  }
  return (
    <div className="space-y-1.5 rounded-panel bg-field/50 p-2">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void search()
        }}
        className="flex gap-1"
      >
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="whoosh, soft click, #impact…"
          aria-label="Search sounds"
          className="h-7 min-w-0 flex-1 rounded-lg bg-field px-2 text-[12px] outline-none hover:bg-hover focus:ring-1 focus:ring-accent"
        />
        <button type="submit" disabled={busy} className="rounded-lg px-2 text-[11px] text-muted hover:bg-hover hover:text-ink disabled:opacity-50">
          {busy ? '…' : 'Search'}
        </button>
      </form>
      {note && <p className="text-[11px] text-muted">{note}</p>}
      <div className="max-h-56 space-y-0.5 overflow-auto">
        {found?.map((r) => (
          <div key={r.id} className="flex items-center gap-1 rounded-lg px-1.5 py-1 hover:bg-hover">
            <button type="button" onClick={() => void hear(r)} aria-label={`Hear ${r.name}`} title="Hear it" className="rounded-md p-1 text-muted hover:text-ink">
              <Play size={11} />
            </button>
            <span className="min-w-0 flex-1 truncate text-[12px]" title={[r.use ?? r.blurb, r.pack, r.license].filter(Boolean).join(' · ')}>
              {r.name}
              <span className="text-muted"> · {r.source === 'library' ? r.pack : r.source === 'pack' ? 'synth pack' : 'this project'}</span>
            </span>
            <button type="button" disabled={busy} onClick={() => void use(r)} className="rounded-md px-1.5 py-0.5 text-[11px] text-accent hover:bg-accent/15 disabled:opacity-50">
              Use
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function SlotSection({ layer, slot, hasTransition }: { layer: Layer; slot: Slot; hasTransition: boolean }) {
  const voices = layer.sounds.map((voice, index) => ({ voice, index })).filter(({ voice }) => voice.trigger.kind === slot.trigger && voice.phase === slot.phase)
  const [open, setOpen] = useState(voices.length > 0)
  const [finding, setFinding] = useState(false)
  const Chevron = open ? ChevronDown : ChevronRight
  const Icon = slot.trigger === 'transition' ? Shuffle : slot.phase === 'in' ? ArrowRightToLine : ArrowRightFromLine
  const add = () => {
    // Letters type on a keyboard; anything else pops.
    const spec = slot.trigger === 'text' ? slotAnimation(layer, 'text', slot.phase) : null
    const pack = spec?.unit === 'letter' ? 'mechanical' : 'pop'
    setOpen(true)
    void patch(layer, [{ op: 'insert', path: 'sounds[-]', value: { pack, volume: spec?.unit === 'letter' ? 0.2 : 0.3, trigger: { kind: slot.trigger }, phase: slot.phase } }])
  }
  return (
    <section className="px-3 py-1">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className={`flex h-10 w-full items-center gap-2 rounded-panel px-3 text-left text-[13px] font-semibold ${voices.length > 0 ? 'active-tint' : 'hover:bg-hover'}`}>
        <Icon size={14} aria-hidden className={voices.length > 0 ? 'text-accent' : 'text-muted'} />
        <span className="flex-1 truncate">{slot.title}</span>
        <span className="text-[11px] font-normal text-muted">{voices.length > 0 ? `${voices.length} sound${voices.length > 1 ? 's' : ''}` : 'None'}</span>
        <Chevron size={13} aria-hidden className="text-muted" />
      </button>
      {open && (
        <div className="mt-1.5 space-y-1.5 px-1 pb-1">
          <Row label="Fires">
            <span className="text-[12px] text-muted">{firesWhat(layer, slot, hasTransition)}</span>
          </Row>
          {voices.map(({ voice, index }) => (
            <VoiceRow key={voice.id} layer={layer} voice={voice} index={index} />
          ))}
          <div className="flex gap-1">
            <button type="button" onClick={add} className="flex h-8 flex-1 items-center gap-1.5 rounded-lg px-2 text-[12px] text-muted hover:bg-hover hover:text-ink">
              <Plus size={13} aria-hidden />
              Add sound
            </button>
            <button type="button" onClick={() => setFinding(!finding)} aria-expanded={finding} className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12px] text-muted hover:bg-hover hover:text-ink">
              <Search size={13} aria-hidden />
              Find a sound
            </button>
          </div>
          {finding && <SoundFinder onUse={(value) => {
            setFinding(false)
            void patch(layer, [{ op: 'insert', path: 'sounds[-]', value: { ...value, volume: 0.4, trigger: { kind: slot.trigger }, phase: slot.phase } }])
          }} />}
        </div>
      )}
    </section>
  )
}

const NO_CATEGORY = ''

/** Which sound category (bus) the layer's own sound goes to; none sends it straight to master. */
function CategoryRow({ layer }: { layer: Layer }) {
  const categories = useEditor((s) => s.project.soundCategories)
  const current = categories.find((c) => c.id === layer.soundBus)
  const options = [{ value: NO_CATEGORY, label: 'None (master)' }, ...categories.map((c) => ({ value: c.id, label: c.name }))]
  return (
    <div className="px-4 pb-2">
      <Row label="Category">
        <span aria-hidden className="size-2.5 shrink-0 rounded-full bg-field" style={current ? { background: current.color } : undefined} />
        <SelectField
          label="Sound category"
          value={current?.id ?? NO_CATEGORY}
          options={options}
          onCommit={(id) => {
            if (id === NO_CATEGORY) {
              if (layer.soundBus !== undefined) void patch(layer, [{ op: 'remove', path: 'soundBus' }])
            } else void patch(layer, [{ op: 'set', path: 'soundBus', value: id }])
          }}
        />
      </Row>
    </div>
  )
}

export function SoundPanel({ layer }: { layer: Layer }) {
  const comp = useActiveComp()
  const track = comp.tracks.find((t) => t.layers.some((l) => l.id === layer.id))
  const windows = track ? transitionWindows(track) : []
  const slots = SLOTS.filter((s) => s.trigger !== 'text' || layer.kind === 'text')
  return (
    <div className="py-1.5">
      <CategoryRow layer={layer} />
      <p className="px-4 pt-1 pb-2 text-[11px] font-semibold tracking-wider text-muted uppercase">Sounds</p>
      {slots.map((slot) => (
        <SlotSection
          key={`${layer.id}-${slot.trigger}-${slot.phase}`}
          layer={layer}
          slot={slot}
          hasTransition={windows.some((w) => (slot.phase === 'in' ? w.b?.id === layer.id : w.a?.id === layer.id))}
        />
      ))}
    </div>
  )
}
