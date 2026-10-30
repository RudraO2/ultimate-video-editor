import { z } from 'zod'
import { worldStructureProblem } from './doc'
import { groupStructureProblem } from './groups'
import { spatialProblem } from './keys'
import { nestingLoops } from './nest'
import { type Project, ProjectSchema } from './schema'
import { withBuiltIns } from './soundMix'

// The project file: one JSON file holding a manifest and the document. Media
// stay on disk where they are and are referenced by absolute path, so the
// manifest lists them for a quick check (and a relink) without reading the
// whole document. Fonts are listed by family.

export const PROJECT_FILE_FORMAT = 'uve-project'
/**
 * 1: the first format. 2 (A8.1): a layer's pivot (`anchorX`, `anchorY`) is a
 * fraction of its box instead of a pixel offset from its centre. 3 (A8.2):
 * shapes and text have `fills` and `strokes`; a shape's `fill`,
 * `strokeColor` and `strokeWidth` became one solid fill and stroke, and its
 * box no longer counts the stroke. 4 (A8.6): nested comp layers (`nested`)
 * and embedded comps; files of earlier formats need no change. 5 (A9.1):
 * entrance and exit presets (`animIn`, `animOut`) on layers; no change needed.
 * 6 (A9.2): effect stacks (`effects` on layers, `style.textEffects` on text)
 * motion blur (`motionBlur` on comps and layers) and transitions on lanes
 * (`transitions`); no change needed. 7 (A10.9): motion-path handles
 * (`spatial`) on `transform.x` keys; no change needed. 8 (A7b): 3D worlds (`world` on comps,
 * `scaleZ`, camera, light and empty layers); no change needed. 9 (A7h):
 * mesh layers (`geometry`, `shading`); no change needed. 10 (A7k): optional
 * layer `constraints`; earlier files need no change. 11 (A7l): 3D model
 * media (`kind: 'model'`, `model`) and meshes that read them (`geometry`
 * of type asset, `animation`); no change needed. 12 (Q2): the mix
 * (`soundCategories` on the project, `soundBus` and `ducking` on layers,
 * `soundMix` on comps); earlier files keep the sound they had, so their
 * leveler and limiter start off. 13 (Q3): the recorded `keys` sound pack;
 * no change needed (synthesised packs now sound like AtomCut's, at their own
 * levels, and randomness varies volume and pitch instead of timing).
 * 14 (Q4): `soundMix.loudness` (the export's loudness match); earlier files
 * keep their sound, so it starts off. 15 (physics): `physics` on comps (gravity,
 * floor, walls) and on layers (a body), `forces` and `joints` on layers, and
 * `silhouette` on media; all optional, so earlier files need no change.
 * 16 (Q7): characters: `switch`, `rig` and `behaviors` on groups, `bind` on
 * the layers of a rig, and `envelope` (a voice's loudness) on media; all
 * optional or defaulted, so earlier files need no change.
 * 17 (Q8): `scripts` on the project (saved scripts and what their last run
 * made); defaulted to none, so earlier files need no change.
 * 18 (S1): `speech` on media (a take's script, language, voice, speech span
 * and word times); optional, so earlier files need no change.
 */
export const PROJECT_FILE_VERSION = 18
export const PROJECT_FILE_EXTENSION = '.uve'

export const ProjectManifestSchema = z.object({
  savedAt: z.string().describe('ISO time of the save'),
  app: z.string().default(''),
  project: z.object({ id: z.string(), name: z.string() }),
  comps: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        width: z.number(),
        height: z.number(),
        fps: z.number(),
        durationMs: z.number(),
      }),
    )
    .default([]),
  media: z
    .array(z.object({ id: z.string(), kind: z.string(), name: z.string(), path: z.string() }))
    .default([])
    .describe('Media files the project uses, by absolute path'),
  fonts: z.array(z.string()).default([]).describe('Font families the text layers use'),
})

export type ProjectManifest = z.infer<typeof ProjectManifestSchema>

/** A project file that cannot be read, with a message fit to show the user. */
export class ProjectFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectFileError'
  }
}

/** The font families used by the project's text layers, sorted. */
export function projectFonts(project: Project): string[] {
  const families = new Set<string>()
  for (const comp of project.comps) {
    for (const track of comp.tracks) {
      for (const layer of track.layers) if (layer.kind === 'text') families.add(layer.style.fontFamily)
    }
  }
  return [...families].sort()
}

export function projectManifest(project: Project, options: { savedAt?: Date; app?: string } = {}): ProjectManifest {
  return {
    savedAt: (options.savedAt ?? new Date()).toISOString(),
    app: options.app ?? '',
    project: { id: project.id, name: project.name },
    comps: project.comps.map(({ id, name, width, height, fps, durationMs }) => ({ id, name, width, height, fps, durationMs })),
    media: project.media.map(({ id, kind, name, path }) => ({ id, kind, name, path })),
    fonts: projectFonts(project),
  }
}

/** The text of a project file for `project`. */
export function writeProjectFile(project: Project, options: { savedAt?: Date; app?: string } = {}): string {
  const file = {
    format: PROJECT_FILE_FORMAT,
    formatVersion: PROJECT_FILE_VERSION,
    manifest: projectManifest(project, options),
    document: project,
  }
  return `${JSON.stringify(file, null, 2)}\n`
}

/** Media references and other links the schema cannot check. Returns the first problem, if any. */
function brokenLink(project: Project): string | null {
  const media = new Set(project.media.map((m) => m.id))
  const seen = new Set<string>()
  const unique = (id: string, what: string) => {
    if (seen.has(id)) return `two objects share the id "${id}" (${what})`
    seen.add(id)
    return null
  }
  for (const m of project.media) {
    const dup = unique(m.id, 'media')
    if (dup) return dup
  }
  for (const comp of project.comps) {
    const dup = unique(comp.id, 'comp')
    if (dup) return dup
    const groups = groupStructureProblem(comp)
    if (groups) return `in comp "${comp.name}", ${groups}`
    const world = worldStructureProblem(comp)
    if (world) return world
    for (const track of comp.tracks) {
      const dupTrack = unique(track.id, 'track')
      if (dupTrack) return dupTrack
      for (const layer of track.layers) {
        const dupLayer = unique(layer.id, 'layer')
        if (dupLayer) return dupLayer
        const spatial = spatialProblem(layer)
        if (spatial) return spatial
        if ('mediaId' in layer && !media.has(layer.mediaId)) {
          return `layer "${layer.name}" uses media "${layer.mediaId}", which is not in the project`
        }
        if (layer.kind === 'mesh' && layer.geometry.type === 'asset' && !media.has(layer.geometry.assetId)) {
          return `mesh "${layer.name}" shows the model "${layer.geometry.assetId}", which is not in the project`
        }
        if (layer.kind === 'nested') {
          if (!project.comps.some((c) => c.id === layer.sourceCompId)) return `nested layer "${layer.name}" shows comp "${layer.sourceCompId}", which is not in the project`
          if (nestingLoops(project, comp.id, layer.sourceCompId)) return `nested layer "${layer.name}" makes comp "${comp.name}" show itself`
        }
      }
    }
  }
  return null
}

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const numberOr = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)

/**
 * The box a version 1 layer had, for turning its pixel pivot into a fraction.
 * Shapes and media are exact. Text cannot be measured here (no fonts), so its
 * box is estimated from the longest line; only a text pivot moved off the
 * centre by hand is affected, and only slightly.
 */
function legacyBox(layer: Json, media: Map<string, Json>): { width: number; height: number } | null {
  if (layer.kind === 'shape') {
    const shape = isObject(layer.shape) ? layer.shape : {}
    const stroke = numberOr(shape.strokeWidth, 0)
    return { width: numberOr(shape.width, 400) + stroke, height: numberOr(shape.height, 400) + stroke }
  }
  if (layer.kind === 'image' || layer.kind === 'video') {
    const asset = typeof layer.mediaId === 'string' ? media.get(layer.mediaId) : undefined
    return { width: numberOr(asset?.width, 640), height: numberOr(asset?.height, 360) }
  }
  if (layer.kind === 'text') {
    const style = isObject(layer.style) ? layer.style : {}
    const size = numberOr(style.fontSize, 96)
    const lines = String(layer.text ?? '').split('\n')
    const longest = Math.max(1, ...lines.map((line) => [...line].length))
    return {
      width: longest * (size * 0.55 + numberOr(style.letterSpacing, 0)),
      height: lines.length * size * numberOr(style.lineHeight, 1.15),
    }
  }
  return null
}

/** Version 1 to 2: pivots in pixels from the centre become fractions of the box. */
function migrateAnchors(document: unknown): void {
  if (!isObject(document) || !Array.isArray(document.comps)) return
  const media = new Map<string, Json>()
  for (const asset of Array.isArray(document.media) ? document.media : []) {
    if (isObject(asset) && typeof asset.id === 'string') media.set(asset.id, asset)
  }
  for (const comp of document.comps) {
    for (const track of isObject(comp) && Array.isArray(comp.tracks) ? comp.tracks : []) {
      for (const layer of isObject(track) && Array.isArray(track.layers) ? track.layers : []) {
        if (!isObject(layer)) continue
        const box = legacyBox(layer, media)
        const transform = isObject(layer.transform) ? layer.transform : (layer.transform = {})
        for (const [field, size] of [
          ['anchorX', box?.width ?? 0],
          ['anchorY', box?.height ?? 0],
        ] as const) {
          const toFraction = (px: unknown) => (size > 0 ? 0.5 + numberOr(px, 0) / size : 0.5)
          transform[field] = toFraction(transform[field])
          const keys = isObject(layer.animations) ? layer.animations[`transform.${field}`] : undefined
          for (const key of Array.isArray(keys) ? keys : []) if (isObject(key)) key.v = toFraction(key.v)
        }
      }
    }
  }
}

const eachLayer = (document: unknown, visit: (layer: Json) => void) => {
  if (!isObject(document) || !Array.isArray(document.comps)) return
  for (const comp of document.comps) {
    for (const track of isObject(comp) && Array.isArray(comp.tracks) ? comp.tracks : []) {
      for (const layer of isObject(track) && Array.isArray(track.layers) ? track.layers : []) if (isObject(layer)) visit(layer)
    }
  }
}

/** Version 2 to 3: a shape's fill and stroke fields become paints, and its pivot is re-measured without the stroke. */
function migratePaints(document: unknown): void {
  eachLayer(document, (layer) => {
    if (layer.kind !== 'shape' || !isObject(layer.shape)) return
    const shape = layer.shape
    const animations = isObject(layer.animations) ? layer.animations : (layer.animations = {})
    const fillId = `${String(layer.id)}_fill`
    const strokeId = `${String(layer.id)}_stroke`
    const strokeWidth = numberOr(shape.strokeWidth, 0)
    const strokeKeyed = Array.isArray(animations['shape.strokeWidth']) || Array.isArray(animations['shape.strokeColor'])
    layer.fills = [{ id: fillId, type: 'solid', color: typeof shape.fill === 'string' ? shape.fill : '#7c5cff' }]
    layer.strokes =
      strokeWidth > 0 || strokeKeyed
        ? [{ id: strokeId, paint: { id: `${strokeId}_paint`, type: 'solid', color: typeof shape.strokeColor === 'string' ? shape.strokeColor : '#ffffff' }, width: strokeWidth }]
        : []
    for (const [from, to] of [
      ['shape.fill', `fill.${fillId}`],
      ['shape.strokeColor', `stroke.${strokeId}.color`],
      ['shape.strokeWidth', `stroke.${strokeId}.width`],
    ] as const) {
      if (animations[from] !== undefined) animations[to] = animations[from]
      delete animations[from]
    }
    // The pivot was a fraction of the box with the stroke; make it the same point of the box without.
    const transform = isObject(layer.transform) ? layer.transform : undefined
    if (transform && strokeWidth > 0) {
      for (const [field, size] of [
        ['anchorX', numberOr(shape.width, 400)],
        ['anchorY', numberOr(shape.height, 400)],
      ] as const) {
        const refit = (a: unknown) => 0.5 + ((numberOr(a, 0.5) - 0.5) * (size + strokeWidth)) / size
        transform[field] = refit(transform[field])
        const keys = animations[`transform.${field}`]
        for (const key of Array.isArray(keys) ? keys : []) if (isObject(key)) key.v = refit(key.v)
      }
    }
    delete shape.fill
    delete shape.strokeColor
    delete shape.strokeWidth
  })
}

/** Version 11 to 12: comps made before the mix keep their sound: leveler and limiter off. */
function migrateMix(document: unknown): void {
  if (!isObject(document) || !Array.isArray(document.comps)) return
  for (const comp of document.comps) {
    if (!isObject(comp) || comp.soundMix !== undefined) continue
    comp.soundMix = { leveler: { enabled: false }, limiter: { enabled: false } }
  }
}

/** Version 13 to 14: comps made before the loudness match keep their sound: it starts off. */
function migrateLoudness(document: unknown): void {
  if (!isObject(document) || !Array.isArray(document.comps)) return
  for (const comp of document.comps) {
    if (!isObject(comp)) continue
    const mix = isObject(comp.soundMix) ? comp.soundMix : (comp.soundMix = {})
    if (isObject(mix) && mix.loudness === undefined) mix.loudness = { enabled: false }
  }
}

/**
 * Reads the text of a project file. Throws `ProjectFileError` when it is not
 * JSON, not a project file, written by a newer version, or damaged.
 */
export function readProjectFile(text: string): { project: Project; manifest: ProjectManifest } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new ProjectFileError('That file is not valid JSON, so it is not a project file.')
  }
  if (typeof raw !== 'object' || raw === null || (raw as { format?: unknown }).format !== PROJECT_FILE_FORMAT) {
    throw new ProjectFileError('That is not an Ultimate Video Editor project file.')
  }
  const { formatVersion, document, manifest } = raw as { formatVersion?: unknown; document?: unknown; manifest?: unknown }
  if (typeof formatVersion !== 'number' || !Number.isInteger(formatVersion) || formatVersion < 1) {
    throw new ProjectFileError('That project file is damaged: its format version is missing.')
  }
  if (formatVersion > PROJECT_FILE_VERSION) {
    throw new ProjectFileError('That project was saved by a newer version of Ultimate Video Editor. Update the app to open it.')
  }
  if (formatVersion < 2) migrateAnchors(document)
  if (formatVersion < 3) migratePaints(document)
  if (formatVersion < 12) migrateMix(document)
  if (formatVersion < 14) migrateLoudness(document)
  const parsed = ProjectSchema.safeParse(document)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue && issue.path.length > 0 ? ` at ${issue.path.join('.')}` : ''
    throw new ProjectFileError(`That project file is damaged and could not be read${where}: ${issue?.message ?? 'invalid document'}.`)
  }
  // The built-in categories are always there, even if a file lost one.
  parsed.data.soundCategories = withBuiltIns(parsed.data.soundCategories)
  const broken = brokenLink(parsed.data)
  if (broken) throw new ProjectFileError(`That project file is damaged: ${broken}.`)
  // The manifest is only a summary; a damaged one is rebuilt from the document.
  const summary = ProjectManifestSchema.safeParse(manifest)
  return { project: parsed.data, manifest: summary.success ? summary.data : projectManifest(parsed.data) }
}
