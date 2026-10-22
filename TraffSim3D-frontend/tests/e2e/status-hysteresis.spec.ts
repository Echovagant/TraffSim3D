/**
 * Verification: status hysteresis at startup.
 *
 * The defect is 状态闪烁 — the status oscillating
 * driving → waiting → driving at the speed threshold. The fix was hysteresis
 * (separated enter/exit thresholds plus a 0.5s dwell).
 *
 * So the property under test is "the status does not oscillate", NOT "the
 * status is always driving". The previous assertion was
 * `expect(samples.at(-1)).toBe('driving')`, which conflated the two: a vehicle
 * that legally stops at a red light inside the 3s sampling window failed the
 * test even though there was no flicker at all. Observed 2026-10-17: one run
 * produced [..., 'driving', 'waiting'] and failed; the next run produced all
 * 'driving' and passed.
 *
 * The assertion below counts transitions instead. One transition (stopping,
 * or pulling away) is correct traffic behaviour; rapid oscillation is the bug.
 */
import { test, expect } from '@playwright/test'
import { waitForSceneReady } from './helpers/wait'

test('status does not flicker at startup (hysteresis)', async ({ page }) => {
  await waitForSceneReady(page)
  // Sample statuses 6 times over 3 seconds
  const samples: (string | null)[] = []
  for (let i = 0; i < 6; i++) {
    const status = await page.evaluate(() => {
      const w = window as unknown as {
        __world?: { network: { vehicles: Record<string, { status: string }> } }
      }
      return w.__world?.network?.vehicles?.['v-1']?.status ?? null
    })
    samples.push(status)
    await page.waitForTimeout(500)
  }
  console.log('Status samples (over 3s):', samples)

  // Every sample must actually resolve to a status (null would mean the
  // vehicle vanished and the test is measuring nothing).
  expect(samples.every((s) => s !== null)).toBe(true)

  // Count how many times the status changed across the window.
  const transitions = samples.filter((s, i) => i > 0 && s !== samples[i - 1]).length
  console.log(`Status transitions in 3s: ${transitions}`)

  // Flicker = at least two back-and-forth changes inside 3 seconds.
  expect(transitions).toBeLessThanOrEqual(1)
})
