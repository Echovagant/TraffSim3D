/**
 * Probe: how many vehicles can each built-in scene actually hold?
 *
 * The M1 gate specifies 20 vehicles, but scene capacity has changed since M1
 * (roads were reworked through M2-M4). This measures the real ceiling per
 * scene so the gate can either target the largest scene honestly or record
 * that no scene reaches 20.
 */
import { test } from '@playwright/test';
import { waitForSceneReady } from './helpers/wait';

const SCENES = ['cross', 't', 'loop', 'elevated', 'corridor'] as const;

test('scene vehicle capacity probe', async ({ page }) => {
  test.setTimeout(240_000);
  await waitForSceneReady(page);

  const results: Record<string, number> = {};
  for (const kind of SCENES) {
    await page.selectOption('[data-testid="scene-kind-select"]', kind);
    await page.waitForTimeout(1_800);
    const cap = await page.evaluate(() => {
      const w = window as unknown as {
        __world?: {
          network: { vehicles: Record<string, unknown> };
          addVehicle: () => void;
        };
      };
      const store = w.__world;
      if (!store) throw new Error('window.__world dev hook missing');
      let guard = 0;
      while (guard++ < 400) {
        const before = Object.keys(store.network.vehicles).length;
        store.addVehicle();
        if (Object.keys(store.network.vehicles).length === before) break;
      }
      return Object.keys(store.network.vehicles).length;
    });
    results[kind] = cap;
     
    console.log(`[capacity] ${kind}: ${cap}`);
  }

  const best = Object.entries(results).sort((a, b) => b[1] - a[1])[0];
   
  console.log(`[capacity] max = ${best![0]} @ ${best![1]} vehicles | all = ${JSON.stringify(results)}`);
});
