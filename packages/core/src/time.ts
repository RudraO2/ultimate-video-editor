/** Frame rate in frames per second, for example 30 or 29.97. */
export type Fps = number

/** Converts a time in milliseconds to the index of the frame showing at that time. */
export function msToFrame(ms: number, fps: Fps): number {
  // The small epsilon keeps exact frame boundaries (e.g. 1000 ms at 30 fps) from
  // rounding down because of floating-point error.
  return Math.floor((ms * fps) / 1000 + 1e-6)
}

/** Converts a frame index to the time in milliseconds at which that frame starts. */
export function frameToMs(frame: number, fps: Fps): number {
  return (frame * 1000) / fps
}

/**
 * Formats a time as a non-drop-frame timecode `HH:MM:SS:FF`.
 * Fractional rates such as 29.97 count frames on the nominal base (30).
 * Negative times are clamped to zero.
 */
export function formatTimecode(ms: number, fps: Fps): string {
  const base = Math.round(fps)
  const totalFrames = msToFrame(Math.max(0, ms), fps)
  const frames = totalFrames % base
  const totalSeconds = Math.floor(totalFrames / base)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  return [hours, minutes, seconds, frames].map((n) => String(n).padStart(2, '0')).join(':')
}

/** Formats a time as `M:SS`, or `H:MM:SS` from one hour on, for rulers and labels. */
export function formatClock(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000)
  const seconds = String(totalSeconds % 60).padStart(2, '0')
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}
