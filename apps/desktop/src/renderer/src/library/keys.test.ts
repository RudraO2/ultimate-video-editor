import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import keys from './keys.json'

describe('the recorded keys pack', () => {
  it('indexes 32 takes laid back to back in a 48 kHz mono 16-bit WAV', () => {
    const wav = readFileSync(join(__dirname, 'keys.wav'))
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.readUInt16LE(22)).toBe(1)
    expect(wav.readUInt32LE(24)).toBe(keys.sampleRate)
    expect(wav.readUInt16LE(34)).toBe(16)
    expect(keys.takes).toHaveLength(32)
    let next = 0
    for (const take of keys.takes) {
      expect(take.start).toBe(next)
      // Long enough to hold the hit, short enough to stay a keypress.
      expect(take.length / keys.sampleRate).toBeGreaterThan(0.1)
      expect(take.length / keys.sampleRate).toBeLessThan(0.25)
      next += take.length
    }
    expect(wav.readUInt32LE(40)).toBe(next * 2)
  })
})
