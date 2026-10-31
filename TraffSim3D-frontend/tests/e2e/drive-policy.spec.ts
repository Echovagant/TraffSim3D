/**
 * The cooperative-driving policy, driving in the browser.
 *
 * The trained policy's weights ship with the frontend (the same file
 * the transfer check pins), the observation builder is pinned to
 * Python's by the observation fixture — this spec is the **behaviour**
 * half: on the unsignalised-junction scene, with RL driving enabled,
 * the three negotiation vehicles actually get through the junction.
 *
 * The scenario is the one the policy was trained on: three drivers on
 * three different arms, one scripted car on the fourth, no lights.
 * "Gets through" means each driver ends on its route's out-road, with
 * nothing crashed — the outcome the training measured (every driver
 * through, a fraction of the baselines' collisions).
 */
import { test, expect } from '@playwright/test'
import { waitForSceneReady, switchScene } from './helpers/wait'

test.describe('the cooperative driving policy', () => {
  test('the negotiation drivers get through the junction', async ({ page }) => {
    await waitForSceneReady(page)
    await switchScene(page, 'junction')

    // The scenario: four vehicles, and the junction has no lights.
    const scene = await page.evaluate(() => {
      const w = (
        window as unknown as {
          __world: {
            network: {
              vehicles: Record<string, { roadId: string }>
              intersections: Record<string, { trafficLights: unknown[] }>
            }
          }
        }
      ).__world
      return {
        vehicles: Object.keys(w.network.vehicles).sort(),
        lights: Object.values(w.network.intersections)[0]!.trafficLights.length,
      }
    })
    expect(scene.vehicles).toEqual(['v-1', 'v-2', 'v-3', 'v-4'])
    expect(scene.lights).toBe(0)

    // The trained policy takes the wheel.
    await page.check('[data-testid="drive-policy-checkbox"]')
    await page.waitForTimeout(500)

    // Fast-forward and watch: each driver must end on its route's
    // out-road, and nothing may crash.
    const outcome = await page.evaluate(async () => {
      const w = (
        window as unknown as {
          __world: {
            network: { vehicles: Record<string, { roadId: string; status: string }> }
          }
        }
      ).__world
      w.tickRate = 4
      for (let i = 0; i < 120; i++) {
        const done = Object.values(w.network.vehicles).every(
          (v) => v.roadId.startsWith('out-') || v.status === 'crashed',
        )
        if (done) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      return Object.fromEntries(
        Object.entries(w.network.vehicles).map(([id, v]) => [
          id,
          { road: v.roadId, status: v.status },
        ]),
      )
    })

    const crashed: string[] = []
    for (const id of ['v-1', 'v-2', 'v-3', 'v-4']) {
      expect(
        outcome[id]!.road.startsWith('out-'),
        `${id} stuck on ${outcome[id]!.road}`,
      ).toBe(true)
      // A driver that reached the boundary stub's end brakes to a stop
      // (the out-of-bounds exit) — `waiting` is the LEGAL terminal
      // state. What must never happen is a crash.
      if (outcome[id]!.status === 'crashed') crashed.push(id)
    }
    expect(crashed, `crashed: ${crashed.join(', ')}`).toEqual([])
  })
})
