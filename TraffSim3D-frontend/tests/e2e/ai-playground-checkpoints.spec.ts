/**
 * Plan 045 / Plan 042 verification: AI Playground with checkpoint list.
 *
 * Stubs /api/v1/rl/checkpoints with a fake list, clicks "列出 checkpoints"
 * button, verifies the list renders, and screenshots baseline.
 */
import { test, expect } from '@playwright/test';
import { waitForSceneReady } from './helpers/wait';

// Sorted by mtime desc to match backend's list_checkpoints() ordering.
const FAKE_CHECKPOINTS = {
  checkpoints: [
    { name: 'ppo_step_0005000.zip', process: 'pid5678', size_kb: 25.4, mtime_ms: Date.now() - 5_000 },
    { name: 'ppo_step_0003000.zip', process: 'pid1234', size_kb: 25.1, mtime_ms: Date.now() - 30_000 },
    { name: 'ppo_step_0000500.zip', process: 'pid1234', size_kb: 24.3, mtime_ms: Date.now() - 60_000 },
  ],
};

test('AI Playground: checkpoint list renders after clicking button', async ({ page }) => {
  // Stub /api/v1/rl/checkpoints
  await page.route('**/api/v1/rl/checkpoints', async (route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(FAKE_CHECKPOINTS),
    });
  });
  // Stub the other RL endpoints defensively
  await page.route('**/api/v1/rl/status', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"running":false,"step":0,"episode_count":0,"last_reward":0,"reward_history":[],"started_at_ms":0,"finished_at_ms":null,"latest_checkpoint":""}' });
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
  await page.route('**/api/v1/rl/train', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"dry_run":true}' });
  });

  await page.goto('/ai-playground');
  await expect(page.locator('[data-testid="list-checkpoints-button"]')).toBeVisible();

  // Click the button to load the list
  await page.locator('[data-testid="list-checkpoints-button"]').click();

  // Verify the list renders with 3 items
  const items = page.locator('[data-testid="ckpt-list"] li');
  await expect(items).toHaveCount(3);

  // First item should be the newest (ppo_step_0005000.zip)
  await expect(page.locator('[data-testid="ckpt-name"]').first()).toHaveText('ppo_step_0005000.zip');

  // Visual regression on the populated checkpoint list.
  await expect(page.locator('main')).toHaveScreenshot('ai-playground-checkpoints.png');
});