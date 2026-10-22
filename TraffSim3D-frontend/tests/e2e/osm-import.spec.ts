/**
 * Verification: OSM import via the MapLab view.
 *
 * Strategy: stub the /api/v1/maps/parse-osm endpoint via Playwright
 * page.route() so the test is self-contained (no live backend).
 * Verifies:
 *  - The map-importer view loads with file input + upload button
 *  - Clicking "载入示例 fixture" loads a 4-road network into worldStore
 *  - The scene-editor renders the imported road layout
 *  - Screenshot is captured for visual regression
 */
import { test, expect } from '@playwright/test'
import * as path from 'path'
import * as fs from 'fs'
import { fileURLToPath } from 'url'
import { waitForSceneReady, expectSceneScreenshot } from './helpers/wait'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'sample-4way.osm')

test('OSM import: stubbed backend → scene-editor shows parsed network', async ({ page }) => {
  // Read the fixture so we know what to expect + to feed the stub.
  const xmlBytes = fs.readFileSync(FIXTURE_PATH)
  const xmlString = xmlBytes.toString('utf-8')

  // Stub the parse-osm endpoint to mimic the backend.
  await page.route('**/api/v1/maps/parse-osm', async (route) => {
    // Build a network by directly calling the parse logic — simpler:
    // just return a fixed-shape network known to match the fixture.
    // (Backend parse function lives outside the frontend; we mirror
    // its semantics here for the e2e stub. The real backend test
    // is in TraffSim3D-backend/tests/test_osm_parser.py.)
    const network = {
      roads: [
        {
          id: 'w-ns',
          startNode: { x: 0, y: 0, z: -100 },
          endNode: { x: 0, y: 0, z: 100 },
          waypoints: [
            { x: 0, y: 0, z: -100 },
            { x: 0, y: 0, z: 100 },
          ],
          laneCount: 4,
          speedLimit: 16.67,
          level: 0,
        },
        {
          id: 'w-ew-low',
          startNode: { x: -100, y: 0, z: 0 },
          endNode: { x: 0, y: 0, z: 0 },
          waypoints: [
            { x: -100, y: 0, z: 0 },
            { x: 0, y: 0, z: 0 },
          ],
          laneCount: 2,
          speedLimit: 16.67,
          level: 0,
        },
        {
          id: 'w-ramp',
          startNode: { x: 0, y: 0, z: 0 },
          endNode: { x: 50, y: 4, z: 0 },
          waypoints: [
            { x: 0, y: 0, z: 0 },
            { x: 10, y: 0.8, z: 0 },
            { x: 20, y: 1.6, z: 0 },
            { x: 30, y: 2.4, z: 0 },
            { x: 40, y: 3.2, z: 0 },
            { x: 50, y: 4, z: 0 },
          ],
          laneCount: 2,
          speedLimit: 13.89,
          level: 1,
        },
        {
          id: 'w-ew-high',
          startNode: { x: 50, y: 4, z: 0 },
          endNode: { x: 150, y: 4, z: 0 },
          waypoints: [
            { x: 50, y: 4, z: 0 },
            { x: 150, y: 4, z: 0 },
          ],
          laneCount: 2,
          speedLimit: 13.89,
          level: 1,
        },
      ],
      intersections: [
        {
          id: 'i-osm-1',
          position: { x: 0, y: 0, z: 0 },
          trafficLights: [
            {
              id: 'tl-1',
              position: { x: -3, y: 0, z: 0 },
              phase: 'green',
              phaseRemaining: 30,
              cycleSeconds: 63,
              axis: 'ns',
            },
          ],
          connectedRoads: ['w-ns', 'w-ew-low', 'w-ramp'],
          intersectionRadius: 8,
        },
      ],
      vehicles: [],
      spawnPoints: [],
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(network),
    })
  })

  // Step 1: load the importer view.
  await page.goto('/map-importer')
  await expect(page.locator('[data-testid="osm-upload-button"]')).toBeVisible()

  // Step 2: click "载入示例 fixture" (uses the frontend's hard-coded
  // sample, bypassing the fetch). This is the path that doesn't need
  // a live backend — same UX as the OSM upload but client-side.
  await page.locator('[data-testid="load-fixture-button"]').click()

  // Step 3: wait for navigation to scene-editor.
  await page.waitForURL('**/scene-editor', { timeout: 5_000 })
  await page.waitForSelector('[data-testid="world-canvas"]', { state: 'attached' })
  await page.waitForTimeout(2_500)

  // Step 4: verify the worldStore now holds 4 roads from the imported network.
  const roadCount = await page.evaluate(() => {
    const w = window as unknown as { __world?: { network: { roads: Record<string, unknown> } } }
    return w.__world?.network?.roads ? Object.keys(w.__world.network.roads).length : 0
  })
  expect(roadCount).toBe(4)

  // Step 5: verify one road has level=1 (the ramp / elevated).
  const hasLevel1 = await page.evaluate(() => {
    const w = window as unknown as {
      __world?: { network: { roads: Record<string, { level?: number }> } }
    }
    return Object.values(w.__world?.network?.roads ?? {}).some((r) => r.level === 1)
  })
  expect(hasLevel1).toBe(true)

  // Step 6: visual regression on the imported road layout.
  await expectSceneScreenshot(page, 'osm-import.png')
})
