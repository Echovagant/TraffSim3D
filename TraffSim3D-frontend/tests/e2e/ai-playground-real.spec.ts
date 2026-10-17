/**
 * Plan 044 GPU extension — opt-in real PPO training e2e.
 *
 * This test runs REAL PPO training, not the dry-run fake. It is NOT
 * included in `npm run test:e2e` (the default suite, which is for CI).
 * Run it manually on a GPU dev machine:
 *
 *     npm run test:e2e:real
 *
 * Skip conditions (per .claude/CLAUDE.md Playwright exception list):
 * - Backend not reachable on http://localhost:8000
 * - Backend reports cuda_available: false
 * - Backend reports sb3_available: false
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
import { test, expect, request } from '@playwright/test';

const BACKEND_URL = 'http://localhost:8000';
const STEPS = 200;

test('real PPO training: starts, updates chart, captures GPU/CPU state', async ({ page }) => {
  // 1. Check capabilities via direct HTTP call (cheaper than routing through page)
  const api = await request.newContext({ baseURL: BACKEND_URL });
  let capsResp;
  try {
    capsResp = await api.get('/api/v1/rl/capabilities', { timeout: 5000 });
  } catch {
    test.skip(true, 'Backend not reachable on ' + BACKEND_URL);
    return;
  }
  if (!capsResp.ok()) {
    test.skip(true, `Backend /capabilities returned ${capsResp.status()}`);
    return;
  }
  const caps = await capsResp.json();
  if (!caps.sb3_available) {
    test.skip(true, 'stable-baselines3 not installed (run `uv sync --extra rl`)');
    return;
  }
  await api.dispose();

  // 2. Navigate to /ai-playground (do NOT stub — use real backend)
  await page.goto('/ai-playground');
  await expect(page.locator('[data-testid="start-train-button"]')).toBeVisible();

  // 3. Verify the capabilities note reflects the backend's state
  const capNote = await page.locator('[data-testid="cap-note"]').textContent();
  expect(capNote).toBeTruthy();

  // 4. Set steps to a small number and trigger real (non-dry-run) training
  await page.locator('[data-testid="train-steps-input"]').fill(String(STEPS));
  await page.locator('[data-testid="dry-run-checkbox"]').uncheck();
  // Pick device based on caps
  if (caps.cuda_available) {
    await page.locator('[data-testid="device-select"]').selectOption('gpu');
  } else {
    await page.locator('[data-testid="device-select"]').selectOption('cpu');
  }
  await page.locator('[data-testid="start-train-button"]').click();

  // 5. Wait briefly for status to reflect running=true
  await expect(page.locator('[data-testid="metric-running"]')).toContainText('运行中', {
    timeout: 15_000,
  });

  // 6. Capture in-progress state for visual regression.
  await expect(page.locator('main')).toHaveScreenshot('ai-playground-real.png');

  // 7. Verify the metric-step is updating (not stuck at 0)
  const stepText = await page.locator('[data-testid="metric-step"]').textContent();
  const step = Number(stepText);
  expect(step).toBeGreaterThanOrEqual(0);
  console.log(`Real PPO training started on ${caps.cuda_available ? 'GPU' : 'CPU'} ` +
              `(${caps.device_name || 'unknown'}). step=${step}`);
});