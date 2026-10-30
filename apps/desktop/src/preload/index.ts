import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AgentCall, AgentStatus, McpTool, McpToolResult } from '../shared/agent'
import type { ExportExtension, ExportFile } from '../shared/export'
import type { FontPrefetchResult, InspectedFont } from '../shared/fonts'
import type { IconData, IconSet } from '../shared/icons'
import type { GrantedFile } from '../shared/media'
import type { OpenCodeEvent, OpenCodeStatus } from '../shared/opencode'
import type { FetchedSound, LibraryPack, LibraryPackManifest } from '../shared/soundLibrary'
import type {
  SarvamStatus,
  SarvamUsage,
  SttRequest,
  SttResult,
  TranslateRequest,
  TranslateResult,
  TtsRequest,
  TtsResult,
} from '../shared/sarvam'
import type { Sticker } from '../shared/stickers'
import type { OpenedProjectFile, ProjectWindowState, RecentProject, SaveChoice } from '../shared/project'

// The renderer's only window into the host. Native features are added here
// one by one, behind small typed functions, never by exposing Node itself.
const api = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  },
  media: {
    /** Lets the editor load files the user dropped. Files that are not media, or not on disk, are left out. */
    grantFiles: (files: File[]): Promise<GrantedFile[]> =>
      ipcRenderer.invoke(
        'media:grant',
        files.map((file) => webUtils.getPathForFile(file)).filter((path) => path !== ''),
      ),
    /** Shows the open dialog; resolves with the picked files, or none when it is cancelled. */
    pickFiles: (): Promise<GrantedFile[]> => ipcRenderer.invoke('media:pick'),
    /** Only while remote debugging is on: grants files by path, so automated checks can import them. */
    grantPathsForDebug: (paths: string[]): Promise<GrantedFile[]> => ipcRenderer.invoke('media:grant-debug', paths),
    /** Keeps a PNG the editor made (a background removed) in the app's data folder and grants it. */
    writeCutout: (name: string, data: Uint8Array): Promise<GrantedFile> => ipcRenderer.invoke('media:write-cutout', name, data),
  },
  library: {
    /** The CC0 sound library's packs (cached on disk, refreshed daily). */
    index: (): Promise<LibraryPack[]> => ipcRenderer.invoke('library:index'),
    /** One pack's sounds. */
    pack: (id: string): Promise<LibraryPackManifest> => ipcRenderer.invoke('library:pack', id),
    /** Fetches a sound to disk (once) and grants it, for import. */
    fetch: (packId: string, soundId: string): Promise<FetchedSound> => ipcRenderer.invoke('library:fetch', packId, soundId),
  },
  stickers: {
    /** The sticker library (free pictures mirrored in ~/uve-assets), scanned once per run; every path is granted. */
    index: (): Promise<Sticker[]> => ipcRenderer.invoke('stickers:index'),
  },
  sarvam: {
    /** Whether a Sarvam API key is set, where it came from, and its last characters (never the key). */
    status: (): Promise<SarvamStatus> => ipcRenderer.invoke('sarvam:status'),
    /** Saves the API key (or, with null or empty text, forgets the saved one). */
    setKey: (key: string | null): Promise<SarvamStatus> => ipcRenderer.invoke('sarvam:set-key', key),
    /** What the real (not cached) calls have cost so far, in rupees. */
    usage: (): Promise<SarvamUsage> => ipcRenderer.invoke('sarvam:usage'),
    /** Speaks a text in an Indian language; the WAV is kept and granted. A repeat of an earlier request is free. */
    tts: (req: TtsRequest): Promise<TtsResult> => ipcRenderer.invoke('sarvam:tts', req),
    /** Translates a text into an Indian language (long texts are sent in pieces). */
    translate: (req: TranslateRequest): Promise<TranslateResult> => ipcRenderer.invoke('sarvam:translate', req),
    /** Writes down a WAV recording of 30 seconds or less, with the time of each phrase. */
    stt: (req: SttRequest): Promise<SttResult> => ipcRenderer.invoke('sarvam:stt', req),
  },
  export: {
    /** Shows the save dialog for a comp, for a file of this extension; resolves with the file to write, or null when it is cancelled. */
    begin: (compName: string, extension: ExportExtension = 'mp4'): Promise<ExportFile | null> =>
      ipcRenderer.invoke('export:begin', compName, extension),
    /**
     * Opens an export without a dialog (for agents): at an absolute path, or,
     * with null, the comp's name in the Videos folder. The file gets the
     * extension when it lacks it. An existing file is replaced only with
     * `overwrite`.
     */
    beginAt: (path: string | null, compName: string, overwrite: boolean, extension: ExportExtension = 'mp4'): Promise<ExportFile> =>
      ipcRenderer.invoke('export:begin-at', path, compName, overwrite, extension),
    /**
     * Opens a folder export without a dialog (for a PNG sequence): at an
     * absolute path, or, with null, the comp's name plus "-png-seq" in the
     * Videos folder. An existing folder is reused only with `overwrite`, which
     * deletes its old frames.
     */
    beginFolderAt: (path: string | null, compName: string, overwrite: boolean): Promise<ExportFile> =>
      ipcRenderer.invoke('export:begin-folder-at', path, compName, overwrite),
    /**
     * Shows the save dialog naming a folder for a PNG sequence (default: the
     * comp's name plus "-png-seq" in Videos) and makes it; resolves with the
     * open folder export, or null when the dialog is cancelled.
     */
    beginFolder: (compName: string): Promise<ExportFile | null> => ipcRenderer.invoke('export:begin-folder', compName),
    /** Writes bytes into an open export, at a byte position. */
    write: (id: string, position: number, data: Uint8Array): Promise<void> =>
      ipcRenderer.invoke('export:write', id, position, data),
    /** Writes one frame file (frame-000.png) into an open folder export, replacing it if it is there. */
    writeFile: (id: string, name: string, data: Uint8Array): Promise<void> =>
      ipcRenderer.invoke('export:write-file', id, name, data),
    /** Closes an open export. A file that is not kept (cancelled or failed) is deleted. */
    end: (id: string, keep: boolean): Promise<void> => ipcRenderer.invoke('export:end', id, keep),
    /** Shows a finished export in the file manager. */
    reveal: (path: string): Promise<void> => ipcRenderer.invoke('export:reveal', path),
    /** Only while remote debugging is on: opens an export at a path without the dialog, for automated checks. */
    beginForDebug: (path: string): Promise<ExportFile> => ipcRenderer.invoke('export:begin-debug', path),
  },
  project: {
    /** Shows the save dialog; resolves with the chosen path, or null when it is cancelled. */
    chooseSavePath: (projectName: string): Promise<string | null> => ipcRenderer.invoke('project:choose-save', projectName),
    /** Shows the open dialog; resolves with the chosen path, or null when it is cancelled. */
    chooseOpenPath: (): Promise<string | null> => ipcRenderer.invoke('project:choose-open'),
    /** Writes a project file (the extension is added when missing) and remembers it as recent. */
    write: (path: string, text: string): Promise<{ path: string; name: string }> =>
      ipcRenderer.invoke('project:write', path, text),
    /** Reads a project file, grants the media it lists, and remembers it as recent. */
    read: (path: string): Promise<OpenedProjectFile> => ipcRenderer.invoke('project:read', path),
    /** Recent projects that are still on disk, newest first. */
    recent: (): Promise<RecentProject[]> => ipcRenderer.invoke('project:recent'),
    /** Asks the user whether to save unsaved changes first. */
    askToSave: (projectName: string): Promise<SaveChoice> => ipcRenderer.invoke('project:ask-to-save', projectName),
    /** Tells the window its project's name and whether it has unsaved changes, for the close warning. */
    setState: (state: ProjectWindowState): void => ipcRenderer.send('project:state', state),
    /** Closes the window without asking again (after a save requested by the close warning). */
    closeWindow: (): void => ipcRenderer.send('project:close-window'),
    /** Called when the user chose Save in the close warning. Returns a function that stops listening. */
    onSaveBeforeClose: (handler: () => void): (() => void) => {
      const listener = () => handler()
      ipcRenderer.on('project:save-before-close', listener)
      return () => ipcRenderer.off('project:save-before-close', listener)
    },
  },
  fonts: {
    /** Fetches Google Fonts stylesheets and their Latin files into the disk cache, so they work offline. */
    prefetch: (stylesheets: string[]): Promise<FontPrefetchResult> => ipcRenderer.invoke('fonts:prefetch', stylesheets),
    /** A Google Fonts stylesheet's text (cached on disk), for loading one font file by hand. */
    css: (url: string): Promise<string> => ipcRenderer.invoke('fonts:css', url),
    outline: (family: string, weight: number, italic: boolean): Promise<Uint8Array> => ipcRenderer.invoke('fonts:outline', family, weight, italic),
    /** Shows the open dialog for font files; resolves with the readable ones, granted. */
    pick: (): Promise<InspectedFont[]> => ipcRenderer.invoke('fonts:pick'),
    /** Reads font files that were handed over already (dropped on the window): what each says about itself. */
    inspect: (paths: string[]): Promise<InspectedFont[]> => ipcRenderer.invoke('fonts:inspect', paths),
  },
  icons: {
    /** The icon sets that may be offered (copyleft and non-commercial ones left out), cached on disk. */
    sets: (): Promise<IconSet[]> => ipcRenderer.invoke('icons:sets'),
    /** The icon names of one set. */
    names: (prefix: string): Promise<string[]> => ipcRenderer.invoke('icons:names', prefix),
    /** Icon ids (set:name) matching words, in every set or only the sets named. */
    search: (query: string, prefixes: string[] | null, limit: number): Promise<string[]> => ipcRenderer.invoke('icons:search', query, prefixes, limit),
    /** The pictures of icons by id; an icon that is unknown or cannot be fetched is null. Kept on disk. */
    data: (ids: string[]): Promise<Record<string, IconData | null>> => ipcRenderer.invoke('icons:data', ids),
  },
  agent: {
    /** Tells the agent server which tools this window answers. Calls wait until it has. */
    ready: (tools: McpTool[]): Promise<void> => ipcRenderer.invoke('agent:ready', tools),
    /** Receives tool calls from agents. Returns a function that stops listening. */
    onCall: (handler: (call: AgentCall) => void): (() => void) => {
      const listener = (_event: unknown, call: AgentCall) => handler(call)
      ipcRenderer.on('agent:call', listener)
      return () => ipcRenderer.off('agent:call', listener)
    },
    /** Answers a tool call. */
    answer: (id: string, result: McpToolResult): void => ipcRenderer.send('agent:result', id, result),
    /** The server's address, token and connected agent sessions. */
    status: (): Promise<AgentStatus> => ipcRenderer.invoke('agent:status'),
    /** Receives the status whenever agent sessions connect, call or leave. Returns a function that stops listening. */
    onStatus: (handler: (status: AgentStatus) => void): (() => void) => {
      const listener = (_event: unknown, status: AgentStatus) => handler(status)
      ipcRenderer.on('agent:status', listener)
      return () => ipcRenderer.off('agent:status', listener)
    },
  },
  /** OpenCode inside the app, driven over the Agent Client Protocol by the main process. */
  opencode: {
    status: (): Promise<OpenCodeStatus> => ipcRenderer.invoke('opencode:status'),
    /** Receives the status whenever it changes. Returns a function that stops listening. */
    onStatus: (handler: (status: OpenCodeStatus) => void): (() => void) => {
      const listener = (_event: unknown, status: OpenCodeStatus) => handler(status)
      ipcRenderer.on('opencode:status', listener)
      return () => ipcRenderer.off('opencode:status', listener)
    },
    /** Receives the chat as it happens (fold with `applyEvent`). Returns a function that stops listening. */
    onEvent: (handler: (event: OpenCodeEvent) => void): (() => void) => {
      const listener = (_event: unknown, event: OpenCodeEvent) => handler(event)
      ipcRenderer.on('opencode:event', listener)
      return () => ipcRenderer.off('opencode:event', listener)
    },
    /** Starts OpenCode and opens a chat, unless one is open. */
    start: (): Promise<OpenCodeStatus> => ipcRenderer.invoke('opencode:start'),
    /** Starts a new chat (the transcript is cleared by a `reset` event). */
    newChat: (): Promise<OpenCodeStatus> => ipcRenderer.invoke('opencode:new-chat'),
    /** Sends a request; resolves once it finished (a `turn-end` or `error` event tells the chat). */
    prompt: (text: string): Promise<void> => ipcRenderer.invoke('opencode:prompt', text),
    /** Stops the running request. */
    cancel: (): Promise<void> => ipcRenderer.invoke('opencode:cancel'),
    /** Answers a permission question with one of its options, or null to refuse. */
    answer: (id: string, optionId: string | null): void => ipcRenderer.send('opencode:answer', id, optionId),
    /** Switches the model or the effort of the open chat. */
    setOption: (configId: 'model' | 'effort', value: string): Promise<OpenCodeStatus> => ipcRenderer.invoke('opencode:set-option', configId, value),
    /** Saves a provider key (encrypted) for the model's provider, or forgets it with null. Restarts OpenCode. */
    setKey: (key: string | null): Promise<OpenCodeStatus> => ipcRenderer.invoke('opencode:set-key', key),
    /** Installs the pinned OpenCode into the app's data folder (needs npm). */
    install: (): Promise<OpenCodeStatus> => ipcRenderer.invoke('opencode:install'),
  },
}

contextBridge.exposeInMainWorld('uve', api)

export type UveApi = typeof api
