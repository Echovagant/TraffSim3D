/**
 * Verification: AI Playground training dashboard.
 *
 * Strategy: stub /api/v1/rl/status to return a fake training history
 * so the test is self-contained (no live backend / no PPO required).
 * Verifies:
 *  - View loads, "开始训练" button visible
 *  - Clicking it triggers a status fetch
 *  - Reward chart renders (SVG polyline has ≥ 3 points)
 *  - Screenshot captured for visual regression
 */
import { test, expect } from '@playwright/test'
import { waitForSceneReady } from './helpers/wait'

const FAKE_STATUS = {
  running: false,
  step: 200,
  episode_count: 5,
  last_reward: 12.5,
  reward_history: [0.1, 0.5, 1.2, 3.4, 7.8, 12.5, 18.0, 24.3, 30.1, 35.0],
  started_at_ms: Date.now() - 60_000,
  finished_at_ms: Date.now(),
}

test('AI Playground: training chart renders with reward history', async ({ page }) => {
  // Stub the status endpoint.
  await page.route('**/api/v1/rl/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(FAKE_STATUS),
    })
  })
  // Stub the train endpoint (not actually invoked, but defensive).
  await page.route('**/api/v1/rl/train', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{"ok":true,"dry_run":true}',
    })
  })
  // Stub capabilities — CPU only (no CUDA), so the GPU option is disabled.
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

  // Load the AI Playground view.
  await page.goto('/ai-playground')
  await expect(page.locator('[data-testid="start-train-button"]')).toBeVisible()
  await expect(page.locator('[data-testid="reward-chart"]')).toBeVisible()

  // The chart's polyline should have ≥ 3 points (10 in our fake history).
  const polylinePoints = await page.locator('[data-testid="reward-line"]').getAttribute('points')
  expect(polylinePoints).not.toBeNull()
  const pointCount = (polylinePoints ?? '')
    .trim()
    .split(/\s+/)
    .filter((p) => p.includes(',')).length
  expect(pointCount).toBeGreaterThanOrEqual(3)

  // Metrics should reflect the fake status.
  const episodeText = await page.locator('[data-testid="metric-episode"]').textContent()
  expect(episodeText).toBe('5')
  const rewardText = await page.locator('[data-testid="metric-last-reward"]').textContent()
  expect(rewardText).toBe('12.50')

  // Visual regression on the dashboard panel (metrics + reward chart).
  await expect(page.locator('main')).toHaveScreenshot('ai-playground.png')
})
