/** Target frame budget for M1. Anything below this fails the perf gate. */
export const M1_MIN_FPS = 30;
/** Default render scale (device pixel ratio cap). */
export const MAX_DPR = 2;
/** Default intersection cycle: 30s green, 3s yellow, 30s red per axis. */
export const DEFAULT_CYCLE_SECONDS = 63;

/**
 * Plan B — visual constants shared between the scene builder and the
 * domain tick step. Keeping them here means RoadMesh, RoadMarkings, the
 * traffic-light phase bar, and the trail length all agree without
 * each importing from the other.
 */
/**
 * Width of a single lane in world units. ~3.5m matches real-world lane
 * width; a 4-lane road is then 14u wide. The previous `ROAD_WIDTH = 4`
 * was the *total* road width and gave each lane only 1u, narrower than
 * the car body (2u) — vehicles visibly straddled multiple lanes.
 */
export const ROAD_LANE_WIDTH = 3.5;
/** Number of historical positions kept per vehicle for the trail line. 60 frames ≈ 1s at 60fps. */
export const TRAIL_LENGTH = 60;
/** Per-phase duration in seconds for the default cycle. Used by the phase-countdown bar. */
export const PHASE_DURATIONS = {
  green: 30,
  yellow: 3,
  red: DEFAULT_CYCLE_SECONDS - 33,  // 30s for the default 63s cycle
} as const;

// ===== M1.5 — basic traffic physics (no Rapier) =====
//
// All of these are intentionally simple hand-rolled kinematics; M2
// replaces this block with Rapier-driven simulation. Keeping the knobs
// in one place makes the swap-out mechanical: tick.ts reads from here,
// nothing else does.

/** Maximum forward acceleration in m/s² (≈ 0–100 km/h in 8s, gentle). */
export const MAX_ACCEL = 3.5;
/**
 * Maximum braking deceleration in m/s² (≈ 1.0 g, hard-but-not-panic).
 * Real-world emergency braking with ABS is ~9–10 m/s², so this is
 * already a hard brake — drivers don't go harder than this. Used as
 * the normal stop-at-red-light decel ceiling.
 */
export const MAX_DECEL = 10.0;
/** Time-headway target in seconds for car-following. Newell's rule of thumb. */
export const TIME_HEADWAY = 1.5;
/** Minimum bumper-to-bumper gap in world units. */
export const MIN_GAP = 2.0;
/** Hard speed ceiling so user-set speeds never run away. */
export const MAX_SPEED = 35;  // m/s ≈ 126 km/h
/** Stop line offset from intersection center, in world units along the road. */
export const STOP_LINE_DISTANCE = 5.0;
/**
 * How early the traffic-light brake kicks in, on top of the physical
 * braking distance `v²/(2a)`. Models the "I saw the light and
 * started slowing well before I had to" human behaviour, and gives a
 * safety margin so cars don't overshoot the stop line when the
 * physics is borderline.
 */
export const STOP_LINE_BUFFER = 4.0;

// ===== M2-A — Rapier body specs =====
//
// Per-type body spec for Rapier rigid bodies. Length/width are in
// world units (metres). Mass is in kg. Inertia is derived from
// RapierBodySpec.ts (cube inertia tensor) at register-time.
//
// Note: M1 used a hand-tuned COLLISION_RADIUS (car=2.6, truck=3.6,
// bus=5.0) for its distance check. The Rapier collider uses the
// actual body dimensions (length/width), which give a more faithful
// footprint. M1's NUDGE_SPEED / NUDGE_REVERSE / NUDGE_REVERSE_SPEED
// are deleted with applyIntersectionNudge (M2-A doesn't need a
// reverse-nudge step — Rapier collision response handles it).

export const VEHICLE_BODY_SPEC: Record<
  'car' | 'truck' | 'bus',
  { length: number; width: number; mass: number }
> = {
  car:   { length: 4.2, width: 1.8, mass: 1500 },
  truck: { length: 6.5, width: 2.2, mass: 4500 },
  bus:   { length: 9.0, width: 2.5, mass: 8000 },
};
