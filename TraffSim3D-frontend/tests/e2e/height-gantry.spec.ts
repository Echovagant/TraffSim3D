/**
 * The height gantry — a road's OSM `maxheight`, drawn and enforced.
 *
 * The bundled Shenzhen extract carries real height limits: the 春风隧道
 * tunnel is signed 3.5 m, 梅东三路 4 m, 梅观路 and 沙河西路 5 m. A bus
 * is 3.4 m tall plus 0.2 m of clearance, so it does NOT fit under the
 * tunnel — and the picture says so with a portal whose cross-beam sits
 * AT the limit, with the number on it.
 *
 * The gantry lives in the Cesium layer, so the test drives the same
 * path a user does: put an imported map in the store, walk to the
 * command centre, and look at what was drawn.
 */
import { test, expect } from '@playwright/test'

const TUNNEL_HEIGHT_M = 3.5

test('Smart City: a road with a height limit gets a gantry that names the limit', async ({
  page,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))

  await page.goto('/scene-editor')
  await page.waitForSelector('[data-testid="world-canvas"]', { state: 'attached' })
  await page.waitForTimeout(1500)

  // An imported map: one tunnel (3.5 m) that ENDS at the junction, and
  // one ordinary road through it. The junction is what gives the
  // gantry a mouth to stand at.
  await page.evaluate((heightM) => {
    const w = (
      window as unknown as {
        __world: {
          loadNetwork: (n: unknown, label: string) => void
        }
      }
    ).__world
    const pos = (x: number, z: number) => ({ x, y: 0, z })
    w.loadNetwork(
      {
        origin: { lat: 22.54297, lon: 114.06865 },
        roads: {
          'w-tunnel': {
            id: 'w-tunnel',
            startNode: pos(0, 0),
            endNode: pos(0, 140),
            waypoints: [pos(0, 0), pos(0, 140)],
            laneCount: 2,
            speedLimit: 16.67,
            level: 0,
            oneway: false,
            highway: 'trunk',
            maxHeightM: heightM,
          },
          'w-plain': {
            id: 'w-plain',
            startNode: pos(-120, 0),
            endNode: pos(120, 0),
            waypoints: [pos(-120, 0), pos(120, 0)],
            laneCount: 2,
            speedLimit: 16.67,
            level: 0,
            oneway: false,
            highway: 'trunk',
          },
        },
        intersections: {
          'i-1': {
            id: 'i-1',
            position: pos(0, 0),
            trafficLights: [],
            connectedRoads: ['w-tunnel', 'w-plain'],
            intersectionRadius: 10,
          },
        },
        vehicles: {},
        spawnPoints: {},
      },
      'height gantry',
    )
  }, TUNNEL_HEIGHT_M)

  // The command centre shows the IMPORTED map — it must not replace it
  // with the bundled city (which is what it used to do).
  await page.locator('.showcase-nav a[href="/"]').first().click()
  await page.waitForURL('**/', { timeout: 20_000 })
  // The home page's bands are rendered after its own entrance
  // animation, so the link is not in the DOM the instant the route
  // changes — clicking it straight away is a race.
  const band = page.locator('.feature-band a[href="/smart-city"]').first()
  await band.waitFor({ state: 'attached', timeout: 20_000 })
  await band.click()
  // The route loads the Cesium runtime on demand, and on a COLD dev
  // server (which is what Playwright starts) that chunk is transformed
  // on the spot — the navigation takes noticeably longer than a warm
  // one.
  await page.waitForURL('**/smart-city', { timeout: 90_000 })

  // Wait for the roads to be drawn.
  await page.waitForFunction(
    () => {
      const viewer = (
        window as unknown as {
          __cesium?: {
            dataSources: { length: number; get(i: number): { entities: { values: unknown[] } } }
          }
        }
      ).__cesium
      if (!viewer) return false
      for (let i = 0; i < viewer.dataSources.length; i++) {
        if (viewer.dataSources.get(i).entities.values.length > 0) return true
      }
      return false
    },
    undefined,
    { timeout: 40_000 },
  )

  const drawn = await page.evaluate(() => {
    const viewer = (
      window as unknown as {
        __cesium?: {
          dataSources: {
            length: number
            get(i: number): { entities: { values: Array<Record<string, unknown>> } }
          }
        }
      }
    ).__cesium
    const gantries: string[] = []
    let roads = 0
    if (viewer) {
      for (let i = 0; i < viewer.dataSources.length; i++) {
        const values = viewer.dataSources.get(i).entities.values as Array<{
          properties?: { access?: { getValue?: () => string } }
          label?: { text?: { getValue?: () => string } | string }
        }>
        for (const e of values) {
          const access = e.properties?.access?.getValue?.()
          if (access === 'gantry') {
            const raw = e.label?.text
            const text = typeof raw === 'string' ? raw : ((raw?.getValue?.() as string) ?? '')
            gantries.push(text)
          }
          if (access === 'road') roads++
        }
      }
    }
    return { gantries, roads }
  })

  // The imported map is the one on screen (two roads, not the bundled
  // city's 988).
  expect(drawn.roads).toBe(2)

  // The gantry exists and names the limit.
  expect(drawn.gantries.length).toBeGreaterThan(0)
  expect(drawn.gantries.join(' ')).toContain('3.5 m')

  expect(pageErrors, `uncaught exceptions: ${pageErrors.join(' | ')}`).toHaveLength(0)
})
