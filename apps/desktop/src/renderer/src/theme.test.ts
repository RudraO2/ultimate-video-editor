import { describe, expect, it } from 'vitest'
import { applyTheme, readTheme, THEME_KEY } from './theme'

const storage = (value: string | null) => ({ getItem: (key: string) => (key === THEME_KEY ? value : null) })

describe('readTheme', () => {
  it('opens light on the first launch', () => {
    expect(readTheme(storage(null))).toBe('light')
    expect(readTheme(undefined)).toBe('light')
  })
  it('remembers dark', () => {
    expect(readTheme(storage('dark'))).toBe('dark')
    expect(readTheme(storage('light'))).toBe('light')
  })
  it('falls back to light on anything else or when storage throws', () => {
    expect(readTheme(storage('sepia'))).toBe('light')
    expect(
      readTheme({
        getItem: () => {
          throw new Error('blocked')
        },
      }),
    ).toBe('light')
  })
})

describe('applyTheme', () => {
  it('marks the root with the theme', () => {
    const root = { dataset: {} as Record<string, string> }
    applyTheme('light', root)
    expect(root.dataset.theme).toBe('light')
    applyTheme('dark', root)
    expect(root.dataset.theme).toBe('dark')
  })
})
