// src/infrastructure/api/rlTrainingClient.spec.ts
//
// The bridge between the scene editor and the network-level RL sim.
//
// The client is a thin HTTP wrapper, so what is worth pinning down is the
// *contract*: which URL it hits, that it POSTs, the shape of the request
// body, and — importantly — that a backend refusal comes back as a value
// (`{ok: false, error}`) instead of an exception, so the caller never has
// to wrap the call in a try/catch.

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  VALIDATE_NETWORK_PATH,
  createRLTrainingClient,
  defaultRLTraining,
} from './rlTrainingClient'

const network = {
  roads: [{ id: 'r0', startNode: { x: 0, y: 0, z: 0 }, endNode: { x: 10, y: 0, z: 0 } }],
  intersections: [{ id: 'I0', position: { x: 0, y: 0, z: 0 }, connectedRoads: ['r0'] }],
  vehicles: [],
}

const jsonResponse = (
  body: unknown,
  init: { ok?: boolean; status?: number; statusText?: string } = {},
) => ({
  ok: init.ok ?? true,
  status: init.status ?? 200,
  statusText: init.statusText ?? 'OK',
  text: async () => JSON.stringify(body),
})

describe('RL training client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('posts the network to the validation endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, obs_dim: 24 }))
    vi.stubGlobal('fetch', fetchMock)

    const client = createRLTrainingClient()
    const result = await client.validateNetwork(network)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`/api/v1${VALIDATE_NETWORK_PATH}`)
    expect(url).toBe('/api/v1/rl/validate-network')
    expect(init.method).toBe('POST')
    expect(result.ok).toBe(true)
    expect(result.obs_dim).toBe(24)
  })

  it('sends the network wrapped in a `network` field', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    await defaultRLTraining.validateNetwork(network)

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ network })
  })

  it('reports the backend counters', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true, obs_dim: 24, n_roads: 4, n_intersections: 4 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await defaultRLTraining.validateNetwork(network)

    expect(result).toEqual({ ok: true, obs_dim: 24, n_roads: 4, n_intersections: 4 })
  })

  it('turns a backend rejection into a value, not an exception', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { detail: 'network has no roads' },
          { ok: false, status: 400, statusText: 'Bad Request' },
        ),
      )
    vi.stubGlobal('fetch', fetchMock)

    const result = await defaultRLTraining.validateNetwork({ ...network, roads: [] })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('network has no roads')
  })

  it('falls back to the status line when the body carries no detail', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => '',
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await defaultRLTraining.validateNetwork(network)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('500')
  })

  it('reports a transport failure instead of throwing', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'))
    vi.stubGlobal('fetch', fetchMock)

    const result = await defaultRLTraining.validateNetwork(network)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('network down')
  })

  it('honours a custom base URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    const client = createRLTrainingClient('http://localhost:8001/api/v1')
    await client.validateNetwork(network)

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://localhost:8001/api/v1/rl/validate-network')
  })
})
