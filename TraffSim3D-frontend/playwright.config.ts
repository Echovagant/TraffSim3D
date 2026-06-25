import { defineConfig } from '@playwright/test';

/**
 * Plan 042: Playwright e2e + screenshot baseline.
 *
 * Test directory: ./tests/e2e
 * Screenshot output: ../../e2e-output/{current,baseline}/ (project root, per user request)
 * Vite dev server: auto-started via webServer config
 *
 * Run modes:
 *   npm run test:e2e           — headless (CI / default)
 *   npm run test:e2e:headed    — popup Chrome window (debug)
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    headless: true,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
