/**
 * 探针 3：UI 链路对比。
 *
 * 同时读「真模块 approachSignalFor(rideVehicle)」与「仪表盘文本」，
 * 每 500ms 采一次。若模块有灯而 UI 无信号 ⇒ UI 链路断；两者一致 ⇒
 * 只是选车口径问题（前方恰无灯）。
 *
 * 用法：node scripts/probe-gauge-signal.mjs [--url http://127.0.0.1:5188]
 */
import { chromium } from '@playwright/test'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const URL = argOf('url', 'http://127.0.0.1:5188')
const SAMPLES = Number(argOf('samples', '40'))

const main = async () => {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.goto(`${URL}/smart-city`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="osm-building-count"]')
      return Boolean(el && Number((el.textContent ?? '0').replace(/\D/g, '')) > 0)
    },
    undefined,
    { timeout: 120_000 },
  )
  await page.waitForTimeout(6_000)

  // 预载真模块，挂到 window 上给采样循环用。
  await page.evaluate(async () => {
    window.__sig = await import('/src/domain/services/approachSignal.ts')
  })

  const ride = await page.evaluate(() => {
    const w = window.__world
    const signalledRoads = new Set()
    for (const inter of Object.values(w.network.intersections)) {
      if ((inter.trafficLights ?? []).length > 0) {
        for (const id of inter.connectedRoads ?? []) signalledRoads.add(id)
      }
    }
    const candidates = Object.values(w.network.vehicles)
      .filter((v) => v.type === 'car' && v.speed > 4 && signalledRoads.has(v.roadId))
      .sort((a, b) => b.speed - a.speed)
    const car = candidates[0]
    if (!car) return { ok: false }
    w.setRideVehicle(car.id, 'cockpit')
    return { ok: true, id: car.id }
  })
  console.log('ride:', JSON.stringify(ride))
  if (!ride.ok) throw new Error('no candidate car')

  const rows = []
  for (let i = 0; i < SAMPLES; i++) {
    const row = await page.evaluate(() => {
      const w = window.__world
      const el = document.querySelector('[data-testid="gauge-signal"]')
      const ui = el ? el.textContent.trim().replace(/\s+/g, ' ') : '(missing)'
      const v = w.rideVehicleId ? w.network.vehicles[w.rideVehicleId] : null
      let mod = null
      try {
        const r = v ? window.__sig.approachSignalFor(v, w.network) : null
        mod = r
          ? `${r.light.axis}/${String(r.phase)}/${Math.round(r.remainingS)}s/${Math.round(r.distanceM)}m`
          : 'null'
      } catch (e) {
        mod = `THREW ${String(e).slice(0, 80)}`
      }
      return { ui, mod, car: v ? v.id : null, uiTick: w.uiTick }
    })
    rows.push(row)
    await page.waitForTimeout(500)
  }
  // 压缩打印
  const trace = []
  for (const r of rows) {
    const key = `${r.ui} ⇄ ${r.mod}`
    if (trace[trace.length - 1]?.key !== key) trace.push({ key, n: 1 })
    else trace[trace.length - 1].n++
  }
  for (const t of trace) console.log(`${String(t.n).padStart(2)} × ${t.key}`)
  const uiHas = rows.filter((r) => /红|绿|黄/.test(r.ui)).length
  const modHas = rows.filter((r) => r.mod && r.mod !== 'null' && !r.mod.startsWith('THREW')).length
  console.log(`\nUI 有灯采样 ${uiHas}/${SAMPLES}；模块有灯采样 ${modHas}/${SAMPLES}`)
  await browser.close()
  process.exit(uiHas > 0 && modHas > 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
