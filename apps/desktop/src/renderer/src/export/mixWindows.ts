import type { Comp, SoundHit } from '@uve/core'
import {
  type EdgeFades,
  edgeFades,
  layerSamples,
  MasterMeter,
  type MasterLevels,
  type MediaLayer,
  MIX_SAMPLE_RATE,
  mixHits,
  type MixPlan,
  MixStream,
  mixLayer,
  type Pcm,
  segmentGain,
  sourceSpanSec,
  type Stereo,
  transitionEnvelope,
} from '@uve/engine'
import type { ExportSources } from './sources'

// The sound of a comp mixed a window at a time: each sounding layer and fired
// sound added to its bus's buffer. The export's encoding pass, the export's
// loudness measurement and the preview's loudness measurement all mix through
// this one code, so they hear the same sound.

/** The sound is mixed a second at a time. */
export const AUDIO_WINDOW = MIX_SAMPLE_RATE

/** What a mixer mixes: a comp's sounding layers and fired sounds, read from `sources`, routed and levelled by `mix`. */
export interface MixerSetup {
  comp: Comp
  sounding: readonly MediaLayer[]
  hits: readonly SoundHit[]
  /** null: every sound goes straight to master, unlevelled. */
  mix: MixPlan | null
  sources: ExportSources
}

/** Mixes the buses' sound for one window at a time. Windows must be asked for in order, without going back. */
export type WindowMixer = (first: number, count: number) => Promise<Map<string, Stereo>>

/** A mixer for `setup`; the sources of layers that end in a window are closed after it. */
export function windowMixer({ comp, sounding, hits, mix, sources }: MixerSetup): WindowMixer {
  const fades = new Map<string, EdgeFades>(
    sounding.map((layer) => {
      const transition = transitionEnvelope(comp, layer)
      const envelope = (ms: number) => (transition?.(ms) ?? 1) * (mix ? segmentGain(mix, layer.id, ms) : 1)
      return [layer.id, { ...edgeFades(layer, sounding), envelope }]
    }),
  )
  const customSounds = new Map<string, Pcm | null>()
  return async (mixed, count) => {
    const buses = new Map<string, Stereo>()
    /** The buffer of a bus (or of unrouted sound, ''). */
    const busOut = (bus: string | null) => {
      let out = buses.get(bus ?? '')
      if (!out) {
        out = { left: new Float32Array(count), right: new Float32Array(count) }
        buses.set(bus ?? '', out)
      }
      return out
    }
    for (const layer of sounding) {
      const { first, end } = layerSamples(layer)
      const from = Math.max(first, mixed)
      const to = Math.min(end, mixed + count)
      if (from < to) {
        const span = sourceSpanSec(layer, from, to)
        const pcm = await sources.sound(layer, span.startSec, span.endSec)
        const layerFades = fades.get(layer.id)
        if (pcm && layerFades) mixLayer(busOut(mix?.segmentBus.get(layer.id) ?? null), mixed, layer, pcm, layerFades)
      }
      if (end <= mixed + count) await sources.closeSound(layer.id)
    }
    const windowEnd = ((mixed + count) / MIX_SAMPLE_RATE) * 1000
    // The sounds stack: hits that start before this window ends (and may still ring into it).
    const windowStart = (mixed / MIX_SAMPLE_RATE) * 1000
    const due = new Map<string, SoundHit[]>()
    hits.forEach((hit, i) => {
      if (hit.timeMs >= windowEnd || hit.timeMs <= windowStart - 30000) return
      // Each hit goes to its bus at its levelled volume.
      const bus = mix?.hitBus[i] ?? null
      due.set(bus ?? '', [...(due.get(bus ?? '') ?? []), { ...hit, volume: hit.volume * (mix?.hitTrim[i] ?? 1) }])
    })
    for (const hit of [...due.values()].flat()) if (hit.voice.custom && !customSounds.has(hit.voice.custom.assetId)) customSounds.set(hit.voice.custom.assetId, await sources.wholeSound(hit.voice.custom.assetId))
    for (const [bus, list] of due) mixHits(busOut(bus || null), mixed, list, (assetId) => customSounds.get(assetId) ?? null)
    return buses
  }
}

/** What the loudness match reads off a mix. */
export interface MixLevels {
  /** Integrated loudness before the limiter, at the master fader's level, LUFS (-Infinity when silent). */
  integrated: number
  /** The loudest sample at that point, dBFS (-Infinity when silent). */
  peakDb: number
}

/**
 * Mixes mix samples [first, first + total) once, through the buses and the
 * master fader but not the loudness trim or the limiter, and measures the
 * result (BS.1770 integrated loudness and the loudest sample). Every layer's
 * sound is closed afterwards, so the same `sources` can be mixed again from
 * the start. Rejects when `signal` aborts.
 */
export async function measureMix(setup: MixerSetup & { mix: MixPlan }, first: number, total: number, signal?: AbortSignal): Promise<MixLevels> {
  const { mix, sounding, sources } = setup
  const mixer = windowMixer(setup)
  const stream = new MixStream(mix, MIX_SAMPLE_RATE, { measuring: true })
  const meter = new MasterMeter(MIX_SAMPLE_RATE)
  const end = first + total
  try {
    for (let at = first; at < end; at += AUDIO_WINDOW) {
      signal?.throwIfAborted()
      const count = Math.min(AUDIO_WINDOW, end - at)
      const buses = await mixer(at, count)
      meter.push(stream.process(at, count, buses))
    }
  } finally {
    for (const layer of sounding) await sources.closeSound(layer.id)
  }
  const levels: MasterLevels = meter.levels()
  return { integrated: levels.integrated, peakDb: levels.samplePeakDb }
}
