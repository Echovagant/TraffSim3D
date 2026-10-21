/**
 * Plan 075 (S4): the AI Playground has to *draw* the comparison curve.
 *
 * The dashboard already had a "Reward 曲线" — a hand-written SVG polyline of
 * the raw per-episode training reward. That curve cannot be compared with
 * anything: it is a stochastic policy's sampled return, while the bar the
 * policy has to beat is the deterministic fixed 30/30 cycle. So this spec
 * asserts the two things the dashboard added:
 *
 *   1. the **comparison curve** — the policy's deterministic evaluation
 *      return against the training step, next to the baseline as a
 *      horizontal reference line, with the part above the baseline marked;
 *   2. the **multi-seed table** — every seed on the table, the ones that
 *      collapsed back onto `no_op` included.
 *
 * The gate is the *geometry*, not the presence of an element: a chart that
 * renders an empty `<svg>` would satisfy "the element exists" and prove
 * nothing. So the assertions read the actual `points` / `y1` / `y2`
 * attributes and check them against each other.
 *
 * The backend is stubbed — no training job has to run for this.
 */
import { test, expect } from '@playwright/test'

/** Plan 074 T9/T10's measured numbers. */
const EVAL_SERIES = [
  { step: 10000, return: -455.4, baseline: -423.1, condition: 'train' },
  { step: 20000, return: -440.2, baseline: -423.1, condition: 'train' },
  { step: 30000, return: -410.0, baseline: -423.1, condition: 'train' },
  { step: 40000, return: -399.9, baseline: -423.1, condition: 'train' },
]

const SEED_RESULTS = [
  {
    seed: 0,
    train_return: -399.9,
    train_actions: { no_op: 367, shorten_red: 233 },
    beats_train_baseline: true,
    eval_return: -498.2,
    eval_actions: { no_op: 358, shorten_red: 242 },
    beats_baseline: true,
    best_step: 280000,
    checkpoint: 'signal_seed0_step_0280000.zip',
  },
  {
    seed: 1,
    train_return: -400.9,
    train_actions: { no_op: 599, shorten_red: 1 },
    beats_train_baseline: true,
    eval_return: -507.9,
    eval_actions: { no_op: 599, shorten_red: 1 },
    beats_baseline: false,
    best_step: 280000,
    checkpoint: 'signal_seed1_step_0280000.zip',
  },
  {
    seed: 2,
    train_return: -423.1,
    train_actions: { no_op: 600 },
    beats_train_baseline: false,
    eval_return: -505.3,
    eval_actions: { no_op: 600 },
    beats_baseline: false,
    best_step: 10000,
    checkpoint: 'signal_seed2_step_0010000.zip',
  },
  {
    seed: 3,
    train_return: -423.1,
    train_actions: { no_op: 600 },
    beats_train_baseline: false,
    eval_return: -505.3,
    eval_actions: { no_op: 600 },
    beats_baseline: false,
    best_step: 10000,
    checkpoint: 'signal_seed3_step_0010000.zip',
  },
]

const FAKE_STATUS = {
  running: false,
  step: 40000,
  episode_count: 12,
  last_reward: -123.4,
  reward_history: [-240.1, -198.7, -301.5, -262.2, -180.4, -401.9, -222.6, -399.9],
  started_at_ms: Date.now() - 60_000,
  finished_at_ms: Date.now(),
  policy_kind: 'signal',
  signal_eval_series: EVAL_SERIES,
  signal_baselines: { train: -423.1, eval: -505.3, holdout: -393.8 },
  signal_seed_results: SEED_RESULTS,
  best_seed: 0,
  signal_holdout_return: -375.4,
}

/** The points of an SVG `points` attribute, as `[x, y]` pairs. */
const parsePoints = (attribute: string | null): Array<[number, number]> =>
  (attribute ?? '')
    .trim()
    .split(/\s+/)
    .filter((part) => part.includes(','))
    .map((part) => {
      const [x, y] = part.split(',')
      return [Number(x), Number(y)] as [number, number]
    })

test.describe('AI Playground — the training curve (Plan 075)', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/v1/rl/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(FAKE_STATUS),
      })
    })
    await page.route('**/api/v1/rl/train', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{"ok":true,"dry_run":true}',
      })
    })
    await page.route('**/api/v1/rl/capabilities', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          torch_version: '2.12.1+cpu',
          cuda_available: false,
          device_count: 0,
          device_name: '',
          vram_gb: 0.0,
          sb3_available: true,
          min_vram_gb: 2.0,
          device_fallback_reason: 'cuda_not_available',
        }),
      })
    })
  })

  test('draws the comparison curve against the fixed-cycle baseline', async ({ page }) => {
    await page.goto('/ai-playground')

    const chart = page.locator('[data-testid="eval-curve-chart"]')
    await expect(chart).toBeVisible()

    // --- the curve itself: one point per evaluation ---------------------
    const curvePoints = parsePoints(
      await page.locator('[data-testid="eval-curve-line"]').getAttribute('points'),
    )
    expect(curvePoints).toHaveLength(EVAL_SERIES.length)
    // The x axis is the training step: it grows, and it is not a vertical
    // line (a broken scale would put every point on the same x).
    for (let index = 1; index < curvePoints.length; index++) {
      expect(curvePoints[index]![0]).toBeGreaterThan(curvePoints[index - 1]![0])
    }
    // The curve climbs from -455.4 to -399.9, so it ends higher on screen.
    expect(curvePoints[0]![1]).toBeGreaterThan(curvePoints[curvePoints.length - 1]![1])

    // --- the baseline: a horizontal reference line ----------------------
    const baseline = page.locator('[data-testid="eval-baseline-line"]')
    // `toBeAttached`, not `toBeVisible`: a horizontal <line> has a
    // zero-height bounding box, which Playwright counts as hidden. The
    // geometry is what matters here, and it is asserted below.
    await expect(baseline).toBeAttached()
    const y1 = Number(await baseline.getAttribute('y1'))
    const y2 = Number(await baseline.getAttribute('y2'))
    expect(Number.isNaN(y1)).toBe(false)
    expect(y1).toBe(y2)
    // The baseline (-423.1) is between the worst (-455.4) and the best
    // (-399.9) evaluation. In SVG coordinates a smaller y is a higher
    // value, so the line sits below the best point and above the worst.
    const ys = curvePoints.map(([, y]) => y)
    expect(y1).toBeGreaterThan(Math.min(...ys))
    expect(y1).toBeLessThan(Math.max(...ys))

    // --- the part above the baseline is marked --------------------------
    const marked = page.locator('[data-testid="eval-curve-above"] polyline')
    expect(await marked.count()).toBe(1)
    const markedPoints = parsePoints(await marked.first().getAttribute('points'))
    expect(markedPoints.length).toBeGreaterThanOrEqual(2)
    for (const [, y] of markedPoints) {
      expect(y).toBeLessThanOrEqual(y1 + 0.05)
    }
    // The marked piece ends on the best evaluation, which is strictly above
    // the baseline.
    expect(markedPoints[markedPoints.length - 1]![1]).toBeLessThan(y1 - 0.5)

    // The condition the numbers belong to is on the screen.
    await expect(page.locator('[data-testid="eval-curve-condition"]')).toContainText('训练条件')
  })

  test('lists every seed — the collapsed ones included', async ({ page }) => {
    await page.goto('/ai-playground')

    const table = page.locator('[data-testid="signal-seed-table"]')
    await expect(table).toBeVisible()

    const rows = page.locator('[data-testid="signal-seed-row"]')
    await expect(rows).toHaveCount(SEED_RESULTS.length)
    expect(await rows.evaluateAll((els) => els.map((el) => el.getAttribute('data-seed')))).toEqual([
      '0',
      '1',
      '2',
      '3',
    ])

    // The two seeds that collapsed onto `no_op` are on the table and are
    // marked as collapsed — the ~50 % success rate has to be visible.
    await expect(page.locator('[data-testid="seed-collapsed-badge"]')).toHaveCount(2)
    const collapsedRows = page.locator('[data-testid="signal-seed-row"]', {
      has: page.locator('[data-testid="seed-collapsed-badge"]'),
    })
    await expect(collapsedRows).toHaveCount(2)
    await expect(
      collapsedRows.first().locator('[data-testid="seed-value-beats-train"]'),
    ).toHaveText('❌')
    await expect(collapsedRows.first().locator('[data-testid="seed-value-actions"]')).toHaveText(
      'no_op 600',
    )

    // The success rate and the generalisation gap are on the screen.
    await expect(page.locator('[data-testid="seed-summary"]')).toContainText('2/4')
    await expect(page.locator('[data-testid="generalisation-gap"]')).toContainText('5.5%')
    await expect(page.locator('[data-testid="generalisation-gap"]')).toContainText('1.4%')
  })

  test('keeps the raw reward curve, labelled as the noisy sampled return', async ({ page }) => {
    await page.goto('/ai-playground')

    await expect(page.locator('[data-testid="reward-chart"]')).toBeVisible()
    await expect(page.locator('[data-testid="reward-curve-note"]')).toContainText('采样')
    await expect(page.locator('[data-testid="reward-curve-note"]')).toContainText('噪声')
  })
})
