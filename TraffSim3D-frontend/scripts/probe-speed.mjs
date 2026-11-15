/** 速度对照探针（临时）：实测 372 车默认场景的速度分布。 */
import { chromium } from '@playwright/test'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.goto('http://127.0.0.1:5188/smart-city', { waitUntil: 'domcontentloaded' })
await page.waitForFunction(
  () => Boolean(window.__world && Object.keys(window.__world.network.vehicles).length > 0),
  undefined,
  { timeout: 120_000 },
)
await page.waitForFunction(
  () => Object.keys(window.__world.network.vehicles).length >= 100,
  undefined,
  { timeout: 120_000 },
)
// 让车流跑稳（红灯排队、跟车约束都生效）再采样
await page.waitForTimeout(30_000)

const stats = await page.evaluate(() => {
  const net = window.__world.network
  const speeds = Object.values(net.vehicles)
    .map((v) => v.speed)
    .filter((s) => Number.isFinite(s) && s >= 0)
  const sorted = [...speeds].sort((a, b) => a - b)
  const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length
  const q = (p) => sorted[Math.floor(p * (sorted.length - 1))]
  return {
    n: speeds.length,
    mean,
    median: q(0.5),
    p10: q(0.1),
    p90: q(0.9),
    // 停止/蠕行比例（<2 m/s ≈ 7 km/h，排队中）
    stoppedShare: speeds.filter((s) => s < 2).length / speeds.length,
    // 自由流比例（>0.9×限速 13.89）
    freeFlowShare: speeds.filter((s) => s > 12.5).length / speeds.length,
  }
})
console.log(JSON.stringify(stats))
console.log(
  `mean=${(stats.mean * 3.6).toFixed(1)} km/h  median=${(stats.median * 3.6).toFixed(1)} km/h  p10=${(stats.p10 * 3.6).toFixed(1)}  p90=${(stats.p90 * 3.6).toFixed(1)} km/h  stopped(<7.2km/h)=${(stats.stoppedShare * 100).toFixed(0)}%  freeflow(>45km/h)=${(stats.freeFlowShare * 100).toFixed(0)}%`,
)
await browser.close()
