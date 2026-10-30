import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, type MessageBoxOptions, type WebContents } from 'electron'
import {
  addRecent,
  mediaPathsIn,
  type OpenedProjectFile,
  PROJECT_EXTENSION,
  parseRecent,
  projectFileName,
  type ProjectWindowState,
  type RecentProject,
  type SaveChoice,
  withProjectExtension,
} from '../shared/project'
import { grant } from './media'

// Project files are written and read here; the renderer builds and parses
// their JSON. Writes go to a temporary file first and then replace the old
// file, so a crash mid-save never leaves a half-written project. Opening a
// project grants the media files it lists, so the editor can load them.

/** Larger files are refused: a project holds no media, so this is far beyond any real one. */
const MAX_PROJECT_BYTES = 256 * 1024 * 1024
const FILTERS = [{ name: 'Ultimate Video Editor project', extensions: [PROJECT_EXTENSION.slice(1)] }]

const recentFile = () => join(app.getPath('userData'), 'recent-projects.json')
let recent: RecentProject[] | null = null

async function recentList(): Promise<RecentProject[]> {
  if (recent) return recent
  try {
    recent = parseRecent(JSON.parse(await fs.readFile(recentFile(), 'utf8')))
  } catch {
    recent = []
  }
  return recent
}

/** Recent projects are listed by file name: project names are often left as "Untitled project". */
async function remember(path: string): Promise<void> {
  recent = addRecent(await recentList(), { path, name: basename(path, PROJECT_EXTENSION), at: Date.now() })
  await fs.writeFile(recentFile(), JSON.stringify(recent, null, 2)).catch(() => undefined)
}

/** A path the renderer sent, checked: absolute, and a project file. */
function projectPath(raw: unknown): string {
  if (typeof raw !== 'string' || !isAbsolute(raw)) throw new Error('Give the project file as an absolute path.')
  return resolve(withProjectExtension(raw))
}

async function writeProject(rawPath: unknown, text: unknown): Promise<{ path: string; name: string }> {
  const path = projectPath(rawPath)
  if (typeof text !== 'string') throw new Error('Nothing to save.')
  try {
    if (!(await fs.stat(dirname(path))).isDirectory()) throw new Error()
  } catch {
    throw new Error(`The folder ${dirname(path)} does not exist.`)
  }
  const temp = `${path}.${randomUUID().slice(0, 8)}.tmp`
  try {
    await fs.writeFile(temp, text, 'utf8')
    await fs.rename(temp, path)
  } catch (error) {
    await fs.rm(temp, { force: true })
    throw error
  }
  await remember(path)
  return { path, name: basename(path) }
}

async function readProject(rawPath: unknown): Promise<OpenedProjectFile> {
  const path = projectPath(rawPath)
  let size: number
  try {
    const stat = await fs.stat(path)
    if (!stat.isFile()) throw new Error()
    size = stat.size
  } catch {
    throw new Error(`There is no project file at ${path}.`)
  }
  if (size > MAX_PROJECT_BYTES) throw new Error('That file is too large to be a project file.')
  const text = await fs.readFile(path, 'utf8')
  const wanted = mediaPathsIn(text)
  const found = new Set((await grant(wanted)).map((f) => f.path))
  const missing = wanted.filter((p) => !isAbsolute(p) || !found.has(resolve(p)))
  await remember(path)
  return { path, text, missing }
}

const windowStates = new Map<number, ProjectWindowState>()
/** Windows whose next close is not questioned: the user already answered. */
const closing = new Set<number>()

async function askToSave(win: BrowserWindow | null, name: string): Promise<SaveChoice> {
  const options: MessageBoxOptions = {
    type: 'warning',
    buttons: ['Save', "Don't save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    title: 'Unsaved changes',
    message: `Do you want to save the changes you made to “${name}”?`,
    detail: "Your changes will be lost if you don't save them.",
  }
  const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
  return response === 0 ? 'save' : response === 1 ? 'discard' : 'cancel'
}

/** Asks before a window with unsaved changes closes. Saving is done by the renderer, which then closes the window. */
export function guardProjectWindow(win: BrowserWindow): void {
  const id = win.webContents.id
  win.on('close', (event) => {
    const state = windowStates.get(id)
    if (closing.has(id) || !state?.dirty) return
    event.preventDefault()
    void askToSave(win, state.name).then((choice) => {
      if (choice === 'cancel' || win.isDestroyed()) return
      if (choice === 'save') {
        win.webContents.send('project:save-before-close')
        return
      }
      closing.add(id)
      win.close()
    })
  })
  win.on('closed', () => {
    windowStates.delete(id)
    closing.delete(id)
  })
}

function senderWindow(sender: WebContents): BrowserWindow | null {
  return BrowserWindow.fromWebContents(sender)
}

export function handleProjectRequests(): void {
  ipcMain.handle('project:choose-save', async (event, name: unknown) => {
    const win = senderWindow(event.sender)
    const options = {
      title: 'Save project',
      defaultPath: join(app.getPath('documents'), projectFileName(typeof name === 'string' ? name : '')),
      filters: FILTERS,
    }
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    return result.canceled || !result.filePath ? null : withProjectExtension(result.filePath)
  })
  ipcMain.handle('project:choose-open', async (event) => {
    const win = senderWindow(event.sender)
    const options = { title: 'Open project', properties: ['openFile' as const], filters: FILTERS }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle('project:write', (_event, path: unknown, text: unknown) => writeProject(path, text))
  ipcMain.handle('project:read', (_event, path: unknown) => readProject(path))
  ipcMain.handle('project:recent', async () => {
    const list = await recentList()
    const present = await Promise.all(list.map((r) => fs.stat(r.path).then((s) => s.isFile(), () => false)))
    return list.filter((_, i) => present[i]).map((r) => ({ ...r, name: basename(r.path, PROJECT_EXTENSION) }))
  })
  ipcMain.handle('project:ask-to-save', (event, name: unknown) =>
    askToSave(senderWindow(event.sender), typeof name === 'string' ? name : 'this project'),
  )
  ipcMain.on('project:state', (event, state: unknown) => {
    const { name, path, dirty } = (state ?? {}) as Partial<ProjectWindowState>
    windowStates.set(event.sender.id, {
      name: typeof name === 'string' ? name : 'this project',
      path: typeof path === 'string' ? path : null,
      dirty: dirty === true,
    })
  })
  ipcMain.on('project:close-window', (event) => {
    const win = senderWindow(event.sender)
    if (!win) return
    closing.add(event.sender.id)
    win.close()
  })
}
