/** Target frame budget. Anything below this fails the perf gate. */
export const M1_MIN_FPS = 30
/** Default render scale (device pixel ratio cap). */
export const MAX_DPR = 2

/**
 * Visual constants shared between the scene builder and the
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
export const ROAD_LANE_WIDTH = 3.5
/** Number of historical positions kept per vehicle for the trail line. 60 frames ≈ 1s at 60fps. */
export const TRAIL_LENGTH = 60

// ===== basic traffic physics (no Rapier) =====
//
// All of these are intentionally simple hand-rolled kinematics; the
// Rapier-driven simulation replaces this block. Keeping the knobs
// in one place makes the swap-out mechanical: tick.ts reads from here,
// nothing else does.

/** Maximum forward acceleration in m/s² (≈ 0–100 km/h in 8s, gentle). */
export const MAX_ACCEL = 3.5

// ===== fixed-step physics (frame-rate independence) =====
//
// The physics world does NOT advance one fixed step per rendered frame.
// It **consumes** the wall-clock time it is handed in fixed-size sub-steps
// (`fixedDt`), so the distance a vehicle covers in one wall-clock second
// is the same whether the page renders at 15, 30, 60 or 120 fps.
//
// The three constants below bound that consumption. They are the
// spiral-of-death guard: a long stall (tab switch, GC pause) must not
// turn into an unbounded catch-up that stalls the page even harder.

/**
 * Max number of fixed physics sub-steps one `step()` call may run.
 * 8 sub-steps = 133 ms of simulation per call at the default 1/60 s
 * `fixedDt`. Beyond this the remaining time is dropped rather than
 * repaid, so a stall costs a little simulated time instead of freezing
 * the page.
 */
export const MAX_PHYSICS_SUB_STEPS = 8

/**
 * Max wall-clock time (s) a single `step()` call may consume.
 * 0.25 s = a 4 fps hiccup. Bounds the time jump after a tab switch.
 */
export const MAX_PHYSICS_FRAME_DT = 0.25

/**
 * Max leftover (unconsumed) time the physics accumulator may hold,
 * expressed in sub-steps. Past this the debt is dropped: repaying it
 * later would put the simulation further behind wall clock, not closer.
 */
export const MAX_PHYSICS_PENDING_STEPS = 4

// ===== vehicle dynamics hierarchy =====
//
// Three-tier accel / decel model: `comfy` is what the controller aims
// for under normal conditions; `limit` is the hard cap before
// collision avoidance overrides; `hard_stop` is the panic-brake
// ceiling used only when the controller needs to stop NOW (e.g. on
// contact). All tiers are per-type scaled in VEHICLE_DYN below.
//
// There was originally a single MAX_ACCEL=3.5 and MAX_DECEL=10 used for every
// vehicle regardless of intent, which produced the "instant stop"
// behaviour the user reported in bug 1.

/** Comfortable acceleration in m/s² (≈ 0–100 km/h in 14s). */
export const MAX_ACCEL_COMFY = 2.0
/** Acceleration ceiling before collision-avoidance overrides. */
export const MAX_ACCEL_LIMIT = 3.5
/** Comfortable deceleration in m/s² (≈ 0.25g). */
export const MAX_DECEL_COMFY = 2.5
/** Hard brake ceiling for emergency stops (≈ 0.6g, below ABS). */
export const MAX_DECEL_LIMIT = 6.0
/** Panic brake (e.g. contact response); only used by the safety layer. */
export const HARD_STOP_DECEL = 10.0

// ===== state-machine hysteresis =====
//
// Originally a single 0.5 m/s threshold was used for `waiting ↔ driving`,
// which produced the flicker at startup (speed ∈ [0, 0.5) flipped
// status back to waiting even after the controller had commanded
// throttle). Now the entry and exit thresholds are separated, so a
// vehicle that has begun accelerating won't flicker back to waiting
// just because it briefly dipped under 0.5 m/s during startup.

/** Speed (m/s) above which a vehicle is eligible to enter `driving`. */
export const DRIVING_SPEED_THRESHOLD = 1.0
/** Speed (m/s) below which a vehicle drops back to `waiting`. */
export const WAITING_SPEED_THRESHOLD = 0.3

// ===== spawn-point release =====
//
// Distance past the spawn arc-length at which a spawn point is
// considered "released" — the next spawn is free to reuse it.
export const SPAWN_POINT_RELEASE_DISTANCE = 20

/**
 * Per-type dynamics parameters. Cars are baseline; trucks
 * and buses have lower accel ceilings and lower decel ceilings
 * because they're heavier (the per-type mass in VEHICLE_BODY_SPEC
 * already makes Rapier collision response heavier, but the
 * controller also slows down because the user perceives a truck
 * accelerating briskly as unrealistic).
 */
export const VEHICLE_DYN: Record<'car' | 'truck' | 'bus', { accel: number; decel: number }> = {
  car: { accel: MAX_ACCEL_COMFY, decel: MAX_DECEL_COMFY },
  truck: { accel: MAX_ACCEL_COMFY * 0.7, decel: MAX_DECEL_LIMIT * 0.8 },
  bus: { accel: MAX_ACCEL_COMFY * 0.6, decel: MAX_DECEL_LIMIT * 0.7 },
}

/**
 * Per-type Pure Pursuit parameters.
 * `wheelbase` affects the turning radius (larger = wider turns).
 * `lookahead` affects responsiveness (larger = smoother but slower).
 *
 * Values are empirical — calibration for real-world feel is future work.
 */
export const VEHICLE_PURE_PURSUIT: Record<
  'car' | 'truck' | 'bus',
  { wheelbase: number; lookahead: number }
> = {
  car: { wheelbase: 2.5, lookahead: 8 },
  truck: { wheelbase: 4.0, lookahead: 12 },
  bus: { wheelbase: 3.0, lookahead: 10 },
}

/**
 * Crash impulse threshold (N·s). Below this, a contact is
 * considered a tap (e.g. cars nudging in stop-and-go traffic) and
 * the involved vehicles stay `driving`. Above, both vehicles flip
 * to `crashed`.
 *
 * NOTE: Rapier's `ContactForceEvent` reading is deferred to a follow-up
 * work — currently `ContactEvent.impulse` is always 0, so this
 * threshold is set to 0 to keep the previous "any contact = crash"
 * behaviour. When Rapier contact-force wiring lands, raising this to
 * e.g. 50 N·s becomes a real filter.
 */
export const CRASH_IMPULSE_THRESHOLD = 0
/**
 * Maximum braking deceleration in m/s² (≈ 1.0 g, hard-but-not-panic).
 * Real-world emergency braking with ABS is ~9–10 m/s², so this is
 * already a hard brake — drivers don't go harder than this. Used as
 * the normal stop-at-red-light decel ceiling.
 */
export const MAX_DECEL = 10.0
/** Time-headway target in seconds for car-following. Newell's rule of thumb. */
export const TIME_HEADWAY = 1.5
/** Minimum bumper-to-bumper gap in world units. */
export const MIN_GAP = 2.0
/** Hard speed ceiling so user-set speeds never run away. */
export const MAX_SPEED = 35 // m/s ≈ 126 km/h
/** Stop line offset from intersection center, in world units along the road. */
export const STOP_LINE_DISTANCE = 5.0
/**
 * The clearance an intersection box keeps **beyond** the half-width of the
 * road it crosses (metres).
 *
 * The box has to do two jobs, and both of them are geometric:
 *
 * 1. **Contain the crossing carriageway.** The occupancy rule ("is this
 *    vehicle in the intersection?") tests the box, so a box narrower than
 *    the crossing road can never see a vehicle in the crossing road's
 *    outer lanes. The cross scene's roads are 6 lanes wide (21 m, half-width
 *    10.5 m) and its box used to be 8 m — the outer lanes were outside the
 *    box entirely.
 * 2. **Keep a queued vehicle's NOSE out of the crossing carriageway.** The
 *    stop line sits on the box edge and the stop rule is enforced on the
 *    vehicle's **centre** (`distToStopLine` in `tick.ts`), so a queued
 *    vehicle's nose reaches past the stop line by up to
 *    (half its length - the braking margin) — measured on the cross scene:
 *    a 9 m bus stopped with its nose 0.94 m past the line, a car with its
 *    nose 2.85 m past it.
 *
 * 4.5 m is the **longest vehicle's half-length** (the 9 m bus), so even a
 * vehicle whose centre stops exactly ON the stop line keeps its nose out of
 * the crossing carriageway. The cross scene's box is therefore
 * 10.5 + 4.5 = 15 m.
 *
 * This is the **product's** junction geometry (the per-intersection
 * `intersectionRadius`, sized by the rule in
 * `@domain/services/junctionRadius` — the built-in scenes and the
 * imported maps both go through it). It is NOT the training sim's box:
 * `app/apps/rl/sim_core.py` `INTERSECTION_RADIUS = 8.0` is
 * the contract's constant and mirrors `PYTHON_SIM.INTERSECTION_RADIUS` —
 * the training sim has no lane model, so its 8 m box already contains its
 * whole (7 m wide) carriageway and needs no clearance.
 */
export const INTERSECTION_CLEARANCE_M = 4.5
/**
 * How early the traffic-light brake kicks in, on top of the physical
 * braking distance `v²/(2a)`. Models the "I saw the light and
 * started slowing well before I had to" human behaviour, and gives a
 * safety margin so cars don't overshoot the stop line when the
 * physics is borderline.
 */
export const STOP_LINE_BUFFER = 4.0

// ===== Rapier body specs =====
//
// Per-type body spec for Rapier rigid bodies. Length/width are in
// world units (metres). Mass is in kg. Inertia is derived from
// RapierBodySpec.ts (cube inertia tensor) at register-time.
//
// Note: the hand-rolled path used a hand-tuned COLLISION_RADIUS (car=2.6, truck=3.6,
// bus=5.0) for its distance check. The Rapier collider uses the
// actual body dimensions (length/width), which give a more faithful
// footprint. The NUDGE_SPEED / NUDGE_REVERSE / NUDGE_REVERSE_SPEED
// constants are deleted with applyIntersectionNudge (the Rapier path
// doesn't need a reverse-nudge step — Rapier collision response handles it).

export const VEHICLE_BODY_SPEC: Record<
  'car' | 'truck' | 'bus',
  { length: number; width: number; mass: number }
> = {
  car: { length: 4.2, width: 1.8, mass: 1500 },
  truck: { length: 6.5, width: 2.2, mass: 4500 },
  bus: { length: 9.0, width: 2.5, mass: 8000 },
}

// ===== signal controller constants =====
//
// The phase machine of one light runs
//
//   green → yellow → all-red → red → green
//
// with the durations below. The clearance (yellow + all-red) is the
// "lost time" every phase change costs — 6 s — which is the same number
// the Python training sim charges (`app/apps/rl/sim_core.py`
// `CLEARANCE_SECS`). Keeping the two shapes identical is what makes a
// policy trained in Python transfer to the browser.
//
// The durations match the hand-rolled cycle so the frame-rate gate stays
// reproducible when controllerKind='fixed-cycle'.

/** Green phase (s) — how long an axis is served. */
export const GREEN_PHASE_SECS = 30
/** Yellow clearance (s) — fixed, not shortened. */
export const YELLOW_CLEAR_SECS = 3
/**
 * All-red clearance (s) between the yellow and the red.
 *
 * It is the **second half of the inter-green**: the outgoing axis runs its
 * clearance-yellow, then the junction shows all-red before the other axis
 * may go. The Python training sim charges the pair as one number
 * (`CLEARANCE_SECS = 6.0` in `app/apps/rl/sim_core.py`); the browser
 * implements it as the two phases a real signal runs.
 */
export const ALL_RED_CLEARANCE_SECS = 3
/**
 * Red phase (s) — how long an axis waits before it is served again.
 *
 * It holds the other axis' **whole** turn: its 30 s green plus the 6 s
 * clearance (yellow + all-red). So one light's cycle is 72 s, and the two
 * axis groups of a junction — started half a cycle (36 s) apart — produce
 * the timeline the Python training sim has: 30 s green, a 6 s clearance,
 * 30 s green, a 6 s clearance, … (a 72 s period).
 *
 * A 30 s red would leave the junction with a clearance only before the
 * *second* axis' green (the two machines would be offset by an unequal
 * amount), and the browser's timeline would stop matching the training
 * sim's.
 */
export const RED_PHASE_SECS = 36
/**
 * The tolerance (s) the phase machine uses when it asks "has this phase
 * run out?".
 *
 * A phase's clock is decremented once per tick, so it accumulates a little
 * floating-point error (a few times 1e-11 s over a 30 s phase). Without a
 * tolerance that error decides — at random — whether a phase ends on its
 * tick or one tick late. The two axis groups of a junction then drift a
 * tick apart: the browser's 6 s clearance became 6.00 s **and** 0.03 s, and
 * the training sim's timeline is symmetric (its clock is a step counter, so
 * it never drifts).
 *
 * The tolerance is 1e-6 s: four orders of magnitude below the shortest
 * phase (3 s) and five orders of magnitude above the accumulated error, so
 * it can never cut a real phase short.
 */
export const PHASE_EPSILON_SECS = 1e-6
/**
 * The default intersection cycle (s): 30 green + 3 yellow + 3 all-red +
 * 36 red = **72 s per light**.
 *
 * The two axis groups of a junction start **36 s apart** (half a cycle:
 * 30 green + 3 yellow + 3 all-red), so the "neither axis is green" gap is
 * **6 s** — before *every* green, symmetric — and the repeat period is
 * **72 s**: exactly the shape of the Python training sim's timeline
 * (`app/apps/rl/sim_core.py`: a 30 s phase and `CLEARANCE_SECS = 6.0`).
 */
export const DEFAULT_CYCLE_SECONDS =
  GREEN_PHASE_SECS + YELLOW_CLEAR_SECS + ALL_RED_CLEARANCE_SECS + RED_PHASE_SECS
/** Per-phase duration in seconds for the default cycle. Used by the phase-countdown bar. */
export const PHASE_DURATIONS = {
  green: GREEN_PHASE_SECS,
  yellow: YELLOW_CLEAR_SECS,
  allRed: ALL_RED_CLEARANCE_SECS,
  red: RED_PHASE_SECS,
} as const
/** Max green duration for ActuatedController (s). After this the
 *  light MUST cycle to yellow even with queue. */
export const MAX_GREEN_SECS = 60
/** Green extension step when queue > 0 (s). */
export const GREEN_EXTENSION_STEP = 5
/** Min red duration for ActuatedController (s). Below this the
 *  light won't go green even with empty opposite axis. */
export const MIN_RED_SECS = 10
/**
 * Min green duration (s). Below this the light won't turn yellow — a
 * green must last long enough for a driver to react to it.
 *
 * The symmetric counterpart of `MIN_RED_SECS` — "a red is
 * never shorter than `MIN_RED_SECS`, a green is never shorter than
 * `MIN_GREEN_SECS`". It exists because a controller that shortens the
 * phase on every decision would otherwise *flicker* the light (0.6 s per
 * phase), which no driver can react to.
 *
 * It is a **cross-language contract constant**: the Python training sim
 * owns its own copy (`app/apps/rl/sim_core.py` `MIN_GREEN_SECS`) and the
 * contract compares the two.
 */
export const MIN_GREEN_SECS = 10
/**
 * All-red clearance (s) forced by the intersection's conflict resolution
 * when two perpendicular approaches would show green at the same time
 * (`resolveSignalConflicts` in `application/services/tick.ts`).
 *
 * The forced light goes into the phase machine's **all-red** phase, so the
 * clearance is not a dead end: when it runs out the machine serves the
 * loser a **real red** (`RED_PHASE_SECS`) before it may go green again.
 * That is what stops a desynchronised pair of machines from ping-ponging
 * every 3 s.
 *
 * This is a *different* mechanism from `ALL_RED_SECS` (the clearance the
 * `preempt` / `force_all_red` actions ask for): it is the safety net
 * that keeps the law — "perpendicular approaches never display green
 * simultaneously" — and it is what makes the browser's inter-green
 * longer than a bare yellow.
 */
export const CONFLICT_ALL_RED_SECS = 3
/**
 * The browser's **minimum inter-green** (s): the time between the end of
 * one axis' green and the start of the other axis' green.
 *
 * It is *derived* from the two pieces that implement it, so the number
 * cannot silently drift away from the code:
 *
 * - `YELLOW_CLEAR_SECS` — the clearance-yellow the outgoing axis runs;
 * - `CONFLICT_ALL_RED_SECS` — the all-red the conflict resolution
 *   forces before the other axis may go.
 *
 * During those six seconds no new vehicle gets a green, which is the
 * "lost time" every phase change costs. The Python training sim charges
 * the same 6 s (`app/apps/rl/sim_core.py` `CLEARANCE_SECS`) and the
 * cross-language contract compares the two numbers.
 */
export const MIN_INTER_GREEN_SECS = YELLOW_CLEAR_SECS + CONFLICT_ALL_RED_SECS
/** Default controller kind at app startup. */
export const DEFAULT_CONTROLLER_KIND = 'actuated' as const

// ===== the shared signal-action vocabulary =====
//
// The five action names are the **externally-actionable control surface**
// of the traffic signal.
// The frontend's `RLController` consumes them and the Python training
// sim (`app/apps/rl/sim_core.py`) accepts the same names, so a policy
// trained in Python can drive the browser's signal.
//
// The two sides own **their own copy** of this list — there is no shared
// file both sides read, because a file both sides read would make the
// cross-language assertion vacuous. The contract compares the two copies
// item by item (`tests/contract/test_cross_lang_consistency.py`), so if
// they ever disagree the contract goes red.
//
// The ORDER matters: the contract compares the lists positionally.

/**
 * The five signal actions, in contract order. Mirrors Python's
 * `sim_core.SIGNAL_ACTION_NAMES` exactly (same names, same order).
 */
export const SIGNAL_ACTION_NAMES = [
  'extend_green',
  'shorten_red',
  'preempt',
  'force_all_red',
  'no_op',
] as const

/** One of the five signal action names. */
export type SignalActionName = (typeof SIGNAL_ACTION_NAMES)[number]

/**
 * All-red clearance (s) applied by `preempt` / `force_all_red`.
 * Mirrors Python's `sim_core.ALL_RED_SECS`.
 */
export const ALL_RED_SECS = 3

/**
 * Phase-adjust amount (s) applied by `extend_green` (+5 s) and
 * `shorten_red` (-5 s). Mirrors Python's `sim_core.PHASE_ADJUST_SECS`.
 */
export const PHASE_ADJUST_SECS = 5

// ===== sensor + export constants =====
//
// 16-line default. 32/64 deferred.

/** Per-type LiDAR mount height (m). */
export const LIDAR_MOUNT_HEIGHT: Record<'car' | 'truck' | 'bus', number> = {
  car: 1.5,
  truck: 2.2,
  bus: 2.6,
}

/**
 * The driver's eye height above the road (m).
 *
 * The first-person camera rides at this height. It belongs to the
 * *viewer*, not to the vehicle it rides in — a sedan's roof is lower and
 * a truck's cab is higher, but one height keeps the view comparable
 * between the cars of a scene.
 */
export const DRIVER_EYE_HEIGHT_M = 1.35
/** Horizontal rays. 360 → 90 (4× fewer rays per scan;
 *  mitigation C). 90° 前向扇形 符合主流车载 LiDAR
 *  (Waymo / Mobileye). 32/64-line + 360° 升级留待后续. */
export const LIDAR_HORIZONTAL_RAYS = 90
/** Vertical rays. Default = 16. */
export const LIDAR_VERTICAL_RAYS = 16
/** Max range (m). */
export const LIDAR_MAX_RANGE = 100
/** Gaussian noise stddev (m). */
export const LIDAR_NOISE_STDDEV = 0.02
/** Scan interval in seconds. Default 0.1 = 10Hz throttle.
 *  Combined with LIDAR_HORIZONTAL_RAYS=90 and LIDAR_MAX_ACTIVE_SENSORS=10,
 *  total sensor cost drops from ~205ms/tick to ~5ms/tick. */
export const LIDAR_SCAN_INTERVAL_S = 0.1
/** Max sensors that actually scan per tick. 45 vehicles
 *  registered, but only the first 10 (sorted by vehicleId) scan. Others
 *  keep their last frame. */
export const LIDAR_MAX_ACTIVE_SENSORS = 10
/** Horizontal field of view in degrees. Default 90 (前向扇形).
 *  Future 360 全向升级. */
export const LIDAR_AZIMUTH_DEG = 90

/** Trajectory sample interval (s). 10Hz. */
export const TRAJECTORY_SAMPLE_INTERVAL = 0.1
/** Trajectory buffer cap (rows). 100k ≈ 30min @ 30车 × 10Hz. */
export const TRAJECTORY_BUFFER_CAP = 100_000

// ===== camera sensor constants =====
/** Default offscreen camera resolution. Lower than viewport to
 *  keep the per-frame GPU→CPU pixel-read cost manageable. */
export const CAMERA_DEFAULT_WIDTH = 256
export const CAMERA_DEFAULT_HEIGHT = 192
/** Field of view (degrees). Matches main editor camera. */
export const CAMERA_DEFAULT_FOV = 60
/** Throttle camera capture to 5 Hz to avoid GPU stalls. */
export const CAMERA_SAMPLE_INTERVAL = 0.2

/**
 * 车辆位置距其 (road, lane, s) 几何 > 此值 → respawn.
 * 默认 50m. 道路长 60u, 50 远大于任何合法偏离 (lane change ~3.5m).
 * tick.ts 的 OOB branch 用这个常量决定是否 respawn.
 */
export const OUT_OF_BOUNDS_M = 50

/**
 * Lateral drift threshold (metres). When a vehicle's Rapier position
 * diverges from its expected lane-geometry position by more than this
 * distance (in the XZ plane), tick.ts snaps it back. Pure Pursuit can
 * create a divergent feedback loop when the vehicle is far from the
 * lane: the steering rotates the heading toward the lookahead, but
 * this causes the vehicle to drive perpendicular to the road rather
 * than back toward it. 15m ≈ 4 lane widths — well beyond any legal
 * lane change (~3.5m) but catches divergence before the vehicle
 * leaves the visible area.
 */
export const LATERAL_DRIFT_THRESHOLD_M = 15

/**
 * The share of the movements at a junction that are **turns** rather than
 * going straight on.
 *
 * The rule this replaces was "if a road continues the vehicle's heading,
 * take it" — which is the same as saying no vehicle ever turns where it
 * could go straight. Measured on the 5 x 5 grid (25 junctions, 40
 * segments, 25 vehicles, 90 s): all 29 ninety-degree turns happened at
 * the **edge** of the map and **none** at an interior junction, because
 * an interior junction always has a straight continuation. A traffic
 * simulation whose vehicles never turn at an ordinary crossroads is not
 * modelling a city.
 *
 * 0.25 is the share of movements that are turns in a real street
 * network: through movements dominate, and the rest are right and left
 * turns. The split between right and left is `RIGHT_TURN_SHARE` below.
 *
 * The decision is **deterministic**: it is a hash of the vehicle, the
 * junction and the road it came from, so a run can be reproduced exactly
 * (see `domain/services/roadTransition.ts`). The training side's network
 * environment uses the same two numbers
 * (`app/apps/rl/network_signal_env.py`).
 */
export const TURN_PROBABILITY = 0.25

/**
 * Of the turns, the share that are **right** turns.
 *
 * Right turns outnumber left ones in a street network — left turns are
 * the ones a median or a one-way pair usually forbids, and they are
 * slower, so drivers take them less often.
 */
export const RIGHT_TURN_SHARE = 0.6

/**
 * Constants mirrored from the Python RL sim
 * (`TraffSim3D-backend/app/apps/rl/sim_core.py`).
 *
 * These are the **contract constants** — the cross-language contract
 * (`docs/contracts/sim-snapshot.md`) asserts the Python sim and the TS
 * mirror produce bit-identical trajectories, which only holds when both
 * sides use the same numbers AND the same floating-point operation order.
 *
 * Every value below has a direct counterpart in `sim_core.py`. Change one
 * here and the Python contract test fails.
 */
export const PYTHON_SIM = {
  /** Python: `accel_cmd = clip(action[0], -1, 1) * 3.0` */
  ACCEL_SCALE: 3.0,
  /** Python: `SPEED_LIMIT = 16.67` (m/s) */
  SPEED_LIMIT: 16.67,
  /** Python: `DT = 0.1` (s per sim step) */
  DT: 0.1,
  /**
   * Python: `LOOKAHEAD_DISTANCE = 8.0` — the Pure Pursuit denominator is a
   * **constant**, not the actual distance to the target. That is the
   * Python semantics; do not "fix" it to match the lane-following Pure
   * Pursuit in `purePursuit.ts` (that is cross-language difference #3).
   */
  LOOKAHEAD_DISTANCE: 8.0,
  /** Python: `MAX_STEER = 0.4` (rad) — cross-language difference #4 */
  MAX_STEER: 0.4,
  /** Python: `EGO_WHEELBASE = 2.5` (m) */
  EGO_WHEELBASE: 2.5,
  // --- scene geometry / traffic (used by the contract mirror only) ---
  /** Python: `NS_HALF = 30.0` */
  NS_HALF: 30.0,
  /** Python: `EW_HALF = 30.0` */
  EW_HALF: 30.0,
  /**
   * Python: `INTERSECTION_RADIUS = 8.0`
   *
   * The junction box of the **training sim's** `cross` scene — the box
   * the contract compares, NOT the browser's junction box.
   *
   * The training sim has no lane model: its road is `ROAD_HALF_WIDTH`
   * (3.5 m) wide and its NPCs sit at +/- 3.5 m from the centreline, so
   * an 8 m box already contains the whole carriageway. The defect this
   * number was raised for — a queued vehicle's nose overhanging the
   * crossing road's outer lane — is a property of the **product's** lane
   * model, and it is fixed there (`@domain/services/junctionRadius` →
   * the per-intersection `intersectionRadius`, sized by
   * `INTERSECTION_CLEARANCE_M`).
   *
   * The contract compares the two copies of THIS number, so they stay in
   * lockstep; the product's per-scene radii are a different quantity and
   * are never compared.
   */
  INTERSECTION_RADIUS: 8.0,
  /** Python: `ROUNDABOUT_RADIUS = 10.0` */
  ROUNDABOUT_RADIUS: 10.0,
  /** Python: `NPC_SPEED = 8.0` (m/s) */
  NPC_SPEED: 8.0,
  /** Python: `COLLISION_DISTANCE = 2.0` (m) */
  COLLISION_DISTANCE: 2.0,
  /** Python: `MAX_STEPS_DEFAULT = 200` */
  MAX_STEPS_DEFAULT: 200,
  /** Python: `TrafficLight.cycle_duration = 30.0` (s per phase) */
  LIGHT_CYCLE_SECONDS: 30.0,
  /**
   * Python: `ROAD_HALF_WIDTH = 3.5` (m) — the road's half-width.
   *
   * The scenes carry no lane model; they place their NPCs at a
   * **3.5 m lateral offset** from the road's centreline, so 3.5 m is the
   * half-width the scene itself implies. An ego that leaves it may not score
   * the success any more (the rule is latched for the whole episode).
   *
   * Each side owns its own copy on purpose: a file both sides read would
   * make the contract's comparison of this constant vacuous.
   */
  ROAD_HALF_WIDTH: 3.5,
  /**
   * Python: `SCENE_GOAL_Z` — the **goal line** of each scene (the z the ego
   * has to pass to score the success).
   *
   * The success condition and the progress reward both read
   * this number, so "the goal line" is one thing and not two. The contract
   * compares the two sides' copies item by item.
   */
  SCENE_GOAL_Z: {
    cross: 25.0,
    corridor: 25.0,
    t_junction: -3.0,
    roundabout: 5.0,
    /**
     * Python: `SCENE_GOAL_Z["cross_signalled"]`.
     *
     * The signalled scene's goal line is the `cross` scene's: the two
     * scenes differ in the **light schedule**, not in the route.
     */
    cross_signalled: 25.0,
  },
  /**
   * Python: `sim_core.CROSS_SIGNALLED_CYCLE_SECONDS` — the light cycle of
   * the `cross_signalled` scene (s per phase).
   *
   * The other four scenes run the default 30 s cycle, whose
   * first phase change lands on step 300 — beyond every ego episode, which
   * is why the ego never faces a red light in them. The signalled scene
   * starts the ego's axis **red** and turns it green at step 121 (12 s),
   * inside the episode.
   *
   * Each side owns its own copy on purpose: a file both sides read would
   * make the contract's comparison of this constant vacuous.
   */
  CROSS_SIGNALLED_CYCLE_SECONDS: 12.0,
} as const

/**
 * Back-compat alias: the Python sim speed limit (60 km/h, m/s) that
 * `tick.ts` uses to normalise obs[3] (ego speed). The Python RL sim
 * (`app/apps/rl/sim_core.py`) normalizes obs[3] by this value, and the TS
 * replay must use the SAME denominator or PPO sees "smaller than trained"
 * speeds and drives erratically. Differs from `MAX_SPEED` (126 km/h) which is
 * the TS Rapier / hand-rolled cap.
 *
 * Alias of `PYTHON_SIM.SPEED_LIMIT` — the contract constants have a single
 * source of truth; this name only exists for the pre-contract importers.
 */
export const PYTHON_SIM_SPEED_LIMIT = PYTHON_SIM.SPEED_LIMIT
