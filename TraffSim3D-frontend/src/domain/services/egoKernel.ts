// src/domain/services/egoKernel.ts
//
// Plan 071: the L1 ego-kinematics kernel — a 1:1 port of the Python
// training sim's ego model (`TraffSim3D-backend/app/apps/rl/sim_core.py`).
//
// It is shared by two consumers:
//   - the contract mirror (`@application/services/simCoreMirror`), and
//   - the **product replay path** (`@application/services/tick`), which
//     needs the same speed integration so a PPO policy trained in Python
//     drives identically in the browser.
//
// Six porting rules keep the two implementations bit-comparable:
//   1. The Pure Pursuit denominator is the CONSTANT `LOOKAHEAD_DISTANCE`
//      (8.0 m), not the distance to the target. That is Python's
//      semantics — cross-language difference #3 lives here.
//   2. Update order is speed → heading → position, and `steer` is
//      computed from the state *before* the update.
//   3. `wrapPi` must reproduce CPython's float-modulo algorithm: JS `%` is
//      a truncated remainder (= `fmod`), and CPython's `%` is that plus ONE
//      conditional add of the modulus — performed only when the remainder is
//      NON-ZERO and its sign differs from the modulus's. The naive "always
//      add 2*pi and re-mod" spelling is NOT equivalent: it is exact only for
//      `|alpha| > pi`, and inside the reachable angle-error domain it
//      disagrees with Python — usually in the last bit, but by up to ~1e-10
//      absolute near the +-pi wrap boundary (measured, 200k-sample sweep).
//   4. Statement order mirrors Python's, so the floating-point rounding
//      sequence matches. `3.0 * 0.1` is 0.30000000000000004, so
//      `speed + accel * dt` and `speed + accel * 0.1` can differ in the
//      last bits — and the contract asserts bit-exact equality.
//   5. The action is rounded to float32 BEFORE it is clipped and scaled.
//      Python never sees a float64 action: `apps/rl/env.py` does
//      `action.astype(np.float32)` and the contract test does
//      `np.asarray(action, dtype=np.float32)`. `Math.fround` is IEEE
//      round-to-nearest-even to binary32 — the same rounding `np.float32`
//      applies. The policy's output layer has no tanh, so real actions are
//      arbitrary float64 values and skipping this cast moves the trajectory
//      by ~1e-10 per step.
//   6. The two clamp flavours are NOT interchangeable. The action and the
//      steer are clipped with numpy's `np.clip`, which **propagates NaN**.
//      The speed is clamped with Python's `max(lo, min(hi, v))`, which
//      **collapses NaN to the upper bound** (CPython's `min` keeps the
//      first argument when the comparison is False). A NaN action — a
//      corrupt checkpoint whose forward pass produced NaN — therefore
//      saturates the ego at SPEED_LIMIT in Python, and must do the same
//      here; a NaN-propagating speed clamp would poison the browser
//      replay's position with NaN instead.
//   7. The Pure Pursuit **alpha sign** is the textbook one:
//      `alpha = atan2(dz, dx) - heading` (the angle from the heading to the
//      target), so the steer turns **towards** the target. Python computed
//      the opposite until Plan 076 T11 (2026-10-21), which made the trained
//      ego steer away from its target — invisible while every scenario put
//      the target straight ahead. The contract's `steer_*` vectors keep this
//      dimension covered; see `pythonSteer`'s docstring.
//
// The bit-exactness asserted against Python holds for V8's `Math.sin` /
// `Math.cos` / `Math.atan2`, which ECMA-262 leaves implementation-approximated
// — a deliberate platform assumption, not a language guarantee.
//
// Pure functions only: no DOM, no Three.js, no Rapier.

import { PYTHON_SIM } from '@shared/constants/simulation'

/** Ego pose + speed, in the Python sim's coordinate convention. */
export interface EgoState {
  x: number
  z: number
  heading: number
  speed: number
}

/**
 * numpy's `np.clip(v, lo, hi)`.
 *
 * numpy **propagates NaN**: `NaN < lo` and `NaN > hi` are both false, so
 * neither bound fires and the NaN survives. Python clips the action and
 * the steer with `np.clip`, so this is the correct helper for both.
 *
 * NOT interchangeable with `pythonMaxMin` below — see porting rule 6.
 */
const npClip = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/**
 * Python's `max(lo, min(hi, v))`.
 *
 * CPython's `min(a, b)` keeps `a` when the comparison is False, so
 * `min(16.67, NaN)` is `16.67` (because `NaN < 16.67` is False), and
 * `max(0.0, 16.67)` is `16.67`. A NaN argument therefore collapses to the
 * UPPER bound — unlike numpy's `np.clip`, which propagates it.
 *
 * Python's speed update is exactly this expression
 * (`max(0.0, min(SPEED_LIMIT, speed + accel_cmd * DT))`), so the speed
 * clamp must use this helper. For every finite value the result is
 * identical to `npClip`; only NaN differs.
 */
const pythonMaxMin = (v: number, lo: number, hi: number): number => {
  const upper = v < hi ? v : hi
  return upper > lo ? upper : lo
}

/**
 * Wrap an angle into `[-pi, pi]` the way CPython's float `%` does.
 *
 * Python: `(alpha + math.pi) % (2 * math.pi) - math.pi`. CPython's `%` is
 * `fmod` plus ONE conditional add of the modulus — only when the remainder
 * is non-zero and its sign differs from the modulus's. JS `%` is the
 * truncated remainder alone (`fmod`), so that conditional add is this
 * function's job; a zero remainder must never be shifted to `2 * pi`.
 *
 * Any other spelling (e.g. always adding `2 * pi` and re-modding) adds a
 * rounding step and stops being bit-identical to Python for some angles.
 */
const wrapPi = (a: number): number => {
  const period = 2 * Math.PI
  const remainder = (a + Math.PI) % period
  return (remainder < 0 ? remainder + period : remainder) - Math.PI
}

/**
 * One speed-integration step, Python semantics:
 *
 *   accel_cmd = clip(np.float32(action0), -1, 1) * 3.0
 *   speed     = clip(speed + accel_cmd * dt, 0, 16.67)
 *
 * The action is rounded to float32 and then clipped — the Python sim does
 * both (`np.float32` cast upstream, `np.clip` here), and the policy's output
 * layer has no tanh, so raw actions can exceed [-1, 1].
 *
 * The two clips use **different** helpers on purpose: the action clip is
 * numpy's `np.clip` (NaN propagates), the speed clamp is Python's
 * `max(lo, min(hi, v))` (NaN collapses to `hi`). See porting rule 6.
 */
export const pythonSpeedStep = (speed: number, action0: number, dt: number): number => {
  const accelCmd = npClip(Math.fround(action0), -1, 1) * PYTHON_SIM.ACCEL_SCALE
  return pythonMaxMin(speed + accelCmd * dt, 0, PYTHON_SIM.SPEED_LIMIT)
}

/**
 * Pure Pursuit steering, Python semantics:
 *
 *   alpha = wrapPi(atan2(dz, dx) - heading)
 *   steer = atan2(2 * wheelbase * sin(alpha), LOOKAHEAD_DISTANCE)
 *   steer = clip(steer, -MAX_STEER, MAX_STEER)
 *
 * `target` is `[x, z]` in world space.
 *
 * The alpha sign is the textbook one (Coulter 1992): `alpha` is the angle
 * **from the vehicle's heading to the target direction**, so
 * `sin(alpha) > 0` means the target is ahead and to the left, and the steer
 * turns **towards** it.
 *
 * It was the other way round until Plan 076 T11 (2026-10-21): the sim
 * computed `alpha = heading - atan2(dz, dx)`, and the steering law is only
 * correct for the textbook sign — so the ego steered **away** from its
 * target. It was invisible for years because every scenario put the target
 * straight ahead (`alpha ≈ 0` ⇒ `steer ≡ 0` ⇒ the sign did not matter).
 * Measured before/after (120 steps, full throttle, target 25.7 m away):
 * the distance to the target went 25.7 → **150.9 m** with the old sign and
 * 25.7 → **5.8 m** with this one.
 *
 * ⇒ The contract's `steer_*` vectors exist to keep this dimension covered:
 * a vector that never steers cannot see a sign error.
 *
 * NOTE: this is the **training sim's** convention, and this kernel is its
 * 1:1 port. The browser's *lane-following* controller
 * (`src/domain/services/purePursuit.ts`) computes an alpha with the opposite
 * sign **on purpose** — there the steering is handed to Rapier as an angular
 * velocity about the **y axis**, whose sense is opposite to this plane's
 * `heading`. Do not "fix" one to match the other.
 */
export const pythonSteer = (ego: EgoState, target: readonly [number, number]): number => {
  const dx = target[0] - ego.x
  const dz = target[1] - ego.z
  const targetAngle = Math.atan2(dz, dx)
  const alpha = wrapPi(targetAngle - ego.heading)
  const steer = Math.atan2(
    2 * PYTHON_SIM.EGO_WHEELBASE * Math.sin(alpha),
    PYTHON_SIM.LOOKAHEAD_DISTANCE,
  )
  // Python: `np.clip(steer, -MAX_STEER, MAX_STEER)` — numpy semantics, so a
  // NaN steer propagates (the speed clamp is the opposite; see above).
  return npClip(steer, -PYTHON_SIM.MAX_STEER, PYTHON_SIM.MAX_STEER)
}

/**
 * One full ego step, Python semantics (speed → heading → position).
 *
 * `steer` is derived from the **pre-update** state, matching Python's
 * statement order. The position uses the **updated** speed and heading,
 * again matching Python.
 *
 * The speed update is `pythonSpeedStep` verbatim — the two must stay one
 * operation sequence, so the shared function is the single place to change.
 *
 * `steerResidual` is Plan 076 T12's **steering residual**: a correction the
 * policy applies **on top of** the scripted Pure Pursuit steer, scaled by
 * `MAX_STEER` by the caller and clipped together with it (Python:
 * `steer = clip(clip(steer) + residual)`). The default is `0` — no
 * correction — which keeps every pre-T12 caller bit-identical: the
 * product replay path only uses `pythonSpeedStep`, and the contract mirror
 * passes the vector's residual.
 */
export const integrateEgo = (
  ego: EgoState,
  action0: number,
  dt: number,
  target: readonly [number, number],
  steerResidual = 0,
): EgoState => {
  const speed = pythonSpeedStep(ego.speed, action0, dt)
  const steer = npClip(
    pythonSteer(ego, target) + steerResidual,
    -PYTHON_SIM.MAX_STEER,
    PYTHON_SIM.MAX_STEER,
  )
  const heading = ego.heading + steer * dt
  return {
    x: ego.x + speed * Math.cos(heading) * dt,
    z: ego.z + speed * Math.sin(heading) * dt,
    heading,
    speed,
  }
}
