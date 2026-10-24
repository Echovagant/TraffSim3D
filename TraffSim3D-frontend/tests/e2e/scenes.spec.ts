/**
 * Verification: scene switch screenshots.
 * Visual regression: each demo scene is compared against its checked-in
 * baseline in e2e-output/baseline/ (see playwright.config.ts).
 * The 'elevated' scene (高架桥) is covered here too.
 */
import { test } from '@playwright/test'
import { waitForSceneReady, expectSceneScreenshot } from './helpers/wait'
import { freezeScene } from './helpers/freezeScene'

test.describe('Scene switch screenshots', () => {
  test('cross intersection scene', async ({ page }) => {
    await waitForSceneReady(page)
    // Frozen, like every other scene capture: a live frame drifts by ~1 %
    // between runs (the vehicles move), which is above the 0.5 % tolerance.
    // The cross scene used to be captured live and was therefore a latent
    // flake — `helpers/wait.ts` records one such failure ("failed once at
    // ratio 0.01, then passed twice"). The freeze is the convention the
    // helper prescribes for every scene screenshot.
    await freezeScene(page, 'cross')
    await expectSceneScreenshot(page, 'cross-scene.png')
  })

  test('T junction scene', async ({ page }) => {
    await waitForSceneReady(page)
    await freezeScene(page, 't')
    await expectSceneScreenshot(page, 't-scene.png')
  })

  test('rectangular loop scene', async ({ page }) => {
    await waitForSceneReady(page)
    // Frozen: the loop scene's corner boxes grew (4 m -> 8.5 m — the
    // rule's clearance now applies to every junction, corners included),
    // so this capture is re-recorded. A live frame drifts by ~1 %
    // between runs (the vehicles move), which is above the 0.5 %
    // tolerance — the freeze is the convention `helpers/wait.ts`
    // prescribes for every scene screenshot.
    await freezeScene(page, 'loop')
    await expectSceneScreenshot(page, 'loop-scene.png')
  })

  test('elevated bridge scene', async ({ page }) => {
    await waitForSceneReady(page)
    // Frozen, for the same reason as the loop scene: the elevated
    // scene's ramp-end junction box grew (7 m -> 11.5 m).
    await freezeScene(page, 'elevated')
    await expectSceneScreenshot(page, 'elevated-scene.png')
  })

  test('multi-intersection corridor scene', async ({ page }) => {
    await waitForSceneReady(page)
    // The corridor's junction box grew (6 m -> 11.5 m: the box has to
    // contain the crossing carriageway), so its stop lines and its
    // vehicles' start positions moved. The capture is **frozen** — the
    // convention `helpers/wait.ts` prescribes for every scene screenshot
    // — because a live frame drifts by ~1 % between runs (the vehicles
    // move), which is above the 0.5 % tolerance.
    await freezeScene(page, 'corridor')
    await expectSceneScreenshot(page, 'corridor-scene.png')
  })
})
