import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))
const resolve = createRequire(import.meta.url).resolve

/**
 * The frame kit, served at /plugin-kit/: frame.js as written, frame.css as its base followed by the
 * UI's own components, and the two fonts the UI uses.
 */
function pluginKit(): Plugin {
  return {
    name: 'pneuma-plugin-kit',
    generateBundle() {
      const emit = (fileName: string, source: string | Uint8Array) => this.emitFile({ type: 'asset', fileName: `plugin-kit/${fileName}`, source })
      emit('frame.js', readFileSync(here('./kit/frame.js'), 'utf8'))
      emit('frame.css', `${readFileSync(here('./kit/frame.css'), 'utf8')}\n${readFileSync(here('./src/components.css'), 'utf8')}`)
      emit('inter.woff2', readFileSync(resolve('@fontsource-variable/inter/files/inter-latin-wght-normal.woff2')))
      emit('mono.woff2', readFileSync(resolve('@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2')))
    },
  }
}

// The page is built into ../dist/web, which the server serves next to its own code.
export default defineConfig({
  root: here('.'),
  base: './',
  plugins: [react(), tailwindcss(), pluginKit()],
  build: {
    outDir: here('../dist/web'),
    emptyOutDir: true,
  },
})
