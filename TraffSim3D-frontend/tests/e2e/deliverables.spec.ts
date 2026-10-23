/**
 * Smoke test for the DeliveryLab page (`/deliverables`).
 *
 * The page had no e2e coverage at all. It is the directory of the
 * project's deliverables, so the spec pins that it renders, that it
 * states what it is, and that its two links point at real routes.
 */
import { test, expect } from '@playwright/test'

test('Deliverables: the page loads and links to the other modules', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))

  await page.goto('/deliverables')

  await expect(page.locator('main.placeholder-view')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'DeliveryLab' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '本模块做什么' })).toBeVisible()

  // The two links it offers must point at routes that exist.
  const sceneLink = page.getByRole('link', { name: '看 SceneLab demo' })
  await expect(sceneLink).toBeVisible()
  await expect(sceneLink).toHaveAttribute('href', '/scene-editor')

  const backendLink = page.getByRole('link', { name: '检查后端状态' })
  await expect(backendLink).toBeVisible()
  await expect(backendLink).toHaveAttribute('href', '/backend')

  expect(pageErrors, `uncaught exceptions: ${pageErrors.join(' | ')}`).toHaveLength(0)
})
