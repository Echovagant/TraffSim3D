// src/application/services/signalPolicySource.ts
//
// The browser side of the traffic-signal agent.
//
// The Python training env (`app/apps/rl/signal_env.py`) is the **authoritative**
// definition of the observation. This module rebuilds the *same six
// quantities* from the browser's world state, runs the trained policy's
// forward pass on them, and hands the resulting action name to the signal
// controller through the existing `SignalActionSource` seam.
//
// ---------------------------------------------------------------------------
// The observation, index by index
// ---------------------------------------------------------------------------
//
// Python's `SignalEnv._obs()` is the reference implementation:
//
//   obs[0] = min(queue_length("ns") / MAX_QUEUE, 1)
//   obs[1] = min(queue_length("ew") / MAX_QUEUE, 1)
//   obs[2] = 1.0 if light.ns_green else 0.0
//   obs[3] = 1.0 if light.ew_green else 0.0
//   obs[4] = 1.0 if (not light.ns_green and not light.ew_green) else 0.0
//   obs[5] = light.cycle_timer / light.cycle_duration
//
// and the browser's builder reproduces **the same quantity** for every
// index — not merely the same dimension count:
//
//   idx  meaning                        browser's source
//   ---  -----------------------------  --------------------------------------------
//   0    NS queue length (normalised)   `getAxisQueueLength(nsLight, network)`
//   1    EW queue length (normalised)   `getAxisQueueLength(ewLight, network)`
//   2    NS has the right of way        the NS light's phase ∈ {Green, Yellow}
//   3    EW has the right of way        the EW light's phase ∈ {Green, Yellow}
//   4    all-red (neither may go)       neither 2 nor 3
//   5    the phase clock, **elapsed**   (cycleSeconds - phaseRemaining)
//                                       / cycleSeconds
//
// Three details are worth spelling out, because they are where the two
// sides could silently disagree:
//
// 1. **idx 5 is the elapsed fraction, not the remaining one.** The
//    original draft said the browser uses the *remaining* fraction and the two
//    are complements; that was wrong (corrected on 2026-10-21):
//    the policy's weights are trained against Python's definition, so the
//    browser has to feed the *same* quantity or the network is consuming a
//    different input than it was trained on. Python's `cycle_timer` counts
//    **up** from 0 over the phase; the browser's `phaseRemaining` counts
//    **down**, so the elapsed fraction is
//    `(cycleSeconds - phaseRemaining) / cycleSeconds`.
//
//    The two sides still differ in *scale*: Python's `cycle_duration` is one
//    phase (30 s) while the browser's `cycleSeconds` is the whole cycle
//    (63 s). That is the known "the two traffic models are not the same
//    model" boundary — the schema is compared, not the
//    numbers.
//
// 2. **idx 0 / 1 count the whole axis.** Python's `queue_length(axis)`
//    counts every NPC of that axis that is stopped before the stop line.
//    The browser's `getQueueLength` narrows to one lane when the light
//    carries a `controlledLane`, so the axis-wide `getAxisQueueLength` is
//    the one that matches Python's meaning. (In the default scene no light
//    sets `controlledLane`, so the two are the same number.)
//
//    One residual difference the contract accepts (it compares the *schema*,
//    never the numbers): Python additionally requires the vehicle to be
//    stopped (`speed < STOPPED_SPEED`), the browser only requires it to be
//    before the stop line and not crashed / inside the intersection. The
//    two traffic models are not the same model, so the numbers are not
//    comparable — the *meaning* is.
//
// 3. **idx 2 / 3 count the yellow phase as "has the right of way".** The
//    browser's yellow is the clearance that follows the green, and the
//    axis still has priority during it. This mirrors `MAY_GO` in
//    `tick.ts`, which was introduced for the same reason.

import type { TrafficLight } from '@domain/entities/TrafficLight'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import { LightPhase } from '@domain/value-objects/Phase'
import { SIGNAL_ACTION_NAMES, type SignalActionName } from '@shared/constants/simulation'
import { mlpForwardDiscrete } from '@infrastructure/rl/mlpInference'
import type { PolicyWeights } from '@infrastructure/rl/types'
import { getAxisQueueLength, type SignalActionSource } from './signalController'

/** The signal agent's observation dimension. */
export const SIG_OBS_DIM = 6

/**
 * The queue length that saturates the normalised observation (idx 0 / 1).
 *
 * Mirrors Python's `signal_env.MAX_QUEUE`. The two sides must use the same
 * value, otherwise the two queue observations are not comparable at all.
 */
export const SIGNAL_MAX_QUEUE = 10

/** The five actions, in the contract's order. */
export const SIGNAL_ACTION_COUNT = SIGNAL_ACTION_NAMES.length

/** Phases in which the axis still has the right of way (green + clearance). */
const MAY_GO = new Set<LightPhase>([
  LightPhase.Green,
  LightPhase.GreenLeft,
  LightPhase.Yellow,
  LightPhase.YellowLeft,
])

/**
 * The sibling light of the same intersection — the light governing the
 * *other* axis. `null` when the light stands alone.
 */
export const findSiblingLight = (
  light: TrafficLight,
  network: RoadNetwork,
): TrafficLight | null => {
  for (const inter of Object.values(network.intersections)) {
    if (!inter.trafficLights.some((l) => l.id === light.id)) continue
    return inter.trafficLights.find((l) => l.axis !== light.axis) ?? null
  }
  return null
}

/**
 * The two axes' queue lengths, raw (not normalised).
 *
 * Python's `queue_length(axis)` is the axis-wide count of the vehicles
 * waiting before the stop line, so the browser uses the axis-wide
 * `getAxisQueueLength` (see the module header).
 */
export const signalQueueLengths = (
  light: TrafficLight,
  network: RoadNetwork,
  simTime?: number,
): { ns: number; ew: number } => {
  const sibling = findSiblingLight(light, network)
  const nsLight = light.axis === 'ns' ? light : sibling
  const ewLight = light.axis === 'ew' ? light : sibling
  return {
    ns: nsLight !== null ? getAxisQueueLength(nsLight, network, simTime) : 0,
    ew: ewLight !== null ? getAxisQueueLength(ewLight, network, simTime) : 0,
  }
}

/**
 * The signal agent's six-dimensional observation for `light`.
 *
 * See the module header for the index-by-index mapping against Python's
 * `SignalEnv._obs()`.
 */
export const buildSignalObservation = (
  light: TrafficLight,
  network: RoadNetwork,
  simTime?: number,
): number[] => {
  const sibling = findSiblingLight(light, network)
  const nsLight = light.axis === 'ns' ? light : sibling
  const ewLight = light.axis === 'ew' ? light : sibling

  const nsMayGo = nsLight !== null && MAY_GO.has(nsLight.phase)
  const ewMayGo = ewLight !== null && MAY_GO.has(ewLight.phase)

  const { ns: nsQueue, ew: ewQueue } = signalQueueLengths(light, network, simTime)

  // The **elapsed** fraction of the current phase — the same quantity as
  // Python's `cycle_timer / cycle_duration`.
  const cycleSeconds = light.cycleSeconds
  const elapsed = cycleSeconds > 0 ? (cycleSeconds - light.phaseRemaining) / cycleSeconds : 0

  return [
    Math.min(nsQueue / SIGNAL_MAX_QUEUE, 1),
    Math.min(ewQueue / SIGNAL_MAX_QUEUE, 1),
    nsMayGo ? 1 : 0,
    ewMayGo ? 1 : 0,
    !nsMayGo && !ewMayGo ? 1 : 0,
    elapsed,
  ]
}

/** What the policy decided, and what it decided it on. */
export interface SignalPolicyDecision {
  /** The chosen action — one of the five in `SIGNAL_ACTION_NAMES`. */
  action: SignalActionName
  /** The action's index in `SIGNAL_ACTION_NAMES`. */
  actionIndex: number
  /** The observation the decision was made from. */
  observation: number[]
  /** The axis of the light the decision was taken for. */
  axis: 'ns' | 'ew'
  /** The sim time of the decision. */
  simTime: number
  /** The raw (un-normalised) queue lengths at decision time. */
  queueNs: number
  queueEw: number
}

/**
 * A policy-backed action source.
 *
 * It is a `SignalActionSource` — the seam the `RLController` already
 * consumes — plus the last decision, for the UI's "the AI is commanding"
 * readout.
 */
export interface PolicySignalActionSource extends SignalActionSource {
  readonly lastDecision: SignalPolicyDecision | null
}

/**
 * Build the action source backed by a **trained** signal policy.
 *
 * `weights` must be a *discrete* five-action policy (`action_space:
 * "discrete"`, `action_dim: 5`, `obs_dim: 6`). Anything else is rejected
 * loudly: an ego policy (continuous, two actions) would silently produce a
 * meaningless action index.
 *
 * `onDecision` is called with every decision — the world store uses it to
 * publish the readout the AI Playground renders.
 */
export const createPolicyActionSource = (
  weights: PolicyWeights,
  onDecision?: (decision: SignalPolicyDecision) => void,
): PolicySignalActionSource => {
  if (weights.action_space !== 'discrete') {
    throw new Error(
      `signal policy must be discrete (action_space="discrete"), got "${weights.action_space ?? 'continuous'}"`,
    )
  }
  if (weights.action_dim !== SIGNAL_ACTION_COUNT) {
    throw new Error(
      `signal policy must have ${SIGNAL_ACTION_COUNT} actions, got ${weights.action_dim}`,
    )
  }
  if (weights.obs_dim !== SIG_OBS_DIM) {
    throw new Error(`signal policy must take ${SIG_OBS_DIM} observations, got ${weights.obs_dim}`)
  }

  let last: SignalPolicyDecision | null = null

  return {
    get lastDecision(): SignalPolicyDecision | null {
      return last
    },
    nextAction: (light, network, simTime): SignalActionName | null => {
      const observation = buildSignalObservation(light, network, simTime)
      const actionIndex = mlpForwardDiscrete(observation, weights)
      const action = SIGNAL_ACTION_NAMES[actionIndex]
      if (action === undefined) return null
      const queues = signalQueueLengths(light, network, simTime)
      const decision: SignalPolicyDecision = {
        action,
        actionIndex,
        observation,
        axis: light.axis,
        simTime,
        queueNs: queues.ns,
        queueEw: queues.ew,
      }
      last = decision
      onDecision?.(decision)
      return action
    },
  }
}
