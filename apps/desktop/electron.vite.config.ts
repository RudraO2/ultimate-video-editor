import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

const { version } = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string }

export default defineConfig({
  main: {
    // Workspace packages are TypeScript sources, so they are bundled rather than required at run time.
    build: { externalizeDeps: { exclude: ['@uve/mcp'] } },
  },
  preload: {},
  renderer: {
    // Written into project files, so a file says which version saved it.
    define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify(version) },
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
      },
    },
    // three.js only loads when a 3D world shows (a dynamic import); bundled up front in dev so its first load does not reload the window.
    optimizeDeps: {
      include: [
        '@uve/engine > three',
        '@uve/engine > three/addons/environments/RoomEnvironment.js',
        '@uve/engine > three/addons/lights/RectAreaLightUniformsLib.js',
        '@uve/engine > three/addons/utils/BufferGeometryUtils.js',
        '@uve/engine > three/addons/utils/SkeletonUtils.js',
        '@uve/engine > three/addons/loaders/GLTFLoader.js',
        '@uve/engine > three/addons/loaders/DRACOLoader.js',
        '@uve/engine > three/addons/loaders/OBJLoader.js',
        '@uve/engine > three/addons/loaders/STLLoader.js',
        '@uve/engine > three/addons/loaders/PLYLoader.js',
        '@uve/engine > three/addons/libs/meshopt_decoder.module.js',
      ],
    },
    plugins: [react(), tailwindcss()],
  },
})
