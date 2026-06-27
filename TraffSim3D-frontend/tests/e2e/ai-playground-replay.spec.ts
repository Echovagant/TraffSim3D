/**
 * Plan 049: AI Playground — strategy load + replay UI.
 *
 * Stubs:
 *   - /api/v1/rl/checkpoints     → list of fake .zip checkpoints
 *   - /api/v1/rl/checkpoints/{n}/weights → JSON weights (real fixture data)
 *   - other RL endpoints → defensive stubs
 *
 * Verifies:
 *   - Replay section renders
 *   - Selecting a checkpoint + clicking 加载 loads the policy (status shows it)
 *   - Selecting target vehicle + clicking 开始回放 flips status to "运行中"
 *   - Screenshot saved to e2e-output/baseline/ai-playground-replay.png
 */
import { test, expect } from '@playwright/test';
import { SCREENSHOT_DIR } from './helpers/wait';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Load the real mlp-policy-fixture so the weights JSON we stub is
// architecturally valid (obs_dim=13, action_dim=2, hidden_sizes=[64,64]).
const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(
  __dirname,
  '..',
  '..',
  'src',
  'infrastructure',
  'rl',
  'fixtures',
  'mlp-policy-fixture.json',
);
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'));

const FAKE_CHECKPOINTS = {
  checkpoints: [
    {
      name: 'ppo_step_0005000.zip',
      process: 'pid4242',
      agent_id: null,
      size_kb: 32.0,
      mtime_ms: Date.now() - 30_000,
    },
  ],
};

const FAKE_WEIGHTS = {
  name: 'ppo_step_0005000.zip',
  obs_dim: 13,
  action_dim: 2,
  hidden_sizes: [64, 64],
  layers: fixture.weights,
};

const FAKE_STATUS = {
  running: false,
  step: 0,
  episode_count: 0,
  last_reward: 0,
  reward_history: [],
  started_at_ms: 0,
  finished_at_ms: null,
  n_agents: 0,
  independent_agents: false,
  latest_checkpoint: '',
};

const FAKE_CAPS = {
  torch_version: '2.12.1+cpu',
  cuda_available: false,
  device_count: 0,
  device_name: '',
  vram_gb: 0.0,
  sb3_available: true,
  min_vram_gb: 2.0,
  device_fallback_reason: 'cuda_not_available',
};

test('AI Playground: strategy load + replay UI', async ({ page }) => {
  // Stub all RL endpoints.
  await page.route('**/api/v1/rl/checkpoints', async (route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(FAKE_CHECKPOINTS),
    });
  });
  await page.route('**/api/v1/rl/checkpoints/ppo_step_0005000.zip/weights', async (route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(FAKE_WEIGHTS),
    });
  });
  await page.route('**/api/v1/rl/status', async (route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(FAKE_STATUS),
    });
  });
  await page.route('**/api/v1/rl/capabilities', async (route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(FAKE_CAPS),
    });
  });
  await page.route('**/api/v1/rl/train', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"dry_run":true}' });
  });

  await page.goto('/ai-playground');

  // Replay section is visible.
  await expect(page.locator('[data-testid="load-policy-button"]')).toBeVisible();
  await expect(page.locator('[data-testid="start-replay-button"]')).toBeVisible();

  // Initial status: not loaded.
  await expect(page.locator('[data-testid="policy-status"]')).toContainText('未加载');

  // The "Load" button is disabled until a checkpoint is selected.
  await expect(page.locator('[data-testid="load-policy-button"]')).toBeDisabled();

  // Pull up the checkpoint list and select the one we stubbed.
  await page.locator('[data-testid="list-checkpoints-button"]').click();
  await page.selectOption('[data-testid="ckpt-replay-select"]', 'ppo_step_0005000.zip');
  await expect(page.locator('[data-testid="load-policy-button"]')).toBeEnabled();

  // Click 加载 — status flips to "已加载".
  await page.locator('[data-testid="load-policy-button"]').click();
  await expect(page.locator('[data-testid="policy-status"]')).toContainText('已加载');
  await expect(page.locator('[data-testid="policy-status"]')).toContainText('ppo_step_0005000.zip');
  await expect(page.locator('[data-testid="policy-status"]')).toContainText('13 obs / 2 act');

  // Select target vehicle (v-1 is the default).
  await page.selectOption('[data-testid="replay-target-select"]', 'v-1');

  // Click 开始回放 — state flips to "运行中".
  await page.locator('[data-testid="start-replay-button"]').click();
  await expect(page.locator('[data-testid="replay-state"]')).toContainText('运行中');

  // Click 停止 — state flips back.
  await page.locator('[data-testid="stop-replay-button"]').click();
  await expect(page.locator('[data-testid="replay-state"]')).not.toContainText('运行中');

  // Screenshot for visual regression.
  await page.screenshot({ path: `${SCREENSHOT_DIR}/ai-playground-replay.png`, fullPage: false });
});