import { CommandError } from './errors'
import type { IdGenerator } from './ids'
import { randomId } from './ids'
import {
  type Comp,
  type Layer,
  type MediaAsset,
  type Page,
  type Project,
  ProjectSchema,
  SPATIAL_KINDS,
  type SpatialKind,
  type Track,
} from './schema'

/** Where a layer lives in the project. */
export interface LayerLocation {
  comp: Comp
  track: Track
  trackIndex: number
  layer: Layer
  layerIndex: number
}

/** A new project with one empty 1920×1080, 30 fps, 10 second comp. */
export function createDefaultProject(ids: IdGenerator = randomId): Project {
  const page = ids('page')
  return ProjectSchema.parse({
    version: 1,
    id: ids('project'),
    name: 'Untitled project',
    pages: [{ id: page, name: 'Page 1' }],
    comps: [{ id: ids('comp'), name: 'Comp 1', width: 1920, height: 1080, fps: 30, durationMs: 10_000, pageId: page }],
  })
}

/** Finds a page by id or by name (any case). */
export function findPage(project: Project, ref: string): Page {
  const wanted = ref.trim().toLowerCase()
  const page = project.pages.find((p) => p.id === ref) ?? project.pages.find((p) => p.name.toLowerCase() === wanted)
  if (!page) throw new CommandError('No page "' + ref + '".', 'Pages: ' + project.pages.map((p) => p.id + ' (' + p.name + ')').join(', '))
  return page
}

/** The page a comp is on: its own, or the first when it names none; embedded comps are on no page. */
export function pageOf(project: Project, comp: Comp): Page | null {
  if (comp.embedded) return null
  return project.pages.find((p) => p.id === comp.pageId) ?? (project.pages[0] as Page)
}

/** The comps on a page, in project order. */
export function compsOnPage(project: Project, page: Page): Comp[] {
  return project.comps.filter((c) => pageOf(project, c)?.id === page.id)
}

/** The time a comp shows when asked for `timeMs`: a static comp always shows its still. */
export function compTimeFor(comp: Pick<Comp, 'mode' | 'stillMs' | 'durationMs'>, timeMs: number): number {
  return comp.mode === 'static' ? Math.min(comp.stillMs, comp.durationMs) : timeMs
}

export const layerEnd = (layer: Pick<Layer, 'startMs' | 'durationMs'>): number => layer.startMs + layer.durationMs

/** Finds a comp by id or name. With one comp in the project the id may be omitted. */
export function findComp(project: Project, ref?: string): Comp {
  const list = () => project.comps.map((c) => `${c.id} (${c.name})`).join(', ')
  if (ref === undefined) {
    const only = project.comps.length === 1 ? project.comps[0] : undefined
    if (only) return only
    throw new CommandError('This project has several comps; say which one.', `compId is one of: ${list()}`)
  }
  const comp = project.comps.find((c) => c.id === ref) ?? project.comps.find((c) => c.name === ref)
  if (!comp) throw new CommandError(`No comp "${ref}".`, `Comps: ${list()}`)
  return comp
}

/** Finds a layer by id, or by an exact name that only one layer has. */
export function locateLayer(project: Project, ref: string): LayerLocation {
  const named: LayerLocation[] = []
  for (const comp of project.comps) {
    for (const [trackIndex, track] of comp.tracks.entries()) {
      for (const [layerIndex, layer] of track.layers.entries()) {
        const location = { comp, track, trackIndex, layer, layerIndex }
        if (layer.id === ref) return location
        if (layer.name === ref) named.push(location)
      }
    }
  }
  const [only, ...others] = named
  if (only && others.length === 0) return only
  if (only) throw new CommandError(`Several layers are named "${ref}".`, `Use an id: ${named.map((l) => l.layer.id).join(', ')}`)
  throw new CommandError(`No layer "${ref}".`, 'layers.list shows every layer with its id.')
}

export function findMedia(project: Project, id: string): MediaAsset {
  const media = project.media.find((m) => m.id === id)
  if (!media) throw new CommandError(`No media "${id}".`, 'Add files with media.add first.')
  return media
}

/** Every layer, in any comp, that shows or plays a media file (a model mesh reads its model). */
export function layersUsing(project: Project, mediaId: string): Layer[] {
  return project.comps.flatMap((comp) =>
    comp.tracks.flatMap((track) => track.layers.filter((l) => ('mediaId' in l && l.mediaId === mediaId) || (l.kind === 'mesh' && l.geometry.type === 'asset' && l.geometry.assetId === mediaId))),
  )
}

/** A new lane: shown, audible and unlocked; in a group when `groupId` is given. */
export function newTrack(id: string, layers: Layer[] = [], name?: string, groupId: string | null = null): Track {
  return { id, hidden: false, muted: false, locked: false, groupId, layers, transitions: [], ...(name !== undefined ? { name } : {}) }
}

export function findTrack(comp: Comp, id: string): Track {
  const track = comp.tracks.find((t) => t.id === id)
  if (!track) throw new CommandError(`Comp "${comp.name}" has no track "${id}".`, 'layers.list shows the tracks.')
  return track
}

/** Finds a track by id in any comp. */
export function locateTrack(project: Project, id: string): { comp: Comp; track: Track; trackIndex: number } {
  for (const comp of project.comps) {
    const trackIndex = comp.tracks.findIndex((t) => t.id === id)
    const track = comp.tracks[trackIndex]
    if (track) return { comp, track, trackIndex }
  }
  throw new CommandError(`No track "${id}".`, 'layers.list shows the tracks.')
}

/** The first layer on the track that overlaps [startMs, endMs); touching neighbours do not count. */
function layerInTheWay(track: Track, startMs: number, endMs: number, ignoreId?: string): Layer | undefined {
  return track.layers.find((l) => l.id !== ignoreId && l.startMs < endMs && startMs < layerEnd(l))
}

/** Whether [startMs, endMs) is free on the track (touching neighbours is fine). */
export function laneIsFree(track: Track, startMs: number, endMs: number, ignoreId?: string): boolean {
  return layerInTheWay(track, startMs, endMs, ignoreId) === undefined
}

/** Throws unless [startMs, endMs) is free on the track (touching neighbours is fine). A group's own lane holds only the group. */
export function assertLaneFree(track: Track, startMs: number, endMs: number, ignoreId?: string): void {
  const group = track.layers.find((l) => l.kind === 'group' && l.id !== ignoreId)
  if (group) {
    throw new CommandError(
      `Track "${track.id}" is the lane of group "${group.name}", which holds nothing else.`,
      'Put members on the lanes after it (layer.create with groupId, or a member lane as trackId).',
    )
  }
  const hit = layerInTheWay(track, startMs, endMs, ignoreId)
  if (hit) {
    throw new CommandError(
      `That time is taken on this track by "${hit.name}" (${hit.startMs}–${layerEnd(hit)} ms).`,
      'Pick another time or track, or pass trackId: "new".',
    )
  }
}

/** Keeps a track's layers in time order. */
export function sortLane(track: Track): void {
  track.layers.sort((a, b) => a.startMs - b.startMs)
}

/** Shifts every keyframe of a layer by `deltaMs` (keys are relative to the layer start). */
export function shiftKeys(layer: Layer, deltaMs: number): void {
  if (deltaMs === 0) return
  for (const keys of Object.values(layer.animations)) {
    for (const key of keys) key.t += deltaMs
  }
}

/** True for the kinds that live only in 3D worlds: camera, light, empty and mesh. */
export function isSpatialKind(kind: string): kind is SpatialKind {
  return (SPATIAL_KINDS as readonly string[]).includes(kind)
}

/** What is wrong with a comp's world, if anything: a flat comp (no `world`) cannot hold cameras, lights, controllers or meshes. */
export function worldStructureProblem(comp: Comp): string | null {
  for (const track of comp.tracks) {
    for (const layer of track.layers) {
      if (layer.extrude && !['text', 'shape', 'path', 'image', 'video', 'nested'].includes(layer.kind)) {
        return `the ${layer.kind} "${layer.name}" has thickness; only pictures do`
      }
      if (layer.extrude && !comp.world) {
        return `comp "${comp.name}" is flat but "${layer.name}" has thickness; thickness lives only on pictures of 3D worlds`
      }
      // A material is how a picture takes light: only pictures of a world have one.
      if (layer.material && isSpatialKind(layer.kind) && layer.kind !== 'mesh') {
        return `the ${layer.kind === 'empty' ? 'controller' : layer.kind} "${layer.name}" has a material; only pictures and meshes do`
      }
      if (layer.material && !comp.world) {
        return `comp "${comp.name}" is flat but "${layer.name}" has a material; materials live only on layers of 3D worlds`
      }
      if (!comp.world && isSpatialKind(layer.kind)) {
        return `comp "${comp.name}" is flat but holds the ${layer.kind === 'empty' ? 'controller' : layer.kind} "${layer.name}"; cameras, lights, controllers and meshes live only in 3D worlds`
      }
    }
  }
  return null
}
