import { create } from 'zustand'
import type { RecorderState, RecordingError, RecordingOptions, RecordingOutcome } from '../../../shared/recording'
import { importFiles, type Placement } from '../media/import'
import { activeComp, session, useEditor } from '../store'

// The renderer's half of screen recording: it mirrors the main process's state,
// starts and stops a recording, and imports each finished file (the MP4 is
// granted already) into the library and, by default, onto the open comp at the
// playhead.

interface RecorderStore {
  state: RecorderState
  dialogOpen: boolean
}

export const useRecorder = create<RecorderStore>(() => ({ state: { state: 'idle' }, dialogOpen: false }))

export const openRecordDialog = () => useRecorder.setState({ dialogOpen: true })
export const closeRecordDialog = () => useRecorder.setState({ dialogOpen: false })

export interface Imported {
  outcome: RecordingOutcome
  mediaId?: string
  layerId?: string
}

/** Set by a caller that wants a placement other than the default; `null` = library only. Used once. */
let pending: { placement: Placement | null } | null = null
let waiters: ((imported: Imported) => void)[] = []

async function handleFinished(outcome: RecordingOutcome): Promise<void> {
  const wanted = pending
  pending = null
  const imported: Imported = { outcome }
  if (!outcome.ok) {
    useEditor.getState().notify(outcome.hint ? `${outcome.error} ${outcome.hint}` : outcome.error, 'error')
  } else {
    try {
      const state = useEditor.getState()
      const placement = wanted ? (wanted.placement ?? undefined) : { compId: activeComp(state).id, startMs: state.timeMs }
      const layerIds = await importFiles([{ path: outcome.path, name: outcome.name, size: outcome.size }], placement)
      imported.mediaId = session.project.media.find((m) => m.path === outcome.path)?.id
      imported.layerId = layerIds[0]
    } catch (error) {
      useEditor.getState().notify(`Could not import the recording: ${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }
  const done = waiters
  waiters = []
  for (const resolve of done) resolve(imported)
}

let started = false

/** Starts mirroring the recorder's state and importing finished recordings. Call once. */
export function initRecorder(): void {
  if (started) return
  started = true
  window.uve.recorder.onState((state) => useRecorder.setState({ state }))
  window.uve.recorder.onFinished((outcome) => void handleFinished(outcome))
  void window.uve.recorder.state().then((state) => useRecorder.setState({ state }))
}

/** Starts a recording; resolves once it runs. `placement` null = library only; omitted = open comp at the playhead. */
export async function startRecording(options: RecordingOptions, placement?: Placement | null): Promise<{ ok: true } | ({ ok: false } & RecordingError)> {
  pending = placement === undefined ? null : { placement }
  const result = await window.uve.recorder.start(options)
  if (!result.ok) pending = null
  return result
}

/** Stops the recording; the import happens in the finished handler. */
export async function stopRecording(): Promise<void> {
  // The finished listener reports a failure; nothing more to do with the answer here.
  await window.uve.recorder.stop()
}

/** Resolves after the next finished recording is imported (or has failed). */
export function waitForRecording(): Promise<Imported> {
  return new Promise((resolve) => waiters.push(resolve))
}
