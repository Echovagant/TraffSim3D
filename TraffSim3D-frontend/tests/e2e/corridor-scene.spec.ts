/**
 * Plan 040 / Plan 042 verification: multi-intersection corridor scene.
 * Switches to the corridor scene, verifies 6 default vehicles load,
 * and screenshots the visualization.
 */
import { test, expect } from '@playwright/test'
import { waitForSceneReady, switchScene, expectSceneScreenshot } from './helpers/wait'

test('corridor scene: 6 vehicles load on the 2-intersection line graph', async ({ page }) => {
  await waitForSceneReady(page)
  await switchScene(page, 'corridor')

  // Wait for all 6 corridor vehicles (v-c1..v-c6)
  await page.waitForFunction(
    () => {
      const w = window as unknown as {
        __world?: { network: { vehicles: Record<string, unknown> } }
      }
      const v = w.__world?.network?.vehicles
      if (!v) return false
      return ['v-c1', 'v-c2', 'v-c3', 'v-c4', 'v-c5', 'v-c6'].every((id) => id in v)
    },
    undefined,
    { timeout: 10_000 },
  )

  // Verify scene topology
  const topo = await page.evaluate(() => {
    const w = window as unknown as {
      __world?: {
        network: {
          roads: Record<string, unknown>
          intersections: Record<string, { connectedRoads: string[]; trafficLights: unknown[] }>
        }
      }
    }
    return {
      roadCount: Object.keys(w.__world?.network?.roads ?? {}).length,
      intersectionCount: Object.keys(w.__world?.network?.intersections ?? {}).length,
      iNorthConnects: w.__world?.network?.intersections?.['i-north']?.connectedRoads,
      iSouthConnects: w.__world?.network?.intersections?.['i-south']?.connectedRoads,
      northLightCount: w.__world?.network?.intersections?.['i-north']?.trafficLights.length,
    }
  })

  expect(topo.roadCount).toBe(3)
  expect(topo.intersectionCount).toBe(2)
  expect(topo.iNorthConnects).toContain('r-ns-corridor')
  expect(topo.iSouthConnects).toContain('r-ns-corridor')
  expect(topo.northLightCount).toBe(2)

  // Visual regression. Distinct name from scenes.spec.ts's `corridor-scene.png`:
  // this test captures much later (it waits for all 6 vehicles to spawn), so the
  // two captures are different scenes-in-time and must not share one baseline.
  await expectSceneScreenshot(page, 'corridor-scene-topology.png')
})
