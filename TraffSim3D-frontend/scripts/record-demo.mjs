/**
 * 录一段产品演示视频。
 *
 * 内容：
 *   1. AI Proving Ground：列出 checkpoints → 加载训好的策略 → 选回放目标 → 开始回放
 *   2. 客户端路由回 SceneLab：看**策略在开车**（它会开到路口前并按灯停车）
 *
 * 前置（都必须是本项目自己的进程，端口 5173 / 8000 属于别的项目）：
 *   后端：cd TraffSim3D-backend
 *         $env:PPO_CHECKPOINT_DIR = '<有 checkpoint 的目录>'
 *         .\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8001
 *   前端：cd TraffSim3D-frontend
 *         $env:VITE_BACKEND_PORT  = '8001'
 *         $env:VITE_BACKEND_URL   = 'http://localhost:8001'
 *         npm run dev -- --port 5188
 *
 * 用法：
 *   node scripts/record-demo.mjs --out ../docs/media/traffsim3d-demo.webm
 *
 * 两个环境变量都要设：VITE_BACKEND_PORT 给 vite 代理用，VITE_BACKEND_URL 给
 * 视图里的直连 fetch 用（AI Playground 用后者，缺了就退回 8000 而连不上）。
 *
 * 产物：一个无声的 .webm。headless Chromium 走 SwiftShader 软件光栅 ⇒
 * 画面是**悲观**的（真实 GPU 上更流畅）。
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
const OUT = path.resolve(process.cwd(), argOf('out', '../docs/media/traffsim3d-demo.webm'))
const TMP_DIR = path.resolve(process.cwd(), '..', '.data', 'demo_video_tmp')
const SCENE_SECONDS = Number(argOf('scene-seconds', '24'))

const waitFor = async (page, fn, timeout = 40_000) => {
  await page.waitForFunction(fn, undefined, { timeout })
}

const main = async () => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
  fs.mkdirSync(TMP_DIR, { recursive: true })
  fs.mkdirSync(path.dirname(OUT), { recursive: true })

  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: TMP_DIR, size: { width: 1280, height: 800 } },
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 160))
  })

  // --- 1) AI Proving Ground：加载策略并开始回放 -------------------------
  await page.goto(`${URL}/ai-playground`, { waitUntil: 'domcontentloaded' })
  await page.locator('[data-testid="list-checkpoints-button"]').click()
  await waitFor(
    page,
    () => {
      const sel = document.querySelector('[data-testid="ckpt-replay-select"]')
      return Boolean(sel && sel.options.length > 1)
    },
    30_000,
  )
  const ckpt = await page.$eval('[data-testid="ckpt-replay-select"]', (el) => el.options[1].value)
  console.log('replaying checkpoint:', ckpt)
  await page.selectOption('[data-testid="ckpt-replay-select"]', ckpt)
  await page.locator('[data-testid="load-policy-button"]').click()
  await waitFor(
    page,
    () => {
      const el = document.querySelector('[data-testid="policy-status"]')
      return Boolean(el && el.textContent && el.textContent.includes('14 obs'))
    },
    60_000,
  )
  await waitFor(
    page,
    () => {
      const sel = document.querySelector('[data-testid="replay-target-select"]')
      return Boolean(sel && sel.options.length > 1)
    },
    30_000,
  )
  await page.selectOption('[data-testid="replay-target-select"]', 'v-1')
  await page.locator('[data-testid="start-replay-button"]').click()
  await waitFor(
    page,
    () => {
      const el = document.querySelector('[data-testid="replay-state"]')
      return Boolean(el && el.textContent && el.textContent.includes('运行中'))
    },
    30_000,
  )
  console.log('replay running')

  // --- 2) 客户端路由回 SceneLab（不能整页刷新：刷新会重置 store，策略与
  //        回放状态都活在内存里） -----------------------------------------
  const sBefore = await page.evaluate(() => {
    const v = window.__world.network.vehicles['v-1']
    return v ? v.s : null
  })
  await page.locator('a.back-link').click()
  await page.waitForURL('**/', { timeout: 20_000 })
  await page.locator('a.module-card[href="/scene-editor"]').click()
  await page.waitForURL('**/scene-editor', { timeout: 20_000 })
  await waitFor(page, () => {
    const w = window
    return Boolean(w.__world && Object.keys(w.__world.network.vehicles).length > 0)
  })
  // 多加几辆车，画面上更有车流的感觉
  await page.evaluate(() => {
    const w = window.__world
    let guard = 0
    while (Object.keys(w.network.vehicles).length < 8 && guard++ < 40) w.addVehicle()
  })
  // 用产品自带的「适配场景」把镜头框住路网（否则画面里路口只有中间一小块）
  await page.locator('[data-testid="fit-scene-button"]').click()
  await page.waitForTimeout(800)
  // 再滚轮拉近，让路口占满画面（默认俯视全景里路口太小，看不清车在动）
  await page.mouse.move(640, 400)
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, -400)
    await page.waitForTimeout(200)
  }
  await page.waitForTimeout(SCENE_SECONDS * 1000)

  const state = await page.evaluate(() => {
    const w = window.__world
    const v = w.network.vehicles['v-1']
    return {
      replayActive: w.replayActive,
      replayLast: window.__replayLast ?? null,
      fps: Math.round(w.fps),
      vehicles: Object.keys(w.network.vehicles).length,
      ego: v ? { s: v.s, speed: v.speed, targetSpeed: v.targetSpeed } : null,
    }
  })
  console.log('final state:', JSON.stringify(state))
  if (!state.replayActive || !state.replayLast) {
    throw new Error('the replay never ran in the 3D view — the video would be empty')
  }
  if (sBefore !== null && state.ego && state.ego.s <= sBefore) {
    throw new Error(`the policy did not drive the ego (s ${sBefore} -> ${state.ego.s})`)
  }

  await page.close()
  await context.close()
  await browser.close()

  const produced = fs.readdirSync(TMP_DIR).filter((f) => f.endsWith('.webm'))
  if (produced.length === 0) throw new Error('no video was produced')
  fs.copyFileSync(path.join(TMP_DIR, produced[0]), OUT)
  const size = fs.statSync(OUT).size
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
  console.log(`video written: ${OUT} (${(size / 1024).toFixed(0)} KB)`)
  if (errors.length) console.log('page errors seen:', JSON.stringify(errors.slice(0, 5)))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
