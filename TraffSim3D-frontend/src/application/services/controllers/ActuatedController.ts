// Default: green extends if queue > 0, red shortens if opposite axis empty.
// Per 007 §3.B: 5s extension per check, max 60s green, min 10s red,
// 3s yellow clear + 3s all-red clear (neither shortenable).
//
// Note: when both axes have continuous traffic (the default scene), the
// red shortening rarely fires — the queue stays > 0. This is
// intentional: 007 §3.B says "shorten red when opposite queue = 0",
// and the default scene always has cars. Operators wanting the
// shortening visible should load a low-density scene.
//
// ## The shortening shortens the red — it never replaces it
//
// "Shorten the red" means **cut the remaining red down to the floor**
// (`MIN_RED_SECS`), exactly like the five-action vocabulary's
// `shorten_red` and the Python sim's `shorten_red` do: the phase stays
// red, only the clock changes. The red then counts down and the phase
// machine's Red → Green transition runs as usual.
//
// The previous code switched the phase to Yellow instead. A Yellow's
// only successor is Red(BASE_RED), so the shortened red could never
// reach Green — red → yellow → red → … , forever. With the opposite
// axis's queue empty for long stretches (the queue statistic counts the
// vehicles actually waiting at the projected stop lines, so a moving
// axis reads "no queue"), the axis held at red never got a green at
// all: in the built-in cross scene three of the six vehicles stood at
// the stop line for the whole run while the opposite axis ran free.
//
// The invariant this class must keep: **a red always ends, so every
// axis reaches Green.** Nothing here may restart a red — the remaining
// red only ever counts down.
import type { TrafficLight } from '@domain/entities/TrafficLight'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import type { SignalAction, SignalController, SignalDecision } from '../signalController'
import {
  axisRoadsForLight,
  getQueueLength,
  getAxisQueueLength,
  perpendicularLightForLight,
} from '../signalController'
import { LightPhase } from '@domain/value-objects/Phase'
import {
  MAX_GREEN_SECS,
  GREEN_EXTENSION_STEP,
  MIN_RED_SECS,
  ALL_RED_CLEARANCE_SECS,
  GREEN_PHASE_SECS,
  PHASE_EPSILON_SECS,
  RED_PHASE_SECS,
  YELLOW_CLEAR_SECS,
} from '@shared/constants/simulation'

/**
 * Is the light still *using* its phase — i.e. may the perpendicular axis
 * not go green yet?
 *
 * Green and yellow are the axis' service, the all-red is the last part of
 * its clearance. Only a light that sits in its **red** has handed the
 * junction over.
 */
const isStillClearing = (phase: LightPhase): boolean =>
  phase === LightPhase.Green ||
  phase === LightPhase.GreenLeft ||
  phase === LightPhase.Yellow ||
  phase === LightPhase.YellowLeft ||
  phase === LightPhase.AllRed

export class ActuatedController implements SignalController {
  /**
   * How many times this light's red was shortened.
   *
   * Diagnostic only — the shortening itself is reported per decision as
   * the `shorten_red` action. The counter exists because the livelock
   * this class used to have was **silent**: a light that shortened its
   * red on every cycle and never reached green looked exactly like a
   * light with no traffic. A caller that wants to see the shortening
   * (a debug panel, a test) can read it without parsing decisions.
   */
  private shortenedReds = 0

  /**
   * When the light entered its current green (`simTime`), or `null` when it
   * is not green.
   *
   * `MAX_GREEN_SECS` is the **duration** of a green ("after this the light
   * MUST cycle to yellow even with queue"), so the controller has to know
   * how long the green has already run — the countdown alone cannot say:
   * the extension tops the remaining time back up, so a green with a
   * permanent queue never ends on its own.
   */
  private greenStartedAt: number | null = null

  /** How many reds this light shortened — see {@link shortenedReds}. */
  get shortenRedCount(): number {
    return this.shortenedReds
  }

  decide(light: TrafficLight, network: RoadNetwork, simTime: number): SignalDecision {
    let phase: LightPhase = light.phase
    let duration = light.phaseRemaining
    if (light.phase !== LightPhase.Green) {
      this.greenStartedAt = null
    } else if (this.greenStartedAt === null) {
      this.greenStartedAt = simTime
    }
    if (light.phaseRemaining <= PHASE_EPSILON_SECS) {
      // Phase transition — exit this phase, set next phase + duration.
      if (light.phase === LightPhase.Green) {
        phase = LightPhase.Yellow
        duration = YELLOW_CLEAR_SECS
      } else if (light.phase === LightPhase.Yellow) {
        // The clearance-yellow is followed by an explicit all-red, so the
        // junction shows nothing to anybody for 3 s before the red starts.
        phase = LightPhase.AllRed
        duration = ALL_RED_CLEARANCE_SECS
      } else if (light.phase === LightPhase.AllRed) {
        // The all-red runs out into a **full** red. Skipping the red is
        // what used to make the two axis groups ping-pong every 3 s.
        phase = LightPhase.Red
        duration = RED_PHASE_SECS
      } else {
        // Red → Green — but only once the **perpendicular** axis has
        // finished clearing.
        //
        // The actuated controller desynchronises the two axis groups (it
        // extends the green of the axis that has a queue and shortens the
        // red of the axis that has none), so the two phase machines no
        // longer hand over at the same instant. Without this wait the
        // hand-over would be instantaneous: the axis that just turned green
        // and the axis that is being cut would swap with **no all-red
        // clearance at all** — the thing the training sim's
        // `CLEARANCE_SECS` exists to prevent
        // (`app/apps/rl/sim_core.py`).
        //
        // Waiting until the perpendicular light sits in its **red** — i.e.
        // after its clearance-yellow and its all-red have run — keeps the
        // junction's 6 s clearance intact and the browser's timeline the
        // same shape as the training sim's.
        const perpendicular = perpendicularLightForLight(light, network)
        if (perpendicular !== null && isStillClearing(perpendicular.phase)) {
          // Stay red and try again on the next tick. The phase machine
          // re-enters this branch because the remaining time is 0.
          phase = LightPhase.Red
          duration = 0
        } else {
          phase = LightPhase.Green
          duration = GREEN_PHASE_SECS
        }
      }
    } else if (light.phase === LightPhase.Green) {
      // Mid-green: the green may be extended while there is a queue — but
      // only inside its `MAX_GREEN_SECS` budget, and only while the
      // **perpendicular** axis has nothing waiting.
      //
      // The budget is a bound on the green's **duration**, so a green that
      // has already had its full budget cycles to yellow now, even with a
      // queue waiting.
      //
      // The "perpendicular axis is idle" condition is the classical
      // actuated rule and the mirror image of the red-shortening below: an
      // axis may only hold the junction while nobody is waiting on the
      // other side. Without it the two rules fight each other — the green
      // is extended for an axis that has a queue while the other axis'
      // red is shortened for an axis that has none — and the junction
      // ping-pongs between the two axes every few seconds.
      const elapsed = simTime - (this.greenStartedAt ?? simTime)
      if (elapsed >= MAX_GREEN_SECS) {
        phase = LightPhase.Yellow
        duration = YELLOW_CLEAR_SECS
      } else {
        const queue = getQueueLength(light, network, simTime)
        const perpendicular = perpendicularLightForLight(light, network)
        const oppositeWaiting =
          perpendicular !== null && getAxisQueueLength(perpendicular, network, simTime) > 0
        if (
          queue > 0 &&
          !oppositeWaiting &&
          light.phaseRemaining < MAX_GREEN_SECS - GREEN_EXTENSION_STEP
        ) {
          duration = Math.min(MAX_GREEN_SECS, light.phaseRemaining + GREEN_EXTENSION_STEP)
        }
      }
    } else if (light.phase === LightPhase.Red) {
      // Mid-red: shorten if the opposite axis has zero queue (no
      // point holding red for cross-traffic that isn't coming).
      // 016 H4 mitigation.
      const oppositeAxis: 'ns' | 'ew' = light.axis === 'ns' ? 'ew' : 'ns'
      const oppositeLight = { ...light, axis: oppositeAxis }
      // The opposite approach is resolved **topologically** — the roads
      // connected to this light's intersection whose geometry matches
      // the opposite axis. The old lookup used the `r-${axis}` id
      // convention, which no road of an imported OSM map carries, so
      // this branch was unreachable on every imported map.
      const oppositeRoads = axisRoadsForLight(oppositeLight, network)
      if (oppositeRoads.length > 0 && light.phaseRemaining > MIN_RED_SECS) {
        const oppositeQueue = getAxisQueueLength(oppositeLight, network, simTime)
        if (oppositeQueue === 0) {
          // The red is **shortened**, not replaced: the remaining red is
          // cut down to the floor and then counts down to zero, so the
          // machine's Red → Green transition still runs. Switching the
          // phase to Yellow here (the old behaviour) sent the light
          // into a red → yellow → red loop with no path to Green —
          // see the module header.
          duration = MIN_RED_SECS
          this.shortenedReds += 1
          return {
            phase,
            duration,
            actions: [{ name: 'shorten_red', available: true }],
            decidedAt: simTime,
          }
        }
      }
    }
    return {
      phase,
      duration,
      actions: [{ name: 'no_op', available: true }],
      decidedAt: simTime,
    }
  }
  applyAction(_light: TrafficLight, _action: SignalAction['name']): void {
    // No external action queue yet — RLController implements it.
  }
}
