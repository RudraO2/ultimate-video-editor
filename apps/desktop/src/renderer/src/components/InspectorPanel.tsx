import {
  ancestorGroups,
  type Comp,
  DEFAULT_MOTION_BLUR,
  formatClock,
  graphemes,
  isSpatialKind,
  isWorld,
  type Layer,
  type Layout,
  type MediaAsset,
  MOTION_BLUR_PRESETS,
  type MotionBlurSettings,
  motionBlurPreset,
  nestedInside,
  type Paint,
  type Stroke,
  type TextRange,
  creditLine,
  creditsOf,
} from '@uve/core'
import { resolveLayer } from '@uve/engine'
import {
  ALargeSmall,
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  Bold,
  Box,
  CaseLower,
  CaseSensitive,
  CaseUpper,
  Eye,
  EyeOff,
  Camera,
  Film,
  Group,
  Image as ImageIcon,
  Italic,
  Layers,
  Link2,
  type LucideIcon,
  MoveHorizontal,
  Lightbulb,
  Move3d,
  Music,
  PenTool,
  Plus,
  Square,
  SquareDashed,
  Strikethrough,
  Trash2,
  Type,
  Underline,
  Unlink2,
  WrapText,
  X,
} from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { enterNested, findLayer, propertyEdit, run, useActiveComp, useEditor, useSelectedLayer } from '../store'
import { AnimatePanel } from './AnimatePanel'
import { CaptionSection } from './CaptionSection'
import { EffectsPanel } from './EffectsPanel'
import { MixPanel } from './MixPanel'
import { SoundPanel } from './SoundPanel'
import { type Axis, AxisRow, ColorProp, NumberProp, patch, Section, setter, Switch } from './inspectorParts'
import { BehaviorsSection, BonesSection, CharacterSection, SwitchSection } from './CharacterSections'
import { BodySection, ForcesSection, JointsSection, SimulationSection } from './PhysicsSections'
import { CameraSection, ControllerSection, LightSection, MaterialSection, MeshSection, MoveInto3dButton, ThicknessSection, TrackSection, WorldCompSection, WorldTransformSection } from './WorldSections'
import {
  type Bind,
  ColorField,
  KeyButton,
  NumberField,
  type NumberSpec,
  Row,
  ScrubLabel,
  SelectField,
  TextField,
  Toggle,
} from './fields'

const KIND_ICONS = { text: Type, shape: Square, path: PenTool, group: Group, nested: Layers, image: ImageIcon, video: Film, audio: Music, camera: Camera, light: Lightbulb, empty: Move3d, mesh: Box } as const

/** The layer's name, with its kind and a delete button, at the top of the inspector. */
function LayerHeader({ layer }: { layer: Layer }) {
  const Icon = KIND_ICONS[layer.kind]
  return (
    <div className="flex h-12 items-center gap-2 border-b border-line pr-2 pl-4">
      <Icon size={16} className="shrink-0 text-muted" aria-hidden />
      <input
        key={layer.name}
        aria-label="Layer name"
        defaultValue={layer.name}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            e.currentTarget.value = layer.name
            e.currentTarget.blur()
          }
        }}
        onBlur={(e) => {
          const name = e.currentTarget.value.trim()
          if (name && name !== layer.name) void patch(layer.id, 'name', name)
        }}
        className="min-w-0 flex-1 rounded-lg bg-transparent px-1.5 py-1 text-[14px] font-semibold outline-none hover:bg-hover focus:bg-field"
      />
      <MoveInto3dButton layer={layer} />
      <button
        type="button"
        onClick={() => void run('layers.delete', { ids: [layer.id] })}
        aria-label="Delete"
        title="Delete this layer (Delete)"
        className="flex size-8 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-ink"
      >
        <Trash2 size={15} />
      </button>
    </div>
  )
}

function LayerSection({ layer }: { layer: Layer }) {
  const fps = useActiveComp().fps
  const seconds = { factor: 0.001, precision: 2, step: 0.01, suffix: 's' }
  const start: NumberSpec = { ...seconds, value: layer.startMs, min: 0, bind: (ms) => ['timeline.move', { id: layer.id, startMs: ms }] }
  const duration: NumberSpec = {
    ...seconds,
    value: layer.durationMs,
    min: 1 / fps,
    bind: (ms) => ['timeline.trim', { id: layer.id, endMs: layer.startMs + ms }],
  }
  return (
    <Section title="Timing">
      <Row label="Shown">
        <Toggle label="Visible" checked={layer.enabled} onChange={(on) => void patch(layer.id, 'enabled', on)} />
      </Row>
      <Row label={<ScrubLabel text="Start" spec={start} />}>
        <NumberField spec={start} label="Start" />
      </Row>
      <Row label={<ScrubLabel text="Duration" spec={duration} />}>
        <NumberField spec={duration} label="Duration" />
      </Row>
    </Section>
  )
}

/** All the transform values at the playhead, for the section's key-all diamond. */
function transformTargets(t: ReturnType<typeof resolveLayer>['transform']) {
  return (Object.keys(t) as (keyof typeof t)[]).map((k) => ({ alias: k, path: `transform.${k}`, value: t[k] }))
}

function TransformSection({ layer, timeMs }: { layer: Layer; timeMs: number }) {
  const t = resolveLayer(layer, timeMs).transform
  const [linked, setLinked] = useState(() => t.scaleX === t.scaleY)
  const px = { precision: 1, suffix: 'px' }
  const deg = { precision: 1, suffix: '°' }
  const percent = { factor: 100, precision: 1, suffix: '%' }
  const axis = (axisName: string, alias: string, value: number): Axis => ({ axis: axisName, alias, path: `transform.${alias}`, value })
  // Linked scale edits both axes through the "scale" alias.
  const scaleAxes = linked
    ? [
        { ...axis('X', 'scale', t.scaleX), path: 'transform.scaleX' },
        { ...axis('Y', 'scale', t.scaleY), path: 'transform.scaleY' },
      ]
    : [axis('X', 'scaleX', t.scaleX), axis('Y', 'scaleY', t.scaleY)]
  return (
    <Section title="Transform" action={<KeyButton layer={layer} targets={transformTargets(t)} label="transform" />}>
      <AxisRow layer={layer} label="Position" axes={[axis('X', 'x', t.x), axis('Y', 'y', t.y)]} spec={px} />
      <Row label="Scale" keyButton={<KeyButton layer={layer} targets={scaleAxes} label="scale" />}>
        <NumberField axis="X" label="Scale X" spec={{ ...percent, value: t.scaleX, bind: setter<number>(layer.id, scaleAxes[0]?.alias ?? 'scaleX', 'transform.scaleX') }} />
        <button
          type="button"
          onClick={() => setLinked(!linked)}
          aria-pressed={linked}
          aria-label={linked ? 'Unlink the scale axes' : 'Link the scale axes'}
          title={linked ? 'X and Y scale together' : 'X and Y scale separately'}
          className={`flex size-7 shrink-0 items-center justify-center rounded-lg ${linked ? 'active-tint' : 'text-muted hover:bg-hover'}`}
        >
          {linked ? <Link2 size={13} /> : <Unlink2 size={13} />}
        </button>
        <NumberField axis="Y" label="Scale Y" spec={{ ...percent, value: t.scaleY, bind: setter<number>(layer.id, scaleAxes[1]?.alias ?? 'scaleY', 'transform.scaleY') }} />
      </Row>
      <AxisRow layer={layer} label="Rotate" axes={[axis('↻', 'rotation', t.rotation)]} spec={deg} />
      <AxisRow layer={layer} label="Depth" axes={[axis('Z', 'z', t.z)]} spec={px} />
      <AxisRow layer={layer} label="Tilt" axes={[axis('X', 'rotationX', t.rotationX), axis('Y', 'rotationY', t.rotationY)]} spec={deg} />
      <AxisRow layer={layer} label="Pivot" axes={[axis('X', 'anchorX', t.anchorX), axis('Y', 'anchorY', t.anchorY)]} spec={percent} />
      <AxisRow layer={layer} label="Opacity" axes={[axis('α', 'opacity', t.opacity)]} spec={{ ...percent, min: 0, max: 100 }} />
    </Section>
  )
}

const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900].map((w) => ({ value: w, label: String(w) }))
const ALIGNS = [
  { value: 'left', icon: AlignLeft },
  { value: 'center', icon: AlignCenter },
  { value: 'right', icon: AlignRight },
  { value: 'justify', icon: AlignJustify },
] as const

const CASES = [
  { value: 'none', label: 'Normal case', icon: CaseSensitive },
  { value: 'upper', label: 'UPPERCASE', icon: CaseUpper },
  { value: 'lower', label: 'lowercase', icon: CaseLower },
  { value: 'title', label: 'Title Case', icon: ALargeSmall },
] as const

/** An icon button that is on or off. */
function IconToggle({ icon: Icon, label, on, onChange }: { icon: LucideIcon; label: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      aria-label={label}
      title={label}
      aria-pressed={on}
      className={`rounded-lg p-1.5 ${on ? 'active-tint' : 'text-muted hover:bg-hover hover:text-ink'}`}
    >
      <Icon size={14} />
    </button>
  )
}

/** A row of icon buttons for picking one value. */
function Segmented<T extends string>({
  value,
  items,
  onPick,
}: {
  value: T
  items: readonly { value: T; label: string; icon: typeof AlignLeft }[]
  onPick: (value: T) => void
}) {
  return (
    <>
      {items.map(({ value: item, label, icon: Icon }) => (
        <button
          key={item}
          type="button"
          onClick={() => item !== value && onPick(item)}
          aria-label={label}
          title={label}
          aria-pressed={value === item}
          className={`rounded-lg p-1.5 ${value === item ? 'active-tint' : 'text-muted hover:bg-hover hover:text-ink'}`}
        >
          <Icon size={14} />
        </button>
      ))}
    </>
  )
}

type Sizing = 'autoW' | 'autoH' | 'fixed'
const SIZINGS = [
  { value: 'autoW', label: 'Auto width: grow on one line', icon: MoveHorizontal },
  { value: 'autoH', label: 'Auto height: wrap at a fixed width', icon: WrapText },
  { value: 'fixed', label: 'Fixed size: a fixed box', icon: SquareDashed },
] as const
const VERTICALS = [
  { value: 'top', label: 'Align top', icon: AlignVerticalJustifyStart },
  { value: 'middle', label: 'Align middle', icon: AlignVerticalJustifyCenter },
  { value: 'bottom', label: 'Align bottom', icon: AlignVerticalJustifyEnd },
] as const

/** The text box: AtomCut's three resizing modes, the box size, and where lines sit in a fixed box. */
function SizingSection({ layer, timeMs }: { layer: Extract<Layer, { kind: 'text' }>; timeMs: number }) {
  const box = resolveLayer(layer, timeMs).textBox
  const sizing: Sizing = layer.maxWidth === null ? (layer.maxHeight === null ? 'autoW' : 'fixed') : layer.maxHeight === null ? 'autoH' : 'fixed'
  const pick = (mode: Sizing) => {
    const width = mode === 'autoW' ? null : (layer.maxWidth ?? 800)
    const height = mode === 'fixed' ? (layer.maxHeight ?? 400) : null
    void run('layer.patch', {
      id: layer.id,
      ops: [
        { op: 'set', path: 'maxWidth', value: width },
        { op: 'set', path: 'maxHeight', value: height },
      ],
    })
  }
  return (
    <Section title="Sizing">
      <Row label="Resizing">
        <Segmented value={sizing} items={SIZINGS} onPick={pick} />
      </Row>
      {sizing !== 'autoW' && (
        <NumberProp layer={layer} alias="maxWidth" path="maxWidth" label="Box width" value={box?.maxWidth ?? 800} precision={0} min={1} suffix="px" />
      )}
      {sizing === 'fixed' && (
        <>
          <NumberProp layer={layer} alias="maxHeight" path="maxHeight" label="Box height" value={box?.maxHeight ?? 400} precision={0} min={1} suffix="px" />
          <Row label="Vertical">
            <Segmented value={layer.verticalAlign} items={VERTICALS} onPick={(v) => void patch(layer.id, 'verticalAlign', v)} />
          </Row>
        </>
      )}
      <Row label="Clip">
        <Toggle label="Clip content" checked={layer.clipContent} onChange={(on) => void patch(layer.id, 'clipContent', on)} />
      </Row>
    </Section>
  )
}

function TextSection({ layer, timeMs }: { layer: Extract<Layer, { kind: 'text' }>; timeMs: number }) {
  const style = resolveLayer(layer, timeMs).style ?? layer.style
  // The characters selected in the text field, as grapheme indices, for styling part of the text.
  const [picked, setPicked] = useState<[number, number] | null>(null)
  return (
    <Section title="Content">
      <Row label="Text">
        <TextField
          label="Text"
          multiline
          value={layer.text}
          onCommit={(text) => void run('text.set', { id: layer.id, text })}
          onSelectText={(from, to) => {
            const start = graphemes(layer.text.slice(0, from)).length
            const end = graphemes(layer.text.slice(0, to)).length
            setPicked(end > start ? [start, end] : null)
          }}
        />
      </Row>
      <PickedStyle layer={layer} picked={picked} />
      <Row label="Font">
        <TextField
          label="Font"
          value={layer.style.fontFamily}
          onCommit={(family) => family.trim() && void patch(layer.id, 'style.fontFamily', family.trim())}
        />
      </Row>
      <Row label="Weight">
        <SelectField
          label="Weight"
          value={layer.style.fontWeight}
          options={WEIGHTS}
          onCommit={(w) => void patch(layer.id, 'style.fontWeight', w)}
        />
      </Row>
      <Row label="Style">
        <IconToggle
          icon={Bold}
          label="Faux bold: thicker, on any weight"
          on={layer.style.fauxBold > 0}
          onChange={(on) => void patch(layer.id, 'style.fauxBold', on ? 0.03 : 0)}
        />
        <IconToggle icon={Italic} label="Italic" on={layer.style.italic} onChange={(on) => void patch(layer.id, 'style.italic', on)} />
        <IconToggle
          icon={Underline}
          label="Underline"
          on={layer.style.decoration === 'underline'}
          onChange={(on) => void patch(layer.id, 'style.decoration', on ? 'underline' : 'none')}
        />
        <IconToggle
          icon={Strikethrough}
          label="Strikethrough"
          on={layer.style.decoration === 'strikethrough'}
          onChange={(on) => void patch(layer.id, 'style.decoration', on ? 'strikethrough' : 'none')}
        />
      </Row>
      <Row label="Case">
        <Segmented value={layer.style.textCase} items={CASES} onPick={(v) => void patch(layer.id, 'style.textCase', v)} />
      </Row>
      <Row label="Align">
        {ALIGNS.map(({ value, icon: Icon }) => (
          <button
            key={value}
            type="button"
            onClick={() => void patch(layer.id, 'style.align', value)}
            aria-label={`Align ${value}`}
            aria-pressed={layer.style.align === value}
            className={`rounded-lg p-1.5 ${layer.style.align === value ? 'active-tint' : 'text-muted hover:bg-hover hover:text-ink'}`}
          >
            <Icon size={14} />
          </button>
        ))}
      </Row>
      <NumberProp layer={layer} alias="fontSize" path="style.fontSize" label="Size" value={style.fontSize} precision={1} min={1} suffix="px" />
      <ColorProp layer={layer} alias="color" path="style.color" label="Colour" value={style.color} />
      <NumberProp layer={layer} alias="lineHeight" path="style.lineHeight" label="Line height" value={style.lineHeight} precision={2} step={0.01} min={0.1} />
      <NumberProp layer={layer} alias="letterSpacing" path="style.letterSpacing" label="Spacing" value={style.letterSpacing} precision={1} suffix="px" />
      <Row label="Highlight">
        <Toggle
          label="Pill behind the lines"
          checked={layer.style.highlight !== null}
          onChange={(on) => void patch(layer.id, 'style.highlight', on ? { color: '#ff4e6a', radius: 10, paddingX: 14, paddingY: 6 } : null)}
        />
        {layer.style.highlight && (
          <ColorField
            label="Highlight colour"
            value={layer.style.highlight.color}
            bind={(color) => ['layer.patch', { id: layer.id, ops: [{ op: 'set', path: 'style.highlight.color', value: color }] }]}
          />
        )}
      </Row>
      <RangesList layer={layer} />
    </Section>
  )
}

/** Styles the characters selected in the text field: colour, weight, size, a pill, or back to plain. */
function PickedStyle({ layer, picked }: { layer: Extract<Layer, { kind: 'text' }>; picked: [number, number] | null }) {
  if (!picked) return <p className="text-[11px] text-muted">Select part of the text to style just those characters.</p>
  const [start, end] = picked
  const excerpt = graphemes(layer.text).slice(start, end).join('')
  const style = (fields: object): [string, unknown] => ['text.style', { id: layer.id, start, end, style: fields }]
  const covering = layer.ranges.find((r) => r.start <= start && r.end >= end)
  return (
    <div className="space-y-1.5 rounded-lg bg-field/60 p-2">
      <p className="truncate text-[11px] text-muted">Style “{excerpt}”</p>
      <Row label="Colour">
        <ColorField label="Selection colour" value={covering?.style.color ?? layer.style.color} bind={(color) => style({ color })} />
      </Row>
      <Row label="Weight">
        <SelectField
          label="Selection weight"
          value={covering?.style.fontWeight ?? layer.style.fontWeight}
          options={WEIGHTS}
          onCommit={(fontWeight) => void run(...style({ fontWeight }))}
        />
      </Row>
      <Row label="Size">
        <NumberField label="Selection size" spec={{ precision: 0, min: 1, suffix: 'px', value: covering?.style.fontSize ?? layer.style.fontSize, bind: (fontSize) => style({ fontSize }) }} />
      </Row>
      <Row label="Style">
        <IconToggle
          icon={Underline}
          label="Underline the selection"
          on={(covering?.style.decoration ?? layer.style.decoration) === 'underline'}
          onChange={(on) => void run(...style({ decoration: on ? 'underline' : 'none' }))}
        />
        <IconToggle
          icon={Strikethrough}
          label="Strike through the selection"
          on={(covering?.style.decoration ?? layer.style.decoration) === 'strikethrough'}
          onChange={(on) => void run(...style({ decoration: on ? 'strikethrough' : 'none' }))}
        />
        <Segmented value={covering?.style.textCase ?? layer.style.textCase} items={CASES} onPick={(textCase) => void run(...style({ textCase }))} />
      </Row>
      <Row label="Pill">
        <Toggle
          label="Highlight"
          checked={Boolean(covering?.style.highlight)}
          onChange={(on) => void run(...style({ highlight: on ? { color: '#ff4e6a', radius: 8, paddingX: 8, paddingY: 4 } : null }))}
        />
        <button
          type="button"
          onClick={() => void run('text.style', { id: layer.id, start, end, clear: true })}
          className="rounded-lg px-2 py-1 text-[11px] text-muted hover:bg-hover hover:text-ink"
        >
          Plain
        </button>
      </Row>
    </div>
  )
}

/** The styled ranges, each with its words, a keyable colour and a remove button. */
function RangesList({ layer }: { layer: Extract<Layer, { kind: 'text' }> }) {
  if (layer.ranges.length === 0) return null
  const units = graphemes(layer.text)
  return (
    <div className="space-y-1.5 pt-1">
      {layer.ranges.map((range: TextRange) => {
        const words = units.slice(range.start, range.end).join('')
        return (
          <Row
            key={range.id}
            label={<span title={words}>“{words}”</span>}
            keyButton={<KeyButton layer={layer} targets={[{ alias: `range.${range.id}.color`, path: `range.${range.id}.color`, value: range.style.color ?? layer.style.color }]} label="range colour" />}
          >
            <ColorField label={`Colour of “${words}”`} value={range.style.color ?? layer.style.color} bind={setter<string>(layer.id, `range.${range.id}.color`, `range.${range.id}.color`)} />
            <button
              type="button"
              onClick={() => void run('text.style', { id: layer.id, start: range.start, end: range.end, clear: true })}
              aria-label={`Remove the style of “${words}”`}
              title="Make these characters plain again"
              className="flex size-6 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-ink"
            >
              <X size={13} />
            </button>
          </Row>
        )
      })}
    </div>
  )
}

const SHAPES = [
  { value: 'rect', label: 'Rectangle' },
  { value: 'ellipse', label: 'Ellipse' },
  { value: 'polygon', label: 'Polygon' },
  { value: 'star', label: 'Star' },
] as const

function ShapeSection({ layer, timeMs }: { layer: Extract<Layer, { kind: 'shape' }>; timeMs: number }) {
  const shape = resolveLayer(layer, timeMs).shape ?? layer.shape
  const px = { precision: 1, suffix: 'px', min: 1 }
  return (
    <Section title="Appearance">
      <Row label="Type">
        <SelectField label="Type" value={layer.shape.type} options={SHAPES} onCommit={(type) => void patch(layer.id, 'shape.type', type)} />
      </Row>
      <NumberProp layer={layer} alias="width" path="shape.width" label="Width" value={shape.width} {...px} />
      <NumberProp layer={layer} alias="height" path="shape.height" label="Height" value={shape.height} {...px} />
      {(shape.type === 'polygon' || shape.type === 'star') && (
        <Row label={shape.type === 'star' ? 'Points' : 'Sides'}>
          <NumberField
            label={shape.type === 'star' ? 'Points' : 'Sides'}
            spec={{ precision: 0, min: 3, max: 100, step: 1, value: layer.shape.pointCount, bind: (n) => ['layer.patch', { id: layer.id, ops: [{ op: 'set', path: 'shape.pointCount', value: Math.round(n) }] }] }}
          />
        </Row>
      )}
      {shape.type === 'star' && (
        <NumberProp layer={layer} alias="innerRatio" path="shape.innerRatio" label="Inner" value={shape.innerRatio} factor={100} precision={0} suffix="%" min={0.01} max={1} />
      )}
      {shape.type === 'rect' && (
        <NumberProp layer={layer} alias="cornerRadius" path="shape.cornerRadius" label="Corners" value={shape.cornerRadius} {...px} min={0} />
      )}
    </Section>
  )
}

type Painted = Extract<Layer, { kind: 'shape' | 'text' | 'group' | 'path' }>

const PAINT_TYPES = [
  { value: 'solid', label: 'Solid' },
  { value: 'linear', label: 'Linear' },
  { value: 'radial', label: 'Radial' },
  { value: 'angular', label: 'Angular' },
] as const
const ALIGNMENTS = [
  { value: 'center', label: 'Centre' },
  { value: 'inside', label: 'Inside' },
  { value: 'outside', label: 'Outside' },
] as const
const CAPS = [
  { value: 'butt', label: 'Butt' },
  { value: 'round', label: 'Round' },
  { value: 'square', label: 'Square' },
] as const
const JOINS = [
  { value: 'miter', label: 'Miter' },
  { value: 'round', label: 'Round' },
  { value: 'bevel', label: 'Bevel' },
] as const

/** The same paint as another type, keeping its colours (ids of new stops are minted by layer.patch). */
function convertPaint(paint: Paint, type: Paint['type']) {
  const base = { id: paint.id, enabled: paint.enabled, opacity: paint.opacity, blendMode: paint.blendMode }
  const first = paint.type === 'solid' ? paint.color : (paint.stops[0]?.color ?? '#ffffff')
  if (type === 'solid') return { ...base, type, color: first }
  const stops =
    paint.type === 'solid'
      ? [
          { offset: 0, color: first },
          { offset: 1, color: `${first.slice(0, 7)}00` },
        ]
      : paint.stops
  return { ...base, type, stops }
}

const percent01 = { factor: 100, precision: 0, suffix: '%', min: 0, max: 1, step: 1 }

/** Small icon buttons at the end of a paint row: show or hide, and remove. */
function PaintRowActions({ enabled, onToggle, onRemove, noun }: { enabled: boolean; onToggle: () => void; onRemove: () => void; noun: string }) {
  const Shown = enabled ? Eye : EyeOff
  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        aria-label={enabled ? `Hide ${noun}` : `Show ${noun}`}
        title={enabled ? `Hide ${noun}` : `Show ${noun}`}
        className="flex size-6 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-ink"
      >
        <Shown size={13} />
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${noun}`}
        title={`Remove ${noun}`}
        className="flex size-6 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-ink"
      >
        <X size={13} />
      </button>
    </>
  )
}

/** A paint's colour, or a gradient's stops, each with its key diamond. `prefix` is fill.<id> or stroke.<id>. */
function PaintFields({ layer, paint, prefix, listPath, colorPath }: { layer: Painted; paint: Paint; prefix: string; listPath: string; colorPath: string }) {
  if (paint.type === 'solid') return <ColorProp layer={layer} alias={colorPath} path={colorPath} label="Colour" value={paint.color} />
  return (
    <>
      {paint.stops.map((stop, i) => (
        <Row
          key={stop.id}
          label={`Stop ${i + 1}`}
          keyButton={<KeyButton layer={layer} targets={[{ alias: `${prefix}.stop.${stop.id}.color`, path: `${prefix}.stop.${stop.id}.color`, value: stop.color }]} label={`stop ${i + 1}`} />}
        >
          <ColorField value={stop.color} bind={setter<string>(layer.id, `${prefix}.stop.${stop.id}.color`, `${prefix}.stop.${stop.id}.color`)} label={`Stop ${i + 1} colour`} />
          <div className="w-16 shrink-0">
            <NumberField
              label={`Stop ${i + 1} position`}
              spec={{ ...percent01, value: stop.offset, bind: setter<number>(layer.id, `${prefix}.stop.${stop.id}.offset`, `${prefix}.stop.${stop.id}.offset`) }}
            />
          </div>
        </Row>
      ))}
      <Row label={paint.type === 'linear' ? 'From' : 'Centre'}>
        <NumberField axis="X" label="Start X" spec={{ factor: 100, precision: 0, suffix: '%', value: paint.start.x, bind: (x) => ['layer.patch', { id: layer.id, ops: [{ op: 'set', path: `${listPath}.start.x`, value: x }] }] }} />
        <NumberField axis="Y" label="Start Y" spec={{ factor: 100, precision: 0, suffix: '%', value: paint.start.y, bind: (y) => ['layer.patch', { id: layer.id, ops: [{ op: 'set', path: `${listPath}.start.y`, value: y }] }] }} />
      </Row>
      <Row label={paint.type === 'linear' ? 'To' : paint.type === 'radial' ? 'Edge' : 'Angle'}>
        <NumberField axis="X" label="End X" spec={{ factor: 100, precision: 0, suffix: '%', value: paint.end.x, bind: (x) => ['layer.patch', { id: layer.id, ops: [{ op: 'set', path: `${listPath}.end.x`, value: x }] }] }} />
        <NumberField axis="Y" label="End Y" spec={{ factor: 100, precision: 0, suffix: '%', value: paint.end.y, bind: (y) => ['layer.patch', { id: layer.id, ops: [{ op: 'set', path: `${listPath}.end.y`, value: y }] }] }} />
      </Row>
    </>
  )
}

/** AtomCut's Fill section: the layer's fills, bottom to top, each with its paint, opacity, eye and remove. */
function FillSection({ layer, timeMs }: { layer: Painted; timeMs: number }) {
  const fills = resolveLayer(layer, timeMs).fills ?? layer.fills
  const add = () => void run('layer.patch', { id: layer.id, ops: [{ op: 'insert', path: 'fills[-]', value: { type: 'solid', color: '#B0B4BB' } }] })
  return (
    <Section title="Fill" action={<AddButton label="Add fill" onClick={add} />}>
      {fills.length === 0 && (
        <EmptyAdd
          label={layer.kind === 'text' ? 'Add fill (the ink colour shows while there is none)' : layer.kind === 'group' ? "Add fill (the container's background)" : 'Add fill'}
          onClick={add}
        />
      )}
      {fills.map((fill, i) => {
        const at = `fills[id=${fill.id}]`
        const prefix = `fill.${fill.id}`
        return (
          <div key={fill.id} className={`space-y-1.5 ${i > 0 ? 'border-t border-line pt-1.5' : ''} ${fill.enabled ? '' : 'opacity-50'}`}>
            <Row label={fills.length > 1 ? `Fill ${i + 1}` : 'Type'}>
              <SelectField label="Paint type" value={fill.type} options={PAINT_TYPES} onCommit={(type) => void patch(layer.id, at, convertPaint(fill, type))} />
              <PaintRowActions noun="fill" enabled={fill.enabled} onToggle={() => void patch(layer.id, `${at}.enabled`, !fill.enabled)} onRemove={() => void run('layer.patch', { id: layer.id, ops: [{ op: 'remove', path: at }] })} />
            </Row>
            <PaintFields layer={layer} paint={fill} prefix={prefix} listPath={at} colorPath={prefix} />
            <NumberProp layer={layer} alias={`${prefix}.opacity`} path={`${prefix}.opacity`} label="Opacity" value={fill.opacity} {...percent01} />
          </div>
        )
      })}
    </Section>
  )
}

/** AtomCut's Stroke section: each stroke's paint, width, alignment, ends, dashes and trim (draw-on). */
function StrokeSection({ layer, timeMs }: { layer: Painted; timeMs: number }) {
  const strokes = resolveLayer(layer, timeMs).strokes ?? layer.strokes
  const add = () =>
    void run('layer.patch', { id: layer.id, ops: [{ op: 'insert', path: 'strokes[-]', value: { paint: { type: 'solid', color: '#1E1E1E' }, width: 2 } }] })
  const px = { precision: 1, suffix: 'px', min: 0 }
  return (
    <Section title="Stroke" action={<AddButton label="Add stroke" onClick={add} />}>
      {strokes.length === 0 && <EmptyAdd label="Add stroke" onClick={add} />}
      {strokes.map((stroke: Stroke, i) => {
        const at = `strokes[id=${stroke.id}]`
        const prefix = `stroke.${stroke.id}`
        const prop = (key: string) => `${prefix}.${key}`
        return (
          <div key={stroke.id} className={`space-y-1.5 ${i > 0 ? 'border-t border-line pt-1.5' : ''} ${stroke.enabled ? '' : 'opacity-50'}`}>
            <Row label={strokes.length > 1 ? `Stroke ${i + 1}` : 'Type'}>
              <SelectField label="Paint type" value={stroke.paint.type} options={PAINT_TYPES} onCommit={(type) => void patch(layer.id, `${at}.paint`, convertPaint(stroke.paint, type))} />
              <PaintRowActions noun="stroke" enabled={stroke.enabled} onToggle={() => void patch(layer.id, `${at}.enabled`, !stroke.enabled)} onRemove={() => void run('layer.patch', { id: layer.id, ops: [{ op: 'remove', path: at }] })} />
            </Row>
            <PaintFields layer={layer} paint={stroke.paint} prefix={prefix} listPath={`${at}.paint`} colorPath={prop('color')} />
            <NumberProp layer={layer} alias={prop('width')} path={prop('width')} label="Width" value={stroke.width} {...px} />
            <Row label="Align">
              <SelectField label="Stroke alignment" value={stroke.align} options={ALIGNMENTS} onCommit={(v) => void patch(layer.id, `${at}.align`, v)} />
            </Row>
            <Row label="Ends">
              <SelectField label="Line ends" value={stroke.cap} options={CAPS} onCommit={(v) => void patch(layer.id, `${at}.cap`, v)} />
              <SelectField label="Corners" value={stroke.join} options={JOINS} onCommit={(v) => void patch(layer.id, `${at}.join`, v)} />
            </Row>
            <NumberProp layer={layer} alias={prop('dashLength')} path={prop('dashLength')} label="Dash" value={stroke.dash[0] ?? 0} {...px} />
            {stroke.dash.length > 0 && (
              <NumberProp layer={layer} alias={prop('dashGap')} path={prop('dashGap')} label="Gap" value={stroke.dash[1] ?? stroke.dash[0] ?? 0} {...px} />
            )}
            {layer.kind !== 'text' && (
              <>
                <NumberProp layer={layer} alias={prop('trim.start')} path={prop('trim.start')} label="Trim start" value={stroke.trim.start} {...percent01} />
                <NumberProp layer={layer} alias={prop('trim.end')} path={prop('trim.end')} label="Trim end" value={stroke.trim.end} {...percent01} />
                <NumberProp layer={layer} alias={prop('trim.offset')} path={prop('trim.offset')} label="Trim offset" value={stroke.trim.offset} factor={100} precision={0} suffix="%" />
              </>
            )}
            <NumberProp layer={layer} alias={prop('opacity')} path={prop('opacity')} label="Opacity" value={stroke.opacity} {...percent01} />
          </div>
        )
      })}
    </Section>
  )
}

const FLOWS = [
  { value: 'column', label: 'Column' },
  { value: 'row', label: 'Row' },
  { value: 'wrap', label: 'Wrap' },
  { value: 'grid', label: 'Grid' },
] as const
const PLACES = [
  { value: 'start', label: 'Start' },
  { value: 'center', label: 'Centre' },
  { value: 'end', label: 'End' },
] as const

/** Changes part of a group's layout (layout.set merges). */
const setLayout = (id: string, fields: Partial<Layout>): [string, unknown] => ['layout.set', { id, layout: fields }]

/** A group's auto layout: off, or its flow, spacing, padding, alignment, size and box. */
function LayoutSection({ layer }: { layer: Extract<Layer, { kind: 'group' }> }) {
  const layout = layer.layout
  const px = { precision: 0, suffix: 'px', min: 0 }
  if (!layout) {
    return (
      <Section title="Auto layout">
        <EmptyAdd label="Add auto layout (arrange the members in a row or column)" onClick={() => void run('layout.set', { id: layer.id, layout: {} })} />
      </Section>
    )
  }
  const field = (key: keyof Layout, label: string, value: number, extra: object = {}) => (
    <Row label={label}>
      <NumberField label={label} spec={{ ...px, ...extra, value, bind: (v) => setLayout(layer.id, { [key]: v }) }} />
    </Row>
  )
  const size = (key: 'width' | 'height', label: string) => {
    const value = layout[key]
    return (
      <Row label={label}>
        {value === null ? (
          <span className="flex-1 text-[11px] text-muted">Hugs the members</span>
        ) : (
          <NumberField label={label} spec={{ ...px, min: 1, value, bind: (v) => setLayout(layer.id, { [key]: v }) }} />
        )}
        <Toggle label="Fixed" checked={value !== null} onChange={(on) => void run(...setLayout(layer.id, { [key]: on ? 400 : null }))} />
      </Row>
    )
  }
  return (
    <Section
      title="Auto layout"
      action={
        <button
          type="button"
          onClick={() => void run('layout.set', { id: layer.id, layout: null })}
          aria-label="Remove auto layout"
          title="Remove the auto layout; the members stay where they are"
          className="flex size-6 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-ink"
        >
          <X size={14} />
        </button>
      }
    >
      <Row label="Flow">
        <SelectField label="Flow" value={layout.flow} options={FLOWS} onCommit={(flow) => void run(...setLayout(layer.id, { flow }))} />
      </Row>
      {layout.flow === 'grid' && field('columns', 'Columns', layout.columns, { min: 1, suffix: '' })}
      {field('gap', 'Gap', layout.gap)}
      {(layout.flow === 'wrap' || layout.flow === 'grid') && field('lineGap', 'Line gap', layout.lineGap)}
      <Row label="Padding">
        <NumberField axis="↕" label="Padding top and bottom" spec={{ ...px, value: layout.padding.top, bind: (v) => setLayout(layer.id, { padding: { ...layout.padding, top: v, bottom: v } }) }} />
        <NumberField axis="↔" label="Padding left and right" spec={{ ...px, value: layout.padding.left, bind: (v) => setLayout(layer.id, { padding: { ...layout.padding, left: v, right: v } }) }} />
      </Row>
      <Row label="Align">
        <SelectField label="Align across" value={layout.alignX} options={PLACES} onCommit={(alignX) => void run(...setLayout(layer.id, { alignX }))} />
        <SelectField label="Align down" value={layout.alignY} options={PLACES} onCommit={(alignY) => void run(...setLayout(layer.id, { alignY }))} />
      </Row>
      <Row label="Spread">
        <Toggle label="Space between" checked={layout.spaceBetween} onChange={(on) => void run(...setLayout(layer.id, { spaceBetween: on }))} />
      </Row>
      {size('width', 'Width')}
      {size('height', 'Height')}
      <Row label="Box">
        <NumberField axis="X" label="Box left" spec={{ precision: 0, suffix: 'px', value: layout.x, bind: (v) => setLayout(layer.id, { x: v }) }} />
        <NumberField axis="Y" label="Box top" spec={{ precision: 0, suffix: 'px', value: layout.y, bind: (v) => setLayout(layer.id, { y: v }) }} />
      </Row>
      <NumberProp layer={layer} alias="cornerRadius" path="cornerRadius" label="Corners" value={layer.cornerRadius} precision={0} min={0} suffix="px" />
      <Row label="Clip">
        <Toggle label="Clip content" checked={layout.clipContent} onChange={(on) => void run(...setLayout(layer.id, { clipContent: on }))} />
      </Row>
    </Section>
  )
}

/** How a member of an auto layout is sized: stretch across, or opt out and keep its own place. */
/** A member's part in its group: how a layout sizes it, and whether it cuts or masks the others. */
function LayoutItemSection({ layer }: { layer: Layer }) {
  const comp = useActiveComp()
  const parent = ancestorGroups(comp, layer.id)[0]
  const cuts = parent !== undefined && parent.mode !== 'pass' && parent.mode !== 'union'
  if (!parent || (!parent.layout && !cuts)) return null
  const item = layer.layoutItem
  const set = (key: 'fillX' | 'fillY' | 'absolute', on: boolean) => void patch(layer.id, `layoutItem.${key}`, on)
  return (
    <Section title={`In ${parent.name}`}>
      {parent.layout && (
        <>
          <Row label="Stretch">
            <Toggle label="Fill width" checked={item.fillX} onChange={(on) => set('fillX', on)} />
            <Toggle label="Fill height" checked={item.fillY} onChange={(on) => set('fillY', on)} />
          </Row>
          <Row label="Place">
            <Toggle label="Absolute (ignore the layout)" checked={item.absolute} onChange={(on) => set('absolute', on)} />
          </Row>
        </>
      )}
      {cuts && (
        <Row label="Stencil">
          <Toggle label={`Cut with it (${parent.mode})`} checked={layer.isStencil} onChange={(on) => void patch(layer.id, 'isStencil', on)} />
        </Row>
      )}
    </Section>
  )
}

const MODES = [
  { value: 'pass', label: 'Pass (each as it is)' },
  { value: 'union', label: 'Union (one picture)' },
  { value: 'mask', label: 'Mask (inside the stencil)' },
  { value: 'subtract', label: 'Subtract (cut the stencil out)' },
  { value: 'intersect', label: 'Intersect' },
  { value: 'exclude', label: 'Exclude' },
] as const

/** A group's mode: how its members combine. */
function GroupSection({ layer }: { layer: Extract<Layer, { kind: 'group' }> }) {
  return (
    <Section title="Group">
      <Row label="Mode">
        <SelectField label="Group mode" value={layer.mode} options={MODES} onCommit={(mode) => void patch(layer.id, 'mode', mode)} />
      </Row>
      {layer.mode !== 'pass' && layer.mode !== 'union' && (
        <p className="text-[11px] text-muted">The stencils are the members marked Stencil; with none marked, the front-most member cuts.</p>
      )}
    </Section>
  )
}

const FILL_RULES = [
  { value: 'nonzero', label: 'Non-zero' },
  { value: 'evenodd', label: 'Even-odd (overlaps are holes)' },
] as const

/** A path's outline as SVG path data, and its fill rule. */
function PathSection({ layer }: { layer: Extract<Layer, { kind: 'path' }> }) {
  return (
    <Section title="Path">
      <Row label="Data" keyButton={<KeyButton layer={layer} targets={[{ alias: 'geometry', path: 'geometry', value: layer.geometry }]} label="path" />}>
        <TextField
          label="Path data"
          multiline
          value={layer.geometry}
          onCommit={(d) => {
            const live = findLayer(useEditor.getState().project, layer.id)
            if (!live) return
            const [name, input] = propertyEdit(live, 'geometry', 'geometry', d)
            void run(name, input)
          }}
        />
      </Row>
      <Row label="Fill rule">
        <SelectField label="Fill rule" value={layer.fillRule} options={FILL_RULES} onCommit={(rule) => void patch(layer.id, 'fillRule', rule)} />
      </Row>
    </Section>
  )
}

function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex size-6 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-ink"
    >
      <Plus size={14} />
    </button>
  )
}

/** The dashed "Add …" button an empty paint list shows, as in AtomCut. */
function EmptyAdd({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-line py-1.5 text-[11px] text-muted hover:border-accent hover:text-ink"
    >
      <Plus size={13} /> {label}
    </button>
  )
}

function describeSource(media: MediaAsset): string {
  const parts: string[] = []
  if (media.width && media.height) parts.push(`${media.width}×${media.height}`)
  if (media.fps) parts.push(`${Math.round(media.fps * 100) / 100} fps`)
  if (media.durationMs && media.kind !== 'image') parts.push(formatClock(media.durationMs))
  return parts.join(' · ')
}

function MediaSection({ layer, timeMs }: { layer: Extract<Layer, { kind: 'image' | 'video' | 'audio' }>; timeMs: number }) {
  const media = useEditor((s) => s.project.media.find((m) => m.id === layer.mediaId))
  const playable = layer.kind === 'video' || layer.kind === 'audio' ? layer : null
  const volume = resolveLayer(layer, timeMs).volume ?? 1
  return (
    <Section title="Media">
      <Row label="File">
        <span className="truncate" title={media?.path}>
          {media?.name ?? 'missing'}
        </span>
      </Row>
      {media && describeSource(media) && (
        <Row label="Source">
          <span className="truncate text-muted">{describeSource(media)}</span>
        </Row>
      )}
      {playable && (
        <>
          <Row label="In point">
            <span className="tabular-nums">{(playable.sourceStartMs / 1000).toFixed(2)} s</span>
          </Row>
          <NumberProp layer={layer} alias="volume" path="volume" label="Volume" value={volume} factor={100} precision={0} min={0} max={400} suffix="%" />
          <Row label="Sound">
            <Toggle label="Muted" checked={playable.muted} onChange={(on) => void patch(layer.id, 'muted', on)} />
          </Row>
        </>
      )}
    </Section>
  )
}

const CLIPS = [
  { value: 'auto', label: 'Auto' },
  { value: 'crop', label: 'Crop' },
  { value: 'spill', label: 'Spill' },
] as const
const LOOPS = [
  { value: 'none', label: 'Play once' },
  { value: 'loop', label: 'Loop' },
  { value: 'pingpong', label: 'Back and forth' },
] as const

/** A patch of one field as a field binding. */
const patchBind =
  (id: string, path: string): Bind<number> =>
  (value) => ['layer.patch', { id, ops: [{ op: 'set', path, value }] }]

/** A nested comp: what it shows, how its clock runs, whether it crops, and its sound. */
function NestedSection({ layer }: { layer: Extract<Layer, { kind: 'nested' }> }) {
  const source = useEditor((s) => s.project.comps.find((c) => c.id === layer.sourceCompId))
  const inside = useEditor((s) => nestedInside(s.project, layer))
  const clip = layer.clipContent === null ? 'auto' : layer.clipContent ? 'crop' : 'spill'
  return (
    <Section title="Nested comp">
      <Row label="Comp">
        <span className="min-w-0 flex-1 truncate" title={source ? `${source.width} × ${source.height}, ${formatClock(source.durationMs)}` : undefined}>
          {source?.name ?? 'missing'}
        </span>
        <button
          type="button"
          onClick={() => enterNested(layer.id)}
          title="Edit the comp inside (or double-click the layer)"
          className="rounded-lg px-2 py-1 text-[11px] text-muted hover:bg-hover hover:text-ink"
        >
          Open
        </button>
      </Row>
      <Row label="Inside">
        <span className="min-w-0 flex-1 truncate text-muted">{inside === 'embedded' ? 'Its own comp' : 'Linked: edits show everywhere it is used'}</span>
        {inside === 'linked' && (
          <button
            type="button"
            onClick={() => void run('layers.makeUnique', { ids: [layer.id] })}
            title="Give this layer its own copy of the comp"
            className="shrink-0 rounded-lg px-2 py-1 text-[11px] text-muted hover:bg-hover hover:text-ink"
          >
            Make unique
          </button>
        )}
      </Row>
      <Row label="Clip">
        <SelectField
          label="Clip content: Auto crops a comp with a background and lets a transparent one spill"
          value={clip}
          options={CLIPS}
          onCommit={(value) => void patch(layer.id, 'clipContent', value === 'auto' ? null : value === 'crop')}
        />
      </Row>
      <Row label="Speed">
        <NumberField label="Speed" spec={{ value: layer.playback.speed, bind: patchBind(layer.id, 'playback.speed'), step: 1, min: 1, max: 1600, factor: 100, precision: 0, suffix: '%' }} />
      </Row>
      <Row label="Loop">
        <SelectField label="Loop" value={layer.playback.loop} options={LOOPS} onCommit={(loop) => void patch(layer.id, 'playback.loop', loop)} />
      </Row>
      <Row label="Starts at">
        <NumberField label="Source time at the layer's start" spec={{ value: layer.trimInMs, bind: patchBind(layer.id, 'trimInMs'), step: 10, min: 0, factor: 0.001, precision: 2, suffix: 's' }} />
      </Row>
      <Row label="Volume">
        <NumberField label="Volume" spec={{ value: layer.volume, bind: patchBind(layer.id, 'volume'), step: 1, min: 0, max: 400, factor: 100, precision: 0, suffix: '%' }} />
      </Row>
      <Row label="Sound">
        <Toggle label="Muted" checked={layer.muted} onChange={(on) => void patch(layer.id, 'muted', on)} />
      </Row>
    </Section>
  )
}

/** The preset whose settings these are, or null for custom ones. */
function presetOf(settings: MotionBlurSettings): string | null {
  const same = (a: MotionBlurSettings, b: MotionBlurSettings) => (Object.keys(DEFAULT_MOTION_BLUR) as (keyof MotionBlurSettings)[]).every((k) => a[k] === b[k])
  return MOTION_BLUR_PRESETS.find((p) => same(settings, motionBlurPreset(p.id) as MotionBlurSettings))?.id ?? null
}

const QUALITY = [
  { value: 'velocity', label: 'Fast', title: 'A straight smear along the motion. One extra pass.' },
  { value: 'transform', label: 'Exact', title: 'The layer placed at each moment of the shutter. Arcs and spins are exact.' },
  { value: 'content', label: 'Full', title: 'The layer drawn anew at each moment: changes inside it blur too. Costly.' },
] as const

/** The shutter controls shared by the comp's and a layer's motion blur: preset, shutter, phase, quality. */
function ShutterRows({
  settings,
  onPreset,
  onField,
  numbers,
}: {
  settings: MotionBlurSettings
  onPreset: (id: string) => void
  onField: (field: keyof MotionBlurSettings, value: string | number) => void
  numbers: { angle: NumberSpec; phase: NumberSpec; keyAngle?: ReactNode; keyPhase?: ReactNode }
}) {
  const preset = presetOf(settings)
  return (
    <>
      <Row label="Preset">
        <SelectField
          label="Motion blur preset"
          value={preset ?? 'custom'}
          options={[...MOTION_BLUR_PRESETS.map((p) => ({ value: p.id, label: p.label })), ...(preset ? [] : [{ value: 'custom', label: 'Custom' }])]}
          onCommit={(id) => id !== 'custom' && onPreset(id)}
        />
      </Row>
      <Row label={<ScrubLabel text="Shutter" spec={numbers.angle} />} keyButton={numbers.keyAngle}>
        <NumberField spec={numbers.angle} label="Shutter angle" />
      </Row>
      <Row label={<ScrubLabel text="Phase" spec={numbers.phase} />} keyButton={numbers.keyPhase}>
        <NumberField spec={numbers.phase} label="Shutter phase" />
      </Row>
      <Row label="Quality">
        <div className="grid flex-1 grid-cols-3 gap-1">
          {QUALITY.map((q) => (
            <button
              key={q.value}
              type="button"
              title={q.title}
              onClick={() => onField('sampling', q.value)}
              className={`h-7 rounded-lg text-[11px] ${settings.sampling === q.value ? 'active-tint' : 'bg-field text-muted hover:bg-hover hover:text-ink'}`}
            >
              {q.label}
            </button>
          ))}
        </div>
      </Row>
    </>
  )
}

function MotionBlurSection({ layer, timeMs }: { layer: Layer; timeMs: number }) {
  const comp = useActiveComp()
  const { enabled, override } = layer.motionBlur
  const { enabled: masterOn, ...master } = comp.motionBlur
  const resolved = resolveLayer(layer, timeMs).motionBlur.override ?? master
  // Changing the shutter of a layer that uses the comp's first gives it the comp's settings as its own.
  const own = (calls: { command: string; input: unknown }[]) =>
    override ? calls : [{ command: 'layer.patch', input: { id: layer.id, ops: [{ op: 'set', path: 'motionBlur.override', value: master }] } }, ...calls]
  const shutter = (field: 'shutterAngle' | 'shutterPhase'): Bind<number> => (value) => {
    const [command, input] = propertyEdit(layer, `mblur.${field}`, `mblur.${field}`, value)
    return ['api.batch', { calls: own([{ command, input }]) }]
  }
  const angle: NumberSpec = { value: resolved.shutterAngle, bind: shutter('shutterAngle'), min: 0, max: 720, precision: 0, suffix: '°' }
  const phase: NumberSpec = { value: resolved.shutterPhase, bind: shutter('shutterPhase'), min: -360, max: 360, precision: 0, suffix: '°' }
  const key = (field: string, value: number) => <KeyButton layer={layer} targets={[{ alias: `mblur.${field}`, path: `mblur.${field}`, value }]} label={field} />
  const patch = (path: string, value: unknown) => run('layer.patch', { id: layer.id, ops: [{ op: 'set', path, value }] })
  return (
    <Section title="Motion blur" action={<Switch on={enabled} onChange={(on) => void patch('motionBlur.enabled', on)} label={enabled ? 'Motion blur on' : 'Motion blur off'} />}>
      {!masterOn && <p className="text-[11px] text-muted">The comp's motion blur is off (select nothing to change it).</p>}
      {enabled && (
        <>
          <ShutterRows
            settings={resolved}
            onPreset={(id) => void patch('motionBlur.override', motionBlurPreset(id))}
            onField={(field, value) => void run('api.batch', { calls: own([{ command: 'layer.patch', input: { id: layer.id, ops: [{ op: 'set', path: `motionBlur.override.${field}`, value }] } }]) })}
            numbers={{ angle, phase, keyAngle: key('shutterAngle', resolved.shutterAngle), keyPhase: key('shutterPhase', resolved.shutterPhase) }}
          />
          <p className="flex items-center gap-2 text-[11px] text-muted">
            <span className="flex-1">{override ? 'Its own shutter.' : "The comp's shutter."}</span>
            {override && (
              <button type="button" onClick={() => void patch('motionBlur.override', null)} className="rounded-lg px-2 py-1 hover:bg-hover hover:text-ink">
                Use the comp's
              </button>
            )}
          </p>
        </>
      )}
    </Section>
  )
}

function CompMotionBlurSection({ comp }: { comp: Comp }) {
  const blur = comp.motionBlur
  const set = (fields: Record<string, unknown>) => run('frame.update', { id: comp.id, motionBlur: fields })
  const angle: NumberSpec = { value: blur.shutterAngle, bind: (v) => ['frame.update', { id: comp.id, motionBlur: { shutterAngle: v } }], min: 0, max: 720, precision: 0, suffix: '°' }
  const phase: NumberSpec = { value: blur.shutterPhase, bind: (v) => ['frame.update', { id: comp.id, motionBlur: { shutterPhase: v } }], min: -360, max: 360, precision: 0, suffix: '°' }
  return (
    <Section title="Motion blur" action={<Switch on={blur.enabled} onChange={(enabled) => void set({ enabled })} label={blur.enabled ? 'Motion blur on' : 'Motion blur off'} />}>
      {blur.enabled ? (
        <ShutterRows settings={blur} onPreset={(preset) => void set({ preset })} onField={(field, value) => void set({ [field]: value })} numbers={{ angle, phase }} />
      ) : (
        <p className="text-[11px] text-muted">Off for every layer in this comp.</p>
      )}
    </Section>
  )
}

function LayerInspector({ layer }: { layer: Layer }) {
  // Values show at the playhead, so animated properties read as they look.
  const timeMs = useEditor((s) => s.timeMs)
  const comp = useActiveComp()
  const world = isWorld(comp)
  return (
    <>
      <LayerHeader layer={layer} />
      {layer.kind !== 'audio' && (world ? <WorldTransformSection layer={layer} timeMs={timeMs} /> : <TransformSection layer={layer} timeMs={timeMs} />)}
      {layer.kind === 'mesh' && <MeshSection layer={layer} timeMs={timeMs} />}
      {world && ['text', 'shape', 'path', 'image', 'video', 'nested'].includes(layer.kind) && <ThicknessSection layer={layer} timeMs={timeMs} />}
      {world && layer.kind !== 'audio' && (layer.kind === 'mesh' || !isSpatialKind(layer.kind)) && <MaterialSection layer={layer} timeMs={timeMs} />}
      {layer.kind === 'camera' && <CameraSection layer={layer} timeMs={timeMs} />}
      {layer.kind === 'light' && <LightSection layer={layer} timeMs={timeMs} />}
      {layer.kind === 'empty' && <ControllerSection layer={layer} />}
      {world && layer.kind !== 'audio' && <TrackSection layer={layer} comp={comp} />}
      {layer.kind === 'text' && <SizingSection layer={layer} timeMs={timeMs} />}
      {layer.kind === 'text' && <TextSection layer={layer} timeMs={timeMs} />}
      {layer.kind === 'text' && <CaptionSection layer={layer} />}
      {layer.kind === 'shape' && <ShapeSection layer={layer} timeMs={timeMs} />}
      <LayoutItemSection layer={layer} />
      {layer.kind === 'group' && <GroupSection layer={layer} />}
      {layer.kind === 'group' && <LayoutSection layer={layer} />}
      {layer.kind === 'path' && <PathSection layer={layer} />}
      {layer.kind === 'nested' && <NestedSection layer={layer} />}
      {(layer.kind === 'shape' || layer.kind === 'text' || layer.kind === 'path' || (layer.kind === 'group' && layer.layout)) && (
        <FillSection layer={layer} timeMs={timeMs} />
      )}
      {(layer.kind === 'shape' || layer.kind === 'text' || layer.kind === 'path' || (layer.kind === 'group' && layer.layout)) && (
        <StrokeSection layer={layer} timeMs={timeMs} />
      )}
      {(layer.kind === 'image' || layer.kind === 'video' || layer.kind === 'audio') && (
        <MediaSection layer={layer} timeMs={timeMs} />
      )}
      {!world && <CharacterSection key={layer.id} layer={layer} comp={comp} />}
      {layer.kind === 'group' && <SwitchSection layer={layer} comp={comp} timeMs={timeMs} />}
      {layer.kind === 'group' && <BonesSection layer={layer} timeMs={timeMs} />}
      {layer.kind === 'group' && <BehaviorsSection layer={layer} />}
      {!world && <BodySection layer={layer} comp={comp} />}
      {!world && <JointsSection layer={layer} comp={comp} />}
      {!world && <ForcesSection layer={layer} comp={comp} />}
      {layer.kind !== 'audio' && <MotionBlurSection layer={layer} timeMs={timeMs} />}
      <LayerSection layer={layer} />
    </>
  )
}

function CompInspector({ comp }: { comp: Comp }) {
  const update = (field: string) => (value: unknown) => ['frame.update', { id: comp.id, [field]: value }] as [string, unknown]
  const size = { precision: 0, min: 16, max: 8192, suffix: 'px' }
  const width: NumberSpec = { ...size, value: comp.width, bind: (v) => update('width')(Math.round(v)) }
  const height: NumberSpec = { ...size, value: comp.height, bind: (v) => update('height')(Math.round(v)) }
  const fps: NumberSpec = { value: comp.fps, bind: update('fps'), precision: 3, min: 1, max: 240, suffix: 'fps' }
  const duration: NumberSpec = {
    value: comp.durationMs,
    bind: update('durationMs'),
    factor: 0.001,
    precision: 2,
    step: 0.1,
    min: 0.1,
    suffix: 's',
  }
  const still: NumberSpec = {
    value: comp.stillMs,
    bind: update('atMs'),
    factor: 0.001,
    precision: 2,
    step: 0.1,
    min: 0,
    max: comp.durationMs * 0.001,
    suffix: 's',
  }
  const overflowChoice = comp.overflow === null ? 'auto' : comp.overflow === 0 ? 'crop' : 'spill'
  const projectName = useEditor((s) => s.project.name)
  const pages = useEditor((s) => s.project.pages)
  return (
    <>
      {isWorld(comp) && <WorldCompSection comp={comp} />}
      <Section title="Project">
        <Row label="Name">
          <TextField label="Project name" value={projectName} onCommit={(name) => name.trim() && void run('project.update', { name })} />
        </Row>
      </Section>
      <Section title="Comp">
        <Row label="Name">
          <TextField label="Comp name" value={comp.name} onCommit={(name) => name.trim() && void run(...update('name')(name.trim()))} />
        </Row>
        <Row label={<ScrubLabel text="Width" spec={width} />}>
          <NumberField spec={width} label="Width" />
        </Row>
        <Row label={<ScrubLabel text="Height" spec={height} />}>
          <NumberField spec={height} label="Height" />
        </Row>
        <Row label="Frame rate">
          <NumberField spec={fps} label="Frame rate" />
        </Row>
        <Row label={<ScrubLabel text="Duration" spec={duration} />}>
          <NumberField spec={duration} label="Duration" />
        </Row>
        <Row label="Background">
          <ColorField value={comp.background} bind={(v) => update('background')(v)} label="Background" />
        </Row>
        <Row label="Mode">
          <SelectField
            label="Frame mode"
            value={comp.mode}
            options={[
              { value: 'timeline', label: 'Timeline' },
              { value: 'static', label: 'Static' },
            ]}
            onCommit={(mode) => void run(...update('mode')(mode))}
          />
        </Row>
        {comp.mode === 'static' && (
          <Row label={<ScrubLabel text="Still at" spec={still} />}>
            <NumberField spec={still} label="Still at" />
          </Row>
        )}
        <Row label="Overflow">
          <SelectField
            label="Overflow when nested"
            value={overflowChoice}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'crop', label: 'Crop' },
              { value: 'spill', label: 'Show all' },
            ]}
            onCommit={(choice) =>
              void run('frame.update', { id: comp.id, ops: [{ op: 'set', path: 'overflow', value: choice === 'auto' ? null : choice === 'crop' ? 0 : 1 }] })
            }
          />
        </Row>
        {!comp.embedded && (
          <Row label="Page">
            <SelectField
              label="Page"
              value={comp.pageId ?? pages[0]?.id ?? ''}
              options={pages.map((p) => ({ value: p.id, label: p.name }))}
              onCommit={(pageId) => void run(...update('pageId')(pageId))}
            />
          </Row>
        )}
        <p className="pt-2 text-[11px] text-muted">
          {comp.tracks.length} track{comp.tracks.length === 1 ? '' : 's'}. Select a layer to edit it.
        </p>
      </Section>
      {!isWorld(comp) && <SimulationSection comp={comp} />}
      <CompMotionBlurSection comp={comp} />
      <CreditsSection />
    </>
  )
}

/** The licences and credits of the sounds and icons taken from libraries, with a button to copy them for a description. */
function CreditsSection() {
  const project = useEditor((s) => s.project)
  const credits = useMemo(() => creditsOf(project), [project])
  if (credits.length === 0) return null
  const lines = credits.map(creditLine)
  return (
    <Section title="Credits">
      <ul className="space-y-1 text-[11px] text-muted">
        {lines.map((line) => (
          <li key={line} className="leading-snug">
            {line}
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(lines.join('\n'))
          useEditor.getState().notify('Credits copied')
        }}
        className="rounded-lg bg-field px-2.5 py-1 text-[11px] text-ink hover:bg-hover"
      >
        Copy credits
      </button>
    </Section>
  )
}

export function InspectorPanel() {
  const comp = useActiveComp()
  const layer = useSelectedLayer()
  const tab = useEditor((s) => s.rightTab)
  return (
    // Keyed by the selection and the tab, so each opens scrolled to the top.
    <div key={`${layer?.id ?? comp.id}-${tab}`} className="h-full overflow-auto">
      {layer && tab === 'animate' ? (
        <>
          <LayerHeader layer={layer} />
          <AnimatePanel layer={layer} />
        </>
      ) : layer && tab === 'sound' ? (
        <>
          <LayerHeader layer={layer} />
          <SoundPanel layer={layer} />
        </>
      ) : layer && tab === 'effects' ? (
        <>
          <LayerHeader layer={layer} />
          <EffectsPanel layer={layer} />
        </>
      ) : layer ? (
        <LayerInspector layer={layer} />
      ) : tab === 'sound' ? (
        <MixPanel />
      ) : (
        <CompInspector comp={comp} />
      )}
    </div>
  )
}
