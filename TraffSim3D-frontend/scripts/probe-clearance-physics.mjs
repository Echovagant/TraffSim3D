/**
 * 探针：限高的物理对偶 —— 门架真的挡住公交车吗？
 *
 * 在导入城区里：
 *   1. 找到限高路（春风隧道，3.5 m）与它的两个端点；
 *   2. 把一辆公交放到隧道口的路上，让它朝隧道开；
 *   3. 采样它的位置：它应该**停在门口**（被固定门架挡住）；
 *   4. 再放一辆小车，同一段路：它应该**开进去**。
 *
 * 判据（实测打印，不自己下结论）：
 *   - 公交的前进距离 < 隧道口 + 车身长度；
 *   - 小车的终点在隧道另一端之外。
 *
 * 用法：node scripts/probe-clearance-physics.mjs [--url http://127.0.0.1:5188]
 */
import { chromium } from '@playwright/test'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const URL = argOf('url', 'http://127.0.0.1:5188')

const main = async () => {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
  await page.goto(`${URL}/smart-city`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="osm-building-count"]')
      return Boolean(el && Number((el.textContent ?? '0').replace(/\D/g, '')) > 0)
    },
    undefined,
    { timeout: 120_000 },
  )
  await page.waitForTimeout(5_000)

  const out = await page.evaluate(async () => {
    const ra = await import('/src/domain/services/roadAccess.ts')
    const geo = await import('/src/domain/services/laneGeometry.ts')
    const w = window.__world
    const net = w.network
    const limited = Object.values(net.roads).filter((r) => ra.roadHeightLimitM(r) !== null)
    if (limited.length === 0) return { error: 'no height-limited road in the network' }
    const road = limited[0]
    const limit = ra.roadHeightLimitM(road)
    const wp = geo.roadWaypoints(road)
    const start = wp[0]
    const end = wp[wp.length - 1]
    const len = geo.roadLength(road)
    // The unit vector along the road (start → end).
    const dir = { x: (end.x - start.x) / len, z: (end.z - start.z) / len }
    const heading = Math.atan2(dir.z, dir.x)

    // Put a vehicle on the road, `back` metres before the END portal,
    // pointing into it.
    const place = (type, back) => {
      const id = `probe-${type}`
      const res = w.addVehicle({ id, type, speed: 8 })
      if (!res.ok) return null
      const lp = geo.lanePoint(road, 0, len - back)
      // `moveVehicleTo` re-snaps the vehicle onto the nearest lane —
      // which is exactly the tunnel road we want it on.
      w.moveVehicleTo(id, { x: lp.position.x, y: lp.position.y, z: lp.position.z })
      const v = w.network.vehicles[id]
      v.heading = heading
      v.speed = 8
      v.targetSpeed = 8
      return { id, x: lp.position.x, z: lp.position.z, roadId: v.roadId, lane: v.laneIndex }
    }

    // The junctions on this road — they stop the vehicle too (a red
    // light), so the probe has to know about them.
    const junctions = Object.values(net.intersections)
      .filter((i) => (i.connectedRoads ?? []).includes(road.id))
      .map((i) => ({
        id: i.id.slice(0, 12),
        s: +geo.intersectionCenterS(road, i).toFixed(1),
        lights: (i.trafficLights ?? []).map((l) => l.axis).join('|') || '(none)',
        distToEnd: +Math.hypot(i.position.x - end.x, i.position.z - end.z).toFixed(1),
      }))

    const bus = place('bus', 30)
    const car = place('car', 30)
    const t0 = performance.now()
    // Let the simulation run for a while.
    const samples = []
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 250))
      const v = w.network.vehicles[bus.id]
      const c = w.network.vehicles[car.id]
      samples.push({
        t: +((performance.now() - t0) / 1000).toFixed(1),
        busX: +v.position.x.toFixed(1),
        busSpeed: +v.speed.toFixed(2),
        busStatus: v.status,
        carX: +c.position.x.toFixed(1),
        carSpeed: +c.speed.toFixed(2),
      })
      if (i > 8 && samples.every((s) => s.busSpeed < 0.2 && s.carSpeed < 0.2)) break
    }
    return {
      limit,
      clearanceM: limit - ra.ROAD_MIN_HEIGHT_CLEARANCE_M,
      road: { id: road.id, start, end, len: +len.toFixed(1), heading: +heading.toFixed(3) },
      junctions,
      busStart: { x: +bus.x.toFixed(1), z: +bus.z.toFixed(1) },
      carStart: { x: +car.x.toFixed(1), z: +car.z.toFixed(1) },
      beams: w.getRapierWorld() ? w.getRapierWorld().clearanceBeamCount() : 'no rapierWorld',
      samples: samples.filter((_, i) => i % 4 === 0 || i === samples.length - 1),
      last: samples[samples.length - 1],
    }
  })
  console.log(JSON.stringify(out, null, 1))
  if (errors.length) console.log('PAGE ERRORS:', JSON.stringify(errors.slice(0, 5)))
  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
