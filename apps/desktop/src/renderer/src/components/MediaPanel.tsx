import { formatClock, type MediaAsset } from '@uve/core'
import { Box, Film, Image as ImageIcon, Music, Plus, X } from '../icons'
import { type DragEvent, useState } from 'react'
import { dragHasFiles, importDrop, importFiles, MEDIA_DRAG_TYPE, placeMedia } from '../media/import'
import { run, useEditor } from '../store'

const KIND_ICONS = { video: Film, image: ImageIcon, audio: Music, model: Box } as const

/** "6.0 s" under a minute, "1:05" from a minute on. */
function formatDuration(ms: number): string {
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : formatClock(ms)
}

function describeMedia(media: MediaAsset): string {
  const parts: string[] = []
  if (media.durationMs !== undefined && media.kind !== 'image') parts.push(formatDuration(media.durationMs))
  if (media.width && media.height) parts.push(`${media.width}×${media.height}`)
  if (media.model) parts.push(media.model.format.toUpperCase(), ...(media.model.clips.length > 0 ? [`${media.model.clips.length} clip${media.model.clips.length === 1 ? '' : 's'}`] : []))
  if (media.fps) parts.push(`${Math.round(media.fps * 100) / 100} fps`)
  if (media.kind === 'video' && media.hasAudio === false) parts.push('no sound')
  return parts.join(' · ')
}

function MediaItem({ media }: { media: MediaAsset }) {
  const thumbnail = useEditor((s) => s.thumbnails[media.path])
  const Icon = KIND_ICONS[media.kind]

  // Double-click puts the file on a new track at the playhead.
  const place = () => {
    const { activeCompId, timeMs } = useEditor.getState()
    void placeMedia(media, { compId: activeCompId, startMs: timeMs })
  }

  return (
    <li
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(MEDIA_DRAG_TYPE, media.id)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      onDoubleClick={place}
      title={`${media.path}\nDouble-click to place it at the playhead, or drag it onto the timeline or the picture.`}
      className="group flex cursor-grab items-center gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-hover active:cursor-grabbing"
    >
      <div className="flex h-10 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md bg-stage ring-1 ring-line">
        {thumbnail ? (
          <img src={thumbnail} alt="" className="h-full w-full object-cover" draggable={false} />
        ) : (
          <Icon size={16} className="text-muted" aria-hidden />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] font-medium">{media.name}</div>
        <div className="truncate text-[10px] text-muted">{describeMedia(media)}</div>
      </div>
      <button
        type="button"
        onClick={() => void run('media.remove', { id: media.id })}
        className="rounded-md p-1 text-muted opacity-0 hover:bg-hover hover:text-ink group-hover:opacity-100"
        aria-label={`Remove ${media.name} from the library`}
        title="Remove from the library (the file stays on disk)"
      >
        <X size={13} />
      </button>
    </li>
  )
}

/** The media tab: imported files, with Import and a drop zone. */
export function MediaPanel() {
  const media = useEditor((s) => s.project.media)
  const [dropping, setDropping] = useState(false)

  const pick = async () => {
    const files = await window.uve.media.pickFiles()
    if (files.length > 0) await importFiles(files)
  }

  const onDragOver = (e: DragEvent) => {
    if (!dragHasFiles(e.dataTransfer)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDropping(true)
  }

  return (
    <section
      className={`flex h-full min-h-0 flex-col gap-3 p-3 ${dropping ? 'bg-accent/10 ring-1 ring-accent/60 ring-inset' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
      }}
      onDrop={(e) => {
        setDropping(false)
        if (!dragHasFiles(e.dataTransfer)) return
        e.preventDefault()
        void importDrop(e.dataTransfer)
      }}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-[11px] font-semibold tracking-wider text-muted uppercase">Media</h2>
        <button
          type="button"
          onClick={() => void pick()}
          className="flex h-7 items-center gap-1 rounded-lg bg-field px-2.5 text-[11px] font-medium hover:bg-hover"
        >
          <Plus size={13} aria-hidden />
          Import…
        </button>
      </div>
      {media.length === 0 ? (
        <p className="rounded-panel border border-dashed border-line px-3 py-6 text-center text-[11px] leading-relaxed text-muted">
          Drop video, images or audio here, or onto the picture or the timeline.
        </p>
      ) : (
        <ul className="-mx-1.5 min-h-0 flex-1 overflow-y-auto">
          {media.map((m) => (
            <MediaItem key={m.id} media={m} />
          ))}
        </ul>
      )}
    </section>
  )
}
