import type { WebContents } from 'electron'

// Windows that are not the editor (the recorder's Stop bar). The agent relay
// must not take their loading for the editor reloading, nor answer through them.
export const helperContents = new WeakSet<WebContents>()

export function isHelperContents(contents: WebContents): boolean {
  return helperContents.has(contents)
}
