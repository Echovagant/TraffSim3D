/**
 * 帧率基准探针：量「N 辆车时前端渲染的帧率」（性能基准报告）。
 *
 * 性能门禁（tests/e2e/perf-gate.spec.ts）给的是**一个**点：最大场景
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
import * as os from 'node:os'
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
  // 必须直接进 /scene-editor：下面的 `scene-kind-select` 工具栏只存在于
  // 场景编辑器视图里，停在首页会一直等不到。
  await page.goto(`${URL}/scene-editor`, { waitUntil: 'domcontentloaded' })

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

  // 精确调到目标车数：不够就加，多了就减。
  // （loop 场景自带 8 辆，只加不减的话永远测不到 4 辆那个点。）
  const added = await page.evaluate((target) => {
    const w = window
    const store = w.__world
    const ids = () => Object.keys(store.network.vehicles)
    let guard = 0
    while (ids().length < target && guard++ < 400) {
      store.addVehicle()
    }
    guard = 0
    while (ids().length > target && guard++ < 400) {
      store.removeVehicle(ids()[ids().length - 1])
    }
    return {
      vehicles: ids().length,
      saturated: ids().length < target,
    }
  }, VEHICLES)

  await page.waitForTimeout(WARMUP_MS)

  // 采样窗口内顺便记一次机器负载 ⇒ 帧率读数能被诚实地归因。
  // （软件光栅的帧率对 CPU 争用极其敏感；不记负载的读数没法解释。）
  //
  // ⚠ 负载的算法：**忙 = 总时间 − idle**。早先的版本把 idle 也算成忙，
  // 于是报出 100000%+ 这种荒谬数字。
  const cpuTimes = () =>
    os.cpus().reduce(
      (acc, c) => {
        const t = c.times
        const total = t.user + t.nice + t.sys + t.idle + t.irq
        acc.total += total
        acc.idle += t.idle
        return acc
      },
      { total: 0, idle: 0 },
    )
  const loadBefore = cpuTimes()
  const sampleStart = Date.now()

  // 帧率的**真实**来源：rAF 的实际回调节奏。
  //
  // ⚠ 为什么不直接读 `store.fps`：`worldStore.step()` 用的是
  //   `clampedDt = max(0, min(dt, 1/30))`（见 worldStore.ts:572）——
  //   dt 被**钳在 33.3 ms**，于是 `fps = frameCount / ΣclampedDt`
  //   在结构上**永远不可能低于 30**。拿它当性能读数，测出的是钳位下限，
  //   不是真实帧率。⇒ 这里改用 rAF 回调间隔自己算帧率。
  const samples = await page.evaluate(
    async ([durationMs, intervalMs]) => {
      const out = []
      const w = window
      const start = performance.now()
      // rAF 节奏的实测：相邻两帧回调之间的时间差
      let lastRaf = performance.now()
      const frameDeltas = []
      let rafRunning = true
      const tick = (ts) => {
        if (!rafRunning) return
        frameDeltas.push(ts - lastRaf)
        lastRaf = ts
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)

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
      rafRunning = false
      return { samples: out, frameDeltas }
    },
    [SAMPLE_MS, SAMPLE_INTERVAL_MS],
  )

  const loadAfter = cpuTimes()
  const wallSec = (Date.now() - sampleStart) / 1000
  // `os.cpus()[].times` 的单位是**毫秒** ⇒ 换算成秒再除以「核数 × 墙钟秒数」。
  const busyCpuSec =
    (loadAfter.total - loadBefore.total - (loadAfter.idle - loadBefore.idle)) / 1000
  const loadPct = Math.round((busyCpuSec / (wallSec * os.cpus().length)) * 100)

  const renderer = await page.evaluate(() => {
    const c = document.createElement('canvas')
    const gl = c.getContext('webgl2') ?? c.getContext('webgl')
    const ext = gl?.getExtension('WEBGL_debug_renderer_info')
    return ext && gl ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown'
  })

  await browser.close()

  // --- 两组读数，都要报 ---------------------------------------------------
  // (a) 真帧率：rAF 相邻回调间隔的倒数（不受 store 的 dt 钳位影响）
  // (b) store 读数：DebugPanel 展示的那个 `fps`（**有 30 FPS 的结构性下限**，
  //     因为 worldStore 把 dt 钳在 1/30 ⇒ 它测不出「比 30 更差」）
  const deltas = samples.frameDeltas.filter((d) => d > 0)
  const trueFps = deltas.map((d) => 1000 / d)
  const fpsValues = samples.samples.map((s) => s.fps).slice(2)

  const stat = (arr) => ({
    min: Number(Math.min(...arr).toFixed(1)),
    max: Number(Math.max(...arr).toFixed(1)),
    avg: Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2)),
  })

  const trueStats = stat(trueFps)
  const storeStats = stat(fpsValues)
  const frameAvg = samples.samples.reduce((a, s) => a + s.frameMsAvg, 0) / samples.samples.length
  const deltaStats = stat(deltas)
  const min = trueStats.min
  const max = trueStats.max
  const avg = trueStats.avg

  const report = {
    requestedVehicles: VEHICLES,
    measuredVehicles: added.vehicles,
    saturatedAtCapacity: added.saturated,
    scene: 'loop',
    sceneCapacities: { cross: 8, t: 7, loop: 12, elevated: 6, corridor: 8 },
    renderer,
    headless: true,
    note: 'headless Chromium = SwiftShader software rasterizer => pessimistic lower bound',
    machine: {
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model ?? 'unknown',
      totalMemGb: Number((os.totalmem() / 1024 ** 3).toFixed(2)),
      loadPctDuringSampling: loadPct,
      loadNote:
        'CPU busy% across all cores during the sampling window (includes this ' +
        'measurement itself). A high value means other work was competing.',
    },
    sampledAt: new Date().toISOString(),
    stats: {
      min,
      max,
      avg: Number(avg.toFixed(2)),
      frameMsAvg: Number(frameAvg.toFixed(2)),
    },
    trueFrameTiming: {
      note:
        'rAF callback interval (ms) and the FPS it implies. This is the ' +
        'UNCLAMPED measurement — it can go below 30, which store.fps cannot.',
      deltaMs: deltaStats,
      fps: trueStats,
    },
    storeReportedFps: {
      note:
        'The DebugPanel `fps` readout. worldStore.step() clamps dt to 1/30 s, ' +
        'so this value has a STRUCTURAL floor of 30 FPS and cannot report a ' +
        'slower frame rate. Use trueFrameTiming for the real number.',
      ...storeStats,
    },
    samples: samples.samples,
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const outFile = path.join(OUT_DIR, `fps-${added.vehicles}.json`)
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf-8')
  console.log(
    `[perf] renderer=${renderer} vehicles=${added.vehicles} ` +
      `TRUE fps min/avg/max=${min}/${avg.toFixed(1)}/${max} ` +
      `frameDelta=${deltaStats.avg.toFixed(1)}ms ` +
      `storeFps=${storeStats.avg} load=${loadPct}% -> ${outFile}`,
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
