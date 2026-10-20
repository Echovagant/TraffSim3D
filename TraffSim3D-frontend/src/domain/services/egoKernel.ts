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
// Five porting rules keep the two implementations bit-comparable:
//   1. The Pure Pursuit denominator is the CONSTANT `LOOKAHEAD_DISTANCE`
//      (8.0 m), not the distance to the target. That is Python's
//      semantics — cross-language difference #3 lives here.
//   2. Update order is speed → heading → position, and `steer` is
//      computed from the state *before* the update.
//   3. `wrapPi` must reproduce CPython's float-modulo algorithm: JS `%` is
//      a truncated remainder (= `fmod`), and CPython's `%` is that plus ONE
//      conditional add of the modulus when the remainder's sign differs.
//      The naive "always add 2*pi and re-mod" spelling is NOT equivalent —
//      it adds a rounding step and drifts 1 ULP away from Python on ~5% of
//      angles.
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

/** Clamp `v` into `[lo, hi]`. Mirrors Python's `max(lo, min(hi, v))`. */
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/**
 * Wrap an angle into `[-pi, pi]` using floor-mod.
 *
 * Python: `(alpha + math.pi) % (2 * math.pi) - math.pi` — `%` there is
 * floor-mod, so the intermediate is never negative. JS `%` keeps the
 * dividend's sign, hence the extra normalisation.
 *
 * The normalisation is a single conditional add of `2 * pi` — the same
 * adjustment CPython's `float.__mod__` performs (`fmod`, then add the
 * modulus when the signs differ). Any other spelling (e.g. always adding
 * `2 * pi` and re-modding) introduces an extra rounding step and stops
 * being bit-identical to Python for some angles.
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
 */
export const pythonSpeedStep = (speed: number, action0: number, dt: number): number => {
  const accelCmd = clamp(Math.fround(action0), -1, 1) * PYTHON_SIM.ACCEL_SCALE
  return clamp(speed + accelCmd * dt, 0, PYTHON_SIM.SPEED_LIMIT)
}

/**
 * Pure Pursuit steering, Python semantics:
 *
 *   alpha = wrapPi(heading - atan2(dz, dx))
 *   steer = atan2(2 * wheelbase * sin(alpha), LOOKAHEAD_DISTANCE)
 *   steer = clip(steer, -MAX_STEER, MAX_STEER)
 *
 * `target` is `[x, z]` in world space.
 */
export const pythonSteer = (ego: EgoState, target: readonly [number, number]): number => {
  const dx = target[0] - ego.x
  const dz = target[1] - ego.z
  const targetAngle = Math.atan2(dz, dx)
  const alpha = wrapPi(ego.heading - targetAngle)
  const steer = Math.atan2(
    2 * PYTHON_SIM.EGO_WHEELBASE * Math.sin(alpha),
    PYTHON_SIM.LOOKAHEAD_DISTANCE,
  )
  return clamp(steer, -PYTHON_SIM.MAX_STEER, PYTHON_SIM.MAX_STEER)
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
 */
export const integrateEgo = (
  ego: EgoState,
  action0: number,
  dt: number,
  target: readonly [number, number],
): EgoState => {
  const speed = pythonSpeedStep(ego.speed, action0, dt)
  const steer = pythonSteer(ego, target)
  const heading = ego.heading + steer * dt
  return {
    x: ego.x + speed * Math.cos(heading) * dt,
    z: ego.z + speed * Math.sin(heading) * dt,
    heading,
    speed,
  }
}
