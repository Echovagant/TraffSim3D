// src/interfaces/views/BackendView.spec.ts
//
// The Backend Services page is a *diagnostics* page. Two properties matter:
//
//   1. It must tell the truth. The probe used to hand an OpenAPI path
//      (`/api/v1/rl/status`) to a client that prepends `/api/v1`, producing
//      `/api/v1/api/v1/rl/status` → 404 → the headline read "Backend offline"
//      against a perfectly healthy backend.
//   2. It must be side-effect free. Opening the page used to POST /rl/train
//      (overwriting the live training status) and DELETE /rl/checkpoints
//      (pruning checkpoint files). A self-check is a read operation.
//
// Both are locked down below.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import BackendView from './BackendView.vue'

/** A trimmed-down OpenAPI doc: healthy GETs, one write pair, one param-gated GET. */
const OPENAPI_SPEC = {
  paths: {
    '/health': { get: { summary: 'Health', description: 'Liveness probe.' } },
    '/api/v1/ping': { get: { summary: 'Ping', description: 'Smoke test.' } },
    '/api/v1/rl/status': { get: { summary: 'Status', description: 'Training status.' } },
    '/api/v1/rl/train': { post: { summary: 'Train', description: 'Start a run.' } },
    '/api/v1/rl/checkpoints': {
      get: { summary: 'List Checkpoints', description: 'List checkpoints.' },
      delete: { summary: 'Prune Checkpoints', description: 'Delete old checkpoints.' },
    },
    '/api/v1/maps/overpass': {
      get: {
        summary: 'Overpass',
        description: 'Requires a query.',
        parameters: [{ name: 'query', in: 'query', required: true }],
      },
    },
  },
}

const mockResponse = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    text: async () => JSON.stringify(body),
    json: async () => body,
  }) as unknown as Response

const mountView = async () => {
  const wrapper = mount(BackendView, { global: { stubs: { RouterLink: true } } })
  await flushPromises()
  await flushPromises()
  return wrapper
}

describe('BackendView — the read-only backend self-check', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  /** Every fetch the page made, with the effective HTTP method. */
  const calls = (): { url: string; method: string }[] =>
    fetchSpy.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: (init as RequestInit | undefined)?.method ?? 'GET',
    }))

  const urls = (): string[] => calls().map((c) => c.url)

  beforeEach(() => {
    fetchSpy = vi.fn()
    ;(globalThis as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch
    fetchSpy.mockImplementation((url: string) => {
      const u = String(url)
      if (u.includes('/openapi.json')) return Promise.resolve(mockResponse(OPENAPI_SPEC))
      if (u.endsWith('/health')) return Promise.resolve(mockResponse({ status: 'ok' }))
      if (u.endsWith('/api/v1/ping')) return Promise.resolve(mockResponse({ pong: true }))
      if (u.endsWith('/api/v1/rl/status')) {
        return Promise.resolve(mockResponse({ running: false, step: 3006, total_steps: 3000 }))
      }
      if (u.endsWith('/api/v1/rl/checkpoints')) {
        return Promise.resolve(mockResponse({ checkpoints: [] }))
      }
      return Promise.resolve(mockResponse({ detail: 'Not Found' }, 404))
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('issues no mutating request when the page is opened', async () => {
    const wrapper = await mountView()

    expect(calls().filter((c) => c.method !== 'GET')).toEqual([])

    // …and specifically: nothing that could start training or prune checkpoints.
    expect(calls().some((c) => c.url.includes('/rl/train'))).toBe(false)
    expect(calls().some((c) => c.url.includes('/rl/checkpoints') && c.method === 'DELETE')).toBe(
      false,
    )

    wrapper.unmount()
  })

  it('probes the exact path each endpoint names — no doubled /api/v1 prefix', async () => {
    const wrapper = await mountView()

    expect(urls().some((u) => u.includes('/api/v1/api/v1'))).toBe(false)
    expect(urls()).toContain('/health')
    expect(urls()).toContain('/api/v1/ping')
    expect(urls()).toContain('/api/v1/rl/status')

    wrapper.unmount()
  })

  it('reports a healthy backend as online, not offline', async () => {
    const wrapper = await mountView()

    expect(wrapper.get('.status-text').text()).toBe('Backend online')
    expect(wrapper.get('.status-detail').text()).toBe('全部 4 个端点响应正常')

    wrapper.unmount()
  })

  it('lists write endpoints but never executes them', async () => {
    const wrapper = await mountView()

    const rows = wrapper.findAll('.endpoint').map((n) => ({
      method: n.get('.endpoint-method').text(),
      path: n.get('.endpoint-path').text(),
      state: n.get('.endpoint-state').text(),
    }))

    const train = rows.find((r) => r.path === '/api/v1/rl/train')
    expect(train?.method).toBe('POST')
    expect(train?.state).toContain('未执行')

    const prune = rows.find((r) => r.path === '/api/v1/rl/checkpoints' && r.method === 'DELETE')
    expect(prune?.state).toContain('未执行')

    // …and neither of them was requested.
    expect(urls().some((u) => u.endsWith('/api/v1/rl/train'))).toBe(false)
    expect(urls().some((u) => u.endsWith('/api/v1/rl/checkpoints') && u.includes('DELETE'))).toBe(
      false,
    )

    wrapper.unmount()
  })

  it('does not fabricate a required query parameter', async () => {
    const wrapper = await mountView()

    expect(urls().some((u) => u.includes('/api/v1/maps/overpass'))).toBe(false)

    const row = wrapper
      .findAll('.endpoint')
      .find((n) => n.get('.endpoint-path').text() === '/api/v1/maps/overpass')
    expect(row?.get('.endpoint-state').text()).toContain('未执行')
    expect(row?.get('.endpoint-note').text()).toContain('query')

    wrapper.unmount()
  })

  it('says "partially failing", not "offline", when one route fails but /health is up', async () => {
    fetchSpy.mockImplementation((url: string) => {
      const u = String(url)
      if (u.includes('/openapi.json')) return Promise.resolve(mockResponse(OPENAPI_SPEC))
      if (u.endsWith('/health')) return Promise.resolve(mockResponse({ status: 'ok' }))
      if (u.endsWith('/api/v1/rl/status')) {
        return Promise.resolve(mockResponse({ detail: 'Not Found' }, 404))
      }
      return Promise.resolve(mockResponse({ pong: true }))
    })

    const wrapper = await mountView()

    expect(wrapper.get('.status-text').text()).toBe('部分端点异常')
    expect(wrapper.get('.status-detail').text()).toContain('/api/v1/rl/status')

    wrapper.unmount()
  })

  it('says "offline" only when the backend really cannot be reached', async () => {
    fetchSpy.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')))

    const wrapper = await mountView()

    expect(wrapper.get('.status-text').text()).toBe('Backend offline')

    wrapper.unmount()
  })
})
