import { CommandError, type CommandResult, compTimeFor, findComp, isWorld, locateLayer, renameFieldAliases } from '@uve/core'
import { CompRenderer } from '@uve/engine'
import { z } from 'zod'
import { type AgentCall, type McpTool, type McpToolResult, toolName } from '../../../shared/agent'
import { mediaTypeOf } from '../../../shared/media'
import { EXPORT_FORMATS, isStillFormat, parseExportFormat } from '../export/formats'
import { defaultExportFormat, exportCompTo, exportSpan } from '../export/job'
import { EXPORT_QUALITIES } from '../export/options'
import { installFonts } from '../library/installFonts'
import { layerInput, mediaInput } from '../media/import'
import { modelFormatOfName, probeModelFile } from '../media/model'
import { ProbeError, probeMedia } from '../media/probe'
import { hasUnsavedChanges, newProject, openProjectFrom, saveProjectTo } from '../project/file'
import { activeComp, session, useEditor } from '../store'
import { editorView, registerDesktopCommands } from './commands'
import { captureConsole } from './console'
import { MediaInspectInput, mediaInspect } from './footageInspect'
import { contactSheet, DETAIL_PX, type Detail, encodePicture, type Region, renderStills } from './view'

// Answers agents' tool calls, relayed by the main process from the MCP server.
// Every command in the session's registry is a tool (`layer.set` is
// `layer_set`); a few tools that need the editor itself (pictures, undo, file
// import) are answered here. An agent's edits made close together are one
// undo step, named after the agent app; an edit by hand in between starts a
// new one.

/** A pause longer than this between an agent's calls starts a new undo step. */
const TURN_GAP_MS = 45_000
/** Activity entries kept for the Agents panel. */
const LOG_LIMIT = 50

const DetailSchema = z
  .enum(['glance', 'look', 'inspect'])
  .default('look')
  .describe('glance ≈384 px (layout, cheap) · look ≈768 px (default) · inspect ≈1280 px (type, detail)')

const ViewRenderInput = z.strictObject({
  compId: z.string().optional().describe('Comp id or name; default the one open in the editor'),
  atMs: z.number().min(0).optional().describe('Comp time; default the playhead'),
  detail: DetailSchema,
  layers: z.array(z.string()).min(1).optional().describe("Crop to these layers' bounds, to judge one element up close"),
})

const ViewFramesInput = z.strictObject({
  compId: z.string().optional().describe('Comp id or name; default the one open in the editor'),
  fromMs: z.number().min(0).optional(),
  toMs: z.number().min(0).optional(),
  count: z.number().int().min(2).max(12).default(6),
  times: z.array(z.number().min(0)).min(1).max(12).optional().describe('Exact instants (comp ms) instead of an even spread'),
  detail: DetailSchema,
})

const MediaImportInput = z.strictObject({
  localPath: z.string().describe('Absolute path of a video, image or audio file on this computer'),
  place: z
    .strictObject({
      compId: z.string().optional(),
      startMs: z.number().min(0).optional().describe('Comp time; default the playhead'),
      x: z.number().optional(),
      y: z.number().optional(),
    })
    .optional()
    .describe('Also put it on the timeline. Omitted: only add it to the media library'),
})

const FontInstallInput = z.strictObject({
  localPath: z.string().optional().describe('Absolute path of a font file on this computer: TrueType, OpenType, WOFF or WOFF2'),
  url: z.string().optional().describe('An https address of a font file'),
})

const WorldImportModelInput = z.strictObject({
  localPath: z.string().optional().describe('Absolute path of a model file on this computer: glb, gltf, obj, stl or ply'),
  url: z.string().optional().describe('An https address of a model file (downloaded once; a .gltf brings the files beside it)'),
  attachmentId: z.string().optional().describe('Not supported here: pass localPath or url'),
  frameId: z.string().optional().describe('The 3D world to put it in (id or name); default the frame open in the editor'),
  name: z.string().min(1).optional().describe('The layer name; default the file name without its extension'),
  position: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]).describe('[x, y, z] world px: Z up; the model stands on z = 0 when it is fitted'),
  startMs: z.number().min(0).optional().describe('When it appears; default 0'),
  faces: z.unknown().optional().describe('Accepted and ignored: face shape keys come later'),
})

const ProjectSaveInput = z.strictObject({
  path: z
    .string()
    .optional()
    .describe('Absolute path of the project file (.uve is added when missing). Omitted: the file the project was last saved to or opened from'),
})

const ProjectOpenInput = z.strictObject({
  path: z.string().describe('Absolute path of a .uve project file'),
})

const ProjectNewInput = z.strictObject({
  name: z.string().min(1).optional().describe('Project name; default "Untitled project"'),
})

const ExportVideoInput = z.strictObject({
  compId: z.string().optional().describe('Comp id or name; default the one open in the editor'),
  path: z
    .string()
    .optional()
    .describe(
      "Absolute path of the file to write (the format's extension, such as .mp4, .gif or .png, is added when missing); for png-seq, the folder to write the frames into (made when missing). Omitted: the comp's name in the user's Videos folder (png-seq: a folder '<name>-png-seq'), numbered when taken",
    ),
  overwrite: z.boolean().default(false).describe('Replace a file that already exists at path (png-seq: replace the frame-N.png files in that folder)'),
  format: z
    .string()
    .optional()
    .describe(
      `AtomCut's export format ids: ${EXPORT_FORMATS.join(', ')}. Default mp4 (H.264 + AAC), or png for a static frame; mov is AtomCut's lossless master (a PNG per frame + 16-bit PCM; large); webm is VP9 (else VP8) + Opus; gif loops forever with a palette per frame, at most 50 fps; png-seq is a folder of frame-000.png… from 0; audio is a 16-bit 48 kHz WAV of the mix; png, jpg and webp are stills of one frame (atMs)`,
    ),
  atMs: z.number().min(0).optional().describe('Stills only: the comp time to export; default the playhead (a static frame always gives its still)'),
  quality: z
    .enum(EXPORT_QUALITIES)
    .optional()
    .describe('Video bitrate step: draft, high (default) or master = 0.5, 1 or 2 × clamp(width × height × fps × 0.4, 8, 120 Mbps). For jpg and webp stills: 0.8, 0.92 or 1 (lossless WebP)'),
  videoBitrate: z.number().optional().describe('Video bitrate, overriding quality: megabits per second below 1000 (25), else bits per second'),
  audioBitrate: z.number().optional().describe('Sound bitrate for mp4 and webm: kilobits per second below 1000 (192, the default), else bits per second; 64 to 320 kbps'),
  scale: z.number().optional().describe("Output size as a multiple of the comp's (0.05 to 4, default 1); sides are rounded to even pixels"),
  fps: z.number().optional().describe("Output frame rate (1 to 240, 3 decimals such as 23.976); default the comp's"),
  includeAudio: z.boolean().optional().describe('false writes no sound track (default true)'),
  motionBlur: z.boolean().optional().describe("false draws no motion blur whatever the comp and layers say (default true: their settings apply)"),
  transparent: z
    .boolean()
    .optional()
    .describe(
      "true leaves the comp's background out and keeps alpha (mov: PNG frames with alpha; webm: VP9 with an alpha stream; gif: pixels under half alpha are transparent; png-seq, png and webp: RGBA). Refused for mp4, audio and jpg. Default false",
    ),
  range: z
    .enum(['full', 'span'])
    .optional()
    .describe('full = the whole comp; span = the working range (session_set {workRange}). Default: the working range when it is on, else full'),
})

interface HostTool {
  name: string
  description: string
  input: z.ZodType
  run(args: never, call: AgentCall): Promise<McpToolResult>
}

const HOST_TOOLS: HostTool[] = [
  {
    name: 'view_render',
    description:
      'LOOK at a comp at one instant: the real render, exactly as it would export. A static frame always shows its still, so atMs is ignored and the reported atMs is the still. Use it after every visible change and before you call something finished. `layers` crops to those layers. Pick the cheapest detail that answers your question.',
    input: ViewRenderInput,
    run: viewRender,
  },
  {
    name: 'view_frames',
    description:
      'WATCH motion: a contact sheet of a comp at several instants in one image, each tile labelled with its time. The cheapest way to judge an animation or pacing. 4 to 9 tiles; by default it spans the whole comp, or the working range when one is on (session_set {workRange}). A static frame is one picture: you get one tile at its still.',
    input: ViewFramesInput,
    run: viewFrames,
  },
  {
    name: 'media_inspect',
    description:
      "LOOK at footage: a contact sheet of a video file's own frames (not the comp). With no shot or range, one tile per shot (from media_analyze), the whole file at a glance; with shot or fromMs/toMs, frames spread inside it. The text gives each shot's times and description and the words said there. frames: 0 answers in text only (use it when you cannot see images). Then write what each shot shows with media_describe_shots.",
    input: MediaInspectInput,
    run: async (args: z.output<typeof MediaInspectInput>) => {
      try {
        return await mediaInspect(args)
      } catch (error) {
        return thrown(error)
      }
    },
  },
  {
    name: 'history_undo',
    description: "Undo your own most recent edit step. It refuses to undo anything the user did.",
    input: z.strictObject({}),
    run: historyUndo,
  },
  {
    name: 'script_runs',
    description:
      'The script runs that are live or just finished (newest last), one line each: runId, file, status (running, ok, error, timeout, stopped), age, calls made, the command it is awaiting, its last log line. Answers at once, even while a script runs.',
    input: z.strictObject({}),
    run: scriptRuns,
  },
  {
    name: 'script_logs',
    description:
      "A run's console lines since a cursor: pass back `next` as `since` to read only new lines of a long build. Without since, the newest `tail` lines (default 20, at most 200). Answers at once, even while the script runs.",
    input: z.strictObject({
      runId: z.string().min(1),
      since: z.number().int().min(0).optional(),
      tail: z.number().int().min(1).max(200).default(20),
    }),
    run: scriptLogs,
  },
  {
    name: 'script_stop',
    description:
      'Stop a running script by runId. A stopped run is rolled back whole: nothing it made stays, and its script_run call answers with "was stopped".',
    input: z.strictObject({ runId: z.string().min(1) }),
    run: scriptStop,
  },
  {
    name: 'project_save',
    description:
      'Save the project to a .uve file: the document as JSON plus a manifest. Media files are not copied; the file refers to them by path. Without path it saves to the file the project came from. Not an undo step.',
    input: ProjectSaveInput,
    run: projectSave,
  },
  {
    name: 'project_open',
    description:
      "Open a .uve project file, replacing the open project and its undo history. Refused while the open project has unsaved changes: project_save first, or ask the user. Reports media files that are missing on disk.",
    input: ProjectOpenInput,
    run: projectOpen,
  },
  {
    name: 'project_new',
    description:
      'Start a new empty project (one 1920×1080, 30 fps, 10 s comp; change it with frame_update), replacing the open one and its undo history. Refused while the open project has unsaved changes: project_save first, or ask the user.',
    input: ProjectNewInput,
    run: projectNew,
  },
  {
    name: 'export_video',
    description:
      "Render a comp to a file (default an MP4: H.264 video, AAC sound; a PNG still for a static frame) at the comp's size and frame rate unless scale or fps say otherwise, exactly as view_render draws it, and wait until it is written. The user sees the progress and can cancel. Look at the work with view_frames before exporting. When the working range is on for that comp (session_set {workRange}), only that span is written: the reply's startMs and workRange say which. Returns the file's path, size and length, and for a file with sound its loudness as written: {integratedLufs, truePeakDbtp, matchDb} (matchDb is the loudness match's trim; the target is frame_update soundMix.loudness, default −14 LUFS). `format` takes AtomCut's export ids: mp4, mov (lossless master), webm, gif, png-seq (a folder of PNGs), audio (WAV), and stills of one frame at atMs: png, jpg, webp. A static frame exports only as a still. Options as AtomCut's export panel: quality (draft/high/master), videoBitrate, audioBitrate, scale, fps, includeAudio, motionBlur, transparent (all but mp4, audio and jpg), range (full/span).",
    input: ExportVideoInput,
    run: exportVideo,
  },
  {
    name: 'font_install',
    description:
      'Install a font file into the project (the file stays where it is) so text can use it: give localPath (absolute, on this computer) or an https url of a TrueType, OpenType, WOFF or WOFF2 file. Returns the family name to set as style.fontFamily; a family\'s files (regular, bold, italic) are one family, and a variable font covers a weight range. Google families need no install: set fontFamily by name (fonts_list searches them).',
    input: FontInstallInput,
    run: fontInstall,
  },
  {
    name: 'world_import_model',
    description:
      'Import a 3D model file (glb, gltf, obj, stl, ply) into a 3D WORLD as a mesh layer: give localPath (absolute, on this computer) or an https url; the file stays where it is. Only worlds take models: frameId (or the frame open in the editor) must be a world, else make one with world_create or open one. A glTF is placed at 1 m = 100 px, scaled by its own units, in a Z-up wrapper; obj, stl and ply are fitted to 200 px and stand on z = 0. position is [x, y, z] world px. The file\'s animation clips play: the first one starts in a loop, and layer_set {id, animation: {clip, speed, loop}} changes it (clip null holds the model at rest); world_inspect lists a model\'s clips. The model shows the file\'s own materials (material.source "file", the default); world_material with a preset makes it a custom material instead. faces is accepted and ignored. Returns layerId, assetId, the clip names and the model\'s size [x, y, z] in px.',
    input: WorldImportModelInput,
    run: worldImportModel,
  },
  {
    name: 'media_import',
    description:
      'Bring a video, image or audio file into the project by its path on this computer (the file stays where it is), and optionally put it on the timeline. Returns the media id and, when placed, the layer id.',
    input: MediaImportInput,
    run: mediaImport,
  },
]

const text = (body: string, isError = false): McpToolResult => ({ content: [{ type: 'text', text: body }], isError })
const json = (value: unknown): McpToolResult => text(JSON.stringify(value))

/** An error thrown while answering, with its hint when it is a command error. */
function thrown(error: unknown): McpToolResult {
  if (error instanceof CommandError && error.hint) return text(`${error.message}\nHint: ${error.hint}`, true)
  return text(error instanceof Error ? error.message : String(error), true)
}

function failure(result: Extract<CommandResult, { ok: false }>): McpToolResult {
  return text(result.hint ? `${result.error}\nHint: ${result.hint}` : result.error, true)
}

/** Every tool this window answers: the registry's commands, then the editor's own. */
export function agentTools(): McpTool[] {
  const commands = session.registry.list().map((def) => ({
    name: toolName(def.name),
    description: def.details ? `${def.summary}\n\n${def.details}` : def.summary,
    inputSchema: session.registry.inputSchema(def.name) ?? { type: 'object' },
  }))
  const own = HOST_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.input, { io: 'input' }) as Record<string, unknown>,
  }))
  return [...commands, ...own]
}

const turns = new Map<string, { group: string; lastAt: number }>()
let turnSeq = 0

/** The undo group of an agent session's current turn. */
function turnOf(call: AgentCall): string {
  const now = Date.now()
  let turn = turns.get(call.client.session)
  if (!turn || now - turn.lastAt > TURN_GAP_MS) {
    turn = { group: `agent:${call.client.session}:${++turnSeq}`, lastAt: now }
    turns.set(call.client.session, turn)
  }
  turn.lastAt = now
  return turn.group
}

function callOptions(call: AgentCall) {
  return { group: turnOf(call), label: `Agent · ${call.client.name}` }
}

async function answer(call: AgentCall): Promise<McpToolResult> {
  const own = HOST_TOOLS.find((t) => t.name === call.name)
  if (own) {
    const parsed = own.input.safeParse(renameFieldAliases(own.input, call.args ?? {}))
    if (!parsed.success) {
      return text(`Invalid input for ${call.name}:\n${z.prettifyError(parsed.error)}`, true)
    }
    return own.run(parsed.data as never, call)
  }
  const def = session.registry.get(call.name)
  if (!def) return text(`Unknown tool "${call.name}".`, true)
  const result = await session.call(def.name, call.args, callOptions(call))
  if (!result.ok) return failure(result)
  // The overview also says where the user is in the editor.
  if (def.name === 'doc.overview') return json({ ...(result.value as object), editor: editorView() })
  if (def.name === 'layers.list') return json(withBounds(result.value as LayersListResult))
  return json(result.value)
}

type LayersListResult = { compId: string; tracks: { layers: { id: string; [field: string]: unknown }[] }[] }

/**
 * Adds each visual layer's measured bounds to layers.list (the core cannot
 * measure text): the axis-aligned box it covers in comp space (centre origin,
 * +y down), at the playhead when the layer shows then, otherwise at its start.
 */
function withBounds(list: LayersListResult): LayersListResult {
  const comp = findComp(session.project, list.compId)
  const renderer = new CompRenderer()
  const playhead = useEditor.getState().timeMs
  for (const track of list.tracks) {
    for (const entry of track.layers) {
      const { layer } = locateLayer(session.project, entry.id)
      const at = playhead >= layer.startMs && playhead < layer.startMs + layer.durationMs ? playhead : layer.startMs
      const corners = layer.enabled ? renderer.outline(comp, session.project, layer, at) : null
      if (!corners) continue
      const xs = corners.map(([x]) => x - comp.width / 2)
      const ys = corners.map(([, y]) => y - comp.height / 2)
      const round = (v: number) => Math.round(v * 10) / 10
      const left = Math.min(...xs)
      const top = Math.min(...ys)
      entry.bounds = { left: round(left), top: round(top), width: round(Math.max(...xs) - left), height: round(Math.max(...ys) - top), atMs: Math.round(at) }
    }
  }
  return list
}

function compFor(ref: string | undefined) {
  return ref === undefined ? activeComp(useEditor.getState()) : findComp(session.project, ref)
}

/** The bounds of `layers` at `timeMs`, padded and kept inside the comp. */
function cropTo(compRef: string | undefined, layers: readonly string[], timeMs: number): Region {
  const comp = compFor(compRef)
  const renderer = new CompRenderer()
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const ref of layers) {
    const { comp: home, layer } = locateLayer(session.project, ref)
    if (home.id !== comp.id) throw new Error(`"${ref}" is in comp ${home.id}, not ${comp.id}.`)
    const corners = renderer.outline(comp, session.project, layer, timeMs)
    if (!corners) throw new Error(`"${ref}" is not visible at ${Math.round(timeMs)} ms.`)
    for (const [x, y] of corners) {
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
    }
  }
  const pad = Math.max(16, 0.08 * Math.max(right - left, bottom - top))
  left = Math.max(0, left - pad)
  top = Math.max(0, top - pad)
  right = Math.min(comp.width, right + pad)
  bottom = Math.min(comp.height, bottom + pad)
  if (right - left < 1 || bottom - top < 1) throw new Error('Those layers are outside the comp at that time.')
  return { left, top, width: right - left, height: bottom - top }
}

async function viewRender(args: z.output<typeof ViewRenderInput>): Promise<McpToolResult> {
  try {
    const comp = compFor(args.compId)
    const atMs = compTimeFor(comp, Math.min(args.atMs ?? useEditor.getState().timeMs, comp.durationMs))
    const region = args.layers ? cropTo(comp.id, args.layers, atMs) : undefined
    const [still] = await renderStills(session.project, comp, [atMs], DETAIL_PX[args.detail as Detail], region)
    if (!still) throw new Error('Nothing was drawn.')
    const picture = await encodePicture(still)
    return {
      content: [
        { type: 'image', data: picture.data, mimeType: picture.mimeType },
        { type: 'text', text: JSON.stringify({ compId: comp.id, atMs, width: picture.width, height: picture.height, ...(region ? { region } : {}), ...(comp.mode === 'static' ? { static: true } : {}) }) },
      ],
    }
  } catch (error) {
    return thrown(error)
  }
}

async function viewFrames(args: z.output<typeof ViewFramesInput>): Promise<McpToolResult> {
  try {
    const comp = compFor(args.compId)
    // The last instant that still shows something: one frame before the end.
    const last = Math.max(0, comp.durationMs - 1000 / comp.fps)
    let times = comp.mode === 'static' ? [compTimeFor(comp, 0)] : args.times
    // With no explicit instants or bounds, the working range (when on) replaces the whole comp.
    const range = !times && args.fromMs === undefined && args.toMs === undefined ? exportSpan(comp) : undefined
    if (!times) {
      const from = Math.min(args.fromMs ?? range?.startMs ?? 0, last)
      const to = Math.min(args.toMs ?? (range ? range.endMs - 1000 / comp.fps : last), last)
      times = Array.from({ length: args.count }, (_, i) => Math.round(from + ((to - from) * i) / (args.count - 1)))
    }
    times = comp.mode === 'static' ? times : times.map((t) => Math.min(t, last))
    const longSide = DETAIL_PX[args.detail as Detail]
    const columns = Math.ceil(Math.sqrt(times.length))
    const note = comp.mode === 'static' ? { static: true, note: 'A static frame is one picture, so there is one tile.' } : {}
    const stills = await renderStills(session.project, comp, times, Math.max(160, longSide / columns))
    const picture = await encodePicture(contactSheet(stills, times, longSide))
    return {
      content: [
        { type: 'image', data: picture.data, mimeType: picture.mimeType },
        { type: 'text', text: JSON.stringify({ compId: comp.id, times, width: picture.width, height: picture.height, ...(range ? { workRange: range } : {}), ...note }) },
      ],
    }
  } catch (error) {
    return thrown(error)
  }
}

async function historyUndo(_args: never, call: AgentCall): Promise<McpToolResult> {
  const group = session.undoGroup
  if (!session.canUndo) return text('There is nothing to undo.', true)
  if (!group?.startsWith(`agent:${call.client.session}:`)) {
    return text(`The newest undo step is "${session.undoLabel}", which is not yours, so it stays. Fix forward instead.`, true)
  }
  session.undo()
  turns.delete(call.client.session)
  return json({ undone: true, next: session.undoLabel ?? null })
}

async function scriptRuns(): Promise<McpToolResult> {
  const now = Date.now()
  const runs = session.scripts.list().map((run) => {
    const last = run.logs.at(-1)
    return {
      runId: run.id,
      file: run.file ?? '(code)',
      status: run.status,
      ageMs: now - run.startedAt,
      ms: run.status === 'running' ? now - run.startedAt : run.ms,
      calls: run.calls,
      ...(run.awaiting ? { awaiting: run.awaiting } : {}),
      ...(last ? { lastLog: last.text } : {}),
      ...(run.error ? { error: run.error.message } : {}),
    }
  })
  return json({ runs })
}

async function scriptLogs(args: { runId: string; since?: number | undefined; tail: number }): Promise<McpToolResult> {
  const logs = session.scripts.logs(args.runId, args.since, args.tail)
  if (!logs) return text(`No script run "${args.runId}".\nHint: script_runs lists the recent runs.`, true)
  return json({ status: logs.status, next: logs.next, lines: logs.lines.map((l) => ({ n: l.n, level: l.level, ...(l.line ? { line: l.line } : {}), text: l.text })) })
}

async function scriptStop(args: { runId: string }): Promise<McpToolResult> {
  const run = session.scripts.get(args.runId)
  if (!run) return text(`No script run "${args.runId}".\nHint: script_runs lists the recent runs.`, true)
  if (!session.scripts.stop(args.runId)) return json({ stopped: false, status: run.status, note: 'The run had already finished.' })
  return json({ stopped: true, runId: run.id, note: 'Stopping: the run is rolled back whole.' })
}

async function projectSave(args: z.output<typeof ProjectSaveInput>): Promise<McpToolResult> {
  const path = args.path ?? useEditor.getState().projectPath
  if (!path) {
    return text('This project has never been saved, so it has no file yet.\nHint: pass path, an absolute path ending in .uve.', true)
  }
  try {
    return json(await saveProjectTo(path))
  } catch (error) {
    return text(`Could not save the project: ${error instanceof Error ? error.message : String(error)}`, true)
  }
}

function unsavedRefusal(): McpToolResult | null {
  if (!hasUnsavedChanges()) return null
  const { projectPath } = useEditor.getState()
  return text(
    `The open project has unsaved changes, and this would lose them.\nHint: ${
      projectPath ? `project_save saves them to ${projectPath}` : 'project_save with a path saves them'
    }, or ask the user what to do with them.`,
    true,
  )
}

async function projectOpen(args: z.output<typeof ProjectOpenInput>): Promise<McpToolResult> {
  const refusal = unsavedRefusal()
  if (refusal) return refusal
  try {
    const { path, project, missing } = await openProjectFrom(args.path)
    turns.clear()
    return json({
      path,
      projectName: project.name,
      comps: project.comps.map(({ id, name, width, height, fps, durationMs }) => ({ id, name, width, height, fps, durationMs })),
      mediaCount: project.media.length,
      missingMedia: missing,
    })
  } catch (error) {
    return thrown(error)
  }
}

async function projectNew(args: z.output<typeof ProjectNewInput>): Promise<McpToolResult> {
  const refusal = unsavedRefusal()
  if (refusal) return refusal
  const project = await newProject(args.name)
  turns.clear()
  const comp = project.comps[0]
  return json({ projectName: project.name, compId: comp?.id ?? null })
}

/** A number rounded to 0.1 (null for silence's -Infinity). */
const tenth = (value: number): number | null => (Number.isFinite(value) ? Math.round(value * 10) / 10 : null)

async function exportVideo(args: z.output<typeof ExportVideoInput>): Promise<McpToolResult> {
  try {
    const comp = compFor(args.compId)
    const format = args.format === undefined ? defaultExportFormat(comp) : parseExportFormat(args.format)
    const still = isStillFormat(format)
    const { compId: _compId, path, overwrite, format: _format, ...options } = args
    const job = await exportCompTo(comp, path ?? null, overwrite, { ...options, format })
    if (!job) return text('The user cancelled the export. Nothing was written.', true)
    if (job.status !== 'done' || !job.result) return text(`The export failed: ${job.error ?? 'unknown error'}. Nothing was written.`, true)
    const result = job.result
    const span = still || args.range === 'full' ? undefined : exportSpan(comp)
    return json({
      path: job.path,
      format,
      compId: comp.id,
      ...(result.videoCodec
        ? {
            width: result.width,
            height: result.height,
            scale: result.scale,
            ...(still ? {} : { fps: result.fps, frames: result.frameCount }),
            ...(format === 'png-seq' ? { files: `frame-${'0'.repeat(String(result.frameCount).length)}.png … frame-${result.frameCount - 1}.png` } : {}),
            videoCodec: result.videoCodec,
            ...(result.videoBitrate !== null ? { videoBitrate: result.videoBitrate } : {}),
            motionBlur: args.motionBlur !== false,
            transparent: result.transparent,
          }
        : {}),
      ...(still ? { atMs: result.startMs, ...(comp.mode === 'static' ? { static: true } : {}) } : {}),
      ...(still || format === 'gif' || format === 'png-seq'
        ? {}
        : {
            sound: result.hasSound ? (result.audioBitrate ? { bitrate: result.audioBitrate } : 'pcm-s16 48 kHz stereo') : null,
          }),
      ...(still ? {} : { durationMs: Math.round(result.durationMs), startMs: Math.round(result.startMs) }),
      ...(span ? { workRange: span } : {}),
      ...(result.loudness && !still && format !== 'gif' && format !== 'png-seq'
        ? { loudness: { integratedLufs: tenth(result.loudness.integratedLufs), truePeakDbtp: tenth(result.loudness.truePeakDbtp), matchDb: tenth(result.loudness.matchDb) } }
        : {}),
      bytes: job.bytes,
      tookMs: (job.finishedAt ?? Date.now()) - job.startedAt,
      ...(job.note ? { note: job.note } : {}),
    })
  } catch (error) {
    return thrown(error)
  }
}

async function fontInstall(_args: z.output<typeof FontInstallInput>, call: AgentCall): Promise<McpToolResult> {
  const font = call.font
  if (!font) return text('The font was not handed over by the editor. Pass localPath (an absolute path) or an https url.', true)
  try {
    const [installed] = await installFonts([font], callOptions(call))
    return json({ ...installed, fontFamily: installed?.family })
  } catch (error) {
    return thrown(error)
  }
}

async function worldImportModel(args: z.output<typeof WorldImportModelInput>, call: AgentCall): Promise<McpToolResult> {
  const file = call.file
  if (!file) return text('The model was not handed over by the editor. Pass localPath (an absolute path) or an https url.', true)
  try {
    const comp = compFor(args.frameId)
    if (!isWorld(comp)) {
      return text(`"${comp.name}" is a flat comp, not a 3D world.\nHint: Models go into 3D worlds: make one with world_create (or open one) and pass its id as frameId.`, true)
    }
    const format = modelFormatOfName(file.name)
    if (!format) return text(`"${file.name}" is not a model file (glb, gltf, obj, stl or ply).`, true)
    const model = session.project.media.find((m) => m.path === file.path && m.kind === 'model')?.model ?? (await probeModelFile(file.path, format))
    const options = callOptions(call)
    const added = await session.call('media.add', { kind: 'model', name: file.name, path: file.path, mime: mediaTypeOf(file.name)?.mime, model }, options)
    if (!added.ok) return failure(added)
    const { id: assetId } = added.value as { id: string }
    const placed = await session.call(
      'world.add',
      { compId: comp.id, kind: 'mesh', assetId, position: args.position, ...(args.name !== undefined ? { name: args.name } : {}), ...(args.startMs !== undefined ? { startMs: args.startMs } : {}) },
      options,
    )
    if (!placed.ok) return failure(placed)
    const { id: layerId } = placed.value as { id: string }
    return json({ layerId, assetId, clips: model.clips.map((c) => c.name), size: model.size ?? null, format })
  } catch (error) {
    return thrown(error)
  }
}

async function mediaImport(args: z.output<typeof MediaImportInput>, call: AgentCall): Promise<McpToolResult> {
  const file = call.file
  if (!file) return text('The file was not handed over by the editor. Pass localPath as an absolute path.', true)
  try {
    const known = session.project.media.find((m) => m.path === file.path)
    let media = known ? mediaInput(known) : null
    if (!media) {
      const probed = await probeMedia(file)
      const thumbnail = probed.thumbnail
      if (thumbnail) useEditor.setState((s) => ({ thumbnails: { ...s.thumbnails, [probed.path]: thumbnail } }))
      media = mediaInput(probed)
    }
    const options = callOptions(call)
    const added = await session.call('media.add', media, options)
    if (!added.ok) return failure(added)
    const { id: mediaId, reused } = added.value as { id: string; reused?: boolean }
    if (!args.place) return json({ mediaId, reused: reused ?? false, kind: media.kind, durationMs: media.durationMs ?? null })
    const comp = compFor(args.place.compId)
    const startMs = args.place.startMs ?? useEditor.getState().timeMs
    const { input } = layerInput(media, mediaId, { compId: comp.id, startMs, x: args.place.x, y: args.place.y }, startMs)
    const created = await session.call('layer.create', input, options)
    if (!created.ok) return failure(created)
    return json({ mediaId, reused: reused ?? false, ...(created.value as object) })
  } catch (error) {
    return text(error instanceof ProbeError ? error.message : `Could not import ${file.name}: ${String(error)}`, true)
  }
}

/** Starts answering agents: lists the tools to the main process and handles each call. */
export function startAgentHost(): void {
  captureConsole()
  registerDesktopCommands()
  window.uve.agent.onCall((call) => {
    const started = Date.now()
    void answer(call)
      .catch((error: unknown) => text(`Internal error: ${error instanceof Error ? error.message : String(error)}`, true))
      .then((result) => {
        window.uve.agent.answer(call.id, result)
        useEditor.setState((s) => ({
          agentLog: [
            { at: started, client: call.client.name, tool: call.name, ok: !result.isError, ms: Date.now() - started },
            ...s.agentLog,
          ].slice(0, LOG_LIMIT),
        }))
      })
  })
  window.uve.agent.onStatus((status) => useEditor.setState({ agentStatus: status }))
  void window.uve.agent.ready(agentTools())
  void window.uve.agent.status().then((status) => useEditor.setState({ agentStatus: status }))
}
