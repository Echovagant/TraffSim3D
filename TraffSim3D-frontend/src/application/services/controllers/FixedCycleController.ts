// M1-equivalent: 30s green + 3s yellow + 30s red, no extension.
// Reproduces the M1 hand-rolled cycle so the M1 perf gate stays
// valid when controllerKind='fixed-cycle'.
import type { TrafficLight } from '@domain/entities/TrafficLight';
import type { RoadNetwork } from '@domain/entities/RoadNetwork';
import type { SignalAction, SignalController, SignalDecision } from '../signalController';
import { LightPhase } from '@domain/value-objects/Phase';

const GREEN_SECS = 30;
const YELLOW_SECS = 3;
const RED_SECS = 30;

export class FixedCycleController implements SignalController {
  decide(light: TrafficLight, _network: RoadNetwork, simTime: number): SignalDecision {
    let phase: LightPhase = light.phase;
    let duration = light.phaseRemaining;
    if (light.phaseRemaining <= 0) {
      if (light.phase === LightPhase.Green) {
        phase = LightPhase.Yellow;
        duration = YELLOW_SECS;
      } else if (light.phase === LightPhase.Yellow) {
        phase = LightPhase.Red;
        duration = RED_SECS;
      } else {
        phase = LightPhase.Green;
        duration = GREEN_SECS;
      }
    }
    return { phase, duration, actions: [{ name: 'no_op', available: true }], decidedAt: simTime };
  }
  applyAction(_light: TrafficLight, _action: SignalAction['name']): void {
    // no-op
  }
}