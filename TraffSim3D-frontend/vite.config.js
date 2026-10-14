import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'
import cesium from 'vite-plugin-cesium'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    vueDevTools(),
    // Plan 055: Cesium plugin — copies Cesium's static assets (Workers,
    // ThirdParty, Assets, Widgets) to /Cesium/* in dev and emits the
    // CESIUM_BASE_URL script. Without this, Cesium tries to load
    // /Workers/*.js from the dev server root and fails with a 404
    // module-script error.
    cesium(),
  ],
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
  build: {
    // Plan 055/062 follow-up: split heavy vendor libs into their own
    // chunks so the home page (HomeView, no Rapier/Three scene) does not
    // download a 2 MB WASM blob on first paint. Rapier is only needed by
    // SceneEditor / SimulationLab / AIPlayground, which dynamically
    // import the world simulation.
    rollupOptions: {
      output: {
        manualChunks: {
          rapier: ['@dimforge/rapier3d-compat'],
          three: ['three', 'postprocessing'],
          gsap: ['gsap'],
        },
      },
    },
  },
})
