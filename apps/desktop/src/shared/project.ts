// Shared by the main process, which reads and writes project files, and the
// renderer, which builds them. Plain TypeScript only: no Node or DOM APIs.

export const PROJECT_EXTENSION = '.uve'

/** How many recent projects are remembered. */
export const RECENT_LIMIT = 10

/** A project opened or saved lately, newest first in the list. */
export interface RecentProject {
  path: string
  name: string
  /** Date.now() of the last open or save. */
  at: number
}

/** A project file read from disk, with its media files granted to the editor. */
export interface OpenedProjectFile {
  path: string
  text: string
  /** Media paths in the project that are not on disk any more. */
  missing: string[]
}

/** What the main process needs to know to warn before unsaved changes are lost. */
export interface ProjectWindowState {
  name: string
  path: string | null
  dirty: boolean
}

/** The answer to "save your changes first?". */
export type SaveChoice = 'save' | 'discard' | 'cancel'

/** Characters Windows does not allow in file names, and control characters. */
const UNSAFE_NAME = /[<>:"/\\|?*\u0000-\u001f]/g

/** A file name made from a project name, for the save dialog. */
export function projectFileName(projectName: string): string {
  const name = projectName.replace(UNSAFE_NAME, '').replace(/[. ]+$/, '').trim()
  return `${name || 'Untitled project'}${PROJECT_EXTENSION}`
}

/** `path` with the project extension, added when it has another one or none. */
export function withProjectExtension(path: string): string {
  return path.toLowerCase().endsWith(PROJECT_EXTENSION) ? path : `${path}${PROJECT_EXTENSION}`
}

/** Paths are compared without case, as Windows does. */
const samePath = (a: string, b: string) => a.replaceAll('\\', '/').toLowerCase() === b.replaceAll('\\', '/').toLowerCase()

/** The list with `entry` moved to the front, without duplicates, at most `RECENT_LIMIT` long. */
export function addRecent(list: readonly RecentProject[], entry: RecentProject): RecentProject[] {
  return [entry, ...list.filter((r) => !samePath(r.path, entry.path))].slice(0, RECENT_LIMIT)
}

/** A recent list read from disk: anything malformed is dropped. */
export function parseRecent(raw: unknown): RecentProject[] {
  if (!Array.isArray(raw)) return []
  const list: RecentProject[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const { path, name, at } = item as Record<string, unknown>
    if (typeof path === 'string' && typeof name === 'string' && typeof at === 'number') list.push({ path, name, at })
  }
  return list.slice(0, RECENT_LIMIT)
}

/** The media and font file paths listed in a project file's document, without trusting its shape. */
export function mediaPathsIn(fileText: string): string[] {
  try {
    const document = (JSON.parse(fileText) as { document?: { media?: unknown; fonts?: unknown } }).document
    return [document?.media, document?.fonts].flatMap((list) =>
      Array.isArray(list) ? list.map((m) => (m as { path?: unknown })?.path).filter((p): p is string => typeof p === 'string') : [],
    )
  } catch {
    return []
  }
}
