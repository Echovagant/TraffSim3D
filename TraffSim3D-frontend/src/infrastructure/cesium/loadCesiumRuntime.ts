// src/infrastructure/cesium/loadCesiumRuntime.ts
//
// Why this exists
// ---------------
// `vite-plugin-cesium` externalises the `cesium` npm package in production
// builds (`build.rollupOptions.external = ['cesium']`) and expects the UMD
// global `Cesium` to exist at runtime. It injects that runtime into
// `index.html` with a plain <script> tag, which means **every page — including
// the home page — eagerly downloads the 5.3 MB `cesium/Cesium.js`**, even
// though only `SmartCityView` uses Cesium at all.
//
// That made the home page's first paint cost roughly 5.9 MB (5.3 MB Cesium +
// 0.6 MB of modulepreload), when the home page needs none of it.
//
// What this module does
// ---------------------
// Loads the Cesium runtime **on demand**, right before the SmartCity view is
// imported. The script URL is unchanged (`/cesium/Cesium.js`), which matters:
//
//   Cesium resolves its own asset base URL in this order:
//     1. the global `CESIUM_BASE_URL`, if defined
//     2. the directory of the <script> tag that loaded Cesium
//     3. a built-in fallback
//
// Because (2) derives from the script's own URL, injecting the identical URL
// lazily resolves to the identical `/cesium/` base, so the Workers / Assets /
// ThirdParty lookups keep working unchanged.
//
// In dev, Vite bundles the `cesium` ESM package straight into the lazy
// SmartCity chunk and no global is involved, so this is a no-op there.

/** Runtime URL — must stay identical to what the plugin injected eagerly. */
const CESIUM_RUNTIME_URL = '/cesium/Cesium.js'

/**
 * Base URL for Cesium's static assets (Workers / Assets / ThirdParty).
 * The plugin copies them to `<outDir>/cesium/`, and Cesium itself would
 * derive the same value from the script URL. Setting it explicitly just
 * removes the dependence on that derivation.
 */
const CESIUM_BASE_URL = `${import.meta.env.BASE_URL}cesium/`.replace(/\/{2,}/g, '/')

/** Shared promise so concurrent navigations only inject one script tag. */
let pending: Promise<void> | null = null

const globalScope = window as unknown as {
  Cesium?: unknown
  CESIUM_BASE_URL?: string
}

/**
 * Ensure `window.Cesium` is available. Safe to call repeatedly.
 *
 * @returns resolves once the Cesium runtime is loaded (or was already there).
 * @throws  if the runtime script fails to load.
 */
export const ensureCesiumRuntime = async (): Promise<void> => {
  // Dev: the `cesium` ESM package is bundled into the lazy SmartCity chunk,
  // so no UMD global is needed. Skip the extra 5 MB there.
  if (!import.meta.env.PROD) return

  // Already present (e.g. the script tag was still in the document).
  if (globalScope.Cesium) return

  if (!pending) {
    pending = new Promise<void>((resolve, reject) => {
      globalScope.CESIUM_BASE_URL = CESIUM_BASE_URL
      const el = document.createElement('script')
      el.src = CESIUM_RUNTIME_URL
      el.async = true
      el.onload = () => resolve()
      el.onerror = () => {
        // Allow a later navigation to retry instead of caching the failure.
        pending = null
        reject(
          new Error(
            `Failed to load the Cesium runtime from ${CESIUM_RUNTIME_URL}. ` +
              `The SmartCity view needs it; check that the build copied ` +
              `dist/cesium/ (vite-plugin-cesium's closeBundle step).`,
          ),
        )
      }
      document.head.appendChild(el)
    })
  }

  return pending
}
