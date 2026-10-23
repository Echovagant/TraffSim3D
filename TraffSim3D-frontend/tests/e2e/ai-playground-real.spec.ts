/**
 * Real PPO training e2e — opt-in, but a HARD gate once it is switched on.
 *
 * This test runs REAL PPO training (stable-baselines3 + torch), not the
 * dry-run fake. It is NOT part of `npm run test:e2e` (the default suite,
 * which is what the `e2e` CI job runs):
 *
 *     npm run test:e2e:real
 *
 * WHY IT IS OPT-IN
 * -----------------
 * A real run writes the shared training-status document and the
 * checkpoint directory. Every spec that runs after it then reads a
 * status that belongs to that run — which is how
 * `ai-playground-scene.spec.ts` ended up clicking a training button the
 * page had already disabled, and failing on an empty request body.
 * CI reaches a backend as well, so "the backend is unreachable" is not
 * a usable gate: the gate has to be explicit.
 *
 * WHY IT IS A HARD GATE ONCE ENABLED
 * ----------------------------------
 * Inside this file a *skip* and a *pass* look identical in a CI report.
 * A skipped real-training test is the exact failure mode this spec
 * exists to prevent: the real pipeline breaks, the spec skips itself,
 * the pipeline stays green. So once `E2E_REAL_TRAINING=1` is set, every
 * precondition is asserted and a missing precondition FAILS the test.
 * The one remaining skip is the opt-in gate itself.
 *
 * CI runs it in a dedicated job (`e2e-real` in
 * `.github/workflows/ci.yml`) with its own backend port, its own
 * frontend port and its own RL data directory, so the default suite
 * stays clean and this run cannot leave a status behind for a later
 * spec.
 *
 * The backend URL comes from the environment because the port is not the
 * same everywhere: a local dev backend runs on :8000, CI runs it on
 * :8011 (see .github/workflows/ci.yml).
 *
 * This test exercises the full backend → frontend pipeline:
 *   1. Fetch /api/v1/rl/capabilities to detect GPU + SB3
 *   2. Trigger real PPO for N steps via /api/v1/rl/train (dry_run=false)
 *   3. Poll /api/v1/rl/status until a NEW run has started — a status
 *      left over from an earlier run must not be able to pass this
 *   4. Wait for that run to finish and assert it really was PPO
 *   5. Screenshot the state for visual review
 */
import { test, expect, request, type APIRequestContext } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'
import { SCREENSHOT_DIR } from './helpers/wait'

/**
 * The real backend's base URL.
 *
 * `E2E_BACKEND_URL` → the CI backend (:8011) or a local one (:8000).
 * The default keeps the local dev workflow unchanged.
 */
const BACKEND_URL = process.env.E2E_BACKEND_URL ?? 'http://localhost:8000'

/**
 * How many env steps the run asks for.
 *
 * `E2E_REAL_STEPS` lets CI pin the number without editing this file.
 * The UI's number input has `min="100"`, so anything below that is
 * meaningless (and would make the input invalid).
 */
const STEPS = Math.max(100, Number(process.env.E2E_REAL_STEPS ?? 200))

/**
 * The device the run should use: 'auto' | 'gpu' | 'cpu'.
 *
 * `E2E_REAL_DEVICE` lets CI pin 'cpu' (the hosted runners have no GPU)
 * so the job is deterministic on any runner image. Unset → pick from
 * what the backend reports.
 */
const REQUESTED_DEVICE = process.env.E2E_REAL_DEVICE ?? 'auto'

/**
 * The opt-in gate. See the file header for why a real run cannot be
 * part of the default suite, and why everything below this line fails
 * instead of skipping.
 */
const REAL_TRAINING_ENABLED = process.env.E2E_REAL_TRAINING === '1'

/**
 * The first call to /api/v1/rl/capabilities imports torch on the
 * backend, which is slow on a cold process — measured at >10 s on the
 * first hit, because the import happens inside the request handler.
 * The old 5 s budget made a cold backend look like a dead one.
 */
const CAPABILITIES_TIMEOUT_MS = 120_000

/** The run must have started (a new status) within this budget. */
const RUN_START_TIMEOUT_MS = 60_000

/**
 * The run must have FINISHED within this budget.
 *
 * Measured on a developer machine (Windows, CPU): a 200-step PPO run
 * reaches its first reward at ~9 s and completes at ~13 s. A hosted
 * runner is slower, so the budget is generous — but it is finite,
 * because "the run never finished" is a real failure, not a hang.
 */
const RUN_FINISH_TIMEOUT_MS = 240_000

/**
 * The shared `playwright.config.ts` allows 60 s per test, which a real
 * PPO run exceeds. The whole test gets its own budget.
 */
const TEST_TIMEOUT_MS = 300_000

/** The subset of the status document this spec reads. */
interface RLStatus {
  running?: boolean
  step?: number
  total_steps?: number
  device?: string
  device_reason?: string
  reason?: string
  started_at_ms?: number
}

/** Read the shared training status. Throws when the endpoint misbehaves. */
const readStatus = async (api: APIRequestContext): Promise<RLStatus> => {
  const r = await api.get('/api/v1/rl/status')
  if (!r.ok()) {
    throw new Error(`GET /api/v1/rl/status returned ${r.status()} on ${BACKEND_URL}`)
  }
  return (await r.json()) as RLStatus
}

test('real PPO training: starts, updates chart, captures GPU/CPU state', async ({ page }) => {
  if (!REAL_TRAINING_ENABLED) {
    test.skip(true, 'Real PPO training is opt-in — run `npm run test:e2e:real`.')
    return
  }
  test.setTimeout(TEST_TIMEOUT_MS)

  // 1. Check capabilities via direct HTTP call (cheaper than routing through
  //    page). From here on nothing may skip: an unreachable backend, a
  //    missing SB3 or a failing run are all failures.
  const api = await request.newContext({ baseURL: BACKEND_URL })
  let capsResp
  try {
    capsResp = await api.get('/api/v1/rl/capabilities', { timeout: CAPABILITIES_TIMEOUT_MS })
  } catch (e) {
    throw new Error(
      `Backend not reachable on ${BACKEND_URL}: ${e instanceof Error ? e.message : String(e)}. ` +
        'A real training run was requested, so this is a failure, not a skip.',
    )
  }
  if (!capsResp.ok()) {
    throw new Error(
      `GET /api/v1/rl/capabilities returned ${capsResp.status()} on ${BACKEND_URL}. ` +
        'A real training run was requested, so this is a failure, not a skip.',
    )
  }
  const caps = await capsResp.json()
  if (!caps.sb3_available) {
    throw new Error(
      'stable-baselines3 is not installed on the backend — the trainer would silently ' +
        'fall back to dry-run (a fabricated reward curve) and the run would prove ' +
        'nothing. Install the backend with the RL extra: pip install -e ".[rl]".',
    )
  }

  // 2. Remember the identity of the run that is on the status document NOW.
  //    Without this a stale status from an earlier run could satisfy every
  //    assertion below — that is not a hypothetical: it is what the first
  //    version of this spec did, and it passed on a status the test itself
  //    had never started.
  const statusBefore = await readStatus(api)
  const previousStartedAtMs = Number(statusBefore.started_at_ms ?? 0)

  // 3. Navigate to /ai-playground (do NOT stub — use real backend)
  await page.goto('/ai-playground')
  await expect(page.locator('[data-testid="start-train-button"]')).toBeVisible()

  // 4. The capabilities note must reflect the backend's state. The note is
  //    rendered before the fetch resolves too ("检测后端能力中…"), so the
  //    placeholder text is what "the page never reached the backend" looks
  //    like — assert it is gone.
  await expect(page.locator('[data-testid="cap-note"]')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-testid="cap-note"]')).not.toContainText('检测后端能力中')
  const capNote = await page.locator('[data-testid="cap-note"]').textContent()
  expect(capNote).toBeTruthy()

  // 5. Set steps to a small number and trigger real (non-dry-run) training
  await page.locator('[data-testid="train-steps-input"]').fill(String(STEPS))
  await page.locator('[data-testid="dry-run-checkbox"]').uncheck()
  // Pick device based on caps, unless the environment pins it (CI pins 'cpu')
  const device =
    REQUESTED_DEVICE === 'auto' ? (caps.cuda_available ? 'gpu' : 'cpu') : REQUESTED_DEVICE
  if (device === 'gpu' && !caps.cuda_available) {
    throw new Error(
      'E2E_REAL_DEVICE=gpu was requested but the backend reports no CUDA device ' +
        `(${caps.device_name || 'unknown'}).`,
    )
  }
  await page.locator('[data-testid="device-select"]').selectOption(device)
  await page.locator('[data-testid="start-train-button"]').click()

  // 6. The click must not have produced an error on the page — that is how
  //    a rejected /rl/train call surfaces.
  await expect(page.locator('[data-testid="train-error"]')).toHaveCount(0)

  // 7. A NEW run must have started. The status document is rewritten by
  //    the trainer process, so a changed `started_at_ms` is the proof that
  //    the browser reached the backend AND that the trainer came up.
  await expect
    .poll(async () => Number((await readStatus(api)).started_at_ms ?? 0), {
      timeout: RUN_START_TIMEOUT_MS,
      intervals: [500],
    })
    .not.toBe(previousStartedAtMs)

  // 8. The real run must actually PROGRESS.
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

  // 9. The page reflects the run — running OR already finished (both
  //    are valid end states for a short run).
  await expect(page.locator('[data-testid="metric-running"]')).toHaveText(/运行中|已结束/, {
    timeout: 15_000,
  })

  // 10. Capture the state for human review.
  //
  //     A *pixel baseline* cannot work here: the page shows the live
  //     step counter and the reward series of an actual PPO run, so
  //     every run produces a different image — comparing it against a
  //     committed PNG can only ever fail (it did: the baseline was
  //     recorded once, on 2026-10-17, and no later run can match it).
  //     The screenshot is written to `e2e-output/current/` for review
  //     instead. The behavioural assertions above are the real gate.
  const reviewPath = path.join(SCREENSHOT_DIR, 'ai-playground-real.png')
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })
  await page.locator('main').screenshot({ path: reviewPath })

  // 11. The UI's own step readout must not be stuck at 0 — this is the
  //     browser's half of the pipeline (the page polls /rl/status every
  //     2 s and renders the counter).
  await expect
    .poll(async () => Number(await page.locator('[data-testid="metric-step"]').textContent()), {
      timeout: 20_000,
    })
    .toBeGreaterThan(0)

  const step = Number(await page.locator('[data-testid="metric-step"]').textContent())

  // 12. The run must COMPLETE, and it must have been a real PPO run.
  //
  //     `reason` is written by `finalize_status`:
  //       'ppo_completed on cpu (2 agents)'  ← a real SB3 run
  //       'dry_run_fallback (…)'            ← SB3 missing: a fabricated
  //                                            curve, i.e. nothing proved
  //       'dry_run_completed'                ← the dry-run request path
  //     Only the first one means the RL engine really ran.
  await expect
    .poll(async () => String((await readStatus(api)).reason ?? ''), {
      timeout: RUN_FINISH_TIMEOUT_MS,
      intervals: [1_000],
    })
    .toMatch(/^ppo_completed/)

  const final = await readStatus(api)
  expect(final.device).not.toBe('dry_run')
  expect(final.total_steps).toBe(STEPS)

  await api.dispose()
  console.log(
    `Real PPO training ${final.reason} — device ${final.device} ` +
      `(${caps.device_name || 'unknown'}), requested ${device}, step=${step}, ` +
      `status step=${final.step}`,
  )
})
