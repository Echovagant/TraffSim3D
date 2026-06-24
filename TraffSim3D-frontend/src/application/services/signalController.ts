// src/application/services/signalController.ts
//
// M2-B (plan 010): per-light signal controller. One instance per
// traffic light, owned by worldStore. Per-tick, the application
// tick calls `controller.decide(light, network, simTime)` and
// applies the returned decision to the light entity.
//
// See ADR-004 for the contract.

import type { TrafficLight } from '@domain/entities/TrafficLight';
import type { RoadNetwork } from '@domain/entities/RoadNetwork';
import type { LightPhase } from '@domain/value-objects/Phase';
import { roadLength } from '@domain/services/laneGeometry';
import { STOP_LINE_DISTANCE } from '@shared/constants/simulation';
import { FixedCycleController, ActuatedController, RLController } from './controllers';

export interface SignalDecision {
  phase: LightPhase;
  duration: number;
  actions: ReadonlyArray<SignalAction>;
  decidedAt: number;
}

export interface SignalAction {
  name: 'extend_green' | 'shorten_red' | 'preempt' | 'force_all_red' | 'no_op';
  available: boolean;
}

export interface SignalController {
  decide(light: TrafficLight, network: RoadNetwork, simTime: number): SignalDecision;
  /** Synchronous: mutate internal pending-action queue.
   *  Next decide() consumes. See 007 §2 semantics. */
  applyAction(light: TrafficLight, action: SignalAction['name']): void;
}

export type ControllerKind = 'fixed-cycle' | 'actuated' | 'rl';

/**
 * Queue length on `light.controlledLane` (or "any lane on this
 * axis" if undefined) of `light.axis` direction.
 *
 * Per 007 §3.1 R2 mitigation: crashed cars are excluded;
 * cars inside the intersection box are excluded; cars past the
 * stop line are excluded. Only "queued" cars (in lane, in
 * stop-line approach, not crashed, not in box) count.
 *
 * `queue_length >= 1` means "there IS queue".
 */
export const getQueueLength = (light: TrafficLight, network: RoadNetwork): number => {
  const roadId = `r-${light.axis}`;  // convention: tl-ns → r-ns
  const road = network.roads[roadId];
  if (!road) return 0;
  const stopLineS = roadLength(road) / 2 - STOP_LINE_DISTANCE;
  let count = 0;
  for (const v of Object.values(network.vehicles)) {
    if (v.roadId !== road.id) continue;
    if (v.status === 'crashed') continue;
    if (light.controlledLane !== undefined && v.laneIndex !== light.controlledLane) continue;
    if (v.enteredIntersectionAt !== null) continue;  // 在 box 内不算
    if (v.s >= stopLineS) continue;  // 过了 stop line
    if (v.s < 0) continue;
    count += 1;
  }
  return count;
};

/**
 * Total queue across all controlled lanes of this axis.
 * Used by some controllers to check "any queue on this axis".
 */
export const getAxisQueueLength = (light: TrafficLight, network: RoadNetwork): number => {
  const roadId = `r-${light.axis}`;
  const road = network.roads[roadId];
  if (!road) return 0;
  const stopLineS = roadLength(road) / 2 - STOP_LINE_DISTANCE;
  let count = 0;
  for (const v of Object.values(network.vehicles)) {
    if (v.roadId !== road.id) continue;
    if (v.status === 'crashed') continue;
    if (v.enteredIntersectionAt !== null) continue;
    if (v.s >= stopLineS) continue;
    if (v.s < 0) continue;
    count += 1;
  }
  return count;
};

/**
 * Factory: returns a SignalController instance for the requested kind.
 * `coordinated` is not implemented in M2-B (deferred to M2-D / M3) —
 * falls back to actuated. Unknown kinds also fall back.
 */
export const createSignalController = (kind: ControllerKind): SignalController => {
  switch (kind) {
    case 'fixed-cycle': return new FixedCycleController();
    case 'actuated':    return new ActuatedController();
    case 'rl':          return new RLController();
    default:            return new ActuatedController();
  }
};