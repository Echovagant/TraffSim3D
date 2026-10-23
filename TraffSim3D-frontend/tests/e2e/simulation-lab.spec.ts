/**
 * Smoke test for the SimulationLab page (`/simulation-lab`).
 *
 * The page had no e2e coverage at all: a broken route, a broken
 * render loop or an exception in the panel would only show up when a
 * human opened it. This spec pins the three things the page must do:
 * load, mount its live 3D stage, and actually advance the simulation.
 *
 * Deliberately minimal — no screenshots (the visual baselines are
 * platform-bound, see `helpers/visual.ts`) and no dependency on the
 * backend.
 */
import { test, expect } from '@playwright/test'

test('SimulationLab: the page loads, mounts the live stage and advances the tick', async ({
  page,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))

  await page.goto('/simulation-lab')

  // The panel and the live 3D stage are both mounted.
  await expect(page.locator('[data-testid="sim-lab-panel"]')).toBeVisible()
  await expect(page.locator('[data-testid="sim-lab-stage"]')).toBeAttached()
  await expect(page.locator('[data-testid="world-canvas"]')).toBeAttached()

  // The key controls exist.
  await expect(page.locator('[data-testid="scene-select"]')).toBeVisible()
  await expect(page.locator('[data-testid="controller-select"]')).toBeVisible()
  await expect(page.locator('[data-testid="pause-button"]')).toBeVisible()

  // The simulation is really running: the tick counter advances.
  const tick = page.locator('[data-testid="sim-tick"]')
  await expect(tick).toBeVisible()
  const first = Number(await tick.textContent())
  await expect
    .poll(async () => Number(await tick.textContent()), { timeout: 15_000 })
    .toBeGreaterThan(first)

  expect(pageErrors, `uncaught exceptions: ${pageErrors.join(' | ')}`).toHaveLength(0)
})
