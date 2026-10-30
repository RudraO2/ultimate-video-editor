import { activeWorkRange, CommandError, type Comp, compTimeFor, type Project } from '@uve/core'
import { renderPlan } from '@uve/engine'
import type { ExportFile } from '../../../shared/export'
import { hostRequest } from '../ipc'
import { activeComp, type ExportJob, session, useEditor } from '../store'
import { encodeSpecOf } from './encode'
import { type ExportFormat, isStillFormat } from './formats'
import { audioBitrateOf, checkScale, clampFps, type ExportQuality, qualityBitrate, videoBitrateOf } from './options'
import { compHasSound, type RenderOptions, renderComp } from './render'

/** What an export is asked for, by AtomCut's option names; every field may be left out. */
export interface ExportSettings {
  format?: ExportFormat
  /** `full` is the whole comp; `span` the working range. Default: the working range when it is on for the comp. */
  range?: 'full' | 'span'
  /** Picks the video bitrate (`qualityBitrate`); default `high`. */
  quality?: ExportQuality
  /** Overrides the quality, as `videoBitrateOf` reads it. */
  videoBitrate?: number
  /** As `audioBitrateOf` reads it; default 192 kbps. */
  audioBitrate?: number
  scale?: number
  fps?: number
  includeAudio?: boolean
  motionBlur?: boolean
  /** Leaves the comp's background out and keeps the picture's alpha: every format but MP4, audio and JPG. Default false. */
  transparent?: boolean
  /** A still's moment in comp time; default the playhead (a static frame always shows its still). Stills only. */
  atMs?: number
}

/** JPEG and WebP quality per step (1 is lossless WebP). */
const IMAGE_QUALITY: Record<ExportQuality, number> = { draft: 0.8, high: 0.92, master: 1 }

/** The format an export takes when none is asked for: a PNG still for a static frame, else an MP4. */
export function defaultExportFormat(comp: Comp): ExportFormat {
  return comp.mode === 'static' ? 'png' : 'mp4'
}

/** The render options an export's settings come to for `comp`, checked before any file is opened. Throws a command error with a hint. */
export function exportRenderOptions(project: Project, comp: Comp, settings: ExportSettings = {}): Omit<RenderOptions, 'write' | 'writeFile' | 'onProgress' | 'signal'> {
  const format = settings.format ?? defaultExportFormat(comp)
  const encode = encodeSpecOf(format)
  const scale = checkScale(settings.scale ?? 1)
  const transparent = settings.transparent === true
  checkTransparent(format, transparent)
  if (isStillFormat(format)) {
    // As view_render: past the end shows the last moment, and a static frame its still.
    const atMs = compTimeFor(comp, Math.min(settings.atMs ?? useEditor.getState().timeMs, comp.durationMs))
    return {
      encode,
      scale,
      atMs,
      motionBlur: settings.motionBlur !== false,
      transparent,
      ...(format !== 'png' ? { imageQuality: IMAGE_QUALITY[settings.quality ?? 'high'] } : {}),
    }
  }
  if (settings.atMs !== undefined) {
    throw new CommandError('atMs is only for stills (png, jpg, webp).', 'Leave atMs out, or set format to a still. A video takes its span from range and the working range.')
  }
  assertExportsAsVideo(comp)
  let span = exportSpan(comp)
  if (settings.range === 'full') span = undefined
  else if (settings.range === 'span' && !span) {
    throw new CommandError(
      `The working range is not on for "${comp.name}".`,
      "Set one with session_set {workRange: {startMs, endMs}}, or use range: 'full' (the default when no range is on).",
    )
  }
  // GIF delays are whole hundredths of a second: at most 50 fps.
  const asked = settings.fps === undefined ? undefined : clampFps(settings.fps)
  const fps = encode.maxFps !== undefined && (asked ?? comp.fps) > encode.maxFps ? encode.maxFps : asked
  const includeAudio = settings.includeAudio !== false
  if (!encode.video) {
    if (!includeAudio) throw new CommandError('An audio-only export with includeAudio: false would write nothing.', 'Leave includeAudio out, or export a video format.')
    if (!compHasSound(project, comp)) {
      throw new CommandError(
        `"${comp.name}" makes no sound, so there is nothing to export as audio.`,
        'Add sound first (media_import a file with sound, sounds_use, or sounds on an animation), or export a video format such as mp4.',
      )
    }
  }
  const plan = renderPlan(comp, span, { scale, ...(fps !== undefined ? { fps } : {}) })
  const bitrated = typeof encode.video === 'object' && encode.video !== null
  return {
    encode,
    ...(span ? { span } : {}),
    scale,
    ...(fps !== undefined ? { fps } : {}),
    ...(bitrated
      ? {
          videoBitrate:
            settings.videoBitrate !== undefined
              ? videoBitrateOf(settings.videoBitrate)
              : qualityBitrate(settings.quality ?? 'high', plan.width, plan.height, plan.fps),
        }
      : {}),
    ...(settings.audioBitrate !== undefined ? { audioBitrate: audioBitrateOf(settings.audioBitrate) } : {}),
    includeAudio,
    motionBlur: settings.motionBlur !== false,
    transparent,
  }
}

/** Progress reaches the dialog at most this often, in ms. */
const PROGRESS_INTERVAL_MS = 100

let running: AbortController | null = null

/** Refuses transparency for a format that cannot keep it, with the formats that can. */
function checkTransparent(format: ExportFormat, transparent: boolean): void {
  const encode = encodeSpecOf(format)
  if (!transparent || encode.alpha) return
  throw new CommandError(
    `${encode.label} cannot keep transparency.`,
    format === 'jpg'
      ? "Use format 'png' or 'webp' for a still with alpha, or leave transparent out."
      : encode.video
        ? "Use format 'mov' (lossless PNG frames with alpha), 'webm' (VP9 with an alpha stream), 'gif' or 'png-seq', or leave transparent out."
        : 'An audio file has no picture: leave transparent out.',
  )
}

/** Refuses a static frame for every format but stills: it is one picture. */
export function assertExportsAsVideo(comp: Comp): void {
  if (comp.mode !== 'static') return
  throw new CommandError(
    `"${comp.name}" is a static frame, so it cannot export as a video, GIF or sequence.`,
    "Export it as a still (format 'png', the default for a static frame, 'jpg' or 'webp'), or switch the frame to timeline mode (Mode in the inspector, or frame_update {mode: 'timeline'}).",
  )
}

/** The working range in force on `comp`, as a span for the render, or undefined when the whole comp is exported. */
export function exportSpan(comp: Comp): { startMs: number; endMs: number } | undefined {
  const { workRange, workRangeEnabled } = useEditor.getState()
  return activeWorkRange(workRange, workRangeEnabled, comp.id) ?? undefined
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

function update(patch: Partial<ExportJob>): void {
  const job = useEditor.getState().exportJob
  if (job) useEditor.setState({ exportJob: { ...job, ...patch } })
}

/**
 * Renders `comp` into an opened export file, showing progress in the export
 * dialog. The project is the snapshot taken when the export started. Resolves
 * with the finished job, or null when it was cancelled. `render` holds the
 * span, format and options (see `exportRenderOptions`); default a whole MP4.
 */
export async function exportTo(
  project: Project,
  comp: Comp,
  file: ExportFile,
  render: Omit<RenderOptions, 'write' | 'writeFile' | 'onProgress' | 'signal'> = {},
): Promise<ExportJob | null> {
  if (running) throw new Error('An export is already running.')
  const abort = new AbortController()
  running = abort
  useEditor.setState({
    playing: false,
    exportJob: {
      fileName: file.name,
      path: file.path,
      status: 'rendering',
      soundOnly: render.encode?.video === null,
      frame: 0,
      frameCount: 0,
      startedAt: Date.now(),
      finishedAt: null,
      bytes: 0,
      error: null,
      note: null,
    },
  })

  let bytes = 0
  let shownAt = 0
  try {
    const result = await renderComp(project, comp, {
      ...render,
      write: async (position, data) => {
        await window.uve.export.write(file.id, position, data)
        bytes = Math.max(bytes, position + data.byteLength)
      },
      writeFile: async (name, data) => {
        await window.uve.export.writeFile(file.id, name, data)
        bytes += data.byteLength
      },
      onProgress: (frame, frameCount) => {
        const now = performance.now()
        if (now - shownAt < PROGRESS_INTERVAL_MS && frame < frameCount) return
        shownAt = now
        update({ frame, frameCount, bytes })
      },
      signal: abort.signal,
    })
    await window.uve.export.end(file.id, true)
    update({
      status: 'done',
      finishedAt: Date.now(),
      bytes,
      result,
      note: result.clippedSamples > 0 ? 'Some sound was louder than the file can hold and was clipped.' : null,
    })
  } catch (error) {
    await window.uve.export.end(file.id, false).catch(() => undefined)
    if (abort.signal.aborted) {
      useEditor.setState({ exportJob: null })
      useEditor.getState().notify('Export cancelled.')
    } else {
      console.error('Export failed', error)
      update({ status: 'failed', finishedAt: Date.now(), error: messageOf(error) })
    }
  } finally {
    running = null
  }
  return useEditor.getState().exportJob
}

/** Remote debugging only: where the export dialog's exports go instead of the save dialog (a file path with the format's extension, or a folder for a PNG sequence). */
let debugTarget: string | null = null

/** Development builds only (remote debugging on): sends the dialog's next exports to `path` without the save dialog; null restores it. */
export function setDebugExportTarget(path: string | null): void {
  debugTarget = path
}

/**
 * Exports the comp in the viewport with the export dialog's settings: asks
 * where to save it (a folder for a PNG sequence), then renders it. Settings
 * that cannot be met show as an error toast (the dialog checks them first).
 */
export async function exportActiveComp(settings: ExportSettings = {}): Promise<void> {
  if (running) return
  const state = useEditor.getState()
  const comp = activeComp(state)
  // The project as it was when the user asked: edits made meanwhile are not part of this export.
  const project = state.project
  let render: ReturnType<typeof exportRenderOptions>
  try {
    render = exportRenderOptions(project, comp, settings)
  } catch (error) {
    state.notify(error instanceof CommandError && error.hint ? `${error.message} ${error.hint}` : messageOf(error), 'error')
    return
  }
  const folder = render.encode?.container === 'png-seq'
  const extension = render.encode?.extension ?? 'mp4'
  let file: ExportFile | null
  try {
    if (debugTarget) {
      file = folder
        ? await window.uve.export.beginFolderAt(debugTarget, comp.name, true)
        : await window.uve.export.beginForDebug(debugTarget)
    } else {
      file = folder ? await window.uve.export.beginFolder(comp.name) : await window.uve.export.begin(comp.name, extension)
    }
  } catch (error) {
    state.notify(`Could not create the file: ${messageOf(error)}`, 'error')
    return
  }
  if (file) await exportTo(project, comp, file, render)
}

/**
 * Exports `comp` without a dialog (for agents): to `path`, an absolute one, or
 * with null to the comp's name in the Videos folder, with the extension of
 * the format. The progress shows in the export dialog. Resolves with the
 * finished or failed job, or null when the user cancelled it; throws a
 * command error for settings that cannot be met, and an error when the file
 * cannot be opened. `settings.format` must be one `parseExportFormat` accepted.
 */
export async function exportCompTo(
  comp: Comp,
  path: string | null,
  overwrite: boolean,
  settings: ExportSettings = {},
): Promise<ExportJob | null> {
  if (running) throw new Error('An export is already running. Wait for it to finish.')
  // The project after every queued edit: an empty transaction runs last and makes no undo step.
  const project = await session.transact('', async () => session.project)
  const render = exportRenderOptions(project, comp, settings)
  // A PNG sequence is a folder of files; every other format one file.
  const file = await hostRequest(
    render.encode?.container === 'png-seq'
      ? window.uve.export.beginFolderAt(path, comp.name, overwrite)
      : window.uve.export.beginAt(path, comp.name, overwrite, render.encode?.extension ?? 'mp4'),
  )
  try {
    return await exportTo(project, comp, file, render)
  } catch (error) {
    // Another export started meanwhile: the file opened for this one is removed.
    await window.uve.export.end(file.id, false).catch(() => undefined)
    throw error
  }
}

/** Development builds only (remote debugging on): exports the comp in the viewport to `path` (its extension must match the format) without the dialog. */
export async function exportForDebug(path: string, settings: ExportSettings = {}): Promise<ExportJob | null> {
  const state = useEditor.getState()
  const comp = activeComp(state)
  const render = exportRenderOptions(state.project, comp, settings)
  if (render.encode?.container === 'png-seq') throw new Error('A PNG sequence is a folder: export it with export_video.')
  const file = await window.uve.export.beginForDebug(path)
  return exportTo(state.project, comp, file, render)
}

export function cancelExport(): void {
  running?.abort()
}

/** Closes the dialog of a finished or failed export. */
export function dismissExport(): void {
  if (!running) useEditor.setState({ exportJob: null })
}
