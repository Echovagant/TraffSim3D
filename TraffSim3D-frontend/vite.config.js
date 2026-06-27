import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), vueDevTools()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@domain': fileURLToPath(new URL('./src/domain', import.meta.url)),
      '@application': fileURLToPath(new URL('./src/application', import.meta.url)),
      '@infrastructure': fileURLToPath(new URL('./src/infrastructure', import.meta.url)),
      '@interfaces': fileURLToPath(new URL('./src/interfaces', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
  server: {
    // Plan A: forward FastAPI endpoints to the local backend so the browser
    // can call `/api/v1/ping` and `/health` without CORS preflights in dev.
    // Production builds serve the API from the same origin (or a reverse
    // proxy) — this block is dev-only.
    //
    // Plan 052 follow-up: read the backend port from `VITE_BACKEND_PORT`
    // env (default 8000) so users who launch uvicorn on a non-default
    // port don't need to edit this file. Frontend's `BACKEND_URL`
    // (`MapImporterView`, `AIPlaygroundView`) mirrors this env var so
    // direct fetches target the same port the proxy uses.
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.VITE_BACKEND_PORT || 8000}`,
        changeOrigin: true,
      },
      '/health': {
        target: `http://localhost:${process.env.VITE_BACKEND_PORT || 8000}`,
        changeOrigin: true,
      },
    },
  },
  optimizeDeps: {
    // Rapier compat ships .wasm + asm.js; let Vite pre-bundle and
    // serve it without trying to crawl the .wasm file as JS.
    exclude: ['@dimforge/rapier3d-compat'],
  },
  assetsInclude: ['**/*.wasm'],
  worker: {
    format: 'es',
  },
})
