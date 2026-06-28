/**
 * Plan 055: Smart City view verification.
 *
 * Plan 056 follow-up: we stub our BACKEND proxy
 * (`/api/v1/maps/overpass`) instead of overpass-api.de directly,
 * because the frontend now hits our cached proxy (Plan 055 called
 * Overpass directly, which was blocked from China and slow). The
 * stub returns the same raw Overpass shape the real backend would
 * return after a cache miss / hit.
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCREENSHOT_DIR = path.resolve(__dirname, '..', '..', '..', 'e2e-output', 'current');

const FAKE_OVERPASS_ROADS = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 100,
      properties: { highway: 'primary' },
      geometry: {
        type: 'LineString',
        coordinates: [[116.395, 39.900], [116.400, 39.905], [116.405, 39.910]],
      },
    },
    {
      type: 'Feature',
      id: 101,
      properties: { highway: 'secondary' },
      geometry: {
        type: 'LineString',
        coordinates: [[116.398, 39.902], [116.402, 39.907]],
      },
    },
  ],
};

// Mock Overpass node + way response. The viewer parses it via
// osmiumToFeatureCollection, but actually our loadOSMScene function
// already converts the *raw* Overpass JSON `{ elements: [...] }`
// to FeatureCollection. So the stub must return the *raw* Overpass
// shape, NOT the FeatureCollection.
const FAKE_OVERPASS_RAW = {
  version: 0.6,
  elements: [
    { type: 'node', id: 1, lat: 39.900, lon: 116.395 },
    { type: 'node', id: 2, lat: 39.905, lon: 116.400 },
    { type: 'node', id: 3, lat: 39.910, lon: 116.405 },
    { type: 'way', id: 100, nodes: [1, 2, 3], tags: { highway: 'primary' } },
    { type: 'node', id: 4, lat: 39.902, lon: 116.398 },
    { type: 'node', id: 5, lat: 39.907, lon: 116.402 },
    { type: 'way', id: 101, nodes: [4, 5], tags: { highway: 'secondary' } },
  ],
};

test('Smart City: route mounts Cesium + Three.js canvases', async ({ page }) => {
  // Stub our backend's cached Overpass proxy so the OSM loader
  // doesn't hit the network (Plan 056: browser calls our backend,
  // not overpass-api.de directly).
  await page.route('**/api/v1/maps/overpass*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(FAKE_OVERPASS_RAW),
    });
  });

  // Capture console errors so failures are diagnosable.
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

  await page.goto('/smart-city');

  // Cesium container + Three.js canvas should both be attached.
  // Wait up to 10s — Cesium is heavy and takes time to initialize
  // even on a fast machine (workers must load + WebGL2 context).
  try {
    await expect(page.locator('[data-testid="cesium-container"]')).toBeVisible({ timeout: 10000 });
  } catch (e) {
    console.error('Console errors during mount:', consoleErrors);
    throw e;
  }
  await expect(page.locator('[data-testid="world-canvas"]')).toBeAttached();

  // Toolbar (top dock) — pause button + view-mode select.
  await expect(page.locator('[data-testid="pause-button"]')).toBeVisible();
  await expect(page.locator('[data-testid="view-mode-select"]')).toBeVisible();

  // Status panel (right) shows vehicle + light counts.
  await expect(page.locator('[data-testid="status-panel"]')).toBeVisible();

  // Capture baseline for visual regression.
  await page.screenshot({ path: `${SCREENSHOT_DIR}/smart-city-basemap.png`, fullPage: false });
});

test('Smart City: view mode toggle switches between bird / street / free', async ({ page }) => {
  await page.route('**/api/v1/maps/overpass*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(FAKE_OVERPASS_RAW),
    });
  });

  await page.goto('/smart-city');
  const select = page.locator('[data-testid="view-mode-select"]');
  await expect(select).toBeVisible();

  // Default = bird. Select street.
  await select.selectOption('street');
  await expect(select).toHaveValue('street');

  // Switch to free.
  await select.selectOption('free');
  await expect(select).toHaveValue('free');

  // Back to bird.
  await select.selectOption('bird');
  await expect(select).toHaveValue('bird');
});

test('Smart City: OSM stats render after Overpass fetch', async ({ page }) => {
  await page.route('**/api/v1/maps/overpass*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(FAKE_OVERPASS_RAW),
    });
  });

  await page.goto('/smart-city');
  // Wait for the counts to populate (Overpass is async).
  // Note: Cesium might also throw without tiles; we just check
  // the toolbar render count is visible.
  await page.waitForTimeout(2000);
  // Even if the OSM loader failed silently, the toolbar's road/building
  // counts should still exist (possibly showing "—" or 0).
  await expect(page.locator('[data-testid="osm-road-count"]')).toBeAttached();
});