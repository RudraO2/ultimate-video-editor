// Shared by the main process, which writes export files, and the renderer,
// which renders them. Plain TypeScript only: no Node or DOM APIs.

/** An export file opened for writing: the renderer writes into it by id. */
export interface ExportFile {
  id: string
  /** Absolute path the user chose. */
  path: string
  name: string
}

/** The file extensions an export can have: one per container. */
export const EXPORT_EXTENSIONS = ['mp4', 'mov', 'webm', 'wav', 'gif', 'png', 'jpg', 'webp'] as const
export type ExportExtension = (typeof EXPORT_EXTENSIONS)[number]

export function isExportExtension(value: unknown): value is ExportExtension {
  return typeof value === 'string' && (EXPORT_EXTENSIONS as readonly string[]).includes(value)
}

/** Characters Windows does not allow in file names, and control characters. */
const UNSAFE_NAME = /[<>:"/\\|?*\u0000-\u001f]/g

/** A comp name made safe for a file or folder name; "Export" when nothing usable is left. */
function safeName(compName: string): string {
  const name = compName.replace(UNSAFE_NAME, '').replace(/[. ]+$/, '').trim()
  return name || 'Export'
}

/** A file name made from a comp name, for the save dialog; "Export" when nothing usable is left. */
export function exportFileName(compName: string, extension: ExportExtension = 'mp4'): string {
  return `${safeName(compName)}.${extension}`
}

/** The folder name for a PNG sequence made from a comp name: "Comp 1" becomes "Comp 1-png-seq". */
export function exportFolderName(compName: string): string {
  return `${safeName(compName)}-png-seq`
}

/** The only file names a folder export may write: "frame-000.png", "frame-001.png", and so on. */
export const SEQUENCE_FILE = /^frame-\d{1,9}\.png$/

/** `path` with `.<extension>` added when it has another extension or none. */
export function withExtension(path: string, extension: ExportExtension): string {
  return path.toLowerCase().endsWith(`.${extension}`) ? path : `${path}.${extension}`
}

/** "Comp 1.webm" becomes "Comp 1 (2).webm" for n = 2: the name tried when the first one is taken. */
export function numberedPath(path: string, n: number): string {
  const base = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1
  const dot = path.lastIndexOf('.')
  // Only a dot inside the file name counts, and a leading one (".hidden") is not an extension.
  const at = dot > base ? dot : path.length
  return `${path.slice(0, at)} (${n})${path.slice(at)}`
}

/** "Comp 1-png-seq" becomes "Comp 1-png-seq (2)" for n = 2: the folder tried when the first one is taken. */
export function numberedFolder(path: string, n: number): string {
  return `${path} (${n})`
}
