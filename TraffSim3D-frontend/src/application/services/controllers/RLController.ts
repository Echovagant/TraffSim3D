// src/application/services/controllers/RLController.ts
//
// The RL controller: the browser's half of the five-action control
// surface, applied to the **junction**.
//
// The five actions are the ones the Python training sim defines
// (`app/apps/rl/sim_core.py` → `class TrafficLight` → `apply_action`,
// driven by `app/apps/rl/signal_env.py`). They are operations on the
// junction, and the browser now models the junction the same way:
//
//   extend_green          the junction's current green axis grows by 5 s
//                         (never past `MAX_GREEN_SECS`)
//   shorten_red           the opposite axis is served 5 s earlier — its
//                         red shrinks by 5 s (never below `MIN_RED_SECS`)
//   preempt /
//   force_all_red         the **whole junction** holds all-red for 3 s,
//                         then resumes the interrupted phase with the
//                         time it had left
//   no_op                 nothing
//
// The Python's `resume_state` trick is the behaviour to copy: the phase
// **and its remaining time** are remembered before the all-red, and the
// junction comes back to them. A clearance that resumed into "nothing is
// served" would wedge the junction — the browser's plan has no such
// state (every phase has a successor), but the resume point is recorded
// all the same.
//
// `applyAction` is **synchronous**: it only mutates the pending-action
// queue. The next `decide()` consumes the queue. It never calls
// `decide()` itself.
//
// The action source (`SignalActionSource`) is the seam for the trained
// policy: it decides only *where* the actions come from, so replacing
// the injected sequence with the trained policy is a one-line change at
// the construction site. It is polled **once per junction per tick** —
// the same rate the training env drives its light (`SignalEnv.step`
// applies one action per step).

import type { Intersection } from '@domain/entities/Intersection'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import type { TrafficLight } from '@domain/entities/TrafficLight'
import type { SignalAction, SignalActionSource } from '../signalController'
import { LightPhase } from '@domain/value-objects/Phase'
import {
  MAX_GREEN_SECS,
  MIN_RED_SECS,
  PHASE_ADJUST_SECS,
  type SignalActionName,
} from '@shared/constants/simulation'
import { axisLightFor, JunctionControllerBase, type JunctionPlanState } from './junctionPlan'

export interface RLControllerDeps {
  /**
   * Where the next action comes from.
   *
   * Sprint 2: `createSequenceActionSource([...])` — an injected sequence.
   * Sprint 3: the trained policy's source. Both satisfy
   * `SignalActionSource`, so nothing else in the controller changes.
   */
  actionSource?: SignalActionSource
}

export class RLController extends JunctionControllerBase {
  private readonly actionSource: SignalActionSource | null

  constructor(deps: RLControllerDeps = {}) {
    super()
    this.actionSource = deps.actionSource ?? null
  }

  /**
   * Apply the queued actions to the junction's plan.
   *
   * The preemption (`preempt` / `force_all_red`) is the shared
   * machinery's — it is a property of the junction, not of this
   * controller — so it is handled by the base class.
   */
  protected override applyActions(
    state: JunctionPlanState,
    actions: readonly SignalActionName[],
    junction: Intersection,
    network: RoadNetwork,
    simTime: number,
  ): void {
    super.applyActions(state, actions, junction, network, simTime)
    for (const action of actions) {
      if (action === 'extend_green') {
        // The green may grow by 5 s, but never past `MAX_GREEN_SECS` —
        // the same bound the Python training sim uses, so a policy
        // trained against one side behaves the same on the other.
        //
        // The bound is on the green's **duration**: the remaining time
        // may not exceed what is left of the budget. (A clamp on the
        // remaining alone would pin the countdown: an action applied on
        // every tick would keep the green from ever running out.)
        //
        // The action only means something while an axis is served: the
        // Python freezes the phase clock during its clearance, so an
        // adjustment landing there would shorten the *next* green.
        if (state.phase === LightPhase.Green) {
          const elapsed = simTime - state.greenStartedAt
          const budget = Math.max(0, MAX_GREEN_SECS - elapsed)
          state.remaining = Math.min(state.remaining + PHASE_ADJUST_SECS, budget)
        }
      } else if (action === 'shorten_red') {
        // The opposite axis is served 5 s earlier. The green's remaining
        // time is what the opposite axis waits, so it shrinks by the same
        // 5 s.
        //
        // The floor is **refused**, not clamped: the Python's environment
        // masks the action when it would push the green below
        // `MIN_GREEN_SECS` (10 s — the same number as the browser's
        // `MIN_RED_SECS`), and the light is not touched at all. Clamping
        // instead would pin the countdown, and the green would never run
        // out.
        //
        // Like the extension, it is only legal while an axis is served:
        // during the clearance the clock is frozen, and an adjustment
        // there would shorten the *next* green.
        if (
          state.phase === LightPhase.Green &&
          state.remaining - PHASE_ADJUST_SECS >= MIN_RED_SECS
        ) {
          state.remaining -= PHASE_ADJUST_SECS
        }
      }
      // 'no_op' — nothing.
    }
  }

  /**
   * The action space offered to the agent, with the availability flags.
   *
   * `preempt` / `force_all_red` are only legal when the junction is not
   * already held; `extend_green` and `shorten_red` only while an axis
   * is served.
   */
  protected override planActions(
    state: JunctionPlanState,
    _simTime: number,
  ): ReadonlyArray<SignalAction> {
    const holding = state.allRedUntil > Number.NEGATIVE_INFINITY
    const serving = state.phase === LightPhase.Green
    return [
      { name: 'extend_green', available: serving },
      {
        name: 'shorten_red',
        available: serving && state.remaining - PHASE_ADJUST_SECS >= MIN_RED_SECS,
      },
      { name: 'preempt', available: !holding },
      { name: 'force_all_red', available: !holding },
      { name: 'no_op', available: true },
    ]
  }

  /**
   * Poll the action source once per junction per tick.
   *
   * The source is given the light of the axis the junction is serving,
   * so the observation the policy reads is the junction's — the same
   * six numbers the training env builds (`signal_env.SignalEnv._obs`).
   */
  protected override pollActions(
    state: JunctionPlanState,
    junction: Intersection,
    network: RoadNetwork,
    simTime: number,
  ): void {
    const light = this.servedLight(junction, state)
    if (light === null) return
    const sourced = this.actionSource?.nextAction(light, network, simTime)
    if (sourced !== null && sourced !== undefined) this.pending.push(sourced)
  }

  /** The light of the axis the junction is serving. */
  private servedLight(junction: Intersection, state: JunctionPlanState): TrafficLight | null {
    return (
      axisLightFor(junction, state.axis) ??
      axisLightFor(junction, state.axis === 'ns' ? 'ew' : 'ns')
    )
  }
}
