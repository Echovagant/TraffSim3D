// The POI client's tests.
//
// What is pinned here:
//   1. the request carries the scene's origin and rectangle;
//   2. the answer's POIs come through as they are;
//   3. a provider refusal is an ERROR, not an empty list — "no POIs here"
//      and "the provider said no" must not look the same;
//   4. the rectangle conversion is the parser's own inverse.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { boundsToDegrees, createPoiClient, POI_PATH, POI_TIMEOUT_MS, type Poi } from './poiClient'

const POI: Poi = {
  id: 'B0FF',
  name: '示例咖啡',
  type: '餐饮服务;咖啡厅',
  typeCode: '050100',
  category: '餐饮',
  address: '示例路 1 号',
  lon: 116.3913,
  lat: 39.9073,
  x: -29.1,
  z: 127.5,
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

describe('the POI client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('posts the rectangle and the scene origin', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ source: 'amap', pois: [POI] }))
    vi.stubGlobal('fetch', fetchMock)

    const client = createPoiClient('/api/v1')
    const result = await client.fetchPois({
      south: 39.9,
      west: 116.39,
      north: 39.92,
      east: 116.41,
      originLat: 39.90625,
      originLon: 116.3917,
      key: 'my-key',
    })

    expect(result.ok).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`/api/v1${POI_PATH}`)
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.south).toBe(39.9)
    expect(body.origin_lat).toBe(39.90625)
    expect(body.origin_lon).toBe(116.3917)
    expect(body.key).toBe('my-key')
    expect((init as RequestInit).method).toBe('POST')
  })

  it('returns the POIs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockResponse({ source: 'amap', count: 1, pois: [POI] })),
    )
    const result = await createPoiClient().fetchPois({
      south: 0,
      west: 0,
      north: 1,
      east: 1,
      originLat: 0,
      originLon: 0,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.pois).toHaveLength(1)
      expect(result.pois[0]!.name).toBe('示例咖啡')
    }
  })

  it('a provider refusal is an error, not an empty list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockResponse({ detail: 'no AMap key: ...' }, 400)),
    )
    const result = await createPoiClient().fetchPois({
      south: 0,
      west: 0,
      north: 1,
      east: 1,
      originLat: 0,
      originLon: 0,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('no AMap key')
  })

  it('a network failure is an error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const result = await createPoiClient().fetchPois({
      south: 0,
      west: 0,
      north: 1,
      east: 1,
      originLat: 0,
      originLon: 0,
    })
    expect(result.ok).toBe(false)
  })

  it('the request gives up after its own budget', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError')))
    const result = await createPoiClient().fetchPois({
      south: 0,
      west: 0,
      north: 1,
      east: 1,
      originLat: 0,
      originLon: 0,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain(String(POI_TIMEOUT_MS))
  })
})

describe('boundsToDegrees', () => {
  it('is the parser projection inverted', () => {
    const origin = { lat: 39.90625, lon: 116.3917 }
    const rectangle = boundsToDegrees({ minX: -1000, maxX: 1000, minZ: -500, maxZ: 500 }, origin)
    const metresPerDegreeLat = 111000
    const metresPerDegreeLon = 111000 * Math.cos((origin.lat * Math.PI) / 180)
    expect(rectangle.south).toBeCloseTo(origin.lat - 500 / metresPerDegreeLat, 9)
    expect(rectangle.north).toBeCloseTo(origin.lat + 500 / metresPerDegreeLat, 9)
    expect(rectangle.west).toBeCloseTo(origin.lon - 1000 / metresPerDegreeLon, 9)
    expect(rectangle.east).toBeCloseTo(origin.lon + 1000 / metresPerDegreeLon, 9)
  })
})
