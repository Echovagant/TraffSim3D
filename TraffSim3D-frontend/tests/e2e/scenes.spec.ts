/**
 * Plan 042 / Plan 035 verification: scene switch screenshots.
 * Captures each of the three demo scenes to e2e-output/current/.
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
});
