// src/domain/services/vehicleDynamics.ts
//
// Pure functions for vehicle dynamics + status-decision.
// tick.ts calls these in step 3-4 (target speed) and step 11 (status).
// Keeping the math here means the integration logic stays linear and
// these helpers can be unit-tested in isolation.
//
// All functions are pure: same input → same output, no side effects.

// Ramp speed toward `targetSpeed`, limited by
// `maxAccel`. Returns the new speed value (does not mutate the
// vehicle). The ramp linearly accelerates toward `targetSpeed`; if
// the gap is smaller than `maxAccel * dt`, the new speed snaps to
// `targetSpeed` (avoids the "almost-target-but-not-quite" floating-
// point asymptote).
//
// Negative speeds are clamped to 0 — vehicles cannot drive in reverse
// in this simulator (reverse is reserved for future parking maneuvers).
//
// This is the *primitive* ramp: it uses the per-type accel / decel
// caps and nothing else. The simulation uses `rampSpeed` below, which
// adds the "stop now" decel tier (`MAX_DECEL`) that the traffic-light
// constraint's braking distance assumes.
import {
  MAX_ACCEL_COMFY,
  MAX_DECEL_COMFY,
  MAX_DECEL,
  DRIVING_SPEED_THRESHOLD,
  WAITING_SPEED_THRESHOLD,
  VEHICLE_DYN,
} from '@shared/constants/simulation'
import type { Vehicle, VehicleStatus, VehicleType } from '@domain/entities/Vehicle'

/**
 * Ramp `currentSpeed` toward `targetSpeed` using the per-type accel
 * cap. Returns the new speed value.
 *
 * @param currentSpeed  m/s, current speed
 * @param targetSpeed   m/s, desired speed
 * @param dt            seconds since last update
 * @param type          vehicle type (car / truck / bus)
 */
export const smoothAccel = (
  currentSpeed: number,
  targetSpeed: number,
  dt: number,
  type: VehicleType,
): number => {
  if (dt <= 0) return currentSpeed
  const accelCap = VEHICLE_DYN[type].accel
  const decelCap = VEHICLE_DYN[type].decel
  // Use accel cap when speeding up, decel cap when slowing down.
  const dv = targetSpeed - currentSpeed
  if (Math.abs(dv) < 1e-6) return targetSpeed
  const cap = dv > 0 ? accelCap : decelCap
  const maxDv = cap * dt
  if (Math.abs(dv) <= maxDv) return Math.max(0, targetSpeed)
  return Math.max(0, currentSpeed + Math.sign(dv) * maxDv)
}

/**
 * The speed a vehicle should carry after this tick: the current speed
 * ramped toward `targetSpeed` under the vehicle type's caps.
 *
 * This is the ramp the simulation uses — both the Rapier path and the
 * physics-free fallback path. It is `smoothAccel` plus one extra tier:
 *
 *   - **Accelerating** → `VEHICLE_DYN[type].accel` (per type).
 *   - **Slowing down to a non-zero target** → `VEHICLE_DYN[type].decel`
 *     (per type, comfortable).
 *   - **Stopping** (`targetSpeed === 0` — a red light, a stopped
 *     leader, the end of the road) → `MAX_DECEL`, the documented
 *     "normal stop-at-red-light decel ceiling".
 *
 * The stop tier is not an arbitrary choice: the traffic-light
 * constraint computes its braking distance as `v² / (2·MAX_DECEL) +
 * STOP_LINE_BUFFER`, i.e. it assumes the vehicle can decelerate at
 * exactly `MAX_DECEL`. If the ramp used the comfortable per-type decel
 * (2.5 m/s² for a car) the vehicle would need four times the distance
 * the constraint assumed and would roll straight through the stop line.
 * Both sides read the same constant, so they cannot drift apart.
 *
 * @param currentSpeed  m/s, the speed the vehicle carries now
 * @param targetSpeed   m/s, the speed the controller asks for
 * @param dt            seconds since the last update
 * @param type          vehicle type (car / truck / bus)
 */
export const rampSpeed = (
  currentSpeed: number,
  targetSpeed: number,
  dt: number,
  type: VehicleType,
): number => {
  if (dt <= 0) return currentSpeed
  const dv = targetSpeed - currentSpeed
  if (Math.abs(dv) < 1e-6) return Math.max(0, targetSpeed)
  if (dv > 0) {
    const maxDv = VEHICLE_DYN[type].accel * dt
    if (dv <= maxDv) return Math.max(0, targetSpeed)
    return Math.max(0, currentSpeed + maxDv)
  }
  const decelCap = targetSpeed === 0 ? MAX_DECEL : VEHICLE_DYN[type].decel
  const maxDv = decelCap * dt
  if (-dv <= maxDv) return Math.max(0, targetSpeed)
  return Math.max(0, currentSpeed - maxDv)
}

/**
 * Simplified Gipps safe-following gap. Newell's
 * rule assumes the leader travels at constant speed, which causes
 * the follower to misjudge when the leader is decelerating (e.g.
 * approaching a red light). Gipps accounts for the relative speed
 * by adding a `v * Δv / (2 * b)` term — the gap the follower needs
 * to brake to the leader's speed with the leader's decel limit.
 *
 * @param selfSpeed       m/s, this vehicle's current speed
 * @param leaderSpeed     m/s, the vehicle ahead's speed
 * @param gap             m, bumper-to-bumper distance to leader
 * @param timeHeadway     s, desired following time (1.5s default)
 * @param minGap          m, hard bumper-to-bumper floor (2m)
 * @param leaderDecelCap  m/s², decel ceiling for the leader
 * @returns safe gap in metres
 */
export const safeGapGipps = (
  selfSpeed: number,
  leaderSpeed: number,
  gap: number,
  timeHeadway: number,
  minGap: number,
  leaderDecelCap: number = MAX_DECEL_COMFY,
): number => {
  const dv = Math.abs(selfSpeed - leaderSpeed)
  // Gipps' braking component: how much extra gap to leave when
  // closing on a slower (or stationary) leader.
  const brakingComponent = (selfSpeed * dv) / (2 * leaderDecelCap)
  return selfSpeed * timeHeadway + minGap + brakingComponent
}

/**
 * The speed a follower may still have and still keep the safe gap.
 *
 * This is the **inverse** of `safeGapGipps`: the follower may hold the
 * speed `v` while the gap it has is at least
 *
 *     v * timeHeadway + minGap + v * (v - leaderSpeed) / (2 * decelCap)
 *
 * and solving that inequality for `v` gives the expression below. The
 * two are therefore consistent by construction — there is no second set
 * of parameters to keep in step.
 *
 * Why the model needs it: the gap alone does not tell a follower what
 * to do. Clamping its target to the leader's **current** speed means a
 * leader that brakes hard leaves the follower at that speed, and the
 * follower — whose own braking is capped at `MAX_DECEL_COMFY` — closes
 * the remaining gap and hits it. Measured 2026-10-25 on the 5 x 5 grid:
 * 1364 frames of a follower at 8.97 m/s inside a leader at 2.49 m/s.
 * This is the speed from which the follower can still brake down in
 * time, so it slows **before** the gap is gone.
 *
 * @param leaderSpeed  m/s, the vehicle ahead's current speed
 * @param gap          m, bumper-to-bumper distance to the leader
 * @param timeHeadway  s, desired following time
 * @param minGap       m, hard bumper-to-bumper floor
 * @param decelCap     m/s², the follower's own braking capability
 * @returns the safe speed in m/s
 */
export const safeSpeedGipps = (
  leaderSpeed: number,
  gap: number,
  timeHeadway: number,
  minGap: number,
  decelCap: number = MAX_DECEL_COMFY,
): number => {
  const net = Math.max(0, gap - minGap)
  const k = 2 * decelCap * timeHeadway - leaderSpeed
  return (-k + Math.sqrt(k * k + 8 * decelCap * net)) / 2
}

/**
 * Hysteresis state machine.
 *
 * Returns the next observable `status` given the current observable
 * status, the desired status (controller's intent), and the current
 * speed. The hysteresis rule prevents flicker around the threshold:
 *
 *   - Entering `driving` requires speed >= DRIVING_SPEED_THRESHOLD
 *     AND desiredStatus != 'crashed'. Without this, a vehicle that
 *     just began accelerating would flicker back to waiting if its
 *     speed dipped briefly under 0.5 m/s.
 *   - Entering `waiting` is a one-way trap: once waiting, only
 *     desiredStatus='driving' AND speed >= WAITING_SPEED_THRESHOLD
 *     can lift it. Below WAITING_SPEED_THRESHOLD the vehicle stays
 *     waiting even if the controller wanted it to drive.
 *   - `crashed` is sticky: nothing in tick can un-crash a vehicle
 *     (only `worldStore.reset` clears the flag).
 *
 * `desiredStatus` is the *controller's* intent — set in tick.ts by
 * the controller layer (red-light approach → 'waiting', green light
 * → 'driving'). The status update happens separately so the UI shows
 * the user's intended state, not just the speed-derived one.
 */
export const statusFromHysteresis = (
  current: VehicleStatus,
  desired: VehicleStatus,
  speed: number,
): VehicleStatus => {
  // Crashed is sticky — controller can't un-crash a vehicle mid-tick.
  if (current === 'crashed') return 'crashed'

  // Controller asked for crash; honour it.
  if (desired === 'crashed') return 'crashed'

  if (desired === 'waiting') {
    // Controller wants to wait — honour the request unless we're
    // already moving fast enough that waiting doesn't make sense
    // (this case is rare: it can happen if the controller flipped
    // intent during a single tick while the vehicle was already
    // cruising). Default: trust the controller.
    return 'waiting'
  }

  // desired == 'driving'. Now decide based on speed.
  if (current === 'driving') {
    // Stay driving unless speed has dropped to the WAITING threshold
    // (lower than DRIVING so we don't bounce).
    if (speed < WAITING_SPEED_THRESHOLD) return 'waiting'
    return 'driving'
  }

  // current === 'waiting'. Promote only when speed has crossed the
  // higher DRIVING threshold (entry vs exit asymmetry = hysteresis).
  if (speed >= DRIVING_SPEED_THRESHOLD) return 'driving'
  return 'waiting'
}

/**
 * Clamp a desired speed to the per-type
 * dynamics ceiling. Used by tick.ts to make sure `v.targetSpeed`
 * never asks for more than the vehicle can physically deliver. This
 * replaces the previous single-MAX_ACCEL clamp which ignored vehicle
 * type.
 */
export const clampTargetSpeedByType = (
  desired: number,
  type: VehicleType,
  roadSpeedLimit: number,
): number => {
  const dyn = VEHICLE_DYN[type]
  // Heuristic: a vehicle's practical top speed in this simulator is
  // roughly its road's speed limit; we cap to that and also enforce
  // a hard ceiling of 35 m/s (≈ 126 km/h) via MAX_SPEED.
  return Math.max(0, Math.min(desired, roadSpeedLimit))
}

/**
 * Compute the new speed for the hand-rolled (physics-free
 * fallback) tick path. Replaces the previous `v.speed += 3.5*dt`
 * one-liner with a per-type ramp.
 *
 * It uses the same `rampSpeed` the Rapier path uses, so the two paths
 * do not disagree about how a vehicle accelerates or comes to a stop.
 */
export const handRolledStep = (vehicle: Vehicle, dt: number): number =>
  rampSpeed(vehicle.speed, vehicle.targetSpeed, dt, vehicle.type)
