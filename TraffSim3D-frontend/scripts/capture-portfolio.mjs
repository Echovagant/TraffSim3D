/**
 * 拍作品集用的界面图（首页 hero、场景带瓦片、时间线锚点）。
 *
 * 为什么要有这个脚本：这些图**以前是手工截的**，所以 2026-11-09 的场景合并、
 * 11-10 的界面改版之后有 4 张瓦片一直是旧界面（`tile-ai` / `tile-backend` /
 * `tile-deliverables` / `tile-maplab` 都停在 11-07）。没有脚本 ⇒ 没有复查点。
 *
 * 用法：
 *   node scripts/capture-portfolio.mjs [--url http://127.0.0.1:5188]
 *
 * 产物（public/ 下，直接被首页与交付页引用）：
 *   scene-smartcity.png        首页 hero 的实拍底图
 *   tiles/tile-*.png           六个模块瓦片
 *   timeline-chase.png         交付页时间线的视觉锚点
 *
 * 约定：截图前先让页面**稳定**（等动画与仿真落定），否则拍到的是运动中的一帧，
 * 跟读者看到的对不上。
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
const PUBLIC = path.resolve(process.cwd(), 'public')

/**
 * 每个瓦片：去哪个页面、截哪一块、多等多久。
 *
 * `ready` 是一个选择器：等它出现再拍。没有它时只等固定时间。
 * 交付页需要它——那一页的数字是**实时问后端要来的**，拍早了拍到的是
 * 「—」（未测量的占位符），那正是这张图不该出现的东西。
 */
const TILES = [
  { file: 'tiles/tile-scenelab.png', route: '/scene-editor', wait: 9000 },
  { file: 'tiles/tile-smartcity.png', route: '/smart-city', wait: 16000 },
  { file: 'tiles/tile-ai.png', route: '/ai-playground', wait: 9000 },
  { file: 'tiles/tile-maplab.png', route: '/map-importer', wait: 9000 },
  { file: 'tiles/tile-backend.png', route: '/backend', wait: 9000 },
  {
    file: 'tiles/tile-deliverables.png',
    route: '/deliverables',
    wait: 3000,
    ready: '.cap-proof.is-live',
  },
]

/**
 * The sizes the page's CSS expects — the images are shown with
 * `object-fit: cover`, so the source's aspect ratio decides the crop.
 * The hero is a wide band; the tiles are 16:9.
 */
const HERO_VIEWPORT = { width: 1280, height: 608 }
const TILE_VIEWPORT = { width: 1200, height: 675 }
const TIMELINE_VIEWPORT = { width: 1200, height: 570 }

const main = async () => {
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: TILE_VIEWPORT })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))

  const shoot = async (file, wait, ready) => {
    if (ready) {
      // The live numbers have to be IN the picture — a shot of the
      // placeholder is worse than no shot.
      await page.waitForSelector(ready, { timeout: 30_000 })
    }
    await page.waitForTimeout(wait)
    const target = path.join(PUBLIC, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    await page.screenshot({ path: target })
    const kb = (fs.statSync(target).size / 1024).toFixed(0)
    console.log(`  ${file}  ${kb} KB`)
  }

  // The home page's hero: the Smart City view behind the title.
  //
  // The panels are COLLAPSED for this shot (the product's own
  // 「收起面板」 button): the hero sits NEXT TO the title, so a
  // dashboard full of panels competes with the text instead of showing
  // the city. The cityscape alone is the stronger image — and it is
  // what the old hero showed, which is why the homepage was built
  // around it.
  console.log('capturing:')
  await page.setViewportSize(HERO_VIEWPORT)
  await page.goto(`${URL}/smart-city`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(14000)
  const collapse = page.locator('[data-testid="toggle-panels"]')
  if (await collapse.count()) {
    await collapse.click()
    await page.waitForTimeout(1200)
  }
  await shoot('scene-smartcity.png', 4000)

  await page.setViewportSize(TILE_VIEWPORT)
  for (const tile of TILES) {
    await page.goto(`${URL}${tile.route}`, { waitUntil: 'domcontentloaded' })
    await shoot(tile.file, tile.wait, tile.ready)
  }

  // The delivery page's timeline anchor: the chase view.
  await page.setViewportSize(TIMELINE_VIEWPORT)
  await page.goto(`${URL}/deliverables`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)
  const anchor = page.locator('img[src="/timeline-chase.png"]')
  if (await anchor.count()) {
    const src = path.join(PUBLIC, 'timeline-chase.png')
    const response = await page.request.get(`${URL}/timeline-chase.png`)
    fs.writeFileSync(src, await response.body())
    console.log(`  timeline-chase.png  ${(fs.statSync(src).size / 1024).toFixed(0)} KB`)
  } else {
    console.log('  timeline-chase.png  SKIPPED (the page no longer shows that image)')
  }

  await browser.close()
  if (errors.length) {
    console.log(`page errors seen (${errors.length}):`)
    for (const e of errors.slice(0, 6)) console.log(`  ${e}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
