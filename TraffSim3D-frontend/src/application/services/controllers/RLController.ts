// M4 stub: identical to FixedCycle for now. M4 plugs PPO/SAC
// agent in via applyAction().
import type { TrafficLight } from '@domain/entities/TrafficLight';
import type { RoadNetwork } from '@domain/entities/RoadNetwork';
import type { SignalAction, SignalController, SignalDecision } from '../signalController';
import { FixedCycleController } from './FixedCycleController';

export class RLController implements SignalController {
  private inner = new FixedCycleController();
  decide(light: TrafficLight, network: RoadNetwork, simTime: number): SignalDecision {
    return this.inner.decide(light, network, simTime);
  }
  applyAction(light: TrafficLight, action: SignalAction['name']): void {
    // M4: PPO action queue integration goes here.
    // For M2-B this is a no-op — the inner fixed cycle runs.
    this.inner.applyAction(light, action);
  }
}