/** A frame reduced to at most 256 colours: `palette` is r,g,b triples, `indices` has one entry per pixel. */
export interface Quantized {
  palette: Uint8Array
  indices: Uint8Array
}

/** A quantized GIF frame. `transparentIndex` is the reserved palette entry for see-through pixels, or null. */
export interface QuantizedFrame extends Quantized {
  transparentIndex: number | null
}

const KEY_BITS = 5
const KEY_COUNT = 1 << (KEY_BITS * 3)
const CHANNEL_SHIFTS = [10, 5, 0] as const
/** Marks see-through pixels while a frame is being quantized; never a real index, because those stop at 254 then. */
const CUT = 255
const MAX_LZW_BITS = 12
const MAX_LZW_CODES = 1 << MAX_LZW_BITS

/**
 * The frame delays in centiseconds for `frameCount` frames at `fps`. Delays are accumulated, so the total
 * stays exact: delay n is round(100 (n+1) / fps) - round(100 n / fps). Each is at least 2, because GIF
 * players treat 0 and 1 as about 10.
 */
export function gifDelays(frameCount: number, fps: number): number[] {
  if (!Number.isInteger(frameCount) || frameCount < 0) throw new Error('The frame count must be a whole number of 0 or more.')
  if (!Number.isFinite(fps) || fps <= 0) throw new Error('fps must be a positive number.')
  const delays: number[] = []
  let before = 0
  for (let n = 0; n < frameCount; n++) {
    const after = Math.round((100 * (n + 1)) / fps)
    delays.push(Math.max(2, after - before))
    before = after
  }
  return delays
}

interface Box {
  start: number
  end: number
  weight: number
  channel: number
  range: number
}

/** Measures the buckets `order[start, end)`: their total weight and the widest channel. */
const measure = (order: Int32Array, counts: Uint32Array, start: number, end: number): Box => {
  let weight = 0
  let loR = 31
  let hiR = 0
  let loG = 31
  let hiG = 0
  let loB = 31
  let hiB = 0
  for (let i = start; i < end; i++) {
    const key = order[i]!
    weight += counts[key]!
    const r = key >> 10
    const g = (key >> 5) & 31
    const b = key & 31
    if (r < loR) loR = r
    if (r > hiR) hiR = r
    if (g < loG) loG = g
    if (g > hiG) hiG = g
    if (b < loB) loB = b
    if (b > hiB) hiB = b
  }
  const rangeR = hiR - loR
  const rangeG = hiG - loG
  const rangeB = hiB - loB
  let channel = 0
  let range = rangeR
  if (rangeG > range) {
    channel = 1
    range = rangeG
  }
  if (rangeB > range) {
    channel = 2
    range = rangeB
  }
  return { start, end, weight, channel, range }
}

/** Reduces `rgba` to at most `maxColors` colours. With `cutAlpha`, pixels of alpha under 128 get index CUT and are left out of the palette. Returns the palette, the indices and the count of cut pixels. */
const reduce = (rgba: Uint8ClampedArray, maxColors: number, cutAlpha: boolean): Quantized & { cut: number } => {
  const pixels = rgba.length >> 2
  const indices = new Uint8Array(pixels)
  let cut = 0

  // Few distinct colours (flat graphics): keep them exactly.
  const table = new Int32Array(1024).fill(-1)
  const slotIndex = new Uint8Array(1024)
  const exact = new Uint8Array(maxColors * 3)
  let count = 0
  let fits = true
  let lastKey = -1
  let lastIndex = 0
  for (let p = 0, i = 0; p < pixels; p++, i += 4) {
    if (cutAlpha && rgba[i + 3]! < 128) {
      indices[p] = CUT
      cut++
      continue
    }
    const r = rgba[i]!
    const g = rgba[i + 1]!
    const b = rgba[i + 2]!
    const key = (r << 16) | (g << 8) | b
    if (key === lastKey) {
      indices[p] = lastIndex
      continue
    }
    let slot = Math.imul(key, 0x9e3779b1) >>> 22
    while (table[slot] !== -1 && table[slot] !== key) slot = (slot + 1) & 1023
    if (table[slot] === -1) {
      if (count === maxColors) {
        fits = false
        break
      }
      table[slot] = key
      slotIndex[slot] = count
      exact[count * 3] = r
      exact[count * 3 + 1] = g
      exact[count * 3 + 2] = b
      count++
    }
    lastKey = key
    lastIndex = slotIndex[slot]!
    indices[p] = lastIndex
  }
  if (fits) return { palette: exact.slice(0, count * 3), indices, cut }

  // Median cut over a histogram of 5-bit colours, each bucket remembering its exact channel sums.
  cut = 0
  const counts = new Uint32Array(KEY_COUNT)
  const sumR = new Uint32Array(KEY_COUNT)
  const sumG = new Uint32Array(KEY_COUNT)
  const sumB = new Uint32Array(KEY_COUNT)
  for (let i = 0; i < rgba.length; i += 4) {
    if (cutAlpha && rgba[i + 3]! < 128) {
      cut++
      continue
    }
    const r = rgba[i]!
    const g = rgba[i + 1]!
    const b = rgba[i + 2]!
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
    counts[key]!++
    sumR[key]! += r
    sumG[key]! += g
    sumB[key]! += b
  }
  let buckets = 0
  for (let key = 0; key < KEY_COUNT; key++) if (counts[key]! > 0) buckets++
  const order = new Int32Array(buckets)
  for (let key = 0, at = 0; key < KEY_COUNT; key++) if (counts[key]! > 0) order[at++] = key
  const scratch = new Int32Array(buckets)

  const boxes: Box[] = [measure(order, counts, 0, buckets)]
  const channelWeight = new Uint32Array(32)
  const target = Math.min(maxColors, buckets)
  while (boxes.length < target) {
    let pick = -1
    for (let b = 0; b < boxes.length; b++) {
      const box = boxes[b]!
      if (box.range > 0 && (pick < 0 || box.weight > boxes[pick]!.weight)) pick = b
    }
    if (pick < 0) break
    const box = boxes[pick]!
    const shift = CHANNEL_SHIFTS[box.channel]!
    channelWeight.fill(0)
    for (let i = box.start; i < box.end; i++) {
      const key = order[i]!
      channelWeight[(key >> shift) & 31]! += counts[key]!
    }
    // The weighted median value along the widest channel; it must leave something on the right.
    let high = 0
    for (let v = 31; v >= 0; v--) {
      if (channelWeight[v]! > 0) {
        high = v
        break
      }
    }
    let threshold = 0
    let running = 0
    for (let v = 0; v < 32; v++) {
      running += channelWeight[v]!
      if (running * 2 >= box.weight) {
        threshold = v
        break
      }
    }
    if (threshold >= high) threshold = high - 1
    let left = box.start
    let right = 0
    for (let i = box.start; i < box.end; i++) {
      const key = order[i]!
      if (((key >> shift) & 31) <= threshold) order[left++] = key
      else scratch[right++] = key
    }
    for (let j = 0; j < right; j++) order[left + j] = scratch[j]!
    boxes[pick] = measure(order, counts, box.start, left)
    boxes.push(measure(order, counts, left, box.end))
  }

  const palette = new Uint8Array(boxes.length * 3)
  const boxOf = new Int16Array(KEY_COUNT).fill(-1)
  for (let b = 0; b < boxes.length; b++) {
    const box = boxes[b]!
    let r = 0
    let g = 0
    let bl = 0
    for (let i = box.start; i < box.end; i++) {
      const key = order[i]!
      r += sumR[key]!
      g += sumG[key]!
      bl += sumB[key]!
      boxOf[key] = b
    }
    palette[b * 3] = Math.round(r / box.weight)
    palette[b * 3 + 1] = Math.round(g / box.weight)
    palette[b * 3 + 2] = Math.round(bl / box.weight)
  }

  // Each pixel takes the palette colour nearest to its bucket's mean, worked out once per bucket.
  const size = boxes.length
  const cache = new Int16Array(KEY_COUNT).fill(-1)
  for (let p = 0, i = 0; p < pixels; p++, i += 4) {
    if (cutAlpha && rgba[i + 3]! < 128) {
      indices[p] = CUT
      continue
    }
    const key = ((rgba[i]! >> 3) << 10) | ((rgba[i + 1]! >> 3) << 5) | (rgba[i + 2]! >> 3)
    let found = cache[key]!
    if (found < 0) {
      const weight = counts[key]!
      const r = sumR[key]! / weight
      const g = sumG[key]! / weight
      const b = sumB[key]! / weight
      let best = boxOf[key]!
      let bestDistance = (palette[best * 3]! - r) ** 2 + (palette[best * 3 + 1]! - g) ** 2 + (palette[best * 3 + 2]! - b) ** 2
      for (let c = 0; c < size; c++) {
        const dr = palette[c * 3]! - r
        let d = dr * dr
        if (d >= bestDistance) continue
        const dg = palette[c * 3 + 1]! - g
        d += dg * dg
        if (d >= bestDistance) continue
        const db = palette[c * 3 + 2]! - b
        d += db * db
        if (d < bestDistance) {
          bestDistance = d
          best = c
        }
      }
      found = best
      cache[key] = found
    }
    indices[p] = found
  }
  return { palette, indices, cut }
}

/**
 * Reduces an RGBA frame to at most `maxColors` colours (1 to 256) with a median cut, no dithering. A frame
 * that already has that few distinct colours keeps them exactly.
 */
export function quantize(rgba: Uint8ClampedArray, maxColors: number): Quantized {
  if (!Number.isInteger(maxColors) || maxColors < 1 || maxColors > 256) throw new Error('maxColors must be a whole number from 1 to 256.')
  if (rgba.length % 4 !== 0) throw new Error('The pixel data must be RGBA, 4 bytes a pixel.')
  const { palette, indices } = reduce(rgba, maxColors, false)
  return { palette, indices }
}

/**
 * Quantizes one animation frame from unpremultiplied RGBA. When `transparent`, pixels of alpha under 128 take
 * one reserved index (`transparentIndex`, the last palette entry) and the rest use at most 255 colours;
 * otherwise alpha is ignored and up to 256 colours are used.
 */
export function quantizeFrame(rgba: Uint8ClampedArray, transparent: boolean): QuantizedFrame {
  if (rgba.length % 4 !== 0) throw new Error('The pixel data must be RGBA, 4 bytes a pixel.')
  if (!transparent) {
    const { palette, indices } = reduce(rgba, 256, false)
    return { palette, indices, transparentIndex: null }
  }
  const { palette, indices, cut } = reduce(rgba, 255, true)
  const reserved = palette.length / 3
  if (cut > 0) {
    for (let p = 0; p < indices.length; p++) if (indices[p] === CUT) indices[p] = reserved
  }
  const withReserved = new Uint8Array(palette.length + 3)
  withReserved.set(palette)
  return { palette: withReserved, indices, transparentIndex: reserved }
}

/**
 * GIF variable-length LZW: a clear code first, codes of up to 12 bits, a clear code and a fresh table when
 * the table is full, and an end-of-information code last. Returns the code stream packed from the low bit,
 * not yet split into sub-blocks. `minCodeSize` is 2 to 8 bits.
 */
export function lzwEncode(indices: Uint8Array, minCodeSize: number): Uint8Array {
  if (!Number.isInteger(minCodeSize) || minCodeSize < 2 || minCodeSize > 8) throw new Error('The minimum code size must be 2 to 8.')
  const clear = 1 << minCodeSize
  const eoi = clear + 1
  let out = new Uint8Array(Math.max(256, indices.length >> 1))
  let length = 0
  let bits = 0
  let held = 0
  let codeSize = minCodeSize + 1
  let next = eoi + 1

  // Open addressing: a key is (prefix code, next byte); a value is the code of that string.
  const slots = 1 << 14
  const keys = new Int32Array(slots).fill(-1)
  const values = new Int16Array(slots)

  const emit = (code: number): void => {
    held |= code << bits
    bits += codeSize
    while (bits >= 8) {
      if (length === out.length) {
        const grown = new Uint8Array(out.length * 2)
        grown.set(out)
        out = grown
      }
      out[length++] = held & 0xff
      held >>>= 8
      bits -= 8
    }
  }

  emit(clear)
  if (indices.length > 0) {
    let prefix = indices[0]!
    if (prefix >= clear) throw new Error('A pixel index does not fit the minimum code size.')
    for (let i = 1; i < indices.length; i++) {
      const byte = indices[i]!
      if (byte >= clear) throw new Error('A pixel index does not fit the minimum code size.')
      const key = (prefix << 8) | byte
      let slot = Math.imul(key, 0x9e3779b1) >>> 18
      while (keys[slot] !== -1 && keys[slot] !== key) slot = (slot + 1) & (slots - 1)
      if (keys[slot] === key) {
        prefix = values[slot]!
        continue
      }
      emit(prefix)
      if (next < MAX_LZW_CODES) {
        keys[slot] = key
        values[slot] = next
        if (next === 1 << codeSize) codeSize++
        next++
      } else {
        emit(clear)
        keys.fill(-1)
        codeSize = minCodeSize + 1
        next = eoi + 1
      }
      prefix = byte
    }
    emit(prefix)
    // The decoder adds one more entry here, so its code size can grow before the end code.
    if (next < MAX_LZW_CODES) {
      if (next === 1 << codeSize) codeSize++
      next++
    }
  }
  emit(eoi)
  if (bits > 0) {
    if (length === out.length) {
      const grown = new Uint8Array(out.length + 1)
      grown.set(out)
      out = grown
    }
    out[length++] = held & 0xff
  }
  return out.slice(0, length)
}

const log2Ceil = (n: number): number => {
  let bits = 0
  while (1 << bits < n) bits++
  return bits
}

/** Writes a looping animated GIF (GIF89a) through `write(position, data)`, one full-size frame at a time. Positions only increase. */
export class GifWriter {
  private position = 0
  private started = false
  private finished = false

  constructor(
    private readonly write: (position: number, data: Uint8Array) => Promise<void>,
    private readonly size: { width: number; height: number },
  ) {
    for (const side of [size.width, size.height]) {
      if (!Number.isInteger(side) || side < 1 || side > 65535) throw new Error('The picture size must be whole pixels from 1 to 65535.')
    }
  }

  private async put(data: Uint8Array): Promise<void> {
    await this.write(this.position, data)
    this.position += data.length
  }

  /** Writes the header, the screen descriptor and the loop-forever extension. Call it once, first. */
  async start(): Promise<void> {
    if (this.started) throw new Error('start() was already called.')
    this.started = true
    const { width, height } = this.size
    const head = new Uint8Array(13 + 19)
    const text = (at: number, s: string): void => {
      for (let i = 0; i < s.length; i++) head[at + i] = s.charCodeAt(i)
    }
    text(0, 'GIF89a')
    head[6] = width & 0xff
    head[7] = width >> 8
    head[8] = height & 0xff
    head[9] = height >> 8
    // No global colour table, 1 bit of colour resolution, background 0, aspect ratio 0.
    head[10] = 0x00
    head[11] = 0
    head[12] = 0
    head[13] = 0x21
    head[14] = 0xff
    head[15] = 11
    text(16, 'NETSCAPE2.0')
    head[27] = 3
    head[28] = 1
    head[29] = 0 // loop count 0: forever
    head[30] = 0
    head[31] = 0
    await this.put(head)
  }

  /**
   * Appends one frame from unpremultiplied RGBA, shown for `delayCs` centiseconds. A transparent frame
   * is cleared to the background before the next one (disposal 2); an opaque one is painted over.
   */
  async addFrame(rgba: Uint8ClampedArray, delayCs: number, transparent: boolean): Promise<void> {
    if (!this.started) throw new Error('Call start() before adding frames.')
    if (this.finished) throw new Error('The file is already finished.')
    const { width, height } = this.size
    if (rgba.length !== width * height * 4) throw new Error('The frame does not match the picture size.')
    if (!Number.isFinite(delayCs) || delayCs < 0) throw new Error('The delay must be 0 or more centiseconds.')
    const delay = Math.min(65535, Math.round(delayCs))

    const frame = quantizeFrame(rgba, transparent)
    const colors = frame.palette.length / 3
    const bits = Math.max(1, log2Ceil(colors))
    const entries = 1 << bits
    const minCodeSize = Math.max(2, bits)
    const codes = lzwEncode(frame.indices, minCodeSize)
    const blocks = Math.ceil(codes.length / 255)

    const total = 8 + 10 + entries * 3 + 1 + codes.length + blocks + 1
    const out = new Uint8Array(total)
    let at = 0
    // Graphic control extension.
    out[at++] = 0x21
    out[at++] = 0xf9
    out[at++] = 4
    out[at++] = ((transparent ? 2 : 1) << 2) | (frame.transparentIndex === null ? 0 : 1)
    out[at++] = delay & 0xff
    out[at++] = delay >> 8
    out[at++] = frame.transparentIndex ?? 0
    out[at++] = 0
    // Image descriptor: the whole screen, a local colour table of `entries` colours.
    out[at++] = 0x2c
    out[at++] = 0
    out[at++] = 0
    out[at++] = 0
    out[at++] = 0
    out[at++] = width & 0xff
    out[at++] = width >> 8
    out[at++] = height & 0xff
    out[at++] = height >> 8
    out[at++] = 0x80 | (bits - 1)
    out.set(frame.palette, at)
    at += entries * 3
    out[at++] = minCodeSize
    for (let from = 0; from < codes.length; from += 255) {
      const chunk = Math.min(255, codes.length - from)
      out[at++] = chunk
      out.set(codes.subarray(from, from + chunk), at)
      at += chunk
    }
    out[at++] = 0
    await this.put(out)
  }

  /** Writes the trailer. Call it once, last. */
  async finish(): Promise<void> {
    if (!this.started) throw new Error('Call start() before finish().')
    if (this.finished) throw new Error('finish() was already called.')
    this.finished = true
    await this.put(Uint8Array.of(0x3b))
  }
}
