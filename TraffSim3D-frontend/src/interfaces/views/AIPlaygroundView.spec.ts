// src/interfaces/views/AIPlaygroundView.spec.ts
//
// Two things are asserted here:
//
//   1. The "AI is commanding" readout — the current action and the two
//      queue lengths — so that "the AI commands the light" is something
//      the user can *see* rather than a claim in a changelog.
//
//   2. The training screen's **honesty**: the primary action must be a
//      real training run, and a dry run must be labelled as such on
//      screen. A fabricated reward series that reads like a learning
//      curve is the defect this pins down.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import AIPlaygroundView from './AIPlaygroundView.vue'
import { useWorldStore } from '@interfaces/stores/worldStore'
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

/** The status a synthetic dry run leaves behind. */
const DRY_RUN_STATUS = {
  running: false,
  paused: false,
  step: 600,
  total_steps: 600,
  episode_count: 3,
  last_reward: 1.65,
  reward_history: [1.0, 1.35, 1.65],
  started_at_ms: 1_700_000_000_000,
  finished_at_ms: 1_700_000_060_000,
  reason: 'dry_run_independent_completed',
  device: 'dry_run',
  device_reason: 'auto_fallback_no_sb3',
  n_agents: 2,
  independent_agents: true,
  scene_kind: 'cross',
  latest_checkpoint: 'ppo_agent0_step_0000600.zip (dry_run), ppo_agent1_step_0000600.zip (dry_run)',
}

/**
 * The train endpoint — matched exactly, because `/rl/training-config`
 * contains `/rl/train` as a substring.
 */
const TRAIN_URL = /\/rl\/train(\?|$)/

/** The status a real PPO run leaves behind. */
const REAL_RUN_STATUS = {
  running: false,
  paused: false,
  step: 3006,
  total_steps: 3000,
  episode_count: 19,
  last_reward: 8.327418,
  reward_history: [6.105498, 3.322413, -2.324495, 29.217927],
  started_at_ms: 1_700_000_000_000,
  finished_at_ms: 1_700_000_060_000,
  reason: 'ppo_completed on cpu (1 agents)',
  device: 'cpu',
  device_reason: 'user_requested_cpu',
  n_agents: 1,
  independent_agents: false,
  scene_kind: 'cross_signalled',
  latest_checkpoint: 'ppo_step_0003000.zip',
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

describe('AIPlaygroundView — the shipped grid policy is the default', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    setActivePinia(createPinia())
    fetchSpy = vi.fn()
    ;(globalThis as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** The payload `GET /rl/signal/grid-policy` serves on a healthy backend. */
  const GRID_POLICY = {
    ...constantSignalPolicy(PREEMPT),
    name: 'network_mappo_weights.json',
    policy_kind: 'signal',
    source: 'shipped',
    action_names: SIGNAL_ACTION_NAMES,
  }

  const mountView = async (): Promise<VueWrapper> => {
    const wrapper = mount(AIPlaygroundView, { global: { stubs: { RouterLink: true } } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()
    return wrapper
  }

  it('mount puts the shipped policy in charge of the lights', async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (String(url).includes('/rl/signal/grid-policy')) {
        return Promise.resolve(mockResponse(GRID_POLICY))
      }
      return Promise.resolve(mockResponse({}, 404))
    })
    const wrapper = await mountView()

    const store = useWorldStore()
    expect(store.signalPolicyOrigin).toBe('shipped')
    expect(store.controllerKind).toBe('rl')
    const checkbox = wrapper.get('[data-testid="rl-signal-controller-checkbox"]')
      .element as HTMLInputElement
    expect(checkbox.checked).toBe(true)
    // The status line says WHERE the policy came from — a shipped policy
    // and a locally trained checkpoint are different claims.
    expect(wrapper.get('[data-testid="signal-policy-status"]').text()).toContain('随产品附带')

    wrapper.unmount()
  })

  it('without the backend the page stays usable and the lights stay actuated', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(mockResponse({}, 404)))
    const wrapper = await mountView()

    const store = useWorldStore()
    expect(store.signalPolicy).toBeNull()
    expect(store.signalPolicyOrigin).toBeNull()
    expect(store.controllerKind).toBe('actuated')
    const checkbox = wrapper.get('[data-testid="rl-signal-controller-checkbox"]')
      .element as HTMLInputElement
    expect(checkbox.checked).toBe(false)
    expect(wrapper.get('[data-testid="signal-policy-status"]').text()).toContain('未加载')

    wrapper.unmount()
  })

  it('the user can still send the lights back to the actuated controller', async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (String(url).includes('/rl/signal/grid-policy')) {
        return Promise.resolve(mockResponse(GRID_POLICY))
      }
      return Promise.resolve(mockResponse({}, 404))
    })
    const wrapper = await mountView()

    await wrapper.get('[data-testid="rl-signal-controller-checkbox"]').setValue(false)

    const store = useWorldStore()
    expect(store.controllerKind).toBe('actuated')
    expect(store.signalPolicy).not.toBeNull()

    wrapper.unmount()
  })
})

describe('AIPlaygroundView — the training screen must not fake a run', () => {
  let fetchSpy: ReturnType<typeof vi.fn>
  let wrapper: VueWrapper | null = null

  const mockFetch = (statusPayload: unknown): void => {
    fetchSpy = vi.fn()
    ;(globalThis as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch
    fetchSpy.mockImplementation((url: string, init?: RequestInit) => {
      const target = String(url)
      if (target.includes('/rl/status')) {
        return Promise.resolve(mockResponse(statusPayload))
      }
      if (TRAIN_URL.test(target) && init?.method === 'POST') {
        return Promise.resolve(mockResponse({ ok: true, dry_run: false }))
      }
      return Promise.resolve(mockResponse({}, 404))
    })
  }

  const mountView = async (statusPayload: unknown): Promise<VueWrapper> => {
    mockFetch(statusPayload)
    wrapper = mount(AIPlaygroundView, { global: { stubs: { RouterLink: true } } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()
    return wrapper
  }

  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    vi.restoreAllMocks()
  })

  it('starts a real training run by default', async () => {
    const view = await mountView(REAL_RUN_STATUS)

    // The dry-run path fabricates its reward series, so it may only ever
    // be an explicit opt-in — never the default of the primary button.
    const checkbox = view.get('[data-testid="dry-run-checkbox"]').element as HTMLInputElement
    expect(checkbox.checked).toBe(false)

    await view.get('[data-testid="start-train-button"]').trigger('click')
    await new Promise((resolve) => setTimeout(resolve, 0))

    const post = fetchSpy.mock.calls.find((call) => TRAIN_URL.test(String(call[0])))
    expect(post).toBeTruthy()
    const body = JSON.parse(String((post![1] as RequestInit).body))
    expect(body.dry_run).toBe(false)
  })

  it('labels a dry run as synthetic instead of a learning curve', async () => {
    const view = await mountView(DRY_RUN_STATUS)

    const provenance = view.get('[data-testid="run-provenance"]').text()
    expect(provenance).toContain('dry-run')
    expect(provenance).toContain('未执行 PPO')
    expect(provenance).toContain('合成数据')

    // The curve's own note must not claim a sampled return either.
    const note = view.get('[data-testid="reward-curve-note"]').text()
    expect(note).toContain('合成')
    expect(note).not.toContain('采样')

    // The backend's reason is on screen, verbatim.
    expect(view.get('[data-testid="metric-reason"]').text()).toBe('dry_run_independent_completed')

    // The checkpoint name is marked as synthetic too.
    expect(view.get('[data-testid="metric-checkpoint"]').text()).toContain('(dry_run)')
    expect(view.find('[data-testid="checkpoint-dry-run-badge"]').exists()).toBe(true)
  })

  it('shows a real run as a real run — device, scene and reason', async () => {
    const view = await mountView(REAL_RUN_STATUS)

    const provenance = view.get('[data-testid="run-provenance"]').text()
    expect(provenance).toContain('真实 PPO')
    expect(provenance).not.toContain('dry-run')
    expect(provenance).toContain('cpu')
    expect(provenance).toContain('信号灯路口')

    expect(view.get('[data-testid="metric-device"]').text()).toBe('cpu')
    expect(view.get('[data-testid="metric-scene"]').text()).toBe('信号灯路口')
    expect(view.get('[data-testid="metric-reason"]').text()).toBe('ppo_completed on cpu (1 agents)')

    // A real checkpoint carries no synthetic marker.
    expect(view.get('[data-testid="metric-checkpoint"]').text()).toBe('ppo_step_0003000.zip')
    expect(view.find('[data-testid="checkpoint-dry-run-badge"]').exists()).toBe(false)
  })
})
