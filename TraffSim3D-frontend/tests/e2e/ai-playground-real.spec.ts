/**
 * GPU extension — opt-in real PPO training e2e.
 *
 * This test runs REAL PPO training, not the dry-run fake. It is NOT
 * included in `npm run test:e2e` (the default suite, which is for CI).
 * Run it manually on a GPU dev machine:
 *
 *     npm run test:e2e:real
 *
 * Skip conditions (this spec is on the Playwright exception list):
 * - Backend not reachable on $E2E_BACKEND_URL (default http://localhost:8000)
 * - Backend reports cuda_available: false
 * - Backend reports sb3_available: false
 *
 * The backend URL comes from the environment because the port is not the
 * same everywhere: a local dev backend runs on :8000, CI runs it on
 * :8001 (see .github/workflows/ci.yml). The old hard-coded :8000 made
 * this spec skip itself in CI — the only spec that talks to a real
 * backend was therefore never exercised by the pipeline.
 *
 * This test exercises the full backend → frontend pipeline:
 *   1. Fetch /api/v1/rl/capabilities to detect GPU + SB3
 *   2. Trigger real PPO for N=200 steps via /api/v1/rl/train (dry_run=false)
 *   3. Poll /api/v1/rl/status until running=true
 *   4. Wait a few seconds for partial progress
 *   5. Screenshot the in-progress state for visual review
 *
 * The test intentionally does NOT wait for training to complete (that
 * could take minutes on CPU). It verifies the start flow + UI updates.
 */
import { test, expect, request } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'
import { SCREENSHOT_DIR } from './helpers/wait'

/**
 * The real backend's base URL.
 *
 * `E2E_BACKEND_URL` → the CI backend (:8001) or a local one (:8000).
 * The default keeps the local dev workflow unchanged.
 */
const BACKEND_URL = process.env.E2E_BACKEND_URL ?? 'http://localhost:8000'
const STEPS = 200

test('real PPO training: starts, updates chart, captures GPU/CPU state', async ({ page }) => {
  // 1. Check capabilities via direct HTTP call (cheaper than routing through page)
  const api = await request.newContext({ baseURL: BACKEND_URL })
  let capsResp
  try {
    capsResp = await api.get('/api/v1/rl/capabilities', { timeout: 5000 })
  } catch {
    test.skip(true, 'Backend not reachable on ' + BACKEND_URL)
    return
  }
  if (!capsResp.ok()) {
    test.skip(true, `Backend /capabilities returned ${capsResp.status()}`)
    return
  }
  const caps = await capsResp.json()
  if (!caps.sb3_available) {
    test.skip(true, 'stable-baselines3 not installed (run `uv sync --extra rl`)')
    return
  }

  // 2. Navigate to /ai-playground (do NOT stub — use real backend)
  await page.goto('/ai-playground')
  await expect(page.locator('[data-testid="start-train-button"]')).toBeVisible()

  // 3. Verify the capabilities note reflects the backend's state
  const capNote = await page.locator('[data-testid="cap-note"]').textContent()
  expect(capNote).toBeTruthy()

  // 4. Set steps to a small number and trigger real (non-dry-run) training
  await page.locator('[data-testid="train-steps-input"]').fill(String(STEPS))
  await page.locator('[data-testid="dry-run-checkbox"]').uncheck()
  // Pick device based on caps
  if (caps.cuda_available) {
    await page.locator('[data-testid="device-select"]').selectOption('gpu')
  } else {
    await page.locator('[data-testid="device-select"]').selectOption('cpu')
  }
  await page.locator('[data-testid="start-train-button"]').click()

  // 5. The real run must actually PROGRESS.
  //
  //    The status endpoint is polled directly instead of waiting for
  //    the UI to say 运行中: a 200-step PPO run on CPU finishes within
  //    seconds, so by the time the page's 2 s poll lands the run may
  //    already be over — the old assertion ("运行中") then failed on a
  //    perfectly healthy run. What must hold is that the trainer
  //    advanced past step 0.
  await expect
    .poll(
      async () => {
        const r = await api.get('/api/v1/rl/status')
        if (!r.ok()) return -1
        const j = await r.json()
        return Number(j.step ?? 0)
      },
      { timeout: 60_000, intervals: [500] },
    )
    .toBeGreaterThan(0)

  // 6. The page reflects the run — running OR already finished (both
  //    are valid end states for a short run).
  await expect(page.locator('[data-testid="metric-running"]')).toHaveText(/运行中|已结束/, {
    timeout: 15_000,
  })

  // 7. Capture the state for human review.
  //
  //    A *pixel baseline* cannot work here: the page shows the live
  //    step counter and the reward series of an actual PPO run, so
  //    every run produces a different image — comparing it against a
  //    committed PNG can only ever fail (it did: the baseline was
  //    recorded once, on 2026-10-17, and no later run can match it).
  //    The screenshot is written to `e2e-output/current/` for review
  //    instead. The behavioural assertions above are the real gate.
  const reviewPath = path.join(SCREENSHOT_DIR, 'ai-playground-real.png')
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })
  await page.locator('main').screenshot({ path: reviewPath })

  // 8. The UI's own step readout must not be stuck at 0.
  await expect
    .poll(async () => Number(await page.locator('[data-testid="metric-step"]').textContent()), {
      timeout: 20_000,
    })
    .toBeGreaterThan(0)

  const step = Number(await page.locator('[data-testid="metric-step"]').textContent())
  await api.dispose()
  console.log(
    `Real PPO training started on ${caps.cuda_available ? 'GPU' : 'CPU'} ` +
      `(${caps.device_name || 'unknown'}). step=${step}`,
  )
})
