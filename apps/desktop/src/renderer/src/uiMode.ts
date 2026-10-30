// Easy and Advanced: two layouts over the same project and commands. Easy shows
// the chat, the preview, a simple timeline and export; Advanced shows every panel.

export type LeftTab = 'chat' | 'library' | 'media' | 'layers' | 'scripts' | 'voice' | 'plugins' | 'agents'

export type UiMode = 'easy' | 'advanced'

/** The left tabs each mode shows, in rail order; the first is where the mode opens. */
export const MODE_TABS: Record<UiMode, readonly LeftTab[]> = {
  easy: ['chat', 'media', 'library'],
  advanced: ['library', 'media', 'layers', 'scripts', 'voice', 'plugins', 'agents'],
}

export const UI_MODE_KEY = 'uve.uiMode'

/** Easy on the first launch; then the mode last picked. */
export function readUiMode(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): UiMode {
  try {
    return storage?.getItem(UI_MODE_KEY) === 'advanced' ? 'advanced' : 'easy'
  } catch {
    return 'easy'
  }
}

/** The left tab to show after switching to `mode`: the current one if the mode has it, else the mode's first. */
export function tabForMode(mode: UiMode, current: LeftTab): LeftTab {
  const tabs = MODE_TABS[mode]
  return tabs.includes(current) ? current : (tabs[0] as LeftTab)
}
