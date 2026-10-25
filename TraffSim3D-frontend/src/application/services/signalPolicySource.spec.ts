// src/application/services/signalPolicySource.spec.ts
//
// The browser side of the traffic-signal agent.
//
// The suite has three parts:
//
// 1. the **observation mapping** — every one of the six indices must carry
//    the *same meaning* as Python's `SignalEnv._obs()`;
// 2. the **policy source** — the trained policy's argmax becomes the
//    action name the controller consumes;
// 3. **the gate** — the phase decisions come from the *policy*, not from
//    the fixed cycle. Proven by injecting a policy that always says
//    `preempt` (the light must go AllRed) and one that always says
//    `extend_green` (the green must outlast the fixed cycle's 30 s).

import { describe, it, expect } from 'vitest'
import { LightPhase } from '@domain/value-objects/Phase'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import type { TrafficLight } from '@domain/entities/TrafficLight'
import { createRoadNetwork } from '@domain/entities/RoadNetwork'
import { SIGNAL_ACTION_NAMES } from '@shared/constants/simulation'
import type { PolicyWeights } from '@infrastructure/rl/types'
import {
  buildSignalObservation,
  createPolicyActionSource,
  SIGNAL_MAX_QUEUE,
  SIG_OBS_DIM,
} from './signalPolicySource'
import { RLController } from './controllers/RLController'
import { makeTestRoad, makeTestVehicle } from '@__fixtures__/testNetwork'
import { constantSignalPolicy } from '@__fixtures__/signalPolicy'
import {
  buildImportedNetwork,
  importedNsLight,
  importedEwLight,
} from '@__fixtures__/importedNetwork'

const CYCLE_SECONDS = 63

const makeLight = (overrides: Partial<TrafficLight> = {}): TrafficLight => ({
  id: 'tl-ns',
  position: { x: 0, y: 0, z: 0 },
  phase: LightPhase.Green,
  phaseRemaining: 30,
  cycleSeconds: CYCLE_SECONDS,
  axis: 'ns',
  ...overrides,
})

/** A network with one intersection holding an NS light and an EW light. */
const buildSignalNetwork = (
  nsLight: TrafficLight,
  ewLight: TrafficLight,
  vehicles: ReturnType<typeof makeTestVehicle>[] = [],
): RoadNetwork => {
  const net = createRoadNetwork()
  net.roads['r-ns'] = makeTestRoad('r-ns', 'ns', 2)
  net.roads['r-ew'] = makeTestRoad('r-ew', 'ew', 2)
  net.intersections['i-1'] = {
    id: 'i-1',
    position: { x: 0, y: 0, z: 0 },
    connectedRoads: ['r-ns', 'r-ew'],
    trafficLights: [nsLight, ewLight],
    intersectionRadius: 8,
  }
  for (const v of vehicles) net.vehicles[v.id] = v
  return net
}

/**
 * Weights whose argmax is always `actionIndex`, whatever the observation.
 *
 * One hidden unit that is switched off, so the action layer sees a zero
 * input and only the action bias decides — the simplest possible policy
 * that still goes through the real forward pass.
 */
const constantPolicy = constantSignalPolicy

describe('buildSignalObservation — the observation mapping', () => {
  it('has six dimensions', () => {
    const ns = makeLight()
    const net = buildSignalNetwork(
      ns,
      makeLight({ id: 'tl-ew', axis: 'ew', phase: LightPhase.Red }),
    )
    expect(buildSignalObservation(ns, net)).toHaveLength(SIG_OBS_DIM)
  })

  it('idx 0 / 1 carry the two axes’ queue lengths, normalised by MAX_QUEUE', () => {
    const ns = makeLight()
    const ew = makeLight({ id: 'tl-ew', axis: 'ew', phase: LightPhase.Red })
    const net = buildSignalNetwork(ns, ew, [
      makeTestVehicle({ id: 'v-ns-1', roadId: 'r-ns', s: 5 }),
      makeTestVehicle({ id: 'v-ns-2', roadId: 'r-ns', s: 13 }),
      makeTestVehicle({ id: 'v-ew-1', roadId: 'r-ew', s: 5 }),
    ])
    const obs = buildSignalObservation(ns, net)
    expect(obs[0]).toBeCloseTo(2 / SIGNAL_MAX_QUEUE, 10)
    expect(obs[1]).toBeCloseTo(1 / SIGNAL_MAX_QUEUE, 10)
  })

  it('idx 2 / 3 say which axis has the right of way (green *or* yellow)', () => {
    const ns = makeLight({ phase: LightPhase.Green })
    const ew = makeLight({ id: 'tl-ew', axis: 'ew', phase: LightPhase.Yellow })
    const net = buildSignalNetwork(ns, ew)
    const obs = buildSignalObservation(ns, net)
    expect(obs[2]).toBe(1)
    expect(obs[3]).toBe(1)
    // Neither axis is "all red" — the yellow axis still has priority.
    expect(obs[4]).toBe(0)
  })

  it('idx 4 is the all-red bit', () => {
    const ns = makeLight({ phase: LightPhase.Red })
    const ew = makeLight({ id: 'tl-ew', axis: 'ew', phase: LightPhase.Red })
    const net = buildSignalNetwork(ns, ew)
    const obs = buildSignalObservation(ns, net)
    expect(obs[2]).toBe(0)
    expect(obs[3]).toBe(0)
    expect(obs[4]).toBe(1)
  })

  it("idx 5 is the ELAPSED fraction of the SERVING axis's green", () => {
    // Python's `TrafficLight` is one object with one `cycle_timer`: the
    // clock belongs to the junction. It counts UP inside the green
    // (0 -> 1 over 30 s), so the elapsed fraction is
    // `(GREEN_PHASE_SECS - phaseRemaining) / GREEN_PHASE_SECS`.
    const ns = makeLight({ phase: LightPhase.Green, phaseRemaining: 30 })
    const net = buildSignalNetwork(
      ns,
      makeLight({ id: 'tl-ew', axis: 'ew', phase: LightPhase.Red, phaseRemaining: 36 }),
    )
    // The green just started => 0 (the remaining fraction would be 1).
    expect(buildSignalObservation(ns, net)[5]).toBeCloseTo(0, 10)

    // Half the green elapsed => 0.5.
    const mid = makeLight({ phase: LightPhase.Green, phaseRemaining: 15 })
    const net2 = buildSignalNetwork(
      mid,
      makeLight({ id: 'tl-ew', axis: 'ew', phase: LightPhase.Red, phaseRemaining: 36 }),
    )
    expect(buildSignalObservation(mid, net2)[5]).toBeCloseTo(0.5, 10)

    // The green is over => 1.
    const late = makeLight({ phase: LightPhase.Green, phaseRemaining: 0 })
    const net3 = buildSignalNetwork(
      late,
      makeLight({ id: 'tl-ew', axis: 'ew', phase: LightPhase.Red, phaseRemaining: 36 }),
    )
    expect(buildSignalObservation(late, net3)[5]).toBeCloseTo(1, 10)
  })

  it("idx 5 is the JUNCTION's clock, so both axes read the same number", () => {
    // The old browser formula read the clock of whichever light was
    // passed in and divided it by the whole cycle (63 s), so the policy
    // saw 0.52 .. 1.0 inside a green and jumped back to 0.52 at every
    // phase change. A policy that had learned "the green is nearly
    // over, extend it" would have read that as "the green has just
    // started" — the opposite meaning.
    const ns = makeLight({ phase: LightPhase.Green, phaseRemaining: 10 })
    const ew = makeLight({ id: 'tl-ew', axis: 'ew', phase: LightPhase.Red, phaseRemaining: 36 })
    const net = buildSignalNetwork(ns, ew)
    const fromNs = buildSignalObservation(ns, net)[5]
    const fromEw = buildSignalObservation(ew, net)[5]
    expect(fromNs).toBeCloseTo((30 - 10) / 30, 10)
    expect(fromEw).toBe(fromNs)
  })

  it("idx 5 is frozen at 0 through the clearance, like Python's clock", () => {
    // Python's clock is reset to 0 when the green ends and frozen there
    // through the clearance: neither axis may go, and the phase does not
    // advance.
    const ns = makeLight({ phase: LightPhase.Yellow, phaseRemaining: 3 })
    const net = buildSignalNetwork(
      ns,
      makeLight({ id: 'tl-ew', axis: 'ew', phase: LightPhase.Red, phaseRemaining: 33 }),
    )
    expect(buildSignalObservation(ns, net)[5]).toBe(0)

    const allRed = makeLight({ phase: LightPhase.AllRed, phaseRemaining: 3 })
    const net2 = buildSignalNetwork(
      allRed,
      makeLight({ id: 'tl-ew', axis: 'ew', phase: LightPhase.Red, phaseRemaining: 33 }),
    )
    expect(buildSignalObservation(allRed, net2)[5]).toBe(0)
  })

  it('idx 5 goes below 0 when the green is extended', () => {
    // Python's `extend_green` takes 5 s off the clock, so the elapsed
    // fraction drops below 0 and the green lasts longer. The browser has
    // to read it the same way, or the policy is told the opposite of
    // what Python tells it.
    const ns = makeLight({ phase: LightPhase.Green, phaseRemaining: 45 })
    const net = buildSignalNetwork(
      ns,
      makeLight({ id: 'tl-ew', axis: 'ew', phase: LightPhase.Red, phaseRemaining: 36 }),
    )
    expect(buildSignalObservation(ns, net)[5]).toBeCloseTo((30 - 45) / 30, 10)
  })
})

describe('createPolicyActionSource', () => {
  it('rejects a continuous (ego) policy', () => {
    const ego: PolicyWeights = {
      name: 'ego.zip',
      obs_dim: 14,
      action_dim: 2,
      action_space: 'continuous',
      hidden_sizes: [64, 64],
      layers: {
        'policy_net.0.weight': [[0]],
        'policy_net.0.bias': [0],
        'policy_net.2.weight': [[0]],
        'policy_net.2.bias': [0],
        'action_net.weight': [[0], [0]],
        'action_net.bias': [0, 0],
        log_std: [0, 0],
      },
    }
    expect(() => createPolicyActionSource(ego)).toThrow(/must be discrete/)
  })

  it('rejects a policy with the wrong action count', () => {
    const wrong = { ...constantPolicy(0), action_dim: 2 }
    expect(() => createPolicyActionSource(wrong)).toThrow(/must have 5 actions/)
  })

  it('rejects a policy with the wrong observation width', () => {
    const wrong = { ...constantPolicy(0), obs_dim: 14 }
    expect(() => createPolicyActionSource(wrong)).toThrow(/must take 6 observations/)
  })

  it('turns the policy’s argmax into an action name', () => {
    const ns = makeLight()
    const net = buildSignalNetwork(
      ns,
      makeLight({ id: 'tl-ew', axis: 'ew', phase: LightPhase.Red }),
    )
    for (const [index, name] of SIGNAL_ACTION_NAMES.entries()) {
      const source = createPolicyActionSource(constantPolicy(index))
      expect(source.nextAction(ns, net, 0)).toBe(name)
    }
  })

  it('records the decision for the UI readout', () => {
    const ns = makeLight()
    const net = buildSignalNetwork(
      ns,
      makeLight({ id: 'tl-ew', axis: 'ew', phase: LightPhase.Red }),
      [makeTestVehicle({ id: 'v-ns-1', roadId: 'r-ns', s: 5 })],
    )
    const seen: string[] = []
    const source = createPolicyActionSource(constantPolicy(2), (d) => seen.push(d.action))
    expect(source.lastDecision).toBeNull()
    source.nextAction(ns, net, 12.5)
    expect(seen).toEqual(['preempt'])
    const decision = source.lastDecision
    expect(decision).not.toBeNull()
    expect(decision?.action).toBe('preempt')
    expect(decision?.actionIndex).toBe(2)
    expect(decision?.axis).toBe('ns')
    expect(decision?.simTime).toBe(12.5)
    expect(decision?.queueNs).toBe(1)
    expect(decision?.queueEw).toBe(0)
    expect(decision?.observation).toHaveLength(SIG_OBS_DIM)
  })
})

describe('THE GATE — the phase decisions come from the policy, not the fixed cycle', () => {
  it('a policy that always preempts drives the light AllRed (the cycle would not)', () => {
    const ns = makeLight({ phase: LightPhase.Green, phaseRemaining: 30 })
    const net = buildSignalNetwork(
      ns,
      makeLight({ id: 'tl-ew', axis: 'ew', phase: LightPhase.Red }),
    )

    // Without a source the controller runs the plain 30/3/30 cycle.
    const plain = new RLController()
    const plainDecision = plain.decide(ns, net, 0)
    expect(plainDecision.phase).toBe(LightPhase.Green)
    expect(plainDecision.duration).toBe(30)

    // With a preempting policy the light must go AllRed.
    const driven = new RLController({ actionSource: createPolicyActionSource(constantPolicy(2)) })
    const decision = driven.decide(ns, net, 0)
    expect(decision.phase).toBe(LightPhase.AllRed)
  })

  it('a policy that always extends green outlasts the fixed cycle’s 30 s', () => {
    const ns = makeLight({ phase: LightPhase.Green, phaseRemaining: 30 })
    const net = buildSignalNetwork(
      ns,
      makeLight({ id: 'tl-ew', axis: 'ew', phase: LightPhase.Red }),
    )

    const plain = new RLController()
    expect(plain.decide(ns, net, 0).duration).toBe(30)

    const driven = new RLController({ actionSource: createPolicyActionSource(constantPolicy(0)) })
    const decision = driven.decide(ns, net, 0)
    expect(decision.phase).toBe(LightPhase.Green)
    expect(decision.duration).toBeGreaterThan(30)
  })

  it('the decision differs from the fixed cycle at every step', () => {
    const ns = makeLight({ phase: LightPhase.Green, phaseRemaining: 30 })
    const net = buildSignalNetwork(
      ns,
      makeLight({ id: 'tl-ew', axis: 'ew', phase: LightPhase.Red }),
    )
    const driven = new RLController({ actionSource: createPolicyActionSource(constantPolicy(1)) })
    // `shorten_red` on a green: the green is cut to the minimum green time.
    const decision = driven.decide(ns, net, 0)
    expect(decision.duration).toBe(25)
  })
})

describe('the observation on an imported OSM map', () => {
  it('idx 0 / 1 carry the real queue lengths, not a structural 0', () => {
    // The imported map's roads are `w-…`: the old `r-${axis}` lookup
    // found nothing, so both queue observations were constantly 0 and
    // the policy saw a city with no traffic at all.
    const net = buildImportedNetwork()
    const ns = importedNsLight(net)
    const ew = importedEwLight(net)

    const obs = buildSignalObservation(ns, net)
    expect(obs[0]).toBeCloseTo(2 / SIGNAL_MAX_QUEUE, 10) // NS queue = 2
    expect(obs[1]).toBeCloseTo(2 / SIGNAL_MAX_QUEUE, 10) // EW queue = 2
  })

  it('the decision readout carries the same queue lengths', () => {
    const net = buildImportedNetwork()
    const ns = importedNsLight(net)
    const source = createPolicyActionSource(constantPolicy(0))
    source.nextAction(ns, net, 0)
    const decision = source.lastDecision
    expect(decision?.queueNs).toBe(2)
    expect(decision?.queueEw).toBe(2)
  })
})
