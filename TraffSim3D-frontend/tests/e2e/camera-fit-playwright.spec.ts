/**
 * Plan 053 follow-up: camera fit behavior under Playwright.
 *
 * Scenarios covered (all driven by the window.__camera debug hook
 * exposed from useCameraControls.ts in DEV mode):
 *  1. Initial scene (cross) has a camera fit + zoom limits set.
 *  2. Switching scenes changes camera position (fit reruns).
 *  3. Wheel-down moves the camera closer (zoom-in works).
 *  4. Wheel-up moves the camera farther (zoom-out works).
 *  5. Manual fit button restores distance after the user zooms away.
 *  6. Zoom limits scale with network size (a 5km district allows
 *     further zoom-out than a 60m intersection).
 */
import { test, expect, type Page } from '@playwright/test';
import { waitForSceneReady, switchScene, expectSceneScreenshot } from './helpers/wait';

interface CameraState {
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  distance: number;
  minDistance: number;
  maxDistance: number;
}

const getCamera = (page: Page): Promise<CameraState | null> =>
  page.evaluate(() => {
    const w = window as unknown as { __camera?: () => CameraState };
    return w.__camera ? w.__camera() : null;
  });

const settleFit = async (page: Page, ms = 900): Promise<void> => {
  // The fit animation is 600ms + 200ms debounce + RAF; wait a bit
  // longer for OrbitControls damping (0.08) to settle.
  await page.waitForTimeout(ms);
};

/** Simulate a wheel event over the canvas. Three.js OrbitControls
 *  listens to 'wheel' on the canvas element, not the window. */
const wheel = async (page: Page, deltaY: number): Promise<void> => {
  const canvas = page.locator('[data-testid="world-canvas"]');
  await canvas.dispatchEvent('wheel', { deltaY, bubbles: true, cancelable: true });
  // OrbitControls damps over ~10 frames at 60fps; give it 200ms.
  await page.waitForTimeout(250);
};

test('Plan 053 follow-up: initial cross-scene fit + zoom limits', async ({ page }) => {
  await waitForSceneReady(page);
  await settleFit(page);

  const cam = await getCamera(page);
  expect(cam, 'window.__camera must be exposed').not.toBeNull();
  // Cross scene: roads span [-30, +30] in X+Z, diagonal ≈ 85m.
  expect(cam!.distance).toBeGreaterThan(20);
  expect(cam!.distance).toBeLessThan(500);
  // Zoom limits should bracket the current distance.
  expect(cam!.minDistance).toBeLessThanOrEqual(cam!.distance);
  expect(cam!.distance).toBeLessThanOrEqual(cam!.maxDistance);
  // minDistance should let the user zoom in to a single lane (~5m).
  expect(cam!.minDistance).toBeLessThanOrEqual(10);
});

test('Plan 053 follow-up: wheel zooms in toward minDistance', async ({ page }) => {
  await waitForSceneReady(page);
  await settleFit(page);

  const before = await getCamera(page);
  expect(before).not.toBeNull();
  // Scroll DOWN (positive deltaY in browser convention = scroll down
  // = zoom in via OrbitControls).
  for (let i = 0; i < 12; i++) await wheel(page, -100);
  const after = await getCamera(page);
  expect(after).not.toBeNull();
  // Camera distance should have decreased.
  expect(after!.distance).toBeLessThan(before!.distance);
  // Should clamp at minDistance, not go below.
  expect(after!.distance).toBeGreaterThanOrEqual(after!.minDistance - 0.5);
});

test('Plan 053 follow-up: wheel zooms out toward maxDistance', async ({ page }) => {
  await waitForSceneReady(page);
  await settleFit(page);

  const before = await getCamera(page);
  expect(before).not.toBeNull();
  // Scroll UP (negative deltaY = zoom out).
  for (let i = 0; i < 12; i++) await wheel(page, 100);
  const after = await getCamera(page);
  expect(after).not.toBeNull();
  expect(after!.distance).toBeGreaterThan(before!.distance);
  // Clamp at maxDistance.
  expect(after!.distance).toBeLessThanOrEqual(after!.maxDistance + 0.5);
});

test('Plan 053 follow-up: fit button restores frame after manual zoom', async ({ page }) => {
  await waitForSceneReady(page);
  await settleFit(page);
  const initial = await getCamera(page);
  expect(initial).not.toBeNull();

  // Zoom way out, then click the fit button.
  for (let i = 0; i < 20; i++) await wheel(page, 100);
  const lost = await getCamera(page);
  expect(lost!.distance).toBeGreaterThan(initial!.distance * 2);

  await page.locator('[data-testid="fit-scene-button"]').click();
  // The button bumps fitRequestTick → WorldCanvas 200ms debounce →
  // 600ms animation → OrbitControls damping. 3.5s is plenty.
  await settleFit(page, 3500);
  const recovered = await getCamera(page);
  expect(recovered).not.toBeNull();
  // The fit math is purely a function of network bounds + aspect, so
  // both fits should produce the same distance. Allow 10% slop for
  // any RAF jitter on the final frame.
  const ratio = Math.abs(recovered!.distance - initial!.distance) / initial!.distance;
  expect(ratio, `initial=${initial!.distance.toFixed(1)}, recovered=${recovered!.distance.toFixed(1)}`).toBeLessThan(0.10);
});

test('Plan 053 follow-up: scene switch reruns fit', async ({ page }) => {
  await waitForSceneReady(page);
  await settleFit(page);
  const cross = await getCamera(page);
  expect(cross).not.toBeNull();

  // Loop is a 120×120 rectangular road — noticeably larger than the
  // 60×60 cross scene, so the fit distance increases. We use loop
  // (not corridor) because corridor and cross happen to share the
  // same bbox (both are 60×60).
  await switchScene(page, 'loop');
  await settleFit(page);
  const loop = await getCamera(page);
  expect(loop).not.toBeNull();
  expect(loop!.distance, `cross=${cross!.distance}, loop=${loop!.distance}`).toBeGreaterThan(cross!.distance * 1.5);
  await expectSceneScreenshot(page, 'camera-fit-loop.png');
});

test('Plan 053 follow-up: zoom limits scale with scene size', async ({ page }) => {
  await waitForSceneReady(page);
  await settleFit(page);
  const cross = await getCamera(page);
  expect(cross).not.toBeNull();

  await switchScene(page, 'loop');
  await settleFit(page);
  const loop = await getCamera(page);
  expect(loop).not.toBeNull();
  // Larger scene → larger maxDistance (the user can zoom further out).
  expect(loop!.maxDistance).toBeGreaterThan(cross!.maxDistance);
  // minDistance is clamped to 5m as a sane lower bound (so the user
  // can always dive into a single road regardless of scene size);
  // verify the clamp exists by checking both are >= 5.
  expect(cross!.minDistance).toBeGreaterThanOrEqual(5);
  expect(loop!.minDistance).toBeGreaterThanOrEqual(5);
});

test('Plan 054 follow-up: right-click drag does NOT pan (mouseButtons.RIGHT = null)', async ({ page }) => {
  await waitForSceneReady(page);
  await settleFit(page);
  const before = await getCamera(page);
  expect(before).not.toBeNull();

  // Right-click drag in the canvas. OrbitControls with mouseButtons.RIGHT
  // = null should not pan, so the target should not move.
  const canvas = page.locator('[data-testid="world-canvas"]');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(cx + 150, cy + 100, { steps: 10 });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(400);
  const after = await getCamera(page);
  expect(after).not.toBeNull();
  // Target should NOT have moved (right-click was a no-op for pan).
  expect(
    Math.hypot(after!.target.x - before!.target.x, after!.target.z - before!.target.z),
  ).toBeLessThan(1);
  // Camera position should also not have moved significantly.
  expect(
    Math.hypot(after!.position.x - before!.position.x, after!.position.z - before!.position.z),
  ).toBeLessThan(1);
});