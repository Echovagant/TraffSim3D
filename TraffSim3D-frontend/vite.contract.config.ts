// vite.contract.config.ts
//
// Plan 071: a minimal vite config for the contract snapshot generator.
//
// It exists because `vite-node` bundles its own (older) vite and the
// project's `vite.config.js` plugins are not compatible with it —
// `vite-plugin-vue-devtools` throws
// `TypeError: Cannot convert undefined or null to object` inside its
// `configureServer` hook. Only the path aliases are needed here.
//
// The aliases mirror `vitest.config.ts`, including `@__fixtures__` (which
// `vite.config.js` does not define).
import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@domain': fileURLToPath(new URL('./src/domain', import.meta.url)),
      '@application': fileURLToPath(new URL('./src/application', import.meta.url)),
      '@infrastructure': fileURLToPath(new URL('./src/infrastructure', import.meta.url)),
      '@interfaces': fileURLToPath(new URL('./src/interfaces', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@__fixtures__': fileURLToPath(new URL('./src/__fixtures__', import.meta.url)),
    },
  },
})
