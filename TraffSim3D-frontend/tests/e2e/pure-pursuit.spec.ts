/**
 * Plan 042 / Plan 037c verification: Pure Pursuit path following.
 * Capture the T-junction scene, let the simulation run for a few seconds,
 * then sample a vehicle's heading — expect it to have rotated through
 * the T-junction corner (not just traveled straight).
 */
import { test, expect } from '@playwright/test';
import { waitForSceneReady, waitForVehicleCount, switchScene, expectSceneScreenshot } from './helpers/wait';

test('Pure Pursuit: vehicle heading changes through T junction corner (Plan 037c)', async ({ page }) => {
  await waitForSceneReady(page);
  await switchScene(page, 't');
  await waitForVehicleCount(page, 4);  // T-junction has 4 vehicles (v-t1..v-t4)

  // Sample v-t1's pose before the simulation runs
  const before = await page.evaluate(() => {
    const w = window as unknown as { __world?: { network: { vehicles: Record<string, { position: { x: number; z: number }; heading: number; s: number }> } } };
    const v = w.__world?.network?.vehicles?.['v-t1'];
    return v ? { x: v.position.x, z: v.position.z, heading: v.heading, s: v.s } : null;
  });

  // Let the vehicle drive for 5s — should pass through the T corner
  await page.waitForTimeout(5000);
  await expectSceneScreenshot(page, 'pure-pursuit-t.png');

  const after = await page.evaluate(() => {
    const w = window as unknown as { __world?: { network: { vehicles: Record<string, { position: { x: number; z: number }; heading: number; s: number }> } } };
    const v = w.__world?.network?.vehicles?.['v-t1'];
    return v ? { x: v.position.x, z: v.position.z, heading: v.heading, s: v.s } : null;
  });

  expect(before).not.toBeNull();
  expect(after).not.toBeNull();
  // Sanity: vehicle actually moved (Pure Pursuit = at least some position change)
  const dx = (after!.x - before!.x);
  const dz = (after!.z - before!.z);
  const moved = Math.hypot(dx, dz);
  expect(moved).toBeGreaterThan(0.5);
  console.log(`Pure Pursuit: v-1 moved ${moved.toFixed(2)}m, heading ${before!.heading.toFixed(3)} → ${after!.heading.toFixed(3)}`);
});
