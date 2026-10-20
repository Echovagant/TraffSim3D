/**
 * Plan 042: batch visual-regression run — captures all M2-closing scenes
 * in a single test for fast review.
 */
import { test } from '@playwright/test'
import { waitForSceneReady, switchScene, expectSceneScreenshot } from './helpers/wait'

test('batch: all M2-closing scenes in one run', async ({ page }) => {
  // Five scenes in one test, and each scene now performs a real pixel
  // comparison rather than just writing a file. At the 30s default this was
  // killed partway through, which left scene-loop / scene-elevated baselines
  // un-recorded at their old dimensions. 180s covers all five comparisons.
  test.setTimeout(180_000)
  for (const kind of ['cross', 't', 'loop', 'elevated', 'corridor'] as const) {
    await waitForSceneReady(page)
    await switchScene(page, kind)
    await expectSceneScreenshot(page, `scene-${kind}.png`)
  }
})
