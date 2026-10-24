/**
 * Batch visual-regression run — captures all the built-in scenes
 * in a single test for fast review.
 */
import { test } from '@playwright/test'
import { waitForSceneReady, expectSceneScreenshot } from './helpers/wait'
import { freezeScene } from './helpers/freezeScene'

test('batch: all built-in scenes in one run', async ({ page }) => {
  // Six scenes in one test, and each scene now performs a real pixel
  // comparison rather than just writing a file. At the 30s default this was
  // killed partway through, which left scene-loop / scene-elevated baselines
  // un-recorded at their old dimensions. 180s covers all six comparisons.
  test.setTimeout(180_000)
  for (const kind of ['cross', 't', 'loop', 'elevated', 'corridor', 'grid'] as const) {
    await waitForSceneReady(page)
    // Every scene is captured **frozen** — the convention
    // `helpers/wait.ts` prescribes for every scene screenshot. A live
    // frame drifts by ~1 % between runs (the vehicles move), which is
    // above the 0.5 % tolerance; the cross and the T junction used to
    // be captured live and were therefore a latent flake (the helper
    // records one such failure: "failed once at ratio 0.01, then passed
    // twice").
    //
    // Freezing rebuilds the scene, so the captured frame is the scene as
    // it was **authored** — the same frame on every run.
    await freezeScene(page, kind)
    await expectSceneScreenshot(page, `scene-${kind}.png`)
  }
})
