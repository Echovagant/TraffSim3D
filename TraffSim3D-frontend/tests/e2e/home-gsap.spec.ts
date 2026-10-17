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
import { test, expect } from '@playwright/test';

test('Home: GSAP hero text reaches final opacity after animation', async ({ page }) => {
  await page.goto('/');

  // Hero h1 + tagline + sub + ctas should all reach opacity 1.
  // GSAP's `from()` with autoAlpha starts elements at opacity 0;
  // they fade in over ~0.7s with stagger. Wait > 1.5s for safety.
  await page.waitForTimeout(1800);

  // Verify opacity computed style. GSAP sets `opacity: 1` inline.
  const heroOpacity = await page.locator('.gsap-hero-title').evaluate(
    (el) => window.getComputedStyle(el).opacity,
  );
  expect(parseFloat(heroOpacity)).toBeGreaterThan(0.95);

  const subOpacity = await page.locator('.gsap-hero-sub').evaluate(
    (el) => window.getComputedStyle(el).opacity,
  );
  expect(parseFloat(subOpacity)).toBeGreaterThan(0.95);

  await expect(page.locator('.hero')).toHaveScreenshot('home-gsap-hero.png');
});

test('Home: SmartCity 3D card is rendered as featured', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-testid="smart-city-card"]')).toBeVisible();
  // Verify it has the featured class (violet border / background).
  const className = await page.locator('[data-testid="smart-city-card"]').getAttribute('class');
  expect(className).toContain('module-card-featured');
  expect(className).toContain('status-active');
  // Badge says "M3 · New".
  await expect(page.locator('[data-testid="smart-city-card"] .badge-new')).toContainText('M3');
});

test('Home: SmartCity link in top nav', async ({ page }) => {
  await page.goto('/');
  const link = page.locator('.nav-link.nav-link-new');
  await expect(link).toBeVisible();
  await expect(link).toHaveText('SmartCity 3D');
  await expect(link).toHaveAttribute('href', '/smart-city');
});

test('Home: all 7 module cards present (was 5 before Plan 055)', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(1200);  // let GSAP card entrance settle
  const cards = page.locator('.module-card');
  await expect(cards).toHaveCount(7);
});

test('Home: full-page screenshot baseline', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(2000);  // all GSAP animations done
  await expect(page.locator('main')).toHaveScreenshot('home-gsap-full.png');
});