import { groupOnLane, type Track } from '@uve/core'
import { Eye, EyeOff, Lock, LockOpen, Volume2, VolumeX } from 'lucide-react'
import { run } from '../store'

/** A track's visibility, sound and lock switches. Each is a track.update command. */
export function TrackToggles({ track, label }: { track: Track; label: string }) {
  const toggles = [
    { key: 'hidden', on: track.hidden, Icon: track.hidden ? EyeOff : Eye, title: track.hidden ? `Show ${label}` : `Hide ${label}` },
    { key: 'muted', on: track.muted, Icon: track.muted ? VolumeX : Volume2, title: track.muted ? `Unmute ${label}` : `Mute ${label}` },
    { key: 'locked', on: track.locked, Icon: track.locked ? Lock : LockOpen, title: track.locked ? `Unlock ${label}` : `Lock ${label}` },
  ] as const
  return (
    <div className="flex items-center gap-0.5">
      {toggles.map(({ key, on, Icon, title }) => (
        <button
          key={key}
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            void run('track.update', { id: track.id, [key]: !on })
          }}
          aria-label={title}
          aria-pressed={on}
          title={title}
          className={`flex size-6 items-center justify-center rounded-md hover:bg-hover ${on ? 'text-accent' : 'text-muted hover:text-ink'}`}
        >
          <Icon size={14} />
        </button>
      ))}
    </div>
  )
}

/** Tracks are numbered from the front, as they are listed; a group's own lane is named after the group. */
export function trackLabel(track: Track, index: number): string {
  const group = groupOnLane(track)
  return group ? group.name : (track.name ?? `Track ${index + 1}`)
}
