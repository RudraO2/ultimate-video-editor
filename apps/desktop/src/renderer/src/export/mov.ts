/** The picture track of a QuickTime file: PNG frames. `alpha` marks 32-bit frames. */
export interface MovVideo {
  width: number
  height: number
  fps: number
  alpha: boolean
}

/** The sound track of a QuickTime file: 16-bit little-endian PCM. */
export interface MovAudio {
  sampleRate: number
  channels: number
}

const MOV_EPOCH_OFFSET = 2_082_844_800
const MOVIE_TIMESCALE = 1000
const FTYP_SIZE = 20
const MDAT_HEADER_SIZE = 16
const IDENTITY_MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000]

/** The media timescale and frame length of a frame rate with at most 3 decimals: 30 is 30000 and 1000, 29.97 is 29970 and 1000. */
export function movTimescale(fps: number): { timescale: number; delta: number } {
  if (!Number.isFinite(fps) || fps <= 0) throw new Error('fps must be a positive number.')
  return { timescale: Math.round(fps * 1000), delta: 1000 }
}

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const u16 = (n: number): Uint8Array => Uint8Array.of((n >>> 8) & 0xff, n & 0xff)
const u32 = (n: number): Uint8Array => Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff)
const u64 = (n: number): Uint8Array => concat([u32(Math.floor(n / 0x100000000)), u32(n % 0x100000000)])
const zeros = (n: number): Uint8Array => new Uint8Array(n)
const fourcc = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0))
const u32s = (values: number[]): Uint8Array => concat(values.map(u32))

const pascal = (s: string, size: number): Uint8Array => {
  const out = new Uint8Array(size)
  out[0] = s.length
  for (let i = 0; i < s.length; i++) out[i + 1] = s.charCodeAt(i)
  return out
}

const box = (type: string, ...parts: Uint8Array[]): Uint8Array => {
  const body = concat(parts)
  return concat([u32(8 + body.length), fourcc(type), body])
}

/** A box with a version byte of 0 and the given 24-bit flags. */
const fullBox = (type: string, flags: number, ...parts: Uint8Array[]): Uint8Array => box(type, u32(flags), ...parts)

const pcmBytes = (pcm: Int16Array): Uint8Array => {
  const out = new Uint8Array(pcm.length * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i]!, true)
  return out
}

const handler = (kind: string, subtype: string, name: string): Uint8Array =>
  fullBox('hdlr', 0, fourcc(kind), fourcc(subtype), zeros(12), Uint8Array.of(name.length), fourcc(name))

const dinf = (): Uint8Array => box('dinf', box('dref', u32(0), u32(1), fullBox('alis', 1)))

interface SoundChunk {
  offset: number
  frames: number
}

/** Writes a QuickTime file of PNG frames and 16-bit PCM sound through `write(position, data)`; the file may be written at any position, so sizes are patched at the end. */
export class MovWriter {
  private position = 0
  private started = false
  private finished = false
  private readonly frameOffsets: number[] = []
  private readonly frameSizes: number[] = []
  private readonly soundChunks: SoundChunk[] = []
  private soundFrames = 0

  constructor(
    private readonly write: (position: number, data: Uint8Array) => Promise<void>,
    private readonly tracks: { video: MovVideo | null; audio: MovAudio | null },
  ) {
    const { video, audio } = tracks
    if (!video && !audio) throw new Error('A QuickTime file needs a video or an audio track.')
    if (video) {
      movTimescale(video.fps)
      for (const side of [video.width, video.height]) {
        if (!Number.isInteger(side) || side < 1 || side > 65535) throw new Error('The picture size must be whole pixels from 1 to 65535.')
      }
    }
    if (audio) {
      if (!Number.isInteger(audio.sampleRate) || audio.sampleRate < 1 || audio.sampleRate > 65535) {
        throw new Error('The sample rate must be a whole number from 1 to 65535 Hz.')
      }
      if (!Number.isInteger(audio.channels) || audio.channels < 1 || audio.channels > 64) throw new Error('The channel count must be 1 to 64.')
    }
  }

  /** Writes the file type and the start of the media data. Call it once, first. */
  async start(): Promise<void> {
    if (this.started) throw new Error('start() was already called.')
    this.started = true
    const head = concat([box('ftyp', fourcc('qt  '), u32(0x200), fourcc('qt  ')), u32(1), fourcc('mdat'), u64(0)])
    await this.write(0, head)
    this.position = FTYP_SIZE + MDAT_HEADER_SIZE
  }

  /** Appends one PNG file as one video sample, one frame long. */
  async addFrame(png: Uint8Array): Promise<void> {
    this.assertOpen()
    if (!this.tracks.video) throw new Error('This file has no video track.')
    if (png.length === 0) throw new Error('A frame cannot be empty.')
    this.frameOffsets.push(this.position)
    this.frameSizes.push(png.length)
    await this.append(png)
  }

  /** Appends interleaved 16-bit samples as one chunk; the length is a multiple of the channel count. An empty array does nothing. */
  async addSound(pcm: Int16Array): Promise<void> {
    this.assertOpen()
    const audio = this.tracks.audio
    if (!audio) throw new Error('This file has no audio track.')
    if (pcm.length % audio.channels !== 0) throw new Error(`The sound length ${pcm.length} is not a multiple of ${audio.channels} channels.`)
    if (pcm.length === 0) return
    const frames = pcm.length / audio.channels
    this.soundChunks.push({ offset: this.position, frames })
    this.soundFrames += frames
    await this.append(pcmBytes(pcm))
  }

  /** Patches the size of the media data and writes the movie box. The writer is closed after it. */
  async finish(): Promise<void> {
    this.assertOpen()
    this.finished = true
    await this.write(FTYP_SIZE + 8, u64(this.position - FTYP_SIZE))
    await this.write(this.position, this.movie())
  }

  private assertOpen(): void {
    if (!this.started) throw new Error('Call start() first.')
    if (this.finished) throw new Error('The file is finished.')
  }

  private async append(data: Uint8Array): Promise<void> {
    const at = this.position
    this.position += data.length
    await this.write(at, data)
  }

  private movie(): Uint8Array {
    const { video, audio } = this.tracks
    const { delta, timescale } = video ? movTimescale(video.fps) : { delta: 0, timescale: 1 }
    const videoDuration = this.frameSizes.length * delta
    const videoMs = video ? Math.round((videoDuration / timescale) * MOVIE_TIMESCALE) : 0
    const audioMs = audio ? Math.round((this.soundFrames / audio.sampleRate) * MOVIE_TIMESCALE) : 0
    const now = Math.floor(Date.now() / 1000) + MOV_EPOCH_OFFSET
    const traks: Uint8Array[] = []
    let id = 1
    if (video) traks.push(this.videoTrack(id++, video, timescale, delta, videoDuration, videoMs, now))
    if (audio) traks.push(this.audioTrack(id++, audio, this.soundFrames, audioMs, now))
    const mvhd = fullBox(
      'mvhd',
      0,
      u32(now),
      u32(now),
      u32(MOVIE_TIMESCALE),
      u32(Math.max(videoMs, audioMs)),
      u32(0x00010000),
      u16(0x0100),
      zeros(10),
      u32s(IDENTITY_MATRIX),
      zeros(24),
      u32(id),
    )
    return box('moov', mvhd, ...traks)
  }

  private track(id: number, ms: number, now: number, audio: boolean, size: [number, number], media: Uint8Array): Uint8Array {
    const tkhd = fullBox(
      'tkhd',
      0x3,
      u32(now),
      u32(now),
      u32(id),
      zeros(4),
      u32(ms),
      zeros(8),
      u16(0),
      u16(0),
      u16(audio ? 0x0100 : 0),
      zeros(2),
      u32s(IDENTITY_MATRIX),
      u32(size[0] * 0x10000),
      u32(size[1] * 0x10000),
    )
    return box('trak', tkhd, media)
  }

  private media(timescale: number, duration: number, now: number, audio: boolean, info: Uint8Array): Uint8Array {
    const mdhd = fullBox('mdhd', 0, u32(now), u32(now), u32(timescale), u32(duration), u16(0x55c4), u16(0))
    const hdlr = audio ? handler('mhlr', 'soun', 'SoundHandler') : handler('mhlr', 'vide', 'VideoHandler')
    return box('mdia', mdhd, hdlr, info)
  }

  private videoTrack(id: number, video: MovVideo, timescale: number, delta: number, duration: number, ms: number, now: number): Uint8Array {
    const frames = this.frameSizes.length
    const entry = box(
      'png ',
      zeros(6),
      u16(1),
      u16(0),
      u16(0),
      u32(0),
      u32(0),
      u32(0x200),
      u16(video.width),
      u16(video.height),
      u32(0x00480000),
      u32(0x00480000),
      u32(0),
      u16(1),
      pascal('PNG', 32),
      u16(video.alpha ? 32 : 24),
      u16(0xffff),
      box('pasp', u32(1), u32(1)),
    )
    const stbl = box(
      'stbl',
      fullBox('stsd', 0, u32(1), entry),
      fullBox('stts', 0, frames > 0 ? u32s([1, frames, delta]) : u32(0)),
      fullBox('stsc', 0, frames > 0 ? u32s([1, 1, 1, 1]) : u32(0)),
      fullBox('stsz', 0, u32(0), u32(frames), u32s(this.frameSizes)),
      fullBox('co64', 0, u32(frames), concat(this.frameOffsets.map(u64))),
    )
    const minf = box('minf', fullBox('vmhd', 1, zeros(8)), handler('dhlr', 'alis', 'DataHandler'), dinf(), stbl)
    return this.track(id, ms, now, false, [video.width, video.height], this.media(timescale, duration, now, false, minf))
  }

  private audioTrack(id: number, audio: MovAudio, frames: number, ms: number, now: number): Uint8Array {
    const entry = box(
      'sowt',
      zeros(6),
      u16(1),
      u16(0),
      u16(0),
      u32(0),
      u16(audio.channels),
      u16(16),
      u16(0),
      u16(0),
      u32(audio.sampleRate * 0x10000),
    )
    const runs: number[] = []
    let runCount = 0
    let last = -1
    this.soundChunks.forEach((chunk, index) => {
      if (chunk.frames === last) return
      last = chunk.frames
      runs.push(index + 1, chunk.frames, 1)
      runCount++
    })
    const stbl = box(
      'stbl',
      fullBox('stsd', 0, u32(1), entry),
      fullBox('stts', 0, frames > 0 ? u32s([1, frames, 1]) : u32(0)),
      fullBox('stsc', 0, u32(runCount), u32s(runs)),
      fullBox('stsz', 0, u32(audio.channels * 2), u32(frames)),
      fullBox('co64', 0, u32(this.soundChunks.length), concat(this.soundChunks.map((c) => u64(c.offset)))),
    )
    const minf = box('minf', fullBox('smhd', 0, zeros(4)), handler('dhlr', 'alis', 'DataHandler'), dinf(), stbl)
    return this.track(id, ms, now, true, [0, 0], this.media(audio.sampleRate, frames, now, true, minf))
  }
}
