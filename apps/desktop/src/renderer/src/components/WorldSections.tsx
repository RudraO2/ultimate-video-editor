import {
  type Comp,
  EMPTY_DISPLAYS,
  ENVIRONMENT_PRESETS,
  evaluateProperty,
  FLOOR_MODES,
  isSpatialKind,
  isWorld,
  type Layer,
  LIGHT_TYPES,
  type LightType,
  MATERIAL_MODELS,
  MATERIAL_PRESETS,
  MESH_DEFAULT_COLOR,
  MESH_SHADING,
  meshGeometryAt,
  PRIMITIVES,
  propertiesOf,
  SHADOW_QUALITIES,
  TONE_MAPPINGS,
} from '@uve/core'
import { resolveLayer } from '@uve/engine'
import { Box, X } from '../icons'
import { findLayer, propertyEdit, run, selectionIds, session, useActiveComp, useEditor } from '../store'
import { type Bind, ColorField, KeyButton, type KeyTarget, NumberField, type NumberSpec, Row, ScrubLabel, SelectField, Toggle } from './fields'
import { type Axis, AxisRow, ColorProp, NumberProp, patch, Section } from './inspectorParts'
import { aoRows, bloomRows, cameraRows, dofRows, floorRows, focusCandidates, lightRows, materialRows, meshRows, trackTargets, worldTransformRows } from './worldRows'

// The 3D parts of the inspector: the world's own section, the 3D transform
// rows, the camera, light and controller sections, and the header's "3D"
// action. Every change is a command (layer.set, layer.patch, frame.update,
// world.move_into), so each is one undo step.

type Of<K extends Layer['kind']> = Extract<Layer, { kind: K }>

/** A field written by layer.patch. */
const patchBind =
  (id: string, path: string): Bind<number> =>
  (value) => ['layer.patch', { id, ops: [{ op: 'set', path, value }] }]

/** A keyable number at the playhead (the key's value when the property is animated). */
function valueAt(layer: Layer, path: string, timeMs: number, fallback: number): number {
  const spec = propertiesOf(layer).find((s) => s.path === path)
  const value = spec ? evaluateProperty(layer, spec, timeMs - layer.startMs) : undefined
  return typeof value === 'number' ? value : fallback
}

/** A colour at the playhead. */
function colorAt(layer: Layer, path: string, timeMs: number, fallback: string): string {
  const spec = propertiesOf(layer).find((s) => s.path === path)
  const value = spec ? evaluateProperty(layer, spec, timeMs - layer.startMs) : undefined
  return typeof value === 'string' ? value : fallback
}

const TRANSPARENT = '#00000000'
const WORLD_BACKGROUND = '#16171b'

const TONE_LABELS: Record<(typeof TONE_MAPPINGS)[number], string> = { agx: 'AgX', aces: 'ACES', neutral: 'Neutral', none: 'None' }
const TONE_OPTIONS = TONE_MAPPINGS.map((value) => ({ value, label: TONE_LABELS[value] }))
const SHADOW_SIZES: Record<(typeof SHADOW_QUALITIES)[number], string> = { low: 'Low 512', medium: 'Medium 1024', high: 'High 2048' }
const SHADOW_OPTIONS = SHADOW_QUALITIES.map((value) => ({ value, label: SHADOW_SIZES[value] }))
const BLOOM_SOURCES = [
  { value: 'bright', label: 'Bright areas' },
  { value: 'emission', label: 'Emission only' },
] as const
const FLOOR_LABELS: Record<(typeof FLOOR_MODES)[number], string> = { none: 'None', shadow: 'Shadow', solid: 'Solid', mirror: 'Mirror' }
const FLOOR_OPTIONS = FLOOR_MODES.map((value) => ({ value, label: FLOOR_LABELS[value] }))

/** The open world's own settings, shown where a flat comp's sections are. */
export function WorldCompSection({ comp }: { comp: Comp }) {
  const transparent = comp.background.length === 9 && comp.background.endsWith('00')
  const world = comp.world
  const look = (input: Record<string, unknown>) => void run('world.look', { compId: comp.id, ...input })
  const lookBind =
    <T,>(make: (value: T) => Record<string, unknown>): Bind<T> =>
    (value) => ['world.look', { compId: comp.id, ...make(value) }]
  const number = (label: string, spec: Omit<NumberSpec, 'bind'>, make: (value: number) => Record<string, unknown>) => {
    const full: NumberSpec = { ...spec, bind: lookBind(make) }
    return (
      <Row label={<ScrubLabel text={label} spec={full} />}>
        <NumberField spec={full} label={label} />
      </Row>
    )
  }
  return (
    <Section title="3D world">
      <Row label="Background">
        <Toggle
          label="Transparent"
          checked={transparent}
          onChange={(on) => void run('frame.update', { id: comp.id, background: on ? TRANSPARENT : WORLD_BACKGROUND })}
        />
      </Row>
      {world && (
        <>
          <Row label="Tone map">
            <SelectField label="Tone mapping" value={world.render.toneMapping} options={TONE_OPTIONS} onCommit={(toneMapping) => look({ toneMapping })} />
          </Row>
          {number('Exposure', { value: world.render.exposure, precision: 1, step: 0.1, min: -10, max: 10, suffix: 'EV' }, (exposure) => ({ exposure }))}
          <Row label="Shadows">
            <Toggle label="Cast shadows" checked={world.render.shadows} onChange={(shadows) => look({ shadows })} />
          </Row>
          {world.render.shadows && (
            <Row label="Quality">
              <SelectField label="Shadow quality" value={world.render.shadowQuality} options={SHADOW_OPTIONS} onCommit={(shadowQuality) => look({ shadowQuality })} />
            </Row>
          )}
          <Row label="Mist">
            <Toggle label="Mist" checked={world.fog.enabled} onChange={(enabled) => look({ mist: { enabled } })} />
          </Row>
          {world.fog.enabled && (
            <>
              <Row label="Colour">
                <ColorField label="Mist colour" value={world.fog.color} bind={lookBind<string>((color) => ({ mist: { color } }))} />
              </Row>
              {number('Start', { value: world.fog.start, precision: 0, step: 10, min: 0, suffix: 'px' }, (start) => ({ mist: { start } }))}
              {number('End', { value: world.fog.end, precision: 0, step: 10, min: 0, suffix: 'px' }, (end) => ({ mist: { end } }))}
            </>
          )}
          <Row label="Bloom">
            <Toggle label="Bloom" checked={world.render.bloom.enabled} onChange={(enabled) => look({ bloom: { enabled } })} />
          </Row>
          {bloomRows(world.render.bloom.enabled).settings && (
            <>
              {number('Strength', { value: world.render.bloom.strength, precision: 2, step: 0.05, min: 0, max: 3 }, (strength) => ({ bloom: { enabled: true, strength } }))}
              {number('Radius', { value: world.render.bloom.radius, precision: 2, step: 0.02, min: 0, max: 1 }, (radius) => ({ bloom: { enabled: true, radius } }))}
              {number('Threshold', { value: world.render.bloom.threshold, precision: 2, step: 0.02, min: 0, max: 1 }, (threshold) => ({ bloom: { enabled: true, threshold } }))}
              <Row label="Source">
                <SelectField label="Bloom source" value={world.render.bloom.source} options={BLOOM_SOURCES} onCommit={(source) => look({ bloom: { enabled: true, source } })} />
              </Row>
            </>
          )}
          <Row label="Occlusion">
            <Toggle label="Ambient occlusion" checked={world.render.ao.enabled} onChange={(enabled) => look({ ao: { enabled } })} />
          </Row>
          {aoRows(world.render.ao.enabled).settings && (
            <>
              {number('AO radius', { value: world.render.ao.radius, precision: 0, step: 5, min: 1, max: 5000, suffix: 'px' }, (radius) => ({ ao: { enabled: true, radius } }))}
              {number('AO strength', { value: world.render.ao.strength, precision: 2, step: 0.05, min: 0, max: 2 }, (strength) => ({ ao: { enabled: true, strength } }))}
            </>
          )}
          <Row label="Floor">
            <SelectField label="Floor mode" value={world.render.floor.mode} options={FLOOR_OPTIONS} onCommit={(mode) => look({ floor: { mode } })} />
          </Row>
          {floorRows(world.render.floor.mode).settings && (
            <>
              <Row label="Colour">
                <ColorField label="Floor colour" value={world.render.floor.color} bind={lookBind<string>((color) => ({ floor: { color } }))} />
              </Row>
              {number('Opacity', { value: world.render.floor.opacity, factor: 100, precision: 0, step: 1, min: 0, max: 100, suffix: '%' }, (opacity) => ({ floor: { opacity } }))}
              {number('Height', { value: world.render.floor.z, precision: 0, step: 1, suffix: 'px' }, (z) => ({ floor: { z } }))}
            </>
          )}
        </>
      )}
      <p className="text-[11px] text-muted">Z is up. Cameras, lights and controllers sit on their own lanes; the topmost visible camera is the live one.</p>
    </Section>
  )
}

/** A field of a layer's material that does not key, written by world.material. */
const materialBind =
  <T,>(id: string, field: string): Bind<T> =>
  (value) => ['world.material', { ids: id, values: { [field]: value } }]

const MODEL_LABELS: Record<(typeof MATERIAL_MODELS)[number], string> = { pbr: 'Physical', toon: 'Toon', unlit: 'Unlit' }
const MODEL_OPTIONS = MATERIAL_MODELS.map((value) => ({ value, label: MODEL_LABELS[value] }))
const PRESET_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'custom', label: 'Custom' },
  ...MATERIAL_PRESETS.map((p) => ({ value: p.id, label: p.id.charAt(0).toUpperCase() + p.id.slice(1) })),
]
const PERCENT = { factor: 100, precision: 0, min: 0, max: 100, step: 1, suffix: '%' }

/** The picture layers a material change should reach: the selection, when this layer is in it. */
function materialTargets(layer: Layer): string[] {
  const project = useEditor.getState().project
  const picked = selectionIds()
  const ids = picked.includes(layer.id) ? picked : [layer.id]
  return ids.filter((id) => {
    const found = findLayer(project, id)
    return found && found.kind !== 'audio' && (found.kind === 'mesh' || !isSpatialKind(found.kind))
  })
}

/** How a picture of a 3D world takes light: a preset, then the fields of its material. */
export function MaterialSection({ layer, timeMs }: { layer: Layer; timeMs: number }) {
  // A model's file materials are not fields to edit: they count as no material here (a preset replaces them).
  const model = layer.kind === 'mesh' && layer.geometry.type === 'asset'
  const material = layer.material && layer.material.source !== 'file' ? layer.material : undefined
  const pick = (preset: string) => {
    if (preset === 'custom') return
    void run('world.material', { ids: materialTargets(layer), preset: preset === 'none' ? null : preset })
  }
  const value = material ? (material.preset && MATERIAL_PRESETS.some((p) => p.id === material.preset) ? material.preset : 'custom') : 'none'
  const options = material || value !== 'none' ? PRESET_OPTIONS : PRESET_OPTIONS.filter((o) => o.value !== 'custom')
  const use = MATERIAL_PRESETS.find((p) => p.id === value)?.use
  const picker = (
    <Row label={<span title={use}>Preset</span>}>
      <SelectField label="Material preset" value={value} options={options} onCommit={pick} />
    </Row>
  )
  if (!material) {
    return (
      <Section title="Material">
        {picker}
        <p className="text-[11px] text-muted">
          {model ? "The model shows the file's own materials. Pick a preset to replace them." : layer.kind === 'mesh' ? 'No material: the mesh keeps its plain colour. Pick one to shine, glow or go glassy.' : 'An unlit picture: lights do not touch it. Pick a material to light it.'}
        </p>
      </Section>
    )
  }
  const show = materialRows(material.model, valueAt(layer, 'material.transmission', timeMs, material.transmission), material.clearcoat)
  const roughness = valueAt(layer, 'material.roughness', timeMs, material.roughness)
  const metalness = valueAt(layer, 'material.metalness', timeMs, material.metalness)
  const glow = valueAt(layer, 'material.emissionStrength', timeMs, material.emissionStrength)
  const emission = colorAt(layer, 'material.emission', timeMs, material.emission)
  const transmission = valueAt(layer, 'material.transmission', timeMs, material.transmission)
  const targets: KeyTarget[] = [
    ...(show.roughness ? [{ alias: 'roughness', path: 'material.roughness', value: roughness }] : []),
    ...(show.metalness ? [{ alias: 'metalness', path: 'material.metalness', value: metalness }] : []),
    ...(show.emission ? [{ alias: 'emission', path: 'material.emission', value: emission }, { alias: 'emissionStrength', path: 'material.emissionStrength', value: glow }] : []),
    ...(show.transmission ? [{ alias: 'transmission', path: 'material.transmission', value: transmission }] : []),
  ]
  const field = (label: string, name: string, current: number, extra: Omit<NumberSpec, 'value' | 'bind'>) => {
    const spec: NumberSpec = { ...extra, value: current, bind: materialBind<number>(layer.id, name) }
    return (
      <Row label={<ScrubLabel text={label} spec={spec} />}>
        <NumberField spec={spec} label={label} />
      </Row>
    )
  }
  const set = (values: Record<string, unknown>) => void run('world.material', { ids: layer.id, values })
  return (
    <Section title="Material" action={targets.length > 0 ? <KeyButton layer={layer} targets={targets} label="material" /> : undefined}>
      {picker}
      <Row label="Model">
        <SelectField label="Shading model" value={material.model} options={MODEL_OPTIONS} onCommit={(model) => set({ model })} />
      </Row>
      <Row label="Tint">
        {material.color === null ? (
          <Toggle label="Tint the picture" checked={false} onChange={() => set({ color: '#ffffff' })} />
        ) : (
          <>
            <ColorField label="Tint" value={material.color} bind={materialBind<string>(layer.id, 'color')} />
            <button
              type="button"
              aria-label="Remove the tint"
              title="Remove the tint"
              onClick={() => set({ color: null })}
              className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-ink"
            >
              <X size={13} aria-hidden />
            </button>
          </>
        )}
      </Row>
      {show.roughness && <NumberProp layer={layer} alias="roughness" path="material.roughness" label="Roughness" value={roughness} {...PERCENT} />}
      {show.metalness && <NumberProp layer={layer} alias="metalness" path="material.metalness" label="Metalness" value={metalness} {...PERCENT} />}
      {show.emission && <ColorProp layer={layer} alias="emission" path="material.emission" label="Emission" value={emission} />}
      {show.emission && (
        <NumberProp layer={layer} alias="emissionStrength" path="material.emissionStrength" label="Glow" value={glow} precision={1} step={0.1} min={0} max={100} />
      )}
      {show.transmission && <NumberProp layer={layer} alias="transmission" path="material.transmission" label="Transmit" value={transmission} {...PERCENT} />}
      {show.refraction && field('IOR', 'ior', material.ior, { precision: 2, step: 0.01, min: 1, max: 2.333 })}
      {show.refraction && field('Thickness', 'thickness', material.thickness, { precision: 0, min: 0, suffix: 'px' })}
      {show.clearcoat && field('Clearcoat', 'clearcoat', material.clearcoat, PERCENT)}
      {show.clearcoatRoughness && field('Coat rough.', 'clearcoatRoughness', material.clearcoatRoughness, PERCENT)}
      {show.sheen && field('Sheen', 'sheen', material.sheen, PERCENT)}
      {show.iridescence && field('Iridescence', 'iridescence', material.iridescence, PERCENT)}
      {show.toonSteps && field('Steps', 'toonSteps', material.toonSteps, { precision: 0, min: 2, max: 16 })}
      <Row label="Sides">
        <Toggle label="Double sided" checked={material.doubleSided} onChange={(doubleSided) => set({ doubleSided })} />
      </Row>
    </Section>
  )
}

/** Thickness for pictures in a world. Depth and bevel can be animated. */
export function ThicknessSection({ layer, timeMs }: { layer: Layer; timeMs: number }) {
  const extrude = layer.extrude
  const depth = extrude ? valueAt(layer, 'extrude.depth', timeMs, extrude.depth) : 0
  const bevel = extrude ? valueAt(layer, 'extrude.bevel', timeMs, extrude.bevel) : 0
  const set = (fields: Record<string, unknown>) => void run('world.extrude', { ids: layer.id, depth: extrude?.depth ?? 40, ...fields })
  const bind = <T,>(field: string): Bind<T> => (value) => ['world.extrude', { ids: layer.id, depth: extrude?.depth ?? 40, [field]: value }]
  const targets: KeyTarget[] = [{ alias: 'extrude.depth', path: 'extrude.depth', value: depth }, { alias: 'extrude.bevel', path: 'extrude.bevel', value: bevel }]
  return (
    <Section title="Thickness" action={extrude ? <KeyButton layer={layer} targets={targets} label="thickness" /> : undefined}>
      {!extrude ? <button type="button" className="text-xs text-ink" onClick={() => set({ depth: 40 })}>Add thickness</button> : <>
        <NumberProp layer={layer} alias="extrude.depth" path="extrude.depth" label="Depth" value={depth} precision={1} min={0} suffix="px" />
        <NumberProp layer={layer} alias="extrude.bevel" path="extrude.bevel" label="Bevel" value={bevel} precision={1} min={0} suffix="px" />
        <Row label="Bevel segments"><NumberField label="Bevel segments" spec={{ value: extrude.bevelSegments, bind: bind<number>('bevelSegments'), precision: 0, min: 1, max: 8 }} /></Row>
        <Row label="Fit"><SelectField label="Thickness fit" value={extrude.fit} options={[{ value: 'outline', label: 'Outline' }, { value: 'box', label: 'Box' }]} onCommit={(fit) => set({ fit })} /></Row>
        <Row label="Side colour">
          {extrude.sideColor === null ? <Toggle label="Custom side colour" checked={false} onChange={() => set({ sideColor: '#808080' })} /> : <>
            <ColorField label="Side colour" value={extrude.sideColor} bind={bind<string>('sideColor')} />
            <button type="button" aria-label="Use automatic side colour" onClick={() => set({ sideColor: null })} className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-ink"><X size={13} aria-hidden /></button>
          </>}
        </Row>
      </>}
    </Section>
  )
}

/** Position, rotation and scale in world axes (X right, Y away from the front view, Z up). */
export function WorldTransformSection({ layer, timeMs }: { layer: Layer; timeMs: number }) {
  const t = resolveLayer(layer, timeMs).transform
  const rows = worldTransformRows(layer.kind)
  const axis = (name: string, alias: string, value: number): Axis => ({ axis: name, alias, path: `transform.${alias}`, value })
  const position = [axis('X', 'x', t.x), axis('Y', 'y', t.y), axis('Z', 'z', t.z)]
  const rotation = [axis('X', 'rotationX', t.rotationX), axis('Y', 'rotationY', t.rotationY), axis('Z', 'rotation', t.rotation)]
  const scale = [axis('X', 'scaleX', t.scaleX), axis('Y', 'scaleY', t.scaleY), axis('Z', 'scaleZ', t.scaleZ)]
  const pivot = [axis('X', 'anchorX', t.anchorX), axis('Y', 'anchorY', t.anchorY)]
  const opacity = [axis('α', 'opacity', t.opacity)]
  const percent = { factor: 100, precision: 0, suffix: '%' }
  const all = [...position, ...rotation, ...(rows.scale ? scale : []), ...(rows.pivot ? pivot : []), ...(rows.opacity ? opacity : [])]
  return (
    <Section title="Transform" action={<KeyButton layer={layer} targets={all} label="transform" />}>
      <AxisRow layer={layer} label="Position" axes={position} spec={{ precision: 1 }} hint="X right, Y away from the front view, Z up (px)" />
      <AxisRow layer={layer} label="Rotation" axes={rotation} spec={{ precision: 1 }} hint="Degrees around X, Y and Z (up)" />
      {rows.scale && (
        <AxisRow
          layer={layer}
          label="Scale"
          axes={scale}
          spec={percent}
          hint={layer.kind === 'empty' || layer.kind === 'mesh' ? 'Scale along X, Y and Z' : "A picture's width is X and its height is Y; Z is its thickness"}
        />
      )}
      {rows.pivot && <AxisRow layer={layer} label="Pivot" axes={pivot} spec={percent} />}
      {rows.opacity && <AxisRow layer={layer} label="Opacity" axes={opacity} spec={{ ...percent, min: 0, max: 100 }} />}
    </Section>
  )
}

const PROJECTIONS = [
  { value: 'perspective', label: 'Perspective' },
  { value: 'orthographic', label: 'Orthographic' },
] as const

/** A camera's lens, clip range and depth of field. */
export function CameraSection({ layer, timeMs }: { layer: Of<'camera'>; timeMs: number }) {
  const cam = layer.camera
  const comp = useActiveComp()
  const show = cameraRows(cam.projection, cam.dof.enabled)
  const dof = dofRows(cam.dof.enabled, cam.dof.focusObjectId)
  const candidates = focusCandidates(comp, layer.id)
  const focusOptions = [
    { value: 'none', label: 'None' },
    ...candidates.map((c) => ({ value: c.id, label: c.name })),
    ...(cam.dof.focusObjectId !== null && !candidates.some((c) => c.id === cam.dof.focusObjectId) ? [{ value: cam.dof.focusObjectId, label: 'Missing layer' }] : []),
  ]
  const dofLook = (fields: Record<string, unknown>) => void run('world.look', { cameraId: layer.id, dof: fields })
  const px = { precision: 0, suffix: 'px', min: 1 }
  const field = (label: string, path: string, value: number, extra: Omit<NumberSpec, 'value' | 'bind'>) => {
    const spec: NumberSpec = { ...extra, value, bind: patchBind(layer.id, path) }
    return (
      <Row label={<ScrubLabel text={label} spec={spec} />}>
        <NumberField spec={spec} label={label} />
      </Row>
    )
  }
  return (
    <Section title="Camera">
      <Row label="Projection">
        <SelectField label="Projection" value={cam.projection} options={PROJECTIONS} onCommit={(p) => void patch(layer.id, 'camera.projection', p)} />
      </Row>
      <NumberProp
        layer={layer}
        alias="focalLength"
        path="camera.focalLength"
        label="Focal length"
        value={valueAt(layer, 'camera.focalLength', timeMs, cam.focalLength)}
        precision={1}
        min={1}
        max={5000}
        suffix="mm"
      />
      {field('Sensor', 'camera.sensorWidth', cam.sensorWidth, { precision: 1, min: 1, max: 200, suffix: 'mm' })}
      {show.orthoScale && field('Ortho scale', 'camera.orthoScale', cam.orthoScale, { precision: 0, min: 1, suffix: 'px' })}
      {field('Clip start', 'camera.clipStart', cam.clipStart, px)}
      {field('Clip end', 'camera.clipEnd', cam.clipEnd, px)}
      <Row label="Depth of field">
        <Toggle label="Depth of field" checked={cam.dof.enabled} onChange={(enabled) => dofLook({ enabled })} />
      </Row>
      {dof.settings && (
        <>
          <Row label="Focus on">
            <SelectField label="Focus on" value={cam.dof.focusObjectId ?? 'none'} options={focusOptions} onCommit={(id) => dofLook({ focusOn: id === 'none' ? null : id })} />
          </Row>
          <div
            className={dof.distanceOverridden ? 'pointer-events-none space-y-1.5 opacity-40' : 'space-y-1.5'}
            aria-disabled={dof.distanceOverridden}
            title={dof.distanceOverridden ? 'The focus layer decides the distance' : undefined}
          >
          <NumberProp
            layer={layer}
            alias="focusDistance"
            path="camera.dof.focusDistance"
            label="Distance"
            value={valueAt(layer, 'camera.dof.focusDistance', timeMs, cam.dof.focusDistance)}
            precision={0}
            min={0}
            suffix="px"
          />
          </div>
          <NumberProp
            layer={layer}
            alias="fStop"
            path="camera.dof.fStop"
            label="f-stop"
            value={valueAt(layer, 'camera.dof.fStop', timeMs, cam.dof.fStop)}
            precision={1}
            step={0.1}
            min={0.1}
            max={128}
          />
          {dof.distanceOverridden && <p className="text-[11px] text-muted">The focus layer decides the distance; pick None to set it by hand.</p>}
        </>
      )}
    </Section>
  )
}

const LIGHT_LABELS: Record<LightType, string> = {
  point: 'Point',
  sun: 'Sun',
  spot: 'Spot',
  area: 'Area',
  environment: 'Environment',
  hemisphere: 'Hemisphere',
}
const LIGHT_OPTIONS = LIGHT_TYPES.map((value) => ({ value, label: LIGHT_LABELS[value] }))
const ENVIRONMENT_OPTIONS = ENVIRONMENT_PRESETS.map((value) => ({ value, label: value.charAt(0).toUpperCase() + value.slice(1) }))
/** The strength a light of each type starts with (the same table world.add uses). */
const LIGHT_INTENSITY: Record<LightType, number> = { point: 1000, spot: 1500, area: 800, sun: 3, environment: 1, hemisphere: 0.6 }

/** A light's type, colour, strength and the fields that type has. */
export function LightSection({ layer, timeMs }: { layer: Of<'light'>; timeMs: number }) {
  const light = layer.light
  const show = lightRows(light.type)
  const watts = light.type === 'point' || light.type === 'spot' || light.type === 'area'
  const intensity = valueAt(layer, 'light.intensity', timeMs, light.intensity)
  const keyedIntensity = (layer.animations['light.intensity']?.length ?? 0) > 0
  const pickType = (type: LightType) => {
    // A strength still at its old type's start follows to the new type's, so a sun is never left at 1000.
    const follow = !keyedIntensity && light.intensity === LIGHT_INTENSITY[light.type]
    const ops = [{ op: 'set', path: 'light.type', value: type }, ...(follow ? [{ op: 'set', path: 'light.intensity', value: LIGHT_INTENSITY[type] }] : [])]
    void run('layer.patch', { id: layer.id, ops })
  }
  const field = (label: string, path: string, value: number, extra: Omit<NumberSpec, 'value' | 'bind'>) => {
    const spec: NumberSpec = { ...extra, value, bind: patchBind(layer.id, path) }
    return (
      <Row label={<ScrubLabel text={label} spec={spec} />}>
        <NumberField spec={spec} label={label} />
      </Row>
    )
  }
  return (
    <Section title="Light">
      <Row label="Type">
        <SelectField label="Light type" value={light.type} options={LIGHT_OPTIONS} onCommit={pickType} />
      </Row>
      <ColorProp layer={layer} alias="color" path="light.color" label="Colour" value={colorAt(layer, 'light.color', timeMs, light.color)} />
      <NumberProp
        layer={layer}
        alias="intensity"
        path="light.intensity"
        label="Intensity"
        value={intensity}
        precision={watts ? 0 : 2}
        step={watts ? 10 : 0.1}
        min={0}
        suffix={watts ? 'W' : ''}
      />
      {show.range && field('Range', 'light.range', light.range, { precision: 0, min: 0, suffix: 'px' })}
      {show.spot && field('Spot angle', 'light.spotAngle', light.spotAngle, { precision: 0, min: 1, max: 180, suffix: '°' })}
      {show.spot && field('Blend', 'light.spotBlend', light.spotBlend, { factor: 100, precision: 0, min: 0, max: 100, step: 1, suffix: '%' })}
      {show.area && field('Width', 'light.width', light.width, { precision: 0, min: 1, suffix: 'px' })}
      {show.area && field('Height', 'light.height', light.height, { precision: 0, min: 1, suffix: 'px' })}
      {show.ground && (
        <Row label="Ground">
          <ColorField
            label="Ground colour"
            value={light.groundColor}
            bind={(v) => ['layer.patch', { id: layer.id, ops: [{ op: 'set', path: 'light.groundColor', value: v }] }]}
          />
        </Row>
      )}
      {show.environment && (
        <>
          <Row label="Preset">
            <SelectField label="Environment preset" value={light.environment} options={ENVIRONMENT_OPTIONS} onCommit={(p) => void patch(layer.id, 'light.environment', p)} />
          </Row>
          <Row label="Background">
            <Toggle label="Show background" checked={light.showBackground} onChange={(on) => void patch(layer.id, 'light.showBackground', on)} />
          </Row>
        </>
      )}
      {show.shadow && (
        <>
          <Row label="Shadow">
            <Toggle label="Cast shadow" checked={light.castShadow} onChange={(on) => void patch(layer.id, 'light.castShadow', on)} />
          </Row>
          {light.castShadow && field('Softness', 'light.shadowSoftness', light.shadowSoftness, { precision: 1, step: 0.1, min: 0, max: 20 })}
        </>
      )}
    </Section>
  )
}

const PRIMITIVE_OPTIONS = PRIMITIVES.map((p) => ({ value: p.id as string, label: p.label }))
const SHADING_LABELS: Record<(typeof MESH_SHADING)[number], string> = { smooth: 'Smooth', flat: 'Flat', auto: 'Auto' }
const SHADING_OPTIONS = MESH_SHADING.map((value) => ({ value, label: SHADING_LABELS[value] }))

/**
 * Changes a mesh's primitive. The new one starts at its own defaults, and the
 * keys of the old one's params go with it (a key named the same in both, such
 * as a radius, would otherwise carry over): clear them, then reset the
 * geometry, as one undo step.
 */
async function pickPrimitive(layer: Of<'mesh'>, primitive: string): Promise<void> {
  if (layer.geometry.type !== 'primitive' || primitive === layer.geometry.primitive) return
  const keyed = Object.keys(layer.animations).filter((path) => path.startsWith('geometry.') && (layer.animations[path]?.length ?? 0) > 0)
  const geometry = { op: 'set', path: 'geometry', value: { type: 'primitive', primitive, params: {} } }
  if (keyed.length === 0) {
    await run('layer.patch', { id: layer.id, ops: [geometry] })
    return
  }
  await session.transact('Change primitive', async (call) => {
    const cleared = await call('keyframes.clear', { id: layer.id, properties: keyed })
    const patched = cleared.ok ? await call('layer.patch', { id: layer.id, ops: [geometry] }) : cleared
    if (!patched.ok) useEditor.getState().notify(patched.error, 'error')
  })
}

/** A mesh's colour: its first enabled solid fill (keyable), or a way to give it one. */
function MeshColorRow({ layer, timeMs }: { layer: Of<'mesh'>; timeMs: number }) {
  const fills = resolveLayer(layer, timeMs).fills ?? layer.fills
  const solid = fills.find((fill) => fill.type === 'solid' && fill.enabled)
  if (solid && solid.type === 'solid') {
    return <ColorProp layer={layer} alias={`fill.${solid.id}`} path={`fill.${solid.id}`} label="Colour" value={solid.color} />
  }
  // No solid fill yet: the first colour picked adds one (looked up as the edit happens, so a drag adds only one).
  const bind: Bind<string> = (value) => {
    const now = findLayer(useEditor.getState().project, layer.id)
    const first = now && now.kind === 'mesh' ? now.fills.find((fill) => fill.type === 'solid' && fill.enabled) : undefined
    if (now && first) return propertyEdit(now, `fill.${first.id}`, `fill.${first.id}`, value)
    return ['layer.patch', { id: layer.id, ops: [{ op: 'insert', path: 'fills[-]', value: { type: 'solid', color: value } }] }]
  }
  return (
    <Row label="Colour">
      <ColorField label="Colour" value={MESH_DEFAULT_COLOR} bind={bind} />
    </Row>
  )
}

const NOTHING = '__none'

const MATERIAL_SOURCE_OPTIONS = [
  { value: 'file', label: 'File' },
  { value: 'custom', label: 'Custom' },
]

/** Whether a model shows its file's own materials: with no material, or a material that says so. */
export function showsFileMaterials(layer: Of<'mesh'>): boolean {
  return !layer.material || layer.material.source === 'file'
}

/** A model mesh's file, materials and animation clip. Colour and shading apply only to Custom materials. */
function ModelSection({ layer, timeMs, assetId }: { layer: Of<'mesh'>; timeMs: number; assetId: string }) {
  const asset = useEditor((s) => s.project.media.find((m) => m.id === assetId))
  const clips = asset?.model?.clips ?? []
  const fromFile = showsFileMaterials(layer)
  const animation = layer.animation ?? { clip: null, speed: 1, loop: true }
  const geometry = meshGeometryAt(layer, timeMs - layer.startMs)
  const pickMaterials = (source: string) => {
    if ((source === 'file') === fromFile) return
    // Custom with no material yet makes a default one; a material already there changes its source.
    if (layer.material) void run('layer.patch', { id: layer.id, ops: [{ op: 'set', path: 'material.source', value: source }] })
    else void run('world.material', { ids: layer.id, values: { source: 'custom' } })
  }
  const setAnimation = (values: Record<string, unknown>) => void run('layer.set', { id: layer.id, animation: values })
  const speed: NumberSpec = { value: animation.speed, bind: (value) => ['layer.set', { id: layer.id, animation: { speed: value } }], precision: 2, step: 0.1, min: 0, max: 16, suffix: '×' }
  const clipOptions = [{ value: NOTHING, label: 'None' }, ...clips.map((c) => ({ value: c.name, label: c.name }))]
  return (
    <Section title="Model">
      <Row label="File">
        <span className="min-w-0 truncate text-[11px] text-muted" title={asset?.path}>
          {asset?.name ?? 'Missing file'}
        </span>
      </Row>
      <Row label={<span title="File shows the materials the model came with; Custom uses the Material section">Materials</span>}>
        <SelectField label="Materials" value={fromFile ? 'file' : 'custom'} options={MATERIAL_SOURCE_OPTIONS} onCommit={pickMaterials} />
      </Row>
      {clips.length > 0 ? (
        <>
          <Row label="Clip">
            <SelectField label="Animation clip" value={animation.clip ?? NOTHING} options={clipOptions} onCommit={(clip) => setAnimation({ clip: clip === NOTHING ? null : clip })} />
          </Row>
          <Row label={<ScrubLabel text="Speed" spec={speed} />}>
            <NumberField spec={speed} label="Clip speed" />
          </Row>
          <Row label="Loop">
            <Toggle label="Loop the clip" checked={animation.loop} onChange={(on) => setAnimation({ loop: on })} />
          </Row>
        </>
      ) : (
        <p className="text-[11px] text-muted">This file has no animation.</p>
      )}
      {!fromFile && <MeshColorRow layer={layer} timeMs={timeMs} />}
      {!fromFile && (
        <Row label="Shading">
          <SelectField label="Shading" value={layer.shading} options={SHADING_OPTIONS} onCommit={(shading) => void patch(layer.id, 'shading', shading)} />
        </Row>
      )}
      {!fromFile && meshRows(layer.shading).autoAngle && (
        <NumberProp layer={layer} alias="smoothAngle" path="smoothAngle" label="Auto angle" value={geometry.smoothAngle} precision={0} min={0} max={180} suffix="°" />
      )}
      <Row label="Shadows">
        <Toggle label="Cast" checked={layer.castShadow} onChange={(on) => void patch(layer.id, 'castShadow', on)} />
        <Toggle label="Receive" checked={layer.receiveShadow} onChange={(on) => void patch(layer.id, 'receiveShadow', on)} />
      </Row>
    </Section>
  )
}

/** A mesh's primitive and its params, shading, shadows and colour; a model's file, materials and clip. */
export function MeshSection({ layer, timeMs }: { layer: Of<'mesh'>; timeMs: number }) {
  if (layer.geometry.type === 'asset') return <ModelSection layer={layer} timeMs={timeMs} assetId={layer.geometry.assetId} />
  const geometry = meshGeometryAt(layer, timeMs - layer.startMs)
  if (geometry.type !== 'primitive') return null
  const primitive = PRIMITIVES.find((p) => p.id === geometry.primitive)
  const params = primitive?.params ?? []
  const targets: KeyTarget[] = params.map((param) => ({ alias: `geometry.${param.key}`, path: `geometry.${param.key}`, value: geometry.params[param.key] ?? param.default }))
  const show = meshRows(layer.shading)
  return (
    <Section title="Mesh" action={targets.length > 0 ? <KeyButton layer={layer} targets={targets} label="shape" /> : undefined}>
      <Row label={<span title={primitive?.use}>Primitive</span>}>
        <SelectField label="Primitive" value={geometry.primitive as string} options={PRIMITIVE_OPTIONS} onCommit={(p) => void pickPrimitive(layer, p)} />
      </Row>
      {params.map((param) => (
        <NumberProp
          key={`${geometry.primitive}.${param.key}`}
          layer={layer}
          alias={`geometry.${param.key}`}
          path={`geometry.${param.key}`}
          label={param.label}
          value={geometry.params[param.key] ?? param.default}
          precision={param.int ? 0 : param.unit === 'px' ? 1 : 0}
          step={1}
          min={param.min}
          {...(param.max !== undefined ? { max: param.max } : {})}
          suffix={param.unit === 'px' ? 'px' : param.unit === 'deg' ? '°' : ''}
        />
      ))}
      <MeshColorRow layer={layer} timeMs={timeMs} />
      <Row label="Shading">
        <SelectField label="Shading" value={layer.shading} options={SHADING_OPTIONS} onCommit={(shading) => void patch(layer.id, 'shading', shading)} />
      </Row>
      {show.autoAngle && (
        <NumberProp layer={layer} alias="smoothAngle" path="smoothAngle" label="Auto angle" value={geometry.smoothAngle} precision={0} min={0} max={180} suffix="°" />
      )}
      <Row label="Shadows">
        <Toggle label="Cast" checked={layer.castShadow} onChange={(on) => void patch(layer.id, 'castShadow', on)} />
        <Toggle label="Receive" checked={layer.receiveShadow} onChange={(on) => void patch(layer.id, 'receiveShadow', on)} />
      </Row>
    </Section>
  )
}

const DISPLAY_OPTIONS =EMPTY_DISPLAYS.map((value) => ({ value, label: value.charAt(0).toUpperCase() + value.slice(1) }))

/** A controller's marker: how it shows in the editor (it never renders). */
export function ControllerSection({ layer }: { layer: Of<'empty'> }) {
  const size: NumberSpec = { value: layer.empty.size, bind: patchBind(layer.id, 'empty.size'), precision: 0, min: 1, suffix: 'px' }
  return (
    <Section title="Controller">
      <Row label="Display">
        <SelectField label="Display" value={layer.empty.display} options={DISPLAY_OPTIONS} onCommit={(d) => void patch(layer.id, 'empty.display', d)} />
      </Row>
      <Row label={<ScrubLabel text="Size" spec={size} />}>
        <NumberField spec={size} label="Size" />
      </Row>
    </Section>
  )
}

/** A layer's constraints in a world: child of, look at and follow (world.track), as AtomCut's Track section. */
export function TrackSection({ layer, comp }: { layer: Layer; comp: Comp }) {
  const constraints = layer.constraints ?? []
  const of = (type: 'lookAt' | 'follow' | 'childOf') => constraints.find((c) => c.type === type)
  const follow = of('follow')
  const options = [{ value: NOTHING, label: 'Nothing' }, ...trackTargets(comp, layer.id).map((t) => ({ value: t.id, label: t.name }))]
  const track = (field: 'lookAt' | 'follow' | 'childOf', target: string, extra: Record<string, unknown> = {}) =>
    void run('world.track', { id: layer.id, [field]: target === NOTHING ? null : target, ...extra })
  const picker = (field: 'lookAt' | 'follow' | 'childOf', label: string, extra: Record<string, unknown> = {}) => (
    <SelectField label={label} value={of(field)?.targetId ?? NOTHING} options={options} onCommit={(target) => track(field, target, extra)} />
  )
  return (
    <Section title="Track">
      <Row label={<span title="Moves, turns and scales with its parent from where it is now; chain them for a rig">Child of</span>}>{picker('childOf', 'Child of')}</Row>
      <Row label={<span title="Always turns to face it: a camera on a hero">Look at</span>}>{picker('lookAt', 'Look at')}</Row>
      <Row label={<span title="Rides along with it; its own position becomes the distance it keeps">Follow</span>}>
        {picker('follow', 'Follow', follow?.type === 'follow' ? { followRotation: follow.rotation ?? false } : {})}
      </Row>
      {follow?.type === 'follow' && follow.targetId && (
        <Row label="">
          <Toggle label="Turn with it" checked={follow.rotation ?? false} onChange={(on) => track('follow', follow.targetId as string, { followRotation: on })} />
        </Row>
      )}
    </Section>
  )
}

/** The header's "3D" action: stand the selected 2D layers in a world, looking the same, now with depth. */
export function MoveInto3dButton({ layer }: { layer: Layer }) {
  const comp = useActiveComp()
  if (isWorld(comp) || layer.kind === 'audio' || isSpatialKind(layer.kind)) return null
  const go = async () => {
    const picked = selectionIds()
    const result = await run('world.move_into', { ids: picked.includes(layer.id) ? picked : [layer.id] })
    if (result.ok) useEditor.getState().notify('In 3D: the same picture, now with depth')
  }
  return (
    <button
      type="button"
      onClick={() => void go()}
      aria-label="Move into 3D"
      title="Move into a 3D world: the same picture, now with depth"
      className="flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-[11px] font-semibold text-muted hover:bg-hover hover:text-ink"
    >
      <Box size={14} aria-hidden />3D
    </button>
  )
}
