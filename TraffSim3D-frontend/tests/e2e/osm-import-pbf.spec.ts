/**
 * OSM PBF import e2e.
 *
 * Stubs POST /api/v1/maps/parse-pbf to return a fake RoadNetwork,
 * uploads a .osm.pbf fixture, and verifies the scene-editor loads
 * with 4+ roads. Screenshots to baseline.
 */
import { test, expect } from '@playwright/test'
import { expectSceneScreenshot, pauseSimulation, waitForCameraIdle } from './helpers/wait'

const FAKE_NETWORK = {
  roads: [
    {
      id: 'w-1',
      startNode: { x: 0, y: 0, z: -50 },
      endNode: { x: 0, y: 0, z: 50 },
      waypoints: [
        { x: 0, y: 0, z: -50 },
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 50 },
      ],
      laneCount: 4,
      speedLimit: 16.67,
      level: 0,
    },
    {
      id: 'w-2',
      startNode: { x: -50, y: 0, z: 0 },
      endNode: { x: 50, y: 0, z: 0 },
      waypoints: [
        { x: -50, y: 0, z: 0 },
        { x: 50, y: 0, z: 0 },
      ],
      laneCount: 4,
      speedLimit: 16.67,
      level: 0,
    },
    {
      id: 'w-3',
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
      laneCount: 4,
      speedLimit: 13.89,
      level: 1,
    },
    {
      id: 'w-4',
      startNode: { x: 50, y: 4, z: 0 },
      endNode: { x: 100, y: 4, z: 0 },
      waypoints: [
        { x: 50, y: 4, z: 0 },
        { x: 100, y: 4, z: 0 },
      ],
      laneCount: 4,
      speedLimit: 13.89,
      level: 1,
    },
  ],
  intersections: [
    {
      id: 'i-1',
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
      connectedRoads: ['w-1', 'w-2', 'w-3'],
      intersectionRadius: 8,
    },
  ],
  vehicles: [],
  spawnPoints: [],
}

test('OSM PBF import: routes to parse-pbf endpoint, loads network', async ({ page }) => {
  let capturedEndpoint = ''
  await page.route('**/api/v1/maps/parse-pbf', async (route, request) => {
    capturedEndpoint = request.url()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(FAKE_NETWORK),
    })
  })
  // XML endpoint should NOT be hit
  await page.route('**/api/v1/maps/parse-osm', async (route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: '{"error":"should not be called"}',
    })
  })

  await page.goto('/map-importer')
  await page
    .locator('[data-testid="osm-file-input"]')
    .setInputFiles('tests/e2e/fixtures/sample-4way.osm.pbf')
  await page.locator('[data-testid="osm-upload-button"]').click()

  // Wait for navigation to scene-editor
  await page.waitForURL('**/scene-editor', { timeout: 10_000 })

  // Verify PBF endpoint was called (not XML)
  expect(capturedEndpoint).toContain('/api/v1/maps/parse-pbf')

  // Verify scene-editor loaded with the network
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __world?: { network: { roads: Record<string, unknown> } } }
      return Object.keys(w.__world?.network?.roads ?? {}).length >= 2
    },
    undefined,
    { timeout: 10_000 },
  )

  // Freeze the scene before the capture: the imported network's
  // vehicles DRIVE, so the pixels depend on when the shot lands (the
  // baseline moved 5 % between runs — measured 2026-11-07). The
  // scene-editor's own screenshot helper pauses the sim for exactly
  // this reason.
  // Two things move under a full suite: the sim (the imported network
  // has no vehicles, but the CAMERA auto-fits to it and the fit
  // animation is still running when the shot lands — measured 2026-11-07:
  // 5 % pixel difference, standalone passes). So: pause the sim, wait
  // for the camera to come to rest, then capture.
  await pauseSimulation(page)
  await waitForCameraIdle(page)
  // The idle check samples every 100 ms and accepts two stable samples;
  // the fit animation can still be ramping up when it is called, so give
  // the frame a moment to settle before the capture.
  await page.waitForTimeout(1200)
  await waitForCameraIdle(page)
  await expectSceneScreenshot(page, 'osm-import-pbf.png', { timeout: 30_000 })
})
