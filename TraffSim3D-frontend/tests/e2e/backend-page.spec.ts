/**
 * Smoke test for the Backend Services page (`/backend`).
 *
 * The page had no e2e coverage at all. It is a diagnostics page: it
 * reads the backend's OpenAPI schema and probes the read-only
 * endpoints. The spec pins that the page renders, that the endpoint
 * list is populated (not an empty shell), and that it never throws.
 *
 * The backend may or may not be reachable — the page is supposed to
 * report that honestly ("在线" / "离线"), so the spec asserts on the
 * *shape* of the page, not on the backend being up.
 */
import { test, expect } from '@playwright/test'

test('Backend: the page loads and lists the discovered endpoints', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))

  await page.goto('/backend')

  await expect(page.locator('main.backend-view')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Backend Services' })).toBeVisible()

  // The status panel always renders — with a verdict, whatever it is.
  await expect(page.locator('.status-panel')).toBeVisible()
  await expect(page.locator('.status-text')).not.toBeEmpty()

  // The endpoint list is populated from the OpenAPI schema (or from the
  // built-in fallback list) — it is never an empty <ul>.
  const endpoints = page.locator('.endpoint-list .endpoint')
  await expect(endpoints.first()).toBeVisible()
  expect(await endpoints.count()).toBeGreaterThan(0)

  // The client-configuration section is part of the page.
  await expect(page.getByRole('heading', { name: '客户端配置' })).toBeVisible()

  expect(pageErrors, `uncaught exceptions: ${pageErrors.join(' | ')}`).toHaveLength(0)
})
