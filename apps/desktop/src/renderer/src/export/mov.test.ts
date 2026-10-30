import { describe, expect, it } from 'vitest'
import { MovWriter, movTimescale, type MovAudio, type MovVideo } from './mov'

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'dinf', 'stbl'])

interface Box {
  type: string
  start: number
  body: number
  end: number
  children: Box[]
}

const readBoxes = (view: DataView, start: number, end: number): Box[] => {
  const boxes: Box[] = []
  let at = start
  while (at < end) {
    let size = view.getUint32(at)
    const type = String.fromCharCode(view.getUint8(at + 4), view.getUint8(at + 5), view.getUint8(at + 6), view.getUint8(at + 7))
    let body = at + 8
    if (size === 1) {
      size = Number(view.getBigUint64(at + 8))
      body = at + 16
    }
    const box: Box = { type, start: at, body, end: at + size, children: [] }
    if (CONTAINERS.has(type)) box.children = readBoxes(view, body, box.end)
    boxes.push(box)
    at += size
  }
  return boxes
}

const child = (box: Box, type: string): Box => {
  const found = box.children.find((c) => c.type === type)
  if (!found) throw new Error(`no ${type} in ${box.type}`)
  return found
}

class Sink {
  data = new Uint8Array(0)
  write = async (position: number, bytes: Uint8Array): Promise<void> => {
    if (position + bytes.length > this.data.length) {
      const grown = new Uint8Array(position + bytes.length)
      grown.set(this.data)
      this.data = grown
    }
    this.data.set(bytes, position)
  }
  get view(): DataView {
    return new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength)
  }
  get boxes(): Box[] {
    return readBoxes(this.view, 0, this.data.length)
  }
  top(type: string): Box {
    const found = this.boxes.find((b) => b.type === type)
    if (!found) throw new Error(`no ${type}`)
    return found
  }
  tracks(): Box[] {
    return this.top('moov').children.filter((c) => c.type === 'trak')
  }
  u32(at: number): number {
    return this.view.getUint32(at)
  }
  u16(at: number): number {
    return this.view.getUint16(at)
  }
  fourcc(at: number): string {
    return String.fromCharCode(...this.data.slice(at, at + 4))
  }
}

const stbl = (track: Box): Box => child(child(child(track, 'mdia'), 'minf'), 'stbl')
const mdhd = (track: Box): Box => child(child(track, 'mdia'), 'mdhd')

const png = (n: number, size = 20): Uint8Array => Uint8Array.from({ length: size }, (_, i) => (0x89 + n + i) & 0xff)
const VIDEO: MovVideo = { width: 64, height: 48, fps: 30, alpha: false }
const AUDIO: MovAudio = { sampleRate: 48000, channels: 2 }
const tone = (frames: number, channels = 2): Int16Array => Int16Array.from({ length: frames * channels }, (_, i) => ((i * 37) % 65536) - 32768)

const make = async (tracks: { video: MovVideo | null; audio: MovAudio | null }, run: (w: MovWriter) => Promise<void>): Promise<Sink> => {
  const sink = new Sink()
  const writer = new MovWriter(sink.write, tracks)
  await writer.start()
  await run(writer)
  await writer.finish()
  return sink
}

describe('movTimescale', () => {
  it('keeps the frame rate in thousandths', () => {
    expect(movTimescale(30)).toEqual({ timescale: 30000, delta: 1000 })
    expect(movTimescale(29.97)).toEqual({ timescale: 29970, delta: 1000 })
    expect(movTimescale(23.976)).toEqual({ timescale: 23976, delta: 1000 })
    expect(movTimescale(60)).toEqual({ timescale: 60000, delta: 1000 })
  })

  it('refuses a frame rate that is not a positive number', () => {
    expect(() => movTimescale(0)).toThrow()
    expect(() => movTimescale(Number.NaN)).toThrow()
  })
})

describe('file layout', () => {
  it('starts with a qt ftyp and a 64-bit mdat that holds the samples', async () => {
    const frames = [png(0), png(1, 33), png(2, 7)]
    const pcm = tone(1200)
    const sink = await make({ video: VIDEO, audio: AUDIO }, async (w) => {
      await w.addSound(pcm)
      for (const f of frames) await w.addFrame(f)
    })
    const [ftyp, mdat, moov] = sink.boxes
    expect(ftyp!.type).toBe('ftyp')
    expect(sink.fourcc(ftyp!.body)).toBe('qt  ')
    expect(sink.u32(ftyp!.body + 4)).toBe(0x200)
    expect(sink.fourcc(ftyp!.body + 8)).toBe('qt  ')
    expect(mdat!.type).toBe('mdat')
    expect(sink.u32(mdat!.start)).toBe(1)
    const payload = pcm.length * 2 + frames.reduce((n, f) => n + f.length, 0)
    expect(mdat!.end - mdat!.body).toBe(payload)
    expect(moov!.type).toBe('moov')
    expect(moov!.end).toBe(sink.data.length)
  })

  it('puts every sample at its co64 offset with the exact bytes', async () => {
    const frames = [png(0), png(1, 33), png(2, 7)]
    const first = tone(500)
    const second = tone(300)
    const sink = await make({ video: VIDEO, audio: AUDIO }, async (w) => {
      await w.addSound(first)
      await w.addFrame(frames[0]!)
      await w.addFrame(frames[1]!)
      await w.addSound(second)
      await w.addFrame(frames[2]!)
    })
    const [video, audio] = sink.tracks()
    const vco = child(stbl(video!), 'co64')
    expect(sink.u32(vco.body + 4)).toBe(3)
    frames.forEach((frame, i) => {
      const at = Number(sink.view.getBigUint64(vco.body + 8 + i * 8))
      expect(Array.from(sink.data.slice(at, at + frame.length))).toEqual(Array.from(frame))
    })
    const aco = child(stbl(audio!), 'co64')
    expect(sink.u32(aco.body + 4)).toBe(2)
    ;[first, second].forEach((pcm, i) => {
      const at = Number(sink.view.getBigUint64(aco.body + 8 + i * 8))
      const view = new DataView(sink.data.buffer, at, pcm.length * 2)
      expect(Array.from(pcm, (_, k) => view.getInt16(k * 2, true))).toEqual(Array.from(pcm))
    })
  })
})

describe('video track', () => {
  it('describes png frames', async () => {
    const sink = await make({ video: VIDEO, audio: null }, async (w) => {
      for (let i = 0; i < 3; i++) await w.addFrame(png(i, 10 + i))
    })
    const [track] = sink.tracks()
    const stsd = child(stbl(track!), 'stsd')
    const entry = stsd.body + 8
    expect(sink.u32(stsd.body + 4)).toBe(1)
    expect(sink.fourcc(entry + 4)).toBe('png ')
    expect(sink.u16(entry + 8 + 6)).toBe(1)
    expect(sink.u16(entry + 8 + 24)).toBe(64)
    expect(sink.u16(entry + 8 + 26)).toBe(48)
    expect(sink.u32(entry + 8 + 28)).toBe(0x00480000)
    expect(sink.u16(entry + 8 + 40)).toBe(1)
    expect(sink.data[entry + 8 + 42]).toBe(3)
    expect(String.fromCharCode(...sink.data.slice(entry + 8 + 43, entry + 8 + 46))).toBe('PNG')
    expect(sink.u16(entry + 8 + 74)).toBe(24)
    expect(sink.u16(entry + 8 + 76)).toBe(0xffff)
  })

  it('writes depth 32 when the frames have alpha', async () => {
    const sink = await make({ video: { ...VIDEO, alpha: true }, audio: null }, (w) => w.addFrame(png(0)))
    const entry = child(stbl(sink.tracks()[0]!), 'stsd').body + 8
    expect(sink.u16(entry + 8 + 74)).toBe(32)
  })

  it('counts frames in stts, stsz, stsc and co64', async () => {
    const sizes = [10, 11, 12, 13]
    const sink = await make({ video: { ...VIDEO, fps: 29.97 }, audio: null }, async (w) => {
      for (const [i, size] of sizes.entries()) await w.addFrame(png(i, size))
    })
    const table = stbl(sink.tracks()[0]!)
    const stts = child(table, 'stts')
    expect([sink.u32(stts.body + 4), sink.u32(stts.body + 8), sink.u32(stts.body + 12)]).toEqual([1, 4, 1000])
    const stsc = child(table, 'stsc')
    expect([sink.u32(stsc.body + 4), sink.u32(stsc.body + 8), sink.u32(stsc.body + 12), sink.u32(stsc.body + 16)]).toEqual([1, 1, 1, 1])
    const stsz = child(table, 'stsz')
    expect(sink.u32(stsz.body + 4)).toBe(0)
    expect(sink.u32(stsz.body + 8)).toBe(4)
    expect(sizes.map((_, i) => sink.u32(stsz.body + 12 + i * 4))).toEqual(sizes)
    expect(sink.u32(child(table, 'co64').body + 4)).toBe(4)
    expect(table.children.some((c) => c.type === 'stss')).toBe(false)
    const media = mdhd(sink.tracks()[0]!)
    expect(sink.u32(media.body + 12)).toBe(29970)
    expect(sink.u32(media.body + 16)).toBe(4000)
  })

  it('sets the picture size in tkhd as 16.16', async () => {
    const sink = await make({ video: VIDEO, audio: null }, (w) => w.addFrame(png(0)))
    const tkhd = child(sink.tracks()[0]!, 'tkhd')
    expect(sink.u32(tkhd.body)).toBe(3)
    expect(sink.u32(tkhd.body + 12)).toBe(1)
    expect(sink.u32(tkhd.body + 76)).toBe(64 * 65536)
    expect(sink.u32(tkhd.body + 80)).toBe(48 * 65536)
  })
})

describe('audio track', () => {
  it('describes 16-bit sowt sound', async () => {
    const sink = await make({ video: null, audio: AUDIO }, (w) => w.addSound(tone(1000)))
    const table = stbl(sink.tracks()[0]!)
    const entry = child(table, 'stsd').body + 8
    expect(sink.fourcc(entry + 4)).toBe('sowt')
    expect(sink.u16(entry + 8 + 16)).toBe(2)
    expect(sink.u16(entry + 8 + 18)).toBe(16)
    expect(sink.u32(entry + 8 + 24)).toBe(48000 * 65536)
    const stsz = child(table, 'stsz')
    expect([sink.u32(stsz.body + 4), sink.u32(stsz.body + 8)]).toEqual([4, 1000])
    const stts = child(table, 'stts')
    expect([sink.u32(stts.body + 4), sink.u32(stts.body + 8), sink.u32(stts.body + 12)]).toEqual([1, 1000, 1])
    const media = mdhd(sink.tracks()[0]!)
    expect(sink.u32(media.body + 12)).toBe(48000)
    expect(sink.u32(media.body + 16)).toBe(1000)
    const tkhd = child(sink.tracks()[0]!, 'tkhd')
    expect(sink.u16(tkhd.body + 36)).toBe(0x0100)
  })

  it('merges chunks of the same length in stsc', async () => {
    const sink = await make({ video: null, audio: AUDIO }, async (w) => {
      await w.addSound(tone(48000))
      await w.addSound(tone(48000))
      await w.addSound(tone(1200))
    })
    const table = stbl(sink.tracks()[0]!)
    const stsc = child(table, 'stsc')
    expect(sink.u32(stsc.body + 4)).toBe(2)
    expect([sink.u32(stsc.body + 8), sink.u32(stsc.body + 12), sink.u32(stsc.body + 16)]).toEqual([1, 48000, 1])
    expect([sink.u32(stsc.body + 20), sink.u32(stsc.body + 24), sink.u32(stsc.body + 28)]).toEqual([3, 1200, 1])
    expect(sink.u32(child(table, 'co64').body + 4)).toBe(3)
    expect(sink.u32(child(table, 'stsz').body + 8)).toBe(97200)
  })

  it('ignores empty sound', async () => {
    const sink = await make({ video: null, audio: AUDIO }, async (w) => {
      await w.addSound(new Int16Array(0))
      await w.addSound(tone(10))
    })
    expect(sink.u32(child(stbl(sink.tracks()[0]!), 'co64').body + 4)).toBe(1)
  })
})

describe('movie header', () => {
  it('lasts as long as the longest track, in milliseconds', async () => {
    const sink = await make({ video: VIDEO, audio: AUDIO }, async (w) => {
      await w.addSound(tone(48000))
      for (let i = 0; i < 30; i++) await w.addFrame(png(i))
    })
    const mvhd = child(sink.top('moov'), 'mvhd')
    expect(sink.u32(mvhd.body + 12)).toBe(1000)
    expect(sink.u32(mvhd.body + 16)).toBe(1000)
    expect(sink.u32(mvhd.body + 20)).toBe(0x00010000)
    expect(sink.u16(mvhd.body + 24)).toBe(0x0100)
    expect(sink.u32(mvhd.body + 96)).toBe(3)
    const [video, audio] = sink.tracks()
    expect(sink.u32(child(video!, 'tkhd').body + 12)).toBe(1)
    expect(sink.u32(child(audio!, 'tkhd').body + 12)).toBe(2)
    expect(sink.u32(child(video!, 'tkhd').body + 20)).toBe(1000)
  })

  it('numbers a single track 1', async () => {
    const sink = await make({ video: null, audio: AUDIO }, (w) => w.addSound(tone(24000)))
    const mvhd = child(sink.top('moov'), 'mvhd')
    expect(sink.u32(mvhd.body + 16)).toBe(500)
    expect(sink.u32(mvhd.body + 96)).toBe(2)
    expect(sink.tracks()).toHaveLength(1)
    expect(sink.u32(child(sink.tracks()[0]!, 'tkhd').body + 12)).toBe(1)
  })

  it('writes a video-only file', async () => {
    const sink = await make({ video: { ...VIDEO, fps: 24 }, audio: null }, async (w) => {
      for (let i = 0; i < 12; i++) await w.addFrame(png(i))
    })
    expect(sink.tracks()).toHaveLength(1)
    expect(sink.u32(child(sink.top('moov'), 'mvhd').body + 16)).toBe(500)
  })
})

describe('misuse', () => {
  it('refuses a file with no tracks', () => {
    expect(() => new MovWriter(new Sink().write, { video: null, audio: null })).toThrow()
  })

  it('refuses a frame without a video track and sound without an audio track', async () => {
    const audioOnly = new MovWriter(new Sink().write, { video: null, audio: AUDIO })
    await audioOnly.start()
    await expect(audioOnly.addFrame(png(0))).rejects.toThrow('video')
    const videoOnly = new MovWriter(new Sink().write, { video: VIDEO, audio: null })
    await videoOnly.start()
    await expect(videoOnly.addSound(tone(10))).rejects.toThrow('audio')
  })

  it('refuses sound that is not whole sample frames', async () => {
    const writer = new MovWriter(new Sink().write, { video: null, audio: AUDIO })
    await writer.start()
    await expect(writer.addSound(new Int16Array(3))).rejects.toThrow('multiple')
  })

  it('refuses calls in the wrong order', async () => {
    const writer = new MovWriter(new Sink().write, { video: VIDEO, audio: null })
    await expect(writer.addFrame(png(0))).rejects.toThrow('start')
    await writer.start()
    await expect(writer.start()).rejects.toThrow('already')
    await writer.addFrame(png(0))
    await writer.finish()
    await expect(writer.addFrame(png(1))).rejects.toThrow('finished')
    await expect(writer.finish()).rejects.toThrow('finished')
  })
})
