/**
 * 探针：限高门架的特写镜头（跟拍版）。
 *
 * 做三件事：
 *   1. 把一辆**公交**放到隧道口的引道上 —— 它进不去，会被门架挡住；
 *   2. 把一辆**小车**放在它后面；
 *   3. 跟拍那辆小车：门架在它前方，公交停在门口。
 *
 * 截图给我看构图对不对。
 *
 * 用法：node scripts/probe-gantry-closeup.mjs [--url http://127.0.0.1:5188]
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
const OUT = path.resolve(process.cwd(), '..', '.tmp')

const main = async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 200)))
  await page.goto(`${URL}/smart-city`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="osm-building-count"]')
      return Boolean(el && Number((el.textContent ?? '0').replace(/\D/g, '')) > 0)
    },
    undefined,
    { timeout: 120_000 },
  )
  await page.waitForTimeout(9_000)

  const plan = await page.evaluate(async () => {
    const ra = await import('/src/domain/services/roadAccess.ts')
    const geo = await import('/src/domain/services/laneGeometry.ts')
    const w = window.__world
    const limited = Object.values(w.network.roads).filter((r) => ra.roadHeightLimitM(r) !== null)
    // The road whose traffic MEETS a portal: the portal stands at the
    // road's END in the direction of travel (lane 0), so the vehicles
    // have to be on a road whose forward direction ends at a portal.
    const tunnel =
      limited.find((r) => {
        const wps = geo.roadWaypoints(r)
        const last = wps[wps.length - 1]
        return Object.values(w.network.intersections).some(
          (i) =>
            (i.connectedRoads ?? []).includes(r.id) &&
            Math.hypot(i.position.x - last.x, i.position.z - last.z) < 8,
        )
      }) ?? limited[0]
    const start = geo.roadWaypoints(tunnel)[0]
    // The mouth: the junction at the tunnel's start.
    const mouth = Object.values(w.network.intersections)
      .filter((i) => (i.connectedRoads ?? []).includes(tunnel.id))
      .map((i) => ({ i, d: Math.hypot(i.position.x - start.x, i.position.z - start.z) }))
      .sort((a, b) => a.d - b.d)[0]?.i
    if (!mouth) return { ok: false, why: 'no mouth' }
    // The vehicles go on the TUNNEL road itself, driving towards its
    // start (where the portal stands). On the tunnel road there is no
    // other road nearby, so the lane guard has nothing to pull them
    // back from — on the APPROACH road they sat within a few metres
    // of the tunnel way, and the guard kept snapping them back (and
    // logging it).
    const len = geo.roadLength(tunnel)
    const laneIndex = 0 // the forward lane: the traffic meets the portal
    const spec = w.getRapierWorld()
    // Place a vehicle `back` metres from the tunnel's START, on the
    // backward lane, driving towards it.
    const place = (type, back) => {
      const s = Math.max(0, Math.min(len, back))
      const lp = geo.lanePoint(tunnel, laneIndex, s)
      const car = Object.values(w.network.vehicles).find((v) => v.type === type && !v.__placed)
      if (!car) return null
      car.__placed = true
      const v = w.network.vehicles[car.id]
      v.roadId = tunnel.id
      v.laneIndex = laneIndex
      v.s = s
      v.position = { x: lp.position.x, y: lp.position.y, z: lp.position.z }
      v.heading = lp.heading
      v.speed = 9
      v.targetSpeed = 9
      v.status = 'driving'
      v.desiredStatus = 'driving'
      spec?.setVehiclePosition(car.id, { x: lp.position.x, y: lp.position.y, z: lp.position.z })
      spec?.setVehicleSpeed(car.id, 9, lp.heading)
      return { id: car.id, s: +s.toFixed(1), pos: { x: lp.position.x, z: lp.position.z } }
    }
    // Far from the shared junction: the two tunnel roads converge at
    // one end, and near that junction the tick's lane snap picks the
    // PARALLEL road (the car then drives away in the wrong direction).
    const bus = place('bus', len - 75)
    const car = place('car', len - 100)
    if (car) w.setRideVehicle(car.id, 'chase')
    return {
      ok: true,
      tunnel: tunnel.id,
      limit: ra.roadHeightLimitM(tunnel),
      approach: tunnel.id,
      laneIndex,
      forward: false,
      mouth: { x: mouth.position.x, z: mouth.position.z },
      bus,
      car,
    }
  })
  console.log('plan:', JSON.stringify(plan))
  if (!plan.ok || !plan.car) throw new Error('no plan')
  // Two-step placement: the tick's lane-frame sync rewrites the
  // vehicle's roadId/laneIndex/s to the NEAREST lane — and the lane
  // guard compares the position against THAT lane. So: let the tick
  // pick the lane, then replay the placement onto exactly the lane
  // point it chose. One step alone leaves a 5 m gap and the guard
  // fires (and keeps firing) every frame.
  await page.waitForTimeout(2_500)
  const exact = await page.evaluate(
    async (ids) => {
      const geo = await import('/src/domain/services/laneGeometry.ts')
      const w = window.__world
      const spec = w.getRapierWorld()
      const out = {}
      for (const [key, id] of Object.entries(ids)) {
        const v = w.network.vehicles[id]
        if (!v) continue
        const road = w.network.roads[v.roadId]
        if (!road) continue
        const lp = geo.lanePoint(road, v.laneIndex, v.s)
        v.position = { x: lp.position.x, y: lp.position.y, z: lp.position.z }
        v.heading = lp.heading
        spec?.setVehiclePosition(id, { x: lp.position.x, y: lp.position.y, z: lp.position.z })
        spec?.setVehicleSpeed(id, v.speed, lp.heading)
        out[key] = { roadId: v.roadId, laneIndex: v.laneIndex, s: +v.s.toFixed(1) }
      }
      return out
    },
    { bus: plan.bus.id, car: plan.car.id },
  )
  console.log('exact lanes:', JSON.stringify(exact))
  await page.waitForTimeout(1_200)
  await page.evaluate(() => window.__clearCityEvents?.())
  console.log('events cleared')

  for (const [i, wait] of [0, 3000, 3000, 3000, 3000, 3000].entries()) {
    await page.waitForTimeout(wait)
    const file = path.join(OUT, `gantry-closeup-${i}.png`)
    await page.screenshot({ path: file })
    const state = await page.evaluate(
      (ids) => {
        const w = window.__world
        const b = w.network.vehicles[ids.bus]
        const c = w.network.vehicles[ids.car]
        return {
          bus: b
            ? { x: +b.position.x.toFixed(1), z: +b.position.z.toFixed(1), v: +b.speed.toFixed(1) }
            : null,
          car: c
            ? { x: +c.position.x.toFixed(1), z: +c.position.z.toFixed(1), v: +c.speed.toFixed(1) }
            : null,
        }
      },
      { bus: plan.bus.id, car: plan.car.id },
    )
    console.log(`shot ${i}:`, file, JSON.stringify(state))
  }
  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
