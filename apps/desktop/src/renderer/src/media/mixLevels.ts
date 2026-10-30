import type { Comp, Project, SoundHit } from '@uve/core'
import { activeRanges, LoudnessMeter, masterTrimDb, measure, type MediaLayer, MIX_SAMPLE_RATE, type MixPlan, mixSampleAt, packReady, planMix, renderPlan, type SegmentLevel, synthHit } from '@uve/engine'
import { type MixLevels, measureMix } from '../export/mixWindows'
import { ExportSources } from '../export/sources'
import { KEYS_TAKES, loadPackTakes } from '../library/sounds'

// The loudness of what a comp plays, measured once per source range and kept
// for the session, and the mix plan made from it. The export waits for every
// measurement; the preview plans with what is measured so far and plans again
// when the rest arrives. The loudness match's trim comes from measuring the
// whole mix (the export does that itself, in render.ts); the preview does it
// in the background and keeps the last trim it knew meanwhile.

/** Reads a file's sound in pieces (ExportSources does, with mediabunny). */
export interface SoundReader {
  eachSoundPiece(assetId: string, startSec: number, endSec: number, visit: (left: Float32Array, right: Float32Array, sampleRate: number) => void): Promise<boolean>
}

/** The preview measures its mix this long after the last change to it, ms. */
const MASTER_DEBOUNCE_MS = 600
/** Measured mixes kept (the preview's). */
const MASTER_CACHE_SIZE = 24

/** Custom hit sounds are measured over their first 30 s at most. */
const HIT_MEASURE_SEC = 30

const segmentLevels = new Map<string, Promise<SegmentLevel | null>>()
const segmentKnown = new Map<string, SegmentLevel | null>()
const hitLevels = new Map<string, Promise<number | null>>()
const hitKnown = new Map<string, number | null>()

/** The measured mixes by fingerprint (null: it could not be read), and the last measured mix of each comp. */
const masterLevels = new Map<string, MixLevels | null>()
const lastMaster = new Map<string, MixLevels | null>()
/** The measurement under way (or waiting out its delay); a newer mix cancels it. */
let masterJob: { key: string; abort: AbortController; timer: ReturnType<typeof setTimeout> | undefined } | null = null

/** A segment is measured over the source range it plays. */
const segmentKey = (layer: MediaLayer) => `${layer.mediaId}|${Math.round(layer.sourceStartMs)}|${Math.round(layer.durationMs * Math.abs(layer.playbackRate))}`
const hitKey = (hit: SoundHit) => hit.voice.pack ?? hit.voice.custom?.assetId ?? ''

function measureSegment(reader: SoundReader, layer: MediaLayer): Promise<SegmentLevel | null> {
  const key = segmentKey(layer)
  let level = segmentLevels.get(key)
  if (!level) {
    const startSec = layer.sourceStartMs / 1000
    const endSec = startSec + (layer.durationMs * Math.abs(layer.playbackRate)) / 1000
    let meter: LoudnessMeter | null = null
    level = reader
      .eachSoundPiece(layer.mediaId, startSec, endSec, (left, right, rate) => {
        meter ??= new LoudnessMeter(rate)
        meter.push([left, right])
      })
      .then((read) => {
        const done = meter as LoudnessMeter | null
        if (!read || !done) return null
        return { integrated: done.integrated(), maxMomentary: done.maxMomentary(), active: activeRanges(done.blocks()) }
      })
      .catch(() => null)
      .then((result) => {
        segmentKnown.set(key, result)
        return result
      })
    segmentLevels.set(key, level)
  }
  return level
}

function measureHit(reader: SoundReader, hit: SoundHit): Promise<number | null> {
  const key = hitKey(hit)
  let level = hitLevels.get(key)
  if (!level) {
    const { pack, custom } = hit.voice
    if (pack) {
      // A pack plays the same sound on both sides; it is measured as heard (a recorded pack by its median take).
      level = loadPackTakes().then(() => {
        if (!packReady(pack)) return null
        const takes = Array.from({ length: pack === 'keys' ? KEYS_TAKES : 1 }, (_, take) => {
          const mono = synthHit(pack, 1, take, MIX_SAMPLE_RATE)
          return measure([mono, mono], MIX_SAMPLE_RATE).maxMomentary
        }).sort((a, b) => a - b)
        return takes[Math.floor(takes.length / 2)] ?? null
      })
    } else if (custom) {
      let meter: LoudnessMeter | null = null
      level = reader
        .eachSoundPiece(custom.assetId, 0, HIT_MEASURE_SEC, (left, right, rate) => {
          meter ??= new LoudnessMeter(rate)
          meter.push([left, right])
        })
        .then((read) => {
          const done = meter as LoudnessMeter | null
          return read && done ? done.maxMomentary() : null
        })
        .catch(() => null)
    } else {
      level = Promise.resolve(null)
    }
    level = level.then((result) => {
      hitKnown.set(key, result)
      return result
    })
    hitLevels.set(key, level)
  }
  return level
}

/** The bus a layer of the comp names (for its fired sounds). */
function layerBusOf(comp: Comp): (layerId: string) => string | undefined {
  const buses = new Map<string, string | undefined>()
  for (const track of comp.tracks) for (const layer of track.layers) buses.set(layer.id, layer.soundBus)
  return (id) => buses.get(id)
}

function plan(project: Pick<Project, 'soundCategories'>, comp: Comp, segments: readonly MediaLayer[], hits: readonly SoundHit[]): MixPlan {
  return planMix({
    comp,
    categories: project.soundCategories,
    segments,
    hits,
    layerBus: layerBusOf(comp),
    segmentLevel: (layer) => segmentKnown.get(segmentKey(layer)) ?? null,
    hitLevel: (hit) => hitKnown.get(hitKey(hit)) ?? null,
  })
}

/** The mix plan of a comp, once every sound in it is measured (for the export). */
export async function measuredMixPlan(project: Pick<Project, 'soundCategories'>, comp: Comp, segments: readonly MediaLayer[], hits: readonly SoundHit[], reader: SoundReader): Promise<MixPlan> {
  // One at a time: each measurement decodes a whole range.
  for (const layer of segments) await measureSegment(reader, layer)
  for (const hit of hits) await measureHit(reader, hit)
  return plan(project, comp, segments, hits)
}

/**
 * What makes the mix of a comp sound the way it does before the limiter: the
 * sounding layers, the fired sounds, the buses, the transitions and the master
 * fader and leveler. The loudness match's own settings and the limiter are
 * left out: they only read the measurement.
 */
function mixFingerprint(project: Pick<Project, 'soundCategories'>, comp: Comp, segments: readonly MediaLayer[], hits: readonly SoundHit[], first: number, total: number): string {
  const { volume, leveler } = comp.soundMix
  return JSON.stringify([comp.id, comp.durationMs, first, total, volume, leveler, comp.tracks.map((t) => t.transitions), project.soundCategories, segments, hits])
}

/** The span of mix samples an export of the comp would measure: the working range on the export's frame clock, else the whole comp. */
function exportSamples(comp: Comp, span: { startMs: number; endMs: number } | undefined): { first: number; total: number } {
  if (!span) return { first: 0, total: mixSampleAt(comp.durationMs) }
  const plan = renderPlan(comp, span)
  return { first: mixSampleAt(plan.startMs), total: Math.round((plan.durationMs * MIX_SAMPLE_RATE) / 1000) }
}

/** Measures the whole mix in the background, after a short wait, and calls `onMeasured` when the result is in. */
function scheduleMasterMeasure(
  key: string,
  project: Pick<Project, 'soundCategories' | 'media' | 'comps'>,
  comp: Comp,
  segments: readonly MediaLayer[],
  hits: readonly SoundHit[],
  mix: MixPlan,
  first: number,
  total: number,
  onMeasured: () => void,
): void {
  if (masterJob) {
    masterJob.abort.abort()
    clearTimeout(masterJob.timer)
  }
  const job = { key, abort: new AbortController(), timer: undefined as ReturnType<typeof setTimeout> | undefined }
  masterJob = job
  job.timer = setTimeout(() => {
    const sources = new ExportSources(project)
    measureMix({ comp, sounding: segments, hits, mix, sources }, first, total, job.abort.signal)
      .then(
        (levels) => levels,
        () => (job.abort.signal.aborted ? undefined : null),
      )
      .then(async (levels) => {
        await sources.dispose()
        if (masterJob === job) masterJob = null
        if (levels === undefined) return
        masterLevels.set(key, levels)
        lastMaster.set(comp.id, levels)
        for (const old of masterLevels.keys()) {
          if (masterLevels.size <= MASTER_CACHE_SIZE) break
          masterLevels.delete(old)
        }
        onMeasured()
      })
  }, MASTER_DEBOUNCE_MS)
}

/** The loudness match's trim for the preview, dB: from the measured mix when it is in, else from the last one measured for this comp. */
function previewMasterTrimDb(
  project: Pick<Project, 'soundCategories' | 'media' | 'comps'>,
  comp: Comp,
  segments: readonly MediaLayer[],
  hits: readonly SoundHit[],
  mix: MixPlan,
  complete: boolean,
  span: { startMs: number; endMs: number } | undefined,
  onMeasured: () => void,
): number {
  if (!mix.loudness.enabled || segments.length + hits.length === 0) return 0
  const trimOf = (levels: MixLevels | null | undefined) => (levels ? masterTrimDb(levels.integrated, levels.peakDb, mix.loudness, mix.limiter) : 0)
  if (!complete) return trimOf(lastMaster.get(comp.id))
  // The same span the export measures, so the preview's trim is the export's.
  const { first, total } = exportSamples(comp, span)
  const key = mixFingerprint(project, comp, segments, hits, first, total)
  if (masterLevels.has(key)) {
    const levels = masterLevels.get(key)
    lastMaster.set(comp.id, levels ?? null)
    return trimOf(levels)
  }
  if (masterJob?.key !== key) scheduleMasterMeasure(key, project, comp, segments, hits, mix, first, total, onMeasured)
  return trimOf(lastMaster.get(comp.id))
}

/**
 * The mix plan with what is measured so far (for the preview), and whether
 * everything is. Measurements still missing start in the background;
 * `onMeasured` runs when one finishes, so the caller can plan again. `span`
 * is the working range the export would render (none: the whole comp); the
 * loudness match measures that span, as the export does.
 */
export function currentMixPlan(
  project: Pick<Project, 'soundCategories' | 'media' | 'comps'>,
  comp: Comp,
  segments: readonly MediaLayer[],
  hits: readonly SoundHit[],
  reader: SoundReader,
  span: { startMs: number; endMs: number } | undefined,
  onMeasured: () => void,
): { plan: MixPlan; complete: boolean } {
  let complete = true
  for (const layer of segments) {
    if (segmentKnown.has(segmentKey(layer))) continue
    complete = false
    if (!segmentLevels.has(segmentKey(layer))) void measureSegment(reader, layer).then(onMeasured)
  }
  for (const hit of hits) {
    if (hitKnown.has(hitKey(hit))) continue
    complete = false
    if (!hitLevels.has(hitKey(hit))) void measureHit(reader, hit).then(onMeasured)
  }
  const mix = plan(project, comp, segments, hits)
  mix.masterTrim = 10 ** (previewMasterTrimDb(project, comp, segments, hits, mix, complete, span, onMeasured) / 20)
  return { plan: mix, complete }
}
