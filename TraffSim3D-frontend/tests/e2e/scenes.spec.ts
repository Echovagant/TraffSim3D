/**
 * Verification: scene switch screenshots.
 * Visual regression: each demo scene is compared against its checked-in
 * baseline in e2e-output/baseline/ (see playwright.config.ts).
 * The 'elevated' scene (高架桥) is covered here too.
 */
import { test } from '@playwright/test'
import { waitForSceneReady, switchScene, expectSceneScreenshot } from './helpers/wait'

test.describe('Scene switch screenshots', () => {
  test('cross intersection scene', async ({ page }) => {
    await waitForSceneReady(page)
    await expectSceneScreenshot(page, 'cross-scene.png')
  })

  test('T junction scene', async ({ page }) => {
    await waitForSceneReady(page)
    await switchScene(page, 't')
    await expectSceneScreenshot(page, 't-scene.png')
  })

  test('rectangular loop scene', async ({ page }) => {
    await waitForSceneReady(page)
    await switchScene(page, 'loop')
    await expectSceneScreenshot(page, 'loop-scene.png')
  })

  test('elevated bridge scene', async ({ page }) => {
    await waitForSceneReady(page)
    await switchScene(page, 'elevated')
    await expectSceneScreenshot(page, 'elevated-scene.png')
  })

  test('multi-intersection corridor scene', async ({ page }) => {
    await waitForSceneReady(page)
    await switchScene(page, 'corridor')
    await expectSceneScreenshot(page, 'corridor-scene.png')
  })
})
