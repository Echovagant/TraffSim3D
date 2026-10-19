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
    /**
     * Plan 066: load the Cesium runtime on demand instead of on every page.
     *
     * `vite-plugin-cesium` injects `<script src="/cesium/Cesium.js">` into
     * `index.html` for production builds, because it externalises the `cesium`
     * npm package and expects the UMD global. That tag is 5.3 MB and was
     * downloaded by *every* page — the home page included — even though only
     * `SmartCityView` touches Cesium.
     *
     * The script is still copied to `dist/cesium/` by the plugin's
     * `closeBundle`; only the eager tag is removed here. The runtime is then
     * injected on demand by `src/infrastructure/cesium/loadCesiumRuntime.ts`,
     * using the identical URL so Cesium's own base-URL derivation is
     * unchanged.
     */
    {
      name: 'cesium-lazy-runtime',
      transformIndexHtml: {
        order: 'post',
        handler(html) {
          return html.replace(/<script[^>]*src="[^"]*Cesium\.js"[^>]*>\s*<\/script>\s*/g, '')
        },
      },
    },
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
    // Split heavy vendor libs into their own chunks.
    //
    // Plan 066 correction: the long-standing comment here claimed the home
    // page used to download "a 2 MB WASM blob". That was already untrue for
    // Rapier — `RapierWorld.init()` lazy-imports it, so `rapier-*.js` is only
    // fetched when a 3D view opens. The real first-paint offender was
    // **Cesium**: `vite-plugin-cesium` injected its 5.3 MB UMD runtime into
    // `index.html` for every page. That is now loaded on demand (see the
    // `cesium-lazy-runtime` plugin above and
    // `src/infrastructure/cesium/loadCesiumRuntime.ts`).
    //
    // Measured on 2026-10-20 (production build, gzip transfer size):
    //   home page   235 KB total  (three 134 + index 62 + gsap 27 + css 8)
    //   before fix  ~1800 KB       (the extra 1565 KB was cesium/Cesium.js)
    //
    // `three` stays eager on purpose: `HomeView` renders
    // `EnhancedWebGLBackground`, a decorative WebGL backdrop that genuinely
    // needs it.
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
