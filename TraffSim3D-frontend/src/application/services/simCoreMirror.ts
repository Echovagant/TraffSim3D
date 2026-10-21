// src/application/services/simCoreMirror.ts
//
// Plan 071: the L3 contract mirror — a 1:1 TypeScript port of the Python
// training sim (`TraffSim3D-backend/app/apps/rl/sim_core.py`).
//
// WHY A MIRROR EXISTS: the cross-language contract compares the Python sim
// against the TS sim. The *product* TS sim (`tick.ts`) is a lane-based,
// Rapier-driven sandbox — structurally incompatible with Python's
// free-space model (cross-language difference #6), so comparing full
// trajectories against it is meaningless. This module is the contract-side
// counterpart: same constants, same equations, same termination rules,
// same reason strings. It exists so the Python↔TS comparison becomes a real,
// executable check that catches drift in either language.
//
// The ego kinematics are NOT re-implemented here — they come from
// `@domain/services/egoKernel`, which the product replay path shares, so
// the mirror and the product can never diverge on the ego model.
//
// Porting rules: see the cross-language contract (ADR-008) §4.1/§4.2.

import { integrateEgo, type EgoState } from '@domain/services/egoKernel'
import {
  ALL_RED_SECS,
  MAX_GREEN_SECS,
  PHASE_ADJUST_SECS,
  PYTHON_SIM,
  SIGNAL_ACTION_NAMES,
  type SignalActionName,
} from '@shared/constants/simulation'

export type SceneKind = 'cross' | 'corridor' | 't_junction' | 'roundabout'

export type TerminationReason =
  | 'success'
  | 'success_corridor'
  | 'success_t_junction'
  | 'success_roundabout'
  | 'collision'
  | 'red_light'
  | ''

/** Python `sim_core.Vehicle` plus the elevation field. */
export interface MirrorVehicle extends EgoState {
  y: number
}

/** Python `sim_core.TrafficLight`. */
export interface MirrorLight {
  nsGreen: boolean
  ewGreen: boolean
  cycleTimer: number
  cycleDuration: number
  /** Python `pending_actions` — actions queued by `apply_action`. */
  pendingActions: SignalActionName[]
  /** Python `all_red_steps` — steps of all-red clearance left. */
  allRedSteps: number
  /** Python `resume_state` — the phase to restore after the all-red. */
  resumeState: [boolean, boolean] | null
}

export interface MirrorSample {
  step: number
  x: number
  z: number
  heading: number
  speed: number
  /**
   * The traffic-light bits — the only cross-language common semantic of
   * the phase ("which axis is green"). The frontend's 10-value `LightPhase`
   * enum projects onto this pair (Green / GreenLeft → that axis is green).
   */
  light: {
    nsGreen: boolean
    ewGreen: boolean
  }
}

export interface MirrorEpisode {
  terminated: boolean
  truncated: boolean
  reason: TerminationReason
  finalStep: number
  finalZ: number
  finalX: number
  finalSpeed: number
  samples: MirrorSample[]
}

/**
 * One external signal action, scheduled for a **1-based** step.
 *
 * THE STEP CONVENTION (identical on both sides of the contract, and the
 * reason the trajectories still match bit for bit): an action labelled
 * `step: N` is applied **before** the N-th simulation step — it is
 * *consumed by* that step. Here that means `applySignalAction(name)`
 * immediately before `mirror.step(...)`; in Python it means
 * `light.apply_action(name)` immediately before `core.step(...)`.
 *
 * Getting this off by one silently produces different trajectories, which
 * the contract would then report as a semantic mismatch.
 */
export interface MirrorSignalAction {
  /** The 1-based step the action is applied before. */
  step: number
  action: SignalActionName
}

/**
 * The light to install right after the scene's `reset()`.
 *
 * The roundabout's own light is both-green ("no traffic lights there"), so
 * its swap is a no-op. The contract vectors that need an *observable*
 * signal override it with a plain NS-green light — the same override the
 * Python side applies (`TrafficLight(ns_green=True, ew_green=False)`),
 * exactly like `tests/contract/test_signal_actions.py` does.
 */
export interface MirrorLightOverride {
  nsGreen: boolean
  ewGreen: boolean
}

/**
 * The ego pose to install right after the scene's `reset()`.
 *
 * Plan 076 S5a. Every contract vector used to be a **straight-line**
 * scenario: the ego drove straight at its target, Pure Pursuit's angle was
 * ~0, `steer` was 0 — and the three turning constants (`LOOKAHEAD_DISTANCE`,
 * `MAX_STEER`, `EGO_WHEELBASE`) therefore could not change any trajectory.
 * They were measured blind spots (see `docs/contracts/sim-snapshot.md`).
 *
 * A vector that starts the ego off its target line makes the angle non-zero
 * from the first step, so the steer is non-zero and the constants become
 * observable. The Python side applies the same override to `core.ego` right
 * after `reset()` (see `tests/contract/test_cross_lang_consistency.py`).
 */
export interface MirrorEgoStart {
  x: number
  z: number
  heading: number
  speed: number
}

/** The optional extras a contract vector may ask the mirror for. */
export interface MirrorRunOptions {
  /** Replace the scene's light after `reset()`. */
  lightOverride?: MirrorLightOverride
  /** The external signal actions to apply, and when. */
  signalActions?: MirrorSignalAction[]
  /** Replace the ego's pose after `reset()`. */
  egoStart?: MirrorEgoStart
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/**
 * CPython's float `%`: `fmod(a, b)` plus a single conditional add of the
 * modulus when the remainder is non-zero and carries the opposite sign.
 *
 * JS `%` is itself IEEE remainder-truncated — exactly `fmod` — so replaying
 * the same two steps gives the same bits. The shorter `((a % m) + m) % m` is
 * NOT equivalent: it adds a rounding step for non-negative inputs
 * (e.g. `a = 0.1` gives `0.099999999999999644729` instead of `0.1`).
 */
const floorMod = (a: number, m: number): number => {
  const r = a % m
  return r !== 0 && r < 0 !== m < 0 ? r + m : r
}

const EGO_START = (): MirrorVehicle => ({
  x: 0,
  z: -25,
  heading: Math.PI / 2,
  speed: 0,
  y: 0,
})

/**
 * Python `sim_core.ALL_RED_STEPS` — the all-red clearance expressed in sim
 * steps (3 s at the contract's 10 Hz). Derived from the same two constants
 * on both sides, so the two derivations cannot drift.
 */
export const ALL_RED_STEPS = Math.round(ALL_RED_SECS / PYTHON_SIM.DT)

/**
 * A fresh light, built the way Python's `TrafficLight(...)` constructor
 * builds one: the phase clock at zero, no queued action, no clearance.
 */
export const createMirrorLight = (nsGreen: boolean, ewGreen: boolean): MirrorLight => ({
  nsGreen,
  ewGreen,
  cycleTimer: 0,
  cycleDuration: PYTHON_SIM.LIGHT_CYCLE_SECONDS,
  pendingActions: [],
  allRedSteps: 0,
  resumeState: null,
})

/** Python `sim_core.TrafficLight()` — the default (NS-green) light. */
const LIGHT_START = (): MirrorLight => createMirrorLight(true, false)

/**
 * A port of Python's `SimCore`.
 *
 * Method names and the `step()` body follow `sim_core.py` statement by
 * statement. Read them side by side when changing anything here.
 */
export class SimCoreMirror {
  sceneKind: SceneKind
  maxSteps: number
  ego: MirrorVehicle = EGO_START()
  npcs: MirrorVehicle[] = []
  light: MirrorLight = LIGHT_START()
  simTime = 0
  stepCount = 0
  terminated = false
  truncated = false
  terminatedReason: TerminationReason = ''

  constructor(sceneKind: SceneKind = 'cross', maxSteps: number = PYTHON_SIM.MAX_STEPS_DEFAULT) {
    this.sceneKind = sceneKind
    this.maxSteps = maxSteps
  }

  /**
   * Port of Python's `TrafficLight.apply_action` — queue an external
   * signal action. Synchronous: the light's phase does not change until
   * the next `step()` consumes the queue.
   */
  applySignalAction(action: SignalActionName): void {
    if (!SIGNAL_ACTION_NAMES.includes(action)) {
      throw new Error(
        `unknown signal action '${action}'; expected one of ${SIGNAL_ACTION_NAMES.join(', ')}`,
      )
    }
    this.light.pendingActions.push(action)
  }

  reset(): void {
    this.ego = EGO_START()
    // Python: `_reset_cross` / `_reset_corridor` / `_reset_t_junction` all use
    // `ns_green=True, ew_green=False`; `_reset_roundabout` uses
    // `ns_green=True, ew_green=True` ("Roundabout has no traffic lights").
    // The difference is load-bearing: with `ew_green=False` the mirror's light
    // cycles at 30 s and can raise a `red_light` termination that Python can
    // never raise, and `obs[6:8]` reports `(1, 0)` instead of Python's `(1, 1)`.
    // Swapping `(true, true)` is a no-op, so Python's roundabout light never
    // changes.
    this.light = createMirrorLight(true, this.sceneKind === 'roundabout')
    this.simTime = 0
    this.stepCount = 0
    this.terminated = false
    this.truncated = false
    this.terminatedReason = ''

    switch (this.sceneKind) {
      case 'corridor':
        this.npcs = [
          { x: 0, z: 10, heading: Math.PI / 2, speed: PYTHON_SIM.NPC_SPEED, y: 0 },
          { x: 3.5, z: -10, heading: -Math.PI / 2, speed: PYTHON_SIM.NPC_SPEED, y: 0 },
          { x: -20, z: 0, heading: 0, speed: PYTHON_SIM.NPC_SPEED, y: 0 },
          { x: 20, z: 3.5, heading: Math.PI, speed: PYTHON_SIM.NPC_SPEED, y: 0 },
        ]
        break
      case 't_junction':
        this.npcs = [
          { x: -18, z: 3.5, heading: 0, speed: PYTHON_SIM.NPC_SPEED, y: 0 },
          { x: 18, z: -3.5, heading: Math.PI, speed: PYTHON_SIM.NPC_SPEED, y: 0 },
          { x: 3.5, z: -12, heading: Math.PI / 2, speed: PYTHON_SIM.NPC_SPEED, y: 0 },
          { x: -10, z: 0, heading: 0, speed: PYTHON_SIM.NPC_SPEED, y: 0 },
        ]
        break
      case 'roundabout':
        this.npcs = [
          {
            x: PYTHON_SIM.ROUNDABOUT_RADIUS,
            z: 0,
            heading: Math.PI / 2,
            speed: PYTHON_SIM.NPC_SPEED,
            y: 0,
          },
          {
            x: 0,
            z: PYTHON_SIM.ROUNDABOUT_RADIUS,
            heading: Math.PI,
            speed: PYTHON_SIM.NPC_SPEED,
            y: 0,
          },
          {
            x: -PYTHON_SIM.ROUNDABOUT_RADIUS,
            z: 0,
            heading: -Math.PI / 2,
            speed: PYTHON_SIM.NPC_SPEED,
            y: 0,
          },
          {
            x: 0,
            z: -PYTHON_SIM.ROUNDABOUT_RADIUS,
            heading: 0,
            speed: PYTHON_SIM.NPC_SPEED,
            y: 0,
          },
        ]
        break
      case 'cross':
      default:
        this.npcs = [
          { x: 0, z: 15, heading: Math.PI / 2, speed: PYTHON_SIM.NPC_SPEED, y: 0 },
          { x: 3.5, z: -15, heading: -Math.PI / 2, speed: PYTHON_SIM.NPC_SPEED, y: 0 },
          { x: -15, z: 0, heading: 0, speed: PYTHON_SIM.NPC_SPEED, y: 0 },
          { x: 15, z: 3.5, heading: Math.PI, speed: PYTHON_SIM.NPC_SPEED, y: 0 },
        ]
        break
    }
  }

  /** Pure Pursuit target, per Python's `step()`. */
  private target(): readonly [number, number] {
    if (this.sceneKind === 'corridor') return [0, 30]
    if (this.sceneKind === 'roundabout') return [0, PYTHON_SIM.ROUNDABOUT_RADIUS]
    return [0, 0]
  }

  step(action0: number): void {
    if (this.terminated) return
    if (this.truncated) return

    // 1) ego control + kinematics
    const next = integrateEgo(this.ego, action0, PYTHON_SIM.DT, this.target())
    this.ego.x = next.x
    this.ego.z = next.z
    this.ego.heading = next.heading
    this.ego.speed = next.speed

    // 2) NPCs
    if (this.sceneKind === 'roundabout') {
      const omega = PYTHON_SIM.NPC_SPEED / PYTHON_SIM.ROUNDABOUT_RADIUS
      for (const npc of this.npcs) {
        const angle = Math.atan2(npc.z, npc.x) + omega * PYTHON_SIM.DT
        npc.x = PYTHON_SIM.ROUNDABOUT_RADIUS * Math.cos(angle)
        npc.z = PYTHON_SIM.ROUNDABOUT_RADIUS * Math.sin(angle)
        npc.heading = angle + Math.PI / 2
      }
    } else {
      for (const npc of this.npcs) {
        npc.x += npc.speed * Math.cos(npc.heading) * PYTHON_SIM.DT
        npc.z += npc.speed * Math.sin(npc.heading) * PYTHON_SIM.DT
        if (Math.abs(npc.x) > 40 || Math.abs(npc.z) > 40) {
          npc.x = -npc.x * 0.8
          npc.z = -npc.z * 0.8
        }
      }
    }

    // 3) traffic light cycle
    // The clearance that ended with the previous step resumes FIRST, so the
    // actions consumed below observe the resumed phase and not the all-red
    // state the light was left in. Without this order a preempt landing on
    // that step would overwrite the resume point with (false, false) and the
    // light would never go green again.
    if (this.light.allRedSteps === 0 && this.light.resumeState !== null) {
      this.light.nsGreen = this.light.resumeState[0]
      this.light.ewGreen = this.light.resumeState[1]
      this.light.resumeState = null
    }
    this.consumeLightActions()
    if (this.light.allRedSteps > 0) {
      // All-red clearance (Plan 073 Sprint 2): neither axis is green and
      // the phase clock is frozen, so the interrupted phase resumes where
      // it left off.
      this.light.nsGreen = false
      this.light.ewGreen = false
      this.light.allRedSteps -= 1
    } else {
      this.light.cycleTimer += PYTHON_SIM.DT
      if (this.light.cycleTimer >= this.light.cycleDuration) {
        this.light.cycleTimer = 0
        const ns = this.light.nsGreen
        this.light.nsGreen = this.light.ewGreen
        this.light.ewGreen = ns
      }
    }

    this.simTime += PYTHON_SIM.DT
    this.stepCount += 1

    // 4) termination
    for (const npc of this.npcs) {
      const d = Math.hypot(this.ego.x - npc.x, this.ego.z - npc.z)
      if (d < PYTHON_SIM.COLLISION_DISTANCE) {
        this.terminated = true
        this.terminatedReason = 'collision'
        break
      }
    }

    if (!this.terminated && this.checkRedLightRun()) {
      this.terminated = true
      this.terminatedReason = 'red_light'
    }

    if (!this.terminated) {
      if (this.sceneKind === 'corridor') {
        if (this.ego.z > 25.0) {
          this.terminated = true
          this.terminatedReason = 'success_corridor'
        }
      } else if (this.sceneKind === 't_junction') {
        if (this.ego.z > -3.0) {
          this.terminated = true
          this.terminatedReason = 'success_t_junction'
        }
      } else if (this.sceneKind === 'roundabout') {
        if (this.ego.z > 5.0) {
          this.terminated = true
          this.terminatedReason = 'success_roundabout'
        }
      } else if (this.ego.z > 25.0) {
        this.terminated = true
        this.terminatedReason = 'success'
      }
    }

    // 5) truncation latch (Plan 067)
    if (this.stepCount >= this.maxSteps && !this.terminated) {
      this.truncated = true
    }
  }

  /** Port of Python's `TrafficLight.consume_actions`. */
  private consumeLightActions(): void {
    if (this.light.pendingActions.length === 0) return
    const actions = this.light.pendingActions
    this.light.pendingActions = []
    for (const action of actions) {
      if (action === 'extend_green') {
        // Delay the swap by 5 s. The timer may go negative — that is how
        // "the green runs longer than cycle_duration" is expressed — bounded
        // by MAX_GREEN_SECS. The floor on the elapsed clock is
        // `cycleDuration - MAX_GREEN_SECS`, i.e. the remaining green is at
        // most `MAX_GREEN_SECS`. (A bound on the remaining, not on the
        // wall-clock duration: a policy that extends on every decision can
        // still hold the axis green.)
        this.light.cycleTimer = Math.max(
          this.light.cycleTimer - PHASE_ADJUST_SECS,
          this.light.cycleDuration - MAX_GREEN_SECS,
        )
      } else if (action === 'shorten_red') {
        // Advance the swap by 5 s (capped, so the swap happens on the next
        // step at the latest).
        this.light.cycleTimer = Math.min(
          this.light.cycleTimer + PHASE_ADJUST_SECS,
          this.light.cycleDuration,
        )
      } else if (action === 'preempt' || action === 'force_all_red') {
        if (this.light.allRedSteps === 0 && (this.light.nsGreen || this.light.ewGreen)) {
          // Not already clearing, and the light has a green axis: remember
          // the phase to resume. An all-red resume point would wedge the
          // light permanently (it would resume into "no axis is green" and
          // never recover).
          this.light.resumeState = [this.light.nsGreen, this.light.ewGreen]
        }
        this.light.allRedSteps = ALL_RED_STEPS
        this.light.nsGreen = false
        this.light.ewGreen = false
      }
      // 'no_op' — nothing.
    }
  }

  /** Port of Python's `_check_red_light_run`. */
  private checkRedLightRun(): boolean {
    const inIntersection =
      Math.abs(this.ego.x) < PYTHON_SIM.INTERSECTION_RADIUS &&
      Math.abs(this.ego.z) < PYTHON_SIM.INTERSECTION_RADIUS
    if (!inIntersection) return false
    const headingNs = Math.abs(floorMod(this.ego.heading, 2 * Math.PI) - Math.PI / 2) < 0.5
    if (headingNs && !this.light.nsGreen) return true
    if (!headingNs && !this.light.ewGreen) return true
    return false
  }

  /** Port of Python's `_obs()` — 14 dims. */
  obs(): number[] {
    const obs = new Array<number>(14).fill(0)
    obs[0] = clamp(this.ego.x / 50, -1, 1)
    obs[1] = clamp(this.ego.z / 50, -1, 1)
    obs[2] = this.ego.heading / Math.PI
    obs[3] = this.ego.speed / PYTHON_SIM.SPEED_LIMIT
    obs[6] = this.light.nsGreen ? 1 : 0
    obs[7] = this.light.ewGreen ? 1 : 0
    const distances = this.npcs
      .map((n) => Math.hypot(this.ego.x - n.x, this.ego.z - n.z))
      .sort((a, b) => a - b)
    while (distances.length < 5) distances.push(50)
    for (let i = 0; i < 5; i++) obs[8 + i] = Math.min(distances[i]! / 50, 1)
    obs[13] = clamp(this.ego.y / 10, -1, 1)
    return obs
  }
}

const snapshot = (step: number, core: SimCoreMirror): MirrorSample => ({
  step,
  x: core.ego.x,
  z: core.ego.z,
  heading: core.ego.heading,
  speed: core.ego.speed,
  light: {
    nsGreen: core.light.nsGreen,
    ewGreen: core.light.ewGreen,
  },
})

/**
 * Validate a scheduled action sequence — loudly.
 *
 * A malformed entry must fail on **both** sides of the contract, exactly
 * like a malformed `repeat` does: a silently-ignored action would make the
 * trajectory comparison vacuous (both sides would run the same *default*
 * episode and "agree").
 */
export const assertValidSignalActions = (actions: MirrorSignalAction[]): void => {
  for (const entry of actions) {
    if (!Number.isInteger(entry.step) || entry.step < 1) {
      throw new Error(
        `signal action step must be a positive integer, got ${JSON.stringify(entry.step)}`,
      )
    }
    if (!SIGNAL_ACTION_NAMES.includes(entry.action)) {
      throw new Error(
        `unknown signal action '${entry.action}'; expected one of ${SIGNAL_ACTION_NAMES.join(', ')}`,
      )
    }
  }
}

/**
 * Run one episode and collect samples.
 *
 * Sampling and stopping follow Python's `_ensure_python_snapshot` exactly:
 * sample at step 0, then every `sampleEvery`-th step, plus the **last
 * action index**; stop as soon as the episode terminates or truncates.
 *
 * Note the terminating step is usually NOT sampled — it is only included
 * when it happens to be a multiple of `sampleEvery` or the last action.
 * (Measured on the `cross` vector: [0, 10, 20, 30, 40, 50].)
 *
 * `maxSteps` is appended last so the existing positional call sites
 * (`runEpisode(scene, actions, sampleEvery)`) keep working unchanged.
 *
 * `options` carries the two optional extras a contract vector may ask for:
 * the light override and the external signal actions. The actions are
 * applied **before** the step they are labelled with — the same order as
 * Python's `light.apply_action(...)` immediately before `core.step(...)`.
 */
export const runEpisode = (
  sceneKind: SceneKind,
  actions: number[],
  sampleEvery = 10,
  maxSteps: number = PYTHON_SIM.MAX_STEPS_DEFAULT,
  options: MirrorRunOptions = {},
): MirrorEpisode => {
  const core = new SimCoreMirror(sceneKind, maxSteps)
  core.reset()
  if (options.lightOverride) {
    core.light = createMirrorLight(options.lightOverride.nsGreen, options.lightOverride.ewGreen)
  }
  if (options.egoStart) {
    // Plan 076 S5a: the ego's pose is overridden right after `reset()` —
    // the same place and the same pattern as the light override, and the
    // same order on the Python side.
    core.ego = { ...options.egoStart, y: 0 }
  }
  const signalActions = options.signalActions ?? []
  assertValidSignalActions(signalActions)
  const samples: MirrorSample[] = [snapshot(0, core)]
  for (let i = 0; i < actions.length; i++) {
    // The 1-based step this iteration is about to run.
    const stepNo = i + 1
    for (const entry of signalActions) {
      if (entry.step === stepNo) core.applySignalAction(entry.action)
    }
    core.step(actions[i]!)
    if ((i + 1) % sampleEvery === 0 || i === actions.length - 1) {
      samples.push(snapshot(i + 1, core))
    }
    if (core.terminated || core.truncated) break
  }
  return {
    terminated: core.terminated,
    truncated: core.truncated,
    reason: core.terminatedReason,
    finalStep: core.stepCount,
    finalZ: core.ego.z,
    finalX: core.ego.x,
    finalSpeed: core.ego.speed,
    samples,
  }
}
