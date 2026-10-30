import { type Comp, compSoundHitsDeep, type Layer, type MediaAsset, type Project, type SoundHit } from '@uve/core'
import {
  audibleLayers,
  FRAME_LOOKUP_EPSILON_MS,
  type FrameProvider,
  isActiveAt,
  type MixPlan,
  planSync,
  resolveLayer,
  playedMedia,
  segmentGain,
  sourceTimeMs,
  packPitch,
  packReady,
  SPEECH_COMPRESSOR,
  synthHit,
  tableAt,
} from '@uve/engine'
import { mediaUrl } from '../../../shared/media'
import { KEYS_TAKES, loadPackTakes } from '../library/sounds'
import { ExportSources } from '../export/sources'
import { currentMixPlan } from './mixLevels'
import mixWorkletUrl from './mixWorklet.ts?worker&url'

/** How far ahead (comp time) an upcoming clip is cued to its first frame while playing. */
const CUE_AHEAD_MS = 2000
/** How far ahead of the playhead the sounds stack's hits are scheduled, ms. */
const HIT_LOOKAHEAD_MS = 250
/** Browsers play media between these rates. */
const MIN_RATE = 0.0625
const MAX_RATE = 16
/** How quickly faders and duck gains follow the plan, seconds (a time constant: about 60 ms to settle). */
const GAIN_GLIDE_SEC = 0.02

type MediaLayer = Extract<Layer, { kind: 'video' | 'audio' }>
/** What the preview plays from: the comps, the media and the sound categories. */
type PreviewDoc = Pick<Project, 'media' | 'comps' | 'soundCategories'>
/** The working range an export would render, in comp ms; the loudness match measures it. */
type MixSpan = { startMs: number; endMs: number }

/** A bus of the preview's mix graph: input → (speech compressor) → duck → fader → master. */
interface BusNodes {
  input: GainNode
  compressor: AudioWorkletNode | null
  compressing: boolean
  duck: GainNode
  fader: GainNode
}

/** The preview's mix graph: one bus per category, the unrouted input, the master fader, the limiter and the meter. */
interface MixGraph {
  context: AudioContext
  buses: Map<string, BusNodes>
  unrouted: GainNode
  master: GainNode
  limiter: AudioWorkletNode | null
  limiting: boolean
  ceilingDb: number
  meter: AnalyserNode
}

/** One media element following one layer. */
interface Player {
  url: string
  el: HTMLVideoElement | HTMLAudioElement
  /** The element's sound goes through this gain, so volumes above 100 % play as they export. */
  gain: GainNode
  /** The bus its gain feeds (null: unrouted); undefined until connected. */
  bus: string | null | undefined
  /** A copy of the last frame shown before a seek, drawn while the seek runs so the picture does not flash. */
  still: ImageBitmap | null
  /** The newest target that arrived while a seek was running; seeks are coalesced, so only it is kept. */
  pendingSec: number | null
  seekStartedAt: number | null
  seekDoneAt: number
  seekLatencySec: number
  playRequestedAt: number | null
  startLatencySec: number
  rateChangedAt: number
}

/** A running average that adapts to how long an element's seeks and starts really take. */
const settle = (average: number, sample: number) => 0.7 * average + 0.3 * Math.min(0.5, sample)

/**
 * Plays the preview's media: one hidden element per video or audio layer,
 * kept in step with the playhead (see `planSync`), plus decoded images.
 * Implements the compositor's FrameProvider, and reports when new frames
 * arrive so the viewport can redraw.
 */
export class PreviewMedia implements FrameProvider {
  private readonly players = new Map<string, Player>()
  private readonly images = new Map<string, HTMLImageElement>()
  private readonly listeners = new Set<() => void>()
  private host: HTMLDivElement | null = null
  private audio: AudioContext | null = null
  private graph: MixGraph | null = null
  /** Whether the dynamics worklet loaded (null while loading); without it the compressor and limiter are left out. */
  private worklet: boolean | null = null
  /** Hits already scheduled in this run of playback, and the comp time last seen (a jump back starts over). */
  private scheduled = new Set<string>()
  private lastTimeMs = -1
  private hitCache: { tracks: Comp['tracks']; comps: PreviewDoc['comps']; hits: SoundHit[] } | null = null
  private readonly hitBuffers = new Map<string, AudioBuffer>()
  private readonly customBuffers = new Map<string, AudioBuffer | 'loading' | 'failed'>()
  /** The mix plan for the comp being played, and what it was made from (remade when any of it changes or a measurement lands). */
  private planCache: { comp: Comp; doc: PreviewDoc; plan: MixPlan; complete: boolean; span: MixSpan | undefined } | null = null
  /** Reads files for loudness measurement (mediabunny), per media list. */
  private reader: { media: PreviewDoc['media']; sources: ExportSources } | null = null

  /** Calls `listener` when a new frame or image becomes available. Returns an unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Brings every media layer of `comp` (those inside its nested comps too) in step with the playhead at `timeMs`. Call before each render. */
  sync(comp: Comp, doc: PreviewDoc, timeMs: number, playing: boolean, span?: MixSpan): void {
    const { media } = doc
    const plan = this.mixPlan(comp, doc, span)
    this.applyPlan(plan, timeMs)
    const live = new Set<string>()
    for (const { layer, trackMuted } of playedMedia(comp, doc.comps)) {
      if (layer.kind !== 'video' && layer.kind !== 'audio') continue
      const asset = media.find((m) => m.id === layer.mediaId)
      if (!asset) continue
      live.add(layer.id)
      this.follow(layer, asset, timeMs, playing, trackMuted, plan)
    }
    for (const id of this.players.keys()) if (!live.has(id)) this.release(id)
    this.scheduleHits(comp, doc, timeMs, playing, plan)
    const paths = new Set(media.map((m) => m.path))
    for (const path of this.images.keys()) if (!paths.has(path)) this.images.delete(path)
  }

  frame(media: MediaAsset, _sourceTimeMs: number, layerId: string): CanvasImageSource | null {
    if (media.kind === 'image') return this.image(media)
    const player = this.players.get(layerId)
    if (!player || !(player.el instanceof HTMLVideoElement)) return null
    const { el, still } = player
    const decoded = el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && el.videoWidth > 0
    if (decoded && !el.seeking) return el
    return still ?? (decoded ? el : null)
  }

  /** Stops and releases everything, for example when the viewport closes. */
  dispose(): void {
    for (const id of [...this.players.keys()]) this.release(id)
    this.images.clear()
    this.host?.remove()
    this.host = null
    void this.audio?.close()
    this.audio = null
    this.graph = null
    this.worklet = null
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  private follow(layer: MediaLayer, media: MediaAsset, timeMs: number, playing: boolean, trackMuted: boolean, plan: MixPlan): void {
    const player = this.playerFor(layer, media)
    const { el } = player
    const rate = Math.min(MAX_RATE, Math.max(MIN_RATE, layer.playbackRate))
    // A changed speed changes pitch, as on tape, the same as in exports. At normal speed pitch is
    // kept, so the small speed nudges that keep the element in step are not heard.
    el.preservesPitch = layer.playbackRate === 1

    if (!isActiveAt(layer, timeMs)) {
      el.muted = true
      // Cue an upcoming clip on its first frame, then start it just early enough to be running at the cut.
      const startsIn = layer.startMs - timeMs
      if (playing && layer.enabled && startsIn > 0 && startsIn < CUE_AHEAD_MS) {
        if (startsIn > player.startLatencySec * 1000) {
          if (!el.paused) el.pause()
          this.seek(player, (layer.sourceStartMs + FRAME_LOOKUP_EPSILON_MS) / 1000)
        } else if (el.paused && !el.seeking) {
          el.playbackRate = rate
          player.playRequestedAt = performance.now()
          void el.play().catch(() => undefined)
        }
        return
      }
      if (!el.paused) el.pause()
      return
    }

    const volume = resolveLayer(layer, timeMs).volume ?? layer.volume
    el.muted = !playing || layer.muted || trackMuted || media.hasAudio === false || volume <= 0
    // The plan's leveler trim and the layer's own ducking, as in the export.
    player.gain.gain.value = volume * segmentGain(plan, layer.id, timeMs)
    this.route(player, plan.segmentBus.get(layer.id) ?? null)
    if (playing && this.audio?.state === 'suspended') void this.audio.resume()

    if (el.readyState < HTMLMediaElement.HAVE_METADATA) return
    const now = performance.now()
    const step = planSync(
      { currentSec: el.currentTime, paused: el.paused, seeking: el.seeking, rate: el.playbackRate },
      {
        targetSec: (sourceTimeMs(layer, timeMs) + FRAME_LOOKUP_EPSILON_MS) / 1000,
        playing,
        rate,
        frameSec: 1 / (media.fps ?? 30),
        seekLatencySec: player.seekLatencySec,
        startLatencySec: player.startLatencySec,
        sinceRateChangeMs: now - player.rateChangedAt,
        sinceSeekMs: now - player.seekDoneAt,
      },
    )
    switch (step.action) {
      case 'none':
        return
      case 'seek':
        this.seek(player, step.toSec)
        return
      case 'pause':
        el.pause()
        if (step.seekToSec !== undefined) this.seek(player, step.seekToSec)
        return
      case 'play':
        if (step.seekToSec !== undefined) this.seek(player, step.seekToSec)
        el.playbackRate = step.rate
        player.rateChangedAt = now
        player.playRequestedAt = now
        void el.play().catch(() => undefined)
        return
      case 'rate':
        el.playbackRate = step.rate
        player.rateChangedAt = now
        return
    }
  }

  /** Seeks, or queues the target when a seek is already running (only the newest target is kept). */
  private seek(player: Player, toSec: number): void {
    const { el } = player
    const target = Math.max(0, Number.isFinite(el.duration) ? Math.min(toSec, el.duration) : toSec)
    if (el.seeking) {
      player.pendingSec = target
      return
    }
    if (Math.abs(el.currentTime - target) < 1e-4) return
    if (el instanceof HTMLVideoElement && el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && el.videoWidth > 0) {
      void createImageBitmap(el)
        .then((bitmap) => {
          player.still?.close()
          player.still = bitmap
        })
        .catch(() => undefined)
    }
    player.seekStartedAt = performance.now()
    el.currentTime = target
  }

  private playerFor(layer: MediaLayer, media: MediaAsset): Player {
    const url = mediaUrl(media.path)
    const existing = this.players.get(layer.id)
    if (existing?.url === url && existing.el.localName === layer.kind) return existing
    if (existing) this.release(layer.id)

    const el = document.createElement(layer.kind)
    el.preload = 'auto'
    el.crossOrigin = 'anonymous'
    el.muted = true
    if (el instanceof HTMLVideoElement) el.playsInline = true
    const audio = this.audioContext()
    const gain = audio.createGain()
    audio.createMediaElementSource(el).connect(gain)
    const player: Player = {
      url,
      el,
      gain,
      bus: undefined,
      still: null,
      pendingSec: null,
      seekStartedAt: null,
      seekDoneAt: 0,
      seekLatencySec: 0.1,
      playRequestedAt: null,
      startLatencySec: 0.1,
      rateChangedAt: 0,
    }
    el.addEventListener('loadeddata', () => this.emit())
    el.addEventListener('playing', () => {
      if (player.playRequestedAt === null) return
      player.startLatencySec = settle(player.startLatencySec, (performance.now() - player.playRequestedAt) / 1000)
      player.playRequestedAt = null
    })
    el.addEventListener('seeked', () => {
      const now = performance.now()
      if (player.seekStartedAt !== null) {
        player.seekLatencySec = settle(player.seekLatencySec, (now - player.seekStartedAt) / 1000)
        player.seekStartedAt = null
      }
      player.seekDoneAt = now
      if (player.pendingSec !== null) {
        const next = player.pendingSec
        player.pendingSec = null
        this.seek(player, next)
      }
      this.emit()
      // Redraw again once the new frame is really on screen.
      if (el instanceof HTMLVideoElement) el.requestVideoFrameCallback(() => this.emit())
    })
    el.addEventListener('error', () => console.warn(`Could not play "${media.name}": ${el.error?.message ?? 'unknown error'}`))
    el.src = url
    this.hostElement().append(el)
    this.players.set(layer.id, player)
    return player
  }

  private release(layerId: string): void {
    const player = this.players.get(layerId)
    if (!player) return
    this.players.delete(layerId)
    player.el.pause()
    player.el.removeAttribute('src')
    player.el.load()
    player.el.remove()
    player.gain.disconnect()
    player.still?.close()
  }

  /**
   * While playing, schedules the sounds stack's hits that fall just ahead of
   * the playhead on Web Audio (each once per run of playback), through the
   * master bus so the mixer meters them.
   */
  private scheduleHits(comp: Comp, doc: PreviewDoc, timeMs: number, playing: boolean, plan: MixPlan): void {
    const { media } = doc
    if (!playing) {
      this.scheduled.clear()
      this.lastTimeMs = timeMs
      return
    }
    if (timeMs < this.lastTimeMs - 50) this.scheduled.clear()
    this.lastTimeMs = timeMs
    const hits = this.compHits(comp, doc.comps)
    if (hits.length === 0) return
    const audio = this.audioContext()
    // A suspended context's clock stands still: hits scheduled on it would play late, all at once.
    if (audio.state === 'suspended') {
      void audio.resume()
      return
    }
    hits.forEach((hit, index) => {
      if (hit.timeMs < timeMs - 20 || hit.timeMs > timeMs + HIT_LOOKAHEAD_MS) return
      const key = `${hit.layerId}|${hit.voice.id}|${Math.round(hit.timeMs)}`
      if (this.scheduled.has(key)) return
      const buffer = this.hitBuffer(audio, hit, media)
      if (!buffer) return
      this.scheduled.add(key)
      const source = audio.createBufferSource()
      source.buffer = buffer
      const lead = hit.voice.custom ? hit.voice.custom.hitMs / 1000 / hit.pitch : 0
      if (hit.voice.custom) source.playbackRate.value = hit.pitch
      const gain = audio.createGain()
      // Levelled like the export: rapid-fire cues sit under one-shots.
      gain.gain.value = hit.volume * (plan.hitTrim[index] ?? 1)
      source.connect(gain).connect(this.busInput(plan.hitBus[index] ?? null))
      const at = audio.currentTime + (hit.timeMs - timeMs) / 1000 - lead
      source.start(Math.max(audio.currentTime, at), Math.max(0, audio.currentTime - at) * (hit.voice.custom ? hit.pitch : 1))
    })
  }

  /** The sounds stack's hits of a comp (those inside its nested comps too), kept while its lanes and the comps are unchanged. */
  private compHits(comp: Comp, comps: PreviewDoc['comps']): SoundHit[] {
    if (this.hitCache?.tracks !== comp.tracks || this.hitCache.comps !== comps) this.hitCache = { tracks: comp.tracks, comps, hits: compSoundHitsDeep(comp, comps) }
    return this.hitCache.hits
  }

  /**
   * The mix plan of the comp: remade when the comp, the categories or the
   * media change, and when a loudness measurement it waited for lands
   * (sounds not yet measured play unlevelled until then). The loudness
   * match's trim lands the same way, once the whole mix is measured.
   */
  private mixPlan(comp: Comp, doc: PreviewDoc, span: MixSpan | undefined): MixPlan {
    const cached = this.planCache
    if (
      cached &&
      cached.comp === comp &&
      cached.doc.soundCategories === doc.soundCategories &&
      cached.doc.media === doc.media &&
      cached.doc.comps === doc.comps &&
      cached.span?.startMs === span?.startMs &&
      cached.span?.endMs === span?.endMs
    )
      return cached.plan
    if (this.reader?.media !== doc.media) this.reader = { media: doc.media, sources: new ExportSources(doc) }
    const { plan, complete } = currentMixPlan(doc, comp, audibleLayers(comp, doc), this.compHits(comp, doc.comps),this.reader.sources, span, () => {
      this.planCache = null
      this.emit()
    })
    this.planCache = { comp, doc, plan, complete, span }
    return plan
  }

  /** Sets the graph's faders, ducks, compressors and limiter from the plan at comp time `timeMs`. */
  private applyPlan(plan: MixPlan, timeMs: number): void {
    const graph = this.mixGraph(this.audioContext())
    const now = graph.context.currentTime
    const glide = (param: AudioParam, value: number) => {
      if (Math.abs(param.value - value) > 1e-4) param.setTargetAtTime(value, now, GAIN_GLIDE_SEC)
    }
    for (const bus of plan.buses) {
      const nodes = this.busNodes(graph, bus.id)
      glide(nodes.fader.gain, bus.gain)
      glide(nodes.duck.gain, bus.duck ? tableAt(bus.duck, timeMs) : 1)
      const compress = bus.compress && this.worklet === true
      if (compress !== nodes.compressing) {
        nodes.compressor ??= new AudioWorkletNode(graph.context, 'uve-compressor', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          channelCount: 2,
          channelCountMode: 'explicit',
          processorOptions: { ...SPEECH_COMPRESSOR },
        })
        nodes.compressor.disconnect()
        nodes.input.disconnect()
        if (compress) nodes.input.connect(nodes.compressor).connect(nodes.duck)
        else nodes.input.connect(nodes.duck)
        nodes.compressing = compress
      }
    }
    glide(graph.unrouted.gain, plan.unroutedGain)
    glide(graph.master.gain, plan.masterVolume * plan.masterTrim)
    const limit = plan.limiter.enabled && this.worklet === true
    if (limit && graph.limiter && plan.limiter.ceilingDb !== graph.ceilingDb) {
      graph.limiter.port.postMessage({ ceilingDb: plan.limiter.ceilingDb })
      graph.ceilingDb = plan.limiter.ceilingDb
    }
    if (limit !== graph.limiting) {
      if (!graph.limiter) {
        graph.limiter = new AudioWorkletNode(graph.context, 'uve-limiter', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          channelCount: 2,
          channelCountMode: 'explicit',
          processorOptions: { ceilingDb: plan.limiter.ceilingDb },
        })
        graph.limiter.connect(graph.meter)
        graph.ceilingDb = plan.limiter.ceilingDb
      }
      graph.master.disconnect()
      graph.master.connect(limit ? graph.limiter : graph.meter)
      graph.limiting = limit
    }
  }

  /** Connects a player's gain to its bus, when that changed. */
  private route(player: Player, bus: string | null): void {
    if (player.bus === bus) return
    player.gain.disconnect()
    player.gain.connect(this.busInput(bus))
    player.bus = bus
  }

  /** Where sound for a bus goes in (null or an unknown bus: the unrouted input). */
  private busInput(bus: string | null): AudioNode {
    const graph = this.mixGraph(this.audioContext())
    return bus === null ? graph.unrouted : this.busNodes(graph, bus).input
  }

  private busNodes(graph: MixGraph, id: string): BusNodes {
    let nodes = graph.buses.get(id)
    if (!nodes) {
      const { context } = graph
      nodes = { input: context.createGain(), compressor: null, compressing: false, duck: context.createGain(), fader: context.createGain() }
      nodes.input.connect(nodes.duck).connect(nodes.fader).connect(graph.master)
      graph.buses.set(id, nodes)
    }
    return nodes
  }

  /** The mix graph on the context; the dynamics worklet loads in the background (until then, and if it fails, sound passes without it). */
  private mixGraph(audio: AudioContext): MixGraph {
    if (this.graph?.context === audio) return this.graph
    const meter = audio.createAnalyser()
    meter.fftSize = 1024
    meter.connect(audio.destination)
    const master = audio.createGain()
    master.connect(meter)
    const unrouted = audio.createGain()
    unrouted.connect(master)
    this.graph = { context: audio, buses: new Map(), unrouted, master, limiter: null, limiting: false, ceilingDb: 0, meter }
    if (this.worklet === null) {
      audio.audioWorklet
        .addModule(mixWorkletUrl)
        .then(() => {
          this.worklet = true
          // The graph picks the compressor and limiter up on the next sync.
          this.planCache = null
          this.emit()
        })
        .catch((error: unknown) => {
          this.worklet = false
          console.warn('The preview plays without its compressor and limiter:', error)
        })
    }
    return this.graph
  }

  /** A hit's sound as an AudioBuffer: a pack synthesised at the context's rate, or a custom file decoded (loaded on first use). */
  private hitBuffer(audio: AudioContext, hit: SoundHit, media: readonly MediaAsset[]): AudioBuffer | null {
    if (hit.voice.pack) {
      // A recorded pack loads its takes on first use; its hits are not heard until then.
      if (!packReady(hit.voice.pack)) {
        void loadPackTakes()
        return null
      }
      const key = `${hit.voice.pack}|${packPitch(hit.pitch)}|${hit.voice.pack === 'keys' ? hit.variant % KEYS_TAKES : 0}`
      let buffer = this.hitBuffers.get(key)
      if (!buffer) {
        const pcm = synthHit(hit.voice.pack, hit.pitch, hit.variant, audio.sampleRate)
        if (pcm.length === 0) return null
        buffer = audio.createBuffer(1, pcm.length, audio.sampleRate)
        buffer.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0)
        this.hitBuffers.set(key, buffer)
      }
      return buffer
    }
    const assetId = hit.voice.custom?.assetId
    if (!assetId) return null
    const known = this.customBuffers.get(assetId)
    if (known instanceof AudioBuffer) return known
    if (known === undefined) {
      const asset = media.find((m) => m.id === assetId)
      if (!asset) return null
      this.customBuffers.set(assetId, 'loading')
      void fetch(mediaUrl(asset.path))
        .then((r) => r.arrayBuffer())
        .then((bytes) => audio.decodeAudioData(bytes))
        .then((decoded) => this.customBuffers.set(assetId, decoded))
        .catch(() => this.customBuffers.set(assetId, 'failed'))
    }
    return null
  }

  private audioContext(): AudioContext {
    this.audio ??= new AudioContext()
    return this.audio
  }

  /** The preview's peak level over the last few milliseconds, after the limiter, in dBFS (-Infinity when silent). */
  level(): number {
    const meter = this.graph?.meter
    if (!meter) return Number.NEGATIVE_INFINITY
    const samples = new Float32Array(meter.fftSize)
    meter.getFloatTimeDomainData(samples)
    let peak = 0
    for (const v of samples) peak = Math.max(peak, Math.abs(v))
    return peak > 0 ? 20 * Math.log10(peak) : Number.NEGATIVE_INFINITY
  }

  private image(media: MediaAsset): HTMLImageElement | null {
    let image = this.images.get(media.path)
    if (!image) {
      image = new Image()
      image.crossOrigin = 'anonymous'
      image.decoding = 'async'
      image.addEventListener('load', () => this.emit())
      image.src = mediaUrl(media.path)
      this.images.set(media.path, image)
    }
    return image.complete && image.naturalWidth > 0 ? image : null
  }

  /**
   * Elements are kept in the page, tiny and transparent: browsers may stop
   * decoding media elements that are not attached to the document.
   */
  private hostElement(): HTMLDivElement {
    if (!this.host) {
      const host = document.createElement('div')
      host.dataset.previewMedia = ''
      host.style.cssText =
        'position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;z-index:-1'
      document.body.append(host)
      this.host = host
    }
    return this.host
  }
}

/** The editor's one preview player, shared by the viewport and the mixer. */
export const preview = new PreviewMedia()
