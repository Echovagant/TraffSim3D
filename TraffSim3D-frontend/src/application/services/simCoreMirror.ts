// src/application/services/simCoreMirror.ts
//
// The L3 contract mirror — a 1:1 TypeScript port of the Python
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
// Porting rules: see the egoKernel header.

import { integrateEgo, type EgoState } from '@domain/services/egoKernel'
import {
  ALL_RED_SECS,
  MAX_GREEN_SECS,
  PHASE_ADJUST_SECS,
  PYTHON_SIM,
  SIGNAL_ACTION_NAMES,
  type SignalActionName,
} from '@shared/constants/simulation'

export type SceneKind = 'cross' | 'corridor' | 't_junction' | 'roundabout' | 'cross_signalled'

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
 * Every contract vector used to be a **straight-line**
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
  /**
   * The **steering commands** (`action[1]`) of the episode, in step order.
   *
   * The policy's steering authority is a residual on top of
   * the scripted Pure Pursuit steer. Absent → every step uses `0`, i.e. the
   * scripted controller drives unmodified (the previous behaviour).
   */
  steerActions?: number[]
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

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
 *
 * `cycleDuration` defaults to the default 30 s cycle; the signalled scene
 * passes its own.
 */
export const createMirrorLight = (
  nsGreen: boolean,
  ewGreen: boolean,
  cycleDuration: number = PYTHON_SIM.LIGHT_CYCLE_SECONDS,
): MirrorLight => ({
  nsGreen,
  ewGreen,
  cycleTimer: 0,
  cycleDuration,
  pendingActions: [],
  allRedSteps: 0,
  resumeState: null,
})

/** Python `sim_core.TrafficLight()` — the default (NS-green) light. */
const LIGHT_START = (): MirrorLight => createMirrorLight(true, false)

/** Python `sim_core.approach_axis` — the signalised approach axis.
 *
 * The NPCs drive straight through the intersection centre, so
 * the axis follows from the heading alone: a heading within 45° of ±Z runs on
 * the north-south road ("ns"), a heading within 45° of ±X on the east-west
 * road ("ew").
 *
 * This is the **traffic model's own** classification, and the red-light rule
 * below uses it too — the two must never disagree about which axis the ego
 * is on. (The previous heuristic read the axis off "within 0.5 rad of north"
 * instead, which disagreed with the traffic model on 23 of the 68 sampled
 * headings that are not on the axis boundary — every 5° — and on the four
 * boundary headings as well, so it both killed green-axis episodes and let
 * real red-light runs through.)
 *
 * The comparison is made on the **rounded** projections, and the rounding is
 * spelled out rather than left to `Math.round`, so that it is bit-identical
 * to the Python side. At exactly 45° the two projections are mathematically
 * equal, and `sin` and `cos` of one angle can differ in the last bit
 * between platforms — which would make the axis, and with it the recorded
 * contract goldens, depend on the machine. Measured 2026-10-25: on the
 * Linux runner the 45° heading came out as "ew" (two gate tests failed)
 * while on Windows it came out as "ns".
 */
const approachAxis = (heading: number): 'ns' | 'ew' => {
  // Python: math.floor(abs(v) * 1e12 + 0.5) / 1e12
  const round12 = (v: number): number => Math.floor(Math.abs(v) * 1e12 + 0.5) / 1e12
  return round12(Math.sin(heading)) >= round12(Math.cos(heading)) ? 'ns' : 'ew'
}

/** Python `sim_core.lateral_offset` — the perpendicular distance from the
 * centreline of the road the vehicle runs along.
 *
 * The scenes carry no lane model; which road a vehicle runs along follows
 * from its heading — the same `approachAxis` the traffic model uses — so a
 * north-south vehicle is measured against the `x = 0` centreline and an
 * east-west one against the `z = 0` centreline.
 */
const lateralOffset = (vehicle: MirrorVehicle): number =>
  approachAxis(vehicle.heading) === 'ns' ? Math.abs(vehicle.x) : Math.abs(vehicle.z)

/**
 * The scene's **own** light — the one `reset()` installs, before any
 * vector-level `lightOverride` is applied.
 *
 * The contract generator writes this into every golden, and
 * the Python side compares it against the light its own `SimCore.reset()`
 * installs — item by item. Each side owns its own schedule (the four
 * default scenes run the 30 s cycle; `cross_signalled` starts the ego's
 * axis red on a 12 s cycle), so a one-sided change turns the contract red.
 */
export const sceneLight = (sceneKind: SceneKind): MirrorLight => {
  const core = new SimCoreMirror(sceneKind)
  core.reset()
  return core.light
}

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
  /**
   * Has the ego left the road during this episode?
   *
   * The success condition used to be route-agnostic (`ego.z > 25`), so a
   * wrong route that left the road scored the same success — and the same
   * bonus — as the right one. The latch is permanent: the success needs the
   * ego to have **stayed** on the road, not to be on it at the moment it
   * crossed the line.
   */
  offRoad = false

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
    //
    // `_reset_cross_signalled` is the third case — the ego's
    // axis starts **red** (`ns_green=False, ew_green=True`) and the cycle is
    // the scene's own 12 s, so the phase changes at step 121 — inside the
    // episode, unlike the default 30 s cycle (step 300).
    this.light =
      this.sceneKind === 'cross_signalled'
        ? createMirrorLight(false, true, PYTHON_SIM.CROSS_SIGNALLED_CYCLE_SECONDS)
        : createMirrorLight(true, this.sceneKind === 'roundabout')
    this.simTime = 0
    this.stepCount = 0
    this.terminated = false
    this.truncated = false
    this.terminatedReason = ''
    // The off-road latch is per-episode state too.
    this.offRoad = false

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
      case 'cross_signalled':
        // Only the east-west cross traffic. A north-south
        // NPC would be respawned by the default traffic model's
        // out-of-bounds rule (`x -> -0.8 x`), which converges onto the
        // ego's own centreline within two respawns and would then drive
        // into a **stopped** ego. Measured over 400 steps, the east-west
        // traffic never comes closer than 5.2 m to an ego stopped at the
        // stop line. It crosses the ego's path on steps 17-21, 107-111,
        // 199-203 and 289-293, which do **not** overlap the light-aware
        // drive's crossing window (~150-167) — so the scene's
        // discriminating power comes entirely from the red light.
        this.npcs = [
          { x: -15, z: 0, heading: 0, speed: PYTHON_SIM.NPC_SPEED, y: 0 },
          { x: 15, z: 3.5, heading: Math.PI, speed: PYTHON_SIM.NPC_SPEED, y: 0 },
        ]
        break
      case 'cross':
        this.npcs = [
          { x: 0, z: 15, heading: Math.PI / 2, speed: PYTHON_SIM.NPC_SPEED, y: 0 },
          { x: 3.5, z: -15, heading: -Math.PI / 2, speed: PYTHON_SIM.NPC_SPEED, y: 0 },
          { x: -15, z: 0, heading: 0, speed: PYTHON_SIM.NPC_SPEED, y: 0 },
          { x: 15, z: 3.5, heading: Math.PI, speed: PYTHON_SIM.NPC_SPEED, y: 0 },
        ]
        break
      default:
        // An unknown scene name is an error, not a silent
        // fall-through to the `cross` scene — the Python side raises too
        // (`SimCore.reset()`). A caller that asked for a scene that does
        // not exist must not end up measuring the `cross` scene.
        throw new Error(`unknown sceneKind ${String(this.sceneKind)}`)
    }
  }

  /** Pure Pursuit target, per Python's `step()`. */
  private target(): readonly [number, number] {
    if (this.sceneKind === 'corridor') return [0, 30]
    if (this.sceneKind === 'roundabout') return [0, PYTHON_SIM.ROUNDABOUT_RADIUS]
    // The signalled scene's target is the **goal line**, not
    // the intersection centre — a pursuit target that stays ahead of the
    // ego for the whole route (the same convention the corridor and
    // roundabout scenes use). See Python's `SimCore.step()`.
    if (this.sceneKind === 'cross_signalled') return [0, PYTHON_SIM.SCENE_GOAL_Z.cross_signalled]
    return [0, 0]
  }

  /**
   * One simulation step.
   *
   * `action1` is the **steering residual**: the policy's
   * correction **on top of** the scripted Pure Pursuit steer, not a
   * replacement. It is scaled by `MAX_STEER` and clipped together with the
   * scripted steer, exactly like Python's
   * `steer = clip(clip(steer) + clip(action[1], -1, 1) * MAX_STEER)`.
   *
   * The default `0` means "no correction" — the scripted controller drives
   * exactly as before.
   */
  step(action0: number, action1 = 0): void {
    if (this.terminated) return
    if (this.truncated) return

    // 1) ego control + kinematics
    // Python: `steer_residual = float(np.clip(action[1], -1.0, 1.0)) * MAX_STEER`
    // (`Math.fround` is the float32 cast Python's env applies to the action;
    // the clip's bounds are exact in float32, so clipping the rounded value
    // in double gives the same bits as numpy's float32 clip.)
    const steerResidual = clamp(Math.fround(action1), -1, 1) * PYTHON_SIM.MAX_STEER
    const next = integrateEgo(this.ego, action0, PYTHON_SIM.DT, this.target(), steerResidual)
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
      // All-red clearance: neither axis is green and
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

    // Has the ego left the road? The latch is permanent —
    // the success needs the ego to have STAYED on the road.
    if (lateralOffset(this.ego) > PYTHON_SIM.ROAD_HALF_WIDTH) {
      this.offRoad = true
    }

    // The success also needs the ego to have stayed on the
    // road — the old condition (`ego.z > 25`) was route-agnostic, so a wrong
    // route that left the road scored the same success and the same bonus as
    // the right one.
    if (!this.terminated && !this.offRoad) {
      const goalZ = PYTHON_SIM.SCENE_GOAL_Z[this.sceneKind]
      if (this.ego.z > goalZ) {
        this.terminated = true
        if (this.sceneKind === 'corridor') {
          this.terminatedReason = 'success_corridor'
        } else if (this.sceneKind === 't_junction') {
          this.terminatedReason = 'success_t_junction'
        } else if (this.sceneKind === 'roundabout') {
          this.terminatedReason = 'success_roundabout'
        } else {
          this.terminatedReason = 'success'
        }
      }
    }

    // 5) truncation latch
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
    // The axis comes from the **traffic model's own**
    // classification (`approachAxis`), so the red-light rule and the traffic
    // model can never disagree about which axis the ego is on.
    //
    // The old heuristic read the axis off the heading as "within 0.5 rad of
    // north" (61.35deg - 118.65deg), while the traffic model uses
    // `|sin h| >= |cos h|` (45deg - 135deg and 225deg - 315deg): 23 of the
    // 68 headings that are not on the boundary disagreed (and the four
    // boundary headings as well), so the rule both killed episodes on the
    // green axis and let real red-light runs through.
    if (approachAxis(this.ego.heading) === 'ns') return !this.light.nsGreen
    return !this.light.ewGreen
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
    // The ego's pose is overridden right after `reset()` —
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
    core.step(actions[i]!, options.steerActions?.[i] ?? 0)
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
