import type { Draft } from 'immer'
import { z } from 'zod'
import { deepClone } from '../clone'
import { compsOnPage, findComp, findPage, pageOf, worldStructureProblem } from '../doc'
import { CommandError, parseOrThrow } from '../errors'
import { CompMotionBlurSchema, MOTION_BLUR_PRESETS, motionBlurPreset } from '../motionBlur'
import { layersShowing, orphanedEmbeddedComps } from '../nest'
import { applyPatchOps } from '../paths'
import { LevelerSchema, LimiterSchema, LoudnessSchema } from '../soundMix'
import { defineCommand } from '../registry'
import { COMP_MODES, ColorSchema, type Comp, CompSchema, IdSchema, optionalFields, type Page, type Project, type Track } from '../schema'
import { copyLanes } from './arrange'
import { PatchOpSchema } from './layer'

// Frames (AtomCut's name for comps) and pages. A frame is a timeline, or a
// static picture that holds one moment; pages keep frames together.

const size = z.number().int().min(16).max(8192)
const frameRate = z.number().min(1).max(240)
const FRAME_MODES = ['timeline', 'flipbook', 'static'] as const

const FLIPBOOK_LATER = 'Flipbook frames (frame-by-frame cells) are not in this build yet; they come with the drawing tools. A timeline or a static frame can be made.'

function checkMode(mode: (typeof FRAME_MODES)[number]): (typeof COMP_MODES)[number] {
  if (mode === 'flipbook') throw new CommandError(FLIPBOOK_LATER)
  return mode
}

/** The page a new frame goes on: the one named, else the page of the frame in view, else the first. */
export function pageFor(project: Project, ref: string | undefined, viewComp: string | undefined): Page {
  if (ref !== undefined) return findPage(project, ref)
  const open = project.comps.find((c) => c.id === viewComp)
  return (open ? pageOf(project, open) : null) ?? (project.pages[0] as Page)
}

export const frameCreate = defineCommand({
  name: 'frame.create',
  aliases: ['comp.create'],
  summary: 'Create a frame (a comp): a timeline with its own size, frame rate and duration, or a static picture such as a thumbnail or a poster.',
  details:
    'mode timeline (default) animates layers over time; static is ONE picture that shows its still whatever time is asked (nested it holds, exported it is an image) and every layer made in it spans it, so there is no timing to manage. Design a thumbnail, poster or social card as a static frame (1280×720, 1080×1350, 595×842 for A4). pageId (id or name) says which page; omitted, the page of the frame in view. overflow: 0 crops what spills past the box wherever the frame is shown nested, 1 never crops it; omitted, each nested layer decides. Returns the id.',
  effect: 'write',
  input: z.strictObject({
    name: z.string().min(1).optional(),
    width: size.default(1920),
    height: size.default(1080),
    fps: frameRate.default(30),
    durationMs: z.number().positive().optional().describe('Default 10 s; 1 s for a static frame'),
    background: ColorSchema.optional(),
    mode: z.enum(FRAME_MODES).default('timeline'),
    overflow: z.number().min(0).max(1).optional(),
    atMs: z.number().min(0).optional().describe('A static frame: the moment it shows (default 0)'),
    pageId: z.string().min(1).optional().describe('A page id or name'),
  }),
  run: (input, ctx) => {
    const mode = checkMode(input.mode)
    const page = pageFor(ctx.project, input.pageId, ctx.view.compId)
    const durationMs = input.durationMs ?? (mode === 'static' ? 1000 : 10_000)
    const comp = parseOrThrow(
      CompSchema,
      {
        id: ctx.ids('comp'),
        name: input.name ?? 'Frame ' + (ctx.project.comps.filter((c) => !c.embedded).length + 1),
        width: input.width,
        height: input.height,
        fps: input.fps,
        durationMs,
        background: input.background,
        mode,
        stillMs: Math.min(input.atMs ?? 0, durationMs),
        overflow: input.overflow ?? null,
        pageId: page.id,
      },
      'The frame',
    )
    ctx.write('Create frame', (draft) => {
      draft.comps.push(comp)
    })
    return { id: comp.id, pageId: page.id }
  },
})

/** Scales a comp's layers when its box changes: positions by the width and height ratios, sizes by the smaller. */
function scaleContents(comp: Draft<Comp>, rw: number, rh: number): void {
  const s = Math.min(rw, rh)
  const times = (value: unknown, by: number) => (typeof value === 'number' ? value * by : value)
  for (const track of comp.tracks) {
    for (const layer of track.layers) {
      const t = layer.transform
      t.x *= rw
      t.y *= rh
      // A group's own scale is relative to its members, which scale themselves.
      const sized = layer.kind !== 'group'
      if (sized) {
        t.scaleX *= s
        t.scaleY *= s
      }
      for (const [path, by] of [['transform.x', rw], ['transform.y', rh], ...(sized ? ([['transform.scaleX', s], ['transform.scaleY', s]] as const) : [])] as const) {
        for (const key of layer.animations[path] ?? []) key.v = times(key.v, by) as typeof key.v
      }
      // Motion-path handles are px offsets, so they stretch with the frame.
      for (const key of layer.animations['transform.x'] ?? []) {
        if (!key.spatial) continue
        for (const side of ['in', 'out'] as const) {
          const h = key.spatial[side]
          if (h) key.spatial[side] = [h[0] * rw, h[1] * rh]
        }
      }
      if (layer.kind === 'group' && layer.layout) {
        const l = layer.layout
        l.x *= rw
        l.y *= rh
        for (const field of ['gap', 'lineGap'] as const) l[field] *= s
        for (const side of ['top', 'right', 'bottom', 'left'] as const) l.padding[side] *= s
        for (const field of ['width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight'] as const) {
          if (l[field] !== null) l[field] = (l[field] as number) * s
        }
      }
    }
  }
}

/** Fields of a frame with their own inputs, and where to go instead (frame.update ops cannot touch them). */
const GUARDED: Readonly<Record<string, string>> = {
  id: 'Ids never change.',
  tracks: 'Use the layer and track commands.',
  embedded: 'A frame is embedded by layers.nest.',
  pageId: 'Use the pageId input of frame.update.',
  mode: 'Use the mode input of frame.update.',
  stillMs: 'Use the atMs input of frame.update.',
}

export const frameUpdate = defineCommand({
  name: 'frame.update',
  aliases: ['comp.update'],
  summary: "Change a frame: its name, size (optionally scaling its contents), background, frame rate, duration, mode, page, master motion blur, or any other field by patch.",
  details:
    'Resizing keeps the layers where they are in comp space (centred on the box) unless scaleContents is true, which scales positions by the width and height ratios and sizes by the smaller one. mode switches losslessly: timeline to static stills the frame at atMs (default the playhead when the frame is open, else its current still), static to timeline resumes; atMs alone moves the still of a static frame. pageId moves the frame to a page. ops patches anything else (guides, overflow, motionBlur, background…): [{op: "set", path: "overflow", value: 0}]; layers and tracks have their own commands.',
  effect: 'write',
  input: z.strictObject({
    id: IdSchema.optional().describe('Default the frame open in the editor'),
    name: z.string().min(1).optional(),
    width: size.optional(),
    height: size.optional(),
    scaleContents: z.boolean().default(false),
    fps: frameRate.optional(),
    durationMs: z.number().positive().optional(),
    background: ColorSchema.optional(),
    mode: z.enum(FRAME_MODES).optional(),
    atMs: z.number().min(0).optional().describe('The moment a static frame shows'),
    pageId: z.string().min(1).optional().describe('A page id or name: moves the frame there'),
    motionBlur: optionalFields(CompMotionBlurSchema)
      .extend({ preset: z.string().optional().describe('A shutter preset applied first: ' + MOTION_BLUR_PRESETS.map((p) => p.id).join(', ') + '') })
      .optional()
      .describe('Merged into the master motion blur (enabled, shutterAngle, shutterPhase, weighting, sampling, combine, strength, amount, maxSamples)'),
    soundMix: z
      .strictObject({
        volume: z.number().min(0).max(4).optional().describe('Master fader, 1 = 0 dB'),
        leveler: optionalFields(LevelerSchema).optional().describe('enabled, mode (category | all), strength 0..1, tameLoud, liftQuiet, evenSpeech'),
        loudness: optionalFields(LoudnessSchema).optional().describe('Loudness match: enabled, targetLufs (−30..−6, default −14); trims the whole mix to the target at export, capped so the limiter takes at most 6 dB'),
        limiter: optionalFields(LimiterSchema).optional().describe('enabled, ceilingDb (−12..0)'),
      })
      .optional()
      .describe("Merged into the frame's mix: master fader, leveler, loudness match and limiter (sound.category for the buses)"),
    ops: z.array(PatchOpSchema).min(1).optional().describe('Anything else on the frame, by path'),
  }),
  run: (input, ctx) => {
    const { id, motionBlur, soundMix, ops, scaleContents: scale, mode: modeInput, atMs, pageId, ...changes } = input
    const comp = findComp(ctx.project, id ?? ctx.view.compId)
    for (const op of ops ?? []) {
      const field = op.path.split(/[.[]/, 1)[0] ?? ''
      if (Object.hasOwn(GUARDED, field)) throw new CommandError('frame.update ops cannot change "' + field + '".', GUARDED[field])
    }
    let blur = comp.motionBlur
    if (motionBlur) {
      const { preset, ...fields } = motionBlur
      const base = preset === undefined ? comp.motionBlur : motionBlurPreset(preset)
      if (!base) throw new CommandError('No motion blur preset "' + preset + '".', 'Presets: ' + MOTION_BLUR_PRESETS.map((p) => p.id).join(', ') + '.')
      blur = { ...comp.motionBlur, ...base, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) }
    }
    if (pageId !== undefined && comp.embedded) throw new CommandError('"' + comp.name + '" is the inside of a nested layer: it is on no page.')
    const page = pageId === undefined ? undefined : findPage(ctx.project, pageId)

    let mode = comp.mode
    let stillMs = comp.stillMs
    if (modeInput !== undefined) mode = checkMode(modeInput)
    if (atMs !== undefined && mode !== 'static') throw new CommandError('atMs is the moment a static frame shows; "' + comp.name + '" is a timeline.', 'Pass mode: "static" with it to still the frame.')
    if (mode === 'static' && (atMs !== undefined || comp.mode !== 'static')) {
      const open = ctx.view.compId === comp.id ? ctx.view.playheadMs : undefined
      stillMs = atMs ?? (comp.mode === 'static' ? comp.stillMs : (open ?? comp.stillMs))
    }
    const durationMs = changes.durationMs ?? comp.durationMs
    if (mode === 'static' && stillMs > durationMs) throw new CommandError('The still at ' + Math.round(stillMs) + ' ms is past the frame end (' + Math.round(durationMs) + ' ms).', 'Pick a moment inside the frame, or lengthen it.')

    let patched: Comp | null = null
    if (ops) {
      const copy = deepClone(comp) as unknown as Record<string, unknown>
      applyPatchOps(copy, ops)
      patched = parseOrThrow(CompSchema, copy, 'The patched frame')
      const problem = worldStructureProblem(patched)
      if (problem?.includes('thickness')) {
        throw new CommandError('That would take the world off "' + comp.name + '", which still holds layers with thickness.', 'Remove extrude from those layers with layer.patch first.')
      }
      if (problem?.includes('material')) {
        throw new CommandError('That would take the world off "' + comp.name + '", which still holds layers with a material.', 'Remove the materials first: world.material with preset null.')
      }
      if (problem) {
        throw new CommandError('That would take the world off "' + comp.name + '", which still holds a camera, light or controller.', 'Cameras, lights and controllers stay in their 3D world: delete them first.')
      }
    }
    const ratioW = changes.width === undefined ? 1 : changes.width / comp.width
    const ratioH = changes.height === undefined ? 1 : changes.height / comp.height
    ctx.write('Edit frame', (draft) => {
      const target = findComp(draft, comp.id)
      if (patched) {
        // Patched fields only: tracks and the rest keep the draft's own.
        for (const [key, value] of Object.entries(patched)) if (!Object.hasOwn(GUARDED, key)) Object.assign(target, { [key]: value })
        if (!patched.world) delete target.world
      }
      for (const [key, value] of Object.entries(changes)) {
        if (value !== undefined) Object.assign(target, { [key]: value })
      }
      if (scale && (ratioW !== 1 || ratioH !== 1)) scaleContents(target, ratioW, ratioH)
      if (motionBlur) target.motionBlur = blur
      if (soundMix) {
        const given = <T extends object>(fields: T | undefined) => Object.fromEntries(Object.entries(fields ?? {}).filter(([, v]) => v !== undefined))
        if (soundMix.volume !== undefined) target.soundMix.volume = soundMix.volume
        Object.assign(target.soundMix.leveler, given(soundMix.leveler))
        Object.assign(target.soundMix.loudness, given(soundMix.loudness))
        Object.assign(target.soundMix.limiter, given(soundMix.limiter))
      }
      target.mode = mode
      target.stillMs = stillMs
      if (page) target.pageId = page.id
    })
    return { updated: comp.id, ...(mode !== comp.mode ? { mode } : {}), ...(mode === 'static' ? { stillMs } : {}) }
  },
})

/** What stops these frames from being deleted, or null: nested layers elsewhere show them, or nothing would be left. */
function deletionProblem(project: Project, doomed: ReadonlySet<string>): { message: string; hint: string } | null {
  const remaining = project.comps.filter((c) => !c.embedded && !doomed.has(c.id))
  if (remaining.length === 0) {
    return { message: 'A project keeps at least one frame.', hint: 'Create another frame first (frame.create).' }
  }
  for (const id of doomed) {
    const users = layersShowing(project, id).filter((l) => !project.comps.some((c) => doomed.has(c.id) && c.tracks.some((t) => t.layers.some((x) => x.id === l.id))))
    if (users.length > 0) {
      const comp = project.comps.find((c) => c.id === id)
      return {
        message: '"' + (comp?.name ?? id) + '" is shown inside ' + users.length + ' other layer' + (users.length === 1 ? '' : 's') + ': ' + users.map((l) => l.name).join(', ') + '.',
        hint: 'Delete those layers first, or make them unique (layers.makeUnique) so they keep their own copy.',
      }
    }
  }
  return null
}

/** Removes comps, then the embedded comps nobody shows any more. */
function removeComps(draft: Draft<Project>, ids: ReadonlySet<string>): void {
  draft.comps = draft.comps.filter((c) => !ids.has(c.id))
  for (let orphans = orphanedEmbeddedComps(draft as Project); orphans.length > 0; orphans = orphanedEmbeddedComps(draft as Project)) {
    const gone = new Set(orphans.map((c) => c.id))
    draft.comps = draft.comps.filter((c) => !gone.has(c.id))
  }
}

export const frameDelete = defineCommand({
  name: 'frame.delete',
  summary: 'Delete a frame and every layer in it.',
  details:
    'A project keeps at least one frame. A frame that other layers show (nested) cannot go until those layers do. The inside of a nested layer is deleted with its layer (layers.delete), not here. Embedded comps only this frame showed go with it.',
  effect: 'write',
  input: z.strictObject({ id: IdSchema }),
  run: ({ id }, ctx) => {
    const comp = findComp(ctx.project, id)
    if (comp.embedded) throw new CommandError('"' + comp.name + '" is the inside of a nested layer.', 'Delete that layer (layers.delete) and its comp goes with it.')
    const problem = deletionProblem(ctx.project, new Set([comp.id]))
    if (problem) throw new CommandError(problem.message, problem.hint)
    const layers = comp.tracks.reduce((n, t) => n + t.layers.length, 0)
    ctx.write('Delete frame', (draft) => removeComps(draft, new Set([comp.id])))
    return { deleted: comp.id, layers }
  },
})

/** A copy of a comp with fresh ids for the comp, its lanes and layers; embedded comps it owns are copied too and repointed. */
function copyComp(project: Project, source: Comp, ids: (prefix: string) => string, name: string, copies: Comp[]): Comp {
  const renamed = new Map<string, string>()
  const lanes: Track[] = copyLanes(source.tracks, ids as never, renamed).map((lane, i) => {
    const original = source.tracks[i] as Track
    const { name: _suffixed, ...rest } = lane
    const transitions = original.transitions.map((t) => ({ ...deepClone(t), id: ids('transition'), aLayerId: t.aLayerId === null ? null : (renamed.get(t.aLayerId) ?? t.aLayerId), bLayerId: t.bLayerId === null ? null : (renamed.get(t.bLayerId) ?? t.bLayerId) }))
    return { ...rest, ...(original.name === undefined ? {} : { name: original.name }), transitions, hidden: original.hidden, muted: original.muted, locked: original.locked }
  })
  const copy: Comp = { ...deepClone(source), id: ids('comp'), name, tracks: lanes, embedded: source.embedded }
  // A nested layer that owned its inside owns a copy of it now.
  for (const lane of copy.tracks) {
    for (const layer of lane.layers) {
      if (layer.kind !== 'nested') continue
      const inside = project.comps.find((c) => c.id === layer.sourceCompId)
      if (inside?.embedded) layer.sourceCompId = copyComp(project, inside, ids, inside.name, copies).id
    }
  }
  copies.push(copy)
  return copy
}

export const frameDuplicate = defineCommand({
  name: 'frame.duplicate',
  summary: 'Duplicate a frame with everything in it, on the same page or another. Returns the new frame id.',
  details:
    'The copy is independent: its layers are new (layers.list reads their ids). What a nested layer owns is copied with it; a comp that other layers also show stays shared. Transitions come along.',
  effect: 'write',
  input: z.strictObject({
    id: IdSchema,
    name: z.string().min(1).optional(),
    pageId: z.string().min(1).optional().describe('A page id or name; default the page of the frame'),
  }),
  run: ({ id, name, pageId }, ctx) => {
    const source = findComp(ctx.project, id)
    if (source.embedded) throw new CommandError('"' + source.name + '" is the inside of a nested layer.', 'layers.duplicate copies the layer with its inside.')
    const page = pageId === undefined ? pageOf(ctx.project, source) : findPage(ctx.project, pageId)
    const copies: Comp[] = []
    const copy = copyComp(ctx.project, source, ctx.ids as never, name ?? source.name + ' copy', copies)
    copy.pageId = page?.id ?? null
    ctx.write('Duplicate frame', (draft) => {
      // The copy sits right after its source; what it owns follows.
      const at = draft.comps.findIndex((c) => c.id === source.id)
      draft.comps.splice(at + 1, 0, ...(copies.filter((c) => c.id !== copy.id) as Draft<Comp>[]), copy as Draft<Comp>)
    })
    return { id: copy.id, pageId: copy.pageId, layers: copy.tracks.reduce((n, t) => n + t.layers.length, 0) }
  },
})

// ---- Pages ---------------------------------------------------------------

const pageName = (project: Project, name: string, except?: string) => {
  const taken = project.pages.find((p) => p.id !== except && p.name.toLowerCase() === name.trim().toLowerCase())
  if (taken) throw new CommandError('A page named "' + taken.name + '" exists.', 'Page names are unique: pick another, or use that page (' + taken.id + ').')
  return name.trim()
}

export const pageCreate = defineCommand({
  name: 'page.create',
  summary: 'Add a page, a place for frames, optionally moving frames onto it.',
  details: 'Pages keep a project readable: scenes on one, deliverables (master, reel, cutdowns) on another. frameIds are frames (ids or names) to move onto the new page. Returns the page id.',
  effect: 'write',
  input: z.strictObject({
    name: z.string().trim().min(1),
    frameIds: z.array(z.string().min(1)).optional().describe('Frames to move onto the new page'),
  }),
  run: ({ name, frameIds }, ctx) => {
    const clean = pageName(ctx.project, name)
    const moving = (frameIds ?? []).map((ref) => findComp(ctx.project, ref))
    const embedded = moving.find((c) => c.embedded)
    if (embedded) throw new CommandError('"' + embedded.name + '" is the inside of a nested layer: it is on no page.')
    const page: Page = { id: ctx.ids('page'), name: clean }
    ctx.write('Create page', (draft) => {
      draft.pages.push(page)
      for (const comp of moving) findComp(draft, comp.id).pageId = page.id
    })
    return { id: page.id, frames: moving.map((c) => c.id) }
  },
})

export const pageUpdate = defineCommand({
  name: 'page.update',
  summary: 'Rename a page, or move it in the page list.',
  effect: 'write',
  input: z.strictObject({
    id: z.string().min(1).describe('A page id or name'),
    name: z.string().trim().min(1).optional(),
    index: z.number().int().min(0).optional().describe('Its new position in the page list (0 is first)'),
  }),
  run: ({ id, name, index }, ctx) => {
    const page = findPage(ctx.project, id)
    if (name === undefined && index === undefined) throw new CommandError('Say what to change: name, or index.')
    const clean = name === undefined ? undefined : pageName(ctx.project, name, page.id)
    ctx.write('Edit page', (draft) => {
      const at = draft.pages.findIndex((p) => p.id === page.id)
      const target = draft.pages[at] as Draft<Page>
      if (clean !== undefined) target.name = clean
      if (index !== undefined) {
        draft.pages.splice(at, 1)
        draft.pages.splice(Math.min(index, draft.pages.length), 0, target)
      }
    })
    return { updated: page.id }
  },
})

export const pageDelete = defineCommand({
  name: 'page.delete',
  summary: 'Delete a page. A page that still holds frames needs moveTo (another page) or comps: "delete"; the last page stays.',
  effect: 'write',
  input: z.strictObject({
    id: z.string().min(1).describe('A page id or name'),
    moveTo: z.string().min(1).optional().describe('Move its frames to this page first'),
    comps: z.enum(['keep', 'delete']).default('keep').describe('delete: its frames go with it'),
  }),
  run: ({ id, moveTo, comps }, ctx) => {
    const page = findPage(ctx.project, id)
    if (ctx.project.pages.length === 1) throw new CommandError('The last page stays.', 'Rename it instead (page.update).')
    const held = compsOnPage(ctx.project, page)
    const target = moveTo === undefined ? undefined : findPage(ctx.project, moveTo)
    if (target?.id === page.id) throw new CommandError('moveTo is the page being deleted.')
    if (held.length > 0 && !target && comps !== 'delete') {
      throw new CommandError('Page "' + page.name + '" still holds ' + held.length + ' frame' + (held.length === 1 ? '' : 's') + ': ' + held.map((c) => c.name).join(', ') + '.', 'Pass moveTo (another page), or comps: "delete" to delete them too.')
    }
    const doomed = new Set(!target && comps === 'delete' ? held.map((c) => c.id) : [])
    if (doomed.size > 0) {
      const problem = deletionProblem(ctx.project, doomed)
      if (problem) throw new CommandError(problem.message, problem.hint)
    }
    ctx.write('Delete page', (draft) => {
      if (target) for (const comp of held) findComp(draft, comp.id).pageId = target.id
      if (doomed.size > 0) removeComps(draft, doomed)
      draft.pages = draft.pages.filter((p) => p.id !== page.id)
    })
    return { deleted: page.id, ...(target ? { moved: held.map((c) => c.id), to: target.id } : {}), ...(doomed.size > 0 ? { deletedFrames: [...doomed] } : {}) }
  },
})

