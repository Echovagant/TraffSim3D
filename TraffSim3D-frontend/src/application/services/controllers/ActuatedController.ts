// Default: green extends if queue > 0, red shortens if opposite axis empty.
// Per 007 §3.B: 5s extension per check, max 60s green, min 10s red,
// 3s yellow clear (not shortenable).
//
// Note: when both axes have continuous traffic (the default scene), the
// red shortening rarely fires — the queue stays > 0. This is
// intentional: 007 §3.B says "shorten red when opposite queue = 0",
// and the default scene always has cars. Operators wanting the
// shortening visible should load a low-density scene.
import type { TrafficLight } from '@domain/entities/TrafficLight'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import type { SignalAction, SignalController, SignalDecision } from '../signalController'
import { getQueueLength, getAxisQueueLength } from '../signalController'
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
      const queue = getQueueLength(light, network)
      if (queue > 0 && light.phaseRemaining < MAX_GREEN_SECS - GREEN_EXTENSION_STEP) {
        duration = Math.min(MAX_GREEN_SECS, light.phaseRemaining + GREEN_EXTENSION_STEP)
      }
    } else if (light.phase === LightPhase.Red) {
      // Mid-red: shorten if the opposite axis has zero queue (no
      // point holding red for cross-traffic that isn't coming).
      // 016 H4 mitigation.
      const oppositeAxis: 'ns' | 'ew' = light.axis === 'ns' ? 'ew' : 'ns'
      const oppositeRoadId = `r-${oppositeAxis}`
      const oppositeRoad = network.roads[oppositeRoadId]
      if (oppositeRoad && light.phaseRemaining > MIN_RED_SECS) {
        const oppositeQueue = getAxisQueueLength({ ...light, axis: oppositeAxis }, network)
        if (oppositeQueue === 0) {
          phase = LightPhase.Yellow
          duration = YELLOW_CLEAR_SECS
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
