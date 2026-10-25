// Regression tests for the RL weights request timeout.
//
// The "load the trained policy and watch it drive" demo fetches
// `GET /rl/checkpoints/{name}/weights`. That endpoint loads a ~155 KB SB3
// PPO checkpoint on the backend and serialises its `state_dict()` to JSON —
// seconds on a cold backend. The shared client default is 3000 ms, so the
// very first load aborted with
//
//   BackendError: GET /api/v1/rl/checkpoints/ppo_step_0230000.zip/weights
//   timed out after 3000ms (elapsed 3036 ms)
//
// and the demo simply never ran. The weights request now carries its own
// 15 s budget; every other endpoint keeps the shared 3 s default.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { BackendError, createHttpClient } from './httpClient'
import {
  createRLWeightsClient,
  GRID_POLICY_TIMEOUT_MS,
  RL_WEIGHTS_TIMEOUT_MS,
} from './rlWeightsClient'

/** A fetch that never settles until the request is aborted. */
const hangingFetch = () =>
  vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
      }),
  )

describe('RL weights client', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('gives the weights request its own generous timeout', () => {
    expect(RL_WEIGHTS_TIMEOUT_MS).toBe(30000)
    expect(RL_WEIGHTS_TIMEOUT_MS).toBeGreaterThan(3000)
  })

  it('survives past the shared 3 s default and gives up at its own budget', async () => {
    vi.useFakeTimers()
    const fetchMock = hangingFetch()
    vi.stubGlobal('fetch', fetchMock)

    const client = createRLWeightsClient(createHttpClient('/api/v1'))

    let settled = false
    const pending = client.getCheckpointWeights('ppo_step_0230000.zip').catch((err) => {
      settled = true
      throw err
    })
    // The rejection lands while the clock is advanced, before the
    // assertions below attach a handler — keep it from being reported as
    // an unhandled rejection.
    pending.catch(() => undefined)

    // The old failure point: 3 s in, the request must still be alive.
    await vi.advanceTimersByTimeAsync(3000)
    expect(settled).toBe(false)

    // ...and it must fail with its own budget, not the shared default.
    await vi.advanceTimersByTimeAsync(RL_WEIGHTS_TIMEOUT_MS)
    await expect(pending).rejects.toThrow(/timed out after 30000ms/)
    await expect(pending).rejects.toBeInstanceOf(BackendError)
  })

  it('leaves every other endpoint on the shared 3 s default', async () => {
    vi.useFakeTimers()
    const fetchMock = hangingFetch()
    vi.stubGlobal('fetch', fetchMock)

    const http = createHttpClient('/api/v1')
    const pending = http.get('/ping')
    pending.catch(() => undefined)

    await vi.advanceTimersByTimeAsync(3000)
    await expect(pending).rejects.toThrow(/timed out after 3000ms/)
  })

  it('requests the weights endpoint with the checkpoint name encoded', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () =>
        JSON.stringify({
          name: 'ppo step.zip',
          obs_dim: 14,
          action_dim: 2,
          action_space: 'continuous',
          hidden_sizes: [64, 64],
          layers: {},
        }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = createRLWeightsClient(createHttpClient('/api/v1'))
    const weights = await client.getCheckpointWeights('ppo step.zip')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/rl/checkpoints/ppo%20step.zip/weights')
    expect(weights.obs_dim).toBe(14)
    expect(weights.hidden_sizes).toEqual([64, 64])
  })

  it('surfaces a backend error instead of a fabricated payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      text: async () => JSON.stringify({ detail: 'weights unavailable: SB3 missing' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = createRLWeightsClient(createHttpClient('/api/v1'))

    await expect(client.getCheckpointWeights('ppo_step_0230000.zip')).rejects.toThrow(/503/)
    await expect(client.getCheckpointWeights('ppo_step_0230000.zip')).rejects.toBeInstanceOf(
      BackendError,
    )
  })

  it('fetches the shipped grid policy from its own endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () =>
        JSON.stringify({
          name: 'network_mappo_weights.json',
          obs_dim: 6,
          action_dim: 5,
          action_space: 'discrete',
          hidden_sizes: [64, 64],
          layers: {},
          policy_kind: 'signal',
          source: 'shipped',
        }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = createRLWeightsClient(createHttpClient('/api/v1'))
    const policy = await client.getGridPolicy()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/rl/signal/grid-policy')
    expect(policy.source).toBe('shipped')
    expect(policy.policy_kind).toBe('signal')
  })

  it('gives the grid-policy request a tighter budget than a torch export', async () => {
    // No SB3 model is loaded here — a cold backend that has not answered
    // within 10 s is a broken install and should surface, not hang the
    // page's default-load path for the checkpoint budget's 30 s.
    expect(GRID_POLICY_TIMEOUT_MS).toBe(10000)
    expect(GRID_POLICY_TIMEOUT_MS).toBeLessThan(RL_WEIGHTS_TIMEOUT_MS)

    vi.useFakeTimers()
    const fetchMock = hangingFetch()
    vi.stubGlobal('fetch', fetchMock)

    const client = createRLWeightsClient(createHttpClient('/api/v1'))
    const pending = client.getGridPolicy()
    pending.catch(() => undefined)

    await vi.advanceTimersByTimeAsync(GRID_POLICY_TIMEOUT_MS)
    await expect(pending).rejects.toThrow(/timed out after 10000ms/)
  })
})
