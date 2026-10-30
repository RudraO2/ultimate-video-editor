import { describe, expect, it } from 'vitest'
import { GifWriter, gifDelays, lzwEncode, quantize, quantizeFrame } from './gif'

class Sink {
  data = new Uint8Array(0)
  writes = 0
  write = async (position: number, bytes: Uint8Array): Promise<void> => {
    expect(position).toBe(this.data.length)
    const grown = new Uint8Array(position + bytes.length)
    grown.set(this.data)
    grown.set(bytes, position)
    this.data = grown
    this.writes++
  }
}

/** A seeded generator so the random tests repeat. */
const rng = (seed: number): (() => number) => {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The GIF spec's LZW decoder, table of whole strings: slow, simple, independent of the encoder. */
const lzwDecode = (data: Uint8Array, minCode: number): { indices: number[]; clears: number } => {
  const clear = 1 << minCode
  const eoi = clear + 1
  const out: number[] = []
  let table: number[][] = []
  const reset = (): void => {
    table = []
    for (let i = 0; i < clear; i++) table.push([i])
    table.push([], [])
  }
  reset()
  let size = minCode + 1
  let prev: number[] | null = null
  let held = 0
  let bits = 0
  let at = 0
  let clears = 0
  for (;;) {
    while (bits < size) {
      if (at >= data.length) throw new Error('ran out of data before the end code')
      held |= data[at++]! << bits
      bits += 8
    }
    const code = held & ((1 << size) - 1)
    held >>>= size
    bits -= size
    if (code === clear) {
      clears++
      reset()
      size = minCode + 1
      prev = null
      continue
    }
    if (code === eoi) break
    let entry: number[]
    if (code < table.length) entry = table[code]!
    else if (code === table.length && prev) entry = [...prev, prev[0]!]
    else throw new Error(`bad code ${code}`)
    for (const v of entry) out.push(v)
    if (prev && table.length < 4096) table.push([...prev, entry[0]!])
    prev = entry
    if (table.length === 1 << size && size < 12) size++
  }
  return { indices: out, clears }
}

interface DecodedFrame {
  delay: number
  disposal: number
  transparentIndex: number | null
  palette: Uint8Array
  tableSizeField: number
  minCode: number
  blockSizes: number[]
  indices: number[]
}

interface Decoded {
  header: string
  width: number
  height: number
  globalTable: boolean
  loop: number | null
  frames: DecodedFrame[]
  trailer: boolean
}

const decodeGif = (data: Uint8Array): Decoded => {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const header = String.fromCharCode(...data.slice(0, 6))
  const width = view.getUint16(6, true)
  const height = view.getUint16(8, true)
  const globalTable = (data[10]! & 0x80) !== 0
  let at = 13
  if (globalTable) at += 3 * (1 << ((data[10]! & 7) + 1))
  const result: Decoded = { header, width, height, globalTable, loop: null, frames: [], trailer: false }
  let control: { delay: number; disposal: number; transparentIndex: number | null } = { delay: 0, disposal: 0, transparentIndex: null }
  const subBlocks = (): number[] => {
    const sizes: number[] = []
    while (data[at] !== 0) {
      sizes.push(data[at]!)
      at += 1 + data[at]!
    }
    at++
    return sizes
  }
  while (at < data.length) {
    const tag = data[at++]!
    if (tag === 0x3b) {
      result.trailer = true
      expect(at).toBe(data.length)
      break
    }
    if (tag === 0x21) {
      const label = data[at++]!
      if (label === 0xf9) {
        expect(data[at]).toBe(4)
        const packed = data[at + 1]!
        control = {
          delay: view.getUint16(at + 2, true),
          disposal: (packed >> 2) & 7,
          transparentIndex: packed & 1 ? data[at + 4]! : null,
        }
        expect(data[at + 5]).toBe(0)
        at += 6
      } else if (label === 0xff) {
        expect(data[at]).toBe(11)
        const name = String.fromCharCode(...data.slice(at + 1, at + 12))
        at += 12
        const start = at
        subBlocks()
        if (name === 'NETSCAPE2.0') {
          expect(data[start]).toBe(3)
          expect(data[start + 1]).toBe(1)
          result.loop = view.getUint16(start + 2, true)
        }
      } else {
        subBlocks()
      }
      continue
    }
    expect(tag).toBe(0x2c)
    expect(view.getUint16(at, true)).toBe(0)
    expect(view.getUint16(at + 2, true)).toBe(0)
    expect(view.getUint16(at + 4, true)).toBe(width)
    expect(view.getUint16(at + 6, true)).toBe(height)
    const packed = data[at + 8]!
    at += 9
    expect(packed & 0x80).toBe(0x80)
    expect(packed & 0x40).toBe(0)
    const tableSizeField = packed & 7
    const entries = 1 << (tableSizeField + 1)
    const palette = data.slice(at, at + entries * 3)
    at += entries * 3
    const minCode = data[at++]!
    const stream: number[] = []
    const blockSizes: number[] = []
    while (data[at] !== 0) {
      const n = data[at++]!
      blockSizes.push(n)
      for (let i = 0; i < n; i++) stream.push(data[at + i]!)
      at += n
    }
    at++
    const { indices } = lzwDecode(Uint8Array.from(stream), minCode)
    result.frames.push({ ...control, palette, tableSizeField, minCode, blockSizes, indices })
    control = { delay: 0, disposal: 0, transparentIndex: null }
  }
  return result
}

const rgbaOf = (colors: number[][], width: number, height: number, pick: (x: number, y: number) => number): Uint8ClampedArray => {
  const out = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = colors[pick(x, y)]!
      out.set([c[0]!, c[1]!, c[2]!, c[3] ?? 255], (y * width + x) * 4)
    }
  }
  return out
}

const colorAt = (frame: DecodedFrame, pixel: number): number[] => {
  const i = frame.indices[pixel]! * 3
  return [frame.palette[i]!, frame.palette[i + 1]!, frame.palette[i + 2]!]
}

describe('gifDelays', () => {
  it('keeps the total exact at 30 fps', () => {
    const delays = gifDelays(30, 30)
    expect(delays.slice(0, 3).reduce((a, b) => a + b, 0)).toBe(10)
    expect(delays.every((d) => d === 3 || d === 4)).toBe(true)
    expect(delays.reduce((a, b) => a + b, 0)).toBe(100)
  })

  it('gives 4 at 25 fps and 2 at 50 fps', () => {
    expect(gifDelays(25, 25).every((d) => d === 4)).toBe(true)
    expect(gifDelays(50, 50).every((d) => d === 2)).toBe(true)
  })

  it('never goes under 2, even at 60 fps', () => {
    const delays = gifDelays(120, 60)
    expect(delays).toHaveLength(120)
    expect(delays.every((d) => d >= 2)).toBe(true)
  })

  it('rejects bad input', () => {
    expect(() => gifDelays(3, 0)).toThrow()
    expect(() => gifDelays(-1, 30)).toThrow()
    expect(gifDelays(0, 30)).toEqual([])
  })
})

describe('lzwEncode', () => {
  it('round-trips random data through table resets', () => {
    const next = rng(7)
    const indices = Uint8Array.from({ length: 200_000 }, () => Math.floor(next() * 256))
    const { indices: back, clears } = lzwDecode(lzwEncode(indices, 8), 8)
    expect(clears).toBeGreaterThan(2)
    expect(back.length).toBe(indices.length)
    expect(Uint8Array.from(back)).toEqual(indices)
  })

  it('round-trips every length around the code size steps', () => {
    const next = rng(11)
    for (const minCode of [2, 3, 4, 8]) {
      const alphabet = 1 << minCode
      for (let n = 0; n <= 600; n += n < 40 ? 1 : 7) {
        const indices = Uint8Array.from({ length: n }, () => Math.floor(next() * alphabet))
        const { indices: back } = lzwDecode(lzwEncode(indices, minCode), minCode)
        expect(Uint8Array.from(back)).toEqual(indices)
      }
    }
  })

  it('compresses a flat run', () => {
    const indices = new Uint8Array(100_000).fill(3)
    const stream = lzwEncode(indices, 2)
    expect(stream.length).toBeLessThan(1000)
    expect(Uint8Array.from(lzwDecode(stream, 2).indices)).toEqual(indices)
  })

  it('refuses an index that does not fit', () => {
    expect(() => lzwEncode(Uint8Array.of(4), 2)).toThrow()
    expect(() => lzwEncode(Uint8Array.of(0), 1)).toThrow()
  })
})

describe('quantize', () => {
  it('keeps a flat image exact', () => {
    const colors = [
      [255, 0, 0],
      [0, 255, 0],
      [1, 2, 3],
    ]
    const rgba = rgbaOf(colors, 9, 3, (x) => x % 3)
    const q = quantize(rgba, 256)
    expect(q.palette.length).toBe(9)
    for (let p = 0; p < 27; p++) {
      expect([...q.palette.slice(q.indices[p]! * 3, q.indices[p]! * 3 + 3)]).toEqual(colors[p % 3])
    }
  })

  it('keeps a gradient within 256 colours and a small error', () => {
    const width = 256
    const height = 64
    const rgba = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) rgba.set([x, y * 4, (x + y * 3) & 255, 255], (y * width + x) * 4)
    }
    const q = quantize(rgba, 256)
    expect(q.palette.length / 3).toBeLessThanOrEqual(256)
    let error = 0
    for (let p = 0; p < width * height; p++) {
      for (let c = 0; c < 3; c++) error += Math.abs(rgba[p * 4 + c]! - q.palette[q.indices[p]! * 3 + c]!)
    }
    expect(error / (width * height * 3)).toBeLessThan(6)
  })

  it('honours a smaller limit', () => {
    const next = rng(3)
    const rgba = Uint8ClampedArray.from({ length: 4000 * 4 }, (_, i) => (i % 4 === 3 ? 255 : Math.floor(next() * 256)))
    const q = quantize(rgba, 16)
    expect(q.palette.length / 3).toBeLessThanOrEqual(16)
    expect(Math.max(...q.indices)).toBeLessThan(q.palette.length / 3)
  })

  it('handles a 1920x1080 noisy frame quickly enough to measure', () => {
    const next = rng(5)
    const rgba = new Uint8ClampedArray(1920 * 1080 * 4)
    for (let i = 0; i < rgba.length; i++) rgba[i] = i % 4 === 3 ? 255 : Math.floor(next() * 256)
    const t0 = performance.now()
    const q = quantize(rgba, 256)
    const t1 = performance.now()
    const stream = lzwEncode(q.indices, 8)
    const t2 = performance.now()
    console.info(`gif 1080p noise: quantize ${(t1 - t0).toFixed(0)} ms, lzw ${(t2 - t1).toFixed(0)} ms`)
    expect(q.palette.length / 3).toBeLessThanOrEqual(256)
    expect(stream.length).toBeGreaterThan(0)
  })
})

describe('quantizeFrame', () => {
  it('ignores alpha when opaque', () => {
    const rgba = Uint8ClampedArray.of(10, 20, 30, 0, 10, 20, 30, 255)
    const q = quantizeFrame(rgba, false)
    expect(q.transparentIndex).toBeNull()
    expect(q.palette.length).toBe(3)
    expect([...q.indices]).toEqual([0, 0])
  })

  it('reserves one index for see-through pixels', () => {
    const next = rng(9)
    const pixels = 2000
    const rgba = Uint8ClampedArray.from({ length: pixels * 4 }, (_, i) => (i % 4 === 3 ? (Math.floor(i / 4) % 4 === 0 ? 0 : 255) : Math.floor(next() * 256)))
    const q = quantizeFrame(rgba, true)
    expect(q.transparentIndex).not.toBeNull()
    expect(q.palette.length / 3).toBeLessThanOrEqual(256)
    for (let p = 0; p < pixels; p++) {
      if (p % 4 === 0) expect(q.indices[p]).toBe(q.transparentIndex)
      else expect(q.indices[p]).not.toBe(q.transparentIndex)
    }
  })
})

describe('GifWriter', () => {
  const colors = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [250, 250, 20],
    [5, 5, 5],
  ]

  it('writes the header, the loop extension and a trailer', async () => {
    const sink = new Sink()
    const gif = new GifWriter(sink.write, { width: 4, height: 2 })
    await gif.start()
    await gif.finish()
    const d = decodeGif(sink.data)
    expect(d.header).toBe('GIF89a')
    expect([d.width, d.height]).toEqual([4, 2])
    expect(d.globalTable).toBe(false)
    expect(d.loop).toBe(0)
    expect(d.frames).toHaveLength(0)
    expect(d.trailer).toBe(true)
  })

  it('round-trips two flat frames with their delays', async () => {
    const sink = new Sink()
    const width = 12
    const height = 7
    const gif = new GifWriter(sink.write, { width, height })
    await gif.start()
    const a = rgbaOf(colors, width, height, (x, y) => (x + y) % 5)
    const b = rgbaOf(colors, width, height, (x) => (x < 6 ? 3 : 4))
    await gif.addFrame(a, 3, false)
    await gif.addFrame(b, 4, false)
    await gif.finish()
    expect(sink.writes).toBe(4)
    const d = decodeGif(sink.data)
    expect(d.frames).toHaveLength(2)
    const [fa, fb] = d.frames as [DecodedFrame, DecodedFrame]
    expect([fa.delay, fb.delay]).toEqual([3, 4])
    for (const f of d.frames) {
      expect(f.disposal).toBe(1)
      expect(f.transparentIndex).toBeNull()
      expect(f.indices).toHaveLength(width * height)
    }
    // Five colours: a table of 8, size field 2, code size 3.
    expect(fa.palette.length).toBe(8 * 3)
    expect(fa.tableSizeField).toBe(2)
    expect(fa.minCode).toBe(3)
    // Two colours: a table of 2, size field 0, code size 2 at least.
    expect(fb.palette.length).toBe(2 * 3)
    expect(fb.tableSizeField).toBe(0)
    expect(fb.minCode).toBe(2)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        expect(colorAt(fa, y * width + x)).toEqual(colors[(x + y) % 5])
        expect(colorAt(fb, y * width + x)).toEqual(colors[x < 6 ? 3 : 4])
      }
    }
    const q = quantizeFrame(a, false)
    expect(fa.indices).toEqual([...q.indices])
  })

  it('marks transparent frames and splits long code streams into blocks', async () => {
    const sink = new Sink()
    const width = 64
    const height = 64
    const next = rng(21)
    const rgba = new Uint8ClampedArray(width * height * 4)
    for (let p = 0; p < width * height; p++) {
      const alpha = p === 0 ? 127 : p === 1 ? 128 : p === 2 ? 0 : 255
      rgba.set([Math.floor(next() * 256), Math.floor(next() * 256), Math.floor(next() * 256), alpha], p * 4)
    }
    const gif = new GifWriter(sink.write, { width, height })
    await gif.start()
    await gif.addFrame(rgba, 5, true)
    await gif.finish()
    const d = decodeGif(sink.data)
    const f = d.frames[0]!
    expect(f.disposal).toBe(2)
    expect(f.delay).toBe(5)
    expect(f.transparentIndex).not.toBeNull()
    expect(f.indices[0]).toBe(f.transparentIndex)
    expect(f.indices[2]).toBe(f.transparentIndex)
    expect(f.indices[1]).not.toBe(f.transparentIndex)
    expect(f.indices[3]).not.toBe(f.transparentIndex)
    expect(f.blockSizes.length).toBeGreaterThan(1)
    expect(f.blockSizes.slice(0, -1).every((n) => n === 255)).toBe(true)
    expect(f.blockSizes.at(-1)!).toBeLessThanOrEqual(255)
  })

  it('keeps flat transparent graphics exact', async () => {
    const sink = new Sink()
    const width = 6
    const height = 4
    const clear = [0, 0, 0, 0]
    const set = [[10, 200, 30], clear, [250, 250, 250]]
    const rgba = rgbaOf(set, width, height, (x) => x % 3)
    const gif = new GifWriter(sink.write, { width, height })
    await gif.start()
    await gif.addFrame(rgba, 2, true)
    await gif.finish()
    const f = decodeGif(sink.data).frames[0]!
    for (let p = 0; p < width * height; p++) {
      if (p % 3 === 1) expect(f.indices[p]).toBe(f.transparentIndex)
      else expect(colorAt(f, p)).toEqual(set[p % 3])
    }
  })

  it('checks sizes and call order', async () => {
    expect(() => new GifWriter(async () => {}, { width: 0, height: 1 })).toThrow()
    expect(() => new GifWriter(async () => {}, { width: 70000, height: 1 })).toThrow()
    const gif = new GifWriter(async () => {}, { width: 2, height: 2 })
    await expect(gif.addFrame(new Uint8ClampedArray(16), 3, false)).rejects.toThrow()
    await gif.start()
    await expect(gif.start()).rejects.toThrow()
    await expect(gif.addFrame(new Uint8ClampedArray(12), 3, false)).rejects.toThrow()
    await gif.finish()
    await expect(gif.addFrame(new Uint8ClampedArray(16), 3, false)).rejects.toThrow()
  })
})
