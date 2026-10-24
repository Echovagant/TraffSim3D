// src/application/services/controllers/junctionPlan.ts
//
// The junction's phase plan — the single source of truth for a junction's
// signal, and the machinery every controller builds on.
//
// ## The shape
//
// One junction, one plan, one clock:
//
//   Green(axis) → Yellow(axis) → AllRed(axis) → Green(other) → …
//
// with 30 s / 3 s / 3 s per leg, so a junction's cycle is 72 s and the
// "neither axis is green" gap before **every** green is exactly 6 s. The
// clearance is 6 s **by construction** — it is not the sum of two
// independent per-light countdowns that happen to line up.
//
// The lights are views of the plan: the served axis shows the junction's
// phase, the other one shows red with the time until it is served.
//
// This is the shape the Python training sim has (`app/apps/rl/sim_core.py`
// → `class TrafficLight`: one object, two boolean axes, one clock).

import type { Intersection } from '@domain/entities/Intersection'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import type { TrafficLight } from '@domain/entities/TrafficLight'
import { LightPhase } from '@domain/value-objects/Phase'
import {
  ALL_RED_CLEARANCE_SECS,
  ALL_RED_SECS,
  GREEN_PHASE_SECS,
  PHASE_EPSILON_SECS,
  YELLOW_CLEAR_SECS,
} from '@shared/constants/simulation'
import type {
  AxisSignalView,
  JunctionSignalPlan,
  SignalAction,
  SignalActionName,
  SignalAxis,
  SignalController,
} from '../signalController'

/** The other axis of the junction. */
export const otherAxis = (axis: SignalAxis): SignalAxis => (axis === 'ns' ? 'ew' : 'ns')

/**
 * The junction's plan state.
 *
 * One per junction, held by the junction's controller.
 */
export interface JunctionPlanState {
  /**
   * The junction's phase.
   *
   * `Green` / `Yellow` / `AllRed` are the three legs of a service slot;
   * `Red` is the junction **waiting** — the state a junction whose
   * lights are all red is adopted into, and the one the hand-over
   * leaves behind for the axis that is not being served.
   */
  phase: LightPhase
  /** The axis the junction is serving (Green / Yellow) or clearing (AllRed). */
  axis: SignalAxis
  /** Seconds left in the junction's phase. */
  remaining: number
  /**
   * When the current green started (`simTime`).
   *
   * `MAX_GREEN_SECS` bounds the green's **duration**, so a controller
   * that extends the green has to know how long it has already run. The
   * countdown alone cannot say: the extension tops the remaining time
   * back up.
   */
  greenStartedAt: number
  /**
   * The sim time until which the junction is held all-red
   * (`-Infinity` = not held).
   *
   * The hold **freezes** the plan's clock; when it ends the junction
   * resumes the phase it was interrupted in, with the time it had left.
   * That is the Python sim's `resume_state` trick
   * (`app/apps/rl/sim_core.py` → `TrafficLight.resume_state`).
   */
  allRedUntil: number
  /** The phase to resume when the hold ends. */
  resumePhase: LightPhase
  /** The axis to resume. */
  resumeAxis: SignalAxis
  /** The remaining time the resumed phase had. */
  resumeRemaining: number
}

/** A fresh, unheld plan state. */
export const newJunctionState = (
  phase: LightPhase,
  axis: SignalAxis,
  remaining: number,
  greenStartedAt: number,
): JunctionPlanState => ({
  phase,
  axis,
  remaining,
  greenStartedAt,
  allRedUntil: Number.NEGATIVE_INFINITY,
  resumePhase: phase,
  resumeAxis: axis,
  resumeRemaining: remaining,
})

/**
 * The light of `axis` at the junction, or `null` when the junction has no
 * light for that axis (a one-sided junction).
 */
export const axisLightFor = (junction: Intersection, axis: SignalAxis): TrafficLight | null =>
  junction.trafficLights.find((light) => light.axis === axis) ?? null

/**
 * Read the junction's initial plan off its lights.
 *
 * A junction that is already running carries the plan in the phase of the
 * light it is serving: the green light is the junction's green, its
 * yellow is the junction's yellow, its all-red is the junction's
 * clearance. Adopting the state (instead of starting a fresh cycle) is
 * what keeps a controller switch from flashing the signal.
 *
 * A junction whose lights are **all** red is the one state the plan
 * cannot express: nothing is being served. The axis whose red runs out
 * first is the one served next.
 */
export const adoptJunctionState = (junction: Intersection, simTime: number): JunctionPlanState => {
  const lights = junction.trafficLights
  const served =
    lights.find((light) => light.phase === LightPhase.Green) ??
    lights.find((light) => light.phase === LightPhase.Yellow) ??
    lights.find((light) => light.phase === LightPhase.AllRed)
  if (served) {
    // A green that is already running started `GREEN_PHASE_SECS -
    // remaining` seconds ago.
    const greenStartedAt =
      served.phase === LightPhase.Green
        ? simTime - (GREEN_PHASE_SECS - served.phaseRemaining)
        : simTime
    return newJunctionState(served.phase, served.axis, served.phaseRemaining, greenStartedAt)
  }
  let next = lights[0]
  for (const light of lights) {
    if (!next || light.phaseRemaining < next.phaseRemaining) next = light
  }
  const axis = next?.axis ?? 'ns'
  return newJunctionState(LightPhase.Red, axis, next?.phaseRemaining ?? GREEN_PHASE_SECS, simTime)
}

/**
 * Advance the plan's clock by `dt` and run the phase transitions.
 *
 * The transitions are the junction's:
 *
 *   Green → Yellow (3 s) → AllRed (3 s) → Green (the other axis)
 *
 * The all-red is the **last** part of the outgoing axis' clearance, so
 * the other axis only goes green once the clearance has run out — the
 * rule the actuated controller used to have to enforce by hand (and
 * which the per-light machines fought over).
 */
export const stepJunctionPlan = (state: JunctionPlanState, dt: number, simTime: number): void => {
  state.remaining -= dt
  if (state.remaining > PHASE_EPSILON_SECS) return
  if (state.phase === LightPhase.Green) {
    state.phase = LightPhase.Yellow
    state.remaining = YELLOW_CLEAR_SECS
  } else if (state.phase === LightPhase.Yellow) {
    state.phase = LightPhase.AllRed
    state.remaining = ALL_RED_CLEARANCE_SECS
  } else if (state.phase === LightPhase.Red) {
    // The junction was waiting for this axis: it is served now.
    state.phase = LightPhase.Green
    state.remaining = GREEN_PHASE_SECS
    state.greenStartedAt = simTime
  } else {
    // The clearance is over — the other axis takes the junction.
    state.phase = LightPhase.Green
    state.axis = otherAxis(state.axis)
    state.remaining = GREEN_PHASE_SECS
    state.greenStartedAt = simTime
  }
}

/**
 * The time until the waiting axis is served — its red countdown.
 *
 * While the junction serves an axis, the other one waits for the rest of
 * that green plus the clearance that follows it.
 */
const waitUntilServed = (state: JunctionPlanState): number => {
  if (state.phase === LightPhase.Green) {
    return state.remaining + YELLOW_CLEAR_SECS + ALL_RED_CLEARANCE_SECS
  }
  if (state.phase === LightPhase.Yellow) return state.remaining + ALL_RED_CLEARANCE_SECS
  if (state.phase === LightPhase.Red) {
    // The junction is waiting: the other axis is served a whole slot
    // (green + yellow + all-red) after this one.
    return state.remaining + GREEN_PHASE_SECS + YELLOW_CLEAR_SECS + ALL_RED_CLEARANCE_SECS
  }
  return state.remaining
}

/**
 * The junction's per-axis views — what each axis' light shows.
 *
 * While the junction is held all-red (a preemption) **neither** axis has
 * the right of way: the served axis shows the all-red, the other one
 * stays red.
 */
export const junctionViews = (
  state: JunctionPlanState,
  simTime: number,
): Record<SignalAxis, AxisSignalView> => {
  const waiting = otherAxis(state.axis)
  if (state.allRedUntil > Number.NEGATIVE_INFINITY) {
    const hold = Math.max(0, state.allRedUntil - simTime)
    return {
      [state.axis]: { phase: LightPhase.AllRed, remaining: hold },
      [waiting]: { phase: LightPhase.Red, remaining: hold + waitUntilServed(state) },
    } as Record<SignalAxis, AxisSignalView>
  }
  if (state.phase === LightPhase.Red) {
    // The junction is waiting: neither axis is served.
    return {
      [state.axis]: { phase: LightPhase.Red, remaining: state.remaining },
      [waiting]: { phase: LightPhase.Red, remaining: waitUntilServed(state) },
    } as Record<SignalAxis, AxisSignalView>
  }
  return {
    [state.axis]: { phase: state.phase, remaining: state.remaining },
    [waiting]: { phase: LightPhase.Red, remaining: waitUntilServed(state) },
  } as Record<SignalAxis, AxisSignalView>
}

/**
 * Hold the whole junction all-red until `simTime + durationSeconds`.
 *
 * The plan's clock is frozen and the interrupted phase is remembered, so
 * the junction resumes it with the time it had left.
 *
 * The resume point is the Python sim's `resume_state`: the phase **and**
 * its remaining time. A clearance that resumed into "nothing is served"
 * would wedge the junction — the browser's plan cannot produce that
 * state (every phase has a successor), but the resume point is recorded
 * all the same, so the junction always comes back to where it was.
 */
export const holdJunctionAllRed = (
  state: JunctionPlanState,
  simTime: number,
  durationSeconds: number,
): void => {
  if (state.allRedUntil === Number.NEGATIVE_INFINITY) {
    state.resumePhase = state.phase
    state.resumeAxis = state.axis
    state.resumeRemaining = state.remaining
  }
  state.allRedUntil = simTime + durationSeconds
}

/**
 * End the all-red hold, if it is over, and resume the interrupted phase.
 *
 * Returns `true` when the junction resumed.
 */
export const resumeJunctionIfHeld = (state: JunctionPlanState, simTime: number): boolean => {
  if (state.allRedUntil === Number.NEGATIVE_INFINITY) return false
  if (simTime < state.allRedUntil) return false
  state.allRedUntil = Number.NEGATIVE_INFINITY
  state.phase = state.resumePhase
  state.axis = state.resumeAxis
  state.remaining = state.resumeRemaining
  return true
}

/**
 * The junction a call target refers to.
 *
 * The controller decides for a **junction**; a caller may still name a
 * **light** (the older per-light call shape), in which case the
 * junction that owns the light is the one decided.
 */
export const junctionOf = (
  target: Intersection | TrafficLight,
  network: RoadNetwork,
): Intersection => {
  if ('trafficLights' in target) return target
  for (const inter of Object.values(network.intersections)) {
    if (inter.trafficLights.some((light) => light.id === target.id)) return inter
  }
  // A light that belongs to no junction (the Simulation Lab's
  // synthesised axis light) is a junction of its own.
  return {
    id: target.id,
    position: target.position,
    connectedRoads: [],
    trafficLights: [target],
    intersectionRadius: 0,
  }
}

/**
 * The shared machinery of a junction-level signal controller.
 *
 * It owns the junction's plan (the state, the clock and the action
 * queue); the subclasses add their own timing rules and their own
 * reading of the five actions.
 *
 * The order of a tick is the Python sim's
 * (`app/apps/rl/sim_core.py` → `SimCore.step`):
 *
 *   1. a hold that ended resumes — the interrupted phase continues with
 *      the time it had left,
 *   2. the junction's clock runs (frozen while the junction is held),
 *   3. the queued actions are applied,
 *   4. the controller's own timing rules run,
 *   5. the plan is built.
 */
export abstract class JunctionControllerBase implements SignalController {
  /** The junction's plan state — `null` until the first `decide()`. */
  protected state: JunctionPlanState | null = null
  /** Actions queued by `applyAction`; consumed by the next `decide()`. */
  protected pending: SignalActionName[] = []

  applyAction(_target: Intersection | TrafficLight, action: SignalActionName): void {
    // Synchronous: mutate the pending queue ONLY. The next decide()
    // consumes it — this method never calls decide().
    this.pending.push(action)
  }

  decide(
    target: Intersection | TrafficLight,
    network: RoadNetwork,
    simTime: number,
    dt = 0,
  ): JunctionSignalPlan {
    const junction = junctionOf(target, network)
    const state = this.ensureState(junction, simTime)
    // 1. Where the actions come from (the RL controller's action source).
    this.pollActions(state, junction, network, simTime)
    // 2. A hold that ended resumes BEFORE the clock runs on, so the
    //    interrupted phase continues with the time it had left.
    resumeJunctionIfHeld(state, simTime)
    // 3. The junction's clock.
    this.advance(state, junction, dt, simTime)
    // 4. The queued actions.
    const actions = this.takeActions()
    this.applyActions(state, actions, junction, network, simTime)
    // 5. The controller's own timing rules.
    this.tune(state, junction, network, simTime)
    // 6. The plan.
    return this.plan(state, simTime)
  }

  /** The junction's plan state, adopted from the lights on first use. */
  protected ensureState(junction: Intersection, simTime: number): JunctionPlanState {
    if (this.state === null) this.state = adoptJunctionState(junction, simTime)
    return this.state
  }

  /** Consume the queued actions. */
  protected takeActions(): SignalActionName[] {
    const actions = this.pending
    this.pending = []
    return actions
  }

  /**
   * Where the queued actions come from.
   *
   * The base queues nothing on its own; the RL controller polls its
   * action source here.
   */
  protected pollActions(
    _state: JunctionPlanState,
    _junction: Intersection,
    _network: RoadNetwork,
    _simTime: number,
  ): void {
    // no-op
  }

  /** Run the junction's clock. Frozen while the junction is held. */
  protected advance(
    state: JunctionPlanState,
    _junction: Intersection,
    dt: number,
    simTime: number,
  ): void {
    if (state.allRedUntil > Number.NEGATIVE_INFINITY) return
    stepJunctionPlan(state, dt, simTime)
  }

  /**
   * Apply the queued actions.
   *
   * The base handles the preemption (`preempt` / `force_all_red`): the
   * whole junction holds all-red and then resumes the interrupted
   * phase. The timing actions are the RL controller's business.
   */
  protected applyActions(
    state: JunctionPlanState,
    actions: readonly SignalActionName[],
    _junction: Intersection,
    _network: RoadNetwork,
    simTime: number,
  ): void {
    for (const action of actions) {
      if (action === 'preempt' || action === 'force_all_red') {
        holdJunctionAllRed(state, simTime, ALL_RED_SECS)
      }
    }
  }

  /** The controller's own timing rules (none by default). */
  protected tune(
    _state: JunctionPlanState,
    _junction: Intersection,
    _network: RoadNetwork,
    _simTime: number,
  ): void {
    // no-op
  }

  /** The action space the decision reports. */
  protected planActions(_state: JunctionPlanState, _simTime: number): ReadonlyArray<SignalAction> {
    return [{ name: 'no_op', available: true }]
  }

  /** Build the junction's plan. */
  protected plan(state: JunctionPlanState, simTime: number): JunctionSignalPlan {
    const held = state.allRedUntil > Number.NEGATIVE_INFINITY
    return {
      phase: held ? LightPhase.AllRed : state.phase,
      duration: held ? Math.max(0, state.allRedUntil - simTime) : state.remaining,
      axis: state.axis,
      views: junctionViews(state, simTime),
      actions: this.planActions(state, simTime),
      decidedAt: simTime,
    }
  }
}
