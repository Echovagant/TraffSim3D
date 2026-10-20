/** M4 stub: RL signal controller placeholder.
 *
 * Current implementation is **identical to FixedCycleController** — it does NOT integrate
 * PPO/SAC agents yet (backlog). Users selecting "RL" in UI will still run fixed-cycle logic.
 * True RL inference requires loading weights via worldStore.loadPolicy() → mlpInference.mlpForwardMean().
 * For real signal control, see `worldStore` + `tick.ts` policy replay path (Plan 049), not this stub.
 *
 * M4 TODO: integrate PPO action queue via applyAction(). Until then: fixed cycle.
 */
import type { TrafficLight } from '@domain/entities/TrafficLight'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import type { SignalAction, SignalController, SignalDecision } from '../signalController'
import { FixedCycleController } from './FixedCycleController'

export class RLController implements SignalController {
  private inner = new FixedCycleController()
  decide(light: TrafficLight, network: RoadNetwork, simTime: number): SignalDecision {
    return this.inner.decide(light, network, simTime)
  }
  applyAction(light: TrafficLight, action: SignalAction['name']): void {
    // M4: PPO action queue integration goes here.
    // For M2-B this is a no-op — the inner fixed cycle runs.
    this.inner.applyAction(light, action)
  }
}
