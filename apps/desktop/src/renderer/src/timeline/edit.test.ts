import { type Comp, CompSchema, type MediaAsset } from '@uve/core'
import { describe, expect, it } from 'vitest'
import { nearestFreeStart, snapShift, snapTargets, trimLimits } from './edit'

const shape = (id: string, startMs: number, durationMs: number) => ({ id, name: id, kind: 'shape', startMs, durationMs })
const video = (id: string, startMs: number, durationMs: number, sourceStartMs: number) => ({
  id,
  name: id,
  kind: 'video',
  mediaId: 'media_1',
  startMs,
  durationMs,
  sourceStartMs,
})

const comp = (layers: object[], second: object[] = []): Comp =>
  CompSchema.parse({
    id: 'comp_1',
    name: 'Comp',
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 10_000,
    tracks: [
      { id: 'track_1', layers },
      { id: 'track_2', layers: second },
    ],
  })

const clip: MediaAsset = { id: 'media_1', kind: 'video', name: 'clip.mp4', path: 'C:/clip.mp4', durationMs: 8000 }

describe('snapping', () => {
  it('collects the comp ends, the playhead and other layer edges', () => {
    const c = comp([shape('a', 1000, 2000), shape('b', 4000, 1000)])
    expect(snapTargets(c, 2500, 'b').sort((x, y) => x - y)).toEqual([0, 1000, 2500, 3000, 10_000])
  })

  it('takes the closest target for any edge, within the tolerance', () => {
    expect(snapShift([1980, 2980], [0, 3000, 5000], 50)).toEqual({ shift: 20, at: 3000 })
    expect(snapShift([1900], [2000], 50)).toEqual({ shift: 0, at: null })
  })
})

describe('trim limits', () => {
  it('stops at neighbours and keeps a minimum length', () => {
    const c = comp([shape('a', 0, 1000), shape('b', 2000, 1000), shape('c', 5000, 1000)])
    const b = c.tracks[0]?.layers[1]
    if (!b) throw new Error('missing layer')
    expect(trimLimits(c, b, undefined, 100)).toEqual({ start: [1000, 2900], end: [2100, 5000] })
  })

  it('stays inside the source file of a media layer', () => {
    const c = comp([video('v', 3000, 2000, 1000)])
    const v = c.tracks[0]?.layers[0]
    if (!v) throw new Error('missing layer')
    // The source starts 1 s before the in point and ends 8 s in.
    expect(trimLimits(c, v, clip, 100)).toEqual({ start: [2000, 4900], end: [3100, 10_000] })
  })
})

describe('room on a track', () => {
  const c = comp([shape('a', 0, 1000), shape('b', 3000, 1000)])
  const track = c.tracks[0]
  if (!track) throw new Error('missing track')

  it('keeps a free spot as it is', () => {
    expect(nearestFreeStart(track, 1200, 1000, undefined, 500)).toBe(1200)
  })

  it('slides flush against the neighbour it would overlap', () => {
    expect(nearestFreeStart(track, 2500, 1000, undefined, 800)).toBe(2000)
    expect(nearestFreeStart(track, 3600, 1000, undefined, 800)).toBe(4000)
  })

  it('gives up when the nearest room is out of reach', () => {
    expect(nearestFreeStart(track, 2900, 2500, undefined, 500)).toBeNull()
  })

  it('ignores the layer being moved', () => {
    expect(nearestFreeStart(track, 3200, 1000, 'b', 0)).toBe(3200)
  })
})
