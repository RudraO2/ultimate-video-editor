import {
  type Comp,
  evaluateProperty,
  FORCE_FALLOFFS,
  FORCE_TYPES,
  type Force,
  isWorld,
  JOINT_TYPES,
  type Joint,
  type Layer,
  PHYSICS_SHAPES,
  PhysicsSceneSchema,
  propertiesOf,
} from '@uve/core'
import { Plus, Trash2 } from '../icons'
import { useEffect, useRef } from 'react'
import { activeComp, findLayer, run, selectionIds, useEditor } from '../store'
import { type Bind, KeyButton, NumberField, type NumberSpec, Row, ScrubLabel, SelectField, TextField } from './fields'
import { bringToLife, selectedLifeTarget } from './CharacterSections'
import { Section, setter, Switch } from './inspectorParts'

// The by-hand controls of physics: a layer's body, its joints and forces, the
// comp's simulation settings, and the layer menu's physics items. Every change
// is a command (physics.body, physics.joint, physics.force, physics.scene,
// effects.update on a force card), so each is one undo step.

type BodyType = 'active' | 'passive' | 'animated'

const BODY_LABELS: Record<BodyType, string> = { active: 'Falls', passive: 'Fixed', animated: 'Keys' }
const TYPE_OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'active', label: 'Falls' },
  { value: 'passive', label: 'Collider' },
  { value: 'animated', label: 'Pushes (moves by its keys)' },
] as const
const SHAPE_LABELS: Record<(typeof PHYSICS_SHAPES)[number], string> = { auto: 'Auto', box: 'Box', sphere: 'Circle', hull: 'Hull', outline: 'Exact' }
const FORCE_LABELS: Record<(typeof FORCE_TYPES)[number], string> = { wind: 'Wind', vortex: 'Vortex', point: 'Point', turbulence: 'Turbulence', drag: 'Drag' }
const FORCE_OPTIONS = FORCE_TYPES.map((value) => ({ value, label: FORCE_LABELS[value] }))
const FALLOFF_LABELS: Record<(typeof FORCE_FALLOFFS)[number], string> = { none: 'None', linear: 'Linear', smooth: 'Smooth' }
const FALLOFF_OPTIONS = FORCE_FALLOFFS.map((value) => ({ value, label: FALLOFF_LABELS[value] }))
const JOINT_LABELS: Record<(typeof JOINT_TYPES)[number], string> = { pin: 'Pin', weld: 'Weld', rope: 'Rope', spring: 'Spring' }
const JOINT_OPTIONS = JOINT_TYPES.map((value) => ({ value, label: JOINT_LABELS[value] }))

const iconButton = 'rounded-md p-1 text-muted hover:bg-hover hover:text-ink'
const addButton = 'flex h-10 w-full items-center justify-center gap-1.5 rounded-panel border border-dashed border-line text-[12px] text-muted hover:bg-hover hover:text-ink'

/** A layer that can be a body: a picture, text, shape, path, nested comp or group on a lane of its own, in a flat comp. */
export function canBeBody(comp: Comp, layer: Layer): boolean {
  if (isWorld(comp)) return false
  if (layer.kind === 'audio' || layer.kind === 'camera' || layer.kind === 'light') return false
  const track = comp.tracks.find((t) => t.layers.some((l) => l.id === layer.id))
  return track !== undefined && track.groupId === null
}

/** The layers a physics change should reach: the selection when this layer is in it, otherwise this layer; only those that can be bodies. */
function bodyTargets(layerId: string): string[] {
  const state = useEditor.getState()
  const comp = activeComp(state)
  const picked = selectionIds()
  const ids = picked.includes(layerId) ? picked : [layerId]
  return ids.filter((id) => {
    const found = findLayer(state.project, id)
    return found !== undefined && canBeBody(comp, found)
  })
}

/** The selected layers that can be bodies (for the layer menu). */
export function selectedBodyTargets(): string[] {
  const { selectedLayerId } = useEditor.getState()
  return selectedLayerId === null ? [] : bodyTargets(selectedLayerId)
}

function numberRow(label: string, spec: NumberSpec, hint?: string) {
  return (
    <Row label={hint ? <span title={hint}>{label}</span> : <ScrubLabel text={label} spec={spec} />}>
      <NumberField spec={spec} label={label} />
    </Row>
  )
}

/** Body: off, falls, collider or pushes; and when on, how it behaves. */
export function BodySection({ layer, comp }: { layer: Layer; comp: Comp }) {
  if (!canBeBody(comp, layer)) return null
  const body = layer.physics
  const ids = () => bodyTargets(layer.id)
  const bind =
    (field: string): Bind<number> =>
    (value) => ['physics.body', { ids: ids(), [field]: value }]
  const pick = (value: string) => void run('physics.body', { ids: ids(), type: value === 'off' ? null : (value as BodyType) })
  const shapes = PHYSICS_SHAPES
  const unit = { step: 0.05, precision: 2, min: 0, max: 1 }
  return (
    <Section title="Physics" action={body ? <span className="text-[11px] text-muted">{BODY_LABELS[body.type]}</span> : undefined}>
      <Row label="Body">
        <SelectField label="Physics body" value={body?.type ?? 'off'} options={TYPE_OPTIONS} onCommit={pick} />
      </Row>
      {body && (
        <>
          <Row label="Shape">
            <SelectField
              label="Collision shape"
              value={body.shape}
              options={shapes.map((value) => ({ value, label: SHAPE_LABELS[value] }))}
              onCommit={(shape) => void run('physics.body', { ids: ids(), shape })}
            />
          </Row>
          {numberRow('Bounce', { ...unit, value: body.bounce, bind: bind('bounce') })}
          {numberRow('Friction', { ...unit, value: body.friction, bind: bind('friction') })}
          {numberRow('Mass', { value: body.mass, bind: bind('mass'), step: 0.1, precision: 2, min: 0.01 })}
          {numberRow('Damping', { ...unit, value: body.damping, bind: bind('damping') })}
          {body.type === 'active' && numberRow('Follow', { ...unit, value: body.follow, bind: bind('follow') })}
          {body.type === 'active' && (
            <>
              <Row label="Push">
                {(['X', 'Y'] as const).map((axis, i) => (
                  <NumberField
                    key={axis}
                    axis={axis}
                    label={`Push ${axis}`}
                    spec={{
                      value: body.velocity[i] ?? 0,
                      bind: (v) => ['physics.body', { ids: ids(), velocity: i === 0 ? [v, body.velocity[1]] : [body.velocity[0], v] }],
                      step: 10,
                      precision: 0,
                      suffix: 'px/s',
                    }}
                  />
                ))}
              </Row>
              {numberRow('Spin', { value: body.spin[2], bind: (v) => ['physics.body', { ids: ids(), spin: [body.spin[0], body.spin[1], v] }], step: 5, precision: 0, suffix: '°/s' })}
              <p className="text-[11px] text-muted">Starts where it is when physics starts (or when its clip does), moving the way its keys were.</p>
            </>
          )}
        </>
      )}
    </Section>
  )
}

/** A rough half-height of a layer in its own px, for placing a new joint at its top centre (0 when it is not cheap to read). */
function halfHeight(layer: Layer): number {
  return layer.kind === 'shape' ? (layer.shape.height * layer.transform.scaleY) / 2 : 0
}

const joint = (id: string, edit: Record<string, unknown>) => ['physics.joint', { id, edit: [edit] }] as [string, unknown]

function JointCard({ layer, comp, item }: { layer: Layer; comp: Comp; item: Joint }) {
  const others = comp.tracks.flatMap((t) => t.layers).filter((l) => l.physics && l.id !== layer.id)
  const targets = [{ value: '', label: 'The comp' }, ...others.map((l) => ({ value: l.id, label: l.name }))]
  const change = (fields: Record<string, unknown>) => void run(...joint(layer.id, { joint: item.id, ...fields }))
  const bindFor =
    (fields: (v: number) => Record<string, unknown>): Bind<number> =>
    (v) => joint(layer.id, { joint: item.id, ...fields(v) })
  const anchor = item.anchor
  const rope = item.type === 'rope' || item.type === 'spring'
  return (
    <div className="space-y-1.5 rounded-panel bg-field/40 p-2">
      <div className="flex items-center gap-1.5">
        <div className="min-w-0 flex-1">
          <SelectField label="Joint type" value={item.type} options={JOINT_OPTIONS} onCommit={(type) => change({ type })} />
        </div>
        <Switch label={item.enabled ? 'Switch the joint off' : 'Switch the joint on'} on={item.enabled} onChange={(enabled) => change({ enabled })} />
        <button type="button" aria-label="Remove joint" title="Remove the joint" onClick={() => void run('physics.joint', { id: layer.id, remove: [item.id] })} className={iconButton}>
          <Trash2 size={13} />
        </button>
      </div>
      <Row label="Holds to">
        <SelectField label="Joint target" value={item.target ?? ''} options={targets} onCommit={(target) => change({ target: target === '' ? null : target })} />
      </Row>
      <Row label="Anchor">
        {(['X', 'Y'] as const).map((axis, i) => (
          <NumberField
            key={axis}
            axis={axis}
            label={`Anchor ${axis}`}
            spec={{ value: anchor[i] ?? 0, bind: bindFor((v) => ({ anchor: i === 0 ? [v, anchor[1], anchor[2]] : [anchor[0], v, anchor[2]] })), step: 1, precision: 0, suffix: 'px' }}
          />
        ))}
      </Row>
      {rope && (
        <Row label={<span title="Empty: the distance when physics starts">Length</span>}>
          <TextField
            label="Joint length"
            value={item.length === null ? '' : String(Number(item.length.toFixed(2)))}
            onCommit={(text) => {
              const n = Number(text.trim())
              if (text.trim() === '') change({ length: null })
              else if (Number.isFinite(n) && n >= 0) change({ length: n })
            }}
          />
        </Row>
      )}
      {item.type === 'spring' && (
        <>
          {numberRow('Stiffness', { value: item.stiffness, bind: bindFor((stiffness) => ({ stiffness })), step: 1, precision: 1, min: 0 })}
          {numberRow('Damping', { value: item.damping, bind: bindFor((damping) => ({ damping })), step: 0.1, precision: 2, min: 0 })}
        </>
      )}
    </div>
  )
}

/** Pins, welds, ropes and springs that hold a body to the comp or to another body. */
export function JointsSection({ layer, comp }: { layer: Layer; comp: Comp }) {
  if (!layer.physics || !canBeBody(comp, layer)) return null
  const joints = layer.joints ?? []
  return (
    <Section title="Joints" action={joints.length > 0 ? <span className="text-[11px] text-muted">{joints.length}</span> : undefined}>
      {joints.map((item) => (
        <JointCard key={item.id} layer={layer} comp={comp} item={item} />
      ))}
      <button
        type="button"
        onClick={() => void run('physics.joint', { id: layer.id, add: [{ type: 'pin', target: null, anchor: [0, -halfHeight(layer), 0] }] })}
        className={addButton}
        title="Pin the layer to the comp at its top centre"
      >
        <Plus size={13} aria-hidden />
        Add joint
      </button>
    </Section>
  )
}

function ForceCard({ layer, force }: { layer: Layer; force: Force }) {
  const timeMs = useEditor((s) => s.timeMs)
  const update = (change: Record<string, unknown>) => void run('effects.update', { id: layer.id, effectId: force.id, ...change })
  const setValue = (values: Record<string, unknown>) => update({ values })
  const at = (key: 'strength' | 'radius' | 'scale'): number => {
    const path = `force.${force.id}.${key}`
    const spec = propertiesOf(layer).find((p) => p.path === path)
    const value = spec ? evaluateProperty(layer, spec, timeMs - layer.startMs) : force[key]
    return typeof value === 'number' ? value : force[key]
  }
  const keyed = (key: 'strength' | 'radius' | 'scale', label: string, spec: Omit<NumberSpec, 'value' | 'bind'>) => {
    const path = `force.${force.id}.${key}`
    const value = at(key)
    const full: NumberSpec = { ...spec, value, bind: setter<number>(layer.id, path, path) }
    return (
      <Row label={<ScrubLabel text={label} spec={full} />} keyButton={<KeyButton layer={layer} targets={[{ alias: path, path, value }]} label={label.toLowerCase()} />}>
        <NumberField spec={full} label={label} />
      </Row>
    )
  }
  const strengthUnit = force.type === 'drag' ? '%/s' : 'px/s²'
  return (
    <div className="space-y-1.5 rounded-panel bg-field/40 p-2">
      <div className="flex items-center gap-1.5">
        <div className="min-w-0 flex-1">
          <SelectField label="Force type" value={force.type} options={FORCE_OPTIONS} onCommit={(type) => setValue({ type })} />
        </div>
        <Switch label={force.enabled ? 'Switch the force off' : 'Switch the force on'} on={force.enabled} onChange={(enabled) => update({ enabled })} />
        <button type="button" aria-label="Remove force" title="Remove the force" onClick={() => update({ remove: true })} className={iconButton}>
          <Trash2 size={13} />
        </button>
      </div>
      {keyed('strength', 'Strength', { step: 10, precision: 0, suffix: strengthUnit })}
      {keyed('radius', 'Radius', { step: 10, precision: 0, min: 0, suffix: 'px' })}
      {force.radius > 0 && (
        <Row label="Falloff">
          <SelectField label="Falloff" value={force.falloff} options={FALLOFF_OPTIONS} onCommit={(falloff) => setValue({ falloff })} />
        </Row>
      )}
      {force.type === 'turbulence' && (
        <>
          {keyed('scale', 'Scale', { step: 10, precision: 0, min: 1, suffix: 'px' })}
          {numberRow('Seed', { value: force.seed, bind: (seed) => ['effects.update', { id: layer.id, effectId: force.id, values: { seed: Math.round(seed) } }], step: 1, precision: 0 })}
        </>
      )}
    </div>
  )
}

/** The forces a layer applies to bodies; shown on any layer that has some. */
export function ForcesSection({ layer, comp }: { layer: Layer; comp: Comp }) {
  const forces = layer.forces ?? []
  if (isWorld(comp) || layer.kind === 'audio' || forces.length === 0) return null
  return (
    <Section title="Forces" action={<span className="text-[11px] text-muted">{forces.length}</span>}>
      {forces.map((force) => (
        <ForceCard key={force.id} layer={layer} force={force} />
      ))}
      <button type="button" onClick={() => void run('physics.force', { id: layer.id, type: 'wind' })} className={addButton}>
        <Plus size={13} aria-hidden />
        Add force
      </button>
    </Section>
  )
}

/** The comp's simulation: gravity, when it starts, floor, walls and speed, with a button for a new force layer. */
export function SimulationSection({ comp }: { comp: Comp }) {
  if (isWorld(comp)) return null
  const scene = PhysicsSceneSchema.parse(comp.physics ?? {})
  const bodies = comp.tracks.reduce((n, t) => n + t.layers.filter((l) => l.physics).length, 0)
  const bind =
    (field: string): Bind<number> =>
    (value) => ['physics.scene', { compId: comp.id, [field]: value }]
  const set = (fields: Record<string, unknown>) => void run('physics.scene', { compId: comp.id, ...fields })
  return (
    <Section title="Simulation" action={<span className="text-[11px] text-muted">{bodies === 1 ? '1 body' : `${bodies} bodies`}</span>}>
      {numberRow('Gravity', { value: scene.gravity, bind: bind('gravity'), step: 10, precision: 0, suffix: 'px/s²' })}
      {numberRow('Start', { value: scene.startMs, bind: bind('startMs'), factor: 0.001, step: 0.05, precision: 2, min: 0, suffix: 's' })}
      {numberRow('Slow-mo', { value: scene.timeScale, bind: bind('timeScale'), step: 0.05, precision: 2, min: 0.05, max: 4, suffix: '×' })}
      <Row label="Floor">
        <Switch label={scene.floor ? 'Floor on: the comp bottom stops bodies' : 'Floor off'} on={scene.floor} onChange={(floor) => set({ floor })} />
      </Row>
      {scene.floor && (
        <Row label={<span title="Empty: the bottom edge of the comp">Floor y</span>}>
          <TextField
            label="Floor height"
            value={scene.floorAt === null ? '' : String(Number(scene.floorAt.toFixed(2)))}
            onCommit={(text) => {
              const n = Number(text.trim())
              if (text.trim() === '') set({ floorAt: null })
              else if (Number.isFinite(n)) set({ floorAt: n })
            }}
          />
        </Row>
      )}
      <Row label="Walls">
        <Switch label={scene.walls ? 'Walls on: the sides and top keep bodies in frame' : 'Walls off'} on={scene.walls} onChange={(walls) => set({ walls })} />
      </Row>
      <button type="button" onClick={() => void run('physics.force', { compId: comp.id, type: 'wind' })} className={addButton} title="A new layer that carries a wind, at the comp's centre">
        <Plus size={13} aria-hidden />
        Add force
      </button>
    </Section>
  )
}

/** The physics items of the layer context menu, at a screen position. Closes on a click outside, Escape or blur. */
export function PhysicsMenu({ x, y, onClose }: { x: number; y: number; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null)
  const project = useEditor((s) => s.project)
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  const ids = selectedBodyTargets()
  const lifeId = selectedLifeTarget()
  if (ids.length === 0 && lifeId === null) return null
  const hasBody = ids.some((id) => findLayer(project, id)?.physics)
  const items: { label: string; type: BodyType | null; show: boolean }[] = [
    { label: 'Make it fall', type: 'active', show: true },
    { label: 'Make it a collider', type: 'passive', show: true },
    { label: 'Pushes: moves by its keys', type: 'animated', show: true },
    { label: 'No physics', type: null, show: hasBody },
  ]
  return (
    <div
      ref={root}
      role="menu"
      aria-label="Physics"
      className="fixed z-50 min-w-52 rounded-panel border border-line bg-card p-1 shadow-float"
      style={{ left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {lifeId !== null && (
        <>
          <p className="px-2.5 pt-1 pb-0.5 text-[11px] font-semibold tracking-wider text-muted uppercase">Character</p>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onClose()
              void bringToLife(lifeId)
            }}
            className="flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-[12px] text-ink hover:bg-hover"
          >
            Bring to life
          </button>
        </>
      )}
      {ids.length > 0 && <p className="px-2.5 pt-1 pb-0.5 text-[11px] font-semibold tracking-wider text-muted uppercase">Physics</p>}
      {items
        .filter((item) => item.show && ids.length > 0)
        .map(({ label, type }) => (
          <button
            key={label}
            type="button"
            role="menuitem"
            onClick={() => {
              onClose()
              void run('physics.body', { ids, type })
            }}
            className="flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-[12px] text-ink hover:bg-hover"
          >
            {label}
          </button>
        ))}
    </div>
  )
}
