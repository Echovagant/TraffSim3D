// src/application/services/tick.ts
//
// M2-A: Rapier-driven simulation step. The hand-rolled collision
// logic (M1: applyBoxInAndCollisionAvoidance + applyIntersectionNudge)
// is gone — Rapier handles physics. This file does:
//   1. Advance traffic lights (M1 30/3/30 — M2-B replaces)
//   2. Compute per-vehicle targetSpeed (light + leader).
//   3. Stamp simTime on vehicles entering intersection (for
//      right-of-way tiebreaker; M1.5 behaviour kept).
//   4. Cross-road yield (先到先行) — target-speed heuristic, since
//      Rapier physics doesn't know about domain-level right-of-way.
//   5. Hand each vehicle's (throttle, brake, targetSpeed, heading)
//      to RapierWorld.applyControl.
//   6. Call rapierWorld.step(dt) — physics integration.
//   7. Drain contact events → classify contacts → update Vehicle.status.
//   8. Re-derive Vehicle.position / heading / laneIndex / s from Rapier.
//   9. Update status (driving / waiting / crashed).
//
// The I5 fixed-timestep accumulator lives in useWorldSimulation,
// not here. tick() always receives dt=1/60 (the physics step).

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
} from '@shared/constants/simulation';
import type { RapierWorld, ContactEvent } from '@infrastructure/physics';
import { findNearestLane } from './laneFrameSync';

/** SimTime clock — caller passes the current sim time so
 *  `enteredIntersectionAt` can be stamped. */
export const tick = (
  network: RoadNetwork,
  dt: number,
  simTime: number,
  rapierWorld: RapierWorld | null,
): void => {
  // 1. Advance traffic-light phases (M1 30/3/30 — M2-B replaces).
  //    For M2-A we keep the hard-coded cycle so the perf gate
  //    measures a known quantity.
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

  // 2. Stamp each vehicle's intersection-entry time (M1.5 — keep).
  updateIntersectionEntry(network, simTime);

  // 3. Compute each vehicle's target speed (light + leader only;
  //    cross-road yield is now a Rapier-collision concern).
  for (const v of Object.values(network.vehicles)) {
    const road = network.roads[v.roadId];
    if (!road) continue;
    v.targetSpeed = road.speedLimit;
    applyTrafficLightConstraint(v, road, network);
    applyCarFollowingConstraint(v, road, network);
  }

  // 4. Cross-road yield (先到先行) — M1.5 right-of-way priority
  //    kept as a *target-speed* constraint (not hand-rolled
  //    collision). Rapier physics enforces the actual non-overlap.
  applyCrossRoadYield(network);

  // 5. Hand each vehicle's control to Rapier.
  if (rapierWorld) {
    for (const v of Object.values(network.vehicles)) {
      const road = network.roads[v.roadId];
      if (!road) continue;
      const heading = v.heading;  // world-space
      rapierWorld.applyControl(
        v.id,
        { throttle: 1, brake: v.status === 'crashed' ? 1 : 0, steering: 0 },
        v.targetSpeed,
        heading,
      );
    }

    // 6. Physics step.
    const result = rapierWorld.step(dt);

    // 7. Classify contact events → crash status.
    classifyContacts(network, result.contactEvents);

    // 8. Re-derive Vehicle.position / heading from Rapier pose,
    //    and update laneIndex / s via findNearestLane.
    for (const v of Object.values(network.vehicles)) {
      const pose = rapierWorld.readPose(v.id);
      if (!pose) continue;  // body not registered (skip — should not happen)
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
    // M1 fallback: no Rapier → keep hand-rolled move+s wrap.
    // This branch only fires if Rapier failed to init; the page
    // should still render (no physics, but no crash).
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

  // 9. Update status (driving / waiting / crashed).
  for (const v of Object.values(network.vehicles)) {
    if (v.status !== 'crashed') {
      v.status = v.speed < 0.5 ? 'waiting' : 'driving';
    }
  }
};

/** M1.5 keep — stamp simTime on entering intersection. */
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
      if (light.phase === LightPhase.Red || light.phase === LightPhase.Yellow) {
        const braking = (v.speed * v.speed) / 20 + STOP_LINE_BUFFER;
        if (distToStopLine <= braking) {
          v.targetSpeed = 0;
          return;
        }
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

/** M2-A new — cross-road right-of-way via target speed.
 *  Replaces M1's applyBoxInAndCollisionAvoidance. Box-in on
 *  adjacent lanes is now Rapier's job (cars physically can't
 *  pass); cross-road yield stays as a target-speed heuristic
 *  (the car that should yield pulls targetSpeed to 0). */
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
      if (a.roadId === b.roadId) continue;  // box-in is Rapier's job
      // Cross-road only — if both in intersection, yield to the one
      // that entered first (先到先行).
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
        // tie (impossible) — both keep going, Rapier handles.
      }
    }
  }
};

/** Rapier contact → crash classification. M2-A simple: any
 *  vehicle-vehicle contact → both 'crashed'. M2-B may refine
 *  with impulse threshold. */
const classifyContacts = (network: RoadNetwork, events: ReadonlyArray<ContactEvent>): void => {
  for (const e of events) {
    const va = network.vehicles[e.colliderA];
    const vb = network.vehicles[e.colliderB];
    if (!va || !vb) continue;
    va.status = 'crashed';
    vb.status = 'crashed';
  }
};

