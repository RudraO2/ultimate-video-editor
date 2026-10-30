import { type Comp, isSpatialKind, type Layer, type LightType } from '@uve/core'

// Which rows the 3D inspector sections show: pure, so they can be tested.

/** The transform rows a layer has in a 3D world. */
export interface WorldTransformRows {
  /** Scale X, Y and Z. A camera and a light have no use for a scale. */
  scale: boolean
  /** The pivot across and down the picture's own box (pictures only). */
  pivot: boolean
  /** Opacity (pictures only: cameras, lights and controllers draw nothing). */
  opacity: boolean
}

export function worldTransformRows(kind: Layer['kind']): WorldTransformRows {
  const picture = !isSpatialKind(kind)
  return { scale: picture || kind === 'empty' || kind === 'mesh', pivot: picture, opacity: picture }
}

/** The mesh fields that depend on its shading: the smoothing angle only matters for Auto. */
export function meshRows(shading: 'smooth' | 'flat' | 'auto') {
  return { autoAngle: shading === 'auto' }
}

/** The fields of a light that matter for its type. */
export interface LightRows {
  range: boolean
  spot: boolean
  area: boolean
  ground: boolean
  environment: boolean
  shadow: boolean
}

export function lightRows(type: LightType): LightRows {
  return {
    range: type === 'point' || type === 'spot',
    spot: type === 'spot',
    area: type === 'area',
    ground: type === 'hemisphere',
    environment: type === 'environment',
    shadow: type !== 'environment' && type !== 'hemisphere',
  }
}

/** The camera fields that depend on its projection and depth of field. */
export function cameraRows(projection: 'perspective' | 'orthographic', dofEnabled: boolean) {
  return { orthoScale: projection === 'orthographic', focus: dofEnabled }
}

/** The material fields that matter for its shading model. */
export interface MaterialRows {
  /** Roughness, the same for pbr and unused by the flat models. */
  roughness: boolean
  metalness: boolean
  transmission: boolean
  /** Index of refraction and thickness: only when light passes through. */
  refraction: boolean
  clearcoat: boolean
  /** The coat's own roughness: only with a coat. */
  clearcoatRoughness: boolean
  sheen: boolean
  iridescence: boolean
  /** Bands of light (toon only). */
  toonSteps: boolean
  /** Emission: lit models glow; an unlit picture ignores lights, so it has none. */
  emission: boolean
}

export function materialRows(model: 'pbr' | 'toon' | 'unlit', transmission: number, clearcoat: number): MaterialRows {
  const pbr = model === 'pbr'
  return {
    roughness: pbr,
    metalness: pbr,
    transmission: pbr,
    refraction: pbr && transmission > 0,
    clearcoat: pbr,
    clearcoatRoughness: pbr && clearcoat > 0,
    sheen: pbr,
    iridescence: pbr,
    toonSteps: model === 'toon',
    emission: model !== 'unlit',
  }
}

/** The bloom fields: its settings matter only when it is on. */
export function bloomRows(enabled: boolean) {
  return { settings: enabled }
}

/** The ambient occlusion fields: its settings matter only when it is on. */
export function aoRows(enabled: boolean) {
  return { settings: enabled }
}

/** The floor fields: a floor of mode none has no colour, opacity or height. */
export function floorRows(mode: 'none' | 'shadow' | 'solid' | 'mirror') {
  return { settings: mode !== 'none' }
}

/**
 * The depth-of-field fields. Focus distance and f-stop show with it on; a
 * focus layer overrides the distance, so that row is dimmed while one is set.
 */
export function dofRows(enabled: boolean, focusOn: string | null) {
  return { settings: enabled, distanceOverridden: focusOn !== null }
}

/** The layers a camera can focus on: the pictures and meshes of its world (not itself, lights, controllers or sound). */
/** The layers of a world another layer can look at, follow or be a child of: every one but itself and audio. */
export function trackTargets(comp: Comp, layerId: string): { id: string; name: string }[] {
  return comp.tracks.flatMap((track) => track.layers.filter((l) => l.id !== layerId && l.kind !== 'audio').map((l) => ({ id: l.id, name: l.name })))
}

export function focusCandidates(comp: Comp, cameraId: string): { id: string; name: string }[] {
  const found: { id: string; name: string }[] = []
  for (const track of comp.tracks) {
    for (const layer of track.layers) {
      // A group is only a parent in a world, with no place of its own; a controller is a good focus mark.
      if (layer.id === cameraId || layer.kind === 'audio' || layer.kind === 'group') continue
      if (layer.kind === 'camera' || layer.kind === 'light') continue
      found.push({ id: layer.id, name: layer.name })
    }
  }
  return found
}
