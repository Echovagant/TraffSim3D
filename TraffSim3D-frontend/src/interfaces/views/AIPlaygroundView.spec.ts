// src/interfaces/views/AIPlaygroundView.spec.ts
//
// The "AI is commanding" readout.
//
// The AI Playground must show what the signal agent is doing — the current
// action and the two queue lengths — so that "the AI commands the light" is
// something the user can *see* rather than a claim in a changelog.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import AIPlaygroundView from './AIPlaygroundView.vue'
import { constantSignalPolicy } from '@__fixtures__/signalPolicy'
import { SIGNAL_ACTION_NAMES } from '@shared/constants/simulation'

const PREEMPT = SIGNAL_ACTION_NAMES.indexOf('preempt')

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

describe('AIPlaygroundView — the AI signal-command readout', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    setActivePinia(createPinia())
    fetchSpy = vi.fn()
    ;(globalThis as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch
    // Only the weights endpoint answers; the view's own polling calls 404.
    fetchSpy.mockImplementation((url: string) => {
      if (String(url).includes('/weights')) {
        return Promise.resolve(mockResponse(constantSignalPolicy(PREEMPT)))
      }
      return Promise.resolve(mockResponse({}, 404))
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows the current action and the two queue lengths', async () => {
    const wrapper = mount(AIPlaygroundView, {
      global: { stubs: { RouterLink: true } },
    })
    await wrapper.vm.$nextTick()

    // Before a policy has decided, the readout is empty.
    expect(wrapper.get('[data-testid="signal-policy-action"]').text()).toBe('—')

    // Drive one decision through the store, the way the sim does.
    const store = (await import('@interfaces/stores/worldStore')).useWorldStore()
    await store.loadSignalPolicy('signal.zip')
    store.setControllerKind('rl')
    store.step(0.1)
    await wrapper.vm.$nextTick()

    expect(store.signalPolicyDecision?.action).toBe('preempt')
    expect(wrapper.get('[data-testid="signal-policy-action"]').text()).toBe('preempt')
    expect(wrapper.get('[data-testid="signal-policy-queue-ns"]').text()).not.toBe('—')
    expect(wrapper.get('[data-testid="signal-policy-queue-ew"]').text()).not.toBe('—')

    wrapper.unmount()
  })
})
