/**
 * 探针：导入城区里有几条带限高的路、限高多少、路怎么走。
 *
 * 用法：node scripts/probe-height-roads.mjs [--url http://127.0.0.1:5188]
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
  await page.goto(`${URL}/smart-city`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="osm-building-count"]')
      return Boolean(el && Number((el.textContent ?? '0').replace(/\D/g, '')) > 0)
    },
    undefined,
    { timeout: 120_000 },
  )
  await page.waitForTimeout(4_000)
  const out = await page.evaluate(async () => {
    const ra = await import('/src/domain/services/roadAccess.ts')
    const geo = await import('/src/domain/services/laneGeometry.ts')
    const net = window.__world.network
    const limited = Object.values(net.roads).filter((r) => ra.roadHeightLimitM(r) !== null)
    return {
      roads: Object.keys(net.roads).length,
      limited: limited.length,
      sample: limited.slice(0, 8).map((r) => {
        const wp = geo.roadWaypoints(r)
        return {
          id: r.id.slice(0, 16),
          limit: ra.roadHeightLimitM(r),
          widthM: +ra.roadWidthM(r).toFixed(1),
          lenM: +geo.roadLength(r).toFixed(0),
          pts: wp.length,
          start: { x: +wp[0].x.toFixed(1), z: +wp[0].z.toFixed(1) },
          end: { x: +wp[wp.length - 1].x.toFixed(1), z: +wp[wp.length - 1].z.toFixed(1) },
          y0: wp[0].y,
          yEnd: wp[wp.length - 1].y,
        }
      }),
    }
  })
  console.log(JSON.stringify(out, null, 1))
  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
