// src/application/services/oobCleanup.ts
//
// Out-of-bounds cleanup. Called once per tick by tick.ts; the tests
// drive it directly with fake deps.
//
// WHAT CHANGED (and why)
//
// The old implementation **teleported** a vehicle that had left the
// road network back to `s = 0` of its lane, in the same frame it was
// detected: the car disappeared from where it was and re-appeared at
// the road start with speed 0 — no deceleration, no explanation, no
// record. The observer saw the car blink back to the origin.
//
// Now a vehicle that has left the network enters an **exit phase**:
//
//   1. it keeps rolling and is braked down under the simulation's own
//      stop deceleration (`MAX_DECEL` — the same constant the speed
//      ramp uses), so the departure is a *process*, not a cut;
//   2. when it has come to a stop (or has rolled far enough / long
//      enough) it is placed back at the start of its lane;
//   3. every entry into the exit phase and every reset is recorded in
//      an event log (`getOobEvents`) and announced on the console, so
//      the reset is never silent.
//
// The exit state lives in a `WeakMap` keyed by the vehicle object:
// when the vehicle is dropped, its exit state goes with it. There is
// no ghost state and nothing to clean up.
//
// The two skip conditions of the old code are kept: a vehicle that is
// mid lane-change (its position is intentionally off-centre) and a
// vehicle that was spawned less than a second ago (its body may not
// have aligned yet) are not judged. A third one was added: the
// vehicle the editor is currently dragging is under the user's
// control, not the simulation's — it must not be teleported away
// while the user is still moving it.

import type { Vehicle } from '@domain/entities/Vehicle'
import type { Road } from '@domain/entities/Road'
import { lanePoint } from '@domain/services/laneGeometry'
import { MAX_DECEL, OUT_OF_BOUNDS_M } from '@shared/constants/simulation'

/** Speed (m/s) at or below which a leaving vehicle counts as stopped. */
export const OOB_EXIT_STOP_SPEED_MS = 0.05

/** Hard cap on the exit phase (s). The vehicle is placed back after this. */
export const OOB_EXIT_MAX_SECONDS = 3

/** How far a leaving vehicle may roll out of the network (m). */
export const OOB_EXIT_MAX_DISTANCE_M = 25

export type OobEventKind = 'exit-start' | 'reset' | 'orphan-removed'

/** Why the exit phase ended. */
export type OobResetReason = 'stopped' | 'distance' | 'timeout'

export interface OobEvent {
  kind: OobEventKind
  vehicleId: string
  /** Sim time (s) the event happened at. */
  simTime: number
  /** Metres between the vehicle and its lane geometry. */
  distance: number
  /** Speed (m/s) the vehicle carried at that moment. */
  speed: number
  /** Human-readable reason. */
  reason: string
}

/** How many events the log keeps. */
const MAX_EVENTS = 64

const events: OobEvent[] = []
const listeners = new Set<(event: OobEvent) => void>()

const emit = (event: OobEvent): void => {
  events.push(event)
  if (events.length > MAX_EVENTS) events.shift()
  for (const listener of listeners) listener(event)
}

/** The OOB events of this session, oldest first. */
export const getOobEvents = (): readonly OobEvent[] => events

/** Forget the recorded events (scene reset / test setup). */
export const clearOobEvents = (): void => {
  events.length = 0
}

/**
 * Subscribe to the OOB events. Returns the unsubscribe function.
 *
 * The UI uses this to show *why* a vehicle was put back on the road
 * instead of letting it happen silently.
 */
export const subscribeOobEvents = (listener: (event: OobEvent) => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * The exit phase of one vehicle.
 *
 * `rolled` is the distance the vehicle covered while it was leaving —
 * it is what bounds the exit phase when the vehicle never comes to a
 * full stop (e.g. it is being pushed along by a collision).
 */
interface OobExitState {
  /** Sim time the vehicle entered the exit phase. */
  enteredAt: number
  /** Speed (m/s) at that moment. */
  startSpeed: number
  /** Distance (m) from the lane geometry at that moment. */
  startDistance: number
  /** Distance (m) rolled since the entry. */
  rolled: number
  lastX: number
  lastZ: number
}

/** Exit state per vehicle. Keyed by the object → no leaks, no ghosts. */
const exits = new WeakMap<Vehicle, OobExitState>()

/**
 * Is this vehicle on its way out of the network?
 *
 * The tick asks this before it hands the vehicle the road's speed
 * limit: a leaving vehicle brakes to a stop instead, and it is not a
 * leader for the cars behind it.
 */
export const isOobExiting = (v: Vehicle): boolean => exits.has(v)

export interface TickOobDeps {
  /** Look up a road by id; returns undefined if missing. */
  getRoad: (roadId: string) => Road | undefined
  /** Hard-delete a vehicle (called when road is missing). */
  removeVehicle: (id: string) => void
  /** Snap Rapier body to (position, heading) for a respawned vehicle. */
  snapVehicle: (id: string, position: { x: number; y: number; z: number }, heading: number) => void
  /**
   * The vehicle the editor is currently dragging, if any. A dragged
   * vehicle is *intentionally* off its lane — it must not be judged
   * (and must not be teleported away under the user's cursor).
   */
  draggingId?: () => string | null
}

/**
 * Put a vehicle back at the start of its lane.
 *
 * This is the **end** of the exit phase: the vehicle has already come
 * to a stop out there, so the placement is the last step of a visible
 * process, not a cut.
 */
const placeAtRoadStart = (v: Vehicle, road: Road, deps: TickOobDeps): void => {
  v.s = 0
  v.speed = 0
  v.targetSpeed = 0
  const lp = lanePoint(road, v.laneIndex, 0)
  v.position = { x: lp.position.x, y: lp.position.y, z: lp.position.z }
  v.heading = lp.heading
  deps.snapVehicle(
    v.id,
    { x: lp.position.x, y: lp.position.y ?? v.position.y, z: lp.position.z },
    lp.heading,
  )
}

/**
 * Advance the exit phase of one vehicle by one tick.
 *
 * The vehicle keeps rolling while it brakes; the phase ends when it
 * has come to a stop, when it has rolled far enough, or when it has
 * taken too long (the last one is the safety net for a vehicle that
 * never comes to a stop).
 */
const advanceExitPhase = (
  v: Vehicle,
  exit: OobExitState,
  road: Road,
  deps: TickOobDeps,
  simTime: number,
  dt: number,
): void => {
  // How far did it roll while it was leaving?
  const dx = v.position.x - exit.lastX
  const dz = v.position.z - exit.lastZ
  exit.rolled += Math.hypot(dx, dz)
  exit.lastX = v.position.x
  exit.lastZ = v.position.z

  // Brake under the simulation's own stop deceleration. In the physics
  // path the rigid body does the braking (the tick commands a target
  // speed of 0 for a leaving vehicle) and this line is overwritten by
  // the pose refresh on the next frame; here it keeps the entity
  // honest for a vehicle that has no body to integrate.
  if (v.speed > 0) {
    v.speed = Math.max(0, v.speed - MAX_DECEL * dt)
  }

  const elapsed = simTime - exit.enteredAt
  const stopped = v.speed <= OOB_EXIT_STOP_SPEED_MS
  const tooFar = exit.rolled >= OOB_EXIT_MAX_DISTANCE_M
  const timedOut = elapsed >= OOB_EXIT_MAX_SECONDS
  if (!stopped && !tooFar && !timedOut) return

  const reason: OobResetReason = stopped ? 'stopped' : tooFar ? 'distance' : 'timeout'
  // The state is dropped BEFORE the reset: the vehicle is back on the
  // road, it is not leaving any more (no ghost state).
  exits.delete(v)
  placeAtRoadStart(v, road, deps)
  emit({
    kind: 'reset',
    vehicleId: v.id,
    simTime,
    distance: exit.startDistance,
    speed: v.speed,
    reason: `back at the start of ${road.id} lane ${v.laneIndex} after leaving the network (${reason})`,
  })
}

/**
 * Per-tick out-of-bounds cleanup.
 *
 * @param dt seconds since the last tick — the brake rate needs it.
 */
export const tickOobCleanup = (
  deps: TickOobDeps,
  vehicles: ReadonlyArray<Vehicle>,
  simTime: number,
  dt: number,
): void => {
  for (const v of vehicles) {
    const road = deps.getRoad(v.roadId)
    if (!road) {
      // The road is gone (a scene load replaced the network under the
      // vehicle): there is nothing left to drive on.
      exits.delete(v)
      deps.removeVehicle(v.id)
      emit({
        kind: 'orphan-removed',
        vehicleId: v.id,
        simTime,
        distance: 0,
        speed: v.speed,
        reason: 'its road no longer exists — the vehicle was removed',
      })
      continue
    }

    // Already leaving: keep braking, and put it back when it is done.
    const exit = exits.get(v)
    if (exit) {
      advanceExitPhase(v, exit, road, deps, simTime, dt)
      continue
    }

    // Skip mid lane-change — position is intentionally off-center.
    if (v.desiredLaneIndex !== null) continue
    // Skip recently spawned (1s grace — Rapier body may not yet have aligned).
    if (simTime - v.spawnedAt < 1.0) continue
    // Skip the vehicle the editor is dragging — the user is moving it.
    if (deps.draggingId?.() === v.id) continue

    const expected = lanePoint(road, v.laneIndex, v.s)
    const dx = v.position.x - expected.position.x
    const dz = v.position.z - expected.position.z
    const distance = Math.hypot(dx, dz)

    if (distance <= OUT_OF_BOUNDS_M) continue

    // The vehicle has left the network: it starts braking now, and it
    // is put back at the road start once it has come to a stop.
    exits.set(v, {
      enteredAt: simTime,
      startSpeed: v.speed,
      startDistance: distance,
      rolled: 0,
      lastX: v.position.x,
      lastZ: v.position.z,
    })
    v.targetSpeed = 0
    emit({
      kind: 'exit-start',
      vehicleId: v.id,
      simTime,
      distance,
      speed: v.speed,
      reason: `left the network (${distance.toFixed(1)} m off its lane) — braking to a stop`,
    })
  }
}
