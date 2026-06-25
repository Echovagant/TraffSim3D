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
import { inIntersectionBox, lanePoint, laneOffset, roadLength, laneForwardSign } from '@domain/services/laneGeometry';
import { steerLateralVelocity, LANE_CHANGE_CONVERGED_M, perpendicularOffsetAlongRoad } from '@domain/services/laneChange';
import { smoothAccel, statusFromHysteresis, safeGapGipps } from '@domain/services/vehicleDynamics';
import { computeSteeringAngle, steeringAngleToOmega } from '@domain/services/purePursuit';
import { tickOobCleanup } from './oobCleanup';
import {
  CRASH_IMPULSE_THRESHOLD,
  MAX_SPEED,
  MIN_GAP,
  SPAWN_POINT_RELEASE_DISTANCE,
  STOP_LINE_BUFFER,
  STOP_LINE_DISTANCE,
  TIME_HEADWAY,
  TRAJECTORY_SAMPLE_INTERVAL,
  DEFAULT_CONTROLLER_KIND,
  VEHICLE_PURE_PURSUIT,
} from '@shared/constants/simulation';
import type { RapierWorld, ContactEvent, Vec3 } from '@infrastructure/physics';
import { findNearestLane } from './laneFrameSync';
import { FixedStepScheduler } from './fixedStepScheduler';
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
  /** Plan 038: optional fixed-step scheduler. When non-null, the
   *  trajectory exporter is only invoked on fixed-step boundaries
   *  (10 Hz by default), regardless of how fast the render loop
   *  fires. When null, the exporter runs per-frame (back-compat
   *  for tests and the legacy M2-C path). */
  fixedStepScheduler: FixedStepScheduler | null;
  /** Vehicle currently being dragged on the 3D canvas (M1.5, plan 023).
   *  When non-null, tick() skips Rapier applyControl + position re-derivation
   *  for this vehicle so the drag handler can move it freely. */
  draggingId: string | null;
  /** Plan 034: hard-delete a vehicle whose road is missing (e.g. sceneIO
   *  load replaced the network while a vehicle still held a stale
   *  roadId). Wired by worldStore.addTickContext(). */
  removeVehicle: (vehicleId: string) => void;
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

  // 3.5. (Plan 037 bug 2) Controller → desiredStatus. We compute the
  //      controller's intent here (separately from `status`) so the
  //      hysteresis in step 11 has a stable target to converge to.
  //      `crashed` is sticky: nothing in the controller overrides it.
  for (const v of Object.values(network.vehicles)) {
    if (v.status === 'crashed') {
      v.desiredStatus = 'crashed';
      continue;
    }
    // Controller intent = the slower of (road speed limit) and
    // (targetSpeed the constraint layer just set). targetSpeed == 0
    // means a red-light approach or a car-following distance hit,
    // both of which mean the vehicle wants to stop.
    v.desiredStatus = v.targetSpeed < 0.5 ? 'waiting' : 'driving';
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

    // Plan 037c: Pure Pursuit steering — turn toward the lookahead
    // point on the lane. Runs after step 8 (position re-derived) so
    // v.position / heading are fresh. Applies angular velocity to Rapier
    // bodies before the lane-change branch (which handles lateral slide).
    for (const v of Object.values(network.vehicles)) {
      if (v.id === ctx.draggingId) continue;
      const road = network.roads[v.roadId];
      if (!road) continue;
      const delta = computeSteeringAngle(
        v.position.x,
        v.position.z,
        v.heading,
        road,
        v.laneIndex,
        v.s,
        VEHICLE_PURE_PURSUIT[v.type],
      );
      const omega = steeringAngleToOmega(delta);
      ctx.rapierWorld.setVehicleAngularVelocity(v.id, omega);
    }
  } else {
    // M1 fallback: no Rapier → hand-rolled move+s wrap. Plan 037
    // replaces the previous hard-coded accel=3.5 / decel=10 with
    // smoothAccel (per-type dynamics).
    for (const v of Object.values(network.vehicles)) {
      const road = network.roads[v.roadId];
      if (!road) continue;
      v.speed = smoothAccel(v.speed, v.targetSpeed, dt, v.type);
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

  // Plan 029 (M2 lane change): per-vehicle lane-change branch.
  // Runs after both Rapier and hand-rolled paths so position/heading
  // are fresh. For vehicles with desiredLaneIndex set, applies a
  // lateral linvel toward the target lane and clears state when
  // converged (or aborts after a 5s timeout).
  for (const v of Object.values(network.vehicles)) {
    if (v.desiredLaneIndex === null) continue;
    const road = network.roads[v.roadId];
    if (!road) { v.desiredLaneIndex = null; v.laneChangeStartedAt = null; continue; }
    const targetLane = v.desiredLaneIndex;
    const currentLat = perpendicularOffsetAlongRoad(road, v.s, v.position);
    const targetLat = laneOffset(targetLane, road.laneCount);
    const lat = steerLateralVelocity(currentLat, targetLat, STEER_GAIN, MAX_LATERAL_MS);
    ctx.rapierWorld?.setVehicleLateralVelocity(v.id, lat);
    if (Math.abs(targetLat - currentLat) < LANE_CHANGE_CONVERGED_M) {
      // Converged — commit target lane, snap to lane geometry.
      v.laneIndex = targetLane;
      v.desiredLaneIndex = null;
      v.laneChangeStartedAt = null;
      const lp = lanePoint(road, v.laneIndex, v.s);
      v.position = { x: lp.position.x, y: v.position.y, z: lp.position.z };
      v.heading = lp.heading;
      ctx.rapierWorld?.setVehicleSpeed(v.id, v.speed, v.heading);
    } else if (v.laneChangeStartedAt !== null && simTime - v.laneChangeStartedAt > LANE_CHANGE_TIMEOUT_S) {
      // Stuck — abort.
      v.desiredLaneIndex = null;
      v.laneChangeStartedAt = null;
    }
  }

  // 9. (M2-C) LiDAR scan — only when enabled (perf gate). 017 H1 fix:
  //    scan() is actually called from inside tick.ts.
  if (ctx.lidarEnabled && ctx.sensorRegistry && ctx.rapierWorld) {
    ctx.sensorRegistry.scanAll(ctx.rapierWorld, simTime, ctx.getHostPose);
  }

  // 10. (M2-C / Plan 038) Trajectory export — fixed-step rate.
  //     Plan 038: when a FixedStepScheduler is provided, only call
  //     record() on fixed-step boundaries (default 10 Hz). Without
  //     a scheduler, fall back to per-frame (the M2-C default).
  if (ctx.trajectoryExporter) {
    if (ctx.fixedStepScheduler) {
      // Drain any extra steps accumulated by a long wallDt (e.g.
      // browser pause). Each fixed-step boundary writes one
      // trajectory sample.
      let fired = ctx.fixedStepScheduler.advance(dt);
      while (fired) {
        ctx.trajectoryExporter.record(
          network,
          ctx.fixedStepScheduler.getSimTime(),
          TRAJECTORY_SAMPLE_INTERVAL,
        );
        fired = ctx.fixedStepScheduler.advance(0);  // drain remainder
      }
    } else {
      // Back-compat: per-frame record (older tests).
      ctx.trajectoryExporter.record(network, simTime, TRAJECTORY_SAMPLE_INTERVAL);
    }
  }

  // 11. Update status (Plan 037 bug 2 — hysteresis).
  for (const v of Object.values(network.vehicles)) {
    v.status = statusFromHysteresis(v.status, v.desiredStatus, v.speed);
  }

  // 11.5. (Plan 037 bug 3) Release spawn points when the occupying
  //      vehicle has driven past SPAWN_POINT_RELEASE_DISTANCE metres
  //      along its lane. Empty spawnPoints map → no-op (back-compat).
  if (Object.keys(network.spawnPoints).length > 0) {
    for (const sp of Object.values(network.spawnPoints)) {
      if (sp.occupiedBy === null) continue;
      const v = network.vehicles[sp.occupiedBy];
      if (!v || v.roadId !== sp.roadId || v.laneIndex !== sp.laneIndex) {
        // Vehicle no longer matches the spawn point — release.
        sp.occupiedBy = null;
        continue;
      }
      const ds = v.s - sp.s;
      // Wrap-safe distance: the road is a polyline / loop. Treat the
      // spawn point as released when the vehicle has moved
      // SPAWN_POINT_RELEASE_DISTANCE forward along the lane (s
      // increasing).
      if (ds > SPAWN_POINT_RELEASE_DISTANCE || ds < -SPAWN_POINT_RELEASE_DISTANCE) {
        sp.occupiedBy = null;
      }
    }
  }

  // 12. (Plan 034) OOB cleanup. Vehicles that have drifted > 50m from
  //     their (road, lane, s) geometry are respawned at s=0. Vehicles
  //     whose road is missing (e.g. after a scene load) are hard-deleted.
  //     See ADR-008 for the design.
  tickOobCleanup(
    {
      getRoad: (id) => network.roads[id],
      removeVehicle: (id) => ctx.removeVehicle(id),
      snapVehicle: (id, pos, heading) => {
        ctx.rapierWorld?.setVehiclePosition(id, pos);
        ctx.rapierWorld?.setVehicleSpeed(id, 0, heading);
      },
    },
    Object.values(network.vehicles),
    simTime,
  );
};

// ===== Plan 029 (M2 lane change) — control constants =====
/** P-controller gain for lateral linvel (1/s). 2.0 means a 1m gap
 *  gets 2 m/s of lateral velocity. */
const STEER_GAIN = 2.0;
/** Cap on lateral linvel (m/s). 4 m/s ≈ 14 km/h sideways. */
const MAX_LATERAL_MS = 4.0;
/** Stuck-lane-change abort timeout (seconds). */
const LANE_CHANGE_TIMEOUT_S = 5.0;

/** M1.5 — stamp simTime on entering intersection. */
const updateIntersectionEntry = (network: RoadNetwork, simTime: number): void => {
  for (const v of Object.values(network.vehicles)) {
    const road = network.roads[v.roadId];
    if (!road) continue;
    // Plan 035: pick the per-intersection radius when the vehicle's
    // road is connected to one (T / corner intersections may have
    // different radii than the 4-way default). Falls back to the
    // STOP_LINE_DISTANCE*2 default if no connected intersection matches.
    const inter = Object.values(network.intersections).find((i) => i.connectedRoads.includes(road.id));
    const radius = inter?.intersectionRadius ?? STOP_LINE_DISTANCE * 2;
    if (inIntersectionBox(road, v.s, radius)) {
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
  for (const inter of Object.values(network.intersections)) {
    if (!inter.connectedRoads.includes(road.id)) continue;
    // Plan 035: stop-line distance follows the per-intersection radius
    // (T路口 6, corner 4) instead of the fixed STOP_LINE_DISTANCE=5.
    // This keeps the brake-trigger window consistent with the visual
    // stop line drawn by createRoadMarkings.
    const stopLineS = len / 2 - inter.intersectionRadius;
    if (v.s >= stopLineS) return;
    const distToStopLine = stopLineS - v.s;
    if (distToStopLine <= 0) return;
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
  // Plan 037 bug 1.3: simplified Gipps — adds a relative-velocity
  // braking component to the safe gap so the follower preempts the
  // leader's deceleration. Without it, Newell's `speed*TIME_HEADWAY +
  // MIN_GAP` under-protects when the leader is braking hard.
  const safeGap = safeGapGipps(v.speed, leader.speed, gap, TIME_HEADWAY, MIN_GAP);
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
    // Plan 037 bug 2.3: respect impulse threshold. Taps below the
    // threshold (e.g. cars nudging in stop-and-go) leave both
    // vehicles `driving`. Currently Rapier reports impulse=0 on
    // every contact, so the threshold defaults to 0 and every
    // contact still triggers `crashed` (back-compat with 009).
    if (e.impulse < CRASH_IMPULSE_THRESHOLD) continue;
    va.status = 'crashed';
    vb.status = 'crashed';
  }
};

// DEFAULT_CONTROLLER_KIND re-exported so existing callers can still import
// from this module without touching the shared constants path.
export { DEFAULT_CONTROLLER_KIND };
