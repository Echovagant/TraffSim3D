import type { LaneId } from '../value-objects/LaneId'
import type { Position } from '../value-objects/Position'
import type { Speed } from '../value-objects/Speed'

export type VehicleType = 'car' | 'truck' | 'bus'
export type VehicleStatus = 'driving' | 'waiting' | 'crashed'

export interface Vehicle {
  readonly id: string
  type: VehicleType
  /**
   * World-space position. **Derived** from (roadId, laneIndex, s) — the
   * simulator updates `s` and then writes back the corresponding
   * position/heading. Kept on the entity so the renderer (and the
   * inspector) can read a single world point without re-deriving.
   */
  position: Position
  /** World-space heading in radians. Derived from lane direction. */
  heading: number
  /** Current speed in m/s. */
  speed: number
  /** Desired / target speed (m/s). Normally the road's speed limit. */
  targetSpeed: number
  /** Which road this vehicle is currently on. */
  roadId: string
  /** Lane index 0..N-1 on that road (see laneGeometry.ts for the convention). */
  laneIndex: number
  /**
   * Distance along the lane from the lane's start, in metres. For
   * forward lanes the start is `road.startNode`; for backward lanes
   * it's `road.endNode`. Wraps at `roadLength` so a single car can
   * loop its road forever.
   */
  s: number
  /** Human-friendly label that mirrors (roadId, laneIndex). */
  lane: LaneId
  color: string // hex string, e.g. '#3a86ff'
  status: VehicleStatus
  /**
   * Intent-based state, separate from the observable
   * `status`. `desiredStatus` is what the *controller* wants (e.g. a
   * red-light approach means `desiredStatus='waiting'` while speed is
   * still > 0). The hysteresis in tick.ts promotes `desiredStatus` to
   * `status` only after the speed has crossed the threshold (and held
   * there for at least one tick). This eliminates the flicker that the
   * old `speed < 0.5 → waiting` rule produced at startup.
   *
   * Defaults to the same value as `status` for entities loaded from a
   * saved scene that predates this field — see sceneSerializer v6
   * migration.
   */
  desiredStatus: VehicleStatus
  /**
   * Simulation-time (seconds since the world was last reset) at which
   * the vehicle first crossed into an intersection box. `null` when
   * the vehicle is not currently inside any intersection. Used by the
   * cross-road emergency-brake logic to break the "both green, both
   * stopped in the middle" deadlock — the car that entered first has
   * right-of-way.
   */
  enteredIntersectionAt: number | null
  /**
   * Lane change: if non-null, vehicle is mid lane-change
   * to this lane. Tick advances the lateral position and clears this
   * when the body reaches the target lane. Inspector / debugging read
   * this to show "changing" state. Set by `requestLaneChange`.
   */
  desiredLaneIndex: number | null
  /**
   * Simulation time at which the current lane-change started. Used by
   * tick to abort stuck lane-changes after a timeout (5s). Set by
   * `requestLaneChange`; cleared on completion or timeout.
   */
  laneChangeStartedAt: number | null
  /**
   * simTime at which the vehicle was spawned. Used by the
   * OOB cleanup in tick.ts to skip vehicles that have just been
   * spawned (their Rapier body may take a frame to align with s=0).
   * Pre-existing vehicles default to 0 (treated as "infinitely old").
   */
  spawnedAt: number
  /**
   * The turn IN PROGRESS (the pivot→arc model change, ADR-012), or
   * `undefined` when the vehicle is on its lane.
   *
   * `roadId` / `laneIndex` / `s` / `heading` are ALREADY the
   * destination lane's values — set the moment the turn starts, so
   * every consumer (constraints, yield, selection) sees the road the
   * vehicle is committed to. The position/heading meanwhile come from
   * the arc: `dist` metres along the Bézier from the pose the vehicle
   * had at the travel end to the lane's entry pose. While `turn` is
   * set, tick advances `dist` by the speed, takes the pose from the
   * arc, and exempts the vehicle from the lane guards and Pure
   * Pursuit (the heading is the arc's tangent, not the lane's).
   */
  turn?: {
    /** The destination lane's entry arc length. */
    s: number
    /** The destination lane's entry heading. */
    heading: number
    /** The Bézier control points (start, corner, entry). */
    p0x: number
    p0z: number
    p1x: number
    p1z: number
    p2x: number
    p2z: number
    /** The arc's length in metres. */
    length: number
    /** The distance driven along the arc so far. */
    dist: number
  }
}
