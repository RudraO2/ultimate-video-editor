import { type Behavior, type Comp, evaluateProperty, isWorld, type Layer, memberInfos, propertiesOf } from '@uve/core'
import { Sparkles, Trash2 } from '../icons'
import { Fragment, useState } from 'react'
import { activeComp, findLayer, run, useEditor } from '../store'
import {
  BEHAVIOR_FIELDS,
  BEHAVIOR_TITLES,
  behaviorNumber,
  LIFE_KEYS,
  LIFE_LABELS,
  lifeNotes,
  lifeToggles,
  type LifeKey,
} from './characterRows'
import { KeyButton, NumberField, type NumberSpec, Row, ScrubLabel } from './fields'
import { AxisRow, NumberProp, Section, Switch } from './inspectorParts'

// The by-hand controls of characters: bring a drawing to life, pick which
// drawing a switch shows, pose the bones of a rig, and tune the behaviours.
// Every change is a command (character.bringToLife, switch.show, layer.set on
// bone.<id>.<channel>, behaviors.update|remove), so each is one undo step.

type Group = Extract<Layer, { kind: 'group' }>

const iconButton = 'rounded-md p-1 text-muted hover:bg-hover hover:text-ink'
const addButton = 'flex h-10 w-full items-center justify-center gap-1.5 rounded-panel border border-dashed border-line text-[12px] text-muted hover:bg-hover hover:text-ink'
const pickButton = 'h-7 min-w-0 truncate rounded-lg px-2.5 text-[11px]'

/** A layer that can be brought to life: anything with a picture or drawing, in a flat comp. */
export function canBringToLife(comp: Comp, layer: Layer): boolean {
  if (isWorld(comp)) return false
  return layer.kind !== 'audio' && layer.kind !== 'camera' && layer.kind !== 'light' && layer.kind !== 'mesh' && layer.kind !== 'empty'
}

/** The selected layer when the layer menu can bring it to life, else null. */
export function selectedLifeTarget(): string | null {
  const state = useEditor.getState()
  if (state.selectedLayerId === null) return null
  const layer = findLayer(state.project, state.selectedLayerId)
  return layer !== undefined && canBringToLife(activeComp(state), layer) ? layer.id : null
}

/** Runs character.bringToLife; returns its life report (reasons for what could not be done), or undefined when it failed. */
export async function bringToLife(id: string, fields: Record<string, unknown> = {}): Promise<unknown> {
  const result = await run('character.bringToLife', { id, ...fields })
  if (!result.ok) return undefined
  const value = result.value as { characterId?: string; life?: unknown }
  // A single picture is wrapped in a group: follow the selection to it.
  if (typeof value.characterId === 'string' && value.characterId !== id) useEditor.getState().select(value.characterId)
  return value.life ?? {}
}

function numberRow(label: string, spec: NumberSpec) {
  return (
    <Row label={<ScrubLabel text={label} spec={spec} />}>
      <NumberField spec={spec} label={label} />
    </Row>
  )
}

/** Bring to life, and the life functions (blink, breathe, nod, talk, look) as toggles. */
export function CharacterSection({ layer, comp }: { layer: Layer; comp: Comp }) {
  const [notes, setNotes] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  if (!canBringToLife(comp, layer)) return null
  const group = layer.kind === 'group' ? layer : undefined
  const on = lifeToggles(group?.behaviors ?? [])
  const go = async (fields: Record<string, unknown> = {}) => {
    setBusy(true)
    try {
      const life = await bringToLife(layer.id, fields)
      if (life !== undefined) setNotes(lifeNotes(life))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section title="Character">
      <button
        type="button"
        disabled={busy}
        onClick={() => void go()}
        className={`${addButton} disabled:opacity-40`}
        title="Finds the eyes, mouth and body, then makes it blink, breathe, nod and talk"
      >
        <Sparkles size={13} aria-hidden />
        Bring to life
      </button>
      {group && (
        <div className="flex flex-wrap gap-1.5">
          {LIFE_KEYS.map((key: LifeKey) => (
            <button
              key={key}
              type="button"
              disabled={busy}
              aria-pressed={on[key]}
              title={on[key] ? `Switch ${LIFE_LABELS[key].toLowerCase()} off` : `Switch ${LIFE_LABELS[key].toLowerCase()} on`}
              onClick={() => void go({ [key]: !on[key] })}
              className={`${pickButton} disabled:opacity-40 ${on[key] ? 'active-tint' : 'bg-field text-ink hover:bg-hover'}`}
            >
              {LIFE_LABELS[key]}
            </button>
          ))}
        </div>
      )}
      {notes.map((note) => (
        <p key={note} className="text-[11px] text-muted">
          {note}
        </p>
      ))}
    </Section>
  )
}

/** Which member a switch shows: its drawings by name, keyable (the keys hold). */
export function SwitchSection({ layer, comp, timeMs }: { layer: Group; comp: Comp; timeMs: number }) {
  if (layer.switch === null) return null
  const members = memberInfos(comp, layer)
  const spec = propertiesOf(layer).find((p) => p.path === 'switch')
  const at = spec ? evaluateProperty(layer, spec, timeMs - layer.startMs) : layer.switch
  const current = Math.max(0, Math.floor(typeof at === 'number' ? at : layer.switch))
  const keyed = (layer.animations.switch?.length ?? 0) > 0
  const show = (index: number) => void run('switch.show', { id: layer.id, show: index, ...(keyed ? { key: true, atMs: timeMs } : {}) })
  return (
    <Section title="Switch" action={<KeyButton layer={layer} targets={[{ alias: 'switch', path: 'switch', value: current }]} label="switch" />}>
      <div className="flex flex-wrap gap-1.5">
        {members.map((m) => (
          <button
            key={m.id}
            type="button"
            aria-pressed={m.index === current}
            title={keyed ? `Show ${m.name} from the playhead on` : `Show ${m.name}`}
            onClick={() => show(m.index)}
            className={`${pickButton} ${m.index === current ? 'active-tint' : 'bg-field text-ink hover:bg-hover'}`}
          >
            {m.name}
          </button>
        ))}
      </div>
    </Section>
  )
}

/** One bone's pose: turn, move and stretch, all keyable. */
function BoneCard({ layer, bone, timeMs }: { layer: Group; bone: NonNullable<Group['rig']>['bones'][number]; timeMs: number }) {
  const props = propertiesOf(layer)
  const at = (channel: 'rotation' | 'x' | 'y' | 'scale'): number => {
    const path = `bone.${bone.id}.${channel}`
    const spec = props.find((p) => p.path === path)
    const value = spec ? evaluateProperty(layer, spec, timeMs - layer.startMs) : bone.pose[channel]
    return typeof value === 'number' ? value : bone.pose[channel]
  }
  const path = (channel: string) => `bone.${bone.id}.${channel}`
  return (
    <div className="space-y-1.5 rounded-panel bg-field/40 p-2">
      <p className="truncate text-[11px] font-semibold text-ink" title={bone.name}>
        {bone.name}
      </p>
      <NumberProp layer={layer} alias={path('rotation')} path={path('rotation')} label="Turn" value={at('rotation')} step={0.5} precision={1} suffix="°" />
      <AxisRow
        layer={layer}
        label="Move"
        axes={[
          { axis: 'X', alias: path('x'), path: path('x'), value: at('x') },
          { axis: 'Y', alias: path('y'), path: path('y'), value: at('y') },
        ]}
        spec={{ step: 1, precision: 1, suffix: 'px' }}
      />
      <NumberProp layer={layer} alias={path('scale')} path={path('scale')} label="Stretch" value={at('scale')} step={0.01} precision={2} min={0} />
    </div>
  )
}

/** The bones of a rig, a card each. */
export function BonesSection({ layer, timeMs }: { layer: Group; timeMs: number }) {
  const bones = layer.rig?.bones ?? []
  if (bones.length === 0) return null
  return (
    <Section title="Bones" action={<span className="text-[11px] text-muted">{bones.length}</span>}>
      {bones.map((bone) => (
        <BoneCard key={bone.id} layer={layer} bone={bone} timeMs={timeMs} />
      ))}
    </Section>
  )
}

function BehaviorCard({ group, item }: { group: Group; item: Behavior }) {
  const update = (fields: Record<string, unknown>) => ['behaviors.update', { groupId: group.id, id: item.id, fields }] as [string, unknown]
  const title = BEHAVIOR_TITLES[item.type]
  return (
    <div className="space-y-1.5 rounded-panel bg-field/40 p-2">
      <div className="flex items-center gap-1.5">
        <p className="min-w-0 flex-1 truncate text-[11px] font-semibold text-ink">{title}</p>
        <Switch
          label={item.enabled ? `Switch ${title.toLowerCase()} off` : `Switch ${title.toLowerCase()} on`}
          on={item.enabled}
          onChange={(enabled) => void run('behaviors.update', { groupId: group.id, id: item.id, enabled })}
        />
        <button type="button" aria-label={`Remove ${title.toLowerCase()}`} title={`Remove ${title.toLowerCase()}`} onClick={() => void run('behaviors.remove', { groupId: group.id, id: item.id })} className={iconButton}>
          <Trash2 size={13} />
        </button>
      </div>
      {BEHAVIOR_FIELDS[item.type].map(({ key, label, ...rest }) => (
        <Fragment key={key}>{numberRow(label, { ...rest, value: behaviorNumber(item, key), bind: (value) => update({ [key]: value }) })}</Fragment>
      ))}
      {numberRow('Seed', { value: item.seed, bind: (value) => update({ seed: Math.round(value) }), step: 1, precision: 0 })}
    </div>
  )
}

/** The life behaviours of a group, a card each. */
export function BehaviorsSection({ layer }: { layer: Group }) {
  if (layer.behaviors.length === 0) return null
  return (
    <Section title="Behaviours" action={<span className="text-[11px] text-muted">{layer.behaviors.length}</span>}>
      {layer.behaviors.map((item) => (
        <BehaviorCard key={item.id} group={layer} item={item} />
      ))}
    </Section>
  )
}
