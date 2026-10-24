// src/application/services/controllers/ActuatedController.ts
//
// The actuated controller, at the **junction** level.
//
// The actuated controller decides which axis gets the green and for how
// long. Its rules are the junction's now:
//
//   - **The clearance comes first.** An axis may only go green once the
//     other axis has finished its clearance. That used to be a rule the
//     controller had to enforce by hand (the per-light machines fought
//     over it); in the junction's plan it is the transition
//     AllRed → Green, so it holds by construction.
//
//   - **The green may be extended only while the perpendicular axis has
//     nobody waiting** — the classical actuated rule. An axis may only
//     hold the junction while nobody waits on the other side.
//
//   - **`MAX_GREEN_SECS` bounds the green's duration**, not just its
//     remaining time: after that the green MUST cycle to yellow, even
//     with a queue waiting.
//
// ## The red-shortening rule is gone
//
// The old controller also cut the waiting axis' red down to
// `MIN_RED_SECS` when the served axis had no queue. That rule existed
// because the two per-light phase machines fought each other: each one
// ran its own countdown, so shortening one of them desynchronised the
// pair — before the clearance became a phase of its own, the junction
// ping-ponged between the axes every few seconds.
//
// At the junction level there is nothing to fight — one plan, one clock,
// one hand-over — and the rule would break the junction's timing (the
// cycle would no longer be 72 s and the clearance would no longer be the
// symmetric 6 s the training sim has). The hand-over is the plan's.

import type { Intersection } from '@domain/entities/Intersection'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import { LightPhase } from '@domain/value-objects/Phase'
import { GREEN_EXTENSION_STEP, MAX_GREEN_SECS } from '@shared/constants/simulation'
import { getAxisQueueLength, getQueueLength } from '../signalController'
import {
  axisLightFor,
  otherAxis,
  JunctionControllerBase,
  type JunctionPlanState,
} from './junctionPlan'

export class ActuatedController extends JunctionControllerBase {
  /**
   * The junction's timing rules.
   *
   * The extension is the classical actuated rule: the served axis keeps
   * its green while it has a queue **and** the perpendicular axis has
   * nobody waiting. The extension is bounded by the green's remaining
   * budget (`MAX_GREEN_SECS` minus what it has already run), so the
   * green's total duration never exceeds `MAX_GREEN_SECS` — and a green
   * that has spent its budget cycles to yellow on the next tick, even
   * with a queue waiting.
   */
  protected override tune(
    state: JunctionPlanState,
    junction: Intersection,
    network: RoadNetwork,
    simTime: number,
  ): void {
    if (state.phase !== LightPhase.Green) return
    const elapsed = simTime - state.greenStartedAt
    if (elapsed >= MAX_GREEN_SECS) {
      // The budget is spent: the green ends now, queue or not.
      state.remaining = 0
      return
    }
    const served = axisLightFor(junction, state.axis)
    if (served === null) return
    const perpendicular = axisLightFor(junction, otherAxis(state.axis))
    const oppositeWaiting =
      perpendicular !== null && getAxisQueueLength(perpendicular, network, simTime) > 0
    if (oppositeWaiting) return
    if (getQueueLength(served, network, simTime) <= 0) return
    const budget = MAX_GREEN_SECS - elapsed
    state.remaining = Math.min(state.remaining + GREEN_EXTENSION_STEP, budget)
  }
}
