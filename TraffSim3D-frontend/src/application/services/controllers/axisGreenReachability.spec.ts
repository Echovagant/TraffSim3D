// src/application/services/controllers/axisGreenReachability.spec.ts
//
// ## The invariant
//
// **Every axis must be able to reach Green.** A traffic light that can be
// held at red forever is not "slow" — it is stuck, and the failure is
// silent: the scene keeps running, the other axis keeps flowing, and the
// vehicles of the starved axis simply stand at the stop line.
//
// The built-in cross scene hit exactly that. `ActuatedController` used to
// *replace* the red with a yellow when the opposite axis had no queue; a
// yellow's only successor is a full red, and the next check shortened
// that one again — red → yellow → red → … — so the east–west axis never
// got a green. Three of the six vehicles moved 3–9 m in 90 s while the
// other three drove 1000+ m.
//
// ## What this spec pins
//
// The spec drives the **real** `tick()` over the **real** cross scene and
// asserts the liveness property, not a distance number:
//
//   - every light reaches Green (and keeps reaching it — a single lucky
//     green is not liveness),
//   - the vehicles of the starved axis actually move.
//
// The distance bound is deliberately loose: the physics path and the
// physics-free fallback path are not bit-identical, so the exact number
// is not a contract. What is a contract is "the axis is served".

import { describe, it, expect } from 'vitest'
import { tick, type TickContext } from '@application/services/tick'
import { buildCrossIntersectionNetwork } from '@application/services/defaultScene'
import { LightPhase } from '@domain/value-objects/Phase'
import type { SignalController } from '../signalController'

const DT = 1 / 60
/**
 * Simulated seconds. Long enough for both axes to be served repeatedly.
 *
 * The junction's cycle is 72 s (30 s green + 6 s clearance + 30 s green +
 * 6 s clearance — the same shape the Python training sim has), so a window
 * has to span more than two cycles for "every axis gets green again" to be
 * a meaningful assertion.
 */
const SECONDS = 150
/**
 * Lower bound (metres) for the distance a vehicle of the EW axis has to
 * cover. The broken controller moved 3–9 m in 90 s; the fixed one moves
 * hundreds. The bound is loose on purpose — it separates "served" from
 * "starved", it does not pin a trajectory.
 */
const MIN_SERVED_DISTANCE_M = 50

interface RunResult {
  /** light id → how many green windows it got. */
  greenWindows: Map<string, number>
  /** vehicle id → metres travelled. */
  distance: Map<string, number>
}

/**
 * Run the cross scene through the real tick with the real controllers.
 *
 * The physics-free path is used on purpose: the signal logic runs in the
 * same place in both paths, and the fallback keeps the spec free of the
 * Rapier WASM (which the unit test environment has no business booting
 * for a signal-timing assertion).
 */
const runCrossScene = (seconds: number): RunResult => {
  const net = buildCrossIntersectionNetwork()
  const controllers = new Map<string, SignalController>()
  const ctx: TickContext = {
    rapierWorld: null,
    signal: {
      controllers,
      controllerKind: 'actuated',
      getCoordinatedOffsets: () => new Map<string, number>(),
      isCoordinatedEnabled: () => false,
      getRlActionSource: () => undefined,
    },
    trajectoryExporter: null,
    sensorRegistry: null,
    lidarEnabled: false,
    getHostPose: () => null,
    fixedStepScheduler: null,
    draggingId: null,
    removeVehicle: (id) => {
      delete net.vehicles[id]
    },
    policy: null,
    replayTargetId: null,
  }

  const greenWindows = new Map<string, number>()
  const distance = new Map<string, number>()
  const last = new Map<string, { x: number; z: number }>()
  /** light id → was it green on the previous frame? */
  const wasGreen = new Map<string, boolean>()
  for (const l of net.intersections['i-center']!.trafficLights) {
    greenWindows.set(l.id, 0)
    wasGreen.set(l.id, false)
  }
  for (const v of Object.values(net.vehicles)) {
    distance.set(v.id, 0)
    last.set(v.id, { x: v.position.x, z: v.position.z })
  }

  const frames = Math.round(seconds / DT)
  for (let frame = 0; frame < frames; frame += 1) {
    tick(net, DT, (frame + 1) * DT, ctx)
    for (const l of net.intersections['i-center']!.trafficLights) {
      const green = l.phase === LightPhase.Green
      // A green window starts whenever the light turns green after not
      // being green on the previous frame.
      if (green && !wasGreen.get(l.id)) {
        greenWindows.set(l.id, (greenWindows.get(l.id) ?? 0) + 1)
      }
      wasGreen.set(l.id, green)
    }
    for (const v of Object.values(net.vehicles)) {
      const prev = last.get(v.id)
      if (!prev) continue
      distance.set(
        v.id,
        (distance.get(v.id) ?? 0) + Math.hypot(v.position.x - prev.x, v.position.z - prev.z),
      )
      prev.x = v.position.x
      prev.z = v.position.z
    }
  }
  return { greenWindows, distance }
}

describe('the cross scene never starves an axis', () => {
  it('gives every axis green, again and again', () => {
    const { greenWindows } = runCrossScene(SECONDS)
    // The north–south axis is the scene's first green — it must keep it.
    expect(greenWindows.get('tl-ns')).toBeGreaterThanOrEqual(2)
    // The east–west axis is the one the broken controller starved.
    expect(greenWindows.get('tl-ew')).toBeGreaterThanOrEqual(2)
  })

  it('moves the vehicles of the starved axis', () => {
    const { distance } = runCrossScene(SECONDS)
    // v-3 / v-4 / v-6 are the EW vehicles of the built-in scene.
    for (const id of ['v-3', 'v-4', 'v-6']) {
      expect(distance.get(id) ?? 0).toBeGreaterThan(MIN_SERVED_DISTANCE_M)
    }
  })
})
