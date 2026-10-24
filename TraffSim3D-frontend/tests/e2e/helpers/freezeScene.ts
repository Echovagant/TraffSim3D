// tests/e2e/helpers/freezeScene.ts
//
// A scene capture has to be a FROZEN frame — `helpers/wait.ts`
// (`pauseSimulation`) documents why: the vehicles move, so a live frame
// drifts by ~1 % between runs, which is above the 0.5 % tolerance.
//
// `pauseSimulation(page)` cannot be used for that on any scene other
// than the cross one: it calls `window.__world.reset()`, and
// `worldStore.reset()` rebuilds `buildCrossIntersectionNetwork()`
// **unconditionally** — so the reset swaps the scene for the cross
// scene, and the capture ends up showing the cross intersection under
// the other scene's name. (The committed `corridor-scene-topology.png`
// and `scene-corridor.png` baselines are exactly that: a cross scene.)
//
// The store's own API has everything a scene capture needs:
//
//   - `isRunning = false` stops the fixed-step scheduler, so nothing
//     moves any more;
//   - `switchScene(kind)` rebuilds the scene from its factory, which
//     puts every vehicle back at the position the scene author wrote
//     down.
//
// So pausing BEFORE the switch yields the scene's **authored** frame,
// and that frame is the same on every run — which is what a committed
// baseline needs.

import type { Page } from '@playwright/test'
import { pauseSimulation, switchScene, waitForCameraIdle } from './wait'

export type SceneKind = 'cross' | 't' | 'loop' | 'elevated' | 'corridor' | 'grid'

/**
 * Stop the simulation.
 *
 * `window.__world` is the dev-only Pinia store (Vite tree-shakes the
 * hook out of production builds) and Pinia unwraps refs on the store
 * proxy, so assigning `isRunning` freezes the fixed-step scheduler.
 */
export const pauseSim = async (page: Page): Promise<void> => {
  // `resetFirst: false` — this helper rebuilds the scene itself, right
  // after the pause, so it must not also reset here.
  await pauseSimulation(page, { resetFirst: false })
}

/**
 * Freeze the scene at its authored frame and wait for the camera to
 * settle.
 *
 * The camera auto-fit is animated on its own RAF (not by the
 * simulation), so it still runs while the sim is frozen — and
 * `waitForCameraIdle` is what makes sure the capture happens after it
 * came to rest, instead of after a guessed delay.
 */
export const freezeScene = async (page: Page, kind: SceneKind): Promise<void> => {
  await pauseSim(page)
  await switchScene(page, kind)
  await waitForCameraIdle(page)
}

/**
 * Advance the frozen simulation by a fixed number of fixed steps.
 *
 * The point is determinism: "let it run for 3 seconds" means 3 seconds
 * of **wall clock**, which depends on the machine's frame rate — two
 * runs of the same spec then capture two different frames. Stepping
 * the simulation by a fixed count means 3 seconds of **simulation**
 * time, so the frame is the same on every run.
 *
 * `window.__world.step(dt)` is the store's own fixed-step entry point;
 * the renderer does not call it while the sim is paused, so nothing
 * else advances the world while this runs.
 */
export const advanceSimulation = async (page: Page, steps: number): Promise<void> => {
  await page.evaluate((n) => {
    const w = window as unknown as { __world?: { step?: (dt: number) => number } }
    if (w.__world?.step) {
      for (let i = 0; i < n; i++) w.__world.step(1 / 60)
    }
  }, steps)
  // Let the renderer pick the new poses up.
  await page.waitForTimeout(300)
}
