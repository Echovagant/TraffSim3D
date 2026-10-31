/**
 * The POI overlay — the panel, the fetch and the markers.
 *
 * The provider itself needs an API key, so the endpoint is STUBBED
 * here: what is under test is the pipeline (the request carries the
 * scene's origin and rectangle; the answer becomes a list, a selection
 * and a set of markers), not the provider's availability.
 *
 * The markers' geometry and colours have their own unit tests
 * (`PoiLayer.spec.ts`); this spec is the browser-level behaviour.
 */
import { test, expect } from '@playwright/test'
import { waitForSceneReady } from './helpers/wait'

const POIS = [
  {
    id: 'P1',
    name: '示例咖啡',
    type: '餐饮服务;咖啡厅',
    typeCode: '050100',
    category: '餐饮',
    address: '示例路 1 号',
    lon: 116.3913,
    lat: 39.9073,
    x: -20,
    z: 40,
  },
  {
    id: 'P2',
    name: '中心医院',
    type: '医疗;综合医院',
    typeCode: '090100',
    category: '医疗',
    address: '示例路 2 号',
    lon: 116.3913,
    lat: 39.9073,
    x: 30,
    z: -10,
  },
]

test.describe('the POI overlay', () => {
  test('the panel fetches the POIs and draws their markers', async ({ page }) => {
    const requests: Record<string, unknown>[] = []
    await page.route('**/maps/poi', async (route) => {
      requests.push(route.request().postDataJSON() as Record<string, unknown>)
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ source: 'amap', count: POIS.length, pois: POIS }),
      })
    })

    await waitForSceneReady(page)
    await expect(page.locator('[data-testid="poi-panel"]')).toBeVisible()

    // The POIs belong to a MAP: a scene without a geographic anchor
    // has nothing to fetch them for.
    await page.evaluate(() => {
      const w = (
        window as unknown as { __world: { network: { origin?: { lat: number; lon: number } } } }
      ).__world
      w.network.origin = { lat: 39.90625, lon: 116.3917 }
    })

    await page.fill('[data-testid="poi-key-input"]', 'test-key')
    await page.click('[data-testid="poi-load-button"]')

    await expect(page.locator('[data-testid="poi-count"]')).toContainText('2')
    await expect(page.locator('[data-testid="poi-item"]')).toHaveCount(2)

    // The request carried the scene's origin and the rectangle around
    // it — the POIs are projected around that origin.
    expect(requests).toHaveLength(1)
    const request = requests[0]!
    expect(request.origin_lat).toBeCloseTo(39.90625, 6)
    expect(request.key).toBe('test-key')
    expect(typeof request.south).toBe('number')

    // The markers are in the scene (one instanced mesh, two instances).
    const layer = await page.evaluate(() => {
      const renderer = (
        window as unknown as {
          __renderer?: {
            getScene: () => { traverse: (fn: (o: { name: string; count: number }) => void) => void }
          }
        }
      ).__renderer
      if (!renderer) return null
      let mesh: { name: string; count: number } | null = null
      renderer.getScene().traverse((object) => {
        if (object.name === 'poi-layer') mesh = object
      })
      return mesh ? { name: mesh.name, count: mesh.count } : null
    })
    expect(layer).toEqual({ name: 'poi-layer', count: 2 })

    // Selecting a POI shows its details.
    await page.locator('[data-testid="poi-item"]').first().click()
    await expect(page.locator('[data-testid="poi-detail"]')).toContainText('示例咖啡')
    await expect(page.locator('[data-testid="poi-detail"]')).toContainText('示例路 1 号')
  })

  test('a scene without a geographic anchor says so instead of failing silently', async ({
    page,
  }) => {
    await waitForSceneReady(page)
    await page.click('[data-testid="poi-load-button"]')
    await expect(page.locator('[data-testid="poi-error"]')).toContainText('地理锚点')
  })
})
