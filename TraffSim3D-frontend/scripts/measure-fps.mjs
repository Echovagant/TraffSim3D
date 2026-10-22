/**
 * 帧率基准探针：量「N 辆车时前端渲染的帧率」（M5 的 Could 项「性能基准报告」）。
 *
 * M1 性能门禁（tests/e2e/m1-perf-gate.spec.ts）给的是**一个**点：最大场景
 * （loop，12 车）在 headless SwiftShader 上的 min/avg/max FPS。本脚本给出
 * 4 / 8 / 12 三档的曲线，数字与门禁同源（同一个 dev hook、同一个采样方式）。
 *
 * 用法（必须先自己起前端，独立端口 —— 5173 属于别的项目）：
 *   npm run dev -- --port 5188
 *   node scripts/measure-fps.mjs --vehicles 12
 *   node scripts/measure-fps.mjs --vehicles 8
 *   node scripts/measure-fps.mjs --vehicles 4
 *
 * 输出：../e2e-output/perf/fps-<n>.json（含原始采样点，供人复核）。
 *
 * ⚠ headless Chromium 走 SwiftShader（软件光栅）⇒ 读数是**悲观下界**；
 *   真实 GPU 上更高。报告里必须带上这句，不要把软件光栅的数当硬件上限。
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
const VEHICLES = Number(argOf('vehicles', '12'))
const WARMUP_MS = 5_000
const SAMPLE_MS = 20_000
const SAMPLE_INTERVAL_MS = 500
const OUT_DIR = path.resolve(process.cwd(), '..', 'e2e-output', 'perf')

const main = async () => {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.goto(URL, { waitUntil: 'domcontentloaded' })

  // 等场景就绪（世界挂到 window.__world 上）
  await page.waitForFunction(
    () => {
      const w = window
      return Boolean(w.__world && Object.keys(w.__world.network.vehicles).length > 0)
    },
    undefined,
    { timeout: 40_000 },
  )

  // 选容量最大的内置场景（loop，容量 12）
  await page.selectOption('[data-testid="scene-kind-select"]', 'loop')
  await page.waitForTimeout(2_000)

  const added = await page.evaluate((target) => {
    const w = window
    const store = w.__world
    let guard = 0
    while (Object.keys(store.network.vehicles).length < target && guard++ < 200) {
      store.addVehicle()
    }
    return {
      vehicles: Object.keys(store.network.vehicles).length,
      saturated: Object.keys(store.network.vehicles).length < target,
    }
  }, VEHICLES)

  await page.waitForTimeout(WARMUP_MS)

  const samples = await page.evaluate(
    async ([durationMs, intervalMs]) => {
      const out = []
      const w = window
      const start = performance.now()
      for (;;) {
        const now = performance.now()
        const store = w.__world
        if (store) {
          out.push({
            tMs: Math.round(now - start),
            fps: Math.round(store.fps),
            frameMsAvg: Number(store.frameMsAvg.toFixed(2)),
            vehicles: Object.keys(store.network.vehicles).length,
          })
        }
        if (now - start >= durationMs) break
        await new Promise((r) => setTimeout(r, intervalMs))
      }
      return out
    },
    [SAMPLE_MS, SAMPLE_INTERVAL_MS],
  )

  const renderer = await page.evaluate(() => {
    const c = document.createElement('canvas')
    const gl = c.getContext('webgl2') ?? c.getContext('webgl')
    const ext = gl?.getExtension('WEBGL_debug_renderer_info')
    return ext && gl ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown'
  })

  await browser.close()

  const fpsValues = samples.map((s) => s.fps).slice(2)
  const min = Math.min(...fpsValues)
  const max = Math.max(...fpsValues)
  const avg = fpsValues.reduce((a, b) => a + b, 0) / fpsValues.length
  const frameAvg = samples.reduce((a, s) => a + s.frameMsAvg, 0) / samples.length

  const report = {
    requestedVehicles: VEHICLES,
    measuredVehicles: added.vehicles,
    saturatedAtCapacity: added.saturated,
    scene: 'loop',
    sceneCapacities: { cross: 8, t: 7, loop: 12, elevated: 6, corridor: 8 },
    renderer,
    headless: true,
    note: 'headless Chromium = SwiftShader software rasterizer => pessimistic lower bound',
    sampledAt: new Date().toISOString(),
    stats: { min, max, avg: Number(avg.toFixed(2)), frameMsAvg: Number(frameAvg.toFixed(2)) },
    samples,
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const outFile = path.join(OUT_DIR, `fps-${added.vehicles}.json`)
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf-8')
  console.log(
    `[perf] renderer=${renderer} vehicles=${added.vehicles} ` +
      `fps min/avg/max=${min}/${avg.toFixed(1)}/${max} ` +
      `frameMs=${frameAvg.toFixed(2)} -> ${outFile}`,
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
