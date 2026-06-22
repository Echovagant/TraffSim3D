import type { RoadNetwork } from '@domain/entities/RoadNetwork';
import { LightPhase } from '@domain/value-objects/Phase';

/** Advance the simulation by dt seconds. Mutates the network in place. */
export const tick = (network: RoadNetwork, dt: number): void => {
  // Move vehicles along their heading
  for (const v of Object.values(network.vehicles)) {
    v.position.x += Math.cos(v.heading) * v.speed * dt;
    v.position.z += Math.sin(v.heading) * v.speed * dt;
    // Wrap around the loop (50u box)
    if (v.position.x > 25) v.position.x = -25;
    if (v.position.x < -25) v.position.x = 25;
    if (v.position.z > 25) v.position.z = -25;
    if (v.position.z < -25) v.position.z = 25;
  }
  // Advance traffic light phases
  for (const inter of Object.values(network.intersections)) {
    for (const light of inter.trafficLights) {
      light.phaseRemaining -= dt;
      if (light.phaseRemaining <= 0) {
        if (light.phase === LightPhase.Green) {
          light.phase = LightPhase.Yellow;
          light.phaseRemaining = 3;
        } else if (light.phase === LightPhase.Yellow) {
          light.phase = LightPhase.Red;
          light.phaseRemaining = light.cycleSeconds - 33;  // green + yellow
        } else {
          light.phase = LightPhase.Green;
          light.phaseRemaining = 30;
        }
      }
    }
  }
};
