/**
 * Batch visual-regression run — captures all the built-in scenes
 * in a single test for fast review.
 */
import { test } from '@playwright/test'
import {
  waitForSceneReady,
  switchScene,
  expectSceneScreenshot,
  pauseSimulation,
} from './helpers/wait'

test('batch: all built-in scenes in one run', async ({ page }) => {
  // Five scenes in one test, and each scene now performs a real pixel
  // comparison rather than just writing a file. At the 30s default this was
  // killed partway through, which left scene-loop / scene-elevated baselines
  // un-recorded at their old dimensions. 180s covers all five comparisons.
  test.setTimeout(180_000)
  for (const kind of ['cross', 't', 'loop', 'elevated', 'corridor'] as const) {
    await waitForSceneReady(page)
    await switchScene(page, kind)
    // The corridor's junction box grew (6 m -> 11.5 m: the box has to
    // contain the crossing carriageway), so its stop lines and its
    // vehicles' start positions moved. Its capture is **frozen** — the
    // convention `helpers/wait.ts` prescribes for every scene screenshot
    // — because a live frame drifts by ~1 % between runs, which is above
    // the 0.5 % tolerance.
    if (kind === 'corridor') await pauseSimulation(page)
    await expectSceneScreenshot(page, `scene-${kind}.png`)
  }
})
