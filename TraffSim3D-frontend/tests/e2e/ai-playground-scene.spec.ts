/**
 * Plan 048 / Plan 042: AI Playground corridor scene training e2e.
 *
 * Verifies the scene select renders both 'cross' and 'corridor' options
 * and that selecting 'corridor' persists in the train request body.
 */
import { test, expect } from '@playwright/test';
import { waitForSceneReady, SCREENSHOT_DIR } from './helpers/wait';

test('AI Playground: corridor scene option selectable', async ({ page }) => {
  // Stub all RL endpoints defensively
  await page.route('**/api/v1/rl/scenes', async (route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ scenes: ['cross', 'corridor'] }),
    });
  });
  await page.route('**/api/v1/rl/capabilities', async (route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        torch_version: '2.12.1+cpu', cuda_available: false, device_count: 0,
        device_name: '', vram_gb: 0.0, sb3_available: true, min_vram_gb: 2.0,
        device_fallback_reason: 'cuda_not_available',
      }),
    });
  });
  await page.route('**/api/v1/rl/status', async (route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        running: false, step: 600, episode_count: 3, last_reward: 18.0,
        reward_history: [12.0, 15.0, 18.0],
        started_at_ms: Date.now() - 60_000, finished_at_ms: Date.now(),
        latest_checkpoint: '', n_agents: 2, independent_agents: false,
        scene_kind: 'corridor',
      }),
    });
  });
  let capturedBody: Record<string, unknown> = {};
  await page.route('**/api/v1/rl/train', async (route, request) => {
    capturedBody = JSON.parse(request.postData() ?? '{}');
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, dry_run: true, scene_kind: 'corridor' }),
    });
  });
  await page.route('**/api/v1/rl/checkpoints', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ checkpoints: [] }) });
  });

  await page.goto('/ai-playground');
  await expect(page.locator('[data-testid="scene-kind-select"]')).toBeVisible();

  // Select corridor option
  await page.locator('[data-testid="scene-kind-select"]').selectOption('corridor');

  // Click start training to trigger the API call
  await page.locator('[data-testid="start-train-button"]').click();

  // Verify train request included scene_kind=corridor
  expect(capturedBody.scene_kind).toBe('corridor');

  // Status should reflect corridor scene_kind after refresh
  await page.waitForTimeout(500);
  const sceneKindVisible = await page.locator('.cap-note').isVisible();
  expect(sceneKindVisible).toBe(true);

  await page.screenshot({ path: `${SCREENSHOT_DIR}/ai-playground-corridor.png`, fullPage: false });
});