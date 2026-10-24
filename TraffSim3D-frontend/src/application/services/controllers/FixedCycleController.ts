// 30s green + 3s yellow + 3s all-red + 30s red, no extension.
//
// The cycle matches the Python training sim's timeline shape (a 30 s
// phase separated by a 6 s clearance — `app/apps/rl/sim_core.py`
// `CLEARANCE_SECS`), so a policy trained there behaves the same here.
// The frame-rate gate stays valid when controllerKind='fixed-cycle'.
import type { TrafficLight } from '@domain/entities/TrafficLight'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import type { SignalAction, SignalController, SignalDecision } from '../signalController'
import { LightPhase } from '@domain/value-objects/Phase'
import {
  ALL_RED_CLEARANCE_SECS,
  GREEN_PHASE_SECS,
  PHASE_EPSILON_SECS,
  RED_PHASE_SECS,
  YELLOW_CLEAR_SECS,
} from '@shared/constants/simulation'

export class FixedCycleController implements SignalController {
  decide(light: TrafficLight, _network: RoadNetwork, simTime: number): SignalDecision {
    let phase: LightPhase = light.phase
    let duration = light.phaseRemaining
    if (light.phaseRemaining <= PHASE_EPSILON_SECS) {
      if (light.phase === LightPhase.Green) {
        phase = LightPhase.Yellow
        duration = YELLOW_CLEAR_SECS
      } else if (light.phase === LightPhase.Yellow) {
        // The clearance-yellow is followed by an explicit all-red: the
        // junction shows nothing to anybody for 3 s before the red starts.
        phase = LightPhase.AllRed
        duration = ALL_RED_CLEARANCE_SECS
      } else if (light.phase === LightPhase.AllRed) {
        // The all-red runs out into a **full** red — not straight back to
        // green. Skipping the red is what used to make a desynchronised
        // pair of lights ping-pong every 3 s.
        phase = LightPhase.Red
        duration = RED_PHASE_SECS
      } else {
        phase = LightPhase.Green
        duration = GREEN_PHASE_SECS
      }
    }
    return { phase, duration, actions: [{ name: 'no_op', available: true }], decidedAt: simTime }
  }
  applyAction(_light: TrafficLight, _action: SignalAction['name']): void {
    // no-op
  }
}
