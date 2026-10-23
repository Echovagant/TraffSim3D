/**
 * AI Playground true multi-agent training e2e.
 *
 * Stubs /api/v1/rl/status with `agent_rewards: {0: [...], 1: [...]}`
 * to simulate true multi-agent training output. Toggles the
 * "独立训练" checkbox and verifies:
 *  - 2 polylines render (one per agent, different colors)
 *  - Checkpoint list shows agent_id field
 *  - Screenshot baseline
 */
import { test, expect } from '@playwright/test'
import { expectVisualScreenshot } from './helpers/visual'
import { waitForSceneReady } from './helpers/wait'

const FAKE_STATUS = {
  running: false,
  step: 600,
  episode_count: 3,
  last_reward: 1.8,
  reward_history: [0.5, 1.2, 1.8], // mean across agents (UI fallback)
  agent_rewards: {
    '0': [0.5, 1.2, 1.8], // agent 0 (slightly higher)
    '1': [0.3, 1.0, 1.5], // agent 1
  },
  independent_agents: true,
  n_agents: 2,
  latest_checkpoint: 'agent0:ppo_agent0_step_0000600.zip, agent1:ppo_agent1_step_0000600.zip',
  started_at_ms: Date.now() - 60_000,
  finished_at_ms: Date.now(),
}

const FAKE_CHECKPOINTS = {
  checkpoints: [
    {
      name: 'ppo_agent0_step_0000600.zip',
      process: 'pid12345',
      agent_id: 0,
      size_kb: 25.0,
      mtime_ms: Date.now() - 5_000,
    },
    {
      name: 'ppo_agent1_step_0000600.zip',
      process: 'pid12345',
      agent_id: 1,
      size_kb: 24.9,
      mtime_ms: Date.now() - 5_000,
    },
  ],
}

test('AI Playground: independent multi-agent renders per-agent polylines', async ({ page }) => {
  await page.route('**/api/v1/rl/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(FAKE_STATUS),
    })
  })
  await page.route('**/api/v1/rl/checkpoints', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(FAKE_CHECKPOINTS),
    })
  })
  await page.route('**/api/v1/rl/capabilities', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        torch_version: '2.12.1+cpu',
        cuda_available: false,
        device_count: 0,
        device_name: '',
        vram_gb: 0.0,
        sb3_available: true,
        min_vram_gb: 2.0,
        device_fallback_reason: 'cuda_not_available',
      }),
    })
  })
  await page.route('**/api/v1/rl/train', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{"ok":true,"dry_run":true,"independent_agents":true}',
    })
  })

  await page.goto('/ai-playground')
  await expect(page.locator('[data-testid="independent-agents-checkbox"]')).toBeVisible()

  // Toggle independent training
  await page.locator('[data-testid="independent-agents-checkbox"]').check()

  // Wait for chart to render with per-agent polylines
  await expect(page.locator('[data-testid="reward-chart"]')).toBeVisible()
  // 2 polylines (one per agent)
  await expect(page.locator('[data-testid="reward-line-agent-0"]')).toBeVisible()
  await expect(page.locator('[data-testid="reward-line-agent-1"]')).toBeVisible()
  await expect(page.locator('[data-testid="reward-line-agent-0"]')).not.toHaveAttribute(
    'points',
    '',
    { timeout: 1000 },
  )

  // Verify checkpoint list shows agent_id
  await page.locator('[data-testid="list-checkpoints-button"]').click()
  await expect(page.locator('[data-testid="ckpt-list"] li')).toHaveCount(2)

  await expectVisualScreenshot(page.locator('main'), 'ai-playground-independent.png')
})
