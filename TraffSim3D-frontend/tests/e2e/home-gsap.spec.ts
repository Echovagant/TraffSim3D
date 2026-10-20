/**
 * Plan 057: GSAP homepage animations + SmartCity 3D card.
 *
 * Verifies:
 *  - Home page mounts + the GSAP-initialized elements appear
 *    (opacity reaches 1 once entrance animation completes).
 *  - The SmartCity 3D module card is present (added by Plan 055).
 *  - The nav-link-new badge for SmartCity 3D is in the top nav.
 *  - All module cards animate in (visible after a short delay).
 */
import { test, expect, type Page } from '@playwright/test'

/**
 * Wait until the Home page's GSAP entrance animations have fully settled.
 *
 * The module cards animate in via
 *   gsap.from('.module-card', { autoAlpha: 0, y: 32, duration: 0.55, stagger: 0.1,
 *     scrollTrigger: { trigger: '.gsap-module-grid', start: 'top 82%', once: true } })
 *
 * so the LAST card only finishes ~1.15s after the ScrollTrigger fires — and
 * that trigger fires on *scroll position*, not on a timer. `toHaveScreenshot`'s
 * `animations: 'disabled'` only freezes CSS animations/transitions; it does
 * nothing to a rAF-driven GSAP tween.
 *
 * The full-page baseline captures `main`, which is taller than the viewport, so
 * Playwright has to scroll to shoot it — and that scroll is what decides when
 * the trigger fires relative to the capture. Net effect (observed 2026-10-20):
 * the baseline was reproducible only by luck — it passed when the spec ran
 * standalone and failed in the full suite, where the dev server is warm and
 * the page lays out slightly differently.
 *
 * This helper removes the timing dependency: scroll the grid into view so the
 * trigger fires, then poll until every animated element reports opacity 1.
 */
const waitForEntrance = async (page: Page): Promise<void> => {
  await page.locator('.gsap-module-grid').scrollIntoViewIfNeeded()
  await page.waitForFunction(
    () => {
      const els = [
        ...document.querySelectorAll<HTMLElement>('.module-card'),
        ...document.querySelectorAll<HTMLElement>(
          '.gsap-hero-title, .gsap-hero-tagline, .gsap-hero-sub, .gsap-hero-ctas',
        ),
      ]
      if (els.length === 0) return false
      return els.every((el) => {
        const o = parseFloat(window.getComputedStyle(el).opacity)
        return Number.isFinite(o) && o > 0.995
      })
    },
    undefined,
    { timeout: 15000 },
  )
}

test('Home: GSAP hero text reaches final opacity after animation', async ({ page }) => {
  await page.goto('/')

  // Hero h1 + tagline + sub + ctas should all reach opacity 1.
  // GSAP's `from()` with autoAlpha starts elements at opacity 0;
  // they fade in over ~0.7s with stagger. Wait > 1.5s for safety.
  await page.waitForTimeout(1800)

  // Verify opacity computed style. GSAP sets `opacity: 1` inline.
  const heroOpacity = await page
    .locator('.gsap-hero-title')
    .evaluate((el) => window.getComputedStyle(el).opacity)
  expect(parseFloat(heroOpacity)).toBeGreaterThan(0.95)

  const subOpacity = await page
    .locator('.gsap-hero-sub')
    .evaluate((el) => window.getComputedStyle(el).opacity)
  expect(parseFloat(subOpacity)).toBeGreaterThan(0.95)

  await expect(page.locator('.hero')).toHaveScreenshot('home-gsap-hero.png')
})
test('Home: SmartCity 3D card is rendered as featured', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('[data-testid="smart-city-card"]')).toBeVisible()
  // Verify it has the featured class (violet border / background).
  const className = await page.locator('[data-testid="smart-city-card"]').getAttribute('class')
  expect(className).toContain('module-card-featured')
  expect(className).toContain('status-active')
  // Badge says "M3 · New".
  await expect(page.locator('[data-testid="smart-city-card"] .badge-new')).toContainText('M3')
})

test('Home: SmartCity link in top nav', async ({ page }) => {
  await page.goto('/')
  const link = page.locator('.nav-link.nav-link-new')
  await expect(link).toBeVisible()
  await expect(link).toHaveText('SmartCity 3D')
  await expect(link).toHaveAttribute('href', '/smart-city')
})

test('Home: all 7 module cards present (was 5 before Plan 055)', async ({ page }) => {
  await page.goto('/')
  await page.waitForTimeout(1200) // let GSAP card entrance settle
  const cards = page.locator('.module-card')
  await expect(cards).toHaveCount(7)
})

test('Home: full-page screenshot baseline', async ({ page }) => {
  await page.goto('/')
  // Wait for the entrance animations to settle deterministically — see
  // waitForEntrance. A fixed timeout is not enough: the module cards are
  // driven by a ScrollTrigger, and capturing `main` (taller than the viewport)
  // scrolls the page, which shifts when the trigger fires.
  await waitForEntrance(page)
  await expect(page.locator('main')).toHaveScreenshot('home-gsap-full.png')
})
