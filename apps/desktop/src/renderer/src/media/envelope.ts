import { envelopeFromSamples, type MediaAsset } from '@uve/core'
import { mediaUrl } from '../../../shared/media'

// A voice's loudness for characters (talk and nod): the audio of an audio or
// video file decoded once, mixed to mono, and reduced to an envelope that is
// kept on the media item (`MediaAsset.envelope`).

/** Speech needs no more than this; decoding at a low rate keeps long files small in memory. */
const DECODE_RATE = 22050

/** Reads a media item's loudness, or undefined when it has no sound or cannot be decoded. */
export async function envelopeOfMedia(media: MediaAsset): Promise<{ rate: number; values: number[] } | undefined> {
  if (media.kind !== 'audio' && media.kind !== 'video') return undefined
  try {
    const response = await fetch(mediaUrl(media.path))
    if (!response.ok) return undefined
    const buffer = await new OfflineAudioContext(1, 1, DECODE_RATE).decodeAudioData(await response.arrayBuffer())
    const channels = buffer.numberOfChannels
    if (channels === 0 || buffer.length === 0) return undefined
    const mono = new Float32Array(buffer.length)
    for (let c = 0; c < channels; c++) {
      const data = buffer.getChannelData(c)
      for (let i = 0; i < mono.length; i++) mono[i]! += data[i]! / channels
    }
    const envelope = envelopeFromSamples(mono, buffer.sampleRate)
    return envelope.values.length > 0 ? envelope : undefined
  } catch {
    return undefined
  }
}
