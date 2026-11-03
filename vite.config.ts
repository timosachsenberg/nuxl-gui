/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin } from 'vite'

/**
 * The OFL texts of the bundled fonts beside the font files in dist/assets: Inter (@fontsource-variable/inter),
 * Inconsolata and Liberation Mono (src/assets/fonts). The OFL asks that its text go with the fonts.
 */
function fontLicences(): Plugin {
  const licences: [string, string][] = [
    ['assets/Inter-LICENSE.txt', 'node_modules/@fontsource-variable/inter/LICENSE'],
    ['assets/Inconsolata-LICENSE.txt', 'src/assets/fonts/Inconsolata-LICENSE.txt'],
    ['assets/LiberationMono-LICENSE.txt', 'src/assets/fonts/LiberationMono-LICENSE.txt'],
  ]
  return {
    name: 'prose-font-licences',
    apply: 'build',
    generateBundle() {
      for (const [fileName, source] of licences) {
        this.emitFile({ type: 'asset', fileName, source: readFileSync(new URL(source, import.meta.url)) })
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  // Tauri serves the build from its own protocol, and `tauri dev` loads the dev server
  clearScreen: false,
  plugins: [tailwindcss(), svelte(), fontLicences()],
  resolve: {
    alias: { $lib: fileURLToPath(new URL('./src/lib', import.meta.url)) },
    // the unit tests mount components (happy-dom): Svelte's client build, as in the app
    ...(process.env.VITEST ? { conditions: ['browser'] } : {}),
  },
  server: { port: 1420, strictPort: true },
  // one bundle, loaded from disk by the app (the modification and chemistry tables are in it)
  build: { chunkSizeWarningLimit: 2000 },
  // the unit tests (e2e/ has the WebdriverIO specs of the app)
  test: { include: ['src/**/*.test.ts'] },
})
