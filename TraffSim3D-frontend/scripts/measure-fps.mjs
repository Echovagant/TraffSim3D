/**
 * 帧率基准探针：量「N 辆车时前端渲染的帧率」（性能基准报告）。
 *
 * 性能门禁（tests/e2e/perf-gate.spec.ts）给的是**一个**点：最大场景
 * （loop，12 车）的 min/avg/max FPS。本脚本给出 4 / 8 / 12 三档的曲线，
 * 数字与门禁同源（同一个 dev hook、同一个采样方式）。
 *
 * **两种渲染环境必须分开测、分开报：**
 *   - 默认（headless Chromium）：WebGL 走 SwiftShader 软件光栅，**完全不用
 *     GPU**。读数是**悲观下界**。这正是 CI 跑的环境。
 *   - `--headed`：真实浏览器窗口，WebGL 走本机真实 GPU。读数才是**真实硬件**
 *     的数字 —— 30 FPS 门禁只在这个环境里成立。
 *
 * 用法（必须先自己起前端，独立端口 —— 5173 属于别的项目）：
 *   npm run dev -- --port 5188
 *   node scripts/measure-fps.mjs --vehicles 12              # headless / SwiftShader
 *   node scripts/measure-fps.mjs --vehicles 12 --headed     # 真实 GPU
 *   node scripts/measure-fps.mjs --vehicles 8
 *   node scripts/measure-fps.mjs --vehicles 4
 *
 * 输出：../e2e-output/perf/fps-<n>-<mode>.json（含原始采样点，供人复核）。
 * `<mode>` 是 headless / headed —— 两种环境的数据不该互相覆盖。
 *
 * ⚠ headless 读数是**悲观下界**；报告里必须带上这句，不要把软件光栅的数
 *   当硬件上限。真实 GPU 的数用 `--headed` 单独测。
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
/**
 * `--headed` → 真实浏览器窗口 + 本机 GPU。
 * headless Chromium 的 WebGL 走 SwiftShader 软件光栅，读数只是悲观下界；
 * 要拿到 30 FPS 门禁真正对应的那个数，必须 headed。
 */
const HEADED = args.includes('--headed')
const MODE = HEADED ? 'headed' : 'headless'
const WARMUP_MS = 5_000
const SAMPLE_MS = Number(argOf('sample-ms', '20000'))
const SAMPLE_INTERVAL_MS = 500
const OUT_DIR = path.resolve(process.cwd(), '..', 'e2e-output', 'perf')

/**
 * Chromium 在窗口被遮挡 / 失去焦点时会把 rAF 降频到 ~1 Hz（backgrounding
 * + occlusion 节流）。在真实窗口下测帧率时这会直接毁掉读数 —— 实测：
 * 未处理时 rAF 间隔 995–2011 ms（≈0.85 FPS），而页面其实完全正常。
 * 这几个开关 + `bringToFront()` 把它拉回真实值（6.1 ms / 165 FPS）。
 */
const GPU_FRIENDLY_ARGS = [
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--disable-features=CalculateNativeWinOcclusion',
]

const main = async () => {
  const browser = await chromium.launch({ headless: !HEADED, args: GPU_FRIENDLY_ARGS })
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

  // 真实窗口必须在前台：被遮挡的窗口会被 Chromium 降频到 ~1 Hz，
  // 那测出来的不是渲染性能，是节流。
  await page.bringToFront()
  await page.waitForTimeout(500)

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
  // ⚠ 为什么不直接读 `store.fps`：历史上 `worldStore.step()` 用的是
  //   `clampedDt = max(0, min(dt, 1/30))`（dt 钳在 33.3 ms），于是
  //   `fps = frameCount / ΣclampedDt` 在结构上**永远不可能低于 30** ——
  //   拿它当性能读数，测出的是钳位下限而不是真实帧率。
  // （该指标已改为按墙钟帧间隔统计；这里仍独立用 rAF 测量，作为**交叉验证**：
  //   两套独立算法给出的数应当一致。）
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
            // 页面状态：headed 读数只有在窗口确实可见/在前台时才有意义。
            // 一旦被 Chromium 节流到 1 Hz，这两个字段会先于帧率掉下去。
            visibilityState: document.visibilityState,
            hasFocus: document.hasFocus(),
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

  // 渲染器字符串：优先读**页面里真正在画的那个 canvas**（Three.js 的），
  // 拿不到再退回新建的 canvas —— 新建 canvas 拿到的上下文未必与页面上实际
  // 使用的是同一个（GPU 适配器的选择路径可能不同）。
  const renderer = await page.evaluate(() => {
    const probe = (canvas) => {
      const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
      const ext = gl?.getExtension('WEBGL_debug_renderer_info')
      return ext && gl ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown'
    }
    const real = document.querySelector('canvas')
    return real ? probe(real) : probe(document.createElement('canvas'))
  })
  // SwiftShader = 软件光栅（无 GPU）。这是「这组数字能不能拿去跟 30 FPS
  // 目标比较」的唯一判据 —— 判据来自**渲染器字符串本身**，不是启动参数，
  // 所以同一个脚本在 CI（headless）和开发者本机（headed）都判得对。
  const softwareRasterizer = /swiftshader/i.test(renderer)

  // 页面状态：headed 读数只有在窗口确实在前台、页面确实可见时才有意义。
  const pageState = await page.evaluate(() => ({
    visibilityState: document.visibilityState,
    hidden: document.hidden,
    hasFocus: document.hasFocus(),
  }))

  await browser.close()

  // --- 两组读数，都要报 ---------------------------------------------------
  // (a) 真帧率：rAF 相邻回调间隔的倒数（不受 store 的 dt 钳位影响）
  // (b) store 读数：DebugPanel 展示的那个 `fps`
  //
  // ⚠ 平均帧率有两种算法，**差得很远**，必须说清用的是哪一种：
  //   - 「瞬时帧率的算术平均」= mean(1000/Δ)  ⇒ **偏大**（Jensen：同样的平均
  //     间隔下，平均倒数 > 倒数的平均；快的帧把均值拉上去）。
  //   - 「时间加权帧率」= 总帧数 / 总耗时 = 1000 / 平均间隔 ⇒ **偏小**，是
  //     稳态帧率的正确估计。
  // 本报告的**主指标是时间加权的那一个**。
  const deltas = samples.frameDeltas.filter((d) => d > 0)
  const trueFps = deltas.map((d) => 1000 / d)
  const fpsValues = samples.samples.map((s) => s.fps).slice(2)

  const stat = (arr) => ({
    min: Number(Math.min(...arr).toFixed(1)),
    max: Number(Math.max(...arr).toFixed(1)),
    avg: Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2)),
  })

  const deltaStats = stat(deltas)

  /**
   * Chromium 把被遮挡 / 后台化的窗口的 rAF **降到精确的 1 Hz**。
   * 这个签名和「应用真的慢」形态完全不同：
   *   - 真慢  → 间隔是一段连续的分布（几毫秒到几十毫秒都有）；
   *   - 被节流 → 间隔几乎全部挤在 1000 ms 附近。
   * 识别出来就标成「读数无效」，**不要把 1 FPS 当成硬件性能写进报告**。
   * 实测（本机，headed）：未处理的窗口在 ~7 s 后整体塌到 1 Hz，
   * 而页面自己仍报 `visibilityState: visible` / `hasFocus: true`。
   */
  const oneHzDeltas = deltas.filter((d) => Math.abs(d - 1000) <= 100).length
  const throttled = deltas.length >= 20 && oneHzDeltas / deltas.length > 0.5

  // 时间加权帧率：总帧数 / 总时长。
  const timeWeightedFps = 1000 / deltaStats.avg
  const trueStats = stat(trueFps)
  const storeStats = stat(fpsValues)
  const frameAvg = samples.samples.reduce((a, s) => a + s.frameMsAvg, 0) / samples.samples.length
  const min = deltaStats.min > 0 ? 1000 / deltaStats.max : 0
  const max = 1000 / deltaStats.min
  const avg = Number(timeWeightedFps.toFixed(2))

  const report = {
    requestedVehicles: VEHICLES,
    measuredVehicles: added.vehicles,
    saturatedAtCapacity: added.saturated,
    scene: 'loop',
    // Measured by tests/e2e/scene-capacity-probe.spec.ts — it calls
    // addVehicle() until the scene refuses, so it is the source of
    // truth. Do not hand-edit: re-run the probe instead.
    sceneCapacities: { cross: 8, t: 7, loop: 12, elevated: 7, corridor: 8 },
    renderer,
    mode: MODE,
    headless: !HEADED,
    softwareRasterizer,
    pageState,
    /**
     * true = 浏览器把窗口节流到了 1 Hz，这一组读数**无效**（不是性能问题）。
     */
    throttled,
    throttledNote: throttled
      ? 'INVALID READING: >50% of frame intervals sit at ~1000 ms — Chromium ' +
        'throttled the (occluded / backgrounded) window to 1 Hz. This is not ' +
        'a performance result. Re-run with the window in the foreground.'
      : 'reading looks valid (frame intervals are not clustered at 1000 ms)',
    /**
     * 30 FPS 目标是否适用于这一组读数。
     * 软件光栅 ⇒ 不适用（读数只是悲观下界，门禁只报不断言）。
     * 真实 GPU ⇒ 适用（这就是门禁要断言的那个环境）。
     */
    gateApplicable: !softwareRasterizer,
    note: softwareRasterizer
      ? 'software rasterizer (SwiftShader) => pessimistic lower bound; the 30 FPS ' +
        'target does NOT apply to this reading'
      : 'real GPU renderer => this reading is the one the 30 FPS target is about',
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
      min: Number(min.toFixed(1)),
      max: Number(max.toFixed(1)),
      avg: Number(avg.toFixed(2)),
      avgMethod: 'time-weighted (1000 / mean frame interval) — the sustained rate',
      frameMsAvg: Number(frameAvg.toFixed(2)),
    },
    trueFrameTiming: {
      note:
        'rAF callback interval (ms) and the FPS it implies. This is the ' +
        'UNCLAMPED measurement — it can go below 30.',
      deltaMs: deltaStats,
      fps: trueStats,
      fpsAvgMethod:
        'fps.avg is the arithmetic mean of the INSTANTANEOUS rates (1000/delta). ' +
        'It reads HIGHER than the sustained rate because fast frames dominate ' +
        'the mean. stats.avg (time-weighted) is the number to quote.',
      timeWeightedFps: Number(timeWeightedFps.toFixed(2)),
    },
    storeReportedFps: {
      note:
        'The DebugPanel `fps` readout, measured over 500 ms wall-clock windows. ' +
        'This is an independent estimate of the same thing the rAF timing ' +
        'measures — the two agreeing is the cross-check that the reading is real.',
      ...storeStats,
    },
    samples: samples.samples,
    /**
     * 原始 rAF 帧间隔（毫秒），一个数一个帧。
     * 报告里的 min/avg/max 全部可以由这个数组复算出来 —— 数字可复核。
     */
    frameDeltas: samples.frameDeltas.map((d) => Number(d.toFixed(2))),
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const outFile = path.join(OUT_DIR, `fps-${added.vehicles}-${MODE}.json`)
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf-8')
  console.log(
    `[perf] mode=${MODE} renderer=${renderer} vehicles=${added.vehicles} ` +
      `sustained=${avg.toFixed(1)} FPS (min ${min.toFixed(1)} / max ${max.toFixed(1)}) ` +
      `frameDelta=${deltaStats.avg.toFixed(1)}ms storeFps=${storeStats.avg} ` +
      `load=${loadPct}% softwareRasterizer=${softwareRasterizer} -> ${outFile}`,
  )
  if (throttled) {
    console.warn(
      `[perf] WARNING: ${oneHzDeltas}/${deltas.length} frame intervals sit at ~1000 ms — ` +
        `Chromium throttled the window to 1 Hz (occluded / backgrounded). ` +
        `THIS READING IS INVALID, not a performance result.`,
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
