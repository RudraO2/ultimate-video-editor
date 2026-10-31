import { type Comp, CommandError, defineCommand, type GroupLayer, type Layer, locateLayer } from '@uve/core'
import { z } from 'zod'

// The "frame look" of a screen recording (Screen Studio, OpenScreen): the
// clip sits in a rounded card with a soft shadow, on a gradient background.
// Built only from ordinary layers and commands, so every piece stays editable:
//
//   Background          a comp-sized rectangle on the back lane
//   Screen frame        a group, mode mask, with a fixed layout box = the card
//     Frame             a rounded rectangle, the stencil
//     <the video>       keeps its own transform and keys
//
// The group's layout has a fixed width and height and both members are
// "absolute", so the group's box is always exactly the card, however the video
// is zoomed by its keys. That keeps the group's pivot on the card's centre, and
// the padding is a plain scale of the group around it.

const FRAME_GROUP = 'Screen frame'
const FRAME_RECT = 'Frame'
const BACKGROUND = 'Background'

type Stop = [offset: number, color: string]

/** Diagonal gradients, top-left to bottom-right. */
const GRADIENTS: Readonly<Record<string, readonly Stop[]>> = {
  aurora: [[0, '#7F5AF0'], [1, '#2CB1BC']],
  sunset: [[0, '#FF7E5F'], [1, '#FEB47B']],
  ocean: [[0, '#2E3192'], [1, '#1BFFFF']],
  graphite: [[0, '#232526'], [1, '#414345']],
  cream: [[0, '#F4EDE4'], [1, '#E8D9C5']],
}

const SHADOW = { color: '#00000059', x: 0, y: 16, blur: 48 }

/** A paint as layer.create and layer.patch take it: a preset's diagonal gradient, or one colour. */
function backgroundPaint(background: string) {
  const stops = GRADIENTS[background.toLowerCase()]
  if (stops) {
    return { type: 'linear', stops: stops.map(([offset, color]) => ({ offset, color })), start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }
  }
  if (/^#[0-9a-f]{6}$/i.test(background)) return { type: 'solid', color: background }
  throw new CommandError(`"${background}" is not a background.`, `Use ${Object.keys(GRADIENTS).join(', ')}, or a colour like "#1a1a2e".`)
}

/** The scale that fits a card of this size inside the comp, leaving the padding on every side. */
function fitScale(comp: Comp, width: number, height: number, padding: number): number {
  const margin = padding * Math.min(comp.width, comp.height)
  return Math.max(0.05, Math.min((comp.width - 2 * margin) / width, (comp.height - 2 * margin) / height))
}

const layersOf = (comp: Comp): Layer[] => comp.tracks.flatMap((t) => t.layers)

export const screenFrame = defineCommand({
  name: 'screen.frame',
  summary: 'Give a screen recording the frame look: the clip in a rounded card with a soft shadow, on a gradient background.',
  details:
    'id: a video layer. It is put in a group named "Screen frame" (mode mask) with a rounded rectangle the size of the clip as its stencil, and the group is scaled so the card sits in the comp with padding on every side, centred. The clip keeps its own transform and keys, so auto-zoom keys work inside the rounded frame. A rectangle named "Background" covers the comp on the back lane, over the same time as the clip. padding: fraction of the comp\'s shorter side left on each side, 0 to 0.3 (default 0.06). radius: corner radius in px (default 20). shadow: a soft drop shadow on the card (default true). background: aurora, sunset, ocean, graphite or cream (diagonal gradients), or a colour "#rrggbb" (default aurora). Run it again on the same clip to change radius, padding, shadow or background: it does not frame twice. Returns groupId, videoId, frameId (the stencil) and backgroundId.',
  effect: 'write',
  input: z.strictObject({
    id: z.string().min(1).describe('The video layer (id or name)'),
    padding: z.number().min(0).max(0.3).default(0.06).describe("Fraction of the comp's shorter side on each side"),
    radius: z.number().min(0).max(200).default(20).describe('Corner radius of the card, px'),
    shadow: z.boolean().default(true),
    background: z.string().min(1).default('aurora').describe('aurora, sunset, ocean, graphite, cream, or a "#rrggbb" colour'),
  }),
  run: async ({ id, padding, radius, shadow, background }, ctx) => {
    const call = async (name: string, input: unknown) => {
      const result = await ctx.call(name, input)
      if (!result.ok) throw new CommandError(result.error, result.hint)
      return result.value as Record<string, unknown>
    }
    const paint = backgroundPaint(background)
    const { comp, layer: video, track } = locateLayer(ctx.project, id)
    if (video.kind !== 'video') throw new CommandError(`"${video.name}" is not a video layer.`, 'Give the id of the screen recording on the timeline (layers_list).')

    const all = layersOf(comp)
    const parent = track.groupId === null ? undefined : all.find((l): l is GroupLayer => l.id === track.groupId && l.kind === 'group')
    const framed = parent?.name === FRAME_GROUP && parent.layout?.width && parent.layout.height ? parent : undefined

    // The card: the clip's footprint at rest (media size times its scale), centred where the clip sits.
    let width: number
    let height: number
    let cx: number
    let cy: number
    if (framed?.layout) {
      width = framed.layout.width as number
      height = framed.layout.height as number
      cx = framed.layout.x + width / 2
      cy = framed.layout.y + height / 2
    } else {
      const media = ctx.project.media.find((m) => m.id === video.mediaId)
      const t = video.transform
      width = (media?.width ?? comp.width) * Math.abs(t.scaleX)
      height = (media?.height ?? comp.height) * Math.abs(t.scaleY)
      cx = t.x + (0.5 - t.anchorX) * width
      cy = t.y + (0.5 - t.anchorY) * height
    }
    const corner = Math.min(radius, width / 2, height / 2)
    const scale = fitScale(comp, width, height, padding)

    let groupId: string
    let frameId: string
    if (framed) {
      groupId = framed.id
      const members = comp.tracks.filter((tr) => tr.groupId === framed.id).flatMap((tr) => tr.layers)
      const frame = members.find((l) => l.kind === 'shape' && l.isStencil)
      if (!frame) throw new CommandError(`"${FRAME_GROUP}" has lost its stencil rectangle.`, 'Ungroup it (layers_ungroup) and run screen_frame again.')
      frameId = frame.id
      await call('layer.patch', { id: frame.id, ops: [{ op: 'set', path: 'shape.cornerRadius', value: corner }] })
    } else {
      const created = await call('layer.create', {
        compId: comp.id,
        kind: 'shape',
        name: FRAME_RECT,
        startMs: video.startMs,
        durationMs: video.durationMs,
        shape: { type: 'rect', width, height, cornerRadius: corner },
        fill: '#ffffff',
        x: cx,
        y: cy,
        ...(parent ? { groupId: parent.id } : {}),
      })
      frameId = created.id as string
      await call('layer.patch', {
        id: frameId,
        ops: [
          { op: 'set', path: 'isStencil', value: true },
          { op: 'set', path: 'layoutItem.absolute', value: true },
        ],
      })
      await call('layer.patch', { id: video.id, ops: [{ op: 'set', path: 'layoutItem.absolute', value: true }] })
      const grouped = await call('layers.group', {
        ids: [video.id, frameId],
        name: FRAME_GROUP,
        mode: 'mask',
      })
      groupId = grouped.groupId as string
      // The layout comes after grouping, so the members keep their order (the stencil in front).
      await call('layout.set', { id: groupId, layout: { flow: 'column', gap: 0, padding: 0, x: cx - width / 2, y: cy - height / 2, width, height } })
    }

    // Padding: scale the group about the card's centre (its pivot), and move the centre to the comp's.
    await call('layer.set', { id: groupId, values: { x: -cx, y: -cy, scale }, mode: 'base' })

    // Shadow on the group, so it follows the rounded silhouette.
    const group = locateLayer(ctx.project, groupId).layer
    const shadowCard = group.kind === 'audio' ? undefined : group.effects.find((e) => e.type === 'shadow')
    if (shadow && !shadowCard) await call('effects.add', { id: groupId, type: 'shadow', values: SHADOW })
    if (!shadow && shadowCard) await call('effects.update', { id: groupId, effectId: shadowCard.id, remove: true })

    // Background: a comp-sized rectangle on the back lane, over the clip's time.
    const existing = comp.tracks.find((tr) => tr.groupId === null && tr.layers.some((l) => l.kind === 'shape' && l.name === BACKGROUND))
    const old = existing?.layers.find((l) => l.kind === 'shape' && l.name === BACKGROUND)
    let backgroundId: string
    if (old) {
      backgroundId = old.id
      await call('layer.patch', { id: old.id, ops: [{ op: 'set', path: 'fills', value: [paint] }] })
    } else {
      const bg = await call('layer.create', {
        compId: comp.id,
        kind: 'shape',
        name: BACKGROUND,
        startMs: video.startMs,
        durationMs: video.durationMs,
        shape: { type: 'rect', width: comp.width, height: comp.height },
        fill: paint,
        x: 0,
        y: 0,
      })
      backgroundId = bg.id as string
      await call('layers.restack', { ids: [backgroundId], to: 'back' })
    }
    return { groupId, videoId: video.id, frameId, backgroundId }
  },
})
