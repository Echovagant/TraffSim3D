// The POI client's tests.
//
// What is pinned here:
//   1. the request carries the scene's origin and rectangle — and NO
//      key (the source is OpenStreetMap: no account, no quota);
//   2. the answer's POIs come through as they are;
//   3. a provider refusal is an ERROR, not an empty list — "no POIs here"
//      and "the provider said no" must not look the same;
//   4. the rectangle conversion is the parser's own inverse.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { boundsToDegrees, createPoiClient, POI_PATH, POI_TIMEOUT_MS, type Poi } from './poiClient'

const POI: Poi = {
  id: 'osm-node-123456',
  name: '示例咖啡',
  type: 'amenity=cafe',
  typeCode: 'amenity',
  category: '餐饮',
  address: '',
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

  it('posts the rectangle and the scene origin — and no key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ source: 'osm', pois: [POI] }))
    vi.stubGlobal('fetch', fetchMock)

    const client = createPoiClient('/api/v1')
    const result = await client.fetchPois({
      south: 39.9,
      west: 116.39,
      north: 39.92,
      east: 116.41,
      originLat: 39.90625,
      originLon: 116.3917,
    })

    expect(result.ok).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`/api/v1${POI_PATH}`)
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.south).toBe(39.9)
    expect(body.origin_lat).toBe(39.90625)
    expect(body.origin_lon).toBe(116.3917)
    // No key: OpenStreetMap needs no account.
    expect(body.key).toBeUndefined()
    expect((init as RequestInit).method).toBe('POST')
  })

  it('carries the tag and keyword filters', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ source: 'osm', pois: [POI] }))
    vi.stubGlobal('fetch', fetchMock)

    const client = createPoiClient('/api/v1')
    await client.fetchPois({
      south: 39.9,
      west: 116.39,
      north: 39.92,
      east: 116.41,
      originLat: 39.90625,
      originLon: 116.3917,
      tags: 'amenity,shop',
      keywords: '咖啡',
      limit: 50,
    })

    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))
    expect(body.tags).toBe('amenity,shop')
    expect(body.keywords).toBe('咖啡')
    expect(body.limit).toBe(50)
  })

  it('returns the POIs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockResponse({ source: 'osm', count: 1, pois: [POI] })),
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
      vi.fn().mockResolvedValue(mockResponse({ detail: 'Overpass is unreachable: ...' }, 502)),
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
    if (!result.ok) expect(result.error).toContain('Overpass')
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
