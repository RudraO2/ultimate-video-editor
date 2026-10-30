import { type Comp, CommandError, defineCommand, findComp, isWorld, type Layer, locateLayer, type Project } from '@uve/core'
import { type Collider, CompRenderer, FONT_PROBE_TEXT, fontsOf, type Simulation } from '@uve/engine'
import { z } from 'zod'
import { loadFontsOf } from '../library/fonts'
import { useEditor } from '../store'

// Reading and baking a comp's physics (AtomCut's physics_inspect, and our
// physics_bake). They need the simulation, which measures layers the way the
// picture draws them, so they live in the desktop app.

const renderer = new CompRenderer()

/** The comp's simulation, with its fonts loaded first so text bodies are measured as they draw. */
async function simulationOf(project: Project, comp: Comp): Promise<Simulation | null> {
  await renderer.prepare(comp, project)
  await loadFontsOf(project.comps)
  await Promise.all(fontsOf(comp, project.comps).map((font) => document.fonts.load(font, FONT_PROBE_TEXT)))
  return renderer.simulation(comp, project)
}

const round = (v: number) => Math.round(v * 10) / 10

/** A collider list in a few words: "box", "circle r 40", "outline (5 pieces)". */
function describeColliders(colliders: readonly Collider[]): string {
  if (colliders.length === 0) return 'none yet (it has not entered)'
  const first = colliders[0] as Collider
  if (colliders.length === 1 && first.kind === 'circle') return `circle r ${round(first.radius)}`
  if (colliders.length === 1 && first.kind === 'polygon' && first.points.length === 4) return 'box'
  return `outline (${colliders.length} convex piece${colliders.length === 1 ? '' : 's'})`
}

const compInput = z.string().min(1).optional().describe('The comp; default the open one (frameId works too)')

function compOf(project: Project, compId: string | undefined): Comp {
  const comp = findComp(project, compId ?? useEditor.getState().activeCompId)
  if (isWorld(comp)) throw new CommandError('Physics runs in flat comps; 3D worlds come later.')
  return comp
}

export const physicsInspect = defineCommand({
  name: 'physics.inspect',
  summary: "A comp's simulation at a moment: every body (kind, collider, where it is then), every force, every joint, and the settings.",
  details:
    'atMs is comp time. Before the physics start, and outside a body\'s clip, a body is where its keys put it (simulated: false). Positions are the pivot in comp px (+y down), rotation in degrees (+ clockwise). Use it at the moments that matter: the impact, the settle.',
  effect: 'read',
  input: z.strictObject({ compId: compInput, atMs: z.number().min(0).default(0) }),
  run: async ({ compId, atMs }, ctx) => {
    const comp = compOf(ctx.project, compId)
    const sim = await simulationOf(ctx.project, comp)
    const settings = sim?.settings ?? null
    const layers = comp.tracks.flatMap((t) => t.layers)
    const bodies = (sim?.bodies() ?? []).map((info) => {
      const layer = layers.find((l) => l.id === info.id) as Layer
      const pose = sim?.poseAt(info.id, atMs) ?? null
      const t = layer.transform
      return {
        id: info.id,
        name: info.name,
        type: info.type,
        shape: layer.physics?.shape ?? 'auto',
        collider: describeColliders(info.colliders),
        simulated: pose !== null,
        x: round(pose?.x ?? t.x),
        y: round(pose?.y ?? t.y),
        rotation: round(pose?.rotation ?? t.rotation),
        enteredMs: Math.round(info.enteredMs),
      }
    })
    const forces = layers.flatMap((l) => (l.forces ?? []).map((f) => ({ layerId: l.id, layer: l.name, ...f, keyed: Object.keys(l.animations).some((p) => p.startsWith(`force.${f.id}.`)) })))
    const joints = layers.flatMap((l) => (l.joints ?? []).map((j) => ({ on: l.id, ...j })))
    return { compId: comp.id, atMs, settings, bodies, forces, joints }
  },
})

export const physicsBake = defineCommand({
  name: 'physics.bake',
  summary: 'Turn the simulated motion of active bodies into keys (x, y, rotation), then remove their bodies, so the motion can be edited by hand.',
  details:
    'ids: the bodies to bake (default every active body in the comp). Keys are sampled at the comp frame rate from the physics start (or the clip start) to the clip end, then simplified to the fewest eased keys within tolerance (px, and degrees for rotation; default 0.5 px and 0.25°). Keys before the physics start are kept. Passive and animated bodies are left as they are. Baking is optional: the simulation already plays and exports the same every time.',
  effect: 'write',
  input: z.strictObject({
    compId: compInput,
    ids: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    tolerance: z.number().positive().optional(),
  }),
  run: async ({ compId, ids, tolerance }, ctx) => {
    const project = ctx.project
    const comp = ids === undefined ? compOf(project, compId) : compOf(project, locateLayer(project, typeof ids === 'string' ? ids : (ids[0] as string)).comp.id)
    const sim = await simulationOf(project, comp)
    if (!sim) throw new CommandError('This comp has no physics bodies.', 'physics_body makes layers fall first.')
    const wanted = ids === undefined ? null : new Set((typeof ids === 'string' ? [ids] : ids).map((ref) => locateLayer(project, ref).layer.id))
    const bodies = comp.tracks
      .flatMap((t) => t.layers)
      .filter((l) => l.physics?.type === 'active' && (wanted === null || wanted.has(l.id)))
    if (wanted && bodies.length < wanted.size) throw new CommandError('Only active bodies of one comp can be baked.', 'Passive and animated bodies already move by their keys.')
    if (bodies.length === 0) throw new CommandError('This comp has no active bodies to bake.')
    const frame = 1000 / comp.fps
    // Sample everything first: the first write changes the comp, and the simulation with it.
    const plans = bodies.map((layer) => {
      const from = Math.max(sim.settings.startMs, layer.startMs)
      const to = Math.min(layer.startMs + layer.durationMs, comp.durationMs)
      const samples: { t: number; x: number; y: number; r: number }[] = []
      for (let i = 0; ; i++) {
        const at = Math.min(to, from + i * frame)
        const pose = sim.poseAt(layer.id, Math.min(at, to - 0.01))
        if (pose) samples.push({ t: at - layer.startMs, x: pose.x, y: pose.y, r: pose.rotation })
        if (at >= to) break
      }
      return { layer, from, samples }
    })
    for (const { layer, from, samples } of plans) {
      if (samples.length === 0) continue
      const keep = (path: string) => (layer.animations[path] ?? []).filter((k) => k.t < from - layer.startMs).map((k) => ({ t: k.t, v: k.v, ease: k.ease }))
      for (const [path, pick] of [
        ['transform.x', (s: (typeof samples)[number]) => s.x],
        ['transform.y', (s: (typeof samples)[number]) => s.y],
        ['transform.rotation', (s: (typeof samples)[number]) => s.r],
      ] as const) {
        const keys = [...keep(path), ...samples.map((s) => ({ t: s.t, v: pick(s), ease: 'linear' }))]
        const result = await ctx.call('keyframes.set', { id: layer.id, path, keys })
        if (!result.ok) throw new CommandError(result.error, result.hint)
      }
      const simplified = await ctx.call('keyframes.simplify', { id: layer.id, properties: ['transform.x', 'transform.y', 'transform.rotation'], ...(tolerance ? { tolerance } : {}) })
      if (!simplified.ok) throw new CommandError(simplified.error, simplified.hint)
    }
    const removed = await ctx.call('physics.body', { ids: plans.map((p) => p.layer.id), type: null })
    if (!removed.ok) throw new CommandError(removed.error, removed.hint)
    const after = (id: string) => locateLayer(ctx.project, id).layer.animations
    return {
      baked: plans.map(({ layer }) => ({
        id: layer.id,
        name: layer.name,
        keys: { x: after(layer.id)['transform.x']?.length ?? 0, y: after(layer.id)['transform.y']?.length ?? 0, rotation: after(layer.id)['transform.rotation']?.length ?? 0 },
      })),
    }
  },
})

/** The forces catalog: what each kind does and the fields it reads. */
export const FORCE_KINDS = [
  { id: 'wind', name: 'Wind', tagline: "Blows along its layer's +X (turn the layer to aim it; 90° blows down). 300 is a breeze, 800 a gale.", fields: ['strength', 'radius', 'falloff'] },
  { id: 'point', name: 'Attract', tagline: 'Pulls toward its layer (negative strength pushes away). 300 to 1500 pulls things into orbit; gravity 0 for space.', fields: ['strength', 'radius', 'falloff'] },
  { id: 'vortex', name: 'Vortex', tagline: 'Swirls bodies clockwise around its layer (negative turns the other way), drawing them in a little.', fields: ['strength', 'radius', 'falloff'] },
  { id: 'turbulence', name: 'Turbulence', tagline: 'A smooth, changing noise push; scale is the size of its swirls in px, seed picks another pattern.', fields: ['strength', 'radius', 'falloff', 'scale', 'seed'] },
  { id: 'drag', name: 'Drag', tagline: 'Slows bodies: strength is the % of speed lost per second (thick air, water).', fields: ['strength', 'radius', 'falloff'] },
] as const
