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

import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import type { Vehicle } from '@domain/entities/Vehicle'
import type { Road } from '@domain/entities/Road'
import type { Intersection } from '@domain/entities/Intersection'
import type { TrafficLight } from '@domain/entities/TrafficLight'
import { LightPhase } from '@domain/value-objects/Phase'
import {
  inIntersectionBox,
  lanePoint,
  laneOffset,
  roadLength,
  laneForwardSign,
} from '@domain/services/laneGeometry'
import {
  steerLateralVelocity,
  LANE_CHANGE_CONVERGED_M,
  perpendicularOffsetAlongRoad,
} from '@domain/services/laneChange'
import { smoothAccel, statusFromHysteresis, safeGapGipps } from '@domain/services/vehicleDynamics'
import { computeSteeringAngle, steeringAngleToOmega } from '@domain/services/purePursuit'
import { pythonSpeedStep } from '@domain/services/egoKernel'
import { tickOobCleanup } from './oobCleanup'
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
  PYTHON_SIM_SPEED_LIMIT,
  LATERAL_DRIFT_THRESHOLD_M,
} from '@shared/constants/simulation'
import type { RapierWorld, ContactEvent, Vec3 } from '@infrastructure/physics'
import { findNearestLane } from './laneFrameSync'
import { FixedStepScheduler } from './fixedStepScheduler'
import {
  createSignalController,
  type SignalController,
  type ControllerKind,
} from './signalController'
import type { TrajectoryExporter } from '@infrastructure/export'
import type { SensorRegistry } from './sensors/SensorRegistry'
import { mlpForwardMean } from '@infrastructure/rl/mlpInference'
import type { PolicyAction, PolicyWeights } from '@infrastructure/rl/types'

/** Signal-controller cache + active kind. Built once by worldStore,
 *  passed by reference each tick. tick() never mutates this object —
 *  it only calls `controller.decide(...)` and reads `controllerKind`. */
export interface SignalContext {
  controllers: Map<string, SignalController>
  controllerKind: ControllerKind
  /** Plan 028: read by tick when lazily creating a new
   *  CoordinatedController (M2-B green-wave). */
  getCoordinatedOffsets: () => ReadonlyMap<string, number>
  isCoordinatedEnabled: () => boolean
}

export interface TickContext {
  rapierWorld: RapierWorld | null
  signal: SignalContext | null
  trajectoryExporter: TrajectoryExporter | null
  sensorRegistry: SensorRegistry | null
  lidarEnabled: boolean
  /** Lookup host vehicle's live pose (used by sensor scan). */
  getHostPose: (vehicleId: string) => { position: Vec3; heading: number } | null
  /** Plan 038: optional fixed-step scheduler. When non-null, the
   *  trajectory exporter is only invoked on fixed-step boundaries
   *  (10 Hz by default), regardless of how fast the render loop
   *  fires. When null, the exporter runs per-frame (back-compat
   *  for tests and the legacy M2-C path). */
  fixedStepScheduler: FixedStepScheduler | null
  /** Vehicle currently being dragged on the 3D canvas (M1.5, plan 023).
   *  When non-null, tick() skips Rapier applyControl + position re-derivation
   *  for this vehicle so the drag handler can move it freely. */
  draggingId: string | null
  /** Plan 034: hard-delete a vehicle whose road is missing (e.g. sceneIO
   *  load replaced the network while a vehicle still held a stale
   *  roadId). Wired by worldStore.addTickContext(). */
  removeVehicle: (vehicleId: string) => void
  /** Plan 049: optional loaded RL policy (SB3 PPO MlpPolicy weights).
   *  When non-null AND `replayTargetId` is set, tick() drives the
   *  target vehicle's `targetSpeed` from a PPO inference each step.
   *  When null, replay is disabled regardless of `replayTargetId`. */
  policy: PolicyWeights | null
  /** Plan 049: id of the vehicle currently being controlled by the
   *  loaded policy. When null, no replay this tick. While the replay
   *  path is driving this vehicle (a policy is loaded or an action is
   *  injected), the constraint layers (light / car-follow / cross-road
   *  yield) skip it — PPO learned to handle them via its obs. */
  replayTargetId: string | null
  /**
   * Plan 071: a fixed action applied to the replay target this tick,
   * overriding the policy's output. Lets the contract harness drive the
   * product replay path deterministically, with no trained checkpoint.
   */
  replayAction?: readonly [number, number]
}

/**
 * Plan 071: is the replay path actually driving this vehicle this tick?
 *
 * `replayTargetId` alone only *nominates* a vehicle. That vehicle's speed
 * is owned by the policy (or by an injected fixed action) only when one of
 * those exists. With neither, the nominated vehicle must behave like an
 * ordinary one — subject to the traffic-light, car-following and
 * cross-road-yield rules — instead of being exempt from them while keeping
 * a stale speed.
 *
 * Every replay-target exemption goes through this one predicate, so the
 * "policy owns the speed" rule and the "policy owns the constraints" rule
 * cannot drift apart.
 */
const isReplayDriven = (ctx: TickContext, v: Vehicle): boolean =>
  ctx.replayTargetId !== null &&
  (ctx.policy !== null || ctx.replayAction !== undefined) &&
  v.id === ctx.replayTargetId

const GREEN_LIKE = new Set<LightPhase>([LightPhase.Green, LightPhase.GreenLeft])
const YELLOW_LIKE = new Set<LightPhase>([LightPhase.Yellow, LightPhase.YellowLeft])
/**
 * "This axis currently has the right of way" — green, or the clearance-yellow
 * that follows it. Used by the RL replay observation (Plan 069) to mirror
 * Python's `ns_green` / `ew_green` semantics, where exactly one axis is
 * always permitted.
 */
const MAY_GO = new Set<LightPhase>([...GREEN_LIKE, ...YELLOW_LIKE])

/**
 * Intersection-level safety: when per-light controllers produce
 * conflicting active phases (two different axes both showing green or
 * yellow), force the later light to red. Traffic law (GB 14886) requires
 * that perpendicular approaches never display green simultaneously —
 * there must always be an all-red clearance between opposing greens.
 */
const resolveSignalConflicts = (inter: Intersection): void => {
  const lights = inter.trafficLights
  for (let i = 0; i < lights.length; i++) {
    const a = lights[i]!
    if (!GREEN_LIKE.has(a.phase) && !YELLOW_LIKE.has(a.phase)) continue
    for (let j = i + 1; j < lights.length; j++) {
      const b = lights[j]!
      if (a.axis === b.axis) continue
      const bActive = GREEN_LIKE.has(b.phase) || YELLOW_LIKE.has(b.phase)
      if (!bActive) continue
      // Conflict: both axes show green/yellow. Force the one with more
      // remaining time to red (the other keeps its phase). When tied,
      // force the second light.
      const target = a.phaseRemaining >= b.phaseRemaining ? a : b
      target.phase = LightPhase.Red
      target.phaseRemaining = 3
    }
  }
}

export const tick = (network: RoadNetwork, dt: number, simTime: number, ctx: TickContext): void => {
  // 1. Advance traffic-light phases via per-light SignalController
  //    (M2-B, plan 010). Replaces M1's hard-coded 30/3/30 loop.
  if (ctx.signal) {
    for (const inter of Object.values(network.intersections)) {
      for (const light of inter.trafficLights) {
        light.phaseRemaining -= dt
        let controller = ctx.signal.controllers.get(light.id)
        if (!controller) {
          // Lazy create (covers lights added after reset/hydrate).
          controller = createSignalController(ctx.signal.controllerKind, {
            getCoordinatedOffsets: ctx.signal.getCoordinatedOffsets,
            isCoordinatedEnabled: ctx.signal.isCoordinatedEnabled,
          })
          ctx.signal.controllers.set(light.id, controller)
        }
        const decision = controller.decide(light, network, simTime)
        light.phase = decision.phase
        light.phaseRemaining = decision.duration
      }
      // Safety: per-light controllers can drift (e.g. ActuatedController
      // red-shortening) and produce conflicting greens across axes.
      // Force conflicting lights to red — traffic law requires that
      // perpendicular approaches never show green simultaneously.
      resolveSignalConflicts(inter)
    }
  } else {
    // M1 fallback: no Rapier → no controllers yet, keep hand-rolled cycle.
    for (const inter of Object.values(network.intersections)) {
      for (const light of inter.trafficLights) {
        light.phaseRemaining -= dt
        if (light.phaseRemaining <= 0) {
          if (light.phase === LightPhase.Green) {
            light.phase = LightPhase.Yellow
            light.phaseRemaining = 3
          } else if (light.phase === LightPhase.Yellow) {
            light.phase = LightPhase.Red
            light.phaseRemaining = light.cycleSeconds - 33
          } else {
            light.phase = LightPhase.Green
            light.phaseRemaining = 30
          }
        }
      }
      resolveSignalConflicts(inter)
    }
  }

  // 2. Stamp each vehicle's intersection-entry time (M1.5 — keep).
  updateIntersectionEntry(network, simTime)

  // 2.5. (Plan 049) RL replay override. When a policy + replay target
  //      are set, build a 14-dim obs matching Python's `SimCore._obs()`,
  //      run the in-browser MlpPolicy forward pass, and write the
  //      resulting accel straight into the target's `targetSpeed`. The
  //      constraint layer below skips the target (it would otherwise
  //      veto PPO's accel at red lights / follower distances — PPO
  //      learned to handle these via the obs's [6:8] light bits and
  //      [8:13] NPC-distance bits).
  if (ctx.replayTargetId) {
    const replayV = network.vehicles[ctx.replayTargetId]
    if (replayV && isReplayDriven(ctx, replayV)) {
      const obs = buildReplayObs(replayV, network)
      // Plan 071: an injected fixed action overrides the policy, so the
      // replay path can be measured without a checkpoint.
      const action: PolicyAction = ctx.replayAction
        ? [ctx.replayAction[0], ctx.replayAction[1]]
        : mlpForwardMean(obs, ctx.policy as PolicyWeights)
      // Python: clip(action[0], -1, 1) * 3.0, then speed + accel * dt.
      // The kernel carries the clip — the policy's output layer has no
      // tanh, so raw actions can leave [-1, 1].
      replayV.targetSpeed = pythonSpeedStep(replayV.speed, action[0], dt)
      // Surface to the AI Playground UI on next refresh.
      if (typeof window !== 'undefined') {
        const w = window as unknown as {
          __replayLast?: { obs: number[]; action: PolicyAction; step: number }
        }
        w.__replayLast = { obs, action, step: simTime }
      }
    }
  }

  // 3. Compute each vehicle's target speed (light + leader).
  for (const v of Object.values(network.vehicles)) {
    const road = network.roads[v.roadId]
    if (!road) continue
    // Plan 071: the replay target's speed is owned by the policy (or by
    // an injected action) and was written in step 2.5. Overwriting it
    // here discarded the policy's output entirely — the replay vehicle
    // drove at the road speed limit.
    if (isReplayDriven(ctx, v)) continue
    v.targetSpeed = road.speedLimit
    applyTrafficLightConstraint(v, road, network, ctx)
    applyCarFollowingConstraint(v, road, network, ctx)
    // Vehicles clamped at the road end (step 8 set speed=0) must stay
    // stopped until a constraint release (light change, leader move).
    // Guard runs AFTER constraints so they can't override it.
    const len = roadLength(road)
    if (v.speed < 0.1 && (v.s >= len - 0.01 || v.s <= 0.01)) {
      v.targetSpeed = 0
    }
  }

  // 3.5. (Plan 037 bug 2) Controller → desiredStatus. We compute the
  //      controller's intent here (separately from `status`) so the
  //      hysteresis in step 11 has a stable target to converge to.
  //      `crashed` is sticky: nothing in the controller overrides it.
  for (const v of Object.values(network.vehicles)) {
    if (v.status === 'crashed') {
      v.desiredStatus = 'crashed'
      continue
    }
    // Controller intent = the slower of (road speed limit) and
    // (targetSpeed the constraint layer just set). targetSpeed == 0
    // means a red-light approach or a car-following distance hit,
    // both of which mean the vehicle wants to stop.
    v.desiredStatus = v.targetSpeed < 0.5 ? 'waiting' : 'driving'
  }

  // 4. Cross-road yield (先到先行) — M1.5 right-of-way priority.
  applyCrossRoadYield(network, ctx)

  // 5-6. Hand each vehicle's control to Rapier + step.
  if (ctx.rapierWorld) {
    for (const v of Object.values(network.vehicles)) {
      // Skip the dragged vehicle — its position is driven by the
      // editor's drag handler, not by Rapier.
      if (v.id === ctx.draggingId) continue
      const road = network.roads[v.roadId]
      if (!road) continue
      const heading = v.heading
      ctx.rapierWorld.applyControl(
        v.id,
        { throttle: 1, brake: v.status === 'crashed' ? 1 : 0, steering: 0 },
        v.targetSpeed,
        heading,
      )
    }
    const result = ctx.rapierWorld.step(dt)

    // 7. Classify contact events → crash status.
    classifyContacts(network, result.contactEvents)

    // 8. Re-derive Vehicle.position / heading from Rapier pose.
    //    Skip the dragged vehicle.
    for (const v of Object.values(network.vehicles)) {
      if (v.id === ctx.draggingId) continue
      const pose = ctx.rapierWorld.readPose(v.id)
      if (!pose) continue
      v.position.x = pose.position.x
      v.position.y = pose.position.y
      v.position.z = pose.position.z
      v.heading = pose.heading
      v.speed = pose.speed
      const nearest = findNearestLane(v, network)
      v.laneIndex = nearest.laneIndex
      v.s = nearest.s
      // Guard: when findNearestLane couldn't project (vehicle went past
      // road end and perpendicular distance exceeded the 5m limit), s
      // stays stale — possibly >= roadLength or <= 0. Clamp and snap the
      // Rapier body so rendering and physics stay in sync.
      const vRoad = network.roads[v.roadId]
      if (vRoad) {
        const len = roadLength(vRoad)
        // Also check if vehicle position is past the road endpoints.
        // findNearestLane returns fallback s when vehicle is off-road,
        // so s might be at the boundary (s=len or s=0) even though the
        // vehicle has driven past the end.
        const expectedAtS = lanePoint(vRoad, v.laneIndex, v.s)
        const dxEnd = v.position.x - expectedAtS.position.x
        const dzEnd = v.position.z - expectedAtS.position.z
        const distFromExpectedSq = dxEnd * dxEnd + dzEnd * dzEnd
        if (v.s >= len || v.s <= 0 || distFromExpectedSq > 25) {
          // 5m threshold
          const clampedS = Math.max(0, Math.min(len, v.s))
          v.s = clampedS
          const lp = lanePoint(vRoad, v.laneIndex, v.s)
          v.position.x = lp.position.x
          v.position.y = lp.position.y
          v.position.z = lp.position.z
          v.heading = lp.heading
          v.speed = 0
          ctx.rapierWorld!.setVehiclePosition(v.id, v.position)
          ctx.rapierWorld!.setVehicleHeading(v.id, lp.heading)
          ctx.rapierWorld!.setVehicleSpeed(v.id, 0, lp.heading) // zero Rapier linvel
        }
      }
      // Guard 2: lateral drift. Pure Pursuit can diverge when the
      // vehicle is far from its lane — the steering rotates heading
      // toward the lookahead, but applyControl then drives the vehicle
      // in the rotated heading direction (perpendicular to the road),
      // making the divergence worse. Snap back when XZ distance from
      // expected lane position exceeds the threshold.
      if (vRoad) {
        const expected = lanePoint(vRoad, v.laneIndex, v.s)
        const dx = v.position.x - expected.position.x
        const dz = v.position.z - expected.position.z
        if (dx * dx + dz * dz > LATERAL_DRIFT_THRESHOLD_M * LATERAL_DRIFT_THRESHOLD_M) {
          v.position.x = expected.position.x
          v.position.y = expected.position.y
          v.position.z = expected.position.z
          v.heading = expected.heading
          v.speed = Math.min(v.speed, 5)
          ctx.rapierWorld!.setVehiclePosition(v.id, v.position)
          ctx.rapierWorld!.setVehicleHeading(v.id, expected.heading)
          ctx.rapierWorld!.setVehicleSpeed(v.id, v.speed, expected.heading)
        }
      }
    }

    // Plan 037c: Pure Pursuit steering — turn toward the lookahead
    // point on the lane. Runs after step 8 (position re-derived) so
    // v.position / heading are fresh. Applies angular velocity to Rapier
    // bodies before the lane-change branch (which handles lateral slide).
    for (const v of Object.values(network.vehicles)) {
      if (v.id === ctx.draggingId) continue
      const road = network.roads[v.roadId]
      if (!road) continue
      // Skip steering when the vehicle is stopped — Pure Pursuit
      // computes a non-zero angle whenever the heading differs from
      // the lookahead direction, and setting angular velocity on a
      // stationary body rotates it in place (the body doesn't move
      // but the heading changes, so when the vehicle resumes it
      // drives in the wrong direction).
      if (v.speed < 0.5) continue
      const delta = computeSteeringAngle(
        v.position.x,
        v.position.z,
        v.heading,
        road,
        v.laneIndex,
        v.s,
        VEHICLE_PURE_PURSUIT[v.type],
      )
      const omega = steeringAngleToOmega(delta)
      ctx.rapierWorld.setVehicleAngularVelocity(v.id, omega)
    }
  } else {
    // M1 fallback: no Rapier → hand-rolled move+s wrap. Plan 037
    // replaces the previous hard-coded accel=3.5 / decel=10 with
    // smoothAccel (per-type dynamics).
    for (const v of Object.values(network.vehicles)) {
      const road = network.roads[v.roadId]
      if (!road) continue
      // Plan 071: the replay target already carries the Python-exact next
      // speed (step 2.5). Ramping it through smoothAccel would cap the
      // acceleration at VEHICLE_DYN[type].accel (2.0 m/s²) instead of
      // Python's 3.0 — cross-language difference #7.
      if (isReplayDriven(ctx, v)) {
        v.speed = v.targetSpeed
      } else {
        v.speed = smoothAccel(v.speed, v.targetSpeed, dt, v.type)
      }
      v.speed = Math.max(0, Math.min(MAX_SPEED, v.speed))
      const sign = laneForwardSign(v.laneIndex, road.laneCount)
      v.s += v.speed * sign * dt
      const len = roadLength(road)
      if (v.s > len) v.s -= len
      if (v.s < 0) v.s += len
      const lp = lanePoint(road, v.laneIndex, v.s)
      v.position.x = lp.position.x
      v.position.y = lp.position.y
      v.position.z = lp.position.z
      v.heading = lp.heading
    }
  }

  // Plan 029 (M2 lane change): per-vehicle lane-change branch.
  // Runs after both Rapier and hand-rolled paths so position/heading
  // are fresh. For vehicles with desiredLaneIndex set, applies a
  // lateral linvel toward the target lane and clears state when
  // converged (or aborts after a 5s timeout).
  for (const v of Object.values(network.vehicles)) {
    if (v.desiredLaneIndex === null) continue
    const road = network.roads[v.roadId]
    if (!road) {
      v.desiredLaneIndex = null
      v.laneChangeStartedAt = null
      continue
    }
    const targetLane = v.desiredLaneIndex
    const currentLat = perpendicularOffsetAlongRoad(road, v.s, v.position)
    const targetLat = laneOffset(targetLane, road.laneCount)
    const lat = steerLateralVelocity(currentLat, targetLat, STEER_GAIN, MAX_LATERAL_MS)
    ctx.rapierWorld?.setVehicleLateralVelocity(v.id, lat)
    if (Math.abs(targetLat - currentLat) < LANE_CHANGE_CONVERGED_M) {
      // Converged — commit target lane, snap to lane geometry.
      v.laneIndex = targetLane
      v.desiredLaneIndex = null
      v.laneChangeStartedAt = null
      const lp = lanePoint(road, v.laneIndex, v.s)
      v.position = { x: lp.position.x, y: lp.position.y, z: lp.position.z }
      v.heading = lp.heading
      ctx.rapierWorld?.setVehicleSpeed(v.id, v.speed, v.heading)
    } else if (
      v.laneChangeStartedAt !== null &&
      simTime - v.laneChangeStartedAt > LANE_CHANGE_TIMEOUT_S
    ) {
      // Stuck — abort.
      v.desiredLaneIndex = null
      v.laneChangeStartedAt = null
    }
  }

  // 9. (M2-C) LiDAR scan — only when enabled (perf gate). 017 H1 fix:
  //    scan() is actually called from inside tick.ts.
  if (ctx.lidarEnabled && ctx.sensorRegistry && ctx.rapierWorld) {
    ctx.sensorRegistry.scanAll(ctx.rapierWorld, simTime, ctx.getHostPose)
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
      let fired = ctx.fixedStepScheduler.advance(dt)
      while (fired) {
        ctx.trajectoryExporter.record(
          network,
          ctx.fixedStepScheduler.getSimTime(),
          TRAJECTORY_SAMPLE_INTERVAL,
        )
        fired = ctx.fixedStepScheduler.advance(0) // drain remainder
      }
    } else {
      // Back-compat: per-frame record (older tests).
      ctx.trajectoryExporter.record(network, simTime, TRAJECTORY_SAMPLE_INTERVAL)
    }
  }

  // 11. Update status (Plan 037 bug 2 — hysteresis).
  for (const v of Object.values(network.vehicles)) {
    v.status = statusFromHysteresis(v.status, v.desiredStatus, v.speed)
  }

  // 11.5. (Plan 037 bug 3) Release spawn points when the occupying
  //      vehicle has driven past SPAWN_POINT_RELEASE_DISTANCE metres
  //      along its lane. Empty spawnPoints map → no-op (back-compat).
  if (Object.keys(network.spawnPoints).length > 0) {
    for (const sp of Object.values(network.spawnPoints)) {
      if (sp.occupiedBy === null) continue
      const v = network.vehicles[sp.occupiedBy]
      if (!v || v.roadId !== sp.roadId || v.laneIndex !== sp.laneIndex) {
        // Vehicle no longer matches the spawn point — release.
        sp.occupiedBy = null
        continue
      }
      const ds = v.s - sp.s
      // Wrap-safe distance: the road is a polyline / loop. Treat the
      // spawn point as released when the vehicle has moved
      // SPAWN_POINT_RELEASE_DISTANCE forward along the lane (s
      // increasing).
      if (ds > SPAWN_POINT_RELEASE_DISTANCE || ds < -SPAWN_POINT_RELEASE_DISTANCE) {
        sp.occupiedBy = null
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
        ctx.rapierWorld?.setVehiclePosition(id, pos)
        ctx.rapierWorld?.setVehicleHeading(id, heading)
        ctx.rapierWorld?.setVehicleSpeed(id, 0, heading)
      },
    },
    Object.values(network.vehicles),
    simTime,
  )
}

// ===== Plan 029 (M2 lane change) — control constants =====
/** P-controller gain for lateral linvel (1/s). 2.0 means a 1m gap
 *  gets 2 m/s of lateral velocity. */
const STEER_GAIN = 2.0
/** Cap on lateral linvel (m/s). 4 m/s ≈ 14 km/h sideways. */
const MAX_LATERAL_MS = 4.0
/** Stuck-lane-change abort timeout (seconds). */
const LANE_CHANGE_TIMEOUT_S = 5.0

/** M1.5 — stamp simTime on entering intersection. */
const updateIntersectionEntry = (network: RoadNetwork, simTime: number): void => {
  for (const v of Object.values(network.vehicles)) {
    const road = network.roads[v.roadId]
    if (!road) continue
    // Plan 035: pick the per-intersection radius when the vehicle's
    // road is connected to one (T / corner intersections may have
    // different radii than the 4-way default). Falls back to the
    // STOP_LINE_DISTANCE*2 default if no connected intersection matches.
    const inter = Object.values(network.intersections).find((i) =>
      i.connectedRoads.includes(road.id),
    )
    const radius = inter?.intersectionRadius ?? STOP_LINE_DISTANCE * 2
    if (inIntersectionBox(road, v.s, radius)) {
      if (v.enteredIntersectionAt === null) {
        v.enteredIntersectionAt = simTime
      }
    } else {
      v.enteredIntersectionAt = null
    }
  }
}

/** M1 复制 — 红灯/黄灯 prepare-to-stop 逻辑 (M2-B 仍要用). */
const applyTrafficLightConstraint = (
  v: Vehicle,
  road: Road,
  network: RoadNetwork,
  ctx: TickContext,
) => {
  // Plan 049: replay target handles lights itself via obs.
  if (isReplayDriven(ctx, v)) return
  const len = roadLength(road)
  for (const inter of Object.values(network.intersections)) {
    if (!inter.connectedRoads.includes(road.id)) continue
    // Plan 035: stop-line distance follows the per-intersection radius
    // (T路口 6, corner 4) instead of the fixed STOP_LINE_DISTANCE=5.
    // This keeps the brake-trigger window consistent with the visual
    // stop line drawn by createRoadMarkings.
    const stopLineS = len / 2 - inter.intersectionRadius
    if (v.s >= stopLineS) return
    const distToStopLine = stopLineS - v.s
    if (distToStopLine <= 0) return
    for (const light of inter.trafficLights) {
      const roadIsNS =
        Math.abs(road.endNode.z - road.startNode.z) > Math.abs(road.endNode.x - road.startNode.x)
      const lightAxisMatches =
        (roadIsNS && light.axis === 'ns') || (!roadIsNS && light.axis === 'ew')
      if (!lightAxisMatches) continue
      // M2-B (plan 016 H3): exhaustive phase set.
      // Red-family phases (Red / RedLeft / AllRed / FlashingRed) = full stop.
      // Yellow-family (Yellow / YellowLeft) = prepare to stop.
      // FlashingYellow = slow down (not stop). FlashingRed = stop (4-way).
      // Dark / Green-family = no constraint here.
      if (
        light.phase === LightPhase.Red ||
        light.phase === LightPhase.Yellow ||
        light.phase === LightPhase.RedLeft ||
        light.phase === LightPhase.YellowLeft ||
        light.phase === LightPhase.AllRed ||
        light.phase === LightPhase.FlashingRed
      ) {
        const braking = (v.speed * v.speed) / 20 + STOP_LINE_BUFFER
        if (distToStopLine <= braking) {
          v.targetSpeed = 0
          return
        }
      } else if (light.phase === LightPhase.FlashingYellow) {
        // Slow approach: targetSpeed halved against the speed limit.
        v.targetSpeed = Math.min(v.targetSpeed, road.speedLimit * 0.5)
      }
      return
    }
  }
}

/** M1 复制 — Newell car-following. */
const applyCarFollowingConstraint = (
  v: Vehicle,
  road: Road,
  network: RoadNetwork,
  ctx: TickContext,
) => {
  // Plan 049: replay target handles follower distance via obs.
  if (isReplayDriven(ctx, v)) return
  const sign = laneForwardSign(v.laneIndex, road.laneCount)
  let bestGap = Infinity
  let leader: Vehicle | null = null
  for (const other of Object.values(network.vehicles)) {
    if (other.id === v.id) continue
    if (other.roadId !== road.id) continue
    if (other.laneIndex !== v.laneIndex) continue
    const ds = sign === 1 ? other.s - v.s : v.s - other.s
    if (ds <= 0) continue
    if (ds > 80) continue
    if (ds < bestGap) {
      bestGap = ds
      leader = other
    }
  }
  if (!leader) return
  const gap = Math.max(0, bestGap - 4)
  // Plan 037 bug 1.3: simplified Gipps — adds a relative-velocity
  // braking component to the safe gap so the follower preempts the
  // leader's deceleration. Without it, Newell's `speed*TIME_HEADWAY +
  // MIN_GAP` under-protects when the leader is braking hard.
  const safeGap = safeGapGipps(v.speed, leader.speed, gap, TIME_HEADWAY, MIN_GAP)
  if (gap >= safeGap) return
  v.targetSpeed = leader.speed
}

const applyCrossRoadYield = (network: RoadNetwork, ctx: TickContext): void => {
  const cars = Object.values(network.vehicles)
  for (let i = 0; i < cars.length; i++) {
    const a = cars[i]!
    const roadA = network.roads[a.roadId]
    if (!roadA) continue
    for (let j = i + 1; j < cars.length; j++) {
      const b = cars[j]!
      const roadB = network.roads[b.roadId]
      if (!roadB) continue
      if (a.roadId === b.roadId) continue
      // The later arrival yields. Plan 071: the replay target's speed is
      // owned by the policy (or by an injected action) — the yield rule
      // must not discard it, or the policy's output dies one step after
      // it was written.
      let yielded: Vehicle | null = null
      if (a.enteredIntersectionAt !== null && b.enteredIntersectionAt === null) {
        yielded = b
      } else if (b.enteredIntersectionAt !== null && a.enteredIntersectionAt === null) {
        yielded = a
      } else if (a.enteredIntersectionAt !== null && b.enteredIntersectionAt !== null) {
        if (a.enteredIntersectionAt < b.enteredIntersectionAt) {
          yielded = b
        } else if (b.enteredIntersectionAt < a.enteredIntersectionAt) {
          yielded = a
        }
      }
      if (yielded && !isReplayDriven(ctx, yielded)) yielded.targetSpeed = 0
    }
  }
}

const classifyContacts = (network: RoadNetwork, events: ReadonlyArray<ContactEvent>): void => {
  for (const e of events) {
    const va = network.vehicles[e.colliderA]
    const vb = network.vehicles[e.colliderB]
    if (!va || !vb) continue
    // Plan 037 bug 2.3: respect impulse threshold. Taps below the
    // threshold (e.g. cars nudging in stop-and-go) leave both
    // vehicles `driving`. Currently Rapier reports impulse=0 on
    // every contact, so the threshold defaults to 0 and every
    // contact still triggers `crashed` (back-compat with 009).
    if (e.impulse < CRASH_IMPULSE_THRESHOLD) continue
    va.status = 'crashed'
    vb.status = 'crashed'
  }
}

// DEFAULT_CONTROLLER_KIND re-exported so existing callers can still import
// from this module without touching the shared constants path.
export { DEFAULT_CONTROLLER_KIND }

// ===== Plan 049: RL replay obs builder =====
//
// Mirror of Python `SimCore._obs()` so the in-browser MlpPolicy sees
// the same 14-dim input it was trained against. Offsets (50m for
// positions, π for heading, 16.67 m/s for speed, 50m for NPC distance)
// MUST stay in sync with the Python sim — PPO is sensitive to scaling
// and will drive erratically if they diverge.
//
// 2026-10-20 audit: the *scaling* matches, but the **light-bit semantics**
// do not — Python's `obs[6:8]` is a raw `ns_green`/`ew_green` boolean that
// stays 1 through a yellow phase, while here a Yellow phase reads 0, and
// the TS sim has a 3s yellow phase that Python's sim does not have at all.
// See `docs/contracts/sim-snapshot.md` → 「实际差异清单」.

const OBS_DIM = 14
const NORMALIZE_DIST = 50.0

/** Build the 14-dim observation vector for the replay target.
 *
 *  Layout (matches Python `SimCore._obs()`):
 *    [0:3] ego pose normalized  (x/50, z/50, heading/π)
 *    [3:6] ego motion           (speed/16.67, 0, 0)
 *    [6:8] traffic light        (NS-green, EW-green)
 *    [8:13] 5 nearest NPC distances / 50, padded with 1.0
 *    [13] ego elevation normalized (y/10, clipped to [-1, 1])
 */
export const buildReplayObs = (ego: Vehicle, network: RoadNetwork): number[] => {
  const obs = new Array<number>(OBS_DIM).fill(0)
  obs[0] = Math.max(-1, Math.min(1, ego.position.x / NORMALIZE_DIST))
  obs[1] = Math.max(-1, Math.min(1, ego.position.z / NORMALIZE_DIST))
  obs[2] = ego.heading / Math.PI
  obs[3] = Math.max(0, Math.min(1, ego.speed / PYTHON_SIM_SPEED_LIMIT))
  obs[4] = 0 // accel placeholder (Python: not used by PPO)
  obs[5] = 0 // steer placeholder (Python: not used by PPO)

  // Traffic light bits — Python parity (Plan 069).
  //
  // Python's `SimCore._obs()` sets:
  //     obs[6] = 1 if ns_green else 0      # the NS axis, ALWAYS
  //     obs[7] = 1 if ew_green else 0      # the EW axis, ALWAYS
  // The two are always complementary, because SimCore swaps `ns_green` and
  // `ew_green` together and has no yellow phase at all.
  //
  // The previous implementation had two defects:
  //   1. It only ever set the bit for the **ego's own axis**, so the other
  //      axis's state was invisible to the policy — obs[7] stayed 0 forever
  //      for an NS ego, while Python would have reported the EW axis there.
  //   2. It used "phase === Green", so during the TS sim's 3s yellow the
  //      pair degraded to (0,0) — a state the policy can never observe in
  //      Python, where exactly one axis is always green.
  //
  // Fix: report each axis independently, and treat "green" as *may go*
  // (green or clearance-yellow) so the pair stays one-hot — the same
  // structure Python's obs[6:8] has. The residual difference is the 3s
  // yellow phase, which Python does not have; see
  // `docs/contracts/sim-snapshot.md` → 「实际差异清单」.
  const egoRoad = network.roads[ego.roadId]
  if (egoRoad) {
    for (const inter of Object.values(network.intersections)) {
      if (!inter.connectedRoads.includes(egoRoad.id)) continue
      // Per axis, prefer the through-lane light (the "main" phase) over a
      // left-turn variant, so a `greenLeft` light cannot mask a red
      // through-lane. Falls back to any light on that axis.
      const byAxis: Record<'ns' | 'ew', { main?: TrafficLight; any?: TrafficLight }> = {
        ns: {},
        ew: {},
      }
      const mayGo: Record<'ns' | 'ew', boolean> = { ns: false, ew: false }
      for (const light of inter.trafficLights) {
        const slot = byAxis[light.axis]
        const isLeft = light.phase.endsWith('Left')
        if (!slot.any) slot.any = light
        if (!isLeft && !slot.main) slot.main = light
      }
      for (const axis of ['ns', 'ew'] as const) {
        const light = byAxis[axis].main ?? byAxis[axis].any
        if (!light) continue
        mayGo[axis] = MAY_GO.has(light.phase)
      }
      // Python's obs[6:8] is ALWAYS exactly one-hot: SimCore keeps a single
      // "which axis has green" boolean and swaps it, so the pair is never
      // (0,0) and never (1,1). The policy was only ever trained on (1,0) and
      // (0,1) — any other pair is out of distribution for it.
      //
      // Mirror that invariant instead of reporting the two axes
      // independently. Ties (both axes may go, or neither) cannot occur in
      // the default cycle but can with a mis-configured scene: NS wins the
      // "both" tie, and "neither" is reported as (0,1), which reads as "NS
      // must stop" — the right action during an all-red clearance.
      obs[6] = mayGo.ns ? 1 : 0
      obs[7] = obs[6] ? 0 : 1
      break // first intersection matching ego's road
    }
  }

  // 5 nearest NPC distances, sorted ascending, padded with 50 (so /50=1.0).
  const distances: number[] = []
  for (const v of Object.values(network.vehicles)) {
    if (v.id === ego.id) continue
    distances.push(Math.hypot(ego.position.x - v.position.x, ego.position.z - v.position.z))
  }
  distances.sort((a, b) => a - b)
  while (distances.length < 5) distances.push(NORMALIZE_DIST)
  for (let i = 0; i < 5; i++) {
    obs[8 + i] = Math.min(1, (distances[i] ?? NORMALIZE_DIST) / NORMALIZE_DIST)
  }
  // Plan 061: keep the replay vector aligned with Python SimCore._obs().
  obs[13] = Math.max(-1, Math.min(1, ego.position.y / 10.0))
  return obs
}
