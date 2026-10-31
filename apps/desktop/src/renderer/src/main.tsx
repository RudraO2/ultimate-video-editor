import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/inter/800.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import { configureModels } from '@uve/engine'
import { mediaUrl } from '../../shared/media'
import { startAgentHost } from './agent/host'
import { startOpenCodeChat } from './agent/opencodeChat'
import { App } from './App'
import { exportForDebug, setDebugExportTarget } from './export/job'
import { followProjectFonts, prefetchLookFonts } from './library/fonts'
import { loadPackTakes } from './library/sounds'
import { importFiles } from './media/import'
import { preview } from './media/preview'
import { startProjectTracking } from './project/file'
import { initRecorder } from './recording/recorder'
import { session, useEditor } from './store'
import { applyTheme } from './theme'
import './styles.css'

// The remembered theme before the first paint, so a light launch never flashes dark.
applyTheme(useEditor.getState().theme)

// Development builds expose the session, the importer and the exporter to
// automated checks (for example through the Chrome DevTools MCP server).
if (import.meta.env.DEV) Object.assign(window, { __uve: { session, useEditor, importFiles, exportForDebug, setDebugExportTarget, preview } })

// 3D models: files (and the files beside a .gltf) are read through the media protocol; the Draco decoder ships beside the page.
configureModels({ urlOf: mediaUrl, dracoPath: new URL('./draco/', document.baseURI).href })
// The recorded keys pack, so its first hits are heard.
void loadPackTakes()
startAgentHost()
initRecorder()
startOpenCodeChat()
startProjectTracking()
// Text layers draw in their own fonts, whichever panel is open; the looks' fonts are cached for offline use.
followProjectFonts((listener) => session.subscribe(listener), () => session.project)
setTimeout(() => void prefetchLookFonts(), 3000)

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
