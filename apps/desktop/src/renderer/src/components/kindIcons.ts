import { type Layer, isWorld, liveCamera } from '@uve/core'
import { Box, Camera, Film, Group, Image as ImageIcon, Layers, Lightbulb, type IconComponent, Move3d, Music, PenTool, Square, Type } from '../icons'
import { activeComp, useEditor } from '../store'

/** The icon of each layer kind, in the Layers tab and on timeline lanes. */
export const KIND_ICONS: Record<Layer['kind'], IconComponent> = {
  text: Type,
  shape: Square,
  path: PenTool,
  group: Group,
  nested: Layers,
  image: ImageIcon,
  video: Film,
  audio: Music,
  camera: Camera,
  light: Lightbulb,
  empty: Move3d,
  mesh: Box,
}

/** The text colour token of each layer kind (the clip colours). */
export const KIND_COLORS: Record<Layer['kind'], string> = {
  text: 'text-clip-text',
  shape: 'text-clip-shape',
  image: 'text-clip-image',
  video: 'text-clip-video',
  audio: 'text-clip-audio',
  group: 'text-clip-group',
  path: 'text-clip-path',
  nested: 'text-clip-nested',
  camera: 'text-clip-video',
  light: 'text-clip-shape',
  empty: 'text-clip-group',
  mesh: 'text-clip-shape',
}

/** Whether a layer is the camera its world is seen through at the playhead. A boolean, so a clip redraws only when it gains or loses the mark. */
export function useIsLiveCamera(layer: Layer): boolean {
  return useEditor((s) => {
    if (layer.kind !== 'camera') return false
    const comp = activeComp(s)
    return isWorld(comp) && liveCamera(comp, s.timeMs)?.id === layer.id
  })
}

/** The small "LIVE" pill that marks the live camera. */
export const LIVE_PILL = 'shrink-0 rounded-full bg-accent/20 px-1.5 py-px font-mono text-[8px] font-semibold tracking-wider text-accent uppercase'
