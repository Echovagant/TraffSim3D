// src/application/services/controllers/RLController.ts
//
// Plan 073 Sprint 2 (A2a): the RL signal controller becomes a real
// control surface.
//
// It still runs the plain 30/3/30 cycle when nothing drives it, so
// selecting "RL" in the UI does not change the traffic — but it now
// *consumes* external actions from the shared five-action vocabulary
// (plans/legacy/007-m2-signal-controller.md §2):
//
//   extend_green          the current light's remaining time grows by 5 s
//                         (never past MAX_GREEN_SECS)
//   shorten_red           the current light's remaining time shrinks by 5 s
//                         (never below the minimum-red floor)
//   preempt /
//   force_all_red         the light holds AllRed for 3 s
//   no_op                 nothing
//
// `applyAction` is **synchronous**: it only mutates the pending-action
// queue. The next `decide()` consumes the queue (007 §2). It never calls
// `decide()` itself.
//
// SCOPE NOTE — the controller is **per light** (007 §3: "M2-B 阶段 =
// per-light controller"). "All lights go AllRed" is therefore realised by
// the caller applying the action to *every* light of the intersection;
// each light's controller then holds its own AllRed for 3 s.
//
// The action source (`SignalActionSource`) is the seam for Sprint 3: it
// decides only *where* the actions come from, so replacing the injected
// sequence with the trained policy is a one-line change at the
// construction site.
import type { TrafficLight } from '@domain/entities/TrafficLight'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import type {
  SignalAction,
  SignalActionSource,
  SignalController,
  SignalDecision,
} from '../signalController'
import { LightPhase } from '@domain/value-objects/Phase'
import {
  ALL_RED_SECS,
  MAX_GREEN_SECS,
  MIN_RED_SECS,
  PHASE_ADJUST_SECS,
  type SignalActionName,
} from '@shared/constants/simulation'

/** The plain cycle — the same transitions as `FixedCycleController`. */
const GREEN_SECS = 30
const YELLOW_SECS = 3
const RED_SECS = 30

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

/**
 * Shorten a phase by the phase-adjust step.
 *
 * The minimum-red floor (`MIN_RED_SECS` — the `ActuatedController`'s
 * existing convention) applies to the **red** phase only: a red light
 * never drops below it. A green light must still be able to expire,
 * otherwise it could never turn yellow, so there the floor is zero.
 */
const shrinkRed = (duration: number, phase: LightPhase): number => {
  const next = duration - PHASE_ADJUST_SECS
  if (phase === LightPhase.Red) return Math.max(next, MIN_RED_SECS)
  return Math.max(next, 0)
}

export class RLController implements SignalController {
  private readonly actionSource: SignalActionSource | null
  /** Actions queued by `applyAction`; consumed by the next `decide()`. */
  private pending: SignalActionName[] = []
  /** simTime until which the light is held AllRed (-Infinity = not held). */
  private allRedUntil = Number.NEGATIVE_INFINITY
  /** The phase to resume when the all-red ends. */
  private resumePhase: LightPhase = LightPhase.Green
  /** The remaining time the resumed phase had when the all-red began. */
  private resumeRemaining = 0

  constructor(deps: RLControllerDeps = {}) {
    this.actionSource = deps.actionSource ?? null
  }

  applyAction(_light: TrafficLight, action: SignalActionName): void {
    // Synchronous: mutate the pending queue ONLY. The next decide()
    // consumes it — this method never calls decide() (007 §2).
    this.pending.push(action)
  }

  decide(light: TrafficLight, network: RoadNetwork, simTime: number): SignalDecision {
    // 1. Ask the action source for this light's action and queue it
    //    exactly like an injected `applyAction()`.
    const sourced = this.actionSource?.nextAction(light, network, simTime) ?? null
    if (sourced !== null) this.pending.push(sourced)

    // 2. Consume the pending queue (007 §2: "next decide() consumes").
    const actions = this.pending
    this.pending = []

    // 3. The base phase machine — the same transitions as
    //    `FixedCycleController` (green → yellow → red → green).
    let phase = light.phase
    let duration = light.phaseRemaining
    if (light.phaseRemaining <= 0) {
      if (phase === LightPhase.Green) {
        phase = LightPhase.Yellow
        duration = YELLOW_SECS
      } else if (phase === LightPhase.Yellow) {
        phase = LightPhase.Red
        duration = RED_SECS
      } else {
        phase = LightPhase.Green
        duration = GREEN_SECS
      }
    }

    // 3b. A clearance that ended with the previous step resumes BEFORE the
    //     actions are applied, so the resume point is the interrupted phase
    //     (with the time it had left) — not the all-red state the light was
    //     left in. Without this order a preempt landing on that step would
    //     overwrite the resume point and the interrupted phase's remaining
    //     time would be lost.
    if (this.allRedUntil > Number.NEGATIVE_INFINITY && simTime >= this.allRedUntil) {
      this.allRedUntil = Number.NEGATIVE_INFINITY
      phase = this.resumePhase
      duration = this.resumeRemaining
    }

    // 4. Apply the queued actions, in order.
    let preempt = false
    for (const action of actions) {
      switch (action) {
        case 'extend_green':
          // The green may grow by 5 s, but never past `MAX_GREEN_SECS` —
          // the same bound the Python training sim uses, so a policy
          // trained against one side behaves the same on the other. It
          // bounds the *remaining* time, not the wall-clock duration.
          duration = Math.min(duration + PHASE_ADJUST_SECS, MAX_GREEN_SECS)
          break
        case 'shorten_red':
          duration = shrinkRed(duration, phase)
          break
        case 'preempt':
        case 'force_all_red':
          preempt = true
          break
        case 'no_op':
          break
      }
    }

    const available = this.availableActions(phase, duration)

    if (preempt) {
      // All-red clearance. Remember where to resume, unless the light is
      // already clearing (a second preempt must not lose the resume point).
      // `allRedUntil` is `-Infinity` exactly when the light is not clearing:
      // step 3b resets it when a clearance ends.
      if (this.allRedUntil === Number.NEGATIVE_INFINITY) {
        this.resumePhase = phase
        this.resumeRemaining = duration
      }
      this.allRedUntil = simTime + ALL_RED_SECS
      return {
        phase: LightPhase.AllRed,
        duration: ALL_RED_SECS,
        actions: available,
        decidedAt: simTime,
      }
    }

    if (simTime < this.allRedUntil) {
      // Still clearing the intersection.
      return {
        phase: LightPhase.AllRed,
        duration: this.allRedUntil - simTime,
        actions: available,
        decidedAt: simTime,
      }
    }

    return { phase, duration, actions: available, decidedAt: simTime }
  }

  /**
   * The action space offered to the agent, with the availability flags of
   * 007 §2 ("preemption is only legal when the light is idle").
   */
  private availableActions(phase: LightPhase, duration: number): ReadonlyArray<SignalAction> {
    const clearing = phase === LightPhase.AllRed
    return [
      { name: 'extend_green', available: phase === LightPhase.Green },
      {
        name: 'shorten_red',
        available: phase === LightPhase.Red && duration > MIN_RED_SECS,
      },
      { name: 'preempt', available: !clearing },
      { name: 'force_all_red', available: !clearing },
      { name: 'no_op', available: true },
    ]
  }
}
