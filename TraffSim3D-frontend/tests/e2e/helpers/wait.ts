import { expect, type Page } from '@playwright/test';
import * as path from 'path';
import { fileURLToPath } from 'url';

/** 等待 SceneEditor 路由加载完毕 + WorldCanvas 的 <canvas> 元素挂载。 */
export const waitForSceneReady = async (page: Page): Promise<void> => {
  await page.goto('/scene-editor');
  await page.waitForSelector('[data-testid="world-canvas"]', { state: 'attached' });
  // 给 Three.js + Rapier WASM 初始化一些时间
  await page.waitForTimeout(2000);
};

/** 等车辆数 = count（通过 window.__world 调试钩子）。 */
export const waitForVehicleCount = async (
  page: Page,
  count: number,
  timeoutMs = 10_000,
): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const n = await page.evaluate(() => {
      const w = window as unknown as { __world?: { network: { vehicles: Record<string, unknown> } } };
      return w.__world?.network?.vehicles ? Object.keys(w.__world.network.vehicles).length : 0;
    });
    if (n === count) return;
    await page.waitForTimeout(200);
  }
  throw new Error(`Vehicle count did not reach ${count} within ${timeoutMs}ms`);
};

/** 切到指定场景，并等场景的车辆就位。 */
export const switchScene = async (page: Page, kind: 'cross' | 't' | 'loop' | 'elevated' | 'corridor'): Promise<void> => {
  await page.selectOption('[data-testid="scene-kind-select"]', kind);
  await page.waitForTimeout(1500);
};

/** 所有 e2e 截图统一输出到项目根 e2e-output/current/。
 *  用 path.resolve(__dirname, …) 锚定到测试文件目录，避免
 *  Playwright 在不同上下文里相对路径解析不一致。
 *  4 级 ..: helpers/ → e2e/ → tests/ → TraffSim3D-frontend/ → TraffSim3D/。 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SCREENSHOT_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'e2e-output', 'current');

/**
 * A float-free region of the 1280x800 scene-editor viewport.
 *
 * The scene-editor is `position: fixed; inset: 0`, so `[data-testid="world-canvas"]`
 * covers the whole viewport — asserting on it is pixel-identical to a full-page
 * screenshot and therefore drags in every HUD overlay. Those overlays are live
 * counters (fps, frame-time min/max/average, trajectory row count, LiDAR frame
 * count) that advance with wall-clock, so they can never match twice.
 *
 * This rect is sized to exclude every overlay while keeping the road network
 * and the vehicles that are the thing actually worth regression-testing:
 *   - top EditorToolbar        y < 105
 *   - CameraView panel         x > 835 && y < 260
 *   - scene-outline / DebugPanel x < 258
 *   - bottom-centre camera widget y > 750
 */
export const SCENE_CLIP = { x: 265, y: 270, width: 700, height: 460 } as const;

/**
 * Visual-regression assertion for the 3D scene viewport. Replaces the old
 * `page.screenshot({ path })`, which wrote a PNG nobody ever compared.
 */
export const expectSceneScreenshot = async (page: Page, name: string): Promise<void> => {
  await expect(page).toHaveScreenshot(name, { clip: SCENE_CLIP });
};
