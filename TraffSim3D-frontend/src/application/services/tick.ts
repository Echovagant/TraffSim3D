// src/application/services/tick.ts
//
// Tick signature is `tick(network, dt, simTime, ctx: TickContext)`.
// This supersedes the earlier 6-arg signature. The 5th param is now a
// single `ctx: TickContext` that bundles:
//   - rapierWorld       (physics)
//   - signal            (per-light signal controllers)
//   - trajectoryExporter (per-tick trajectory sample)
//   - sensorRegistry    (per-tick LiDAR scan)
//   - lidarEnabled      (UI toggle)
//   - getHostPose       (sensor host pose lookup)
//
// See the interface contract for the per-tick event ordering.

import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import type { Vehicle } from '@domain/entities/Vehicle'
import type { Road } from '@domain/entities/Road'
import type { Intersection } from '@domain/entities/Intersection'
import type { TrafficLight } from '@domain/entities/TrafficLight'
import { LaneId } from '@domain/value-objects/LaneId'
import { LightPhase } from '@domain/value-objects/Phase'
import {
  inIntersectionBox,
  lanePoint,
  laneOffset,
  roadForward,
  roadLength,
  roadRight,
  laneForwardSign,
  stopLineSOnRoad,
} from '@domain/services/laneGeometry'
import {
  steerLateralVelocity,
  LANE_CHANGE_CONVERGED_M,
  perpendicularOffsetAlongRoad,
} from '@domain/services/laneChange'
import { junctionIndex, type JunctionIndex } from '@domain/services/roadJunctionIndex'
import { roadContinuation, type RoadContinuation } from '@domain/services/roadTransition'
import {
  buildTurnArc,
  pointAt as arcPointAt,
  MIN_ARC_TURN_RAD,
  turnAngle,
} from '@domain/services/roadTurnArc'
import { buildDriveObservation } from './driveObservation'
import { approachAxis } from '@domain/services/approachAxis'
import {
  rampSpeed,
  statusFromHysteresis,
  safeGapGipps,
  safeSpeedGipps,
} from '@domain/services/vehicleDynamics'
import { computeSteeringAngle, steeringAngleToOmega } from '@domain/services/purePursuit'
import { pythonSpeedStep } from '@domain/services/egoKernel'
import { tickOobCleanup, isOobExiting, recordLaneGuard } from './oobCleanup'
import {
  CRASH_IMPULSE_THRESHOLD,
  MAX_SPEED,
  MAX_DECEL,
  MIN_GAP,
  SPAWN_POINT_RELEASE_DISTANCE,
  STOP_LINE_BUFFER,
  TIME_HEADWAY,
  TRAJECTORY_SAMPLE_INTERVAL,
  CONFLICT_ALL_RED_SECS,
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
  type JunctionSignalPlan,
  type SignalController,
  type ControllerKind,
  type SignalActionSource,
} from './signalController'
import type { TrajectoryExporter } from '@infrastructure/export'
import type { SensorRegistry } from './sensors/SensorRegistry'
import { mlpForwardMean } from '@infrastructure/rl/mlpInference'
import type { PolicyAction, PolicyWeights } from '@infrastructure/rl/types'

/** Signal-controller cache + active kind. Built once by worldStore,
 *  passed by reference each tick. tick() never mutates this object —
 *  it only calls `controller.decide(...)` and reads `controllerKind`. */
export interface SignalContext {
  /**
   * The junction controllers, keyed by the **junction's** id.
   *
   * One controller per junction: the junction owns the phase plan and
   * its lights are views of it.
   */
  controllers: Map<string, SignalController>
  controllerKind: ControllerKind
  /** Read by tick when lazily creating a new
   *  CoordinatedController (green-wave). */
  getCoordinatedOffsets: () => ReadonlyMap<string, number>
  isCoordinatedEnabled: () => boolean
  /**
   * Where the RL controller's actions come from.
   *
   * A **getter**, not a value: the signal policy is loaded at runtime, and
   * a controller that was created before the policy arrived would hold a
   * stale (absent) source. The world store clears the controller cache when
   * the policy changes, and this getter keeps the two in step.
   */
  getRlActionSource: () => SignalActionSource | undefined
}

export interface TickContext {
  rapierWorld: RapierWorld | null
  signal: SignalContext | null
  trajectoryExporter: TrajectoryExporter | null
  sensorRegistry: SensorRegistry | null
  lidarEnabled: boolean
  /** Lookup host vehicle's live pose (used by sensor scan). */
  getHostPose: (vehicleId: string) => { position: Vec3; heading: number } | null
  /** Optional fixed-step scheduler. When non-null, the
   *  trajectory exporter is only invoked on fixed-step boundaries
   *  (10 Hz by default), regardless of how fast the render loop
   *  fires. When null, the exporter runs per-frame (back-compat
   *  for tests and the legacy per-frame path). */
  fixedStepScheduler: FixedStepScheduler | null
  /** Vehicle currently being dragged on the 3D canvas.
   *  When non-null, tick() skips Rapier applyControl + position re-derivation
   *  for this vehicle so the drag handler can move it freely. */
  draggingId: string | null
  /** Hard-delete a vehicle whose road is missing (e.g. sceneIO
   *  load replaced the network while a vehicle still held a stale
   *  roadId). Wired by worldStore.addTickContext(). */
  removeVehicle: (vehicleId: string) => void
  /** Optional loaded RL policy (SB3 PPO MlpPolicy weights).
   *  When non-null AND `replayTargetId` is set, tick() drives the
   *  target vehicle's `targetSpeed` from a PPO inference each step.
   *  When null, replay is disabled regardless of `replayTargetId`. */
  policy: PolicyWeights | null
  /** Id of the vehicle currently being controlled by the
   *  loaded policy. When null, no replay this tick. While the replay
   *  path is driving this vehicle (a policy is loaded or an action is
   *  injected), the constraint layers (light / car-follow / cross-road
   *  yield) skip it — PPO learned to handle them via its obs. */
  replayTargetId: string | null
  /**
   * A fixed action applied to the replay target this tick,
   * overriding the policy's output. Lets the contract harness drive the
   * product replay path deterministically, with no trained checkpoint.
   */
  replayAction?: readonly [number, number]
  /**
   * The road a vehicle's planned route says it takes next, or `null`.
   *
   * Only the vehicle that is *following* a route gets an answer; every
   * other vehicle keeps the ordinary hash-based turn rule, which is
   * what the RL environment models (and what the measured browser-side
   * delay baseline was measured with). A route that cannot be followed
   * falls back to that rule too — see `roadContinuation`.
   */
  routeNextRoadId?: (vehicleId: string) => string | null
  /**
   * The cooperative-driving policy over the junction's negotiation
   * (Scene 4), when it is enabled.
   *
   * While this is set, tick builds each listed vehicle's 23-dim
   * observation (`driveObservation.ts` — pinned to Python's
   * `DriveCore._observation` by the observation fixture), runs the
   * forward pass and owns that vehicle's speed — the same ownership
   * the ego replay has. The turns come from each driver's ROUTE
   * (`routeNextRoadId` answers for the driven ids too). Every other
   * vehicle keeps the ordinary rules.
   */
  drivePolicy?: {
    weights: PolicyWeights
    conflictPoint: { x: number; z: number }
    ids: readonly string[]
    routes: Record<string, readonly string[]>
    /** Progress hints, advanced in place as the drivers move. */
    routeIndex: Record<string, number>
  } | null
}

/**
 * Is the replay path actually driving this vehicle this tick?
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

/**
 * Is this vehicle's speed owned by the cooperative-driving policy?
 *
 * A driven vehicle is exempt from the constraint layers for the same
 * reason the replay target is: the policy was trained WITHOUT the
 * browser's yield rule (the training env's junction has no lights and
 * no phase), and a constraint that vetoes the policy's acceleration
 * would make the negotiation the policy learned invisible.
 */
const isDriveDriven = (ctx: TickContext, v: Vehicle): boolean =>
  ctx.drivePolicy?.ids.includes(v.id) ?? false

const GREEN_LIKE = new Set<LightPhase>([LightPhase.Green, LightPhase.GreenLeft])
const YELLOW_LIKE = new Set<LightPhase>([LightPhase.Yellow, LightPhase.YellowLeft])
/**
 * "This axis currently has the right of way" — green, or the clearance-yellow
 * that follows it. Used by the RL replay observation to mirror
 * Python's `ns_green` / `ew_green` semantics, where exactly one axis is
 * always permitted.
 */
const MAY_GO = new Set<LightPhase>([...GREEN_LIKE, ...YELLOW_LIKE])

/**
 * Intersection-level safety: when per-light controllers produce
 * conflicting greens (two different axes both showing green), force the
 * loser into the clearance. Traffic law (GB 14886) requires that
 * perpendicular approaches never display green simultaneously — there must
 * always be an all-red clearance between opposing greens.
 *
 * ## Only green-vs-green is a conflict
 *
 * A **yellow** is the *clearing* of the axis that is ending, so
 * `green + yellow` is a legal transition, not a conflict: the phase
 * machine's own all-red phase provides the clearance there. Treating the
 * yellow as "active" made the resolver add 3 s of clearance to a
 * transition that already had its 6 s planned — which is where the
 * browser's asymmetric 6.02 s / 3.03 s gaps came from.
 *
 * ## The loser goes into the **all-red**, not into a red
 *
 * The forced light is put into the phase machine's `AllRed` phase for
 * `CONFLICT_ALL_RED_SECS`. When that runs out, the machine serves it a
 * **full red** (`RED_PHASE_SECS`) before it may go green again — so the
 * conflict cannot recur on the next tick. Forcing a plain `Red` used to
 * skip that red entirely (the machine's fallback transition went straight
 * back to green), and the junction ping-ponged every 3 s.
 */
const resolveSignalConflicts = (inter: Intersection): void => {
  const lights = inter.trafficLights
  for (let i = 0; i < lights.length; i++) {
    const a = lights[i]!
    if (!GREEN_LIKE.has(a.phase)) continue
    for (let j = i + 1; j < lights.length; j++) {
      const b = lights[j]!
      if (a.axis === b.axis) continue
      if (!GREEN_LIKE.has(b.phase)) continue
      // Conflict: both axes show green. Force the one with more
      // remaining time into the clearance (the other keeps its phase).
      // The comparison is the one the resolver has always used: on a tie
      // the first light of the pair gives way.
      const target = a.phaseRemaining >= b.phaseRemaining ? a : b
      target.phase = LightPhase.AllRed
      target.phaseRemaining = CONFLICT_ALL_RED_SECS
    }
  }
}

/**
 * The controller that drives a junction.
 *
 * The cache is keyed by the **junction's** id: one controller per
 * junction, because the junction owns the phase plan (the lights are
 * views of it).
 *
 * A controller registered under one of the junction's **light** ids is
 * the older per-light contract and still drives the junction — a
 * controller that does not describe the junction's per-axis views
 * decides for the junction as a whole.
 */
const junctionController = (signal: SignalContext, inter: Intersection): SignalController => {
  const cached = signal.controllers.get(inter.id)
  if (cached) return cached
  for (const light of inter.trafficLights) {
    const legacy = signal.controllers.get(light.id)
    if (legacy) return legacy
  }
  // Lazy create (covers junctions added after reset/hydrate).
  const created = createSignalController(signal.controllerKind, {
    getCoordinatedOffsets: signal.getCoordinatedOffsets,
    isCoordinatedEnabled: signal.isCoordinatedEnabled,
    rlActionSource: signal.getRlActionSource(),
  })
  signal.controllers.set(inter.id, created)
  return created
}

/**
 * Write the junction's plan onto its lights.
 *
 * The plan's per-axis views are what the lights show: the served axis
 * shows the junction's phase, the other one shows red with the time
 * until it is served.
 */
const applyJunctionPlan = (inter: Intersection, plan: JunctionSignalPlan): void => {
  const views = plan.views
  for (const light of inter.trafficLights) {
    const view = views?.[light.axis]
    if (view !== undefined) {
      light.phase = view.phase
      light.phaseRemaining = view.remaining
    } else {
      // A controller without per-axis views decides for the junction as
      // a whole (the older per-light contract).
      light.phase = plan.phase
      light.phaseRemaining = plan.duration
    }
  }
}

export const tick = (network: RoadNetwork, dt: number, simTime: number, ctx: TickContext): void => {
  // 1. Advance the junctions' phase plans. One plan per junction — the
  //    lights are views of it, so the two axes cannot drift apart and
  //    the clearance is 6 s by construction.
  if (ctx.signal) {
    for (const inter of Object.values(network.intersections)) {
      const controller = junctionController(ctx.signal, inter)
      const plan = controller.decide(inter, network, simTime, dt)
      applyJunctionPlan(inter, plan)
      // Safety net: traffic law requires that perpendicular approaches
      // never display green simultaneously. The junction's plan cannot
      // produce that, so this only fires for a controller that does not
      // describe the junction's views.
      resolveSignalConflicts(inter)
    }
  } else {
    // Fallback: no Rapier → no controllers yet, keep hand-rolled cycle.
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

  // 2. Stamp each vehicle's intersection-entry time.
  //
  // The junction index is fetched ONCE here and handed to the two rules
  // that need it. Its freshness check is O(junctions), and an imported
  // district has thousands of them — fetching it per lookup would cost
  // millions of property lookups per frame.
  const junctions = junctionIndex(network)
  updateIntersectionEntry(network, simTime, junctions)

  // 2.5. RL replay override. When a policy + replay target
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
      // An injected fixed action overrides the policy, so the
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

  // 2.6. The cooperative-driving policy (Scene 4). Same ownership as
  //      the ego replay above: the policy writes the target speed, and
  //      the constraint layers stand down for the driven vehicles (see
  //      `isDriveDriven`). The turns are NOT the policy's — they come
  //      from each driver's route, like the route planner's follower.
  if (ctx.drivePolicy) {
    for (const id of ctx.drivePolicy.ids) {
      const driven = network.vehicles[id]
      if (!driven || driven.status === 'crashed') continue
      if (isReplayDriven(ctx, driven)) continue
      const route = ctx.drivePolicy.routes[id]
      if (!route || route.length === 0) continue

      // The route progress the observation's idx 4 wants: the
      // length-weighted share of the route that is behind the vehicle.
      // The env computes (done + seg_t) / total; the browser's
      // equivalent is (done + the signed travel distance on the
      // current road) / total.
      let index = route.indexOf(driven.roadId)
      if (index < 0) index = Math.min(ctx.drivePolicy.routeIndex[id] ?? 0, route.length - 1)
      ctx.drivePolicy.routeIndex[id] = index
      let done = 0
      let total = 0
      for (let i = 0; i < route.length; i++) {
        const road = network.roads[route[i]!]
        if (!road) continue
        const length = roadLength(road)
        total += length
        if (i < index) done += length
      }
      const currentRoad = network.roads[driven.roadId]
      let travel = 0
      if (currentRoad) {
        const length = roadLength(currentRoad)
        const sign = laneForwardSign(driven.laneIndex, currentRoad.laneCount)
        travel = sign === 1 ? driven.s : length - driven.s
      }
      const routeProgress = total > 0 ? Math.min(1, Math.max(0, (done + travel) / total)) : 0

      const observation = buildDriveObservation({
        conflictPoint: ctx.drivePolicy.conflictPoint,
        self: {
          x: driven.position.x,
          z: driven.position.z,
          heading: driven.heading,
          speed: driven.speed,
          routeProgress,
        },
        others: Object.values(network.vehicles)
          .filter((other) => other.id !== id)
          .map((other) => ({ x: other.position.x, z: other.position.z, speed: other.speed })),
      })
      const action = mlpForwardMean(observation, ctx.drivePolicy.weights)
      // Python: clip(action[0], -1, 1) * 3.0, then speed + accel * dt —
      // the same kernel the ego replay runs.
      driven.targetSpeed = pythonSpeedStep(driven.speed, action[0], dt)
      if (typeof window !== 'undefined') {
        const w = window as unknown as {
          __driveLast?: { id: string; obs: number[]; action: PolicyAction }
        }
        w.__driveLast = { id, obs: observation, action }
      }
    }
  }

  // 3. Compute each vehicle's target speed (light + leader).
  for (const v of Object.values(network.vehicles)) {
    const road = network.roads[v.roadId]
    if (!road) continue
    // The replay target's speed is owned by the policy (or by
    // an injected action) and was written in step 2.5. Overwriting it
    // here discarded the policy's output entirely — the replay vehicle
    // drove at the road speed limit.
    //
    // The road-end clamp below is therefore deliberately NOT applied to
    // the replay target: re-arming it would hand the constraint layer
    // ownership of a speed the policy is supposed to own. The accepted
    // consequence: a replay vehicle that stalls at a road end reports
    // `desiredStatus: 'driving'` while its speed is 0 (the Rapier branch
    // still zeroes the speed). Cosmetic — the vehicle was already stuck
    // there before this change.
    if (isReplayDriven(ctx, v) || isDriveDriven(ctx, v)) continue
    v.targetSpeed = road.speedLimit
    applyTrafficLightConstraint(v, road, network, ctx)
    applyCarFollowingConstraint(v, road, network, ctx)
    // NOTE: there is deliberately **no** "road end" clamp here any
    // more. The road end used to be terminal: step 8 snapped the
    // body back to the end point and zeroed its speed, and this
    // clamp (which ran AFTER the constraints so they could not
    // release it) pinned the vehicle there for good — every demo
    // scene ran for half a minute and then stood still.
    //
    // The end of a lane is now a **wrap point**: the vehicle re-enters
    // the same lane from the other end of the road and keeps driving
    // (see `wrappedTravelS` / `applyTravelEndWrap`). A vehicle that
    // is stopped at the end therefore has to be held there by a real
    // constraint — a red light or a leader — not by the geometry.
  }

  // 3.5. Controller → desiredStatus. We compute the
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

  // 4. Cross-road yield (先到先行) — right-of-way priority.
  applyCrossRoadYield(network, ctx, junctions)

  // 5-6. Hand each vehicle's control to Rapier + step.
  if (ctx.rapierWorld) {
    // 5a. Longitudinal control.
    //
    // The speed the body carries is the current speed **ramped** toward
    // `v.targetSpeed` under the per-type caps — not the target itself.
    // The old code pinned the throttle at 1 and let `applyControl` set
    // the velocity straight to the target, so every vehicle jumped to
    // the road speed limit on its first tick and slammed to 0 at a red
    // light. The ramp is what makes the acceleration and the braking
    // physical (and what the trajectory exporter's dirty-data filter
    // was mis-reading as an impossible acceleration).
    //
    // WHY THE RAMP USES THE **FRAME** dt, AND WHY THAT IS STILL
    // FRAME-RATE INDEPENDENT:
    //
    // The ramp adds `accel · dt` per call, and it is called once per
    // frame. With N frames per second and dt = 1/N, the speed grows by
    // `accel` per second — **whatever N is**. The physics advances in
    // fixed 1/60 s sub-steps, so it consumes the speed at the rate the
    // ramp produced it: in 1/60 s of simulation the ramp added
    // `accel / 60`, i.e. an acceleration of exactly `accel`.
    //
    // The control therefore runs **before** the step: the step must
    // integrate the speed this frame asked for, not the one from the
    // previous frame. (Applying it after the step would leave the
    // braking one sub-step late, which is a safety problem at a red
    // light, not just an inaccuracy.)
    //
    // The replay target is exempt: its speed is owned by the policy
    // (Python's own integration), and ramping it would cap the
    // acceleration at VEHICLE_DYN[type].accel instead of Python's
    // 3.0 m/s² — cross-language difference #7.
    for (const v of Object.values(network.vehicles)) {
      // Skip the dragged vehicle — its position is driven by the
      // editor's drag handler, not by Rapier.
      if (v.id === ctx.draggingId) continue
      // Skip a vehicle that is ON A TURN ARC: its body is dragged
      // kinematically by the arc (step 8), and an applyControl here
      // would push the body off it — the arc owns the pose, the ramp
      // (which already ran) owns the speed.
      if (v.turn) continue
      const road = network.roads[v.roadId]
      if (!road) continue
      const heading = v.heading
      // A vehicle that has left the road network is on its way out: it
      // brakes to a stop instead of following the road's speed limit.
      // The ramp toward 0 uses MAX_DECEL — the same deceleration a
      // stop at a red light uses — so the departure is physical.
      // See oobCleanup.ts.
      const speedTarget = isOobExiting(v) ? 0 : v.targetSpeed
      const nextSpeed = isReplayDriven(ctx, v)
        ? v.targetSpeed
        : rampSpeed(v.speed, speedTarget, dt, v.type)
      // Put the body on its road's height **before** the step. The
      // physics world has a flat ground and no geometry for the
      // elevated roads, so a body that starts a step at the ground
      // height stays there — the step's gravity pulls it down and the
      // pose it reads back carries the ground height.
      //
      // The road's height is known exactly (the lane geometry carries
      // it), so the application layer owns it. Only `y` changes: the
      // horizontal motion and the velocity are untouched.
      const roadY = lanePoint(road, v.laneIndex, v.s).position.y
      if (Math.abs(v.position.y - roadY) > 0.01) {
        v.position.y = roadY
        ctx.rapierWorld.setVehicleHeight(v.id, roadY)
      }
      ctx.rapierWorld.applyControl(
        v.id,
        { throttle: 1, brake: v.status === 'crashed' ? 1 : 0, steering: 0 },
        nextSpeed,
        heading,
      )
    }

    // 5b. Lane-change lateral velocity.
    //
    // This runs AFTER `applyControl` and BEFORE the physics step:
    // `applyControl` overwrites the body's linear velocity wholesale,
    // so a lateral component applied before it would be erased.
    applyLaneChangeLateralVelocity(network, ctx)

    // 5c. Step the physics. The world consumes the accumulated
    //     wall-clock time in fixed sub-steps, so the distance covered
    //     per wall-clock second no longer depends on the frame rate.
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
      // ===== the turn in progress (pivot→arc, ADR-012) =====
      //
      // The arc is advanced HERE, before `findNearestLane`: mid-turn
      // the body is ON THE ARC, up to ~7 m from either lane's point —
      // the lane projection (and the 5 m guard behind it) would fight
      // the arc every frame. The pose is the arc's; the Rapier body is
      // dragged along (kinematically — its speed was zeroed at turn
      // start, see `applyRoadTurn`).
      if (v.turn) {
        // The speed ramp keeps feeding the vehicle — step 5a skipped it
        // (the body is a passenger), so the ramp runs here, on the
        // entity, exactly where the arc consumes the speed. The BODY's
        // linvel stays zero (set at turn start): its pose is the arc's,
        // not the integration's.
        const turnRoad = network.roads[v.roadId]
        v.speed = rampSpeed(v.speed, turnRoad ? v.targetSpeed : 0, dt, v.type)
        v.turn.dist += v.speed * dt
        const turnArc = {
          p0: { x: v.turn.p0x, z: v.turn.p0z },
          p1: { x: v.turn.p1x, z: v.turn.p1z },
          p2: { x: v.turn.p2x, z: v.turn.p2z },
          length: v.turn.length,
        }
        if (v.turn.dist >= v.turn.length) {
          // Arrived: snap the pose to the arc's END (the lane's entry
          // point) before dropping the turn — the pose mid-arc is up to
          // ~7 m from the lane point, and the 5 m lane guard would fire
          // on exactly this frame otherwise (measured).
          const end = arcPointAt(turnArc, v.turn.length)
          v.position.x = end.x
          v.position.z = end.z
          v.heading = end.heading
          v.turn = undefined
          ctx.rapierWorld!.setVehiclePosition(v.id, v.position)
          ctx.rapierWorld!.setVehicleHeading(v.id, end.heading)
          ctx.rapierWorld!.setVehicleSpeed(v.id, v.speed, end.heading)
          // Fall through: the normal lane re-derivation now agrees with
          // the pose (the vehicle IS at its lane's entry point).
        } else {
          const p = arcPointAt(turnArc, v.turn.dist)
          v.position.x = p.x
          v.position.y = lanePoint(network.roads[v.roadId]!, v.laneIndex, v.s).position.y
          v.heading = p.heading
          ctx.rapierWorld!.setVehiclePosition(v.id, v.position)
          ctx.rapierWorld!.setVehicleHeading(v.id, p.heading)
          ctx.rapierWorld!.setVehicleSpeed(v.id, 0, p.heading)
          continue
        }
      }
      const nearest = findNearestLane(v, network)
      v.laneIndex = nearest.laneIndex
      v.s = nearest.s
      // Guard: when findNearestLane couldn't project (vehicle went past
      // road end and perpendicular distance exceeded the 5m limit), s
      // stays stale — possibly >= roadLength or <= 0. Clamp and snap the
      // Rapier body so rendering and physics stay in sync.
      let vRoad = network.roads[v.roadId]
      if (vRoad) {
        const len = roadLength(vRoad)
        // ===== travel-end wrap =====
        //
        // The body has run past the end of the direction its lane is
        // travelled (a forward lane ends at s = len, a backward lane
        // at s = 0). It re-enters the SAME lane from the other end of
        // the road and keeps driving — the road is a closed route for
        // the traffic on it, which is what the physics-free fallback
        // path has always done (`s -= len` / `s += len`).
        //
        // The old code parked the vehicle here: the body was snapped
        // back to the end point, its speed was zeroed, and step 3's
        // `targetSpeed = 0` clamp kept it there for good. Every demo
        // scene therefore ran for half a minute and then stood still.
        //
        // `findNearestLane` clamps `s` into [0, len], so `s` alone
        // cannot tell "standing at the end" from "driven past the
        // end" — the overrun is measured from the body's world
        // position instead (`travelEndOverrun`).
        const wrappedS = wrappedTravelS(v, vRoad)
        if (wrappedS !== null) {
          // ===== junction turn =====
          //
          // The travel end of a road can be a JUNCTION, and the road
          // network is a graph: the vehicle continues onto the road
          // that meets its own road there. Without this, every car
          // looped on its own way — measured on the real imported OSM
          // city (391 roads / 450 junctions, 8 cars, 90 s): 43 200
          // vehicle-frames, **0 road changes**.
          //
          // The turn is a pivot in place: the entry point of the new
          // road and the exit point of the old one are the same
          // junction, so the body moves ~0 m and changes heading.
          //
          // `roadContinuation` returns null when no turn is possible
          // (no junction at the travel end, or the junction has no
          // other road) — then the historical wrap happens, unchanged.
          // The vehicle's identity is the turn's seed: the movement it
          // makes at this junction (straight on, or a right / left turn)
          // is a hash of it, so the decision is reproducible and the two
          // motion paths below cannot disagree about it.
          const turn = roadContinuation(
            network,
            vRoad,
            v.laneIndex,
            v.heading,
            v.id,
            ctx.routeNextRoadId?.(v.id),
          )
          const turnedRoad = turn ? network.roads[turn.roadId] : undefined
          if (turn && turnedRoad) {
            applyRoadTurn(v, turnedRoad, turn, ctx)
            // The guards below must judge the vehicle against the road
            // it is on NOW — the old road would snap it straight back.
            vRoad = turnedRoad
          } else {
            applyTravelEndWrap(v, vRoad, wrappedS, ctx)
          }
        } else {
          // Guard: the body is off the lane it is supposed to be on
          // (findNearestLane could not project it, or the physics
          // pushed it sideways). Snap it back onto the lane so
          // rendering and physics stay in sync.
          const expectedAtS = lanePoint(vRoad, v.laneIndex, v.s)
          const dxEnd = v.position.x - expectedAtS.position.x
          const dzEnd = v.position.z - expectedAtS.position.z
          const distFromExpectedSq = dxEnd * dxEnd + dzEnd * dzEnd
          if (distFromExpectedSq > 25) {
            // 5m threshold
            //
            // This guard used to be **silent**: the car was teleported
            // back onto its lane with its speed zeroed and nobody was
            // told. The out-of-bounds exit phase never gets a chance to
            // announce this case — this guard fires first (it is the
            // stricter one), so the common "pushed sideways off the
            // lane" case produced NO event at all. The snap is recorded
            // now, through the same event log as the exit phase.
            const offLaneM = Math.sqrt(distFromExpectedSq)
            const speedAtGuard = v.speed
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
            recordLaneGuard({
              kind: 'lane-guard',
              vehicleId: v.id,
              simTime,
              distance: offLaneM,
              speed: speedAtGuard,
              reason: `snapped back onto its lane — it was ${offLaneM.toFixed(1)} m off its lane point at ${speedAtGuard.toFixed(1)} m/s, and its speed was zeroed`,
            })
          }
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
          // Recorded for the same reason as the 5 m guard above: a
          // silent teleport back onto the lane is indistinguishable
          // from a glitch to whoever watches the scene.
          const offLaneM = Math.sqrt(dx * dx + dz * dz)
          const speedAtGuard = v.speed
          v.position.x = expected.position.x
          v.position.y = expected.position.y
          v.position.z = expected.position.z
          v.heading = expected.heading
          v.speed = Math.min(v.speed, 5)
          ctx.rapierWorld!.setVehiclePosition(v.id, v.position)
          ctx.rapierWorld!.setVehicleHeading(v.id, expected.heading)
          ctx.rapierWorld!.setVehicleSpeed(v.id, v.speed, expected.heading)
          recordLaneGuard({
            kind: 'lateral-guard',
            vehicleId: v.id,
            simTime,
            distance: offLaneM,
            speed: speedAtGuard,
            reason: `pulled back onto its lane — it had drifted ${offLaneM.toFixed(1)} m sideways at ${speedAtGuard.toFixed(1)} m/s, and its speed was clamped`,
          })
        }
      }

      // Guard 3: the road's height. The physics world has a flat ground
      // and **no geometry for the elevated roads** — a ramp or a viaduct
      // is a polyline in the scene graph, not a collider. A vehicle
      // driving on one therefore sinks to the ground plane, and the pose
      // it reads back carries that ground height.
      //
      // The road's height is known exactly (the lane geometry carries
      // it), so the application layer owns it: the body is put at the
      // height of the road it is on, and the entity reports that same
      // height. Measured before this: a vehicle on the ramp reported
      // y = 0.749 (the ground) while the road at its arc length was at
      // y = 2.0 – 3.1 — a 1.3 – 2.4 m error that grew along the ramp.
      if (vRoad) {
        const roadY = lanePoint(vRoad, v.laneIndex, v.s).position.y
        if (Math.abs(v.position.y - roadY) > 0.01) {
          v.position.y = roadY
          ctx.rapierWorld!.setVehicleHeight(v.id, roadY)
        }
      }
    }

    // Pure Pursuit steering — turn toward the lookahead
    // point on the lane. Runs after step 8 (position re-derived) so
    // v.position / heading are fresh. Applies angular velocity to Rapier
    // bodies before the lane-change branch (which handles lateral slide).
    for (const v of Object.values(network.vehicles)) {
      if (v.id === ctx.draggingId) continue
      if (v.turn) continue // the arc owns the heading mid-turn
      const road = network.roads[v.roadId]
      if (!road) continue
      // Skip steering when the vehicle is stopped — Pure Pursuit
      // computes a non-zero angle whenever the heading differs from
      // the lookahead direction, and setting angular velocity on a
      // stationary body rotates it in place (the body doesn't move
      // but the heading changes, so when the vehicle resumes it
      // drives in the wrong direction).
      if (v.speed < 0.5) continue
      // While the vehicle is changing lanes the lookahead rides the
      // **target** lane, not the lane it currently occupies: that is
      // what turns the heading into the new lane instead of steering
      // the vehicle back to the lane it is leaving.
      const steerLane = v.desiredLaneIndex ?? v.laneIndex
      const delta = computeSteeringAngle(
        v.position.x,
        v.position.z,
        v.heading,
        road,
        steerLane,
        v.s,
        VEHICLE_PURE_PURSUIT[v.type],
      )
      const omega = steeringAngleToOmega(delta)
      ctx.rapierWorld.setVehicleAngularVelocity(v.id, omega)
    }

    // 8.6. Lane-change convergence. Runs after the pose refresh, so the
    //      lateral offset it measures is the one the physics just
    //      produced — not the one from before the step.
    finishLaneChanges(network, ctx, simTime)
  } else {
    // Fallback: no Rapier → hand-rolled move+s wrap. This path
    // replaces the previous hard-coded accel=3.5 / decel=10 with the
    // same per-type ramp the Rapier path uses (`rampSpeed`).
    for (const v of Object.values(network.vehicles)) {
      // `let`: a junction turn puts the vehicle on another road, and
      // everything below has to work on THAT road.
      let road = network.roads[v.roadId]
      if (!road) continue
      // The replay target already carries the Python-exact next
      // speed (step 2.5). Ramping it through the ramp would cap the
      // acceleration at VEHICLE_DYN[type].accel (2.0 m/s²) instead of
      // Python's 3.0 — cross-language difference #7.
      if (isReplayDriven(ctx, v)) {
        v.speed = v.targetSpeed
      } else {
        v.speed = rampSpeed(v.speed, v.targetSpeed, dt, v.type)
      }
      v.speed = Math.max(0, Math.min(MAX_SPEED, v.speed))
      // ===== the turn in progress (pivot→arc, ADR-012) =====
      //
      // Same contract as the Rapier path: the arc is advanced by the
      // speed, the pose is the arc's, and the vehicle skips its own s
      // integration while the turn runs (the destination lane's
      // roadId / laneIndex / s were set at turn start).
      if (v.turn) {
        v.turn.dist += v.speed * dt
        if (v.turn.dist >= v.turn.length) {
          // The pose lands on the entry point through the lane
          // re-derivation below (the fallback derives position from s),
          // so only the turn state is dropped here.
          v.turn = undefined
        } else {
          const p = arcPointAt(
            {
              p0: { x: v.turn.p0x, z: v.turn.p0z },
              p1: { x: v.turn.p1x, z: v.turn.p1z },
              p2: { x: v.turn.p2x, z: v.turn.p2z },
              length: v.turn.length,
            },
            v.turn.dist,
          )
          v.position.x = p.x
          v.position.z = p.z
          v.heading = p.heading
          continue
        }
      }
      const sign = laneForwardSign(v.laneIndex, road.laneCount)
      v.s += v.speed * sign * dt
      const len = roadLength(road)
      // ===== junction turn =====
      //
      // The same rule the physics path applies: a lane that runs past
      // its travel end continues onto the road that meets it there,
      // and only falls back to the historical wrap when no turn is
      // possible. The physics-free path is the faithful spelling of the
      // application-layer model, so both paths have to agree on where a
      // vehicle goes next.
      const pastTravelEnd = sign === 1 ? v.s > len : v.s < 0
      if (pastTravelEnd) {
        const turn = roadContinuation(
          network,
          road,
          v.laneIndex,
          v.heading,
          v.id,
          ctx.routeNextRoadId?.(v.id),
        )
        const turnedRoad = turn ? network.roads[turn.roadId] : undefined
        if (turn && turnedRoad) {
          const exitHeading = v.heading
          const exitX = v.position.x
          const exitZ = v.position.z
          const entryLp = lanePoint(turnedRoad, turn.laneIndex, turn.s)
          v.roadId = turn.roadId
          v.laneIndex = turn.laneIndex
          v.s = turn.s
          v.heading = turn.heading
          v.lane = LaneId.make(turn.roadId, turn.laneIndex)
          // A lane change belongs to the lane space of the road the
          // vehicle was on — it does not carry onto the new road.
          v.desiredLaneIndex = null
          v.laneChangeStartedAt = null
          // Near-straight continuations land directly (see the Rapier
          // path and MIN_ARC_TURN_RAD); real turns take the arc, exactly
          // as the Rapier path builds it (ADR-012): the two motion paths
          // must produce the same turn.
          if (turnAngle(exitHeading, turn.heading) < MIN_ARC_TURN_RAD) {
            v.position.x = entryLp.position.x
            v.position.z = entryLp.position.z
            road = turnedRoad
          } else {
            const arc = buildTurnArc(
            { x: exitX, z: exitZ, heading: exitHeading },
            { x: entryLp.position.x, z: entryLp.position.z, heading: turn.heading },
          )
            v.turn = {
              s: turn.s,
              heading: turn.heading,
              p0x: arc.p0.x,
              p0z: arc.p0.z,
              p1x: arc.p1.x,
              p1z: arc.p1.z,
              p2x: arc.p2.x,
              p2z: arc.p2.z,
              length: arc.length,
              dist: 0,
            }
          }
          road = turnedRoad
        } else {
          if (v.s > len) v.s -= len
          if (v.s < 0) v.s += len
        }
      }
      const lp = lanePoint(road, v.laneIndex, v.s)
      v.position.x = lp.position.x
      v.position.y = lp.position.y
      v.position.z = lp.position.z
      v.heading = lp.heading
      // Lane change: this path has no lateral dynamics to integrate, so
      // the lateral offset is placed where the SAME P-controller the
      // physics path integrates would have put it: the lateral
      // velocity is `STEER_GAIN` × the offset error, capped at
      // `MAX_LATERAL_MS` (see `steerLateralVelocity` and
      // `fallbackLateralOffset`).
      //
      // The old code blended the position from the current lane to the
      // target lane over a fixed duration — a *time* mix that ignored
      // both the gain and the cap, so the physics-free path and the
      // physics path did not describe the same manoeuvre.
      if (v.desiredLaneIndex !== null) {
        const fromLat = laneOffset(v.laneIndex, road.laneCount)
        const toLat = laneOffset(v.desiredLaneIndex, road.laneCount)
        const elapsed = v.laneChangeStartedAt === null ? 0 : simTime - v.laneChangeStartedAt
        const offset = fallbackLateralOffset(fromLat, toLat, elapsed)
        // Place the body at that offset from the road's centreline:
        // the lane point plus the shift along the road's right vector.
        const right = roadRight(road, v.s)
        const shift = offset - fromLat
        v.position.x = lp.position.x + shift * right.ux
        v.position.y = lp.position.y
        v.position.z = lp.position.z + shift * right.uz
        // The heading turns towards the target lane in proportion to
        // how much of the lateral offset has been covered.
        const targetLp = lanePoint(road, v.desiredLaneIndex, v.s)
        const span = toLat - fromLat
        const progress = span === 0 ? 1 : Math.max(0, Math.min(1, (offset - fromLat) / span))
        v.heading = lp.heading + (targetLp.heading - lp.heading) * progress
      }
    }
    // The hand-rolled path has no physics to converge on its own, so the
    // lane-change state is resolved here (the Rapier path resolves it
    // after the pose refresh — see `finishLaneChanges`).
    finishLaneChanges(network, ctx, simTime)
  }

  // 9. LiDAR scan — only when enabled (perf gate). The fix:
  //    scan() is actually called from inside tick.ts.
  if (ctx.lidarEnabled && ctx.sensorRegistry && ctx.rapierWorld) {
    ctx.sensorRegistry.scanAll(ctx.rapierWorld, simTime, ctx.getHostPose)
  }

  // 10. Trajectory export — fixed-step rate.
  //     When a FixedStepScheduler is provided, only call
  //     record() on fixed-step boundaries (default 10 Hz). Without
  //     a scheduler, fall back to per-frame (the default).
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

  // 11. Update status (hysteresis).
  for (const v of Object.values(network.vehicles)) {
    v.status = statusFromHysteresis(v.status, v.desiredStatus, v.speed)
  }

  // 11.5. Release spawn points when the occupying
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

  // 12. OOB cleanup. Vehicles that have drifted > 50m from
  //     their (road, lane, s) geometry are braking to a stop and are
  //     then respawned at s=0. Vehicles whose road is missing (e.g.
  //     after a scene load) are hard-deleted. Every entry and every
  //     reset is recorded in the OOB event log.
  //     See the out-of-bounds cleanup design for the details.
  tickOobCleanup(
    {
      getRoad: (id) => network.roads[id],
      removeVehicle: (id) => ctx.removeVehicle(id),
      snapVehicle: (id, pos, heading) => {
        ctx.rapierWorld?.setVehiclePosition(id, pos)
        ctx.rapierWorld?.setVehicleHeading(id, heading)
        ctx.rapierWorld?.setVehicleSpeed(id, 0, heading)
      },
      // The vehicle the editor is dragging is under the user's control.
      draggingId: () => ctx.draggingId,
    },
    Object.values(network.vehicles),
    simTime,
    dt,
  )
}

// ===== lane change — control constants =====
/** P-controller gain for lateral linvel (1/s). 2.0 means a 1m gap
 *  gets 2 m/s of lateral velocity. */
const STEER_GAIN = 2.0
/** Cap on lateral linvel (m/s). 4 m/s ≈ 14 km/h sideways. */
const MAX_LATERAL_MS = 4.0
/** Stuck-lane-change abort timeout (seconds). */
const LANE_CHANGE_TIMEOUT_S = 5.0

/**
 * The lateral offset (metres from the road's centreline) the
 * physics-free fallback path puts a vehicle at, `elapsed` seconds into
 * a lane change that starts at `fromLat` and targets `toLat`.
 *
 * It is the **closed-form solution of the very same P-controller** the
 * physics path integrates (`steerLateralVelocity` with `STEER_GAIN`
 * and `MAX_LATERAL_MS`):
 *
 *   - while the offset error is bigger than `MAX_LATERAL_MS /
 *     STEER_GAIN` (2 m), the controller is saturated and the offset
 *     moves at the cap (`MAX_LATERAL_MS` m/s);
 *   - below that the controller is linear and the remaining error
 *     decays exponentially with the time constant `1 / STEER_GAIN`.
 *
 * The old implementation blended the position from the current lane to
 * the target lane over a fixed duration — a *time* mix that ignored
 * the gain and the cap, so the two paths did not describe the same
 * manoeuvre. The closed form keeps the fallback frame-rate
 * independent (it is a function of the elapsed simulation time) and
 * makes it obey the same limits as the physics path.
 */
export const fallbackLateralOffset = (fromLat: number, toLat: number, elapsed: number): number => {
  const error = toLat - fromLat
  if (error === 0) return toLat
  const t = Math.max(0, elapsed)
  // The controller's output while it is saturated.
  const saturatedRate = Math.sign(error) * Math.min(Math.abs(error) * STEER_GAIN, MAX_LATERAL_MS)
  // How long it stays saturated (0 when the error is small enough that
  // the proportional term never reaches the cap).
  const tSaturated = Math.max(0, (Math.abs(error) - MAX_LATERAL_MS / STEER_GAIN) / MAX_LATERAL_MS)
  if (t <= tSaturated) return fromLat + saturatedRate * t
  // Linear phase: the remaining error decays with the time constant
  // 1 / STEER_GAIN.
  const errorAtSwitch = error - saturatedRate * tSaturated
  return toLat - errorAtSwitch * Math.exp(-STEER_GAIN * (t - tSaturated))
}

// ===== travel-end wrap =====
//
// The end of a lane's travel direction is a **wrap point**, not a
// parking spot: a vehicle that runs past it re-enters the same lane
// from the other end of the road and keeps driving. The physics-free
// fallback path has always done that (`s -= len` / `s += len`); the
// physics path did not, and parked every vehicle at the end of the
// road instead — so a demo scene ran for half a minute and then stood
// still for good.
//
// The three helpers below are the physics-path spelling of that rule.

// ---------------------------------------------------------------------------
// Travel-end wrap
// ---------------------------------------------------------------------------

/**
 * How far (metres) the vehicle's body has travelled **past** the end
 * of the direction its lane is travelled.
 *
 * Forward lanes run start → end, so their end is `s = roadLength`;
 * backward lanes run end → start, so their end is `s = 0`. The
 * measurement is the signed distance from that end point along the
 * lane's TRAVEL direction — positive exactly when the body has run
 * off the end, negative while it is still short of it.
 *
 * The body's world position is used rather than `v.s`, because
 * `findNearestLane` clamps `s` into `[0, len]`: a vehicle that has
 * driven 3 m past the end still reports `s = len`, and `s` alone
 * cannot tell "standing at the end" from "driven past it".
 */
const travelEndOverrun = (v: Vehicle, road: Road): number => {
  const len = roadLength(road)
  if (len < 1e-6) return 0
  const sign = laneForwardSign(v.laneIndex, road.laneCount)
  const endS = sign === 1 ? len : 0
  const end = lanePoint(road, v.laneIndex, endS)
  // `end.heading` is the lane's travel heading at the end point: the
  // road tangent for a forward lane, the REVERSED tangent for a
  // backward lane. Projecting the body's offset on it therefore gives
  // the overrun for both lane directions with the same formula.
  const ux = Math.cos(end.heading)
  const uz = Math.sin(end.heading)
  const dx = v.position.x - end.position.x
  const dz = v.position.z - end.position.z
  return dx * ux + dz * uz
}

/**
 * The arc-length the vehicle re-enters the road at, or `null` when it
 * has not run past the end yet.
 *
 * This mirrors the fallback path's `s -= len` / `s += len` exactly: a
 * forward lane that ran `d` metres past `s = len` re-enters at
 * `s = d`; a backward lane that ran `d` metres past `s = 0` re-enters
 * at `s = len - d`.
 */
const wrappedTravelS = (v: Vehicle, road: Road): number | null => {
  const len = roadLength(road)
  if (len < 1e-6) return null
  const overrun = travelEndOverrun(v, road)
  if (overrun <= 0) return null
  const sign = laneForwardSign(v.laneIndex, road.laneCount)
  // A single frame can never carry the body more than a few metres
  // past the end, but the modulo keeps the wrap well defined even if
  // it does (an editor teleport, a huge frame dt).
  const overshoot = overrun % len
  return sign === 1 ? overshoot : len - overshoot
}

/**
 * Teleport the vehicle to the other end of its lane and re-launch it.
 *
 * The body is moved to the **lane point** of the wrapped `s` — so it
 * lands on the correct lateral lane offset, not on the road
 * centreline — and is re-oriented along the lane's travel direction.
 * A backward lane (laneIndex >= laneCount/2) runs against the road's
 * tangent, so its heading is the reversed tangent: a vehicle that
 * kept the road's forward heading after the wrap would drive against
 * its own lane.
 *
 * The speed is preserved — the wrap is a teleport, not a stop.
 * `setVehiclePosition` zeroes the body's linear velocity, so the
 * speed has to be re-applied afterwards.
 */
const applyTravelEndWrap = (v: Vehicle, road: Road, newS: number, ctx: TickContext): void => {
  const lp = lanePoint(road, v.laneIndex, newS)
  const fwd = roadForward(road, newS)
  const sign = laneForwardSign(v.laneIndex, road.laneCount)
  const heading = Math.atan2(fwd.uz * sign, fwd.ux * sign)
  v.s = newS
  v.position.x = lp.position.x
  v.position.y = lp.position.y
  v.position.z = lp.position.z
  v.heading = heading
  ctx.rapierWorld!.setVehiclePosition(v.id, v.position)
  ctx.rapierWorld!.setVehicleHeading(v.id, heading)
  ctx.rapierWorld!.setVehicleSpeed(v.id, v.speed, heading)
}

/**
 * Teleport the vehicle onto the road it turns onto and re-launch it.
 *
 * The body is moved to the **lane point** of the new (road, lane, s) —
 * so it lands on the correct lateral lane offset, not on the road
 * centreline — and is re-oriented along the new lane's travel
 * direction.
 *
 * The speed is preserved: a turn is a pivot, not a stop.
 * `setVehiclePosition` zeroes the body's linear velocity, so the speed
 * has to be re-applied afterwards (exactly like the travel-end wrap).
 *
 * The turn is ~0 m of movement — the exit point of the old road and the
 * entry point of the new one are the same junction — so the vehicle
 * keeps its momentum and simply changes heading.
 */
const applyRoadTurn = (v: Vehicle, road: Road, turn: RoadContinuation, ctx: TickContext): void => {
  const lp = lanePoint(road, turn.laneIndex, turn.s)
  // The EXIT heading is the pose the vehicle has NOW (step 8 re-derived
  // it from the body) — the arc starts there, along the direction the
  // vehicle was actually travelling, which is what kills the pivot's
  // sideways teleport: the body now sweeps the corner along a Bézier
  // that starts along the old heading and ends along the new (ADR-012).
  const exitHeading = v.heading
  const exitX = v.position.x
  const exitZ = v.position.z
  // The destination lane's values take effect IMMEDIATELY (constraints,
  // yield and selection all see the road the vehicle is committed to);
  // the body travels there along the arc — unless the continuation is
  // near-straight (see MIN_ARC_TURN_RAD): then it lands directly, the
  // pivot with no sweep to fix.
  const direct = turnAngle(exitHeading, turn.heading) < MIN_ARC_TURN_RAD
  v.roadId = road.id
  v.laneIndex = turn.laneIndex
  v.s = turn.s
  v.heading = turn.heading
  v.lane = LaneId.make(road.id, turn.laneIndex)
  // A lane change is expressed in the lane space of the road the vehicle
  // was on; the new road has its own lane space, so the change does not
  // carry over.
  v.desiredLaneIndex = null
  v.laneChangeStartedAt = null
  if (direct) {
    v.position.x = lp.position.x
    v.position.y = lp.position.y
    v.position.z = lp.position.z
    ctx.rapierWorld!.setVehiclePosition(v.id, v.position)
    ctx.rapierWorld!.setVehicleHeading(v.id, turn.heading)
    ctx.rapierWorld!.setVehicleSpeed(v.id, v.speed, turn.heading)
    return
  }
  const arc = buildTurnArc(
    { x: exitX, z: exitZ, heading: exitHeading },
    { x: lp.position.x, z: lp.position.z, heading: turn.heading },
  )
  v.turn = {
    s: turn.s,
    heading: turn.heading,
    p0x: arc.p0.x,
    p0z: arc.p0.z,
    p1x: arc.p1.x,
    p1z: arc.p1.z,
    p2x: arc.p2.x,
    p2z: arc.p2.z,
    length: arc.length,
    dist: 0,
  }
  // The body is a passenger on the arc from here: its speed is zeroed
  // (the arc drags it kinematically — see the turn block in step 8),
  // its pose is the arc's.
  ctx.rapierWorld!.setVehiclePosition(v.id, v.position)
  ctx.rapierWorld!.setVehicleHeading(v.id, exitHeading)
  ctx.rapierWorld!.setVehicleSpeed(v.id, 0, exitHeading)
}

/**
 * Apply the lane-change lateral velocity to every vehicle that is
 * changing lanes.
 *
 * ORDERING IS LOAD-BEARING: this must run **after** the longitudinal
 * control (`applyControl`) and **before** the next physics step.
 * `applyControl` overwrites the body's linear velocity wholesale, so a
 * lateral component that was applied before it was wiped — the lane
 * change was a no-op that produced no visible movement at all. (It used
 * to run before the step instead, which had the same defect from the
 * other side: the next frame's `applyControl` erased the component
 * before the physics could integrate it.)
 *
 * The lateral velocity is a P-controller on the offset from the road's
 * centreline. `travelSign` reconciles the two sign conventions (the
 * offset is right-of-centreline positive, the velocity is
 * left-of-travel positive) — see `steerLateralVelocity`.
 */
const applyLaneChangeLateralVelocity = (network: RoadNetwork, ctx: TickContext): void => {
  const rapier = ctx.rapierWorld
  if (!rapier) return
  for (const v of Object.values(network.vehicles)) {
    if (v.desiredLaneIndex === null) continue
    if (v.id === ctx.draggingId) continue
    const road = network.roads[v.roadId]
    if (!road) continue
    const currentLat = perpendicularOffsetAlongRoad(road, v.s, v.position)
    const targetLat = laneOffset(v.desiredLaneIndex, road.laneCount)
    const travelSign = laneForwardSign(v.laneIndex, road.laneCount)
    const lat = steerLateralVelocity(currentLat, targetLat, STEER_GAIN, MAX_LATERAL_MS, travelSign)
    rapier.setVehicleLateralVelocity(v.id, lat)
  }
}

/**
 * Resolve the lane-change state once the vehicle's pose is fresh: commit
 * the target lane when the lateral offset has converged, or abort a
 * change that got stuck.
 *
 * The convergence test measures the offset the vehicle actually has
 * from the target lane's centreline — not the lane it happens to be
 * nearest to. A vehicle that has converged is within
 * `LANE_CHANGE_CONVERGED_M` of the target lane, so the next pose
 * refresh keeps it there (the lane it is nearest to IS the target
 * lane) and the change sticks.
 *
 * The body is deliberately NOT teleported onto the lane centreline: the
 * remaining offset (≤ 0.3 m) is smaller than the Pure Pursuit's own
 * tracking error, and a teleport would zero the body's velocity and
 * show up in the trajectory export as an impossible deceleration.
 */
const finishLaneChanges = (network: RoadNetwork, ctx: TickContext, simTime: number): void => {
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
    if (Math.abs(targetLat - currentLat) < LANE_CHANGE_CONVERGED_M) {
      // Converged — commit the target lane.
      v.laneIndex = targetLane
      v.desiredLaneIndex = null
      v.laneChangeStartedAt = null
    } else if (
      v.laneChangeStartedAt !== null &&
      simTime - v.laneChangeStartedAt > LANE_CHANGE_TIMEOUT_S
    ) {
      // Stuck — abort.
      v.desiredLaneIndex = null
      v.laneChangeStartedAt = null
    }
  }
}

/** Stamp simTime on entering intersection. */
const updateIntersectionEntry = (
  network: RoadNetwork,
  simTime: number,
  junctions: JunctionIndex,
): void => {
  for (const v of Object.values(network.vehicles)) {
    const road = network.roads[v.roadId]
    if (!road) continue
    // EVERY junction box on this road — not just the first one.
    //
    // The old code took the first connected intersection and tested only
    // its box. On the built-in scenes that is the same thing (one
    // junction per road), but an OSM way has a junction at BOTH ends —
    // the two crossroads it connects — so the second junction was
    // invisible to the occupancy rule: a car driving through it was
    // never "in the intersection", and the cross-road yield rule then
    // treated it as a car still waiting to enter.
    //
    // Measured on the real Shenzhen extract (391 roads / 450 junctions),
    // the old rule missed 4 952 of 43 200 vehicle-frames.
    //
    // A road with no junction at all now has NO box — the old fallback
    // put a phantom 10 m box at the road's midpoint, which marked a
    // car "in the intersection" while it was merely halfway along a
    // street that has no crossroads.
    let inBox = false
    for (const inter of junctions.on(road.id)) {
      if (inIntersectionBox(road, v.s, inter.intersectionRadius, inter)) {
        inBox = true
        break
      }
    }
    if (inBox) {
      if (v.enteredIntersectionAt === null) {
        v.enteredIntersectionAt = simTime
      }
    } else {
      v.enteredIntersectionAt = null
    }
  }
}

/** 红灯/黄灯 prepare-to-stop 逻辑 (信号灯控制器仍要用). */
const applyTrafficLightConstraint = (
  v: Vehicle,
  road: Road,
  network: RoadNetwork,
  ctx: TickContext,
) => {
  // Replay target handles lights itself via obs.
  if (isReplayDriven(ctx, v)) return
  for (const inter of Object.values(network.intersections)) {
    if (!inter.connectedRoads.includes(road.id)) continue
    // The stop line sits on the edge of the intersection box, **on the
    // side the vehicle approaches from**.
    //
    // `stopLineSOnRoad` projects the intersection position onto the
    // road: an imported OSM junction sits at a way *endpoint*, not at
    // the road midpoint, so the stop line has to follow the projection
    // (the historical midpoint assumption is only the degradation
    // fallback). The per-intersection radius (T路口 6, corner 4) keeps
    // the brake-trigger window consistent with the visual stop line
    // drawn by createRoadMarkings — both read the same projection.
    //
    // The direction flips the offset: a forward lane travels towards a
    // LARGER `s` and stops at `centerS - radius`, a backward lane
    // travels towards a SMALLER `s` and stops at `centerS + radius`.
    // `null` means this approach has no stop line on this road (the
    // intersection is not on it).
    const stopLineS = stopLineSOnRoad(road, inter, v.laneIndex)
    if (stopLineS === null) continue
    //
    // ===== THE RED-LIGHT RULE (stop line → commitment) =====
    //
    // A vehicle that has **crossed** the stop line is *committed*: it
    // clears the intersection and is not stopped inside it. That is the
    // dilemma-zone rule real traffic law uses, and this simulator can
    // afford it because the cross-road yield rule (`applyCrossRoadYield`)
    // gives the vehicle that entered the intersection first priority
    // over the crossing traffic — so a committed vehicle never deadlocks
    // the crossing flow.
    //
    // Stopping *inside* the intersection instead would be the wrong
    // trade: the vehicle would block the very flow it is yielding to
    // (an all-way gridlock), and the "crossing" it is waiting for is a
    // light that will not turn green until it has cleared.
    //
    // The consequence of the commitment rule is that the red light must
    // be enforced **before** the stop line — which is what the braking
    // distance below is for. It is computed with the SAME decel ceiling
    // the speed ramp uses (`MAX_DECEL`, see `rampSpeed`), so a vehicle
    // that reacts in time comes to a stand-still at the line instead of
    // rolling through it. A vehicle that is already too close to stop
    // (the dilemma zone) runs the red and clears the intersection —
    // which is what a real driver does, and what the cross-road yield
    // rule is there to handle.
    //
    // Note the boundary: the remaining distance is 0 ON the line, and a
    // vehicle that stands exactly ON the line has not crossed it yet and
    // is held. The remaining distance is negative **after** the line,
    // and the sign of that test flips with the travel direction.
    const sign = laneForwardSign(v.laneIndex, road.laneCount)
    const distToStopLine = sign === 1 ? stopLineS - v.s : v.s - stopLineS
    if (distToStopLine < 0) continue
    // NOTE: the old code bailed out here with `distToStopLine <= 0`,
    // which released a vehicle that stood exactly ON the stop line —
    // the light stopped governing it, so it accelerated straight
    // through the red. A vehicle that has not crossed the line is
    // still governed by it, right down to the line itself.
    // Which light governs THIS approach?
    //
    // The axis is the road's **approach axis at this junction** — the
    // local tangent where the road meets the junction, not the road's
    // end-to-end delta. Three places have to agree on that number:
    // the light is created per axis group (`approachAxisGroups`), the
    // queue is scoped by it (`axisRoadsForLight`), and this test
    // picks the light that holds the vehicle.
    //
    // The old test (`|endNode.z - startNode.z| > |endNode.x - startNode.x|`,
    // the road's whole extent) disagreed with the polyline-extent test
    // the queue scoping used, and with the local-tangent test the
    // lights are built from. Measured on the real Shenzhen extract:
    // **1661 of the 7320 roads** have a different approach axis than
    // their whole-road axis — for those, the old test picked the wrong
    // light (or none).
    //
    // Computed ONCE per intersection, not once per light: the projection
    // is O(waypoints), and a junction with two axis groups would
    // otherwise pay for it twice — for every vehicle, every tick.
    const axis = approachAxis(road, inter)
    for (const light of inter.trafficLights) {
      if (light.axis !== axis) continue
      // Exhaustive phase set.
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
        // Braking distance = v²/(2·a) + buffer, with `a` = the decel
        // ceiling the speed ramp actually applies to a stop. Reading the
        // same constant the ramp uses is what keeps the two in step:
        // with the comfortable per-type decel (2.5 m/s² for a car) the
        // vehicle would need four times this distance and would roll
        // straight through the stop line.
        const braking = (v.speed * v.speed) / (2 * MAX_DECEL) + STOP_LINE_BUFFER
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

/** Newell car-following. */
const applyCarFollowingConstraint = (
  v: Vehicle,
  road: Road,
  network: RoadNetwork,
  ctx: TickContext,
) => {
  // Replay target handles follower distance via obs.
  if (isReplayDriven(ctx, v)) return
  const sign = laneForwardSign(v.laneIndex, road.laneCount)
  let bestGap = Infinity
  let leader: Vehicle | null = null
  for (const other of Object.values(network.vehicles)) {
    if (other.id === v.id) continue
    // A vehicle that is leaving the network (it has drifted off the
    // road and is braking to a stop) is not a leader: it is not on the
    // lane any more, so nobody behind it has to brake for it.
    if (isOobExiting(other)) continue
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
  // Simplified Gipps — adds a relative-velocity
  // braking component to the safe gap so the follower preempts the
  // leader's deceleration. Without it, Newell's `speed*TIME_HEADWAY +
  // MIN_GAP` under-protects when the leader is braking hard.
  const safeGap = safeGapGipps(v.speed, leader.speed, gap, TIME_HEADWAY, MIN_GAP)
  // The speed the follower may still hold and still keep that gap: the
  // **inverse** of the formula above, so the two agree by construction.
  //
  // The old rule clamped the follower's target to the leader's
  // **current** speed, so a leader that braked hard left the follower
  // at that speed — and the follower, whose own braking is capped at
  // MAX_DECEL_COMFY, closed the remaining gap and hit it. Measured
  // 2026-10-25 on the 5 x 5 grid: 1364 frames of a follower at 8.97 m/s
  // inside a leader at 2.49 m/s.
  const safeSpeed = safeSpeedGipps(leader.speed, gap, TIME_HEADWAY, MIN_GAP)
  if (gap >= safeGap) {
    // The desired gap is available. The only thing that can still be
    // wrong is the follower's own speed: it may be too fast for the gap
    // it has, and then it has to give way *now* rather than when the
    // gap is already gone.
    if (v.speed > safeSpeed) v.targetSpeed = safeSpeed
    return
  }
  // The gap is short: the follower gives way, and it may not be faster
  // than it could brake to from.
  v.targetSpeed = Math.min(leader.speed, safeSpeed)
}

const applyCrossRoadYield = (
  network: RoadNetwork,
  ctx: TickContext,
  junctions: JunctionIndex,
): void => {
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
      // The two roads must actually MEET at a junction.
      //
      // The rule used to fire between any two vehicles on different
      // roads: a car entering any junction froze every other car on
      // every other road of the network. On the built-in scenes that is
      // harmless (they are one crossroads), but on an imported city it
      // reached 2 073 m — the car that had to wait was half the district
      // away, and its own junction was 452 m off.
      //
      // Two roads that share a junction are the only pair that can
      // actually conflict, so that is the pair the rule is about.
      if (!junctions.sharedJunction(a.roadId, b.roadId)) continue
      // The later arrival yields. The replay target's speed is
      // owned by the policy (or by an injected action) — the yield rule
      // must not discard it, or the policy's output dies one step after
      // it was written.
      //
      // ===== THE COMMITMENT RULE =====
      //
      // A vehicle that is **already inside the intersection box** is
      // committed: it clears the intersection and is never stopped by the
      // cross-road yield. The yield only applies to a vehicle that has
      // NOT entered the box yet — it stops *before* the intersection and
      // lets the committed one through.
      //
      // The old code also stopped the LATER of two vehicles that were both
      // inside the box ("first come, first served"). That is the deadlock:
      // the later car was already committed, and stopping it there meant it
      // stood **in** the intersection and blocked the very axis it was
      // yielding to. A stopped car inside the box also keeps the other axis'
      // vehicles out (they see an occupied box), so the whole junction
      // locked up.
      //
      // The commitment rule is the same one the traffic-light constraint
      // already uses (`distToStopLine < 0 → continue`: a vehicle that has
      // crossed the stop line is not held by the light any more), and it is
      // the rule the Python training sim applies (`sim_core.py` →
      // `_signal_limit()`: "already past the stop line — the vehicle is in
      // the intersection and keeps going" → no limit). The right of way
      // between two perpendicular approaches is settled by the signal
      // itself — `resolveSignalConflicts` guarantees that only one axis is
      // ever green — so the yield rule only has to cover the case where a
      // vehicle is *about* to enter a box that is already occupied.
      let yielded: Vehicle | null = null
      if (a.enteredIntersectionAt !== null && b.enteredIntersectionAt === null) {
        yielded = b
      } else if (b.enteredIntersectionAt !== null && a.enteredIntersectionAt === null) {
        yielded = a
      }
      // Both inside the box → both are committed → neither yields.
      if (yielded && !isReplayDriven(ctx, yielded) && !isDriveDriven(ctx, yielded)) {
        yielded.targetSpeed = 0
      }
    }
  }
}

const classifyContacts = (network: RoadNetwork, events: ReadonlyArray<ContactEvent>): void => {
  for (const e of events) {
    const va = network.vehicles[e.colliderA]
    const vb = network.vehicles[e.colliderB]
    if (!va || !vb) continue
    // Respect the impulse threshold. Taps below the
    // threshold (e.g. cars nudging in stop-and-go) leave both
    // vehicles `driving`. Currently Rapier reports impulse=0 on
    // every contact, so the threshold defaults to 0 and every
    // contact still triggers `crashed` (back-compat with the original Rapier integration).
    if (e.impulse < CRASH_IMPULSE_THRESHOLD) continue
    va.status = 'crashed'
    vb.status = 'crashed'
  }
}

// DEFAULT_CONTROLLER_KIND re-exported so existing callers can still import
// from this module without touching the shared constants path.
export { DEFAULT_CONTROLLER_KIND }

// ===== RL replay obs builder =====
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

  // Traffic light bits — Python parity.
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
  // Keep the replay vector aligned with Python SimCore._obs().
  obs[13] = Math.max(-1, Math.min(1, ego.position.y / 10.0))
  return obs
}
