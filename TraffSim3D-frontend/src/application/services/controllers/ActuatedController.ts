// Default: green extends if queue > 0, red shortens if opposite axis empty.
// Per 007 §3.B: 5s extension per check, max 60s green, min 10s red,
// 3s yellow clear (not shortenable).
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
import { axisRoadsForLight, getQueueLength, getAxisQueueLength } from '../signalController'
import { LightPhase } from '@domain/value-objects/Phase'
import {
  MAX_GREEN_SECS,
  GREEN_EXTENSION_STEP,
  MIN_RED_SECS,
  YELLOW_CLEAR_SECS,
} from '@shared/constants/simulation'

const BASE_GREEN = 30
const BASE_RED = 30

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

  /** How many reds this light shortened — see {@link shortenedReds}. */
  get shortenRedCount(): number {
    return this.shortenedReds
  }

  decide(light: TrafficLight, network: RoadNetwork, simTime: number): SignalDecision {
    let phase: LightPhase = light.phase
    let duration = light.phaseRemaining
    if (light.phaseRemaining <= 0) {
      // Phase transition — exit this phase, set next phase + duration.
      if (light.phase === LightPhase.Green) {
        phase = LightPhase.Yellow
        duration = YELLOW_CLEAR_SECS
      } else if (light.phase === LightPhase.Yellow) {
        phase = LightPhase.Red
        duration = BASE_RED
      } else {
        // Red → Green
        phase = LightPhase.Green
        duration = BASE_GREEN
      }
    } else if (light.phase === LightPhase.Green) {
      // Mid-green: extend if there's a queue and we're below the cap.
      const queue = getQueueLength(light, network, simTime)
      if (queue > 0 && light.phaseRemaining < MAX_GREEN_SECS - GREEN_EXTENSION_STEP) {
        duration = Math.min(MAX_GREEN_SECS, light.phaseRemaining + GREEN_EXTENSION_STEP)
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
