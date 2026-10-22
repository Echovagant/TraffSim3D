// src/interfaces/views/AIPlaygroundTrainingCurve.spec.ts
//
// The training-curve UI must make the *measurement* legible.
//
// The raw reward curve that was already there is a sampled per-episode
// return — noisy, and not comparable with anything. What the dashboard has
// to add is:
//
//   1. the policy's **deterministic evaluation return** against the training
//      step, drawn next to the fixed-cycle baseline it has to beat, with the
//      part **above** the baseline marked;
//   2. the **multi-seed table**, every seed included — the ones that
//      collapsed back onto `no_op` especially, because the ~50 % success
//      rate is only honest if the failures are on the table.
//
// The numbers below are the ones a real training run measured, so the spec
// describes a real run rather than a convenient fiction.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import AIPlaygroundView from './AIPlaygroundView.vue'

/** The evaluation series: one point per evaluation, on the training condition. */
const EVAL_SERIES = [
  { step: 10000, return: -455.4, baseline: -423.1, condition: 'train' },
  { step: 20000, return: -440.2, baseline: -423.1, condition: 'train' },
  { step: 30000, return: -410.0, baseline: -423.1, condition: 'train' },
  { step: 40000, return: -399.9, baseline: -423.1, condition: 'train' },
]

/** Two seeds beat the baseline, two collapsed onto `no_op`. */
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
  started_at_ms: 1_700_000_000_000,
  finished_at_ms: 1_700_000_060_000,
  policy_kind: 'signal',
  signal_eval_series: EVAL_SERIES,
  signal_baselines: { train: -423.1, eval: -505.3, holdout: -393.8 },
  signal_seed_results: SEED_RESULTS,
  best_seed: 0,
  signal_holdout_return: -375.4,
}

const mockResponse = (body: unknown, status = 200): Response => {
  const text = JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Err',
    text: async () => text,
    json: async () => body,
  } as unknown as Response
}

/** The points of an SVG `points` attribute, as `[x, y]` pairs. */
const parsePoints = (attribute: string | undefined): Array<[number, number]> =>
  (attribute ?? '')
    .trim()
    .split(/\s+/)
    .filter((part) => part.includes(','))
    .map((part) => {
      const [x, y] = part.split(',')
      return [Number(x), Number(y)] as [number, number]
    })

describe('AIPlaygroundView — the training curve', () => {
  let fetchSpy: ReturnType<typeof vi.fn>
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    setActivePinia(createPinia())
    fetchSpy = vi.fn()
    ;(globalThis as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch
    fetchSpy.mockImplementation((url: string) => {
      if (String(url).includes('/rl/status')) {
        return Promise.resolve(mockResponse(FAKE_STATUS))
      }
      return Promise.resolve(mockResponse({}, 404))
    })
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    vi.restoreAllMocks()
  })

  const mountView = async (): Promise<VueWrapper> => {
    wrapper = mount(AIPlaygroundView, { global: { stubs: { RouterLink: true } } })
    // The view loads the status on mount; let the fetch chain settle.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()
    return wrapper
  }

  const mountViewWithStatus = async (status: unknown): Promise<VueWrapper> => {
    fetchSpy.mockImplementation((url: string) => {
      if (String(url).includes('/rl/status')) {
        return Promise.resolve(mockResponse(status))
      }
      return Promise.resolve(mockResponse({}, 404))
    })
    return mountView()
  }

  it('draws the evaluation curve with one point per evaluation', async () => {
    const view = await mountView()

    const line = view.get('[data-testid="eval-curve-line"]')
    const points = parsePoints(line.attributes('points'))
    expect(points).toHaveLength(EVAL_SERIES.length)
    // The x axis is the training step, so it grows with the step.
    for (let index = 1; index < points.length; index++) {
      expect(points[index]![0]).toBeGreaterThan(points[index - 1]![0])
    }
    // The first point is the worst (-455.4) and the last the best (-399.9),
    // so the curve climbs: in SVG coordinates "up" is a smaller y.
    expect(points[0]![1]).toBeGreaterThan(points[points.length - 1]![1])
  })

  it('draws the fixed-cycle baseline as a horizontal reference line', async () => {
    const view = await mountView()

    const baseline = view.get('[data-testid="eval-baseline-line"]')
    const y1 = Number(baseline.attributes('y1'))
    const y2 = Number(baseline.attributes('y2'))
    expect(Number.isNaN(y1)).toBe(false)
    // A reference line is horizontal.
    expect(y1).toBe(y2)

    // The baseline (-423.1) lies between the worst (-455.4) and the best
    // (-399.9) evaluation, so the line has to sit between the curve's
    // extreme points. In SVG coordinates a smaller y is a higher value, so
    // the baseline is below the best point and above the worst one.
    const curve = parsePoints(view.get('[data-testid="eval-curve-line"]').attributes('points'))
    const ys = curve.map(([, y]) => y)
    expect(y1).toBeGreaterThan(Math.min(...ys))
    expect(y1).toBeLessThan(Math.max(...ys))

    // The label says which condition the numbers belong to.
    expect(view.get('[data-testid="eval-curve-condition"]').text()).toContain('训练条件')
  })

  it('marks the part of the curve that is above the baseline', async () => {
    const view = await mountView()

    const marked = view.findAll('[data-testid="eval-curve-above"] polyline')
    // The curve climbs over the baseline between the 2nd and the 3rd point,
    // so there is exactly one marked piece.
    expect(marked).toHaveLength(1)

    const baselineY = Number(view.get('[data-testid="eval-baseline-line"]').attributes('y1'))
    const markedPoints = parsePoints(marked[0]!.attributes('points'))
    expect(markedPoints.length).toBeGreaterThanOrEqual(2)
    // Every marked point is on or above the baseline (smaller y = higher).
    for (const [, y] of markedPoints) {
      expect(y).toBeLessThanOrEqual(baselineY + 0.05)
    }
    // The marked piece ends on the best evaluation (-399.9), which is
    // strictly above the baseline.
    expect(markedPoints[markedPoints.length - 1]![1]).toBeLessThan(baselineY - 0.5)

    expect(view.get('[data-testid="eval-curve-verdict"]').text()).toContain('曾高于基线')
  })

  it('clips the marked piece at a crossing that goes the other way', async () => {
    // The curve starts above the baseline and falls back below it: the
    // marked piece has to end exactly on the baseline line, not carry on
    // into the region that is below it.
    const view = await mountViewWithStatus({
      ...FAKE_STATUS,
      signal_eval_series: [
        { step: 10000, return: -399.9, baseline: -423.1, condition: 'train' },
        { step: 20000, return: -410.0, baseline: -423.1, condition: 'train' },
        { step: 30000, return: -455.4, baseline: -423.1, condition: 'train' },
      ],
    })

    const baselineY = Number(view.get('[data-testid="eval-baseline-line"]').attributes('y1'))
    const marked = view.findAll('[data-testid="eval-curve-above"] polyline')
    expect(marked).toHaveLength(1)

    const markedPoints = parsePoints(marked[0]!.attributes('points'))
    expect(markedPoints.length).toBeGreaterThanOrEqual(2)
    // The first point is above the baseline, the last one sits on it.
    expect(markedPoints[0]![1]).toBeLessThan(baselineY - 0.5)
    expect(markedPoints[markedPoints.length - 1]![1]).toBeCloseTo(baselineY, 1)
  })

  it('marks nothing when the curve never beats the baseline', async () => {
    const view = await mountViewWithStatus({
      ...FAKE_STATUS,
      signal_eval_series: [
        { step: 10000, return: -455.4, baseline: -423.1, condition: 'train' },
        { step: 20000, return: -440.2, baseline: -423.1, condition: 'train' },
      ],
    })

    expect(view.findAll('[data-testid="eval-curve-above"] polyline')).toHaveLength(0)
    expect(view.get('[data-testid="eval-curve-verdict"]').text()).toContain('从未高于基线')
  })

  it('shows every seed in the multi-seed table — the collapsed ones included', async () => {
    const view = await mountView()

    const rows = view.findAll('[data-testid="signal-seed-row"]')
    expect(rows).toHaveLength(SEED_RESULTS.length)
    expect(rows.map((row) => row.attributes('data-seed'))).toEqual(['0', '1', '2', '3'])

    // The two seeds that collapsed back onto `no_op` are on the table, and
    // they are marked as collapsed — hiding them would hide the ~50 %
    // success rate.
    const collapsed = view.findAll('[data-testid="seed-collapsed-badge"]')
    expect(collapsed).toHaveLength(2)
    const collapsedRows = rows.filter((row) =>
      row.find('[data-testid="seed-collapsed-badge"]').exists(),
    )
    expect(collapsedRows.map((row) => row.attributes('data-seed'))).toEqual(['2', '3'])
    for (const row of collapsedRows) {
      expect(row.get('[data-testid="seed-value-beats-train"]').text()).toBe('❌')
      expect(row.get('[data-testid="seed-value-beats-eval"]').text()).toBe('❌')
      expect(row.get('[data-testid="seed-value-actions"]').text()).toBe('no_op 600')
    }

    // The winner's row carries both conditions' numbers.
    const winner = rows[0]!
    expect(winner.get('[data-testid="seed-value-train"]').text()).toBe('-399.9')
    expect(winner.get('[data-testid="seed-value-eval"]').text()).toBe('-498.2')
    expect(winner.get('[data-testid="seed-value-beats-train"]').text()).toBe('✅')

    // The success rate is stated, not implied.
    const summary = view.get('[data-testid="seed-summary"]').text()
    expect(summary).toContain('2/4')
    expect(summary).toContain('50')
  })

  it('makes the generalisation gap visible in one screen', async () => {
    const view = await mountView()

    // +23.2 (5.5 %) on the training condition, +7.1 (1.4 %)
    // on the held-out evaluation condition.
    const gap = view.get('[data-testid="generalisation-gap"]').text()
    expect(gap).toContain('23.2')
    expect(gap).toContain('5.5%')
    expect(gap).toContain('7.1')
    expect(gap).toContain('1.4%')
  })

  it('labels the raw reward curve as the noisy sampled return', async () => {
    const view = await mountView()

    // The old curve is kept — but it must not be mistaken for the
    // evaluation curve.
    const note = view.get('[data-testid="reward-curve-note"]').text()
    expect(note).toContain('采样')
    expect(note).toContain('噪声')
    expect(view.find('[data-testid="reward-line"]').exists()).toBe(true)
  })

  it('says the curve is synthetic when the run was a dry run', async () => {
    // A dry run's series is fabricated by construction. Calling it a
    // "sampled return" would dress synthetic data up as a measurement.
    const view = await mountViewWithStatus({
      ...FAKE_STATUS,
      reason: 'dry_run_completed',
      device: 'dry_run',
      latest_checkpoint: 'ppo_step_0000400.zip (dry_run)',
    })

    const note = view.get('[data-testid="reward-curve-note"]').text()
    expect(note).toContain('合成')
    expect(note).not.toContain('采样')

    const provenance = view.get('[data-testid="run-provenance"]').text()
    expect(provenance).toContain('未执行 PPO')
  })

  it('shows neither the curve nor the table when the run measured nothing', async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (String(url).includes('/rl/status')) {
        return Promise.resolve(
          mockResponse({
            running: false,
            step: 0,
            episode_count: 0,
            last_reward: 0,
            reward_history: [],
            started_at_ms: 0,
            finished_at_ms: null,
          }),
        )
      }
      return Promise.resolve(mockResponse({}, 404))
    })

    const view = await mountView()

    expect(view.find('[data-testid="eval-curve-chart"]').exists()).toBe(false)
    expect(view.find('[data-testid="signal-seed-table"]').exists()).toBe(false)
  })
})
