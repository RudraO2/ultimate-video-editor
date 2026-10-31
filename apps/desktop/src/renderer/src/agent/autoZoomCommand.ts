import { CommandError, defineCommand, locateLayer } from '@uve/core'
import { z } from 'zod'
import { planAutoZoom, type ZoomDepth, zoomKeyframes } from '../../../shared/autoZoom'

// Zooms on the clicks of a screen recording (OpenScreen's auto-zoom), as
// ordinary scale and position keys on the clip: edit, move or delete them like
// any keys. The clicks come from the cursor sidecar the recorder keeps beside
// the file (`<video>.cursor.json`).

export const mediaAutoZoom = defineCommand({
  name: 'media.auto_zoom',
  summary: 'Zoom in on the clicks of a screen recording: scale and position keys on the clip, eased in before each click and out after, from the cursor data kept beside the recording.',
  details:
    'id: a video layer whose file was recorded in the editor (Record button or screen_record), so `<file>.cursor.json` sits beside it. Clicks close together become one zoom that keeps them all in view; the first 2.5 s and the last second stay wide; the click on Stop is ignored. depth 1 to 6 forces one zoom depth for every zoom (1.25x, 1.5x, 1.8x, 2.2x, 3.5x, 5x); omitted, each zoom is the deepest that fits its clicks (up to 1.8x). It replaces the clip\'s scale and position keys; clear: true removes them (back to the still pose). Returns the zooms (layer times) and how many clicks they cover.',
  effect: 'write',
  input: z.strictObject({
    id: z.string().min(1).describe('The video layer (id or name)'),
    depth: z.number().int().min(1).max(6).optional().describe('One depth for every zoom: 1 = 1.25x … 3 = 1.8x … 6 = 5x'),
    clear: z.boolean().default(false).describe('Remove the zoom keys instead'),
  }),
  run: async ({ id, depth, clear }, ctx) => {
    const { layer } = locateLayer(ctx.project, id)
    if (layer.kind !== 'video') throw new CommandError(`"${layer.name}" is not a video layer.`, 'Give the id of a screen recording on the timeline (layers_list).')
    const media = ctx.project.media.find((m) => m.id === layer.mediaId)
    if (!media) throw new CommandError(`The file of "${layer.name}" is not in the project.`, 'Import it again.')
    const t = layer.transform
    const call = async (name: string, input: unknown) => {
      const result = await ctx.call(name, input)
      if (!result.ok) throw new CommandError(result.error, result.hint)
      return result.value
    }

    if (clear) {
      // Frozen at the clip's start, which is its still pose (a zoom never starts there).
      await call('keyframes.clear', { id: layer.id, properties: ['scale', 'position'], atMs: layer.startMs })
      return { zooms: [], cleared: true }
    }

    const recording = await window.uve.recorder.cursor(media.path)
    if (!recording) {
      throw new CommandError(
        `"${media.name}" has no cursor data beside it.`,
        'Auto-zoom works on recordings made in the editor (the Record button or screen_record); their clicks are kept in <file>.cursor.json.',
      )
    }
    const width = media.width ?? 1920
    const height = media.height ?? 1080
    const rate = layer.playbackRate
    const fromMs = layer.sourceStartMs
    const toMs = fromMs + layer.durationMs * rate
    const shots = planAutoZoom(recording, { fromMs, toMs, video: { width, height }, ...(depth ? { depth: depth as ZoomDepth } : {}) })
    if (shots.length === 0) {
      const clicks = recording.samples.filter((s) => s.interactionType === 'click').length
      return {
        zooms: [],
        note:
          clicks === 0
            ? 'The recording has no clicks, so nothing to zoom on. Zoom by hand with scale and position keys.'
            : 'No click is far enough from the start, the end and each other for a zoom (the first 2.5 s and the last second stay wide).',
      }
    }
    const keys = zoomKeyframes(shots, {
      x: t.x,
      y: t.y,
      scale: t.scaleX,
      anchorX: t.anchorX,
      anchorY: t.anchorY,
      width,
      height,
      sourceStartMs: layer.sourceStartMs,
      playbackRate: rate,
      durationMs: layer.durationMs,
    })
    await call('keyframes.set', { id: layer.id, path: 'scale', keys: keys.scale, mode: 'replace' })
    await call('keyframes.set', { id: layer.id, path: 'position', keys: keys.position, mode: 'replace' })
    return {
      zooms: shots.map((s) => ({
        fromMs: Math.round((s.startMs - layer.sourceStartMs) / rate),
        toMs: Math.round((s.endMs - layer.sourceStartMs) / rate),
        scale: s.scale,
        focus: [Number(s.cx.toFixed(3)), Number(s.cy.toFixed(3))],
        clicks: s.clicks,
      })),
      note: 'Each zoom eases in before its first click and out after its last; the keys are ordinary scale and position keys on the clip.',
    }
  },
})
