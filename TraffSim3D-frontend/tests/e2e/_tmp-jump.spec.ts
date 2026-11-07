import { test } from '@playwright/test'
import { waitForSceneReady, switchScene } from './helpers/wait'

test('jump hunt', async ({ page }) => {
  test.setTimeout(180_000)
  await waitForSceneReady(page)
  await switchScene(page, 'micro-city')
  await page.evaluate(() => {
    const w = window as unknown as { __world?: { setTickRate?: (n: number) => void } }
    w.__world?.setTickRate?.(4)
  })
  await page.evaluate(() => {
    const buf: unknown[] = []
    ;(window as unknown as { __j?: unknown[] }).__j = buf
    const t0 = performance.now()
    setInterval(() => {
      const w = window as unknown as {
        __world?: { network: { vehicles: Record<string, Record<string, unknown>> } }
      }
      const wt = Math.round(performance.now() - t0)
      for (const [id, v] of Object.entries(w.__world?.network.vehicles ?? {})) {
        ;(window as unknown as { __j?: unknown[] }).__j!.push({
          wt, id, road: v.roadId, lane: v.laneIndex,
          x: Math.round((v.position.x as number) * 100) / 100,
          z: Math.round((v.position.z as number) * 100) / 100,
          s: Math.round((v.s as number) * 100) / 100,
          sp: Math.round((v.speed as number) * 100) / 100,
          st: v.status,
        })
      }
    }, 120)
  })
  await page.waitForTimeout(45000)
  const out = await page.evaluate(() => {
    const rows = (window as unknown as { __j?: any[] }).__j ?? []
    const per: Record<string, any[]> = {}
    for (const r of rows) (per[r.id] ??= []).push(r)
    const jumps: unknown[] = []
    for (const [id, rs] of Object.entries(per)) {
      for (let i = 1; i < rs.length; i++) {
        const a = rs[i - 1], b = rs[i]
        const d = Math.hypot(b.x - a.x, b.z - a.z)
        const gap = (b.wt - a.wt) / 1000
        if (d > 6) {
          jumps.push({
            id, d: Math.round(d * 10) / 10, gap: Math.round(gap * 1000) / 1000,
            spA: a.sp, spB: b.sp, stA: a.st, stB: b.st,
            roadA: a.road, roadB: b.road, laneA: a.lane, laneB: b.lane,
            sA: a.s, sB: b.s,
          })
        }
      }
    }
    return { jumps: jumps.slice(0, 14), total: jumps.length }
  })
  console.log('JUMPS ' + JSON.stringify(out))
})
