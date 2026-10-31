// The route-planning client.
//
// The endpoint is a POST (it carries the scene's network), so this
// module does its own fetch — the same shape as `rlTrainingClient`.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRouteClient, ROUTE_PLAN_PATH } from './routeClient'

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

const network = { roads: [], intersections: [], vehicles: [] }

describe('route client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('posts the network and the two ends to the route endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({
        found: true,
        roads: ['r-b'],
        legs: [],
        cost_m: 100,
        start_node: 'n-1',
        end_node: 'n-2',
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const client = createRouteClient('/api/v1')
    const result = await client.planRoute(
      network,
      { roadId: 'r-a', direction: 'forward' },
      { junctionId: 'i-2' },
    )

    expect(result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toBe(`/api/v1${ROUTE_PLAN_PATH}`)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('POST')
    const body = JSON.parse(String(init.body))
    // The browser's field names are camelCase; the backend's are
    // snake_case. The client translates — the mismatch would otherwise
    // silently plan a route to nowhere.
    expect(body.start).toEqual({ road_id: 'r-a', direction: 'forward' })
    expect(body.end).toEqual({ junction_id: 'i-2' })
    expect(body.network).toEqual(network)
  })

  it('reports a backend error instead of pretending a route exists', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockResponse({ detail: 'end junction not found: i-9' }, 404))
    vi.stubGlobal('fetch', fetchMock)

    const client = createRouteClient('/api/v1')
    const result = await client.planRoute(network, { junctionId: 'i-1' }, { junctionId: 'i-9' })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('i-9')
  })

  it('survives a network that is not there at all', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)

    const client = createRouteClient('/api/v1')
    const result = await client.planRoute(network, { junctionId: 'i-1' }, { junctionId: 'i-2' })

    expect(result.ok).toBe(false)
  })
})
