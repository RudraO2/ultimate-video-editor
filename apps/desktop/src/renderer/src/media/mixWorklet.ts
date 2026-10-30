import { Compressor, type CompressorOptions, Limiter } from '@uve/engine/dynamics'

// The preview's dynamics, as AudioWorklet processors running the export's own
// compressor and limiter code (engine dynamics.ts), so the preview sounds like
// the export. Loaded with audioWorklet.addModule; nodes are made with
// outputChannelCount [2] and an explicit two-channel input.

// The worklet scope's globals (not in the DOM types).
declare const sampleRate: number
declare function registerProcessor(name: string, processor: new (options: { processorOptions?: unknown }) => unknown): void
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}

/** Copies the input (silence when none) to the output; returns the two output channels. */
function passThrough(inputs: Float32Array[][], outputs: Float32Array[][]): [Float32Array, Float32Array] | null {
  const out = outputs[0]
  const left = out?.[0]
  const right = out?.[1]
  if (!left || !right) return null
  const input = inputs[0]
  const inLeft = input?.[0]
  if (!inLeft) {
    left.fill(0)
    right.fill(0)
  } else {
    left.set(inLeft)
    right.set(input?.[1] ?? inLeft)
  }
  return [left, right]
}

class CompressorProcessor extends AudioWorkletProcessor {
  private readonly compressor: Compressor

  constructor(options: { processorOptions?: unknown }) {
    super()
    this.compressor = new Compressor({ ...(options.processorOptions as Omit<CompressorOptions, 'sampleRate'>), sampleRate })
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channels = passThrough(inputs, outputs)
    if (channels) this.compressor.process(channels[0], channels[1])
    return true
  }
}

class LimiterProcessor extends AudioWorkletProcessor {
  private limiter: Limiter

  constructor(options: { processorOptions?: unknown }) {
    super()
    const { ceilingDb } = options.processorOptions as { ceilingDb: number }
    this.limiter = new Limiter({ sampleRate, ceilingDb })
    // A new ceiling starts a new limiter (its look-ahead is a millisecond or two: nothing is heard).
    this.port.onmessage = (event: MessageEvent<{ ceilingDb: number }>) => {
      this.limiter = new Limiter({ sampleRate, ceilingDb: event.data.ceilingDb })
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channels = passThrough(inputs, outputs)
    if (channels) this.limiter.process(channels[0], channels[1])
    return true
  }
}

registerProcessor('uve-compressor', CompressorProcessor)
registerProcessor('uve-limiter', LimiterProcessor)
