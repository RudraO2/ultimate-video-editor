import { type ChildProcessByStdio, spawn } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { app, BrowserWindow, desktopCapturer, type Display, ipcMain, screen } from 'electron'
import { type CursorRecording, mfraSizeFromTail,
  CURSOR_SAMPLE_INTERVAL_MS,
  captureHelperConfig,
  countClicks,
  CursorCollector,
  cursorSidecarPath,
  MAX_RECORDING_MS,
  parseHelperLine,
  parseSamplerLine,
  type PixelRect,
  type RecorderState,
  type RecordingError,
  type RecordingOptions,
  type RecordingOutcome,
  type RecordingSource,
  recordingFileName,
} from '../shared/recording'
import { grant, isGranted } from './media'
import { helperContents } from './windows'

// Screen recording: OpenScreen's two Windows helpers (wgc-capture records the
// screen, cursor-sampler follows the mouse) run as child processes. This module
// starts and stops them, keeps the cursor sidecar, shows a small Stop window
// that the capture leaves out, and tells the editor windows how it is going.

type Helper = ChildProcessByStdio<Writable, Readable, Readable>
type StartOutcome = { ok: true } | ({ ok: false } & RecordingError)

interface SourceEntry {
  info: RecordingSource
  display: Display | null
}

interface Session {
  sourceName: string
  outputPath: string
  helper: Helper
  sampler: Helper | null
  collector: CursorCollector
  surfaceKind: 'display' | 'window'
  surfaceBounds: PixelRect
  /** The window's own bounds as the sampler last sent them. */
  lastWindowBounds: PixelRect | null
  startedAt: number
  /** The file the helper said it wrote (`recording-stopped`), when it said. */
  screenPath: string | null
  hud: BrowserWindow | null
  minimised: BrowserWindow[]
  timer: NodeJS.Timeout | null
  exited: Promise<void>
  stopped: Promise<void>
  stopping: Promise<RecordingOutcome> | null
}

const HUD_WIDTH = 190
const HUD_HEIGHT = 44
const STARTUP_TIMEOUT_MS = 20_000
const SAMPLER_READY_TIMEOUT_MS = 3_000
const STOP_TIMEOUT_MS = 25_000
const FLUSH_GRACE_MS = 1_500
const QUIT_WAIT_MS = 3_000
const MINIMISE_SETTLE_MS = 400

let state: RecorderState = { state: 'idle' }
/** True from the start of a start request until the recorder is idle again. */
let busy = false
let session: Session | null = null
/** The Stop window of the recording that is starting or running. */
let hud: BrowserWindow | null = null

const fail = (error: string, hint?: string, detail?: string): { ok: false } & RecordingError => ({
  ok: false,
  error: detail ? `${error} (${detail})` : error,
  ...(hint ? { hint } : {}),
})

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function editorWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w !== hud)
}

function send(channel: string, payload: unknown): void {
  for (const win of editorWindows()) win.webContents.send(channel, payload)
}

function setState(next: RecorderState): void {
  state = next
  send('recorder:state', state)
}

function helperPath(name: string, envVar: string): string | null {
  const fromEnv = process.env[envVar]
  const candidates = [
    ...(fromEnv ? [fromEnv] : []),
    join(app.getAppPath(), 'native', 'bin', 'win32-x64', name),
    join(process.resourcesPath, 'native', 'bin', 'win32-x64', name),
  ]
  return candidates.find((path) => existsSync(path)) ?? null
}

/** Reads a stream line by line. */
function onLines(stream: Readable, handler: (line: string) => void): void {
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    buffer += chunk
    let at = buffer.indexOf('\n')
    while (at >= 0) {
      handler(buffer.slice(0, at))
      buffer = buffer.slice(at + 1)
      at = buffer.indexOf('\n')
    }
  })
}

/** The size of a display in physical pixels (the helpers work in those). */
function physicalBounds(display: Display): PixelRect {
  const rect = process.platform === 'win32' ? screen.dipToScreenRect(null, display.bounds) : display.bounds
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
}

async function listSources(withThumbnails: boolean): Promise<SourceEntry[]> {
  const raw = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: withThumbnails ? { width: 240, height: 135 } : { width: 0, height: 0 },
  })
  const displays = screen.getAllDisplays()
  const primaryId = screen.getPrimaryDisplay().id
  const ownIds = new Set(BrowserWindow.getAllWindows().map((w) => (w.isDestroyed() ? '' : w.getMediaSourceId())))
  const thumbnailOf = (image: Electron.NativeImage): string | null => (withThumbnails && !image.isEmpty() ? image.toDataURL() : null)

  const screens: SourceEntry[] = []
  let screenIndex = 0
  for (const source of raw) {
    if (!source.id.startsWith('screen:')) continue
    // display_id is the display's id; when it is empty, the n-th screen is the n-th display.
    const display = displays.find((d) => String(d.id) === source.display_id) ?? displays[screenIndex] ?? null
    screenIndex += 1
    const bounds = display ? physicalBounds(display) : null
    const primary = display?.id === primaryId
    const number = display ? displays.indexOf(display) + 1 : screenIndex
    const size = bounds ? ` (${bounds.width}×${bounds.height})` : ''
    screens.push({
      display,
      info: {
        id: source.id,
        kind: 'display',
        name: `Display ${number}${size}${primary ? ', main' : ''}`,
        thumbnail: thumbnailOf(source.thumbnail),
        primary,
      },
    })
  }
  screens.sort((a, b) => Number(b.info.primary) - Number(a.info.primary) || a.info.name.localeCompare(b.info.name))

  const windows: SourceEntry[] = []
  for (const source of raw) {
    if (!source.id.startsWith('window:')) continue
    if (ownIds.has(source.id) || source.name.trim() === '') continue
    windows.push({
      display: null,
      info: { id: source.id, kind: 'window', name: source.name, thumbnail: thumbnailOf(source.thumbnail), primary: false },
    })
  }
  return [...screens, ...windows]
}

/** A file name in the folder that is not taken: "Recording ….mp4", then "Recording … (2).mp4". */
function freeFileName(folder: string, name: string): string {
  const dot = name.lastIndexOf('.')
  const stem = name.slice(0, dot)
  const extension = name.slice(dot)
  let candidate = name
  for (let n = 2; existsSync(join(folder, candidate)); n += 1) candidate = `${stem} (${n})${extension}`
  return candidate
}

// The Stop window is outside the themed renderer: it is a data page with its
// own few fixed colours, and it has no access to the app.
const HUD_HTML = `<!doctype html><meta charset="utf-8"><title>Recording</title><style>
/* Outside the themed renderer: fixed colours on purpose. */
html,body{margin:0;height:100%;background:transparent;overflow:hidden;user-select:none;font:600 13px system-ui,"Segoe UI",sans-serif;color:#fff}
.bar{box-sizing:border-box;width:100%;height:100%;display:flex;align-items:center;gap:10px;padding:0 6px 0 16px;border-radius:22px;background:rgba(24,22,28,.94);border:1px solid rgba(255,255,255,.16);-webkit-app-region:drag}
.dot{width:10px;height:10px;border-radius:50%;background:#ef4444;animation:blink 1.2s ease-in-out infinite}
@keyframes blink{50%{opacity:.35}}
.time{flex:1;font-variant-numeric:tabular-nums}
button{-webkit-app-region:no-drag;height:32px;padding:0 14px;border:0;border-radius:16px;background:#ef4444;color:#fff;font:inherit;cursor:pointer}
button:hover{background:#dc2626}
</style><div class="bar"><span class="dot"></span><span class="time" id="t">00:00</span><button id="s">Stop</button></div><script>
var start=Number(location.hash.slice(1))||Date.now();
function two(n){return n<10?'0'+n:''+n}
function tick(){var s=Math.max(0,Math.floor((Date.now()-start)/1000));document.getElementById('t').textContent=two(Math.floor(s/60))+':'+two(s%60)}
tick();setInterval(tick,250);
document.getElementById('s').addEventListener('click',function(){document.title='uve-stop';location.href='uve-hud://stop'});
</script>`

function openHud(display: Display, startedAt: number): BrowserWindow {
  const area = display.workArea
  const win = new BrowserWindow({
    width: HUD_WIDTH,
    height: HUD_HEIGHT,
    x: area.x + Math.round((area.width - HUD_WIDTH) / 2),
    y: area.y + 12,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    hasShadow: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  })
  helperContents.add(win.webContents)
  win.setAlwaysOnTop(true, 'screen-saver')
  // The capture leaves this window out of the video.
  win.setContentProtection(true)
  const stop = (): void => {
    void stopRecording()
  }
  win.webContents.on('will-navigate', (event) => {
    event.preventDefault()
    stop()
  })
  win.webContents.on('page-title-updated', (_event, title) => {
    if (title === 'uve-stop') stop()
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.once('ready-to-show', () => win.showInactive())
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(HUD_HTML)}#${startedAt}`)
  return win
}

function closeHud(): void {
  if (hud && !hud.isDestroyed()) hud.destroy()
  hud = null
}

function restoreWindows(windows: BrowserWindow[]): void {
  for (const win of windows) if (!win.isDestroyed()) win.restore()
  const first = windows.find((w) => !w.isDestroyed())
  if (first) first.focus()
}

function killQuietly(child: Helper | null): void {
  if (!child) return
  try {
    child.kill()
  } catch {
    // Already gone.
  }
}

function spawnHelper(exe: string, args: string[]): Helper {
  const child = spawn(exe, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  // A helper that died leaves stdin broken; writing `stop` to it must not throw.
  child.stdin.on('error', () => {})
  return child
}

async function start(raw: unknown): Promise<StartOutcome> {
  if (process.platform !== 'win32') return fail('Screen recording works on Windows for now.')
  if (busy) return fail('A recording is already running.')
  busy = true

  const options: RecordingOptions = typeof raw === 'object' && raw !== null ? (raw as RecordingOptions) : {}
  const minimised: BrowserWindow[] = []
  let sampler: Helper | null = null
  let helper: Helper | null = null
  const abort = (error: string, hint?: string, detail?: string): StartOutcome => {
    killQuietly(sampler)
    killQuietly(helper)
    closeHud()
    restoreWindows(minimised)
    busy = false
    setState({ state: 'idle' })
    return fail(error, hint, detail)
  }

  try {
    const wgcExe = helperPath('wgc-capture.exe', 'UVE_WGC_CAPTURE_EXE')
    if (!wgcExe) {
      busy = false
      return fail('The screen recorder program is missing.', 'Build it with "node apps/desktop/scripts/build-wgc.mjs", or reinstall the app.')
    }
    const samplerExe = helperPath('cursor-sampler.exe', 'UVE_CURSOR_SAMPLER_EXE')

    // Resolve the source: the main display unless one was asked for.
    const sources = await listSources(false)
    const wanted = typeof options.sourceId === 'string' && options.sourceId !== '' ? options.sourceId : null
    const entry = wanted ? sources.find((s) => s.info.id === wanted) : (sources.find((s) => s.info.primary) ?? sources.find((s) => s.info.kind === 'display'))
    if (!entry) {
      busy = false
      return fail(wanted ? 'That screen or window is not available any more.' : 'No screen was found to record.', 'Pick one from the list again.')
    }

    const fps = options.fps === 30 ? 30 : 60
    const systemAudio = options.systemAudio !== false
    const microphone = options.microphone === true
    const webcam = options.webcam === true
    const durationMs =
      typeof options.durationMs === 'number' && Number.isFinite(options.durationMs)
        ? Math.min(MAX_RECORDING_MS, Math.max(1000, Math.round(options.durationMs)))
        : null

    const hudDisplay = entry.display ?? screen.getPrimaryDisplay()
    const surfaceKind = entry.info.kind
    const surfaceBounds: PixelRect = entry.display ? physicalBounds(entry.display) : { x: 0, y: 0, width: 1, height: 1 }
    const sourceName = entry.info.name
    setState({ state: 'starting', sourceName })

    const folder = join(app.getPath('videos'), 'UVE recordings')
    await fs.mkdir(folder, { recursive: true })
    const outputPath = join(folder, freeFileName(folder, recordingFileName(new Date())))

    // Recording a display: get the editor out of the picture first.
    if (entry.display) {
      for (const win of editorWindows()) {
        if (win.isVisible() && !win.isMinimized()) {
          win.minimize()
          minimised.push(win)
        }
      }
      if (minimised.length > 0) await delay(MINIMISE_SETTLE_MS)
    }

    const config = captureHelperConfig({
      outputPath,
      source: entry.display
        ? { kind: 'display', displayId: entry.display.id, bounds: surfaceBounds }
        : { kind: 'window', sourceId: entry.info.id },
      fps,
      systemAudio,
      microphone,
      webcam,
    })

    const collector = new CursorCollector(surfaceBounds, Date.now())
    let lastWindowBounds: PixelRect | null = null

    // The cursor sampler first; without it the video is still recorded.
    if (samplerExe) {
      const hwnd = entry.info.kind === 'window' ? (entry.info.id.split(':')[1] ?? 'null') : 'null'
      const child = spawnHelper(samplerExe, [String(CURSOR_SAMPLE_INTERVAL_MS), hwnd])
      sampler = child
      let markReady: (ok: boolean) => void = () => {}
      const ready = new Promise<boolean>((resolve) => {
        markReady = resolve
      })
      onLines(child.stdout, (line) => {
        const event = parseSamplerLine(line)
        if (!event) return
        if (event.type === 'ready') markReady(true)
        else if (event.type === 'error') console.warn('[recorder] cursor sampler:', event.message)
        else {
          if (event.bounds) lastWindowBounds = event.bounds
          collector.add(event)
          if (session) session.lastWindowBounds = lastWindowBounds
        }
      })
      child.once('exit', () => markReady(false))
      child.once('error', () => markReady(false))
      const ok = await Promise.race([ready, delay(SAMPLER_READY_TIMEOUT_MS).then(() => false)])
      if (!ok) {
        console.warn('[recorder] cursor sampler did not start; recording without cursor data')
        killQuietly(child)
        sampler = null
      }
    }

    // The capture helper.
    const diagnostics: string[] = []
    let helperError = ''
    const child = spawnHelper(wgcExe, [JSON.stringify(config)])
    helper = child
    let markStarted: () => void = () => {}
    const startedEvent = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    let markStopped: () => void = () => {}
    const stoppedEvent = new Promise<void>((resolve) => {
      markStopped = resolve
    })
    let markExited: () => void = () => {}
    const exited = new Promise<void>((resolve) => {
      markExited = resolve
    })
    let screenPath: string | null = null
    onLines(child.stdout, (line) => {
      const event = parseHelperLine(line)
      if (!event) return
      if (event.event === 'recording-started') markStarted()
      else if (event.event === 'recording-stopped') {
        if (typeof event.screenPath === 'string' && event.screenPath !== '') {
          screenPath = event.screenPath
          if (session) session.screenPath = event.screenPath
        }
        markStopped()
      } else if (event.event === 'warning' || event.event === 'error') {
        const message = typeof event.message === 'string' ? event.message : JSON.stringify(event)
        if (event.event === 'error') helperError = message
        console.warn(`[recorder] wgc-capture ${event.event}:`, message)
      }
    })
    onLines(child.stderr, (line) => {
      if (line.trim() !== '') diagnostics.push(line.trim())
      if (diagnostics.length > 8) diagnostics.shift()
    })
    child.once('exit', () => markExited())
    child.once('error', (error) => {
      diagnostics.push(error.message)
      markExited()
    })

    const outcome = await Promise.race([
      startedEvent.then(() => 'started' as const),
      exited.then(() => 'exited' as const),
      delay(STARTUP_TIMEOUT_MS).then(() => 'timeout' as const),
    ])
    if (outcome !== 'started') {
      const detail = helperError || diagnostics.slice(-2).join(' | ') || undefined
      return abort(
        outcome === 'timeout' ? 'The screen recorder did not start in time.' : 'The screen recorder stopped before it started.',
        'Check that the screen or window is still there, then try again.',
        detail,
      )
    }

    const startedAt = Date.now()
    collector.setStart(startedAt)
    hud = openHud(hudDisplay, startedAt)
    const live: Session = {
      sourceName,
      outputPath,
      helper: child,
      sampler,
      collector,
      surfaceKind,
      surfaceBounds,
      lastWindowBounds,
      startedAt,
      screenPath,
      hud,
      minimised,
      timer: durationMs === null ? null : setTimeout(() => void stopRecording(), durationMs),
      exited,
      stopped: stoppedEvent,
      stopping: null,
    }
    session = live
    setState({ state: 'recording', sourceName, startedAt, durationMs })
    // A helper that dies mid-recording ends the recording; the fragmented MP4 keeps what was written.
    void exited.then(() => {
      if (session === live) void stopRecording()
    })
    return { ok: true }
  } catch (error) {
    return abort('The recording could not be started.', 'Try again.', error instanceof Error ? error.message : String(error))
  }
}

/**
 * Cuts the fragment index (`mfra`) off the end of the helper's fragmented MP4.
 * Media Foundation stamps its entries with nominal frame times, and mediabunny
 * places fragments by them: a 14.25 s recording read as 15.04 s, and its frames
 * drifted 5 % late. Without the index every reader walks the fragments' own
 * sample durations, the true timing (ffprobe and Chromium agree). Returns the new size.
 */
async function dropFragmentIndex(path: string, size: number): Promise<number> {
  try {
    const file = await fs.open(path, 'r+')
    try {
      const tail = Buffer.alloc(16)
      await file.read(tail, 0, 16, size - 16)
      const index = mfraSizeFromTail(tail)
      if (index === null || index > size) return size
      const head = Buffer.alloc(8)
      await file.read(head, 0, 8, size - index)
      if (head.toString('latin1', 4, 8) !== 'mfra') return size
      await file.truncate(size - index)
      return size - index
    } finally {
      await file.close()
    }
  } catch (error) {
    console.warn('[recorder] fragment index kept:', error)
    return size
  }
}

function stopRecording(): Promise<RecordingOutcome> {
  const live = session
  if (!live) return Promise.resolve(fail('No recording is running.'))
  live.stopping ??= finish(live)
  return live.stopping
}

async function finish(live: Session): Promise<RecordingOutcome> {
  if (live.timer) clearTimeout(live.timer)
  live.timer = null
  const elapsedMs = Date.now() - live.startedAt
  setState({ state: 'stopping', sourceName: live.sourceName })

  let outcome: RecordingOutcome
  try {
    try {
      live.helper.stdin.write('stop\n')
    } catch {
      // The helper is gone already.
    }
    const waited = await Promise.race([
      live.stopped.then(() => 'stopped' as const),
      live.exited.then(() => 'exited' as const),
      delay(STOP_TIMEOUT_MS).then(() => 'timeout' as const),
    ])
    // The file is closed when the helper exits; give it a moment after it said it stopped.
    if (waited === 'stopped') await Promise.race([live.exited, delay(FLUSH_GRACE_MS)])
    killQuietly(live.helper)
    killQuietly(live.sampler)

    const path = live.screenPath ?? live.outputPath
    let size = 0
    try {
      size = (await fs.stat(path)).size
    } catch {
      size = 0
    }
    if (size > 0) size = await dropFragmentIndex(path, size)
    if (size === 0) {
      outcome = fail('The recording could not be saved.', 'Try again, and check that the Videos folder has free space.')
    } else {
      const surface = {
        kind: live.surfaceKind,
        name: live.sourceName,
        ...(live.surfaceKind === 'window' ? (live.lastWindowBounds ?? live.surfaceBounds) : live.surfaceBounds),
      }
      const sidecar = live.collector.finish(surface)
      let cursorPath: string | null = null
      if (sidecar.samples.length > 0) {
        try {
          await fs.writeFile(cursorSidecarPath(path), JSON.stringify(sidecar))
          cursorPath = cursorSidecarPath(path)
        } catch (error) {
          console.warn('[recorder] cursor sidecar not written:', error)
        }
      }
      const granted = await grant([path])
      outcome = {
        ok: true,
        path,
        name: granted[0]?.name ?? basename(path),
        size: granted[0]?.size ?? size,
        cursorPath,
        sourceName: live.sourceName,
        elapsedMs,
        cursorSamples: sidecar.samples.length,
        clicks: countClicks(sidecar),
      }
    }
  } catch (error) {
    outcome = fail('The recording could not be saved.', undefined, error instanceof Error ? error.message : String(error))
  }

  closeHud()
  restoreWindows(live.minimised)
  session = null
  busy = false
  setState({ state: 'idle' })
  send('recorder:finished', outcome)
  return outcome
}

/** Whether a recording is starting or running. */
export function isRecording(): boolean {
  return busy
}

/** Writes `stop` to a running recording and waits at most about 3 s for it; then ends it by force. */
export async function stopRecordingForQuit(): Promise<void> {
  const live = session
  if (live) await Promise.race([stopRecording(), delay(QUIT_WAIT_MS)])
  if (session === live && live) {
    if (live.timer) clearTimeout(live.timer)
    killQuietly(live.helper)
    killQuietly(live.sampler)
    session = null
  }
  closeHud()
  busy = false
}

/** Registers the recorder's IPC handlers. */
export function handleRecorder(): void {
  ipcMain.handle('recorder:sources', async (): Promise<RecordingSource[]> => (await listSources(true)).map((entry) => entry.info))
  ipcMain.handle('recorder:start', (_event, options: unknown) => start(options))
  ipcMain.handle('recorder:stop', () => stopRecording())
  ipcMain.handle('recorder:state', () => state)
  // The cursor sidecar of a granted media file (`<video>.cursor.json`), or null when it has none.
  ipcMain.handle('recorder:cursor', async (_event, videoPath: unknown) => {
    if (typeof videoPath !== 'string' || !isGranted(videoPath)) return null
    try {
      return JSON.parse(await fs.readFile(cursorSidecarPath(videoPath), 'utf8')) as CursorRecording
    } catch {
      return null
    }
  })
}
