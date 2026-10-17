/**
 * Plan 042 / Plan 035 verification: scene switch screenshots.
 * Visual regression: each demo scene is compared against its checked-in
 * baseline in e2e-output/baseline/ (see playwright.config.ts).
 * Plan 039 added 'elevated' (高架桥) — covered here too.
 */
import { test } from '@playwright/test';
import { waitForSceneReady, switchScene, expectSceneScreenshot } from './helpers/wait';

test.describe('Scene switch screenshots', () => {
  test('cross intersection scene', async ({ page }) => {
    await waitForSceneReady(page);
    await expectSceneScreenshot(page, 'cross-scene.png');
  });

  test('T junction scene (Plan 035)', async ({ page }) => {
    await waitForSceneReady(page);
    await switchScene(page, 't');
    await expectSceneScreenshot(page, 't-scene.png');
  });

  test('rectangular loop scene (Plan 035)', async ({ page }) => {
    await waitForSceneReady(page);
    await switchScene(page, 'loop');
    await expectSceneScreenshot(page, 'loop-scene.png');
  });

  test('elevated bridge scene (Plan 039)', async ({ page }) => {
    await waitForSceneReady(page);
    await switchScene(page, 'elevated');
    await expectSceneScreenshot(page, 'elevated-scene.png');
  });

  test('multi-intersection corridor scene (Plan 040)', async ({ page }) => {
    await waitForSceneReady(page);
    await switchScene(page, 'corridor');
    await expectSceneScreenshot(page, 'corridor-scene.png');
  });
});
