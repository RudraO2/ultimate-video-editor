import type { LightType } from './schema'

/** What a light gets when no intensity is given: watts for point, spot and area, a plain strength for the rest (AtomCut's). */
export const LIGHT_INTENSITY: Record<LightType, number> = { point: 1000, spot: 1500, area: 800, sun: 3, environment: 1, hemisphere: 0.6 }

/** What each light type is for, and what its intensity means. */
export const LIGHT_USE: Record<LightType, { unit: 'watts' | 'strength'; use: string }> = {
  point: { unit: 'watts', use: 'A bulb: light in every direction from one point, fading with distance (range ends it).' },
  spot: { unit: 'watts', use: 'A cone of light aimed down its -Z: spotAngle is the cone, spotBlend softens its edge.' },
  sun: { unit: 'strength', use: 'Parallel light from far away along its -Z, with sharp shadows: the key light of a scene.' },
  area: { unit: 'watts', use: 'A soft rectangular panel (width, height) facing its -Z: gentle highlights and soft falloff.' },
  environment: { unit: 'strength', use: 'The surroundings: lights everything from all sides and shows in reflections. preset picks studio, soft, sunset, dawn, night or overcast; showBackground draws it behind the scene. Only the first one counts.' },
  hemisphere: { unit: 'strength', use: 'Ambient fill: color from above, groundColor from below.' },
}



/** A gradient sky: colours from the top, the horizon and the bottom, and an optional sun disc (a bright sphere that lights reflections). */
export interface SkyPreset {
  top: string
  horizon: string
  bottom: string
  sun: { color: string; strength: number; elevation: number; azimuth: number } | null
}

/**
 * The environment presets other than `studio` (which is a lit room, built by
 * the renderer). Colours and sun strengths are AtomCut's data; where the sun
 * stands (elevation above the horizon, azimuth round it, degrees) is ours.
 */
export const SKY_PRESETS: Record<'soft' | 'sunset' | 'dawn' | 'night' | 'overcast', SkyPreset> = {
  soft: { top: '#ffffff', horizon: '#e2e5ea', bottom: '#7d8088', sun: { color: '#ffffff', strength: 3, elevation: 60, azimuth: 35 } },
  sunset: { top: '#28335e', horizon: '#ff9452', bottom: '#2c2230', sun: { color: '#ffb36b', strength: 14, elevation: 6, azimuth: 35 } },
  dawn: { top: '#8db6e9', horizon: '#ffd8b2', bottom: '#62656e', sun: { color: '#ffd8b2', strength: 8, elevation: 12, azimuth: -50 } },
  night: { top: '#03050c', horizon: '#141c34', bottom: '#010103', sun: { color: '#bcd0ff', strength: 2.5, elevation: 35, azimuth: 20 } },
  overcast: { top: '#c8cdd5', horizon: '#b0b5bd', bottom: '#5d6168', sun: null },
}
