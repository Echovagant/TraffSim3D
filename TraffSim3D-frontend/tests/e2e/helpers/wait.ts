import { expect, type Page } from '@playwright/test'
import * as path from 'path'
import { fileURLToPath } from 'url'

/** 等待 SceneEditor 路由加载完毕 + WorldCanvas 的 <canvas> 元素挂载。 */
export const waitForSceneReady = async (page: Page): Promise<void> => {
  await page.goto('/scene-editor')
  await page.waitForSelector('[data-testid="world-canvas"]', { state: 'attached' })
  // 给 Three.js + Rapier WASM 初始化一些时间
  await page.waitForTimeout(2000)
}

/** 等车辆数 = count（通过 window.__world 调试钩子）。 */
export const waitForVehicleCount = async (
  page: Page,
  count: number,
  timeoutMs = 10_000,
): Promise<void> => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const n = await page.evaluate(() => {
      const w = window as unknown as {
        __world?: { network: { vehicles: Record<string, unknown> } }
      }
      return w.__world?.network?.vehicles ? Object.keys(w.__world.network.vehicles).length : 0
    })
    if (n === count) return
    await page.waitForTimeout(200)
  }
  throw new Error(`Vehicle count did not reach ${count} within ${timeoutMs}ms`)
}

/** 切到指定场景，并等场景的车辆就位。 */
export const switchScene = async (
  page: Page,
  kind: 'cross' | 't' | 'loop' | 'elevated' | 'corridor',
): Promise<void> => {
  await page.selectOption('[data-testid="scene-kind-select"]', kind)
  await page.waitForTimeout(1500)
}

/** 所有 e2e 截图统一输出到项目根 e2e-output/current/。
 *  用 path.resolve(__dirname, …) 锚定到测试文件目录，避免
 *  Playwright 在不同上下文里相对路径解析不一致。
 *  4 级 ..: helpers/ → e2e/ → tests/ → TraffSim3D-frontend/ → TraffSim3D/。 */
const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const SCREENSHOT_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'e2e-output',
  'current',
)

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
export const SCENE_CLIP = { x: 265, y: 270, width: 700, height: 460 } as const

/**
 * Freeze the simulation so a screenshot captures a static frame.
 *
 * `SCENE_CLIP` deliberately includes vehicles, but vehicles MOVE. A slow
 * first run (cold Vite server, busy machine) captures them at different
 * positions than a fast run, producing ~1% pixel diff — above the 0.5%
 * tolerance — even though nothing regressed. Observed 2026-10-17 on
 * `camera-fit.spec.ts:26`: failed once at ratio 0.01, then passed twice.
 *
 * `window.__world` is the dev-only Pinia store (Vite tree-shakes the hook out
 * of production), and Pinia unwraps refs on the store proxy, so assigning
 * `isRunning` freezes the fixed-step scheduler. Call this BEFORE
 * `expectSceneScreenshot`, and note that the captured frame therefore shows a
 * paused sim — re-record affected baselines after adding this call.
 */
export const pauseSimulation = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    const w = window as unknown as { __world?: { isRunning?: boolean } }
    if (w.__world) w.__world.isRunning = false
  })
  // One more frame so the renderer picks up the frozen state.
  await page.waitForTimeout(150)
}

/**
 * Visual-regression assertion for the 3D scene viewport. Replaces the old
 * `page.screenshot({ path })`, which wrote a PNG nobody ever compared.
 */
export const expectSceneScreenshot = async (page: Page, name: string): Promise<void> => {
  await expect(page).toHaveScreenshot(name, { clip: SCENE_CLIP })
}

/**
 * Block until the camera has stopped moving.
 *
 * Replaces the fixed `waitForTimeout(900)` calls the camera-fit specs used to
 * "give the fit animation time to settle". That number is a guess: the fit
 * animation duration depends on how far the camera has to travel, so on a slow
 * frame 900ms is sometimes not enough. Observed 2026-10-17 as
 * `camera-fit.spec.ts:26` failing once at 1% pixel diff (above the 0.5%
 * tolerance) and passing on both re-runs.
 *
 * This polls the `window.__camera` debug hook and returns once two
 * consecutive samples are within `epsilon` of each other and the sample
 * before that — i.e. the camera is genuinely at rest rather than
 * accidentally caught between frames. `maxWaitMs` is a safety net, not the
 * expected duration.
 */
export const waitForCameraIdle = async (
  page: Page,
  { epsilon = 1e-3, settleSamples = 2, maxWaitMs = 8000, pollMs = 100 } = {},
): Promise<void> => {
  const readCamera = (): Promise<string | null> =>
    page.evaluate(() => {
      const w = window as unknown as { __camera?: () => unknown }
      if (!w.__camera) return null
      const c = w.__camera() as {
        position?: { x: number; y: number; z: number }
        target?: { x: number; y: number; z: number }
      }
      if (!c?.position || !c?.target) return null
      // Round so float noise does not read as movement.
      return `${c.position.x.toFixed(4)},${c.position.y.toFixed(4)},${c.position.z.toFixed(4)}|${c.target.x.toFixed(4)},${c.target.y.toFixed(4)},${c.target.z.toFixed(4)}`
    })

  const isSettled = (a: string, b: string, eps: number): boolean => {
    const pa = a.split(/[|,]/).map(Number)
    const pb = b.split(/[|,]/).map(Number)
    if (pa.length !== pb.length || pa.some(Number.isNaN)) return false
    return pa.every((v, i) => Math.abs(v - pb[i]) <= eps)
  }

  const deadline = Date.now() + maxWaitMs
  let stable = 0
  let previous = await readCamera()

  while (Date.now() < deadline) {
    await page.waitForTimeout(pollMs)
    const current = await readCamera()
    if (current !== null && previous !== null && isSettled(previous, current, epsilon)) {
      stable += 1
      if (stable >= settleSamples) return
    } else {
      stable = 0
    }
    previous = current
  }
  // Exhausting maxWaitMs is not a hard failure: the camera may still be within
  // visual tolerance. The screenshot assertion downstream is the real gate.
}
