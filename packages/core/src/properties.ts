import { type Effect, EFFECT_PREFIX, type EffectDomain, findEffectDef } from './effects'
import { CommandError } from './errors'
import { DEFAULT_MOTION_BLUR, type MotionBlurSettings } from './motionBlur'
import { sampleKeys } from './interpolate'
import { motionPointAt } from './motionPath'
import { findPrimitive, primitiveParams } from './primitives'
import { normalizeSvgPath } from './svgPath'
import { BONE_CHANNELS, ColorSchema, type KeyValue, type Layer, type LayerKind, type Paint, type Stroke } from './schema'

/** One animatable property of a layer. */
export interface PropertySpec {
  /**
   * Canonical name, also the key in `layer.animations`. A dotted path into the
   * layer (`transform.x`), or, for paints, AtomCut's path by id
   * (`fill.<paintId>`, `stroke.<strokeId>.trim.end`) read through `get`/`set`.
   */
  path: string
  /** Short name agents may use instead of the path, e.g. `x`. */
  alias: string
  type: 'number' | 'color' | 'path'
  /** Other names that resolve to it: AtomCut's paths, such as `anchor.x`. */
  aliases?: readonly string[]
  min?: number
  max?: number
  description: string
  /** A label for the inspector when the alias is not one (a mesh's params). */
  label?: string
  /** The value a param rests at before it is given (a mesh's params). */
  default?: number
  /** Reads the value when `path` is not a plain dotted path. */
  get?: (layer: Layer) => unknown
  /** Writes the value when `path` is not a plain dotted path. */
  set?: (layer: Layer, value: KeyValue) => void
}

type SpecExtra = Pick<PropertySpec, 'min' | 'max' | 'aliases' | 'get' | 'set' | 'label' | 'default'>

const num = (path: string, alias: string, description: string, extra: SpecExtra = {}): PropertySpec => ({
  path,
  alias,
  type: 'number',
  description,
  ...extra,
})

const color = (path: string, alias: string, description: string, extra: SpecExtra = {}): PropertySpec => ({
  path,
  alias,
  type: 'color',
  description,
  ...extra,
})

const TRANSFORM: readonly PropertySpec[] = [
  num('transform.x', 'x', 'Horizontal position of the pivot in px from the comp centre (+ is right)'),
  num('transform.y', 'y', 'Vertical position of the pivot in px from the comp centre (+ is down)'),
  num('transform.z', 'z', 'Depth in px (+ is away from the viewer); 0 is pixel-exact'),
  num('transform.rotation', 'rotation', 'Rotation in the picture plane, degrees clockwise'),
  num('transform.rotationX', 'rotationX', 'Tilt around the horizontal axis, degrees; positive leans the top away'),
  num('transform.rotationY', 'rotationY', 'Turn around the vertical axis, degrees; positive turns the right side away'),
  num('transform.scaleX', 'scaleX', 'Horizontal scale; 1 is 100%'),
  num('transform.scaleY', 'scaleY', 'Vertical scale; 1 is 100%'),
  num('transform.scaleZ', 'scaleZ', 'Depth scale in a 3D world (a picture plane reads its scales as scaleX, scaleZ, scaleY); 1 is 100%'),
  num('transform.anchorX', 'anchorX', "Pivot across the layer's box: 0 left edge, 0.5 centre, 1 right edge (may go past)", {
    aliases: ['anchor.x'],
  }),
  num('transform.anchorY', 'anchorY', "Pivot down the layer's box: 0 top edge, 0.5 centre, 1 bottom edge (may go past)", {
    aliases: ['anchor.y'],
  }),
  num('transform.opacity', 'opacity', 'Opacity from 0 (invisible) to 1', { min: 0, max: 1 }),
]

const VOLUME = num('volume', 'volume', 'Loudness; 1 is the original level', { min: 0, max: 4 })

const PROPERTIES: Record<LayerKind, readonly PropertySpec[]> = {
  text: [
    ...TRANSFORM,
    num('style.fontSize', 'fontSize', 'Font size in px', { min: 1 }),
    color('style.color', 'color', 'Text colour'),
    num('style.letterSpacing', 'letterSpacing', 'Extra space between letters in px'),
    num('style.lineHeight', 'lineHeight', 'Line height as a multiple of the font size', { min: 0.1 }),
    num('maxWidth', 'maxWidth', 'Box width in px; keying it re-wraps the lines', { min: 1 }),
    num('maxHeight', 'maxHeight', 'Box height in px of a fixed box', { min: 1 }),
  ],
  shape: [
    ...TRANSFORM,
    num('shape.width', 'width', 'Width in px', { min: 1 }),
    num('shape.height', 'height', 'Height in px', { min: 1 }),
    num('shape.cornerRadius', 'cornerRadius', 'Corner radius in px (rectangles)', { min: 0 }),
    num('shape.innerRatio', 'innerRatio', "A star's inner radius as a fraction of its outer one", { min: 0.01, max: 1 }),
  ],
  group: [...TRANSFORM, num('cornerRadius', 'cornerRadius', "The container's corner radius in px (with a layout)", { min: 0 })],
  path: [
    ...TRANSFORM,
    {
      path: 'geometry',
      alias: 'geometry',
      type: 'path',
      description: 'The outline as SVG path data; keys with the same commands morph into each other',
    },
  ],
  nested: TRANSFORM,
  image: TRANSFORM,
  video: [...TRANSFORM, VOLUME],
  audio: [VOLUME],
  // 3D world kinds: a camera's lens and focus and a light's strength and colour key too.
  camera: [
    ...TRANSFORM,
    num('camera.focalLength', 'focalLength', 'Lens focal length in mm (longer zooms in)', { min: 1, max: 5000 }),
    num('camera.dof.focusDistance', 'focusDistance', 'Depth of field: the distance from the camera that stays sharp, px', { min: 0 }),
    num('camera.dof.fStop', 'fStop', 'Depth of field: the aperture (a smaller f-stop blurs more)', { min: 0.1, max: 128 }),
  ],
  light: [
    ...TRANSFORM,
    num('light.intensity', 'intensity', 'Strength: watts for point, spot and area lights, a plain strength for the rest', { min: 0 }),
    color('light.color', 'color', 'Light colour'),
  ],
  empty: TRANSFORM,
  // A mesh's geometry params key per primitive (see meshProperties); only the shading angle is common.
  mesh: [...TRANSFORM, num('smoothAngle', 'smoothAngle', 'Auto shading: edges flatter than this angle (degrees) are smoothed', { min: 0, max: 180, label: 'Auto angle' })],
}

/** Convenience names that write several properties at once. */
const GROUPS: Readonly<Record<string, readonly string[]>> = {
  scale: ['transform.scaleX', 'transform.scaleY'],
  position: ['transform.x', 'transform.y'],
  anchor: ['transform.anchorX', 'transform.anchorY'],
}

/**
 * The value each of `specs` gets when `name` is written with `value`: a list
 * is spread over a group in order (`position: [x, y]`, `scale: [sx, sy]`), and
 * a single value goes to every member (`scale: 1.2`).
 */
export function spreadValue(specs: readonly PropertySpec[], name: string, value: unknown): unknown[] {
  if (!Array.isArray(value)) return specs.map(() => value)
  if (specs.length > 1 && value.length === specs.length) return value
  throw new CommandError(
    specs.length > 1
      ? `${name} takes ${specs.length} values (${specs.map((s) => s.alias).join(', ')}), not ${value.length}.`
      : `${name} takes one value, not a list.`,
  )
}

/** A number property of one paint or stroke, found by id each time it is read or written. */
function field<T>(
  path: string,
  alias: string,
  description: string,
  find: (layer: Layer) => T | undefined,
  read: (target: T) => number,
  write: (target: T, value: number) => void,
  range: { min?: number; max?: number } = {},
): PropertySpec {
  return num(path, alias, description, {
    ...range,
    get: (layer) => {
      const target = find(layer)
      return target === undefined ? undefined : read(target)
    },
    set: (layer, value) => {
      const target = find(layer)
      if (target !== undefined) write(target, value as number)
    },
  })
}

/** The colour of a solid paint, found by id each time. */
function solidColor(path: string, alias: string, description: string, find: (layer: Layer) => Paint | undefined, aliases: string[]): PropertySpec {
  return color(path, alias, description, {
    aliases,
    get: (layer) => {
      const paint = find(layer)
      return paint?.type === 'solid' ? paint.color : undefined
    },
    set: (layer, value) => {
      const paint = find(layer)
      if (paint?.type === 'solid') paint.color = value as string
    },
  })
}

/** A gradient's stop colours and offsets, under `prefix.stop.<stopId>`. */
function stopProperties(prefix: string, paint: Paint, find: (layer: Layer) => Paint | undefined): PropertySpec[] {
  if (paint.type === 'solid') return []
  return paint.stops.flatMap((stop) => {
    const stopOf = (layer: Layer) => {
      const found = find(layer)
      return found && found.type !== 'solid' ? found.stops.find((s) => s.id === stop.id) : undefined
    }
    const base = `${prefix}.stop.${stop.id}`
    return [
      color(`${base}.color`, `${base}.color`, 'Gradient stop colour', {
        get: (layer) => stopOf(layer)?.color,
        set: (layer, value) => {
          const target = stopOf(layer)
          if (target) target.color = value as string
        },
      }),
      field(`${base}.offset`, `${base}.offset`, 'Gradient stop position, 0 to 1', stopOf, (s) => s.offset, (s, v) => (s.offset = v), {
        min: 0,
        max: 1,
      }),
    ]
  })
}

/**
 * The animatable properties of a layer's fills and strokes, by AtomCut's
 * paths. The first solid fill is also `fill`; the first stroke is also
 * `strokeColor`, `strokeWidth`, `trimStart`, `trimEnd` and `trimOffset`.
 */
function paintProperties(layer: Layer): PropertySpec[] {
  if (!('fills' in layer)) return []
  const specs: PropertySpec[] = []
  layer.fills.forEach((fill, index) => {
    const find = (l: Layer) => ('fills' in l ? l.fills.find((f) => f.id === fill.id) : undefined)
    const prefix = `fill.${fill.id}`
    if (fill.type === 'solid') specs.push(solidColor(prefix, index === 0 ? 'fill' : prefix, 'Fill colour', find, [`${prefix}.color`]))
    specs.push(
      field(`${prefix}.opacity`, `${prefix}.opacity`, 'Fill opacity, 0 to 1', find, (f) => f.opacity, (f, v) => (f.opacity = v), { min: 0, max: 1 }),
      ...stopProperties(prefix, fill, find),
    )
  })
  ;('strokes' in layer ? layer.strokes : []).forEach((stroke, index) => {
    const find = (l: Layer): Stroke | undefined => ('strokes' in l ? l.strokes.find((s) => s.id === stroke.id) : undefined)
    const prefix = `stroke.${stroke.id}`
    const name = (key: string, alias?: string) => (index === 0 && alias ? alias : `${prefix}.${key}`)
    const prop = (key: string, alias: string | undefined, description: string, read: (s: Stroke) => number, write: (s: Stroke, v: number) => void, range = {}) =>
      field(`${prefix}.${key}`, name(key, alias), description, find, read, write, range)
    if (stroke.paint.type === 'solid') {
      specs.push(solidColor(`${prefix}.color`, name('color', 'strokeColor'), 'Stroke colour', (l) => find(l)?.paint, [prefix]))
    }
    specs.push(
      prop('width', 'strokeWidth', 'Stroke width in px', (s) => s.width, (s, v) => (s.width = v), { min: 0 }),
      prop('opacity', undefined, 'Stroke opacity, 0 to 1', (s) => s.opacity, (s, v) => (s.opacity = v), { min: 0, max: 1 }),
      prop('dashLength', undefined, 'Dash length in px', (s) => s.dash[0] ?? 0, (s, v) => (s.dash = [v, s.dash[1] ?? s.dash[0] ?? v]), { min: 0 }),
      prop('dashGap', undefined, 'Gap between dashes in px', (s) => s.dash[1] ?? s.dash[0] ?? 0, (s, v) => (s.dash = [s.dash[0] ?? v, v]), { min: 0 }),
      prop('dashOffset', undefined, 'Shifts the dashes along the line, in px', (s) => s.dashOffset, (s, v) => (s.dashOffset = v)),
    )
    // Trim follows an outline; text has none to follow yet.
    if (layer.kind !== 'text') {
      specs.push(
        prop('trim.start', 'trimStart', 'Start of the drawn slice of the outline, 0 to 1', (s) => s.trim.start, (s, v) => (s.trim.start = v), {
          min: 0,
          max: 1,
        }),
        prop('trim.end', 'trimEnd', 'End of the drawn slice, 0 to 1; key it 0 to 1 to draw the line on', (s) => s.trim.end, (s, v) => (s.trim.end = v), {
          min: 0,
          max: 1,
        }),
        prop('trim.offset', 'trimOffset', 'Shifts the drawn slice along the outline, in laps', (s) => s.trim.offset, (s, v) => (s.trim.offset = v)),
      )
    }
    specs.push(...stopProperties(prefix, stroke.paint, (l) => find(l)?.paint))
  })
  return specs
}

/** A text layer's styled ranges: `range.<id>.color`, `.opacity` and `.fontSize` (what the range leaves out reads as the layer's). */
function rangeProperties(layer: Layer): PropertySpec[] {
  if (layer.kind !== 'text') return []
  return layer.ranges.flatMap((range) => {
    const find = (l: Layer) => (l.kind === 'text' ? l.ranges.find((r) => r.id === range.id) : undefined)
    const base = (l: Layer) => (l.kind === 'text' ? l.style : undefined)
    const prefix = `range.${range.id}`
    return [
      color(`${prefix}.color`, `${prefix}.color`, 'Colour of a styled range', {
        get: (l) => find(l)?.style.color ?? base(l)?.color,
        set: (l, v) => {
          const r = find(l)
          if (r) r.style.color = v as string
        },
      }),
      num(`${prefix}.opacity`, `${prefix}.opacity`, 'Opacity of a styled range, 0 to 1', {
        min: 0,
        max: 1,
        get: (l) => find(l)?.style.opacity ?? 1,
        set: (l, v) => {
          const r = find(l)
          if (r) r.style.opacity = v as number
        },
      }),
      num(`${prefix}.fontSize`, `${prefix}.fontSize`, 'Font size of a styled range, px', {
        min: 1,
        get: (l) => find(l)?.style.fontSize ?? base(l)?.fontSize,
        set: (l, v) => {
          const r = find(l)
          if (r) r.style.fontSize = v as number
        },
      }),
    ]
  })
}

/** A layer's effect cards of a domain: its layer effects, or a text layer's text effects. */
export function effectStack(layer: Layer, domain: EffectDomain): Effect[] | undefined {
  if (domain === 'text') return layer.kind === 'text' ? layer.style.textEffects : undefined
  return layer.effects
}

/** The number and colour fields of a layer's effect cards: `lfx.<id>.<field>` and `tfx.<id>.<field>`. */
function effectProperties(layer: Layer): PropertySpec[] {
  return (['layer', 'text'] as const).flatMap((domain) =>
    (effectStack(layer, domain) ?? []).flatMap((effect) => {
      const def = findEffectDef(domain, effect.type)
      if (!def) return []
      const find = (l: Layer) => effectStack(l, domain)?.find((e) => e.id === effect.id)
      return Object.entries(def.fields).flatMap(([key, field]): PropertySpec[] => {
        if (field.kind !== 'number' && field.kind !== 'color') return []
        const path = `${EFFECT_PREFIX[domain]}.${effect.id}.${key}`
        const range = field.kind === 'number' ? { ...(field.min !== undefined ? { min: field.min } : {}), ...(field.max !== undefined ? { max: field.max } : {}) } : {}
        return [
          {
            path,
            alias: path,
            type: field.kind,
            description: `${def.label}: ${field.description}`,
            ...range,
            get: (l) => find(l)?.[key],
            set: (l, value) => {
              const card = find(l)
              if (card) card[key] = value as number | string
            },
          },
        ]
      })
    }),
  )
}

/** The number fields of a layer's force cards: `force.<id>.strength`, `.radius` and `.scale` (no boolean property exists, so `enabled` does not key). */
function forceProperties(layer: Layer): PropertySpec[] {
  return (layer.forces ?? []).flatMap((force) => {
    const find = (l: Layer) => l.forces?.find((f) => f.id === force.id)
    const field = (key: 'strength' | 'radius' | 'scale', description: string, range: { min?: number }): PropertySpec => {
      const path = `force.${force.id}.${key}`
      return {
        path,
        alias: path,
        type: 'number',
        description: `${force.name ?? force.type} force: ${description}`,
        ...range,
        get: (l) => find(l)?.[key],
        set: (l, value) => {
          const card = find(l)
          if (card) card[key] = value as number
        },
      }
    }
    return [
      field('strength', 'acceleration in px/s² (drag: % of speed lost per second); key two values for a gust', {}),
      field('radius', 'how far it reaches in px; 0 reaches everywhere', { min: 0 }),
      field('scale', 'turbulence cell size in px', { min: 0.01 }),
    ]
  })
}

/** A group's `switch`: the index of the member shown (keyable; its keys hold, and the value rounds down when drawn). */
function switchProperties(layer: Layer): PropertySpec[] {
  if (layer.kind !== 'group' || layer.switch === null) return []
  return [
    num('switch', 'switch', 'Switch: the index of the member shown, counted from the top (front); keys hold, a fraction rounds down', {
      min: 0,
      get: (l) => (l.kind === 'group' ? (l.switch ?? 0) : undefined),
      set: (l, value) => {
        if (l.kind === 'group') l.switch = Math.max(0, Math.floor(value as number))
      },
    }),
  ]
}

const BONE_UNITS: Record<(typeof BONE_CHANNELS)[number], { text: string; min?: number }> = {
  rotation: { text: 'turn from rest, degrees clockwise' },
  x: { text: 'move from rest along x, px' },
  y: { text: 'move from rest along y, px' },
  scale: { text: 'stretch along the bone, 1 is rest', min: 0 },
}

/** A rig group's pose channels: `bone.<id>.rotation|x|y|scale`, deltas from rest, read and written on the bone's `pose`. */
function boneProperties(layer: Layer): PropertySpec[] {
  if (layer.kind !== 'group' || !layer.rig) return []
  return layer.rig.bones.flatMap((bone) => {
    const find = (l: Layer) => (l.kind === 'group' ? l.rig?.bones.find((b) => b.id === bone.id) : undefined)
    return BONE_CHANNELS.map((channel): PropertySpec => {
      const path = `bone.${bone.id}.${channel}`
      const unit = BONE_UNITS[channel]
      return num(path, path, `Bone "${bone.name}": ${unit.text}`, {
        ...(unit.min !== undefined ? { min: unit.min } : {}),
        label: `${bone.name} ${channel}`,
        get: (l) => find(l)?.pose[channel],
        set: (l, value) => {
          const target = find(l)
          if (target) target.pose[channel] = value as number
        },
      })
    })
  })
}

/** A layer's own shutter (`mblur.<field>`): read through the comp's defaults, written into an override made on first use. */
function shutterSpec(key: 'shutterAngle' | 'shutterPhase' | 'strength' | 'amount', description: string, min: number, max: number): PropertySpec {
  return num(`mblur.${key}`, `mblur.${key}`, description, {
    min,
    max,
    get: (l) => (l.motionBlur.override ?? DEFAULT_MOTION_BLUR)[key],
    set: (l, value) => {
      l.motionBlur.override ??= { ...DEFAULT_MOTION_BLUR }
      ;(l.motionBlur.override as MotionBlurSettings)[key] = value as number
    },
  })
}

const SHUTTER: readonly PropertySpec[] = [
  shutterSpec('shutterAngle', 'Motion blur shutter angle, degrees of a frame (180 film)', 0, 720),
  shutterSpec('shutterPhase', 'Motion blur shutter phase, degrees (-90 centres a 180° shutter)', -360, 360),
  shutterSpec('strength', 'Motion blur strength, 0 to 1', 0, 1),
  shutterSpec('amount', 'Motion blur exaggeration, 1 physical', 0, 4),
]

/** What a layer's material lets key: only when it has one (world.material). */
const MATERIAL_SPECS: readonly PropertySpec[] = [
  num('material.roughness', 'roughness', 'Material: 0 mirror-smooth, 1 fully rough', { min: 0, max: 1 }),
  num('material.metalness', 'metalness', 'Material: 0 plain, 1 metal', { min: 0, max: 1 }),
  num('material.emissionStrength', 'emissionStrength', 'Material: how brightly it glows', { min: 0, max: 100 }),
  color('material.emission', 'emission', 'Material: the colour it glows with'),
  num('material.transmission', 'transmission', 'Material: 1 lets light through like glass', { min: 0, max: 1 }),
]

const EXTRUDE_SPECS: readonly PropertySpec[] = [
  num('extrude.depth', 'extrude.depth', 'Thickness in px; zero is flat', { min: 0 }),
  num('extrude.bevel', 'extrude.bevel', 'Bevel size in px', { min: 0 }),
]

/** A mesh's geometry params: `geometry.<key>` for each param of its primitive, read as resolved and written sparse. */
function meshProperties(layer: Layer): PropertySpec[] {
  if (layer.kind !== 'mesh' || layer.geometry.type !== 'primitive') return []
  const { primitive } = layer.geometry
  return (findPrimitive(primitive)?.params ?? []).map((param) =>
    num(`geometry.${param.key}`, `geometry.${param.key}`, `${param.label}${param.unit === 'px' ? ' in px' : param.unit === 'deg' ? ' in degrees' : ''} (a count of whole steps rounds)`, {
      min: param.min,
      ...(param.max !== undefined ? { max: param.max } : {}),
      label: param.label,
      default: param.default,
      get: (l) => (l.kind === 'mesh' && l.geometry.type === 'primitive' ? primitiveParams(l.geometry.primitive, l.geometry.params)[param.key] : undefined),
      set: (l, value) => {
        if (l.kind === 'mesh' && l.geometry.type === 'primitive') l.geometry.params[param.key] = value as number
      },
    }),
  )
}

/** Every animatable property of a layer: its kind's, plus those of its fills, strokes, styled ranges, effects, material and shutter. */
export function propertiesOf(layer: Layer): readonly PropertySpec[] {
  const own = layer.kind === 'audio' ? PROPERTIES[layer.kind] : [...PROPERTIES[layer.kind], ...SHUTTER, ...(layer.material ? MATERIAL_SPECS : []), ...(layer.extrude ? EXTRUDE_SPECS : [])]
  const effects = effectProperties(layer)
  const base = 'fills' in layer ? [...meshProperties(layer), ...paintProperties(layer), ...rangeProperties(layer), ...effects] : effects
  const forced = layer.forces?.length ? [...base, ...forceProperties(layer)] : base
  const extra = layer.kind === 'group' ? [...forced, ...switchProperties(layer), ...boneProperties(layer)] : forced
  return extra.length > 0 ? [...own, ...extra] : own
}

/** The properties every layer of a kind has, without its paints. */
export function kindProperties(kind: LayerKind): readonly PropertySpec[] {
  return PROPERTIES[kind]
}

/** Resolves a path, alias or group name (`scale`) to the properties it names. */
export function resolveProperty(layer: Layer, name: string): PropertySpec[] {
  const kind = layer.kind
  const specs = propertiesOf(layer)
  const group = Object.hasOwn(GROUPS, name) ? GROUPS[name] : undefined
  if (group) {
    const members = specs.filter((s) => group.includes(s.path))
    if (members.length > 0) return members
  }
  const spec = specs.find((s) => s.path === name || s.alias === name || s.aliases?.includes(name))
  if (spec) return [spec]
  const paint = /^(fill|stroke|trim)/.test(name)
  const effect = /^(lfx|tfx)\./.test(name)
  const force = name.startsWith('force.')
  const bone = name.startsWith('bone.')
  const switched = name === 'switch'
  throw new CommandError(
    `This ${kind} layer has no animatable property "${name}".`,
    paint
      ? 'Paint properties belong to the fills and strokes the layer has (layer.properties lists them; a gradient has stop colours, not one colour). Add a paint with layer.patch: insert into "fills" or "strokes".'
      : bone
        ? layer.kind === 'group' && layer.rig
          ? `Bone channels are bone.<boneId>.rotation|x|y|scale; this rig's bones: ${layer.rig.bones.map((b) => `${b.id} (${b.name})`).join(', ') || 'none yet'} (rig.inspect lists them).`
          : 'Bone channels belong to a rig group: rig.create makes one, and bone.<boneId>.rotation|x|y|scale key its bones.'
        : switched
          ? 'Only a switch group has a "switch" property: switch.create makes one.'
          : force
        ? 'Force fields are keyed by the card id that physics.force returned: force.<forceId>.strength, force.<forceId>.radius, force.<forceId>.scale (layer.properties lists them).'
        : effect
        ? 'Effect fields are keyed by the card id that effects.add returned (lfx.<effectId>.<field>, tfx.<effectId>.<field> for text effects); only number and colour fields animate. layer.properties lists them.'
        : `Animatable on this layer: ${specs.map((s) => s.alias).join(', ')}. Use layer.patch for other fields.`,
  )
}

/** Checks a value against a property's type and range, returning it on success. */
export function checkValue(spec: PropertySpec, value: unknown): KeyValue {
  if (spec.type === 'path') {
    if (typeof value !== 'string') throw new CommandError(`${spec.alias} needs SVG path data such as "M0 0 L100 0", not ${JSON.stringify(value)}.`)
    return normalizeSvgPath(value)
  }
  if (spec.type === 'color') {
    if (typeof value === 'string' && ColorSchema.safeParse(value).success) return value
    throw new CommandError(`${spec.alias} needs a hex colour such as "#ff8800", not ${JSON.stringify(value)}.`)
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CommandError(`${spec.alias} needs a number, not ${JSON.stringify(value)}.`)
  }
  if (spec.min !== undefined && value < spec.min) throw new CommandError(`${spec.alias} must be at least ${spec.min}.`)
  if (spec.max !== undefined && value > spec.max) throw new CommandError(`${spec.alias} must be at most ${spec.max}.`)
  return value
}

/** Reads a dotted path such as `transform.x`; returns undefined when it does not exist. */
export function readPath(target: object, path: string): unknown {
  let node: unknown = target
  for (const key of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

/** Writes a dotted path whose parent objects already exist. */
export function writePath(target: object, path: string, value: unknown): void {
  const keys = path.split('.')
  let node = target as Record<string, unknown>
  for (const key of keys.slice(0, -1)) {
    const next = node[key]
    if (next === null || typeof next !== 'object') throw new CommandError(`Path "${path}" does not exist.`)
    node = next as Record<string, unknown>
  }
  node[keys[keys.length - 1] as string] = value
}

/** A property's resting (unkeyed) value. */
export function readProperty(layer: Layer, spec: PropertySpec): KeyValue | undefined {
  return (spec.get ? spec.get(layer) : readPath(layer, spec.path)) as KeyValue | undefined
}

/** Writes a property's resting value into a (draft) layer. */
export function writeProperty(layer: Layer, spec: PropertySpec, value: KeyValue): void {
  if (spec.set) spec.set(layer, value)
  else writePath(layer, spec.path, value)
}

/**
 * A property's value at a time measured from the layer start: sampled when
 * keyed, otherwise static. On a curved stretch of a motion path, x and y come
 * from the curve.
 */
export function evaluateProperty(layer: Layer, spec: PropertySpec, layerTimeMs: number): KeyValue | undefined {
  const keys = layer.animations[spec.path]
  if (spec.path === 'transform.x' || spec.path === 'transform.y') {
    const point = motionPointAt(layer, layerTimeMs)
    if (point) return spec.path === 'transform.x' ? point[0] : point[1]
  }
  if (keys && keys.length > 0) return sampleKeys(keys, layerTimeMs)
  return readProperty(layer, spec)
}
