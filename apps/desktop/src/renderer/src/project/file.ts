import { createDefaultProject, type Project, ProjectFileError, readProjectFile, writeProjectFile } from '@uve/core'
import { hostRequest } from '../ipc'
import { probeMedia } from '../media/probe'
import { session, useEditor } from '../store'

// Saving and opening projects. A project file is the document as JSON plus a
// manifest (see `writeProjectFile`); media stay on disk and are referenced by
// path. The functions without "ask" in their name never show a dialog, so
// agents use them too; the ones the menu and shortcuts use ask where to save
// and whether to keep unsaved changes.

const APP_NAME = 'Ultimate Video Editor'
const APP_LABEL = `${APP_NAME} ${import.meta.env.VITE_APP_VERSION ?? ''}`.trim()

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Whether the project has changed since it was last saved or opened. */
export function hasUnsavedChanges(state = useEditor.getState()): boolean {
  return state.revision !== state.savedRevision
}

/** The file's name without its folder and extension, or the project name before the first save. */
export function projectTitle(state = useEditor.getState()): string {
  if (!state.projectPath) return state.project.name
  const file = state.projectPath.split(/[\\/]/).pop() ?? state.projectPath
  return file.replace(/\.uve$/i, '')
}

export interface SavedProject {
  path: string
  name: string
  savedAt: string
}

/**
 * Writes the project to `path`, an absolute path (`.uve` is added when
 * missing). Waits for edits in progress, so the file never holds half a
 * change. Throws when the file cannot be written.
 */
export async function saveProjectTo(path: string): Promise<SavedProject> {
  const savedAt = new Date()
  // An empty transaction runs after every queued call and makes no undo step.
  const snapshot = await session.transact('', async () => ({
    text: writeProjectFile(session.project, { savedAt, app: APP_LABEL }),
    revision: session.revision,
  }))
  const written = await hostRequest(window.uve.project.write(path, snapshot.text))
  useEditor.setState({ projectPath: written.path, savedRevision: snapshot.revision })
  return { path: written.path, name: written.name, savedAt: savedAt.toISOString() }
}

/** Forgets the old project's thumbnails and view state, and shows `project`. */
function showProject(project: Project, path: string | null): void {
  for (const url of Object.values(useEditor.getState().thumbnails)) URL.revokeObjectURL(url)
  useEditor.setState({
    activeCompId: project.comps[0]?.id ?? '',
    selectedLayerId: null,
    selectedKey: null,
    timeMs: 0,
    playing: false,
    thumbnails: {},
    projectPath: path,
    savedRevision: session.revision,
    viewZoom: null,
    viewPan: { x: 0, y: 0 },
    workRange: null,
    workRangeEnabled: false,
  })
}

/** Makes the media panel's thumbnails again, in the background. */
async function refreshThumbnails(project: Project, missing: readonly string[]): Promise<void> {
  const skip = new Set(missing)
  for (const media of project.media) {
    if (skip.has(media.path) || media.kind === 'audio') continue
    try {
      const { thumbnail } = await probeMedia({ path: media.path, name: media.path.split(/[\\/]/).pop() ?? media.name, size: 0 })
      if (thumbnail && session.project.media.some((m) => m.path === media.path)) {
        useEditor.setState((s) => ({ thumbnails: { ...s.thumbnails, [media.path]: thumbnail } }))
      }
    } catch {
      // A file that cannot be read shows without a thumbnail.
    }
  }
}

export interface OpenedProject {
  path: string
  project: Project
  /** Media files the project uses that are not on disk any more. */
  missing: string[]
}

/** Opens the project file at `path`, replacing the open project and its history. Throws when it cannot be read. */
export async function openProjectFrom(path: string): Promise<OpenedProject> {
  const file = await hostRequest(window.uve.project.read(path))
  const { project } = readProjectFile(file.text)
  await session.replace(project)
  showProject(project, file.path)
  void refreshThumbnails(project, file.missing)
  return { path: file.path, project, missing: file.missing }
}

/** Starts a new, empty project, replacing the open one and its history. */
export async function newProject(name?: string): Promise<Project> {
  const fresh = createDefaultProject()
  const project = name ? { ...fresh, name } : fresh
  await session.replace(project)
  showProject(project, null)
  return project
}

// What the menu, shortcuts and close warning use: they ask the user.

function busy(): boolean {
  if (!useEditor.getState().exportJob) return false
  useEditor.getState().notify('Wait for the export to finish first.', 'error')
  return true
}

/** Saves to the project's file, or asks where when it has none (or with `saveAs`). Resolves with false when nothing was saved. */
export async function askSaveProject(options: { saveAs?: boolean } = {}): Promise<boolean> {
  const state = useEditor.getState()
  const path = options.saveAs || !state.projectPath ? await window.uve.project.chooseSavePath(projectTitle(state)) : state.projectPath
  if (!path) return false
  try {
    const saved = await saveProjectTo(path)
    state.notify(`Saved ${saved.name}.`)
    return true
  } catch (error) {
    state.notify(`Could not save the project: ${messageOf(error)}`, 'error')
    return false
  }
}

/** With unsaved changes, asks whether to save them. Resolves with false when the user cancelled (or the save failed). */
async function settleUnsavedChanges(): Promise<boolean> {
  if (!hasUnsavedChanges()) return true
  const choice = await window.uve.project.askToSave(projectTitle())
  if (choice === 'cancel') return false
  if (choice === 'discard') return true
  return askSaveProject()
}

/** Opens a project: the one at `path`, or one picked in the open dialog. */
export async function askOpenProject(path?: string): Promise<void> {
  if (busy() || !(await settleUnsavedChanges())) return
  const chosen = path ?? (await window.uve.project.chooseOpenPath())
  if (!chosen) return
  const { notify } = useEditor.getState()
  try {
    const opened = await openProjectFrom(chosen)
    const count = opened.missing.length
    if (count > 0) {
      const names = opened.missing.map((p) => p.split(/[\\/]/).pop()).join(', ')
      notify(`${count === 1 ? 'A media file is' : `${count} media files are`} missing: ${names}.`, 'error')
    } else notify(`Opened ${opened.project.name}.`)
  } catch (error) {
    notify(error instanceof ProjectFileError ? error.message : `Could not open the project: ${messageOf(error)}`, 'error')
  }
}

export async function askNewProject(): Promise<void> {
  if (busy() || !(await settleUnsavedChanges())) return
  await newProject()
}

/** Loads the recent projects into the store, for the menu. */
export async function refreshRecentProjects(): Promise<void> {
  try {
    useEditor.setState({ recentProjects: await window.uve.project.recent() })
  } catch {
    // The menu then shows no recent projects.
  }
}

/**
 * Keeps the window title and the main process's close warning up to date, and
 * saves when the user chose Save in the close warning.
 */
export function startProjectTracking(): void {
  let last = ''
  const sync = () => {
    const state = useEditor.getState()
    const dirty = hasUnsavedChanges(state)
    const name = projectTitle(state)
    const key = `${dirty}|${name}|${state.projectPath}`
    if (key === last) return
    last = key
    document.title = `${dirty ? '• ' : ''}${name} — ${APP_NAME}`
    window.uve.project.setState({ name, path: state.projectPath, dirty })
  }
  useEditor.subscribe(sync)
  sync()
  window.uve.project.onSaveBeforeClose(() => {
    void askSaveProject().then((saved) => {
      if (saved) window.uve.project.closeWindow()
    })
  })
}
