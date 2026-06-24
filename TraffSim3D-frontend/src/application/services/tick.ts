// src/application/services/tick.ts
//
// M2-C (plan 017): tick signature is `tick(network, dt, simTime, ctx: TickContext)`.
// This supersedes plan 010's 6-arg signature. The 5th param is now a
// single `ctx: TickContext` that bundles:
//   - rapierWorld       (M2-A physics)
//   - signal            (M2-B per-light signal controllers)
//   - trajectoryExporter (M2-C per-tick trajectory sample)
//   - sensorRegistry    (M2-C per-tick LiDAR scan)
//   - lidarEnabled      (M2-C UI toggle)
//   - getHostPose       (M2-C sensor host pose lookup)
//
// See plans/m2-interface-contract.md §4 for the per-tick event ordering.

import type { RoadNetwork } from '@domain/entities/RoadNetwork';
import type { Vehicle } from '@domain/entities/Vehicle';
import type { Road } from '@domain/entities/Road';
import { LightPhase } from '@domain/value-objects/Phase';
import { inIntersectionBox, lanePoint, roadLength, laneForwardSign } from '@domain/services/laneGeometry';
import {
  MAX_SPEED,
  MIN_GAP,
  STOP_LINE_BUFFER,
  STOP_LINE_DISTANCE,
  TIME_HEADWAY,
  TRAJECTORY_SAMPLE_INTERVAL,
  DEFAULT_CONTROLLER_KIND,
} from '@shared/constants/simulation';
import type { RapierWorld, ContactEvent, Vec3 } from '@infrastructure/physics';
import { findNearestLane } from './laneFrameSync';
import {
  createSignalController,
  type SignalController,
  type ControllerKind,
} from './signalController';
import type { TrajectoryExporter } from '@infrastructure/export';
import type { SensorRegistry } from './sensors/SensorRegistry';

/** Signal-controller cache + active kind. Built once by worldStore,
 *  passed by reference each tick. tick() never mutates this object —
 *  it only calls `controller.decide(...)` and reads `controllerKind`. */
export interface SignalContext {
  controllers: Map<string, SignalController>;
  controllerKind: ControllerKind;
  /** Plan 028: read by tick when lazily creating a new
   *  CoordinatedController (M2-B green-wave). */
  getCoordinatedOffsets: () => ReadonlyMap<string, number>;
  isCoordinatedEnabled: () => boolean;
}

export interface TickContext {
  rapierWorld: RapierWorld | null;
  signal: SignalContext | null;
  trajectoryExporter: TrajectoryExporter | null;
  sensorRegistry: SensorRegistry | null;
  lidarEnabled: boolean;
  /** Lookup host vehicle's live pose (used by sensor scan). */
  getHostPose: (vehicleId: string) => { position: Vec3; heading: number } | null;
  /** Vehicle currently being dragged on the 3D canvas (M1.5, plan 023).
   *  When non-null, tick() skips Rapier applyControl + position re-derivation
   *  for this vehicle so the drag handler can move it freely. */
  draggingId: string | null;
}

export const tick = (
  network: RoadNetwork,
  dt: number,
  simTime: number,
  ctx: TickContext,
): void => {
  // 1. Advance traffic-light phases via per-light SignalController
  //    (M2-B, plan 010). Replaces M1's hard-coded 30/3/30 loop.
  if (ctx.signal) {
    for (const inter of Object.values(network.intersections)) {
      for (const light of inter.trafficLights) {
        light.phaseRemaining -= dt;
        let controller = ctx.signal.controllers.get(light.id);
        if (!controller) {
          // Lazy create (covers lights added after reset/hydrate).
          controller = createSignalController(ctx.signal.controllerKind, {
            getCoordinatedOffsets: ctx.signal.getCoordinatedOffsets,
            isCoordinatedEnabled: ctx.signal.isCoordinatedEnabled,
          });
          ctx.signal.controllers.set(light.id, controller);
        }
        const decision = controller.decide(light, network, simTime);
        light.phase = decision.phase;
        light.phaseRemaining = decision.duration;
      }
    }
  } else {
    // M1 fallback: no Rapier → no controllers yet, keep hand-rolled cycle.
    for (const inter of Object.values(network.intersections)) {
      for (const light of inter.trafficLights) {
        light.phaseRemaining -= dt;
        if (light.phaseRemaining <= 0) {
          if (light.phase === LightPhase.Green) {
            light.phase = LightPhase.Yellow;
            light.phaseRemaining = 3;
          } else if (light.phase === LightPhase.Yellow) {
            light.phase = LightPhase.Red;
            light.phaseRemaining = light.cycleSeconds - 33;
          } else {
            light.phase = LightPhase.Green;
            light.phaseRemaining = 30;
          }
        }
      }
    }
  }

  // 2. Stamp each vehicle's intersection-entry time (M1.5 — keep).
  updateIntersectionEntry(network, simTime);

  // 3. Compute each vehicle's target speed (light + leader).
  for (const v of Object.values(network.vehicles)) {
    const road = network.roads[v.roadId];
    if (!road) continue;
    v.targetSpeed = road.speedLimit;
    applyTrafficLightConstraint(v, road, network);
    applyCarFollowingConstraint(v, road, network);
  }

  // 4. Cross-road yield (先到先行) — M1.5 right-of-way priority.
  applyCrossRoadYield(network);

  // 5-6. Hand each vehicle's control to Rapier + step.
  if (ctx.rapierWorld) {
    for (const v of Object.values(network.vehicles)) {
      // Skip the dragged vehicle — its position is driven by the
      // editor's drag handler, not by Rapier.
      if (v.id === ctx.draggingId) continue;
      const road = network.roads[v.roadId];
      if (!road) continue;
      const heading = v.heading;
      ctx.rapierWorld.applyControl(
        v.id,
        { throttle: 1, brake: v.status === 'crashed' ? 1 : 0, steering: 0 },
        v.targetSpeed,
        heading,
      );
    }
    const result = ctx.rapierWorld.step(dt);

    // 7. Classify contact events → crash status.
    classifyContacts(network, result.contactEvents);

    // 8. Re-derive Vehicle.position / heading from Rapier pose.
    //    Skip the dragged vehicle.
    for (const v of Object.values(network.vehicles)) {
      if (v.id === ctx.draggingId) continue;
      const pose = ctx.rapierWorld.readPose(v.id);
      if (!pose) continue;
      v.position.x = pose.position.x;
      v.position.y = pose.position.y;
      v.position.z = pose.position.z;
      v.heading = pose.heading;
      v.speed = pose.speed;
      const nearest = findNearestLane(v, network);
      v.laneIndex = nearest.laneIndex;
      v.s = nearest.s;
    }
  } else {
    // M1 fallback: no Rapier → hand-rolled move+s wrap.
    for (const v of Object.values(network.vehicles)) {
      const road = network.roads[v.roadId];
      if (!road) continue;
      if (v.speed < v.targetSpeed) v.speed = Math.min(v.targetSpeed, v.speed + 3.5 * dt);
      else if (v.speed > v.targetSpeed) v.speed = Math.max(v.targetSpeed, v.speed - 10.0 * dt);
      v.speed = Math.max(0, Math.min(MAX_SPEED, v.speed));
      const sign = laneForwardSign(v.laneIndex, road.laneCount);
      v.s += v.speed * sign * dt;
      const len = roadLength(road);
      if (v.s > len) v.s -= len;
      if (v.s < 0) v.s += len;
      const lp = lanePoint(road, v.laneIndex, v.s);
      v.position.x = lp.position.x;
      v.position.z = lp.position.z;
      v.heading = lp.heading;
    }
  }

  // 9. (M2-C) LiDAR scan — only when enabled (perf gate). 017 H1 fix:
  //    scan() is actually called from inside tick.ts.
  if (ctx.lidarEnabled && ctx.sensorRegistry && ctx.rapierWorld) {
    ctx.sensorRegistry.scanAll(ctx.rapierWorld, simTime, ctx.getHostPose);
  }

  // 10. (M2-C) Trajectory export — per-tick 10Hz sampling, decoupled
  //     from LiDAR (always runs unless the exporter is null).
  if (ctx.trajectoryExporter) {
    ctx.trajectoryExporter.record(network, simTime, TRAJECTORY_SAMPLE_INTERVAL);
  }

  // 11. Update status.
  for (const v of Object.values(network.vehicles)) {
    if (v.status !== 'crashed') {
      v.status = v.speed < 0.5 ? 'waiting' : 'driving';
    }
  }
};

/** M1.5 — stamp simTime on entering intersection. */
const updateIntersectionEntry = (network: RoadNetwork, simTime: number): void => {
  for (const v of Object.values(network.vehicles)) {
    const road = network.roads[v.roadId];
    if (!road) continue;
    if (inIntersectionBox(road, v.s)) {
      if (v.enteredIntersectionAt === null) {
        v.enteredIntersectionAt = simTime;
      }
    } else {
      v.enteredIntersectionAt = null;
    }
  }
};

/** M1 复制 — 红灯/黄灯 prepare-to-stop 逻辑 (M2-B 仍要用). */
const applyTrafficLightConstraint = (v: Vehicle, road: Road, network: RoadNetwork): void => {
  const len = roadLength(road);
  const stopLineS = len / 2 - STOP_LINE_DISTANCE;
  if (v.s >= stopLineS) return;
  const distToStopLine = stopLineS - v.s;
  if (distToStopLine <= 0) return;
  for (const inter of Object.values(network.intersections)) {
    if (!inter.connectedRoads.includes(road.id)) continue;
    for (const light of inter.trafficLights) {
      const roadIsNS = Math.abs(road.endNode.z - road.startNode.z) > Math.abs(road.endNode.x - road.startNode.x);
      const lightAxisMatches = (roadIsNS && light.axis === 'ns') || (!roadIsNS && light.axis === 'ew');
      if (!lightAxisMatches) continue;
      // M2-B (plan 016 H3): exhaustive phase set.
      // Red-family phases (Red / RedLeft / AllRed / FlashingRed) = full stop.
      // Yellow-family (Yellow / YellowLeft) = prepare to stop.
      // FlashingYellow = slow down (not stop). FlashingRed = stop (4-way).
      // Dark / Green-family = no constraint here.
      if (light.phase === LightPhase.Red
        || light.phase === LightPhase.Yellow
        || light.phase === LightPhase.RedLeft
        || light.phase === LightPhase.YellowLeft
        || light.phase === LightPhase.AllRed
        || light.phase === LightPhase.FlashingRed) {
        const braking = (v.speed * v.speed) / 20 + STOP_LINE_BUFFER;
        if (distToStopLine <= braking) {
          v.targetSpeed = 0;
          return;
        }
      } else if (light.phase === LightPhase.FlashingYellow) {
        // Slow approach: targetSpeed halved against the speed limit.
        v.targetSpeed = Math.min(v.targetSpeed, road.speedLimit * 0.5);
      }
      return;
    }
  }
};

/** M1 复制 — Newell car-following. */
const applyCarFollowingConstraint = (v: Vehicle, road: Road, network: RoadNetwork): void => {
  const sign = laneForwardSign(v.laneIndex, road.laneCount);
  let bestGap = Infinity;
  let leader: Vehicle | null = null;
  for (const other of Object.values(network.vehicles)) {
    if (other.id === v.id) continue;
    if (other.roadId !== road.id) continue;
    if (other.laneIndex !== v.laneIndex) continue;
    const ds = sign === 1 ? other.s - v.s : v.s - other.s;
    if (ds <= 0) continue;
    if (ds > 80) continue;
    if (ds < bestGap) {
      bestGap = ds;
      leader = other;
    }
  }
  if (!leader) return;
  const gap = Math.max(0, bestGap - 4);
  const safeGap = leader.speed * TIME_HEADWAY + MIN_GAP;
  if (gap >= safeGap) return;
  v.targetSpeed = leader.speed;
};

const applyCrossRoadYield = (network: RoadNetwork): void => {
  const cars = Object.values(network.vehicles);
  for (let i = 0; i < cars.length; i++) {
    const a = cars[i]!;
    const roadA = network.roads[a.roadId];
    if (!roadA) continue;
    for (let j = i + 1; j < cars.length; j++) {
      const b = cars[j]!;
      const roadB = network.roads[b.roadId];
      if (!roadB) continue;
      if (a.roadId === b.roadId) continue;
      if (a.enteredIntersectionAt !== null && b.enteredIntersectionAt === null) {
        b.targetSpeed = 0;
      } else if (b.enteredIntersectionAt !== null && a.enteredIntersectionAt === null) {
        a.targetSpeed = 0;
      } else if (a.enteredIntersectionAt !== null && b.enteredIntersectionAt !== null) {
        if (a.enteredIntersectionAt < b.enteredIntersectionAt) {
          b.targetSpeed = 0;
        } else if (b.enteredIntersectionAt < a.enteredIntersectionAt) {
          a.targetSpeed = 0;
        }
      }
    }
  }
};

const classifyContacts = (network: RoadNetwork, events: ReadonlyArray<ContactEvent>): void => {
  for (const e of events) {
    const va = network.vehicles[e.colliderA];
    const vb = network.vehicles[e.colliderB];
    if (!va || !vb) continue;
    va.status = 'crashed';
    vb.status = 'crashed';
  }
};

// DEFAULT_CONTROLLER_KIND re-exported so existing callers can still import
// from this module without touching the shared constants path.
export { DEFAULT_CONTROLLER_KIND };
