/**
 * Verification: trajectory export CSV contains dt column.
 * Let the trajectory exporter accumulate rows, click the "📥 轨迹 CSV" button,
 * download the CSV, and verify the first line contains the dt column.
 */
import { test, expect } from '@playwright/test'
import { waitForSceneReady, SCREENSHOT_DIR } from './helpers/wait'
import { promises as fs } from 'fs'
import * as path from 'path'

test('trajectory export CSV contains dt column', async ({ page }) => {
  await waitForSceneReady(page)
  // Let the trajectory exporter run for 3 seconds at 10Hz → ~30 rows per vehicle
  await page.waitForTimeout(3000)

  // Trigger CSV download (button text: "📥 轨迹 CSV")
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('button', { hasText: '轨迹 CSV' }).click(),
  ])
  const downloadPath = await download.path()
  expect(downloadPath).not.toBeNull()
  const text = await fs.readFile(downloadPath!, 'utf-8')
  // Save a copy for manual review. SCREENSHOT_DIR is resolved against
  // the test file directory (see helpers/wait.ts) so the path is stable
  // regardless of Playwright's CWD.
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
  const outPath = path.join(SCREENSHOT_DIR, 'trajectory.csv')
  await fs.writeFile(outPath, text)
  // Verify the dt column header
  expect(text.split('\n')[0]).toContain('dt')
  // Sanity: at least one data row
  const lines = text.split('\n').filter((l) => l.length > 0)
  expect(lines.length).toBeGreaterThan(1)
})
