/**
 * Plan 042 / Plan 035 verification: scene switch screenshots.
 * Captures each demo scene to e2e-output/current/.
 * Plan 039 added 'elevated' (高架桥) — covered here too.
 */
import { test, expect } from '@playwright/test';
import { waitForSceneReady, switchScene, SCREENSHOT_DIR } from './helpers/wait';

test.describe('Scene switch screenshots', () => {
  test('cross intersection scene', async ({ page }) => {
    await waitForSceneReady(page);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/cross-scene.png`, fullPage: false });
  });

  test('T junction scene (Plan 035)', async ({ page }) => {
    await waitForSceneReady(page);
    await switchScene(page, 't');
    await page.screenshot({ path: `${SCREENSHOT_DIR}/t-scene.png`, fullPage: false });
  });

  test('rectangular loop scene (Plan 035)', async ({ page }) => {
    await waitForSceneReady(page);
    await switchScene(page, 'loop');
    await page.screenshot({ path: `${SCREENSHOT_DIR}/loop-scene.png`, fullPage: false });
  });

  test('elevated bridge scene (Plan 039)', async ({ page }) => {
    await waitForSceneReady(page);
    await switchScene(page, 'elevated');
    await page.screenshot({ path: `${SCREENSHOT_DIR}/elevated-scene.png`, fullPage: false });
  });

  test('multi-intersection corridor scene (Plan 040)', async ({ page }) => {
    await waitForSceneReady(page);
    await switchScene(page, 'corridor');
    await page.screenshot({ path: `${SCREENSHOT_DIR}/corridor-scene.png`, fullPage: false });
  });
});
