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

test('SimulationLab (merged into SceneLab): the redirect lands, the drawer runs', async ({
  page,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))

  await page.goto('/simulation-lab')

  // The old route redirects to the scene editor — bookmarks and old
  // links keep working.
  await expect(page).toHaveURL(/\/scene-editor/)

  // The live 3D stage and the readout drawer are both mounted.
  await expect(page.locator('[data-testid="world-canvas"]')).toBeAttached()
  await expect(page.locator('[data-testid="sim-drawer"]')).toBeVisible()

  // The key controls exist (the drawer carries them now).
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
