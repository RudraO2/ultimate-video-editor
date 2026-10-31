import { CircleAlert, CircleCheck, FolderOpen } from '../icons'
import { useEffect, useState } from 'react'
import { cancelExport, dismissExport } from '../export/job'
import { type ExportJob, useEditor } from '../store'

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatSeconds(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`
}

/** Elapsed time, and the time left estimated from the frames done so far. */
function timing(job: ExportJob, now: number): string {
  const elapsed = (job.finishedAt ?? now) - job.startedAt
  if (job.status !== 'rendering') return formatSeconds(elapsed)
  if (job.frame === 0 || job.frameCount === 0) return `${formatSeconds(elapsed)} elapsed`
  const left = (elapsed / job.frame) * (job.frameCount - job.frame)
  return `${formatSeconds(elapsed)} elapsed · about ${formatSeconds(left)} left`
}

const button = 'rounded px-3 py-1.5 text-xs font-medium'

/** Shows a running export's progress, with Cancel, and its result once it ends. The editor waits behind it. */
export function ExportDialog() {
  const job = useEditor((s) => s.exportJob)
  const [now, setNow] = useState(() => Date.now())
  const rendering = job?.status === 'rendering'

  useEffect(() => {
    if (!rendering) return
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [rendering])

  useEffect(() => {
    if (!job || rendering) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter') dismissExport()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [job, rendering])

  if (!job) return null
  const fraction = job.frameCount > 0 ? job.frame / job.frameCount : 0
  const title = rendering ? 'Exporting video' : job.status === 'done' ? 'Video exported' : 'Export failed'

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-title"
        className="w-[26rem] rounded-lg border border-line bg-panel p-4 shadow-2xl"
      >
        <div className="flex items-center gap-2">
          {job.status === 'done' && <CircleCheck size={16} className="text-ok" aria-hidden />}
          {job.status === 'failed' && <CircleAlert size={16} className="text-danger" aria-hidden />}
          <h2 id="export-title" className="font-semibold">
            {title}
          </h2>
        </div>
        <p className="mt-1 truncate text-xs text-muted" title={job.path}>
          {job.fileName}
        </p>

        {job.status === 'failed' ? (
          <p className="mt-3 text-xs text-danger">{job.error}</p>
        ) : (
          <>
            <div
              className="mt-4 h-1.5 overflow-hidden rounded-full bg-raised"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(fraction * 100)}
            >
              <div className="h-full bg-accent transition-[width] duration-100" style={{ width: `${fraction * 100}%` }} />
            </div>
            <div className="mt-2 flex justify-between text-xs text-muted">
              <span>
                {job.frameCount === 0
                  ? 'Preparing…'
                  : rendering && job.frame === job.frameCount
                    ? 'Finishing the file…'
                    : `${job.soundOnly ? 'Second' : 'Frame'} ${job.frame} of ${job.frameCount}`}
                {job.bytes > 0 && ` · ${formatBytes(job.bytes)}`}
              </span>
              <span>{timing(job, now)}</span>
            </div>
            {job.note && <p className="mt-2 text-xs text-warn">{job.note}</p>}
          </>
        )}

        <div className="mt-4 flex justify-end gap-2">
          {rendering ? (
            <button type="button" onClick={cancelExport} className={`${button} bg-raised hover:bg-line`}>
              Cancel
            </button>
          ) : (
            <>
              {job.status === 'done' && (
                <button
                  type="button"
                  onClick={() => void window.uve.export.reveal(job.path)}
                  className={`${button} flex items-center gap-1.5 bg-raised hover:bg-line`}
                >
                  <FolderOpen size={13} aria-hidden />
                  Show in folder
                </button>
              )}
              <button type="button" onClick={dismissExport} className={`${button} bg-accent text-accent-ink hover:bg-accent/85`}>
                Close
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
