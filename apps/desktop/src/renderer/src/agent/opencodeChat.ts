import { applyEvent } from '../../../shared/opencode'
import { useEditor } from '../store'

/** Follows OpenCode's status and chat from the main process into the store. */
export function startOpenCodeChat(): void {
  // An older preload has no OpenCode bridge: nothing to follow.
  const bridge = window.uve.opencode as typeof window.uve.opencode | undefined
  if (!bridge) return
  bridge.onStatus((status) => useEditor.setState({ opencodeStatus: status }))
  bridge.onEvent((event) => useEditor.setState((s) => ({ chat: applyEvent(s.chat, event) })))
  void bridge.status().then((status) => useEditor.setState({ opencodeStatus: status }))
}
