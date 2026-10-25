// Regression test for the `switchScene` bug.
//
// Bug history: `worldStore.network` was originally a plain closure
// variable; `replaceNetwork` did `network = next`. Pinia setup stores
// do NOT track plain reassignments, so consumers like EntityOutline
// (which read `world.network` and depended on the in-place-mutation
// contract) saw the stale initial reference even after the Three.js
// renderer rebuilt. Switches from "cross" → "t" / "loop" had no
// visible effect in the UI.
//
// Fix: `network` is now `shallowRef`. Pinia auto-unwraps it on the
// store so `world.network` reflects the latest value reactively. This
// test pins the contract: `switchScene('t')` must produce a network
// whose `roads` / `intersections` / `vehicles` come from the T
// factory, and `currentSceneKind` must update.
//
// Also adds RL replay surface tests (loadPolicy / startReplay /
// stopReplay / clearPolicy) below.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorldStore } from './worldStore'
import {
  buildCrossIntersectionNetwork,
  buildTJunctionNetwork,
  buildRectangularLoopNetwork,
} from '@application/services/defaultScene'
import fixture from '@infrastructure/rl/fixtures/mlp-policy-fixture.json'
import type { PolicyWeights } from '@infrastructure/rl/types'
import { constantSignalPolicy } from '@__fixtures__/signalPolicy'
import { LightPhase } from '@domain/value-objects/Phase'
import { SIGNAL_ACTION_NAMES } from '@shared/constants/simulation'

describe('worldStore.switchScene', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('default scene is the cross-intersection factory output', () => {
    const world = useWorldStore()
    const expected = buildCrossIntersectionNetwork()
    expect(Object.keys(world.network.roads).sort()).toEqual(Object.keys(expected.roads).sort())
    expect(world.currentSceneKind).toBe('cross')
  })

  it('switchScene("t") replaces network with the T-junction factory output', () => {
    const world = useWorldStore()
    world.switchScene('t')
    const expected = buildTJunctionNetwork()
    expect(world.currentSceneKind).toBe('t')
    expect(Object.keys(world.network.roads).sort()).toEqual(Object.keys(expected.roads).sort())
    expect(Object.keys(world.network.intersections).length).toBe(1)
    expect(Object.values(world.network.intersections)[0]!.connectedRoads.length).toBe(3)
    // Vehicles dropped from 6 (cross) to 4 (T).
    expect(Object.keys(world.network.vehicles).length).toBe(4)
  })

  it('switchScene("loop") replaces network with the rectangular-loop factory output', () => {
    const world = useWorldStore()
    world.switchScene('loop')
    const expected = buildRectangularLoopNetwork()
    expect(world.currentSceneKind).toBe('loop')
    expect(Object.keys(world.network.roads).sort()).toEqual(Object.keys(expected.roads).sort())
    expect(Object.keys(world.network.intersections).length).toBe(4)
    expect(Object.keys(world.network.vehicles).length).toBe(8)
  })

  it('switchScene("t") then switchScene("loop") leaves the store on the loop scene', () => {
    const world = useWorldStore()
    world.switchScene('t')
    world.switchScene('loop')
    expect(world.currentSceneKind).toBe('loop')
    expect(Object.keys(world.network.vehicles).length).toBe(8)
  })
})

describe('worldStore.loadNetwork (imported OSM/PBF scenes)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('loadNetwork with sourceLabel switches to "imported" + records the label', () => {
    const world = useWorldStore()
    // Simulate an OSM import with a 537-road network and 629
    // intersections — same shape as the parsed Shenzhen output.
    const net = buildTJunctionNetwork() // any valid network works as the source
    world.loadNetwork(net, 'shenzhen-futuan.osm')
    expect(world.currentSceneKind).toBe('imported')
    expect(world.currentSceneLabel).toBe('shenzhen-futuan.osm')
  })

  it('switchScene back to a built-in scene clears the imported label', () => {
    const world = useWorldStore()
    world.loadNetwork(buildTJunctionNetwork(), 'shenzhen.osm')
    expect(world.currentSceneLabel).toBe('shenzhen.osm')
    world.switchScene('cross')
    expect(world.currentSceneKind).toBe('cross')
    expect(world.currentSceneLabel).toBe('十字路口')
  })
})

describe('worldStore.replay', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    setActivePinia(createPinia())
    fetchSpy = vi.fn()
    ;(globalThis as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const fakeWeights: PolicyWeights = {
    name: 'ppo_step_0005000.zip',
    obs_dim: fixture.obs.length,
    action_dim: 2,
    hidden_sizes: [64, 64],
    layers: fixture.weights as PolicyWeights['layers'],
  }

  /** Mock Response for httpClient — httpClient calls `res.text()`
   *  first (not `res.json()`), so we need to provide a text() too. */
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

  it('loadPolicy fetches /weights endpoint and stores the weights', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(fakeWeights))
    const world = useWorldStore()
    const r = await world.loadPolicy('ppo_step_0005000.zip')
    if (!r.ok) {
      throw new Error(`loadPolicy failed: ${r.reason}`)
    }
    expect(r.ok).toBe(true)
    expect(r.obs_dim).toBe(fixture.obs.length)
    expect(r.action_dim).toBe(2)
    expect(world.policy?.name).toBe('ppo_step_0005000.zip')
    const callArgs = fetchSpy.mock.calls[0] ?? []
    expect(String(callArgs[0])).toContain('/api/v1/rl/checkpoints/ppo_step_0005000.zip/weights')
  })

  it('loadPolicy returns ok=false when fetch 404s', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({}, 404))
    const world = useWorldStore()
    const r = await world.loadPolicy('missing.zip')
    expect(r.ok).toBe(false)
    expect(world.policy).toBeNull()
  })

  it('startReplay requires both policy + target vehicle', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(fakeWeights))
    const world = useWorldStore()
    // No policy, no target → reject.
    expect(world.startReplay().ok).toBe(false)
    // Load policy, but no target → still reject.
    await world.loadPolicy('ppo_step_0005000.zip')
    expect(world.startReplay().ok).toBe(false)
    // Set target → start succeeds.
    world.setReplayTarget('v-1')
    expect(world.startReplay().ok).toBe(true)
    expect(world.replayActive).toBe(true)
  })

  it('stopReplay flips replayActive off', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(fakeWeights))
    const world = useWorldStore()
    await world.loadPolicy('ppo_step_0005000.zip')
    world.setReplayTarget('v-1')
    world.startReplay()
    world.stopReplay()
    expect(world.replayActive).toBe(false)
  })

  it('clearPolicy wipes policy + target + active flag', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(fakeWeights))
    const world = useWorldStore()
    await world.loadPolicy('ppo_step_0005000.zip')
    world.setReplayTarget('v-1')
    world.startReplay()
    world.clearPolicy()
    expect(world.policy).toBeNull()
    expect(world.replayTargetId).toBeNull()
    expect(world.replayActive).toBe(false)
  })

  it('switchScene clears any loaded policy (no stale target drives new scene)', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(fakeWeights))
    const world = useWorldStore()
    await world.loadPolicy('ppo_step_0005000.zip')
    world.setReplayTarget('v-1')
    world.startReplay()
    world.switchScene('t')
    expect(world.policy).toBeNull()
    expect(world.replayActive).toBe(false)
  })
})

describe('worldStore signal policy', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    setActivePinia(createPinia())
    fetchSpy = vi.fn()
    ;(globalThis as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

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

  /** The index of `preempt` in the shared five-action vocabulary. */
  const PREEMPT = SIGNAL_ACTION_NAMES.indexOf('preempt')

  it('loadSignalPolicy stores the policy and builds the action source', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(constantSignalPolicy(PREEMPT)))
    const world = useWorldStore()
    const r = await world.loadSignalPolicy('signal.zip')
    expect(r.ok).toBe(true)
    expect(world.signalPolicy?.name).toBe('constant-preempt.zip')
    expect(world.signalPolicy?.action_dim).toBe(5)
  })

  it('loadSignalPolicy rejects a continuous (ego) policy', async () => {
    const ego = {
      ...constantSignalPolicy(PREEMPT),
      action_space: 'continuous' as const,
      obs_dim: 14,
    }
    fetchSpy.mockResolvedValueOnce(mockResponse(ego))
    const world = useWorldStore()
    const r = await world.loadSignalPolicy('ego.zip')
    expect(r.ok).toBe(false)
    expect(world.signalPolicy).toBeNull()
  })

  it('loadShippedGridPolicy adopts the product policy and marks its origin', async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (String(url).includes('/rl/signal/grid-policy')) {
        return Promise.resolve(
          mockResponse({
            ...constantSignalPolicy(PREEMPT),
            name: 'network_mappo_weights.json',
            policy_kind: 'signal',
            source: 'shipped',
          }),
        )
      }
      return Promise.resolve(mockResponse({}, 404))
    })
    const world = useWorldStore()
    const r = await world.loadShippedGridPolicy()
    expect(r.ok).toBe(true)
    expect(world.signalPolicy?.name).toBe('network_mappo_weights.json')
    expect(world.signalPolicyOrigin).toBe('shipped')
  })

  it('loadShippedGridPolicy fails gracefully without a backend', async () => {
    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'))
    const world = useWorldStore()
    const r = await world.loadShippedGridPolicy()
    expect(r.ok).toBe(false)
    expect(world.signalPolicy).toBeNull()
    expect(world.signalPolicyOrigin).toBeNull()
  })

  it('clearSignalPolicy resets the origin along with the policy', async () => {
    fetchSpy.mockImplementation((url: string) =>
      Promise.resolve(
        mockResponse({
          ...constantSignalPolicy(PREEMPT),
          name: 'network_mappo_weights.json',
          policy_kind: 'signal',
          source: 'shipped',
        }),
      ),
    )
    const world = useWorldStore()
    await world.loadShippedGridPolicy()
    expect(world.signalPolicyOrigin).toBe('shipped')
    world.clearSignalPolicy()
    expect(world.signalPolicyOrigin).toBeNull()
  })

  it('without a policy the RL controller runs the plain cycle', async () => {
    const world = useWorldStore()
    world.setControllerKind('rl')
    world.step(0.1)
    const light = Object.values(world.network.intersections)[0]!.trafficLights.find(
      (l) => l.id === 'tl-ns',
    )!
    expect(light.phase).toBe(LightPhase.Green)
    expect(world.signalPolicyDecision).toBeNull()
  })

  it('the RL controller drives the light from the POLICY, not from the fixed cycle', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(constantSignalPolicy(PREEMPT)))
    const world = useWorldStore()
    world.setControllerKind('rl')
    await world.loadSignalPolicy('signal.zip')

    world.step(0.1)
    const light = Object.values(world.network.intersections)[0]!.trafficLights.find(
      (l) => l.id === 'tl-ns',
    )!
    expect(light.phase).toBe(LightPhase.AllRed)
    expect(world.signalPolicyDecision?.action).toBe('preempt')
  })

  it('the policy is not injected while another controller kind is active', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(constantSignalPolicy(PREEMPT)))
    const world = useWorldStore()
    // The default kind is 'actuated' — the signal policy must stay unused.
    await world.loadSignalPolicy('signal.zip')
    world.step(0.1)
    const light = Object.values(world.network.intersections)[0]!.trafficLights.find(
      (l) => l.id === 'tl-ns',
    )!
    expect(light.phase).toBe(LightPhase.Green)
    expect(world.signalPolicyDecision).toBeNull()
  })

  it('clearSignalPolicy removes the policy and the readout', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(constantSignalPolicy(PREEMPT)))
    const world = useWorldStore()
    world.setControllerKind('rl')
    await world.loadSignalPolicy('signal.zip')
    world.step(0.1)
    expect(world.signalPolicyDecision).not.toBeNull()
    world.clearSignalPolicy()
    expect(world.signalPolicy).toBeNull()
    expect(world.signalPolicyDecision).toBeNull()
  })
})
