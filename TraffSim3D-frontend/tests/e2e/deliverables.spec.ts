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

  // The page is the portfolio view now (2026-11-07): the architecture,
  // the capability matrix, the screen wall and how to run it.
  await expect(page.locator('main.delivery')).toBeVisible()
  await expect(page.getByRole('heading', { name: '架构' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '能力矩阵' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '界面' })).toBeVisible()

  // The screen wall links to every module that has a screen.
  const wall = page.locator('.wall a[href]')
  await expect(wall).toHaveCount(6)
  for (const route of ['/scene-editor', '/smart-city', '/ai-playground', '/backend']) {
    await expect(page.locator(`.wall a[href="${route}"]`)).toBeVisible()
  }

  // The two calls to action must point at routes that exist.
  const sceneLink = page.getByRole('link', { name: '进入 SceneLab' })
  await expect(sceneLink).toBeVisible()
  await expect(sceneLink).toHaveAttribute('href', '/scene-editor')

  const backendLink = page.getByRole('link', { name: '检查后端状态' })
  await expect(backendLink).toBeVisible()
  await expect(backendLink).toHaveAttribute('href', '/backend')

  expect(pageErrors, `uncaught exceptions: ${pageErrors.join(' | ')}`).toHaveLength(0)
})
