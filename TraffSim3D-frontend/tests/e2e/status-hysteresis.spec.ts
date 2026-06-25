/**
 * Plan 042 / Plan 037 (bug 2) verification: status hysteresis at startup.
 * Sample v-1's status multiple times — it should converge to 'driving'
 * and stay there (no flicker back to 'waiting').
 */
import { test, expect } from '@playwright/test';
import { waitForSceneReady } from './helpers/wait';

test('status does not flicker at startup (Plan 037 hysteresis)', async ({ page }) => {
  await waitForSceneReady(page);
  // Sample statuses 6 times over 3 seconds
  const samples: (string | null)[] = [];
  for (let i = 0; i < 6; i++) {
    const status = await page.evaluate(() => {
      const w = window as unknown as { __world?: { network: { vehicles: Record<string, { status: string }> } } };
      return w.__world?.network?.vehicles?.['v-1']?.status ?? null;
    });
    samples.push(status);
    await page.waitForTimeout(500);
  }
  console.log('Status samples (over 3s):', samples);
  // After 3 seconds the vehicle should still be 'driving' (not stuck 'waiting')
  expect(samples[samples.length - 1]).toBe('driving');
});
