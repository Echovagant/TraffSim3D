// tests/e2e/helpers/visual.ts
//
// Visual-regression baselines are **platform-bound**.
//
// The PNGs in `e2e-output/baseline/` were recorded on Windows +
// Chromium 1228 (headless, SwiftShader). A Linux runner has a
// different Chromium build and a different font rasterisation, so the
// pixel comparison differs even when nothing regressed — the measured
// tolerance (`maxDiffPixelRatio: 0.005`) is derived from runs on the
// recording platform and must NOT be raised to paper over that.
//
// So the comparison runs **only on the platform the baselines were
// recorded on**. Everywhere else the assertion is skipped with a
// visible annotation, and the *rest* of the test still runs — the
// behaviour assertions are platform-independent and stay in the gate.
//
// This is what lets the CI e2e job be blocking: the visual specs are
// excluded from a Linux runner by construction, instead of failing
// there for a reason nobody can act on. Re-recording the baselines on
// Linux would make them comparable again.
//
// Usage:
//   await expectVisualScreenshot(page.locator('main'), 'home.png')
//   await expectVisualSceneScreenshot(page, 'scene-cross.png')

import { expect, test, type Locator, type Page } from '@playwright/test'

/** The platform the committed baselines were recorded on. */
export const VISUAL_BASELINE_PLATFORM = 'win32'

/** Are the committed baselines usable on the current platform? */
export const visualBaselinesUsable = (): boolean => process.platform === VISUAL_BASELINE_PLATFORM

/**
 * Annotate + skip a visual comparison that cannot be made on this
 * platform. The annotation shows up in the Playwright report, so the
 * skip is visible instead of silent.
 */
const skipVisual = (name: string): void => {
  test.info().annotations.push({
    type: 'visual-baseline-skipped',
    description:
      `${name}: the committed baselines were recorded on ${VISUAL_BASELINE_PLATFORM}; ` +
      `this run is on ${process.platform} — the comparison was skipped, not failed.`,
  })
}

/** `toHaveScreenshot` for an element, guarded by the baseline platform. */
export const expectVisualScreenshot = async (
  locator: Locator,
  name: string,
  options?: Parameters<(typeof expect<Locator>)['toHaveScreenshot']>[1],
): Promise<void> => {
  if (!visualBaselinesUsable()) {
    skipVisual(name)
    return
  }
  await expect(locator).toHaveScreenshot(name, options)
}

/** `toHaveScreenshot` for the frozen scene viewport. */
export const expectVisualSceneScreenshot = async (
  page: Page,
  name: string,
  clip?: { x: number; y: number; width: number; height: number },
): Promise<void> => {
  if (!visualBaselinesUsable()) {
    skipVisual(name)
    return
  }
  await expect(page).toHaveScreenshot(name, clip ? { clip } : undefined)
}
