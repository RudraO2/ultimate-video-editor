import { z } from 'zod'
import { idList } from '../compat'
import { locateLayer } from '../doc'
import { CommandError } from '../errors'
import { defineCommand } from '../registry'
import { ColorSchema, ExtrudeSchema, IdSchema, type Layer } from '../schema'
import { parseSvgPath } from '../svgPath'
import { isWorld } from '../world'

/** Every contour must close, including separate contours in a compound path. */
export function closedPath(path: string): boolean {
  const commands = parseSvgPath(path)
  let open = false
  for (const command of commands) {
    if (command.c === 'M') {
      if (open) return false
      open = true
    } else if (command.c === 'Z') open = false
  }
  return !open
}

export const worldExtrude = defineCommand({
  name: 'world.extrude',
  summary: 'Give picture layers in a 3D world thickness, or make them flat with depth 0.',
  details: 'Depth and bevel are in px and can be keyed at extrude.depth and extrude.bevel. fit outline follows the glyph, shape, path or image silhouette; box makes a slab and is the default for video and nested frames. sideColor defaults to a darker version of the fill. Paths must be closed.',
  effect: 'write',
  input: z.strictObject({
    ids: z.union([IdSchema, z.array(IdSchema).min(1)]),
    depth: z.number().min(0),
    bevel: z.number().min(0).optional(),
    bevelSegments: z.number().int().min(1).max(8).optional(),
    sideColor: ColorSchema.nullable().optional(),
    fit: z.enum(['outline', 'box']).optional(),
  }),
  run: ({ ids, depth, bevel, bevelSegments, sideColor, fit }, ctx) => {
    const layers = idList(undefined, ids).map((ref) => locateLayer(ctx.project, ref))
    for (const { comp, layer } of layers) {
      if (!isWorld(comp)) throw new CommandError(`"${layer.name}" is in a flat comp, not a 3D world.`, 'Move the layer into a world with world_move_into first.')
      if (!['text', 'shape', 'path', 'image', 'video', 'nested'].includes(layer.kind)) {
        throw new CommandError(`"${layer.name}" has no picture to extrude.`, 'Pass text, a shape, a closed path, an image, video or nested frame.')
      }
      if (layer.kind === 'path' && (!closedPath(layer.geometry) || (layer.animations.geometry ?? []).some((key) => typeof key.v === 'string' && !closedPath(key.v)))) {
        throw new CommandError(`"${layer.name}" is an open path and cannot be extruded.`, 'Close every contour with Z, then try again.')
      }
    }
    const made = new Map<string, NonNullable<Layer['extrude']>>()
    for (const { layer } of layers) {
      const previous = layer.extrude ?? { fit: layer.kind === 'video' || layer.kind === 'nested' ? 'box' : 'outline' }
      made.set(layer.id, ExtrudeSchema.parse({ ...previous, depth, ...(bevel !== undefined ? { bevel } : {}), ...(bevelSegments !== undefined ? { bevelSegments } : {}), ...(sideColor !== undefined ? { sideColor } : {}), ...(fit !== undefined ? { fit } : {}) }))
    }
    ctx.write('Set thickness', (draft) => {
      for (const { layer } of layers) locateLayer(draft, layer.id).layer.extrude = made.get(layer.id)
    })
    return { updated: layers.map(({ layer }) => layer.id), extrude: made.get(layers[0]?.layer.id ?? '') }
  },
})
