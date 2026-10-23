// src/infrastructure/api/rlStatus.spec.ts
//
// The contract test for `/api/v1/rl/status`.
//
// The failure this replaces: the view read the payload with
// `(await r.json()) as Status`. A renamed backend field produced no
// compile error and no test failure — the panel just showed a
// plausible wrong number. `parseRLStatus()` turns that into a loud,
// specific error.

import { describe, it, expect } from 'vitest'
import { parseRLStatus, RLStatusContractError, type RLStatusCore } from './rlStatus'

/** The payload the backend returns when no run has happened yet. */
const EMPTY_STATUS = {
  running: false,
  paused: false,
  step: 0,
  episode_count: 0,
  last_reward: 0.0,
  reward_history: [],
  started_at_ms: 0,
  finished_at_ms: null,
  latest_checkpoint: '',
  n_agents: 0,
  independent_agents: false,
}

describe('parseRLStatus', () => {
  it('accepts the backend\'s "no run yet" payload', () => {
    const status = parseRLStatus(EMPTY_STATUS)
    expect(status.running).toBe(false)
    expect(status.finished_at_ms).toBeNull()
    expect(status.reward_history).toEqual([])
  })

  it('accepts a live run and keeps the fields the UI reads', () => {
    const status = parseRLStatus({
      ...EMPTY_STATUS,
      running: true,
      paused: true,
      step: 42,
      total_steps: 200,
      episode_count: 7,
      last_reward: -12.5,
      reward_history: [-1, -2, -3],
      started_at_ms: 1_700_000_000_000,
      finished_at_ms: null,
      device: 'gpu',
      scene_kind: 'cross',
      latest_checkpoint: 'ppo_step_0000040.zip',
      n_agents: 2,
      independent_agents: true,
    })
    expect(status.step).toBe(42)
    expect(status.paused).toBe(true)
    expect(status.device).toBe('gpu')
    expect(status.independent_agents).toBe(true)
  })

  it('rejects a payload whose core field was renamed', () => {
    // `step` → `steps`: exactly the kind of change an unchecked cast
    // would have swallowed.
    const broken = { ...EMPTY_STATUS } as Record<string, unknown>
    delete broken.step
    broken.steps = 42

    expect(() => parseRLStatus(broken)).toThrow(RLStatusContractError)
    expect(() => parseRLStatus(broken)).toThrow(/step is missing/)
  })

  it('rejects a payload whose field changed type', () => {
    expect(() => parseRLStatus({ ...EMPTY_STATUS, running: 'yes' })).toThrow(
      /running should be boolean/,
    )
    expect(() => parseRLStatus({ ...EMPTY_STATUS, reward_history: ['a'] })).toThrow(
      /reward_history should be number\[\]/,
    )
    expect(() => parseRLStatus({ ...EMPTY_STATUS, finished_at_ms: 'never' })).toThrow(
      /finished_at_ms should be number\|null/,
    )
  })

  it('rejects a non-object payload', () => {
    expect(() => parseRLStatus(null)).toThrow(/not a JSON object/)
    expect(() => parseRLStatus([])).toThrow(/not a JSON object/)
  })

  it('passes unknown extra fields through (forward compatible)', () => {
    const status = parseRLStatus<
      RLStatusCore & { signal_eval_series?: unknown[]; something_new?: string }
    >({
      ...EMPTY_STATUS,
      signal_eval_series: [{ step: 1, ret: -3 }],
      something_new: 'added later',
    })
    expect(status.signal_eval_series).toEqual([{ step: 1, ret: -3 }])
    expect(status.something_new).toBe('added later')
  })
})
