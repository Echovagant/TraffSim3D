/**
 * The delivery page's live evidence.
 *
 * The point of this layer is honesty: the page used to state numbers
 * it had hardcoded, and they went stale (the suite lost a spec and the
 * page still said 58). Now the numbers come from the running product,
 * and when the product cannot answer the page SAYS SO rather than
 * falling back to the remembered ones.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { useLiveEvidence } from './useLiveEvidence'

const jsonResponse = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  }) as Response

interface Harness {
  state: () => string
  city: () => unknown
  rl: () => unknown
  note: () => string
}

/** Mount a component that calls the composable and exposes its state. */
const mountProbe = (): Harness => {
  let live: ReturnType<typeof useLiveEvidence> | null = null
  const Probe = defineComponent({
    setup() {
      live = useLiveEvidence()
      return () => h('div')
    },
  })
  mount(Probe)
  // The composable probes on mount; the test drives the fake fetch.
  return {
    state: () => live!.state.value,
    city: () => live!.city.value,
    rl: () => live!.rl.value,
    note: () => live!.note.value,
  }
}

describe('useLiveEvidence', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports the city and the RL stack when the backend answers', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/health')) return jsonResponse({ status: 'ok' })
      if (url.endsWith('/maps/sample-stats'))
        return jsonResponse({
          source: '福田中心(深圳).osm',
          roads: 988,
          intersections: 1120,
          trafficLights: 460,
          spawnPoints: 336,
        })
      if (url.endsWith('/rl/capabilities'))
        return jsonResponse({
          torch_version: '2.11.0+cu128',
          cuda_available: true,
          device_name: 'NVIDIA GeForce RTX 4050 Laptop GPU',
        })
      if (url.endsWith('/rl/scenes')) return jsonResponse({ scenes: ['cross', 'corridor'] })
      if (url.endsWith('/rl/checkpoints')) return jsonResponse({ checkpoints: [{ name: 'a.zip' }] })
      return jsonResponse({}, 404)
    })

    const probe = mountProbe()
    await vi.waitFor(() => expect(probe.state()).toBe('live'))

    expect(probe.city()).toMatchObject({ roads: 988, intersections: 1120, trafficLights: 460 })
    expect(probe.rl()).toMatchObject({
      checkpoints: 1,
      scenes: ['cross', 'corridor'],
      torch: '2.11.0+cu128',
      cuda: true,
    })
  })

  it('says the backend is not there instead of inventing numbers', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network down'))

    const probe = mountProbe()
    await vi.waitFor(() => expect(probe.state()).toBe('offline'))

    // No city, no RL — and the page is told why.
    expect(probe.city()).toBeNull()
    expect(probe.rl()).toBeNull()
    expect(probe.note()).toContain('后端未连接')
  })

  it('keeps the RL evidence when only the city probe fails', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/health')) return jsonResponse({ status: 'ok' })
      if (url.endsWith('/maps/sample-stats')) throw new Error('the city is too big')
      if (url.endsWith('/rl/capabilities')) return jsonResponse({ torch_version: '2.11.0' })
      if (url.endsWith('/rl/scenes')) return jsonResponse({ scenes: ['cross'] })
      if (url.endsWith('/rl/checkpoints')) return jsonResponse({ checkpoints: [] })
      return jsonResponse({}, 404)
    })

    const probe = mountProbe()
    await vi.waitFor(() => expect(probe.state()).toBe('live'))

    expect(probe.city()).toBeNull()
    expect(probe.rl()).toMatchObject({ torch: '2.11.0' })
  })
})
