/**
 * Plan 042 / Plan 039 verification: elevated road scene.
 *
 * Switch to the elevated scene (level=0 ground cross + ramp + level=1
 * high straight), confirm 4 default vehicles exist, and capture the
 * scene so the elevated bridge + ramp is visible.
 *
 * Note on motion verification: this test does NOT assert v-e3 climbs the
 * ramp by Y delta over time. With 4 vehicles packed at the ground
 * intersection (v-e1 / v-e2 close to v-e3's ramp entry), the truck can
 * stall against cross traffic or get respawned by OOB cleanup, which
 * makes Y-monotonic assertions flaky. The polyline geometry + Pure
 * Pursuit climb is unit-tested in laneGeometry.spec.ts + purePursuit.spec.ts;
 * the visual screenshot here is the integration check.
 */
import { test, expect } from '@playwright/test'
import { waitForSceneReady, switchScene, expectSceneScreenshot } from './helpers/wait'

test('elevated scene: bridge visible + 4 vehicles + v-e3 starts on ramp', async ({ page }) => {
  await waitForSceneReady(page)
  await switchScene(page, 'elevated')

  // Wait until the elevated scene's 4 vehicles are present (v-e1..v-e4).
  await page.waitForFunction(
    () => {
      const w = window as unknown as {
        __world?: { network: { vehicles: Record<string, unknown> } }
      }
      const v = w.__world?.network?.vehicles
      if (!v) return false
      return ['v-e1', 'v-e2', 'v-e3', 'v-e4'].every((id) => id in v)
    },
    undefined,
    { timeout: 10_000 },
  )

  // Visual regression of the elevated bridge from the default camera angle.
  // Distinct name from scenes.spec.ts's `elevated-scene.png`: this test waits
  // for all 4 vehicles before capturing, so the two are different scenes-in-time.
  await expectSceneScreenshot(page, 'elevated-ramp-scene.png')

  // Verify v-e3 is on the ramp road with Y between 1 and 3 (mid-ramp).
  const v3 = await page.evaluate(() => {
    const w = window as unknown as {
      __world?: {
        network: {
          vehicles: Record<
            string,
            { position: { x: number; y: number; z: number }; roadId: string; s: number }
          >
        }
      }
    }
    const v = w.__world?.network?.vehicles?.['v-e3']
    return v ? { y: v.position.y, roadId: v.roadId, s: v.s } : null
  })

  expect(v3).not.toBeNull()
  expect(v3!.roadId).toBe('r-ramp')
  expect(v3!.y).toBeGreaterThan(1)
  expect(v3!.y).toBeLessThan(3)

  // Verify r-ew-high is at level=1 (tagged elevated)
  const level = await page.evaluate(() => {
    const w = window as unknown as {
      __world?: { network: { roads: Record<string, { level: number }> } }
    }
    return w.__world?.network?.roads?.['r-ew-high']?.level
  })
  expect(level).toBe(1)

  // After a few seconds, capture a "running" screenshot for visual review.
  await page.waitForTimeout(3000)
  await expectSceneScreenshot(page, 'elevated-after-3s.png')
})
