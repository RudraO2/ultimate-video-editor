import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, shell } from 'electron'
import { startAgentServer, stopAgentServer } from './agent'
import { handleExportRequests } from './export'
import { handleFontFiles } from './fontFiles'
import { handleFontRequests } from './fonts'
import { handleIcons } from './icons'
import { handleMediaRequests, registerMediaScheme } from './media'
import { handleSoundLibrary } from './soundLibrary'
import { handleStickerLibrary } from './stickerLibrary'
import { handleCutouts } from './cutouts'
import { handleSarvam } from './sarvam'
import { guardProjectWindow, handleProjectRequests } from './project'
import { handleOpenCode, stopOpenCode } from './opencode'
import { handleRecorder, isRecording, stopRecordingForQuit } from './recorder'

// Opt-in remote debugging so agents and tests can inspect the renderer
// (for example through the Chrome DevTools MCP server on port 9222).
const debugPort = process.env.UVE_REMOTE_DEBUG_PORT
if (debugPort) app.commandLine.appendSwitch('remote-debugging-port', debugPort)

// On laptops with two GPUs, render on the discrete one: 3D worlds and their
// post effects run out of the integrated GPU's memory at 1080p. Set
// UVE_LOW_POWER_GPU=1 to stay on the integrated GPU (to save battery).
if (!process.env.UVE_LOW_POWER_GPU) app.commandLine.appendSwitch('force_high_performance_gpu')

registerMediaScheme()

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: 'Ultimate Video Editor',
    backgroundColor: '#08060a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Agents drive the editor while its window sits behind theirs or is minimized; throttled
      // timers there stall script runs, renders and exports (a 200-call script never finished).
      backgroundThrottling: false,
    },
  })

  win.once('ready-to-show', () => win.show())
  // Unsaved changes are not lost by closing the window.
  guardProjectWindow(win)

  // Links open in the system browser; the editor never spawns extra windows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  const appUrl = devServerUrl ?? pathToFileURL(join(__dirname, '../renderer/index.html')).href

  // The window only ever shows the editor. This also stops a file dropped
  // outside a drop zone from replacing the editor with the file itself.
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(appUrl)) event.preventDefault()
  })

  void win.loadURL(appUrl)
}

app.whenReady().then(() => {
  handleMediaRequests({ debug: Boolean(debugPort) })
  handleSoundLibrary()
  handleStickerLibrary()
  handleCutouts()
  handleSarvam()
  handleExportRequests({ debug: Boolean(debugPort) })
  handleProjectRequests()
  handleFontRequests()
  handleFontFiles()
  handleIcons()
  void startAgentServer()
  handleOpenCode()
  handleRecorder()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', (event) => {
  // A recording that is still running is stopped first (up to about 3 s), so its file is kept.
  if (isRecording()) {
    event.preventDefault()
    void stopRecordingForQuit().finally(() => app.quit())
    return
  }
  stopOpenCode()
  void stopAgentServer()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
