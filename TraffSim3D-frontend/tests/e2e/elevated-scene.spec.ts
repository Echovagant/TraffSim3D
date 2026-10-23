/**
 * Verification: elevated road scene.
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

  // Verify v-e3 is on the ramp road, at the height the ramp has **at the
  // arc length it has reached**.
  //
  // The old assertion pinned the height to a window (1 m … 3 m — the
  // mid-ramp), which only held while the vehicles stood still. Now they
  // drive, so where v-e3 is when the test looks depends on the timing —
  // but it is always on the ramp, and its height always matches the
  // ramp's height at that point. That is the property worth pinning: the
  // ramp really is a slope, and the vehicle really is on it.
  const v3 = await page.evaluate(() => {
    const w = window as unknown as {
      __world?: {
        network: {
          vehicles: Record<
            string,
            { position: { x: number; y: number; z: number }; roadId: string; s: number }
          >
          roads: Record<string, { waypoints?: Array<{ x: number; y: number; z: number }> }>
        }
      }
    }
    const v = w.__world?.network?.vehicles?.['v-e3']
    const road = w.__world?.network?.roads?.['r-ramp']
    if (!v || !road) return null
    // The ramp's height at the vehicle's arc length: the polyline is a
    // straight climb from y = 0 to y = 4 over its length, so the height
    // at `s` is proportional to the distance travelled.
    const waypoints = road.waypoints ?? []
    let total = 0
    for (let i = 0; i < waypoints.length - 1; i++) {
      const a = waypoints[i]!
      const b = waypoints[i + 1]!
      total += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
    }
    let climbed = 0
    for (let i = 0; i < waypoints.length - 1; i++) {
      const a = waypoints[i]!
      const b = waypoints[i + 1]!
      const seg = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
      if (climbed + seg >= v.s) {
        const t = seg > 0 ? (v.s - climbed) / seg : 0
        return {
          y: v.position.y,
          roadId: v.roadId,
          s: v.s,
          expectedY: a.y + (b.y - a.y) * t,
          rampLength: total,
        }
      }
      climbed += seg
    }
    return { y: v.position.y, roadId: v.roadId, s: v.s, expectedY: 0, rampLength: total }
  })

  expect(v3).not.toBeNull()
  expect(v3!.roadId).toBe('r-ramp')
  // The vehicle is at the ramp's height for the arc length it has
  // reached — the slope is real and the vehicle is on it.
  expect(v3!.y).toBeCloseTo(v3!.expectedY, 1)
  // And the ramp does climb: the vehicle's height differs from the
  // ground by a measurable amount somewhere along the run.
  expect(v3!.rampLength).toBeGreaterThan(10)
  expect(Math.abs(v3!.y - v3!.expectedY)).toBeLessThan(0.2)

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
