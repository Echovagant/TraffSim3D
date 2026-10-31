/**
 * Route planning + the first-person camera.
 *
 * The point of this spec is the **integration**: the browser asks the
 * backend for a route over the scene's network, the car drives the roads
 * the plan names, and the camera can ride along with it.
 *
 * The route endpoint is deliberately NOT stubbed here — a stubbed plan
 * would prove nothing about the real thing. The e2e job runs a real
 * backend, and the endpoint needs no SB3 / torch, so it is available
 * there.
 *
 * What is asserted:
 *   1. a route is planned from the UI, and the plan is a real path
 *      (several roads, a length, a polyline);
 *   2. the follower drives the plan's roads, in the plan's order;
 *   3. the first-person camera sits in the car (eye height) and looks
 *      ahead of it.
 */
import { test, expect } from '@playwright/test'
import { waitForSceneReady, switchScene } from './helpers/wait'

/** The dev-only store hook (Vite tree-shakes it out of production). */
interface RouteWorld {
  network: {
    vehicles: Record<string, { roadId: string; position: { x: number; y: number; z: number } }>
    intersections: Record<string, unknown>
  }
  plannedRoute: { roads: string[]; points: unknown[]; lengthM: number } | null
  routeFollowerId: string | null
  followCamera: boolean
}

const world = (page: import('@playwright/test').Page): Promise<RouteWorld> =>
  page.evaluate(() => (window as unknown as { __world: RouteWorld }).__world)

test.describe('Route planning + the first-person camera', () => {
  test('a car drives the planned route', async ({ page }) => {
    await waitForSceneReady(page)
    await switchScene(page, 'grid')

    // The first vehicle and the last junction of the grid.
    const startVehicle = await page.locator('[data-testid="route-start-vehicle"] option').first()
    const startValue = await startVehicle.getAttribute('value')
    const endValue = await page
      .locator('[data-testid="route-end-junction"] option')
      .last()
      .getAttribute('value')
    expect(startValue).toBeTruthy()
    expect(endValue).toBeTruthy()

    await page.selectOption('[data-testid="route-start-vehicle"]', startValue!)
    await page.selectOption('[data-testid="route-end-junction"]', endValue!)
    await page.click('[data-testid="plan-route-button"]')

    // The plan is real: several roads, a length, a polyline.
    await expect(page.locator('[data-testid="route-hud"]')).toBeVisible()
    const planned = await world(page)
    expect(planned.plannedRoute).not.toBeNull()
    expect(planned.plannedRoute!.roads.length).toBeGreaterThan(1)
    expect(planned.plannedRoute!.lengthM).toBeGreaterThan(0)
    expect(planned.plannedRoute!.points.length).toBeGreaterThan(1)

    // The car follows the plan: the roads it takes are the plan's roads,
    // in the plan's order.
    const seen = await page.evaluate(async () => {
      const w = (window as unknown as { __world: RouteWorld }).__world
      const roads: string[] = []
      let last: string | null = null
      for (let i = 0; i < 60; i++) {
        const v = w.network.vehicles[w.routeFollowerId ?? '']
        if (v && v.roadId !== last) {
          roads.push(v.roadId)
          last = v.roadId
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      return roads
    })
    expect(seen.length).toBeGreaterThan(0)
    const plan = (await world(page)).plannedRoute!.roads
    // Every road the car took is on the plan, and they appear in the
    // plan's order.
    let cursor = -1
    for (const road of seen) {
      const at = plan.indexOf(road, cursor + 1)
      expect(at, `road ${road} is not on the plan ${plan.join(',')}`).toBeGreaterThan(cursor)
      cursor = at
    }
  })

  test('the first-person camera rides in the car', async ({ page }) => {
    await waitForSceneReady(page)
    await switchScene(page, 'grid')

    const startValue = await page
      .locator('[data-testid="route-start-vehicle"] option')
      .first()
      .getAttribute('value')
    await page.selectOption('[data-testid="route-start-vehicle"]', startValue!)
    await page.selectOption(
      '[data-testid="route-end-junction"]',
      (await page
        .locator('[data-testid="route-end-junction"] option')
        .last()
        .getAttribute('value'))!,
    )
    await page.click('[data-testid="plan-route-button"]')
    await expect(page.locator('[data-testid="route-hud"]')).toBeVisible()

    // Before: the orbit camera, high above the scene.
    const before = await page.evaluate(() =>
      (window as unknown as { __camera: () => { position: { y: number } } }).__camera(),
    )
    expect(before.position.y).toBeGreaterThan(5)

    // After: the camera sits in the car, at eye height.
    await page.check('[data-testid="follow-camera-checkbox"]')
    await page.waitForTimeout(800)
    const after = await page.evaluate(() => {
      const w = (window as unknown as { __world: RouteWorld }).__world
      const cam = (
        window as unknown as {
          __camera: () => {
            position: { x: number; y: number; z: number }
            target: { x: number; y: number; z: number }
          }
        }
      ).__camera()
      const v = w.network.vehicles[w.routeFollowerId ?? '']
      return {
        cameraY: cam.position.y,
        targetY: cam.target.y,
        carY: v ? v.position.y : 0,
        carX: v ? v.position.x : 0,
        carZ: v ? v.position.z : 0,
        camX: cam.position.x,
        camZ: cam.position.z,
      }
    })

    // Eye height above the road (1.35 m), not the orbit camera's height.
    expect(after.cameraY).toBeGreaterThan(after.carY + 1.0)
    expect(after.cameraY).toBeLessThan(after.carY + 2.0)
    // The camera is at the car, and it looks ahead of it (14 m).
    expect(Math.hypot(after.camX - after.carX, after.camZ - after.carZ)).toBeLessThan(0.5)
    expect(after.targetY).toBeLessThan(after.cameraY)
  })
})
