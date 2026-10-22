// src/application/services/signalController.ts
//
// Per-light signal controller. One instance per
// traffic light, owned by worldStore. Per-tick, the application
// tick calls `controller.decide(light, network, simTime)` and
// applies the returned decision to the light entity.
//
// See the signal-controller contract for the full details.

import type { TrafficLight } from '@domain/entities/TrafficLight'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import type { LightPhase } from '@domain/value-objects/Phase'
import { roadLength } from '@domain/services/laneGeometry'
import { STOP_LINE_DISTANCE } from '@shared/constants/simulation'
import type { SignalActionName } from '@shared/constants/simulation'
import {
  FixedCycleController,
  ActuatedController,
  RLController,
  CoordinatedController,
  type CoordinatedControllerDeps,
} from './controllers'

export interface SignalDecision {
  phase: LightPhase
  duration: number
  actions: ReadonlyArray<SignalAction>
  decidedAt: number
}

export interface SignalAction {
  /** The action name — one of the five in `SIGNAL_ACTION_NAMES`. */
  name: SignalActionName
  available: boolean
}

/**
 * Where the RL controller's next action comes from.
 *
 * This is the **seam** between "the signal can be driven" and "the signal
 * is driven by a policy". Sprint 2 ships
 * `createSequenceActionSource` — an injected list of action names, one per
 * poll. Sprint 3 replaces it with a source backed by the trained policy.
 *
 * Both satisfy this one interface, so the swap is a **single line** at the
 * construction site (`createSignalController`'s `rlActionSource` dep) and
 * nothing else in the controller changes.
 */
export interface SignalActionSource {
  /**
   * The next action for `light`, or `null` when there is nothing to apply.
   * Called once per `decide()`.
   */
  nextAction(light: TrafficLight, network: RoadNetwork, simTime: number): SignalActionName | null
}

/**
 * Sprint 2's action source: a fixed sequence of action names.
 *
 * The sequence is consumed one entry per `decide()` call; once it is
 * exhausted the source returns `null` and the controller keeps running its
 * normal cycle. Sprint 3's policy-backed source replaces this — the
 * controller cannot tell the difference.
 */
export const createSequenceActionSource = (
  actions: readonly SignalActionName[],
): SignalActionSource => {
  let index = 0
  return {
    nextAction: () => (index < actions.length ? (actions[index++] ?? null) : null),
  }
}

export interface SignalController {
  decide(light: TrafficLight, network: RoadNetwork, simTime: number): SignalDecision
  /** Synchronous: mutate internal pending-action queue.
   *  Next decide() consumes. */
  applyAction(light: TrafficLight, action: SignalActionName): void
}

export type ControllerKind = 'fixed-cycle' | 'actuated' | 'coordinated' | 'rl'

/**
 * Queue length on `light.controlledLane` (or "any lane on this
 * axis" if undefined) of `light.axis` direction.
 *
 * Crashed cars are excluded;
 * cars inside the intersection box are excluded; cars past the
 * stop line are excluded. Only "queued" cars (in lane, in
 * stop-line approach, not crashed, not in box) count.
 *
 * `queue_length >= 1` means "there IS queue".
 */
export const getQueueLength = (light: TrafficLight, network: RoadNetwork): number => {
  const roadId = `r-${light.axis}` // convention: tl-ns → r-ns
  const road = network.roads[roadId]
  if (!road) return 0
  const stopLineS = roadLength(road) / 2 - STOP_LINE_DISTANCE
  let count = 0
  for (const v of Object.values(network.vehicles)) {
    if (v.roadId !== road.id) continue
    if (v.status === 'crashed') continue
    if (light.controlledLane !== undefined && v.laneIndex !== light.controlledLane) continue
    if (v.enteredIntersectionAt !== null) continue // 在 box 内不算
    if (v.s >= stopLineS) continue // 过了 stop line
    if (v.s < 0) continue
    count += 1
  }
  return count
}

/**
 * Total queue across all controlled lanes of this axis.
 * Used by some controllers to check "any queue on this axis".
 */
export const getAxisQueueLength = (light: TrafficLight, network: RoadNetwork): number => {
  const roadId = `r-${light.axis}`
  const road = network.roads[roadId]
  if (!road) return 0
  const stopLineS = roadLength(road) / 2 - STOP_LINE_DISTANCE
  let count = 0
  for (const v of Object.values(network.vehicles)) {
    if (v.roadId !== road.id) continue
    if (v.status === 'crashed') continue
    if (v.enteredIntersectionAt !== null) continue
    if (v.s >= stopLineS) continue
    if (v.s < 0) continue
    count += 1
  }
  return count
}

/**
 * Factory: returns a SignalController instance for the requested kind.
 * `coordinated` was added for the green-wave; its deps
 * (offset map + enabled flag) are passed by worldStore so the
 * controller stays a pure decision function.
 */
export interface CreateSignalControllerDeps {
  getCoordinatedOffsets: () => ReadonlyMap<string, number>
  isCoordinatedEnabled: () => boolean
  /**
   * The RL controller's action source.
   *
   * Optional: with no source the controller still accepts actions through
   * `applyAction` (the injected-sequence path). A later change passes the
   * trained policy's source here — a one-line swap, because the source is
   * the only thing that decides *where* the actions come from.
   */
  rlActionSource?: SignalActionSource
}

export const createSignalController = (
  kind: ControllerKind,
  deps: CreateSignalControllerDeps,
): SignalController => {
  switch (kind) {
    case 'fixed-cycle':
      return new FixedCycleController()
    case 'actuated':
      return new ActuatedController()
    case 'coordinated':
      return new CoordinatedController({
        getOffsets: deps.getCoordinatedOffsets,
        isEnabled: deps.isCoordinatedEnabled,
      })
    case 'rl':
      return new RLController({ actionSource: deps.rlActionSource })
    default:
      return new ActuatedController()
  }
}
