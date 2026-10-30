import { type Draft, produce } from 'immer'
import { z } from 'zod'
import { type Box, detectCharacter, type Detection, isPlainGroup, layerBox, type Part, pathPieces, piecesInside } from '../characterDetect'
import { looseName } from '../characters'
import { locateLayer } from '../doc'
import { CommandError } from '../errors'
import { groupMembers } from '../groups'
import { type CommandContext, defineCommand } from '../registry'
import type { Behavior, Comp, GroupLayer, Layer, PathLayer, Project } from '../schema'
import { IdSchema } from '../schema'
import { formatSvgPath, parseSvgPath, svgPathBounds } from '../svgPath'
import { type PlanStep, planToScript } from '../script/plan'

// The two character verbs: `character.detect` reads a drawing and says which
// layers are its head, eyes, mouth and so on; `character.bringToLife` makes it
// blink, breathe, nod and talk with the commands that already exist (all in
// one undo step), after splitting a one-path face into its features.

const OverridesSchema = z
  .record(z.string(), z.string().min(1).nullable())
  .describe('Pin a part to a layer (id or name) or rule it out with null, e.g. {"mouth": "Lips", "eye.L": null}. Parts: head, face, hair, brow.L, brow.R, eye.L, eye.R, lid.L, lid.R, pupil.L, pupil.R, nose, mouth, neck, torso, hips, arm.L … foot.R, accessory')

const LIFE_KEYS = ['blink', 'breathe', 'nod', 'talk', 'look'] as const
type LifeKey = (typeof LIFE_KEYS)[number]
type Life = Record<LifeKey, string>

const BEHAVIOR_OF: Record<LifeKey, Behavior['type']> = { blink: 'blink', breathe: 'breathe', nod: 'nod', talk: 'talk', look: 'glance' }

const NO_VOICE = 'No voice: add a voice line to talk'
const DARK = '#1F1A17'

interface Step {
  call: string
  input: unknown
}

const reportPart = (p: Part) => ({ role: p.role, id: p.id, name: p.name, confidence: p.confidence, reason: p.reason })

/** The voice a character talks to: an audio or video layer of the comp that plays while the character shows, front-most first. */
function findVoice(comp: Comp, root: Layer): Layer | undefined {
  const end = root.startMs + root.durationMs
  for (const track of comp.tracks) {
    for (const l of track.layers) {
      if ((l.kind === 'audio' || l.kind === 'video') && l.startMs < end && l.startMs + l.durationMs > root.startMs) return l
    }
  }
  return undefined
}

function behaviorsOf(layer: Layer): readonly Behavior[] {
  return layer.kind === 'group' ? layer.behaviors : []
}

/** What each life function can do now: on, off, can, or why not. */
function lifeOf(project: Project, comp: Comp, root: Layer, det: Detection, reasons: Partial<Life> = {}, wanted: Partial<Record<LifeKey, boolean>> = {}): Life {
  const present = behaviorsOf(root)
  const hasPart = (re: RegExp) => det.parts.some((p) => re.test(p.role))
  const voice = findVoice(comp, root)
  void project
  const can = (key: LifeKey, why: string | true): string => {
    const b = present.find((x) => x.type === BEHAVIOR_OF[key])
    if (b) return b.enabled ? 'on' : 'off'
    if (reasons[key]) return reasons[key] as string
    if (wanted[key] === false) return 'off'
    return why === true ? 'can' : why
  }
  const talkWhy = voice === undefined ? NO_VOICE : hasPart(/^mouth$/) || hasPart(/^(face|head)$/) ? true : 'No mouth found'
  const talkOn = present.some((b) => b.type === 'talk' && b.enabled)
  return {
    blink: can('blink', hasPart(/^eye\./) ? true : det.pieces !== undefined ? 'No eyes found (the face is one drawing: bringToLife splits it first)' : 'No eyes found'),
    breathe: can('breathe', true),
    nod: can('nod', talkOn || talkWhy === true ? true : 'Nods with a voice'),
    talk: can('talk', talkWhy),
    look: can('look', hasPart(/^pupil\./) || hasPart(/^eye\./) ? true : 'No pupils found'),
  }
}

export const characterDetect = defineCommand({
  name: 'character.detect',
  summary: 'Find the parts of a character (head, face, eyes, brows, mouth, torso, limbs …) in a group or a picture, and what can be brought to life.',
  details:
    'id is the character: a group (layers at any depth count) or one layer. Parts are found by name (in many languages, with L and R sides, the character\'s own left), by the drawings of a switch (mouth shapes, open and closed eyes) and by where flat pieces sit (two small pieces high in a big one are eyes). Each part has a confidence (evidence combined, under 0.3 dropped) and the reason. overrides pins a part to a layer or rules it out (null). figure is "body" when a torso or limbs are found, else "face". life says per function (blink, breathe, nod, talk, look) "on" (a behaviour exists), "off", "can" (bringToLife can add it) or why it cannot. pieces is set when the face is one path of many outlines, which bringToLife splits. Returns {figure, parts: [{role, id, name, confidence, reason}], pieces?, life}.',
  effect: 'read',
  input: z.strictObject({
    id: IdSchema.describe('The character: a group, or one layer'),
    overrides: OverridesSchema.optional(),
  }),
  run: ({ id, overrides }, ctx) => {
    const { comp, layer } = locateLayer(ctx.project, id)
    const det = detectCharacter(ctx.project, comp, layer, overrides ?? {})
    return { figure: det.figure, parts: det.parts.map(reportPart), ...(det.pieces !== undefined ? { pieces: det.pieces } : {}), life: lifeOf(ctx.project, comp, layer, det) }
  },
})

// ------------------------------------------------------------ drawing helpers

const K = 0.5522847498
const n = (v: number) => Math.round(v * 100) / 100

const ellipsePath = (rx: number, ry: number) =>
  `M ${n(-rx)} 0 C ${n(-rx)} ${n(-K * ry)} ${n(-K * rx)} ${n(-ry)} 0 ${n(-ry)} C ${n(K * rx)} ${n(-ry)} ${n(rx)} ${n(-K * ry)} ${n(rx)} 0 C ${n(rx)} ${n(K * ry)} ${n(K * rx)} ${n(ry)} 0 ${n(ry)} C ${n(-K * rx)} ${n(ry)} ${n(-rx)} ${n(K * ry)} ${n(-rx)} 0 Z`

function capsulePath(w: number, h: number): string {
  const r = h / 2
  const a = w / 2 - r
  return `M ${n(-a)} ${n(-r)} L ${n(a)} ${n(-r)} C ${n(a + K * r)} ${n(-r)} ${n(a + r)} ${n(-K * r)} ${n(a + r)} 0 C ${n(a + r)} ${n(K * r)} ${n(a + K * r)} ${n(r)} ${n(a)} ${n(r)} L ${n(-a)} ${n(r)} C ${n(-a - K * r)} ${n(r)} ${n(-a - r)} ${n(K * r)} ${n(-a - r)} 0 C ${n(-a - r)} ${n(-K * r)} ${n(-a - K * r)} ${n(-r)} ${n(-a)} ${n(-r)} Z`
}

/** A wide flat lens: two arcs from corner to corner. */
const lensPath = (w: number, h: number) => `M ${n(-w / 2)} 0 Q 0 ${n(-h)} ${n(w / 2)} 0 Q 0 ${n(h)} ${n(-w / 2)} 0 Z`

/** An open mouth: a flat top and a round bottom (a D on its side). */
function dPath(w: number, h: number): string {
  const rx = w / 2
  return `M ${n(-rx)} ${n(-h / 2)} L ${n(rx)} ${n(-h / 2)} C ${n(rx)} ${n(-h / 2 + K * h)} ${n(K * rx)} ${n(h / 2)} 0 ${n(h / 2)} C ${n(-K * rx)} ${n(h / 2)} ${n(-rx)} ${n(-h / 2 + K * h)} ${n(-rx)} ${n(-h / 2)} Z`
}

const smilePath = (w: number) => `M ${n(-w / 2)} ${n(-0.09 * w)} Q 0 ${n(0.26 * w)} ${n(w / 2)} ${n(-0.09 * w)}`

/** Rough brightness of a hex colour, 0 to 1. */
function luma(hex: string): number {
  const v = Number.parseInt(hex.slice(1, 7), 16)
  return Number.isFinite(v) ? (0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255)) / 255 : 1
}

/** The colour a drawing is inked in: its first fill (a gradient's darkest stop), else its first solid stroke, else dark. */
function inkOf(project: Project, comp: Comp, layer: Layer): string {
  const leaves = layer.kind === 'group' ? groupMembers(comp, layer.id) : [layer]
  for (const l of leaves) {
    if (l.kind === 'group') continue
    if (l.kind !== 'path' && l.kind !== 'shape') continue
    const fill = l.fills.find((f) => f.enabled)
    if (fill?.type === 'solid') return fill.color
    // A gradient mouth: its darkest stop reads as the inside of the mouth.
    if (fill) return [...fill.stops].sort((a, b) => luma(a.color) - luma(b.color))[0]?.color ?? DARK
    const stroke = l.strokes.find((s) => s.enabled && s.paint.type === 'solid')
    if (stroke?.paint.type === 'solid') return stroke.paint.color
  }
  void project
  return DARK
}

/** Strings over 120 characters (path data) are cut to their first 60 and an ellipsis, so a plan stays readable. */
const shorten = (value: unknown): unknown => {
  if (typeof value === 'string') return value.length > 120 ? `${value.slice(0, 60)}…` : value
  if (Array.isArray(value)) return value.map(shorten)
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shorten(v)]))
  return value
}

const stripIds = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripIds)
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'id').map(([k, v]) => [k, stripIds(v)]))
  return value
}

/** A context that edits a private copy of the project, so a dry run can plan for real and leave the real project alone. */
function scratchContext(base: CommandContext): CommandContext {
  let state = base.project
  const ctx: CommandContext = {
    get project() {
      return state
    },
    write(_label, recipe) {
      state = produce(state, recipe as (draft: Draft<Project>) => void)
    },
    async call(name, input = {}) {
      const before = state
      const result = await base.registry.run(name, input, ctx)
      if (!result.ok) state = before
      return result
    },
    registry: base.registry,
    ids: base.ids,
    get view() {
      return base.view
    },
    get measure() {
      return base.measure
    },
    get silhouette() {
      return base.silhouette
    },
    get envelope() {
      return base.envelope
    },
  }
  return ctx
}

const boneRe = { body: /^(chest|torso|spine|body)/i, head: /^(head|neck)$/i }

const InputSchema = z.strictObject({
  id: IdSchema.describe('The character: a group, or one picture or drawing (it is put in a group named "Character")'),
  blink: z.boolean().optional().describe('Eyes blink (default true when eyes are found); false removes it'),
  breathe: z.boolean().optional().describe('The body swells and settles (default true); false removes it'),
  nod: z.boolean().optional().describe('The head nods with the voice (default true with talk); false removes it'),
  talk: z.boolean().optional().describe('The mouth follows the voice (default true when there is a voice); false removes it'),
  look: z.boolean().optional().describe('The pupils glance about (default false)'),
  blinkEvery: z.number().min(0.5).max(30).optional().describe('Seconds between blinks, on average; default 4'),
  voice: z.string().min(1).nullable().optional().describe('The audio or video layer to talk to; left out, the front-most one that plays while the character shows'),
  overrides: OverridesSchema.optional(),
  dryRun: z.boolean().optional().describe('Return the plan and write nothing'),
})

type Input = z.output<typeof InputSchema>

export const characterBringToLife = defineCommand({
  name: 'character.bringToLife',
  summary: 'Bring a character to life: blink, breathe, nod and talk, and a body and head rig to carry them. One undo step; a second run adds nothing.',
  details:
    'id is a group (a character with its parts inside) or one layer, which is wrapped in a group named "Character". A face drawn as one path with many outlines (an Open Peeps face) is split into a layer for each feature, named after its part (eye.L, mouth …), inside a group "face". Then: talk (needs a voice: voice, or the front-most audio or video layer that plays while the character shows; makes a "Mouth" switch with shapes X MBP E AI O U from the mouth if it is not one, reads the voice\'s loudness, adds a talk behaviour), a rig (Body and Head bones for a figure, one Head bone for a face or picture) with the head and torso bound to their bones, blink (both eyes together, every blinkEvery s), breathe (the Body bone, else the whole character), nod (the Head bone, with the voice; only with talk), look (glance on the pupils; only when look is true). A function that is already on is left alone; one given false is removed. overrides pins a part as in character.detect. dryRun returns steps (the commands it would run, "<name>" standing for layers it would make) and script (the same plan as ac.* code: script.run {code: script} runs it as one undo step) and writes nothing. Returns {characterId, figure, parts, life, steps}; life says per function on, off, can or why not ("No eyes found", "No mouth found", "No voice: add a voice line to talk").',
  effect: 'write',
  input: InputSchema,
  run: async (input, ctx) => {
    if (!input.dryRun) return execute(input, ctx, false)
    const scratch = scratchContext(ctx)
    const out = await execute(input, scratch, true)
    // Ids of what the plan would make stand as "<name>".
    const before = new Set<string>()
    const mark = (p: Project, into: Set<string>) => {
      for (const comp of p.comps) {
        for (const track of comp.tracks) {
          for (const l of track.layers) {
            into.add(l.id)
            if (l.kind === 'group') {
              for (const b of l.rig?.bones ?? []) into.add(b.id)
              for (const b of l.behaviors) into.add(b.id)
            }
          }
        }
      }
    }
    mark(ctx.project, before)
    const names = new Map<string, string>()
    for (const comp of scratch.project.comps) {
      for (const track of comp.tracks) {
        for (const l of track.layers) {
          if (!before.has(l.id)) names.set(l.id, `<${l.name}>`)
          if (l.kind === 'group') {
            for (const b of l.rig?.bones ?? []) if (!before.has(b.id)) names.set(b.id, `<${b.name}>`)
            for (const b of l.behaviors) if (!before.has(b.id)) names.set(b.id, `<${b.type}>`)
          }
        }
      }
    }
    const swap = (value: unknown): unknown => {
      if (typeof value === 'string') return names.get(value) ?? value
      if (Array.isArray(value)) return value.map(swap)
      if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, swap(v)]))
      return value
    }
    const { plan, ...rest } = out
    const script = planToScript(plan ?? [], new Set(names.keys()), `character.bringToLife plan, as code: script.run {code} does the same in one undo step.
Edit it to change a part, a bone or a behaviour before running.`)
    return { ...(swap({ ...rest, dryRun: true }) as object), script }
  },
})

// ------------------------------------------------------------------- the plan

/** The member of the character (a direct child) that holds a layer. */
function memberOf(ctx: CommandContext, rootId: string, layerId: string): Layer | undefined {
  let at = layerId
  for (let guard = 0; guard < 50; guard++) {
    const loc = locateLayer(ctx.project, at)
    if (loc.track.groupId === rootId) return loc.layer
    if (loc.track.groupId === null) return undefined
    at = loc.track.groupId
  }
  return undefined
}

async function execute(input: Input, ctx: CommandContext, dry: boolean) {
  const steps: Step[] = []
  const full: PlanStep[] = []
  const run = async (name: string, args: Record<string, unknown>) => {
    steps.push({ call: name, input: args })
    const result = await ctx.call(name, args)
    if (!result.ok) throw new CommandError(`${name}: ${result.error}`, result.hint)
    full.push({ call: name, input: args, result: result.value })
    return result.value as Record<string, unknown> & { id?: string; groupId?: string }
  }
  const rename = (id: string, name: string) => run('layer.patch', { id, ops: [{ op: 'set', path: 'name', value: name }] })

  const want = { blink: input.blink ?? true, breathe: input.breathe ?? true, nod: input.nod ?? true, talk: input.talk ?? true, look: input.look ?? false }
  const reasons: Partial<Life> = {}

  // a. the character is a group
  const first = locateLayer(ctx.project, input.id).layer
  let rootId = first.id
  if (first.kind !== 'group') rootId = (await run('layers.group', { ids: [rootId], name: 'Character' })).groupId as string
  const state = () => {
    const loc = locateLayer(ctx.project, rootId)
    return { comp: loc.comp, root: loc.layer as GroupLayer }
  }
  const detect = () => {
    const { comp, root } = state()
    return detectCharacter(ctx.project, comp, root, input.overrides ?? {})
  }
  const present = (type: Behavior['type']) => state().root.behaviors.filter((b) => b.type === type)
  const partOf = (det: Detection, re: RegExp) => det.parts.find((p) => re.test(p.role))
  let det = detect()

  // b. a one-path face becomes its features
  if ((want.blink || want.talk || want.look) && det.facePath && !det.parts.some((p) => p.role.startsWith('eye'))) {
    const split = await splitFace(ctx, run, state().comp, det.facePath, rootId)
    if (split.length > 0) {
      det = detect()
      for (const p of det.parts) {
        if (split.includes(p.id) && p.name !== p.role) await rename(p.id, p.role)
      }
      det = detect()
    }
  }

  // b2. outlines joined because they are painted alike (both eyes in one path) become layers of their own, unless eyes are known by name
  if ((want.blink || want.talk || want.look) && !det.parts.some((p) => p.role.startsWith('eye') && p.confidence >= 0.6)) {
    let split = false
    for (const path of pathsUnder(state().comp, state().root)) {
      if (await splitMerged(ctx, run, state().comp, path)) split = true
    }
    if (split) det = detect()
  }

  // c. talk
  const voiceRef = input.voice
  const { comp: compNow, root: rootNow } = state()
  let voice: Layer | undefined
  if (typeof voiceRef === 'string') {
    const all = compNow.tracks.flatMap((t) => t.layers)
    voice = all.find((l) => l.id === voiceRef) ?? all.find((l) => l.name === voiceRef)
    if (!voice || (voice.kind !== 'audio' && voice.kind !== 'video')) throw new CommandError(`The voice "${voiceRef}" is not an audio or video layer of this comp.`, 'voice is an audio or video layer, or leave it out to use the front-most one.')
  } else voice = findVoice(compNow, rootNow)
  const talkVoiceId: string | null = typeof voiceRef === 'string' ? (voice as Layer).id : voiceRef === null ? null : (voice?.id ?? null)

  if (!want.talk) {
    for (const b of present('talk')) await run('behaviors.remove', { groupId: rootId, id: b.id })
  } else if (present('talk').length === 0) {
    if (!voice) reasons.talk = NO_VOICE
    else {
      const media = ctx.project.media.find((m) => m.id === (voice as Layer & { mediaId: string }).mediaId)
      let traced: { rate: number; values: number[] } | undefined
      if (media?.envelope) traced = media.envelope
      else if (!ctx.envelope) reasons.talk = 'Cannot read the voice here'
      else if (dry) traced = { rate: 50, values: [] }
      else traced = await ctx.envelope(media as NonNullable<typeof media>)
      if (!reasons.talk && !traced) reasons.talk = 'Cannot read the voice here'
      if (!reasons.talk) {
        const mouthId = await ensureMouth(ctx, run, rename, det, rootId)
        if (!mouthId) reasons.talk = 'No mouth found'
        else {
          if (media && !media.envelope && traced) {
            const envelope = { rate: traced.rate, values: traced.values }
            steps.push({ call: 'media.envelope', input: { mediaId: media.id, rate: envelope.rate, samples: envelope.values.length } })
            full.push({ call: 'media.envelope', input: { mediaId: media.id } })
            ctx.write('Read voice loudness', (draft) => {
              const target = draft.media.find((m) => m.id === media.id)
              if (target) target.envelope = envelope
            })
          }
          await run('behaviors.add', { groupId: rootId, type: 'talk', fields: { mouth: mouthId, voice: talkVoiceId } })
          det = detect()
        }
      }
    }
  }
  const talkOn = present('talk').length > 0
  const talkVoice = present('talk')[0]?.type === 'talk' ? (present('talk')[0] as Extract<Behavior, { type: 'talk' }>).voice : talkVoiceId

  // d. a rig to carry them
  const needsBones = (want.breathe && present('breathe').length === 0) || (want.nod && talkOn && present('nod').length === 0)
  if (needsBones && !state().root.rig) {
    const { comp, root } = state()
    const rootBox = det.rootBox ?? layerBox(ctx.project, comp, root)
    const head = partOf(det, /^head$/) ?? partOf(det, /^face$/)
    const torso = partOf(det, /^torso$/)
    const bodyBones =
      det.figure === 'body' && head?.box && torso?.box && torso.box.top + torso.box.height > head.box.top + head.box.height + 1
        ? ([
            { name: 'Body', head: [n(torso.box.left + torso.box.width / 2), n(torso.box.top + torso.box.height)], tail: [n(head.box.left + head.box.width / 2), n(head.box.top + head.box.height)] },
            { name: 'Head', head: [n(head.box.left + head.box.width / 2), n(head.box.top + head.box.height)], tail: [n(head.box.left + head.box.width / 2), n(head.box.top)], parent: 'Body' },
          ] as const)
        : undefined
    if (bodyBones) {
      await run('rig.create', { id: rootId, bones: bodyBones })
      const headMember = head ? memberOf(ctx, rootId, head.id) : undefined
      const torsoMember = torso ? memberOf(ctx, rootId, torso.id) : undefined
      if (headMember && torsoMember && headMember.id !== torsoMember.id) {
        await run('rig.bind', { ids: headMember.id, mode: 'rigid', bone: 'Head' })
        await run('rig.bind', { ids: torsoMember.id, mode: 'rigid', bone: 'Body' })
      }
    } else if (rootBox && rootBox.height > 0) {
      const midX = n(rootBox.left + rootBox.width / 2)
      await run('rig.create', { id: rootId, bones: [{ name: 'Head', head: [midX, n(rootBox.top + rootBox.height)], tail: [midX, n(rootBox.top)] }] })
    }
  }

  // e. blink: an eye drawn in pieces (white, pupil, highlight) is grouped, so it squashes whole
  let savedPupils = det.parts.filter((p) => p.role.startsWith('pupil.'))
  if (want.blink && present('blink').length === 0 && det.parts.some((p) => p.role.startsWith('eye.'))) {
    const { comp, root } = state()
    const skip = new Set(det.parts.filter((p) => !p.role.startsWith('pupil.')).map((p) => p.id))
    let grouped = false
    for (const eye of det.parts.filter((p) => p.role.startsWith('eye.'))) {
      if (eye.layer.kind === 'group' || !eye.box) continue
      const parentId = locateLayer(ctx.project, eye.id).track.groupId
      const pieces = piecesInside(ctx.project, comp, root, eye.box, skip, 0.8).filter((l) => l.id !== eye.id && locateLayer(ctx.project, l.id).track.groupId === parentId)
      if (pieces.length === 0) continue
      await run('layers.group', { ids: [eye.id, ...pieces.map((l) => l.id)], name: eye.role })
      grouped = true
    }
    if (grouped) det = detect()
  }
  if (savedPupils.length > 0 && det.parts.some((p) => p.role.startsWith('pupil.'))) savedPupils = []
  const eyes = det.parts.filter((p) => p.role.startsWith('eye.'))
  if (!want.blink) {
    for (const b of present('blink')) await run('behaviors.remove', { groupId: rootId, id: b.id })
  } else if (present('blink').length === 0) {
    if (eyes.length === 0) reasons.blink = 'No eyes found'
    else await run('behaviors.add', { groupId: rootId, type: 'blink', fields: { eyes: eyes.map((e) => e.id), every: input.blinkEvery ?? 4 } })
  }

  // f. breathe
  if (!want.breathe) {
    for (const b of present('breathe')) await run('behaviors.remove', { groupId: rootId, id: b.id })
  } else if (present('breathe').length === 0) {
    const bone = state().root.rig?.bones.find((b) => boneRe.body.test(b.name))
    await run('behaviors.add', { groupId: rootId, type: 'breathe', fields: bone ? { bone: bone.id } : { layer: rootId } })
  }

  // g. nod
  if (!want.nod) {
    for (const b of present('nod')) await run('behaviors.remove', { groupId: rootId, id: b.id })
  } else if (present('nod').length === 0) {
    if (!talkOn) reasons.nod = 'Nods with a voice'
    else {
      const bone = state().root.rig?.bones.find((b) => boneRe.head.test(b.name))
      const head = partOf(det, /^head$/)
      if (bone) await run('behaviors.add', { groupId: rootId, type: 'nod', fields: { bone: bone.id, voice: talkVoice } })
      else if (head?.layer.kind === 'group') await run('behaviors.add', { groupId: rootId, type: 'nod', fields: { layer: head.id, voice: talkVoice } })
      else if (det.figure === 'face') await run('behaviors.add', { groupId: rootId, type: 'nod', fields: { layer: rootId, voice: talkVoice } })
      else reasons.nod = head ? 'Group the head with its face to nod' : 'No head found'
    }
  }

  // h. look
  if (!want.look) {
    for (const b of present('glance')) await run('behaviors.remove', { groupId: rootId, id: b.id })
  } else if (present('glance').length === 0) {
    const pupils = det.parts.filter((p) => p.role.startsWith('pupil.'))
    if (pupils.length === 0) pupils.push(...savedPupils)
    const targets = pupils.length > 0 ? pupils : eyes
    if (targets.length === 0) reasons.look = 'No pupils found'
    else {
      const eye = (eyes[0] ?? targets[0])?.box
      await run('behaviors.add', {
        groupId: rootId,
        type: 'glance',
        fields: { layers: targets.map((t) => t.id), ...(eye ? { rangeX: n(0.25 * eye.width), rangeY: n(0.15 * eye.height) } : {}) },
      })
    }
  }

  det = detect()
  const { comp, root } = state()
  return {
    characterId: rootId,
    figure: det.figure,
    parts: det.parts.map(reportPart),
    ...(det.pieces !== undefined ? { pieces: det.pieces } : {}),
    life: lifeOf(ctx.project, comp, root, det, reasons, want),
    steps: shorten(steps) as Step[],
    ...(dry ? { plan: full } : {}),
  }
}

type Run = (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown> & { id?: string; groupId?: string }>

/** A path's fills for one piece of it: gradient points are fractions of the layer's box, so they move to the piece's box. */
function pieceFills(path: PathLayer, total: Box, piece: Box): unknown {
  const stripped = stripIds(path.fills) as Record<string, unknown>[]
  const fx = (v: number) => (piece.width > 0 ? (v * total.width + total.left - piece.left) / piece.width : v)
  const fy = (v: number) => (piece.height > 0 ? (v * total.height + total.top - piece.top) / piece.height : v)
  return stripped.map((paint) => {
    const { start, end } = paint as { start?: { x: number; y: number }; end?: { x: number; y: number } }
    if (!start || !end) return paint
    return { ...paint, start: { x: fx(start.x), y: fy(start.y) }, end: { x: fx(end.x), y: fy(end.y) } }
  })
}

/** The path layers under a group, through plain groups (not into switches). */
function pathsUnder(comp: Comp, root: GroupLayer): PathLayer[] {
  const out: PathLayer[] = []
  const walk = (group: GroupLayer) => {
    for (const m of groupMembers(comp, group.id)) {
      if (m.kind === 'path') out.push(m)
      else if (m.kind === 'group' && m.switch === null) walk(m)
    }
  }
  walk(root)
  return out
}

/**
 * Splits a path of several separate outlines (two eyes joined because they are
 * painted alike) into a layer for each, in the same group and place in the
 * stack, then removes it. False when it is one outline or cannot be split in
 * place (rotated, flipped, animated).
 */
async function splitMerged(ctx: CommandContext, run: Run, comp: Comp, path: PathLayer): Promise<boolean> {
  const t = path.transform
  if (Math.abs(t.rotation) > 0.01 || t.scaleX <= 0 || t.scaleY <= 0 || Object.keys(path.animations).length > 0) return false
  let pieces: ReturnType<typeof pathPieces>
  let total: Box
  try {
    pieces = pathPieces(path.geometry)
    total = svgPathBounds(parseSvgPath(path.geometry))
  } catch {
    return false
  }
  const whole = layerBox(ctx.project, comp, path)
  const parentId = locateLayer(ctx.project, path.id).track.groupId
  if (pieces.length < 2 || !whole || parentId === null) return false
  const made: string[] = []
  for (const [i, piece] of pieces.entries()) {
    const created = await run('layer.create', {
      kind: 'path',
      compId: comp.id,
      name: `${path.name} ${i + 1}`,
      d: formatSvgPath(piece.commands),
      fillRule: path.fillRule,
      fills: pieceFills(path, total, piece.box),
      strokes: stripIds(path.strokes),
      x: n(whole.left + (piece.box.left + piece.box.width / 2 - total.left) * t.scaleX),
      y: n(whole.top + (piece.box.top + piece.box.height / 2 - total.top) * t.scaleY),
      startMs: path.startMs,
      durationMs: path.durationMs,
      transform: { scaleX: t.scaleX, scaleY: t.scaleY, opacity: t.opacity },
      groupId: parentId,
    })
    made.push(created.id as string)
  }
  await run('layers.restack', { ids: made, to: { above: path.id } })
  await run('layers.delete', { ids: [path.id] })
  return true
}

/**
 * Splits the one path that draws a face into a layer for each piece, same
 * paints, each centred where its piece was. Returns the ids of the pieces, or
 * none when the path cannot be split in place (rotated, flipped, animated).
 */
async function splitFace(ctx: CommandContext, run: Run, comp: Comp, path: PathLayer, rootId: string): Promise<string[]> {
  const t = path.transform
  if (Math.abs(t.rotation) > 0.01 || t.scaleX <= 0 || t.scaleY <= 0 || Object.keys(path.animations).length > 0) return []
  const whole = layerBox(ctx.project, comp, path)
  if (!whole) return []
  const pieces = pathPieces(path.geometry)
  const total = svgPathBounds(parseSvgPath(path.geometry))
  const loc = locateLayer(ctx.project, path.id)
  const parentId = loc.track.groupId
  const parent = parentId === null ? undefined : (locateLayer(ctx.project, parentId).layer as GroupLayer)
  const soleChild = parent !== undefined && parent.id !== rootId && isPlainGroup(parent) && groupMembers(comp, parent.id).length === 1
  const made: string[] = []
  for (const [i, piece] of pieces.entries()) {
    const px = piece.box.left + piece.box.width / 2
    const py = piece.box.top + piece.box.height / 2
    const created = await run('layer.create', {
      kind: 'path',
      compId: comp.id,
      name: `${path.name} ${i + 1}`,
      d: formatSvgPath(piece.commands),
      fillRule: path.fillRule,
      fills: pieceFills(path, total, piece.box),
      strokes: stripIds(path.strokes),
      x: n(whole.left + (px - total.left) * t.scaleX),
      y: n(whole.top + (py - total.top) * t.scaleY),
      startMs: path.startMs,
      durationMs: path.durationMs,
      transform: { scaleX: t.scaleX, scaleY: t.scaleY, opacity: t.opacity },
      ...(soleChild ? { groupId: parent.id } : {}),
    })
    made.push(created.id as string)
  }
  if (!soleChild) {
    const grouped = await run('layers.group', { ids: made, name: 'face' })
    await run('layers.restack', { ids: [grouped.groupId as string], to: { above: path.id } })
  }
  await run('layers.delete', { ids: [path.id] })
  return made
}

/**
 * The mouth as a switch of shapes, for talk: the layer the character has for a
 * mouth becomes the rest drawing X, with shapes MBP, E, AI, O and U drawn
 * beside it. With no mouth, a small smile is drawn low in the face. Returns
 * the switch's id, or undefined when there is nowhere to put a mouth.
 */
async function ensureMouth(ctx: CommandContext, run: Run, rename: (id: string, name: string) => Promise<unknown>, det: Detection, rootId: string): Promise<string | undefined> {
  const mouth = det.parts.find((p) => p.role === 'mouth')
  if (mouth?.layer.kind === 'group' && mouth.layer.switch !== null) return mouth.id
  const { comp } = locateLayer(ctx.project, rootId)
  const face = det.parts.find((p) => p.role === 'face') ?? det.parts.find((p) => p.role === 'head')
  const root = locateLayer(ctx.project, rootId).layer
  let box: Box
  let parentId: string
  let ink: string
  let startMs: number
  let durationMs: number
  let rest: string
  let filled = false
  if (mouth) {
    if (!mouth.box) return undefined
    box = mouth.box
    parentId = locateLayer(ctx.project, mouth.id).track.groupId ?? rootId
    ink = inkOf(ctx.project, comp, mouth.layer)
    startMs = mouth.layer.startMs
    durationMs = mouth.layer.durationMs
    rest = mouth.id
    filled = (mouth.layer.kind === 'path' || mouth.layer.kind === 'shape') && mouth.layer.fills.some((f) => f.enabled)
    // A mouth drawn in pieces (the dark inside, teeth, tongue): all of them are the rest shape X, so they hide when another shape shows.
    const skip = new Set(det.parts.filter((p) => p.role !== 'mouth').map((p) => p.id))
    const pieces = piecesInside(ctx.project, comp, root, mouth.box, skip, 0.8).filter((l) => l.id !== mouth.id && locateLayer(ctx.project, l.id).track.groupId === parentId)
    if (pieces.length > 0) {
      const boxes = [mouth.box, ...pieces.flatMap((l) => layerBox(ctx.project, comp, l) ?? [])]
      const left = Math.min(...boxes.map((b) => b.left))
      const top = Math.min(...boxes.map((b) => b.top))
      box = { left, top, width: Math.max(...boxes.map((b) => b.left + b.width)) - left, height: Math.max(...boxes.map((b) => b.top + b.height)) - top }
      const grouped = await run('layers.group', { ids: [mouth.id, ...pieces.map((l) => l.id)], name: 'X' })
      rest = grouped.groupId as string
    }
  } else {
    if (!face?.box) return undefined
    const w = Math.max(6, 0.3 * face.box.width)
    box = { left: face.box.left + (face.box.width - w) / 2, top: face.box.top + 0.62 * face.box.height - 0.08 * w, width: w, height: 0.16 * w }
    parentId = face.layer.kind === 'group' ? face.id : rootId
    ink = DARK
    startMs = root.startMs
    durationMs = root.durationMs
    const smile = await run('layer.create', {
      kind: 'path',
      compId: comp.id,
      name: 'X',
      d: smilePath(w),
      fills: [],
      strokes: [{ paint: ink, width: n(Math.max(2, 0.07 * w)), cap: 'round', join: 'round' }],
      x: n(box.left + box.width / 2),
      y: n(box.top + box.height / 2),
      startMs,
      durationMs,
      groupId: parentId,
    })
    rest = created(smile)
  }
  const w = Math.max(6, box.width)
  const x = n(box.left + box.width / 2)
  const y = n(box.top + box.height / 2)
  // A filled open mouth keeps its shapes inside its own box; a thin line of a mouth gets the usual proportions.
  const cap = filled && box.height >= 0.4 * w ? box.height : Number.POSITIVE_INFINITY
  const shapes: [string, string][] = [
    ['MBP', capsulePath(w, 0.08 * w)],
    ['E', lensPath(w, 0.28 * w)],
    ['AI', dPath(w, Math.min(0.6 * w, cap))],
    ['O', ellipsePath(0.3 * w, Math.min(0.325 * w, cap / 2))],
    ['U', ellipsePath(0.19 * w, 0.19 * w)],
  ]
  const ids: string[] = [rest]
  for (const [name, d] of shapes) {
    const made = await run('layer.create', { kind: 'path', compId: comp.id, name, d, fills: [ink], strokes: [], x, y, startMs, durationMs, groupId: parentId })
    ids.push(created(made))
  }
  if (mouth && rest === mouth.id) await rename(rest, 'X')
  await run('layers.restack', { ids, to: 'front' })
  const switched = await run('switch.create', { ids, name: 'Mouth', show: 0 })
  return switched.switchId as string
}

const created = (value: { id?: string }): string => value.id as string

void looseName
