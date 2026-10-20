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
import { PYTHON_SIM } from '@shared/constants/simulation'

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
}

export interface MirrorSample {
  step: number
  x: number
  z: number
  heading: number
  speed: number
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
  light: MirrorLight = {
    nsGreen: true,
    ewGreen: false,
    cycleTimer: 0,
    cycleDuration: PYTHON_SIM.LIGHT_CYCLE_SECONDS,
  }
  simTime = 0
  stepCount = 0
  terminated = false
  truncated = false
  terminatedReason: TerminationReason = ''

  constructor(sceneKind: SceneKind = 'cross', maxSteps: number = PYTHON_SIM.MAX_STEPS_DEFAULT) {
    this.sceneKind = sceneKind
    this.maxSteps = maxSteps
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
    this.light = {
      nsGreen: true,
      ewGreen: this.sceneKind === 'roundabout',
      cycleTimer: 0,
      cycleDuration: PYTHON_SIM.LIGHT_CYCLE_SECONDS,
    }
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
    this.light.cycleTimer += PYTHON_SIM.DT
    if (this.light.cycleTimer >= this.light.cycleDuration) {
      this.light.cycleTimer = 0
      const ns = this.light.nsGreen
      this.light.nsGreen = this.light.ewGreen
      this.light.ewGreen = ns
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
})

/**
 * Run one episode and collect samples.
 *
 * Sampling and stopping follow Python's `_ensure_python_snapshot` exactly:
 * sample at step 0, then every `sampleEvery`-th step, plus the **last
 * action index**; stop as soon as the episode terminates.
 *
 * Note the terminating step is usually NOT sampled — it is only included
 * when it happens to be a multiple of `sampleEvery` or the last action.
 * (Measured on the `cross` vector: [0, 10, 20, 30, 40, 50].)
 */
export const runEpisode = (
  sceneKind: SceneKind,
  actions: number[],
  sampleEvery = 10,
): MirrorEpisode => {
  const core = new SimCoreMirror(sceneKind)
  core.reset()
  const samples: MirrorSample[] = [snapshot(0, core)]
  for (let i = 0; i < actions.length; i++) {
    core.step(actions[i]!)
    if ((i + 1) % sampleEvery === 0 || i === actions.length - 1) {
      samples.push(snapshot(i + 1, core))
    }
    if (core.terminated) break
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
