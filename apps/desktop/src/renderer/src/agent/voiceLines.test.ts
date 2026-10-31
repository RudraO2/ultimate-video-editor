import { describe, expect, it, vi } from 'vitest'

vi.mock('../store', () => ({ useEditor: { getState: () => ({}) } }))
vi.mock('../media/probe', () => ({ probeMedia: vi.fn() }))
vi.mock('../media/import', () => ({ mediaInput: vi.fn() }))

const { balanceLines, languageOfText, soundsHindi } = await import('./voiceCommands')

describe('balanceLines', () => {
  it('breaks a translated title into as many lines as the original, about equally long', () => {
    expect(balanceLines('दुनिया को म्यूट कर दो', 3).split('\n')).toHaveLength(3)
    expect(balanceLines('one two three four', 2)).toBe('one two\nthree four')
    expect(balanceLines('single', 3)).toBe('single')
  })
})

describe('languageOfText', () => {
  it('reads the language from the script', () => {
    expect(languageOfText('तीस घंटे')).toBe('hi-IN')
    expect(languageOfText('தமிழ்')).toBe('ta-IN')
    expect(languageOfText('Thirty hours')).toBe('en-IN')
  })
})

describe('captionChunks', () => {
  it('starts a new line after a phrase end, a pause, or seven words', async () => {
    const { captionChunks } = await import('./voiceCommands')
    const w = (text: string, startMs: number) => ({ text, startMs, endMs: startMs + 200 })
    const chunks = captionChunks([w('Thirty', 0), w('hours.', 200), w('Noise', 400), w('gone', 600), w('now', 1200)])
    expect(chunks.map((c) => c.map((x) => x.text).join(' '))).toEqual(['Thirty hours.', 'Noise gone', 'now'])
    expect(captionChunks(Array.from({ length: 9 }, (_, i) => w('w' + i, i * 200))).map((c) => c.length)).toEqual([7, 2])
  })
})

describe('soundsHindi', () => {
  it('tells Hinglish in Latin letters from English', () => {
    expect(soundsHindi('As you all guys know that LinkedIn ke upar bahut zyada AI slop chal raha hai. Matlab jaise LinkedIn sab use karte hain')).toBe(true)
    expect(soundsHindi('So this video is just for testing purposes of this ultimate video editor and right now we are in a hackathon')).toBe(false)
    expect(soundsHindi('')).toBe(false)
  })
})
