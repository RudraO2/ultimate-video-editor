// Character motion (Q7): idle life (blinks, breathing, sway, glances) and
// talking (loudness envelope, mouth shapes). Pure and deterministic: the same
// input always gives the same output, nothing reads a clock or a random
// source. Times are in ms unless a name says otherwise.

// ---------------------------------------------------------------- hashing

/** A 32-bit integer mix (murmur3 finaliser) of any number of numbers, as a value in [0, 1). */
export function hash01(...nums: number[]): number {
  let h = 0x9e3779b9
  const mix = (v: number) => {
    h ^= v | 0
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
    h ^= h >>> 16
    h = (h + 0x7f4a7c15) | 0
  }
  for (const n of nums) {
    const whole = Math.floor(n)
    mix(whole)
    mix(Math.floor((n - whole) * 4294967296))
  }
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 12
  h = Math.imul(h, 0x297a2d39)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

/** FNV-1a of a string, as an unsigned 32-bit integer (a seed for the functions below). */
export function seedOf(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Keeps a cache from growing for ever when parameters are dragged. */
function remember<K, V>(cache: Map<K, V>, key: K, make: () => V): V {
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  if (cache.size >= 64) cache.clear()
  const value = make()
  cache.set(key, value)
  return value
}

// ----------------------------------------------------------------- blinks

export interface BlinkParams {
  /** Seconds between blinks. */
  every: number
  /** How long the eyes stay shut, ms. */
  closedMs: number
  /** 0..100: how much the gap between blinks varies. */
  variance: number
  /** 0..100: chance of a quick second blink. */
  doubles: number
  seed: number
}

export interface BlinkWindow {
  startMs: number
  endMs: number
}

interface BlinkSchedule {
  windows: BlinkWindow[]
  /** Start of the next first blink not yet generated. */
  next: number
  k: number
}

const blinkCache = new Map<string, BlinkSchedule>()

function blinkShape(p: BlinkParams) {
  const period = Math.max(200, p.every * 1000)
  const shut = clamp(p.closedMs, 10, period / 2)
  return { period, shut, v: clamp(p.variance, 0, 100) / 100, d: clamp(p.doubles, 0, 100) / 100 }
}

function extendBlinks(s: BlinkSchedule, p: BlinkParams, untilMs: number): void {
  const { period, shut, v, d } = blinkShape(p)
  while (s.next <= untilMs) {
    const e = s.next
    const k = s.k
    s.windows.push({ startMs: e, endMs: e + shut })
    if (hash01(p.seed, k, 1) < d) s.windows.push({ startMs: e + 2.2 * shut, endMs: e + 3.2 * shut })
    s.next = Math.max(e + 3.5 * shut, e + period * (1 - v + 2 * v * hash01(p.seed, k, 2)))
    s.k = k + 1
  }
}

function blinkSchedule(p: BlinkParams, untilMs: number): BlinkSchedule {
  const key = JSON.stringify(p)
  const s = remember(blinkCache, key, () => {
    const { period } = blinkShape(p)
    return { windows: [], next: period * (0.3 + 0.7 * hash01(p.seed, 0, 0)), k: 0 }
  })
  extendBlinks(s, p, untilMs)
  return s
}

/** Every blink that starts before `untilMs`, in order. */
export function blinkWindows(p: BlinkParams, untilMs: number): BlinkWindow[] {
  const s = blinkSchedule(p, untilMs)
  return s.windows.filter((w) => w.startMs < untilMs)
}

/** 1 when the eyes are shut, 0.5 half shut (closing or opening), 0 open. Callers with no half drawing treat 0.5 as shut. */
export function blinkAt(p: BlinkParams, tMs: number): 0 | 0.5 | 1 {
  if (!(tMs >= 0)) return 0
  const s = blinkSchedule(p, tMs)
  const w = s.windows
  let lo = 0
  let hi = w.length - 1
  let at = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (w[mid]!.startMs <= tMs) {
      at = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  if (at < 0) return 0
  const win = w[at]!
  if (tMs >= win.endMs) return 0
  const u = (tMs - win.startMs) / (win.endMs - win.startMs)
  return u < 0.25 || u >= 0.8 ? 0.5 : 1
}

// ------------------------------------------------------- breathe and sway

/** A fraction to add to the scale: 0 at phase 0, `amount`% at the top of each breath. */
export function breatheAt(p: { amount: number; rate: number; phase: number }, tMs: number): number {
  const cycles = (p.rate / 60) * (tMs / 1000) + p.phase / 100
  return (p.amount / 100) * (0.5 - 0.5 * Math.cos(2 * Math.PI * cycles))
}

/** 1-D value noise in [0, 1]: hashed lattice points, smoothstep between them. */
function valueNoise(x: number, seed: number): number {
  const i = Math.floor(x)
  const f = x - i
  const a = hash01(seed, i)
  const b = hash01(seed, i + 1)
  const s = f * f * (3 - 2 * f)
  return a + (b - a) * s
}

/** A slow wander in [-amount, +amount] (three octaves of value noise). */
export function swayAt(p: { amount: number; speed: number; seed: number }, tMs: number): number {
  const x = (tMs / 1000) * p.speed
  const n =
    0.57 * valueNoise(x, p.seed) + 0.29 * valueNoise(2.03 * x + 17.1, p.seed) + 0.14 * valueNoise(4.01 * x + 31.7, p.seed)
  return (2 * n - 1) * p.amount
}

// ---------------------------------------------------------------- glances

export interface GlanceParams {
  rangeX: number
  rangeY: number
  /** Seconds between looks (varies by half to one and a half times). */
  hold: number
  moveMs: number
  /** 0..100: chance that a look goes back to the centre. */
  centre: number
  seed: number
}

interface GlanceStop {
  t: number
  x: number
  y: number
}

const glanceCache = new Map<string, GlanceStop[]>()

function glanceStops(p: GlanceParams, tMs: number): GlanceStop[] {
  const key = JSON.stringify([p.rangeX, p.rangeY, p.hold, p.centre, p.seed])
  const stops = remember(glanceCache, key, () => [{ t: 0, x: 0, y: 0 }])
  const gap = Math.max(200, p.hold * 1000)
  const c = clamp(p.centre, 0, 100) / 100
  for (;;) {
    const last = stops[stops.length - 1]!
    if (last.t > tMs) break
    const k = stops.length
    const t = last.t + gap * (0.5 + hash01(p.seed, k, 0))
    if (hash01(p.seed, k, 1) < c) stops.push({ t, x: 0, y: 0 })
    else stops.push({ t, x: (2 * hash01(p.seed, k, 2) - 1) * p.rangeX, y: (2 * hash01(p.seed, k, 3) - 1) * p.rangeY })
  }
  return stops
}

/** Where the eyes look: an eased move from one target to the next, then a hold. */
export function glanceAt(p: GlanceParams, tMs: number): { x: number; y: number } {
  if (!(tMs > 0)) return { x: 0, y: 0 }
  const stops = glanceStops(p, tMs)
  let lo = 0
  let hi = stops.length - 1
  let at = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (stops[mid]!.t <= tMs) {
      at = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  const cur = stops[at]!
  if (at === 0) return { x: cur.x, y: cur.y }
  const prev = stops[at - 1]!
  const u = clamp((tMs - cur.t) / Math.max(1, p.moveMs), 0, 1)
  const e = 1 - (1 - u) ** 3
  return { x: prev.x + (cur.x - prev.x) * e, y: prev.y + (cur.y - prev.y) * e }
}

// --------------------------------------------------------------- envelope

export interface Envelope {
  /** Values per second. */
  rate: number
  values: number[]
}

const ENV_RATE = 100
const ENV_HOP_MS = 10
const ENV_WINDOW_MS = 20
const ENV_FLOOR_DB = -42
const ENV_ATTACK_MS = 12
const ENV_RELEASE_MS = 70

/** How loud speech is, 0..1, 100 times a second (RMS of 20 ms windows, relative to the loud parts, over a 42 dB range, smoothed). */
export function envelopeFromSamples(samples: Float32Array, sampleRate: number): { rate: 100; values: number[] } {
  const len = samples.length
  if (len === 0 || !(sampleRate > 0)) return { rate: ENV_RATE, values: [] }
  const hop = (sampleRate * ENV_HOP_MS) / 1000
  const half = (sampleRate * ENV_WINDOW_MS) / 2000
  const frames = Math.ceil(len / hop)
  const sq = new Float64Array(len + 1)
  for (let i = 0; i < len; i++) {
    const s = samples[i]!
    sq[i + 1] = sq[i]! + s * s
  }
  const rms = new Float64Array(frames)
  for (let j = 0; j < frames; j++) {
    const centre = j * hop
    const a = Math.max(0, Math.round(centre - half))
    const b = Math.min(len, Math.round(centre + half))
    rms[j] = b > a ? Math.sqrt(Math.max(0, sq[b]! - sq[a]!) / (b - a)) : 0
  }
  const loud = Array.from(rms).filter((r) => r > 0)
  const values: number[] = new Array<number>(frames).fill(0)
  if (loud.length > 0) {
    loud.sort((x, y) => x - y)
    const ref = loud[Math.floor(0.98 * (loud.length - 1))]!
    const attack = 1 - Math.exp(-ENV_HOP_MS / ENV_ATTACK_MS)
    const release = 1 - Math.exp(-ENV_HOP_MS / ENV_RELEASE_MS)
    let y = 0
    for (let j = 0; j < frames; j++) {
      const r = rms[j]!
      const target = r > 0 ? clamp((20 * Math.log10(r / ref) - ENV_FLOOR_DB) / -ENV_FLOOR_DB, 0, 1) : 0
      y += (target - y) * (target > y ? attack : release)
      values[j] = Math.round(y * 1000) / 1000
    }
  }
  return { rate: ENV_RATE, values }
}

/** The loudness at a media time (linear between values, 0 outside). */
export function envelopeAt(env: Envelope, mediaMs: number): number {
  const n = env.values.length
  if (n === 0 || !(mediaMs >= 0)) return 0
  const pos = (mediaMs / 1000) * env.rate
  if (pos > n - 1) return 0
  const i = Math.floor(pos)
  const f = pos - i
  const a = env.values[i]!
  if (f === 0 || i + 1 >= n) return a
  return a + (env.values[i + 1]! - a) * f
}

// ------------------------------------------------------------------- talk

/** Our order: rest, closed lips, small, wide, round, small round. */
export const MOUTH_SHAPES = ['X', 'MBP', 'E', 'AI', 'O', 'U'] as const
export type MouthShape = (typeof MOUTH_SHAPES)[number]

export interface TalkOptions {
  /** Media time where the clip starts playing. */
  fromMs: number
  toMs: number
  /** Show each shape this many ms before the sound. */
  lead: number
  frameMs: number
  seed: number
}

export interface TalkBlock {
  startMs: number
  endMs: number
  shape: MouthShape
}

const STEP_MS = ENV_HOP_MS
const DIP = 0.08
const SAME_BAND_MS = 160
const SHORT_REST_MS = 150

const bandOf = (l: number) => (l < 0.12 ? 0 : l < 0.3 ? 1 : l < 0.6 ? 2 : 3)

function pickShape(band: number, syllable: number, seed: number): MouthShape {
  const h = hash01(seed, syllable, band)
  if (band === 0) return 'X'
  if (band === 1) return (['MBP', 'E', 'U'] as const)[Math.min(2, Math.floor(h * 3))]!
  if (band === 2) return h < 0.5 ? 'E' : 'O'
  return h < 2 / 3 ? 'AI' : 'O'
}

function mergeEqual(blocks: TalkBlock[]): TalkBlock[] {
  const out: TalkBlock[] = []
  for (const b of blocks) {
    const last = out[out.length - 1]
    if (last && last.shape === b.shape) last.endMs = b.endMs
    else out.push({ ...b })
  }
  return out
}

function computeBlocks(env: Envelope, o: TalkOptions): TalkBlock[] {
  if (!(o.toMs > o.fromMs)) return []
  // 1. One shape per 10 ms step, with syllable tracking.
  let blocks: TalkBlock[] = []
  let syllable = 0
  let band = -1
  let bandSince = o.fromMs
  let peak = 0
  let valley = 0
  for (let t = o.fromMs; t < o.toMs; t += STEP_MS) {
    const l = envelopeAt(env, t)
    const b = bandOf(l)
    if (band === -1) {
      peak = l
      valley = l
    } else {
      if (b !== band) bandSince = t
      let fresh = false
      if (band === 0 && b > 0) fresh = true
      else if (l - valley >= DIP && peak - valley >= DIP) fresh = true
      else if (b === band && t - bandSince >= SAME_BAND_MS) fresh = true
      if (fresh) {
        syllable++
        peak = l
        valley = l
        bandSince = t
      } else if (l > peak) {
        peak = l
        valley = l
      } else valley = Math.min(valley, l)
    }
    band = b
    blocks.push({ startMs: t, endMs: Math.min(o.toMs, t + STEP_MS), shape: pickShape(b, syllable, o.seed) })
  }
  blocks = mergeEqual(blocks)

  // 2. Minimum hold: absorb the shortest short block into its longer neighbour.
  const hold = Math.max(60, 2 * o.frameMs)
  for (;;) {
    if (blocks.length < 2) break
    let idx = -1
    let shortest = Infinity
    for (let i = 0; i < blocks.length; i++) {
      const d = blocks[i]!.endMs - blocks[i]!.startMs
      if (d < hold && d < shortest) {
        shortest = d
        idx = i
      }
    }
    if (idx < 0) break
    const prev = blocks[idx - 1]
    const next = blocks[idx + 1]
    const b = blocks[idx]!
    const intoPrev = prev && (!next || prev.endMs - prev.startMs >= next.endMs - next.startMs)
    if (intoPrev) prev.endMs = b.endMs
    else next!.startMs = b.startMs
    blocks.splice(idx, 1)
    blocks = mergeEqual(blocks)
  }

  // 3. A short rest between two shapes is lips closed.
  blocks = mergeEqual(
    blocks.map((b, i) =>
      b.shape === 'X' && i > 0 && i < blocks.length - 1 && b.endMs - b.startMs < SHORT_REST_MS
        ? { ...b, shape: 'MBP' as MouthShape }
        : b,
    ),
  )

  // 4. Lead (mouths move before the sound), then snap to the frame grid.
  const frame = o.frameMs > 0 ? o.frameMs : 0
  const starts: number[] = []
  let floor = o.fromMs
  blocks.forEach((b, i) => {
    let s = b.startMs
    if (i > 0) s -= b.shape === 'X' ? o.lead / 2 : o.lead
    if (frame > 0) s = o.fromMs + Math.round((s - o.fromMs) / frame) * frame
    if (i === 0) s = o.fromMs
    s = Math.max(s, floor)
    starts.push(s)
    floor = s
  })
  const out: TalkBlock[] = []
  blocks.forEach((b, i) => {
    const startMs = starts[i]!
    if (startMs >= o.toMs) return
    const endMs = i + 1 < blocks.length ? Math.min(o.toMs, starts[i + 1]!) : o.toMs
    if (endMs > startMs) out.push({ startMs, endMs, shape: b.shape })
  })
  return mergeEqual(out)
}

const talkCache = new WeakMap<object, Map<string, TalkBlock[]>>()

/** Mouth shapes to show over a stretch of media time, in media time. Blocks do not overlap and cover fromMs..toMs. */
export function talkBlocks(env: Envelope, opts: TalkOptions): TalkBlock[] {
  let per = talkCache.get(env)
  if (!per) {
    per = new Map()
    talkCache.set(env, per)
  }
  const key = JSON.stringify([opts.fromMs, opts.toMs, opts.lead, opts.frameMs, opts.seed])
  return remember(per, key, () => computeBlocks(env, opts))
}

/** The shape at a media time ('X' outside every block). */
export function talkShapeAt(blocks: readonly TalkBlock[], mediaMs: number): MouthShape {
  let lo = 0
  let hi = blocks.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const b = blocks[mid]!
    if (mediaMs < b.startMs) hi = mid - 1
    else if (mediaMs >= b.endMs) lo = mid + 1
    else return b.shape
  }
  return 'X'
}

// -------------------------------------------------------- mouth switching

const loose = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

const ALIASES: Record<MouthShape, string[]> = {
  X: ['rest', 'closed', 'neutral', 'm'],
  AI: ['a', 'open', 'wide', 'ah'],
  E: ['ee', 'smile'],
  O: ['oh', 'round'],
  U: ['oo', 'w', 'woo', 'uh'],
  MBP: ['m', 'b', 'p', 'closed'],
}

const FALLBACKS: Record<MouthShape, MouthShape[]> = {
  X: [],
  MBP: ['X'],
  E: ['AI'],
  AI: [],
  O: ['AI'],
  U: ['O', 'AI'],
}

const isShape = (s: string): s is MouthShape => (MOUTH_SHAPES as readonly string[]).includes(s)

/**
 * The index of the member to show for a mouth shape. Order: the `map` override
 * (shape to member name), the member named like the shape or one of its
 * aliases, a near shape (U to O to AI, E to AI, MBP to X), then the position
 * (members assumed to run from closed to open).
 */
export function mouthMember(shape: string, memberNames: string[], map?: Record<string, string>): number {
  const n = memberNames.length
  if (n === 0) return -1
  const names = memberNames.map(loose)
  const key = shape.toUpperCase()
  const canon: MouthShape | undefined = isShape(key) ? key : undefined

  if (map) {
    for (const [k, v] of Object.entries(map)) {
      if (loose(k) !== loose(shape)) continue
      const hit = names.indexOf(loose(v))
      if (hit >= 0) return hit
    }
  }
  const tryShape = (s: string, aliases: string[]): number => {
    const exact = names.indexOf(loose(s))
    if (exact >= 0) return exact
    for (const a of aliases) {
      const hit = names.indexOf(a)
      if (hit >= 0) return hit
    }
    return -1
  }
  if (!canon) {
    const hit = tryShape(shape, [])
    return hit >= 0 ? hit : 0
  }
  const direct = tryShape(canon, ALIASES[canon])
  if (direct >= 0) return direct
  // Fallback chain (U to O to AI is one step deeper than listed, so walk it).
  const seen = new Set<MouthShape>([canon])
  const queue = [...FALLBACKS[canon]]
  while (queue.length > 0) {
    const s = queue.shift()!
    if (seen.has(s)) continue
    seen.add(s)
    const hit = tryShape(s, ALIASES[s])
    if (hit >= 0) return hit
    queue.push(...FALLBACKS[s])
  }
  switch (canon) {
    case 'X':
    case 'MBP':
      return 0
    case 'E':
      return Math.round(0.4 * (n - 1))
    case 'U':
      return Math.round(0.35 * (n - 1))
    case 'O':
      return Math.round(0.7 * (n - 1))
    case 'AI':
      return n - 1
  }
}
