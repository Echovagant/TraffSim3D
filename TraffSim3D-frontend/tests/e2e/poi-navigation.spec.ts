/**
 * Driving to a POI — the browser-side loop.
 *
 * The story this spec tells: a POI is fetched for the map, the driver
 * picks one as the **destination**, the browser routes the scene's
 * first car to the road it stands beside, the first-person camera
 * rides along, and the car **arrives**.
 *
 * The POI fetch is stubbed (the real one is a public Overpass call
 * that takes a minute), but the **route endpoint is not**: a stubbed
 * plan would prove nothing about the real thing — the backend plans
 * over the scene's own directed graph.
 *
 * The scene is the 5×5 **grid**, not the default cross scene: the
 * cross scene's roads carry no waypoints, so its route graph has no
 * intermediate nodes and the arms do not connect (a route there is
 * honestly "not found").
 */
import { test, expect } from '@playwright/test'
import { waitForSceneReady, switchScene } from './helpers/wait'

interface PoiWorld {
  network: {
    origin?: { lat: number; lon: number } | null
    roads: Record<string, { id: string; waypoints?: { x: number; z: number }[] }>
    vehicles: Record<string, { roadId: string; position: { x: number; y: number; z: number } }>
  }
  plannedRoute: { roads: string[]; lengthM: number } | null
  routeFollowerId: string | null
  followCamera: boolean
  poiDestinationId: string | null
  poiDistanceM: number | null
  poiArrived: boolean
}

/**
 * Read ONLY the fields this spec needs.
 *
 * It used to serialise the WHOLE store — and the store holds the
 * trajectory exporter's buffer (up to 100 000 rows), so the cost of a
 * read GREW with every second of driving: measured 4 055 ms after a
 * minute of simulation, against 55 ms for the fields themselves.
 *
 * That is not slow, it is fatal: a `page.evaluate` blocks the page's
 * main thread, so every poll froze the simulation for four seconds —
 * and the car, which has to DRIVE to the POI, never got there. The
 * spec failed for a reason that had nothing to do with navigation.
 */
interface PoiState {
  poiDestinationId: string | null
  poiDistanceM: number | null
  poiArrived: boolean
  plannedRoute: { roads: string[]; lengthM: number } | null
  followCamera: boolean
  routeFollowerId: string | null
}

const world = (page: import('@playwright/test').Page): Promise<PoiState> =>
  page.evaluate(() => {
    const w = (window as unknown as { __world?: PoiWorld }).__world
    return {
      poiDestinationId: w?.poiDestinationId ?? null,
      poiDistanceM: w?.poiDistanceM ?? null,
      poiArrived: w?.poiArrived ?? false,
      plannedRoute: w?.plannedRoute ?? null,
      followCamera: w?.followCamera ?? false,
      routeFollowerId: w?.routeFollowerId ?? null,
    }
  })

/**
 * A POI beside one of the grid's roads.
 *
 * NOT the driver's own road: the planner forbids a route that starts
 * with the road the car is on (that would be a U-turn at the
 * junction it is about to reach), so a POI there sends the car
 * around the block — measured: the journey took **twice** as long.
 */
const poiNextToARoad = async (page: import('@playwright/test').Page) => {
  // The scene has to be LOADED before "a road" means anything. Read
  // too early and the network is still empty: the POI then lands in the
  // middle of nowhere, the planner finds no route, and the test fails
  // with a null destination. That is what happened on the CI runner,
  // where the grid scene takes longer to build than the fixed wait
  // below allowed for.
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const w = (window as unknown as { __world?: PoiWorld }).__world
          return Object.keys(w?.network?.roads ?? {}).length
        }),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0)
  return page.evaluate(() => {
    const w = (window as unknown as { __world: PoiWorld }).__world
    const road = Object.values(w.network.roads)[0]!
    const line = road.waypoints ?? []
    const middle = line[Math.floor(line.length / 2)] ?? { x: 0, z: 0 }
    return { x: middle.x + 5, z: middle.z + 5 }
  })
}

test.describe('Driving to a point of interest', () => {
  // The car really drives: the journey is wall-clock time at the
  // simulation's own pace. Measured: about two minutes from "开过去" to
  // the arrival on a busy grid, so the arrival poll needs more than the
  // suite's default 60 s — and the test itself more than the poll.
  // The journey is a two-minute drive at 4x the sim clock, but the sim
  // clock is not wall time: on a loaded machine the physics stepper
  // drops the time it cannot keep up with, and the journey then takes
  // longer in the real world. The budget is generous on purpose — this
  // test is about the navigation, not about the runner's speed.
  test.setTimeout(660_000)

  test('the car routes to the POI and arrives', async ({ page }) => {
    await waitForSceneReady(page)
    await switchScene(page, 'grid')
    await page.waitForTimeout(1500)

    // The grid is a busy city (67 vehicles): at 1× the drive takes
    // minutes, so the sim runs at 4× — the journey is the same, the
    // waiting is not.
    await page.evaluate(() => {
      const w = (window as unknown as { __world: PoiWorld & { setTickRate?: (r: number) => void } })
        .__world
      w.setTickRate?.(4)
    })

    // A POI belongs to a map: the scene needs a geographic anchor.
    await page.evaluate(() => {
      const w = (window as unknown as { __world: PoiWorld }).__world
      w.network.origin = { lat: 22.54297, lon: 114.06865 }
    })

    const spot = await poiNextToARoad(page)
    await page.route('**/api/v1/maps/poi', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          source: 'osm',
          count: 1,
          pois: [
            {
              id: 'osm-node-1',
              name: '示例咖啡',
              type: 'amenity=cafe',
              typeCode: 'amenity',
              category: '餐饮',
              address: '',
              lon: 114.069,
              lat: 22.543,
              x: spot.x,
              z: spot.z,
            },
          ],
        }),
      })
    })

    await page.click('[data-testid="poi-load-button"]')
    await expect(page.locator('[data-testid="poi-item"]')).toHaveCount(1)
    await page.locator('[data-testid="poi-item"]').first().click()

    // "开过去": the POI becomes the destination.
    await page.click('[data-testid="poi-go-button"]')
    await expect(page.locator('[data-testid="route-hud"]')).toBeVisible()

    // The destination is set by the click, but the ROUTE comes back
    // from the backend — so the state is polled rather than read once
    // (a one-shot read on a slow runner saw the plan before it
    // arrived).
    await expect
      .poll(async () => (await world(page)).poiDestinationId, { timeout: 30_000 })
      .toBe('osm-node-1')
    await expect
      .poll(async () => (await world(page)).plannedRoute, { timeout: 30_000 })
      .not.toBeNull()
    const planned = await world(page)
    expect(planned.plannedRoute!.roads.length).toBeGreaterThan(1)
    expect(planned.plannedRoute!.lengthM).toBeGreaterThan(0)
    // The first-person camera is switched on: choosing a destination
    // is about riding to it.
    expect(planned.followCamera).toBe(true)
    expect(planned.routeFollowerId).toBeTruthy()

    // The instrument panel names the destination and the distance.
    await expect(page.locator('[data-testid="route-hud-destination"]')).toContainText('示例咖啡')
    await expect(page.locator('[data-testid="route-hud-distance"]')).toBeVisible()

    // The car drives there: the distance shrinks.
    await expect
      .poll(async () => (await world(page)).poiDistanceM ?? Infinity, { timeout: 240_000 })
      .toBeLessThan(planned.poiDistanceM ?? Infinity)

    // And it arrives.
    await expect.poll(async () => (await world(page)).poiArrived, { timeout: 600_000 }).toBe(true)
    await expect(page.locator('[data-testid="poi-arrived"]')).toContainText('已到达')
    await expect(page.locator('[data-testid="route-hud-distance"]')).toContainText('已到达')
  })
})

test('a destination behind the driver on its own road turns the car around', async ({ page }) => {
  // The cross scene used to be unusable here: its roads were built as
  // two nodes, so the four arms shared NO node at the junction and the
  // route graph was four disconnected lines. They carry the intersection
  // as a waypoint now, and the planner is asked to allow the U-turn that
  // a destination behind the driver on its own road needs.
  await waitForSceneReady(page)
  await switchScene(page, 'cross')
  await page.waitForTimeout(1500)

  await page.evaluate(() => {
    const w = (window as unknown as { __world: PoiWorld }).__world
    w.network.origin = { lat: 22.54297, lon: 114.06865 }
  })

  // The driver (v-1) starts on the north arm heading for the junction,
  // so a POI further up that arm is BEHIND it.
  await page.route('**/api/v1/maps/poi', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        source: 'osm',
        count: 1,
        pois: [
          {
            id: 'osm-node-1',
            name: '身后咖啡',
            type: 'amenity=cafe',
            typeCode: 'amenity',
            category: '餐饮',
            address: '',
            lon: 114.069,
            lat: 22.543,
            x: 5,
            z: -25,
          },
        ],
      }),
    })
  })

  await page.click('[data-testid="poi-load-button"]')
  await expect(page.locator('[data-testid="poi-item"]')).toHaveCount(1)
  await page.locator('[data-testid="poi-item"]').first().click()
  await page.click('[data-testid="poi-go-button"]')

  await expect(page.locator('[data-testid="route-hud"]')).toBeVisible()
  const planned = await world(page)
  expect(planned.poiDestinationId).toBe('osm-node-1')
  // The route turns the car around: its own road, then that road again
  // — the U-turn at the end of the block.
  expect(planned.plannedRoute!.roads).toHaveLength(3)
  expect(planned.plannedRoute!.roads[0]).toBe(planned.plannedRoute!.roads[1])
  expect(planned.plannedRoute!.roads[2]).toBe(planned.plannedRoute!.roads[0])
})
