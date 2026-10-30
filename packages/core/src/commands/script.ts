import { z } from 'zod'
import { findComp } from '../doc'
import { CommandError } from '../errors'
import { type CommandContext, type CommandDef, defineCommand, normalizeCommandName } from '../registry'
import { type Project, SCRIPT_RUN_MODES, type ScriptFile } from '../schema'
import { runScript, type ScriptHere, type ScriptLog } from '../script/runtime'

/** Commands a script cannot call: it is already one step, and runs do not nest. */
const NOT_IN_SCRIPTS = new Set(['script.run', 'script.save', 'script.remove', 'api.batch'])
/** Commands that take either `ids` or a `compId` naming the whole comp to act on: a call with ids gets no `here` comp. */
const COMP_OR_IDS = new Set(['world.move_into'])

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 300_000

/** `intro/title` → `intro/title.js`; slashes made forward, no leading slash. */
function normalPath(path: string): string {
  const clean = path.trim().replace(/\\/g, '/').replace(/^\/+/, '')
  if (!clean || clean.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new CommandError(`"${path}" is not a script path.`, 'Use a path like "title.js" or "intro/title.js".')
  }
  return clean.endsWith('.js') ? clean : `${clean}.js`
}

/** A saved script by id, path, or file name when only one script has it. */
function findScript(project: Project, ref: string): ScriptFile {
  const scripts = project.scripts
  const byId = scripts.find((s) => s.id === ref)
  if (byId) return byId
  let path: string | null = null
  try {
    path = normalPath(ref)
  } catch {
    // Not a path; fall through to the "not found" error.
  }
  const byPath = path ? scripts.find((s) => s.path === path) : undefined
  if (byPath) return byPath
  const byName = path ? scripts.filter((s) => s.path.split('/').at(-1) === path) : []
  if (byName.length === 1 && byName[0]) return byName[0]
  const list = scripts.map((s) => s.path).join(', ') || 'none yet'
  throw new CommandError(`No script "${ref}".`, `Saved scripts: ${list}.`)
}

function allIds(project: Project): { layers: Set<string>; comps: Set<string> } {
  const layers = new Set<string>()
  const comps = new Set<string>()
  for (const comp of project.comps) {
    comps.add(comp.id)
    for (const track of comp.tracks) for (const layer of track.layers) layers.add(layer.id)
  }
  return { layers, comps }
}

function hereOf(project: Project, ref: string | undefined): ScriptHere | null {
  let comp
  if (ref !== undefined) {
    comp = findComp(project, ref)
  } else {
    try {
      comp = findComp(project)
    } catch {
      return null
    }
  }
  return { frameId: comp.id, name: comp.name, width: comp.width, height: comp.height, fps: comp.fps, durationMs: comp.durationMs, mode: comp.mode }
}

/** What `ac.help(id)` answers: namespaces, a namespace's verbs, or one verb's input shape. */
function help(ctx: CommandContext, callable: CommandDef[], id: string): unknown {
  const wanted = id.trim()
  if (!wanted) {
    const spaces = new Map<string, number>()
    for (const def of callable) {
      const space = def.name.split('.')[0] ?? def.name
      spaces.set(space, (spaces.get(space) ?? 0) + 1)
    }
    return {
      namespaces: Object.fromEntries(spaces),
      usage: 'ac.help("layer") lists its verbs; ac.help("layer.create") shows one verb\'s input. Every verb is await ac.<namespace>.<verb>(input).',
    }
  }
  const def = callable.find((d) => d.name === normalizeCommandName(wanted))
  if (def) {
    return { name: def.name, summary: def.summary, ...(def.details ? { details: def.details } : {}), input: ctx.registry.inputSchema(def.name) }
  }
  const verbs = callable.filter((d) => d.name.startsWith(`${wanted}.`)).map((d) => ({ name: d.name, summary: d.summary }))
  if (verbs.length > 0) return { verbs }
  return { error: `Nothing called "${wanted}".`, namespaces: [...new Set(callable.map((d) => d.name.split('.')[0]))] }
}

const ScriptRunInput = z.strictObject({
  code: z.string().optional().describe('The script: the body of an async function over ac, here and console'),
  script: z.string().optional().describe('A saved script (script.list) by path, file name or id, instead of code'),
  compId: z.string().optional().describe('The comp it runs in (`here`); omitted = the open comp'),
  timeoutMs: z.number().int().min(1000).max(3_600_000).optional().describe(`Stop past this; default ${DEFAULT_TIMEOUT_MS}, at most ${MAX_TIMEOUT_MS} (larger values are cut to it)`),
  background: z.boolean().optional().describe('Accepted for AtomCut; a run always finishes before the call answers (watch it meanwhile with script_runs and script_logs)'),
  seed: z.number().int().default(1).describe('Seeds Math.random, so a re-run makes the same choices'),
  mode: z.enum(SCRIPT_RUN_MODES).optional().describe("A saved script's re-run mode for this run only; default its own onRun"),
})

export const scriptRun = defineCommand({
  name: 'script.run',
  summary: 'Run JavaScript against the editor in one call, as one undo step: loops, maths, data. Every command is await ac.<namespace>.<verb>(input).',
  details:
    'The code is the body of an async function: top-level await works, `return value` comes back as value. Globals: ac (every command: tool layer_create is await ac.layer.create({...}), same input and result; ac.call("layer.create", input); ac.help(), ac.help("layer"), ac.help("layer.create")), here (the comp it runs in: {frameId, name, width, height, fps, durationMs, mode}, frozen; calls without a comp id land in it) and console (log, info, warn, error: captured with their line). Nothing else: no fetch, timers, files or imports. Math.random is seeded (seed) and Date is frozen, so the same script on the same project writes the same document. A failed call throws CommandError (message, hint, line); uncaught, it stops the run. A run that fails, passes timeoutMs (default 30 s, at most 300 s) or is stopped (script_stop) is rolled back whole: nothing changes. Await every call. Use it for anything repetitive or computed: a grid, a stagger over many words, a layout from data, a whole scene in one go. script.run and api.batch cannot be called inside a script. Returns {value, logs (the last 40, "line: text"), calls, ms, created {layers, comps, ids}, removed {layers, comps}, replaced, runId}.',
  effect: 'write',
  input: ScriptRunInput,
  async run(input, ctx) {
    if ((input.code === undefined) === (input.script === undefined)) {
      throw new CommandError('Give code or script, not both or neither.', 'script.run {code: "..."} runs code once; {script: "title.js"} runs a saved script.')
    }
    const saved = input.script !== undefined ? findScript(ctx.project, input.script) : undefined
    const code = saved ? saved.source : (input.code ?? '')
    const here = hereOf(ctx.project, input.compId ?? ctx.view.compId)
    const mode = saved ? (input.mode ?? saved.onRun) : 'append'

    // Replace mode: what the last run of this script made goes first, in the same step.
    const replaced = { layers: 0, comps: 0 }
    if (saved && mode === 'replace') {
      const ids = allIds(ctx.project)
      const comps = saved.output.compIds.filter((id) => ids.comps.has(id) && id !== here?.frameId)
      for (const id of comps) {
        const result = await ctx.call('frame.delete', { id })
        if (!result.ok) throw new CommandError(`Could not remove comp ${id} made by the last run: ${result.error}`, result.hint)
        replaced.comps++
      }
      const left = allIds(ctx.project).layers
      const layers = saved.output.layerIds.filter((id) => left.has(id))
      if (layers.length > 0) {
        const result = await ctx.call('layers.delete', { ids: layers })
        if (!result.ok) throw new CommandError(`Could not remove the layers made by the last run: ${result.error}`, result.hint)
        replaced.layers = layers.length
      }
    }

    const before = allIds(ctx.project)
    const started = Date.now()
    const callable = ctx.registry.list().filter((def) => !NOT_IN_SCRIPTS.has(def.name))
    const handle = ctx.scripts?.begin(saved?.path)
    let stopped = false
    const logs: ScriptLog[] = []
    const outcome = await runScript({
      code,
      commands: callable.map((d) => ({ name: d.name, summary: d.summary })),
      here,
      timeoutMs: Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
      seed: input.seed,
      stopRequested: () => stopped || (handle?.stopRequested() ?? false),
      ...(handle ? { stopSignal: handle.stopSignal } : {}),
      onLog: (line) => {
        logs.push(line)
        handle?.log(line)
      },
      onCall: (name) => handle?.awaiting(name),
      help: (id) => help(ctx, callable, id),
      call: async (name, raw) => {
        const def = ctx.registry.get(name)
        if (def && NOT_IN_SCRIPTS.has(def.name)) {
          return { ok: false, error: `${def.name} is not available inside a script.`, hint: 'Call the commands directly: a script is already one step.' }
        }
        let callInput = raw
        // Calls without a comp land in `here`, except where compId picks what to act on instead of ids (world.move_into).
        if (def && here && def.input instanceof z.ZodObject && 'compId' in def.input.shape && raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
          const fields = raw as Record<string, unknown>
          const picksByIds = COMP_OR_IDS.has(def.name) && 'ids' in fields
          if (!('compId' in fields) && !('frameId' in fields) && !picksByIds) callInput = { ...fields, compId: here.frameId }
        }
        return ctx.call(name, callInput)
      },
    })
    stopped = true
    handle?.end(outcome)
    const shown = (l: ScriptLog) => `${l.line ? `${l.line}: ` : ''}${l.level === 'log' || l.level === 'info' ? '' : `[${l.level}] `}${l.text}`

    if (outcome.status !== 'ok') {
      const { error } = outcome
      const where = error.line ? ` at line ${error.line}` : ''
      const what =
        outcome.status === 'timeout' ? 'timed out' : outcome.status === 'stopped' ? 'was stopped' : 'failed'
      const tail = logs.slice(-10).map(shown)
      const hint = [
        error.hint,
        'Nothing changed: a run that fails is rolled back whole.',
        ...(tail.length ? [`Last logs:\n${tail.join('\n')}`] : []),
        ...(handle ? [`script_logs {runId: "${handle.record.id}"} has every line.`] : []),
      ]
        .filter(Boolean)
        .join('\n')
      throw new CommandError(`Script ${what}${where}: ${error.name}: ${error.message}`, hint)
    }

    const after = allIds(ctx.project)
    const createdLayers = [...after.layers].filter((id) => !before.layers.has(id))
    const createdComps = [...after.comps].filter((id) => !before.comps.has(id))
    if (saved) {
      ctx.write('Record script output', (draft) => {
        const file = draft.scripts.find((s) => s.id === saved.id)
        if (!file) return
        const keep = mode === 'append' ? file.output : { layerIds: [], compIds: [] }
        const live = allIds(ctx.project)
        file.output = {
          layerIds: [...new Set([...keep.layerIds.filter((id) => live.layers.has(id)), ...createdLayers])],
          compIds: [...new Set([...keep.compIds.filter((id) => live.comps.has(id)), ...createdComps])],
        }
      })
    }
    return {
      value: outcome.value,
      logs: logs.slice(-40).map(shown),
      calls: outcome.calls,
      ms: Date.now() - started,
      created: { layers: createdLayers.length, comps: createdComps.length, ids: [...createdComps, ...createdLayers].slice(0, 50) },
      removed: {
        layers: [...before.layers].filter((id) => !after.layers.has(id)).length,
        comps: [...before.comps].filter((id) => !after.comps.has(id)).length,
      },
      ...(saved ? { script: saved.path, mode, replaced } : {}),
      ...(handle ? { runId: handle.record.id } : {}),
    }
  },
})

export const scriptSave = defineCommand({
  name: 'script.save',
  summary: 'Save a script in the project at a path (made or overwritten), to run with script.run {script}.',
  details:
    'Save a script the person should keep and re-run; it shows in the Scripts panel. For a one-off, call script.run {code} and leave the project\'s scripts alone. onRun replace (the default): a run first removes the layers and comps the last run made, so edit and re-run rebuilds and never stacks; append: every run adds. Overwriting keeps what the last run made, so the next replace run swaps it. Returns {id, path, onRun, created}.',
  effect: 'write',
  input: z.strictObject({
    path: z.string().min(1).describe('`intro/title.js`; .js is added when missing'),
    source: z.string(),
    onRun: z.enum(SCRIPT_RUN_MODES).optional().describe('replace (default for a new script) or append'),
  }),
  run({ path, source, onRun }, ctx) {
    const clean = normalPath(path)
    const existing = ctx.project.scripts.find((s) => s.path === clean)
    const id = existing?.id ?? ctx.ids('script')
    const mode = onRun ?? existing?.onRun ?? 'replace'
    ctx.write(existing ? 'Save script' : 'New script', (draft) => {
      const file = draft.scripts.find((s) => s.id === id)
      if (file) {
        file.source = source
        file.onRun = mode
      } else {
        draft.scripts.push({ id, path: clean, source, onRun: mode, output: { layerIds: [], compIds: [] } })
      }
    })
    return { id, path: clean, onRun: mode, created: !existing }
  },
})

export const scriptList = defineCommand({
  name: 'script.list',
  summary: "The project's saved scripts: path, id, size, run mode, and how much its last run made.",
  effect: 'read',
  input: z.strictObject({}),
  run(_input, ctx) {
    return {
      scripts: ctx.project.scripts.map((s) => ({
        id: s.id,
        path: s.path,
        size: s.source.length,
        onRun: s.onRun,
        output: { layers: s.output.layerIds.length, comps: s.output.compIds.length },
      })),
    }
  },
})

export const scriptRead = defineCommand({
  name: 'script.read',
  summary: "A saved script's source.",
  effect: 'read',
  input: z.strictObject({ script: z.string().min(1).describe('Path (`intro/title.js`), file name or id') }),
  run({ script }, ctx) {
    const file = findScript(ctx.project, script)
    return { id: file.id, path: file.path, onRun: file.onRun, source: file.source }
  },
})

export const scriptRemove = defineCommand({
  name: 'script.remove',
  summary: 'Delete a saved script. What its runs made stays.',
  effect: 'write',
  input: z.strictObject({ script: z.string().min(1).describe('Path, file name or id') }),
  run({ script }, ctx) {
    const file = findScript(ctx.project, script)
    ctx.write('Delete script', (draft) => {
      draft.scripts = draft.scripts.filter((s) => s.id !== file.id)
    })
    return { removed: file.path }
  },
})
