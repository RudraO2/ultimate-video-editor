// Records the microphone for the chat's "speak" button and hands back 16 kHz
// mono samples, the shape Sarvam's speech to text takes (see encodeWav).

/** Sample rate of the recording handed back. */
export const MIC_RATE = 16000

/** A recording stops by itself here: Sarvam takes 30 seconds at most. */
export const MIC_MAX_MS = 29_000

export interface MicRecording {
  /** Ends the recording and resolves with its samples (empty when nothing was heard). */
  stop: () => Promise<Float32Array>
  /** Ends it and drops the sound. */
  cancel: () => void
}

/** Decodes a recorded blob and resamples it to MIC_RATE mono. */
async function toSamples(blob: Blob): Promise<Float32Array> {
  const context = new AudioContext()
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer())
    const length = Math.max(1, Math.ceil(decoded.duration * MIC_RATE))
    const offline = new OfflineAudioContext(1, length, MIC_RATE)
    const source = offline.createBufferSource()
    source.buffer = decoded
    // A mono destination mixes a stereo source down.
    source.connect(offline.destination)
    source.start()
    const rendered = await offline.startRendering()
    return rendered.getChannelData(0).slice()
  } finally {
    void context.close().catch(() => {})
  }
}

/**
 * Starts recording. Rejects when the microphone is missing or refused. The
 * microphone is always released, whichever way the recording ends. At the time
 * limit the recording ends by itself and `onAutoStop` runs; `stop()` still
 * returns what was recorded.
 */
export async function startRecording(onAutoStop?: () => void): Promise<MicRecording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
  const release = () => stream.getTracks().forEach((track) => track.stop())
  let recorder: MediaRecorder
  try {
    recorder = new MediaRecorder(stream)
  } catch (error) {
    release()
    throw error
  }
  const chunks: Blob[] = []
  const finished = new Promise<void>((resolve) => {
    recorder.addEventListener('dataavailable', (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    })
    recorder.addEventListener('stop', () => resolve())
    recorder.addEventListener('error', () => resolve())
  })
  let ended = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const end = (): Promise<void> => {
    if (!ended) {
      ended = true
      clearTimeout(timer)
      if (recorder.state !== 'inactive') recorder.stop()
      else release()
    }
    return finished.finally(release)
  }
  timer = setTimeout(() => {
    if (ended) return
    void end()
    onAutoStop?.()
  }, MIC_MAX_MS)
  recorder.start()
  return {
    stop: async () => {
      await end()
      if (chunks.length === 0) return new Float32Array(0)
      return toSamples(new Blob(chunks, { type: recorder.mimeType }))
    },
    cancel: () => void end(),
  }
}
