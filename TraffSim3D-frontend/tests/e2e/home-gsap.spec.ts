/**
 * GSAP homepage animations + SmartCity 3D card.
 *
 * Verifies:
 *  - Home page mounts + the GSAP-initialized elements appear
 *    (opacity reaches 1 once entrance animation completes).
 *  - The SmartCity 3D module card is present.
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
 * trigger fires, then poll until every animated element reports opacity 1 AND
 * has stopped moving.
 */
const waitForSettled = async (page: Page, selectors: string[]): Promise<void> => {
  await page.waitForFunction(
    (sels: string[]) => {
      const els = sels.flatMap((s) => [...document.querySelectorAll<HTMLElement>(s)])
      if (els.length === 0) return false
      const opaque = els.every((el) => {
        const o = parseFloat(window.getComputedStyle(el).opacity)
        return Number.isFinite(o) && o > 0.995
      })
      if (!opaque) return false
      // Opacity reaching 1 does NOT mean the tween has finished: the entrance
      // also animates `y`, so a card can be fully opaque and still be sliding
      // into place. Compare the positions across two consecutive polls and
      // only accept the frame when nothing moved.
      const sig = els
        .map((el) => {
          const r = el.getBoundingClientRect()
          return `${r.top.toFixed(1)},${r.left.toFixed(1)}`
        })
        .join('|')
      const store = window as unknown as { __entranceSignature?: string }
      if (store.__entranceSignature === sig) return true
      store.__entranceSignature = sig
      return false
    },
    selectors,
    { timeout: 15000, polling: 120 },
  )
}

const HERO_SELECTORS = ['.gsap-hero-title, .gsap-hero-tagline, .gsap-hero-sub, .gsap-hero-ctas']
const CARD_SELECTORS = ['.module-card']

test('Home: GSAP hero text reaches final opacity after animation', async ({ page }) => {
  await page.goto('/')

  // Hero h1 + tagline + sub + ctas should all reach opacity 1.
  // GSAP's `from()` with autoAlpha starts elements at opacity 0;
  // they fade in over ~0.7s with stagger. Wait until the tween has actually
  // stopped, not just until a fixed delay has elapsed - the capture below is
  // a pixel comparison, so a card that is still sliding is a failure.
  await waitForSettled(page, HERO_SELECTORS)

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
  // Badge says "New".
  await expect(page.locator('[data-testid="smart-city-card"] .badge-new')).toContainText('New')
})

test('Home: SmartCity link in top nav', async ({ page }) => {
  await page.goto('/')
  const link = page.locator('.nav-link.nav-link-new')
  await expect(link).toBeVisible()
  await expect(link).toHaveText('SmartCity 3D')
  await expect(link).toHaveAttribute('href', '/smart-city')
})

test('Home: all 7 module cards present', async ({ page }) => {
  await page.goto('/')
  await page.waitForTimeout(1200) // let GSAP card entrance settle
  const cards = page.locator('.module-card')
  await expect(cards).toHaveCount(7)
})

test.describe('Home: full-page baseline', () => {
  /**
   * The whole page fits in ONE viewport, so Playwright captures `main`
   * without scrolling. That removes the two sources of non-determinism a
   * taller-than-viewport capture has:
   *
   *  1. The header is `position: fixed`, so it is painted at whatever scroll
   *     offset the page happens to be at when the shot is taken.
   *  2. The card entrance ScrollTrigger carries
   *     `toggleActions: 'play none none reverse'`, so scrolling back up
   *     reverses the entrance again.
   *
   * With the grid already inside the viewport its trigger fires at load, and
   * waitForSettled waits for the tween to finish.
   */
  test.use({ viewport: { width: 1280, height: 1400 } })

  test('Home: full-page screenshot baseline', async ({ page }) => {
    await page.goto('/')
    await waitForSettled(page, [...HERO_SELECTORS, ...CARD_SELECTORS])

    // The decorative WebGL background is time-driven (`u_time` is fed from
    // `Date.now()`), so every capture of it differs by construction. It
    // covers a large part of the page, which on its own is enough to blow
    // the 0.5% tolerance. It carries no layout information - hide it.
    await page.locator('canvas.webgl-background').evaluate((el) => {
      ;(el as HTMLElement).style.visibility = 'hidden'
    })

    // Pin the page to the top, then drop the inline styles GSAP left on the
    // animated elements. Scrolling to the top can re-trigger the entrance
    // ScrollTrigger (`toggleActions: 'play none none reverse'`), and a tween
    // caught mid-flight would be captured at a different offset every run.
    // Clearing the inline transform/opacity/visibility puts every element
    // back at its natural, final position - which is exactly the layout the
    // baseline is meant to pin.
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.evaluate(() => {
      const selectors = [
        '.module-card',
        '.gsap-hero-title',
        '.gsap-hero-tagline',
        '.gsap-hero-sub',
        '.gsap-hero-ctas',
        '.gsap-modules-header',
      ]
      document.querySelectorAll<HTMLElement>(selectors.join(',')).forEach((el) => {
        el.style.transform = ''
        el.style.opacity = ''
        el.style.visibility = ''
      })
    })

    await expect(page.locator('main')).toHaveScreenshot('home-gsap-full.png')
  })
})
