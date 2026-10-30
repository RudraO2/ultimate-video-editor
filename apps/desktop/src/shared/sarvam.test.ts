import { describe, expect, it } from 'vitest'
import {
  BULBUL_V3_SPEAKERS,
  SARVAM_LANGUAGES,
  dubCost,
  keyHint,
  languageCode,
  sarvamErrorMessage,
  splitForTranslate,
  stableKey,
  sttCost,
  translateBody,
  translateCost,
  ttsBody,
  ttsCost,
  wavSeconds,
} from './sarvam'

describe('languageCode', () => {
  it('accepts codes, short codes and names in any case', () => {
    for (const input of ['hi', 'hi-IN', 'HI-in', 'Hindi', 'hindi', 'हिन्दी', ' hi ']) expect(languageCode(input)).toBe('hi-IN')
    expect(languageCode('Tamil')).toBe('ta-IN')
    expect(languageCode('en')).toBe('en-IN')
    expect(languageCode('English')).toBe('en-IN')
  })

  it('maps Odia by its old names too', () => {
    for (const input of ['or', 'or-IN', 'Oriya', 'od', 'od-IN', 'Odia', 'ଓଡ଼ିଆ']) expect(languageCode(input)).toBe('od-IN')
  })

  it('knows every listed language by code and native name', () => {
    for (const lang of SARVAM_LANGUAGES) {
      expect(languageCode(lang.code)).toBe(lang.code)
      expect(languageCode(lang.native)).toBe(lang.code)
    }
  })

  it('returns null for what it does not know', () => {
    expect(languageCode('klingon')).toBeNull()
    expect(languageCode('')).toBeNull()
  })
})

describe('speakers', () => {
  it('lists genders only where they are known', () => {
    const gender = (id: string) => BULBUL_V3_SPEAKERS.find((s) => s.id === id)?.gender
    expect(gender('shubh')).toBe('male')
    expect(gender('priya')).toBe('female')
    expect(gender('kabir')).toBeNull()
    expect(BULBUL_V3_SPEAKERS).toHaveLength(37)
  })
})

describe('ttsBody', () => {
  it('fills the defaults and leaves out unset fields', () => {
    expect(ttsBody({ text: 'नमस्ते', language: 'hindi' })).toEqual({
      text: 'नमस्ते',
      language_code: 'hi-IN',
      speaker: 'shubh',
      model: 'bulbul:v3',
      speech_sample_rate: 48000,
    })
  })

  it('passes pace and temperature when given', () => {
    const body = ttsBody({ text: 'hi', language: 'en', speaker: 'ritu', model: 'bulbul:v4-flash', pace: 1.2, temperature: 0.3, sampleRate: 24000 })
    expect(body).toMatchObject({ speaker: 'ritu', model: 'bulbul:v4-flash', pace: 1.2, temperature: 0.3, speech_sample_rate: 24000 })
  })

  it('refuses text that is empty or too long', () => {
    expect(() => ttsBody({ text: '  ', language: 'hi' })).toThrow()
    expect(() => ttsBody({ text: 'a'.repeat(2501), language: 'hi' })).toThrow(/2500/)
    expect(() => ttsBody({ text: 'a'.repeat(2500), language: 'hi' })).not.toThrow()
  })

  it('refuses a pace out of range, an unknown language and a bad sample rate', () => {
    expect(() => ttsBody({ text: 'a', language: 'hi', pace: 0.4 })).toThrow(/Pace/)
    expect(() => ttsBody({ text: 'a', language: 'hi', pace: 2.1 })).toThrow(/Pace/)
    expect(() => ttsBody({ text: 'a', language: 'xx' })).toThrow(/language/)
    expect(() => ttsBody({ text: 'a', language: 'hi', sampleRate: 12345 })).toThrow(/Sample rate/)
  })
})

describe('translateBody', () => {
  it('detects the source language by default', () => {
    expect(translateBody({ text: 'x', to: 'ta' }, 'Hello')).toEqual({
      input: 'Hello',
      source_language_code: 'auto',
      target_language_code: 'ta-IN',
      model: 'sarvam-translate:v1',
    })
  })

  it('carries the source, mode and gender', () => {
    expect(translateBody({ text: 'x', to: 'Hindi', from: 'en', mode: 'code-mixed', speakerGender: 'Female' }, 'Hi')).toMatchObject({
      source_language_code: 'en-IN',
      target_language_code: 'hi-IN',
      mode: 'code-mixed',
      speaker_gender: 'Female',
    })
  })

  it('refuses an unknown target', () => {
    expect(() => translateBody({ text: 'x', to: 'nope' }, 'x')).toThrow()
  })
})

describe('splitForTranslate', () => {
  it('keeps a short text whole', () => {
    expect(splitForTranslate('Hello there.')).toEqual(['Hello there.'])
  })

  it('splits at English sentence ends and Hindi dandas', () => {
    expect(splitForTranslate('One two. Three four! Five six?', 12)).toEqual(['One two.', 'Three four!', 'Five six?'])
    expect(splitForTranslate('यह पहला है। यह दूसरा है।', 14)).toEqual(['यह पहला है।', 'यह दूसरा है।'])
  })

  it('packs short sentences together up to the limit', () => {
    expect(splitForTranslate('A b. C d. E f.', 10)).toEqual(['A b. C d.', 'E f.'])
  })

  it('cuts a 4500-character text into chunks of at most 2000 that rejoin to the original', () => {
    const sentence = 'The quick brown fox jumps over the lazy dog'
    let text = ''
    for (let i = 0; text.length < 4500; i++) text += `${sentence} ${i}${i % 3 === 0 ? '।' : '.'} `
    text = text.trim()
    const chunks = splitForTranslate(text)
    expect(chunks.length).toBeGreaterThan(2)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(2000)
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' '))
  })

  it('cuts a sentence with no stops at spaces, never mid-word', () => {
    const text = Array.from({ length: 900 }, (_, i) => `word${i}`).join(' ')
    const chunks = splitForTranslate(text)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(2000)
    expect(chunks.join(' ')).toBe(text)
  })
})

describe('sarvamErrorMessage', () => {
  it('explains a rejected key', () => {
    expect(sarvamErrorMessage(401, null)).toBe('Sarvam rejected the API key. Set it in the Voice tab or the SARVAM_API_KEY environment variable.')
    expect(sarvamErrorMessage(403, {})).toMatch(/rejected the API key/)
  })

  it('explains used-up credits', () => {
    expect(sarvamErrorMessage(402, { error: { message: 'x' } })).toBe(
      'Your Sarvam credits are used up. Top up at https://dashboard.sarvam.ai, then try again.',
    )
  })

  it('shows the validation message with the status', () => {
    const message = sarvamErrorMessage(422, { error: { message: 'text too long', code: 'x', request_id: 'r' } })
    expect(message).toContain('422')
    expect(message).toContain('text too long')
  })

  it('copes with a body it cannot read', () => {
    expect(sarvamErrorMessage(500, 'oops')).toContain('500')
    expect(sarvamErrorMessage(429, null)).toMatch(/limiting/)
  })
})

describe('stableKey', () => {
  it('ignores key order, also in nested objects', () => {
    expect(stableKey({ b: 1, a: { d: 2, c: [{ z: 1, y: 2 }] } })).toBe(stableKey({ a: { c: [{ y: 2, z: 1 }], d: 2 }, b: 1 }))
    expect(stableKey({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
  })

  it('tells different values apart and drops undefined', () => {
    expect(stableKey({ a: 1 })).not.toBe(stableKey({ a: 2 }))
    expect(stableKey({ a: 1, b: undefined })).toBe('{"a":1}')
  })
})

describe('costs', () => {
  it('prices speech by the thousand characters', () => {
    expect(ttsCost(1000, 'bulbul:v3')).toBe(3)
    expect(ttsCost(1000, 'bulbul:v4-flash')).toBe(1)
    expect(ttsCost(2500)).toBe(7.5)
    expect(ttsCost(123, 'bulbul:v3')).toBe(0.37)
  })

  it('prices translation, speech to text and dubbing', () => {
    expect(translateCost(2000)).toBe(4)
    expect(sttCost(60)).toBe(0.49)
    expect(sttCost(30)).toBe(0.25)
    expect(dubCost(60, 1)).toBe(40)
    expect(dubCost(90, ['hi-IN', 'ta-IN'])).toBe(120)
  })
})

describe('keyHint', () => {
  it('shows only the last three characters', () => {
    expect(keyHint('sk_abcdefghijYaM')).toBe('sk_…YaM')
  })
})

describe('wavSeconds', () => {
  const wav = (byteRate: number, dataBytes: number) => {
    const bytes = new Uint8Array(44 + dataBytes)
    const view = new DataView(bytes.buffer)
    bytes.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0)
    view.setUint32(4, 36 + dataBytes, true)
    bytes.set([...'WAVEfmt '].map((c) => c.charCodeAt(0)), 8)
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, byteRate / 2, true)
    view.setUint32(28, byteRate, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    bytes.set([...'data'].map((c) => c.charCodeAt(0)), 36)
    view.setUint32(40, dataBytes, true)
    return bytes
  }

  it('reads the length from the header', () => {
    expect(wavSeconds(wav(48000, 96000))).toBe(2)
  })

  it('is null for something that is not a WAV', () => {
    expect(wavSeconds(new Uint8Array(100))).toBeNull()
    expect(wavSeconds(new Uint8Array(10))).toBeNull()
  })
})
