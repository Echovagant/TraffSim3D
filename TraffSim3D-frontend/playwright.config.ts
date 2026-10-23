import { defineConfig } from '@playwright/test'

/**
 * The frontend port the suite runs against.
 *
 * 5173 is vite's default port and it is regularly taken by ANOTHER
 * project on a developer machine. With `reuseExistingServer: true`
 * Playwright then silently reuses that foreign server and the whole
 * suite runs against the wrong application — the symptom is a set of
 * instant failures and one-minute timeouts that look exactly like
 * broken code.
 *
 * So:
 *   - the port is configurable (`E2E_FRONTEND_PORT`),
 *   - vite is started with `--strictPort` so it never drifts to the
 *     next free port (Playwright would then wait for a port nobody
 *     serves),
 *   - the server is NOT reused by default: a busy port fails the run
 *     loudly instead of testing somebody else's app. Set
 *     `E2E_REUSE_SERVER=1` to opt back into reusing a running server.
 *
 * CI does not use this file's port at all: it generates
 * `playwright.ci.config.ts`, which moves the frontend to :5188 and the
 * backend stays on :8001.
 */
const FRONTEND_PORT = Number(process.env.E2E_FRONTEND_PORT ?? 5173)
const REUSE_EXISTING_SERVER = process.env.E2E_REUSE_SERVER === '1'

/**
 * Playwright e2e + screenshot baseline.
 *
 * Test directory: ./tests/e2e
 * Screenshot output: ../../e2e-output/{current,baseline}/ (project root, per user request)
 * Vite dev server: auto-started via webServer config
 *
 * Run modes:
 *   npm run test:e2e           — headless (CI / default)
 *   npm run test:e2e:headed    — popup Chrome window (debug)
 *   npm run test:e2e:update    — re-record the baseline PNGs
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  /**
   * Raised from Playwright's 30s default on 2026-10-17.
   *
   * Reason: before this change every spec used `page.screenshot({path})`, which
   * only writes a file and costs almost nothing. Replacing those with
   * `toHaveScreenshot()` adds a real capture + pixel comparison per assertion,
   * and under SwiftShader software rasterization that is not cheap. Several
   * specs then hit the 30s ceiling and were killed mid-run, which silently
   * left 4 baselines (`scene-loop`, `scene-elevated`, `home-gsap-hero`,
   * `smart-city-basemap`) un-recorded at their old 1280x800 dimensions.
   *
   * 60s leaves headroom for the software rasterizer on a busy machine without
   * masking a genuine hang.
   */
  timeout: 60_000,
  /**
   * Compare against the checked-in baselines at the repo root instead of
   * Playwright's default `<testDir>/<spec>-snapshots/`. `{arg}` is the snapshot
   * name without its extension, `{ext}` is `.png`, and a relative template
   * resolves against this config's directory (TraffSim3D-frontend/), so this
   * lands on D:/Projects/TraffSim3D/e2e-output/baseline/<name>.png.
   */
  snapshotPathTemplate: '../e2e-output/baseline/{arg}{ext}',
  expect: {
    toHaveScreenshot: {
      /**
       * Tolerance, derived from measurement rather than guesswork: running the
       * scene specs twice with no code change between them gave a 0-0.25%
       * differing-pixel ratio on the scene-editor clip region (several captures
       * were bit-identical). 0.5% is ~2x the observed worst case, which leaves
       * room for a busier machine without hiding real rendering regressions.
       * Do NOT raise this to make a genuine visual change pass - that is
       * precisely the defect this assertion exists to catch.
       */
      maxDiffPixelRatio: 0.005,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    },
  },
  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    headless: true,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `npm run dev -- --port ${FRONTEND_PORT} --strictPort`,
    url: `http://localhost:${FRONTEND_PORT}`,
    reuseExistingServer: REUSE_EXISTING_SERVER,
    timeout: 60_000,
  },
})
