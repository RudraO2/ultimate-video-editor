import {
  ALL_TARGET_LUFS,
  type Comp,
  categoryTarget,
  type DuckRule,
  type SoundCategory,
  type SoundHit,
  type SoundMix,
} from '@uve/core'
import { continues, type MediaLayer } from './audio'

// The mix as data: which bus each sound goes to and the gains it gets there,
// computed once from the document and the measured loudness of each sound.
// The export (mixStream.ts) and the preview's Web Audio graph both apply this
// plan, so they sound the same. The rules follow AtomCut's mixer (see
// docs/research/atomcut-inspiration.md ▸ "The mix"); the code is ours.

/** Steps of the duck tables, ms. */
export const DUCK_STEP_MS = 10
/** A fired cue counts as sounding for this long, for ducking. */
const CUE_ACTIVE_MS = 80
/** Cues of one sound closer than this count as rapid fire. */
const RAPID_WINDOW_MS = 400
/** Rapid-fire cues (two or more in the window) sit this far under one-shots, dB. */
const RAPID_UNDER_DB = 7
/** Sounds quieter than this are left alone by the leveler, LUFS. */
const LEVELER_FLOOR = -60

/** A span of time, ms. */
export interface Range {
  startMs: number
  endMs: number
}

/** The measured loudness of one media layer's trimmed source, at volume 1. */
export interface SegmentLevel {
  /** Gated integrated loudness, LUFS (−Infinity when silent). */
  integrated: number
  /** The loudest 400 ms momentary loudness, LUFS. */
  maxMomentary: number
  /** Where it sounds (100 ms blocks above −45 LUFS, gaps up to 350 ms merged), ms of source time from the layer's source start. */
  active: Range[]
}

/** What the plan is made from. */
export interface MixInputs {
  comp: Pick<Comp, 'durationMs' | 'soundMix'>
  categories: readonly SoundCategory[]
  /** The media layers heard (audibleLayers), placed in the comp's time. */
  segments: readonly MediaLayer[]
  /** The sounds stack's hits (compSoundHits). */
  hits: readonly SoundHit[]
  /** Layers by id, for the bus of a hit's layer. */
  layerBus: (layerId: string) => string | undefined
  /** A segment's measured level; null while unmeasured (it counts as sounding throughout, and is not levelled). */
  segmentLevel: (layer: MediaLayer) => SegmentLevel | null
  /** The loudest momentary loudness of a hit's sound at volume 1, LUFS; null while unmeasured. */
  hitLevel: (hit: SoundHit) => number | null
}

/** One bus of the plan. */
export interface PlanBus {
  id: string
  /** Fader with mute and solo applied (linear). */
  gain: number
  /** Whether the speech compressor runs on it. */
  compress: boolean
  /** Duck gain on DUCK_STEP_MS steps from comp time 0; null when it never ducks. */
  duck: Float32Array | null
}

export interface MixPlan {
  buses: PlanBus[]
  /** Gain of sound that goes to no bus (untagged media, unknown ids); 0 when any bus is soloed. */
  unroutedGain: number
  /** Each segment's bus (null: straight to master), by layer id. */
  segmentBus: Map<string, string | null>
  /** Each segment's leveler trim (linear), by layer id. */
  segmentTrim: Map<string, number>
  /** Each segment's own duck gain table (from its layer's duck rules), by layer id. */
  segmentDuck: Map<string, Float32Array>
  /** Per hit (same order as the inputs): its bus and its gain multiplier (cue trim). */
  hitBus: (string | null)[]
  hitTrim: number[]
  masterVolume: number
  /**
   * The loudness match's master trim (linear), applied after the master fader
   * and before the limiter. planMix makes it 1: the trim needs the measured
   * mix (masterTrimDb), which whoever plays or exports the plan sets.
   */
  masterTrim: number
  loudness: SoundMix['loudness']
  limiter: SoundMix['limiter']
}

/**
 * The loudness match never lets the limiter take more than this off the mix's
 * loudest peak, dB. The loudest peaks are mostly one-shot effects (a pop, a
 * click, an impact): at 6 dB the Q9 launch film's hits lost their snap, so the
 * match now stops short instead (Q10).
 */
export const LOUDNESS_MAX_LIMIT_DB = 3
/** The loudness match's trim stays within this, dB. */
const MASTER_TRIM_RANGE_DB = 24

/** dB to a linear gain. */
const gainOf = (db: number) => 10 ** (db / 20)

/** The leveler's trim, dB: toward `target`, by the rules of the frame's leveler. */
export function levelerTrimDb(measured: number, target: number, leveler: SoundMix['leveler']): number {
  if (!leveler.enabled || !Number.isFinite(measured) || measured < LEVELER_FLOOR) return 0
  let db = target - measured
  if (!leveler.tameLoud) db = Math.max(0, db)
  if (!leveler.liftQuiet) db = Math.min(0, db)
  return Math.min(12, Math.max(-30, db)) * leveler.strength
}

/**
 * The loudness match's master trim, dB: the mix (measured before the limiter,
 * at the master fader's level: `measuredLufs` integrated, `peakDb` its
 * loudest sample) moved to the target, but no further than the limiter can
 * hold: it takes at most LOUDNESS_MAX_LIMIT_DB off the loudest peak, and with
 * no limiter nothing may pass full scale. 0 when off, silent or not finite.
 */
export function masterTrimDb(measuredLufs: number, peakDb: number, loudness: SoundMix['loudness'], limiter: SoundMix['limiter']): number {
  if (!loudness.enabled || !Number.isFinite(measuredLufs) || !Number.isFinite(peakDb)) return 0
  const reach = limiter.enabled ? limiter.ceilingDb - peakDb + LOUDNESS_MAX_LIMIT_DB : -peakDb
  return Math.min(MASTER_TRIM_RANGE_DB, Math.max(-MASTER_TRIM_RANGE_DB, Math.min(loudness.targetLufs - measuredLufs, reach)))
}

/** The id path of a placed layer: the layer itself and the nested layers it is inside (see nestedKey). */
function nestPath(id: string): string[] {
  return id.split('/').map((part) => part.replace(/#\d+$/, ''))
}

/**
 * A duck envelope on DUCK_STEP_MS steps: while any range sounds the gain dips
 * by `depthDb`, starting `attackMs` early (the look-ahead, so the first word
 * is already ducked), ramping linearly down over `attackMs` and back up over
 * `releaseMs` after the range ends.
 */
export function duckEnvelope(ranges: readonly Range[], rule: Pick<DuckRule, 'depthDb' | 'attackMs' | 'releaseMs'>, durationMs: number): Float32Array {
  const steps = Math.max(1, Math.ceil(durationMs / DUCK_STEP_MS) + 1)
  const sorted = [...ranges].sort((a, b) => a.startMs - b.startMs)
  const out = new Float32Array(steps)
  const up = rule.attackMs > 0 ? DUCK_STEP_MS / rule.attackMs : 1
  const down = rule.releaseMs > 0 ? DUCK_STEP_MS / rule.releaseMs : 1
  let u = 0
  let next = 0
  const live: Range[] = []
  for (let k = 0; k < steps; k++) {
    const t = k * DUCK_STEP_MS
    while (next < sorted.length && (sorted[next] as Range).startMs - rule.attackMs <= t) live.push(sorted[next++] as Range)
    for (let i = live.length - 1; i >= 0; i--) if ((live[i] as Range).endMs <= t) live.splice(i, 1)
    u = live.length > 0 ? Math.min(1, u + up) : Math.max(0, u - down)
    out[k] = gainOf(-rule.depthDb * u)
  }
  return out
}

/** A table's value at comp time `ms`, linearly between steps. */
export function tableAt(table: Float32Array, ms: number): number {
  const x = Math.max(0, ms / DUCK_STEP_MS)
  const i = Math.floor(x)
  if (i >= table.length - 1) return table[table.length - 1] ?? 1
  const a = table[i] ?? 1
  return a + ((table[i + 1] ?? 1) - a) * (x - i)
}

/** Multiplies tables into the first. */
function multiplyInto(target: Float32Array, other: Float32Array): void {
  for (let i = 0; i < target.length; i++) target[i] = (target[i] ?? 1) * (other[i] ?? 1)
}

/** Computes the mix plan of a comp (see MixPlan). Pure: the same inputs give the same plan. */
export function planMix(inputs: MixInputs): MixPlan {
  const { comp, categories, segments, hits } = inputs
  const { leveler } = comp.soundMix
  const known = new Map(categories.map((c) => [c.id, c]))
  const routeOf = (tag: string | undefined, fallback: string | null): string | null => (tag === undefined ? fallback : known.has(tag) ? tag : null)
  const anySolo = categories.some((c) => c.solo)

  // Routing: a segment's own tag (or the innermost nested layer's); untagged media goes to master, untagged cues to sfx.
  const segmentBus = new Map<string, string | null>()
  for (const layer of segments) segmentBus.set(layer.id, routeOf(layer.soundBus, null))
  const hitBus = hits.map((hit) => routeOf(hit.soundBus ?? inputs.layerBus(hit.layerId), 'sfx'))

  const targetOf = (bus: string | null): number => {
    const category = bus === null ? undefined : known.get(bus)
    return leveler.mode === 'all' || !category ? ALL_TARGET_LUFS : categoryTarget(category)
  }

  // Leveler: one trim per run of segments that carry on from each other (a split clip keeps one level).
  const levels = new Map(segments.map((layer) => [layer.id, inputs.segmentLevel(layer)]))
  const segmentTrim = new Map<string, number>()
  const done = new Set<string>()
  for (const layer of segments) {
    if (done.has(layer.id)) continue
    const run = [layer]
    for (let last = layer; ; ) {
      const next = segments.find((s) => !done.has(s.id) && s !== last && !run.includes(s) && continues(last, s))
      if (!next) break
      run.push(next)
      last = next
    }
    for (const s of run) done.add(s.id)
    const bus = segmentBus.get(layer.id) ?? null
    const peak = bus !== null && known.get(bus)?.character === 'sfx'
    // The run's loudness: the measured levels weighted by length, plus the clip's own gain.
    let energy = 0
    let length = 0
    let measured = true
    for (const s of run) {
      const level = levels.get(s.id)
      if (!level) {
        measured = false
        break
      }
      const value = (peak ? level.maxMomentary : level.integrated) + 20 * Math.log10(Math.max(1e-6, s.volume))
      if (Number.isFinite(value)) energy += s.durationMs * 10 ** (value / 10)
      length += s.durationMs
    }
    const loudness = measured && energy > 0 ? 10 * Math.log10(energy / length) : Number.NEGATIVE_INFINITY
    const trim = gainOf(levelerTrimDb(loudness, targetOf(bus), leveler))
    for (const s of run) segmentTrim.set(s.id, trim)
  }

  // Rapid-fire cues: hits of one layer and one sound are levelled together; two or more in 400 ms sit as texture.
  const hitTrim = hits.map(() => 1)
  const groups = new Map<string, number[]>()
  hits.forEach((hit, i) => {
    const key = `${hit.layerId}|${hit.voice.custom?.assetId ?? hit.voice.pack ?? ''}`
    groups.set(key, [...(groups.get(key) ?? []), i])
  })
  for (const members of groups.values()) {
    const times = members.map((i) => (hits[i] as SoundHit).timeMs).sort((a, b) => a - b)
    let n = 0
    for (let a = 0, b = 0; b < times.length; b++) {
      while ((times[b] as number) - (times[a] as number) >= RAPID_WINDOW_MS) a++
      n = Math.max(n, b - a + 1)
    }
    const first = hits[members[0] as number] as SoundHit
    const level = inputs.hitLevel(first)
    if (level === null) continue
    const rms = Math.sqrt(members.reduce((sum, i) => sum + (hits[i] as SoundHit).volume ** 2, 0) / members.length)
    const measured = level + 20 * Math.log10(Math.max(1e-6, rms)) + 10 * Math.log10(Math.max(1, n))
    const bus = hitBus[members[0] as number] ?? null
    const trim = gainOf(levelerTrimDb(measured, targetOf(bus) - (n >= 2 ? RAPID_UNDER_DB : 0), leveler))
    for (const i of members) hitTrim[i] = trim
  }

  // Activity, for ducking: where each segment and cue sounds, in comp time.
  const segmentActive = (layer: MediaLayer): Range[] => {
    const end = layer.startMs + layer.durationMs
    const level = levels.get(layer.id)
    if (!level) return [{ startMs: layer.startMs, endMs: end }]
    const rate = Math.abs(layer.playbackRate) || 1
    return level.active
      .map((r) => ({ startMs: layer.startMs + r.startMs / rate, endMs: Math.min(end, layer.startMs + r.endMs / rate) }))
      .filter((r) => r.endMs > r.startMs)
  }
  const cueRange = (hit: SoundHit): Range => ({ startMs: hit.timeMs, endMs: hit.timeMs + CUE_ACTIVE_MS })
  /** Where a rule's source sounds; `skipBus` never ducks itself. */
  const sourceRanges = (rule: DuckRule, skipBus: string | null, skipLayer: string | null): Range[] => {
    const ranges: Range[] = []
    const { kind, id } = rule.under
    segments.forEach((layer) => {
      if (layer.id === skipLayer) return
      const bus = segmentBus.get(layer.id) ?? null
      if (skipBus !== null && bus === skipBus) return
      if (kind === 'bus' ? bus === id : nestPath(layer.id).includes(id)) ranges.push(...segmentActive(layer))
    })
    hits.forEach((hit, i) => {
      const bus = hitBus[i] ?? null
      if (skipBus !== null && bus === skipBus) return
      if (kind === 'bus' ? bus === id : hit.layerId === id) ranges.push(cueRange(hit))
    })
    return ranges
  }
  const tableFor = (rules: readonly DuckRule[], skipBus: string | null, skipLayer: string | null): Float32Array | null => {
    let table: Float32Array | null = null
    for (const rule of rules) {
      if (!rule.enabled || rule.depthDb <= 0) continue
      const envelope = duckEnvelope(sourceRanges(rule, skipBus, skipLayer), rule, comp.durationMs)
      if (table) multiplyInto(table, envelope)
      else table = envelope
    }
    return table
  }

  const buses: PlanBus[] = categories.map((c) => ({
    id: c.id,
    gain: c.muted || (anySolo && !c.solo) ? 0 : c.volume,
    compress: c.character === 'voice' && leveler.enabled && leveler.evenSpeech,
    duck: tableFor(c.ducking, c.id, null),
  }))
  const segmentDuck = new Map<string, Float32Array>()
  for (const layer of segments) {
    if (!layer.ducking?.length) continue
    const table = tableFor(layer.ducking, null, layer.id)
    if (table) segmentDuck.set(layer.id, table)
  }

  return {
    buses,
    unroutedGain: anySolo ? 0 : 1,
    segmentBus,
    segmentTrim,
    segmentDuck,
    hitBus,
    hitTrim,
    masterVolume: comp.soundMix.volume,
    masterTrim: 1,
    loudness: comp.soundMix.loudness,
    limiter: comp.soundMix.limiter,
  }
}

/** A segment's mix gain at comp time `ms`: its leveler trim and its own ducking. */
export function segmentGain(plan: MixPlan, layerId: string, ms: number): number {
  const duck = plan.segmentDuck.get(layerId)
  return (plan.segmentTrim.get(layerId) ?? 1) * (duck ? tableAt(duck, ms) : 1)
}
