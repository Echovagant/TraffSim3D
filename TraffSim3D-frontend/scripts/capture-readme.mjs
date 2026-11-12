/**
 * 拍 README 用的配图。
 *
 * 两张：
 *   1. `docs/media/readme-hero.png` —— 深圳福田白模城区的宽幅全景，
 *      **不带界面 chrome**（顶栏、事件流、左右面板都藏掉）：README 的首屏
 *      要的是这座城市本身，不是仪表盘。
 *   2. `docs/media/scene-editor.png` —— 场景编辑器（原来那张是 10-22 的旧界面）。
 *
 * 用法：node scripts/capture-readme.mjs [--url http://127.0.0.1:5188]
 */
import { chromium } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const URL = argOf('url', 'http://127.0.0.1:5188')
const OUT = path.resolve(process.cwd(), '..', 'docs', 'media')

/** The chrome that hides behind the city in the hero shot. */
const HIDE_CHROME = `
  .dc-topbar, .bottom-bar, .col, .showcase-nav { visibility: hidden !important; }
`

const main = async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch()

  // 1) The hero: the city, wide, without the dashboard.
  {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
    await page.goto(`${URL}/smart-city`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="osm-building-count"]')
        return Boolean(el && Number((el.textContent ?? '0').replace(/\D/g, '')) > 0)
      },
      undefined,
      { timeout: 120_000 },
    )
    // The tiles are cached now, so the buildings are there — give the
    // white model a moment to settle into the picture.
    await page.waitForTimeout(12_000)
    // Collapse the panels, then hide the chrome entirely.
    const toggle = page.locator('[data-testid="toggle-panels"]')
    if (await toggle.count()) await toggle.click()
    await page.waitForTimeout(1_500)
    await page.addStyleTag({ content: HIDE_CHROME })
    await page.waitForTimeout(800)
    const file = path.join(OUT, 'readme-hero.png')
    await page.screenshot({ path: file })
    console.log(`  readme-hero.png  ${(fs.statSync(file).size / 1024).toFixed(0)} KB`)
    await page.close()
  }

  // 2) The scene editor, at its own size.
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto(`${URL}/scene-editor`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="world-canvas"]', { state: 'attached' })
    await page.waitForTimeout(6_000)
    const file = path.join(OUT, 'scene-editor.png')
    await page.screenshot({ path: file })
    console.log(`  scene-editor.png  ${(fs.statSync(file).size / 1024).toFixed(0)} KB`)
    await page.close()
  }

  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
