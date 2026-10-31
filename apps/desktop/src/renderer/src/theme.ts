// Light (Cream) and dark: two looks over the same tokens in styles.css. The
// theme is a per-machine preference, not part of the project.

export type Theme = 'light' | 'dark'

export const THEME_KEY = 'uve.theme'

/** Light on the first launch; then the theme last picked. */
export function readTheme(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): Theme {
  try {
    return storage?.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

/** Puts `theme` on the page: styles.css keys the light tokens off `html[data-theme="light"]`. */
export function applyTheme(theme: Theme, root: { dataset: DOMStringMap } = document.documentElement): void {
  root.dataset.theme = theme
}

/** The value of a colour token as the current theme sets it, for canvas drawing (for example `cssColor('accent')`). */
export function cssColor(token: string, fallback = '#ff4e6a'): string {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(`--color-${token}`).trim() || fallback
  } catch {
    return fallback
  }
}
