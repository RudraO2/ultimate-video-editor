import { describe, expect, it } from 'vitest'
import { MODE_TABS, readUiMode, tabForMode, UI_MODE_KEY } from './uiMode'

const storage = (value: string | null) => ({ getItem: (key: string) => (key === UI_MODE_KEY ? value : null) })

describe('readUiMode', () => {
  it('opens in Easy on the first launch', () => {
    expect(readUiMode(storage(null))).toBe('easy')
    expect(readUiMode(undefined)).toBe('easy')
  })
  it('remembers Advanced', () => {
    expect(readUiMode(storage('advanced'))).toBe('advanced')
    expect(readUiMode(storage('easy'))).toBe('easy')
  })
  it('falls back to Easy on anything else or when storage throws', () => {
    expect(readUiMode(storage('pro'))).toBe('easy')
    expect(
      readUiMode({
        getItem: () => {
          throw new Error('blocked')
        },
      }),
    ).toBe('easy')
  })
})

describe('tabForMode', () => {
  it('keeps a tab both modes have', () => {
    expect(tabForMode('easy', 'media')).toBe('media')
    expect(tabForMode('advanced', 'library')).toBe('library')
  })
  it("moves to the mode's first tab otherwise", () => {
    expect(tabForMode('easy', 'scripts')).toBe('chat')
    expect(tabForMode('advanced', 'chat')).toBe('library')
  })
  it('gives Easy the chat first and Advanced every older tab', () => {
    expect(MODE_TABS.easy[0]).toBe('chat')
    expect(MODE_TABS.advanced).toEqual(['library', 'media', 'layers', 'scripts', 'voice', 'plugins', 'agents'])
  })
})
