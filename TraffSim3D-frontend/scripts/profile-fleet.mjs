/** CDP CPU profile（临时）：372 车场景热点定位。 */
import { chromium } from '@playwright/test'
import * as fs from 'node:fs'

const browser = await chromium.launch({
  headless: false,
  args: [
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-features=CalculateNativeWinOcclusion',
  ],
})
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = await context.newPage()
const cdp = await context.newCDPSession(page)
await cdp.send('Profiler.enable')
await page.goto('http://127.0.0.1:5188/smart-city', { waitUntil: 'domcontentloaded' })
await page.waitForFunction(
  () => {
    const el = document.querySelector('[data-testid="osm-building-count"]')
    return Boolean(el && Number((el.textContent ?? '0').replace(/\D/g, '')) > 0)
  },
  undefined,
  { timeout: 180_000 },
)
await page.waitForTimeout(15_000)
await cdp.send('Profiler.start')
await page.waitForTimeout(6_000)
const { profile } = await cdp.send('Profiler.stop')
fs.writeFileSync('D:/Projects/TraffSim3D/.tmp/cpu-fleet.json', JSON.stringify(profile))

const { nodes, samples, timeDeltas } = profile
const byId = new Map(nodes.map((n) => [n.id, n]))
let total = 0
const cnt = new Map()
for (let i = 0; i < samples.length; i++) {
  cnt.set(samples[i], (cnt.get(samples[i]) ?? 0) + 1)
  total += timeDeltas[i] ?? 0
}
const selfUs = new Map()
for (const [id, c] of cnt) selfUs.set(id, (c * total) / samples.length)
const parentOf = new Map()
for (const n of nodes) for (const ch of n.children ?? []) parentOf.set(ch, n.id)
const cf = (n) =>
  `${n.callFrame.functionName || '(anon)'} @ ${(n.callFrame.url || '').split('/').pop()}:${n.callFrame.lineNumber + 1}`
const chain = (id) => {
  const out = []
  let cur = id
  const seen = new Set()
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    const n = byId.get(cur)
    if (!n) break
    out.push(cf(n))
    cur = parentOf.get(cur)
  }
  return out
}
for (const [id, us] of [...selfUs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  const n = byId.get(id)
  console.log(`[${(us / 1000).toFixed(0)} ms | ${((100 * us) / total).toFixed(1)}%] ${cf(n)}`)
  const ch = chain(id)
  if (ch.length > 1) console.log(`    ← ${ch.slice(1, 4).join(' ← ')}`)
}
await browser.close()
