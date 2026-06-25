/**
 * Plan 042: batch screenshot run — captures all three M2-closing scenes
 * in a single test for fast review.
 */
import { test } from '@playwright/test';
import { waitForSceneReady, switchScene, SCREENSHOT_DIR } from './helpers/wait';

test('batch: all M2-closing scenes in one run', async ({ page }) => {
  for (const kind of ['cross', 't', 'loop'] as const) {
    await waitForSceneReady(page);
    await switchScene(page, kind);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/scene-${kind}.png`, fullPage: false });
  }
});
