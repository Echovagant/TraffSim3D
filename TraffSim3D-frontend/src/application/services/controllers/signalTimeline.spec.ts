// src/application/services/controllers/signalTimeline.spec.ts
//
// ## The invariant
//
// **The browser's signal timeline must have the same shape as the Python
// training sim's.** A policy trained in Python only transfers if the two
// sides agree on *when* an axis may go.
//
// The training sim's timeline (`app/apps/rl/sim_core.py`) is:
//
//   ns green 30 s → 6 s clearance (neither axis green) → ew green 30 s →
//   6 s clearance → ns green …            (a 72 s period)
//
// The 6 s clearance is `CLEARANCE_SECS = 6.0` there — the sum of the
// clearance-yellow (3 s) and the all-red (3 s) the browser runs as two
// separate phases.
//
// ## What this spec pins
//
// It drives the **real** `tick()` over the **real** cross scene and pins
// the *shape*, not a trajectory:
//
//   - every green window is 30 s,
//   - every "neither axis is green" gap is 6 s,
//   - the gaps are symmetric (all of them equal),
//   - the period is 72 s.
//
// The numbers are the **training sim's** numbers on purpose: this spec is
// the browser half of the cross-language check, and it goes red as soon as
// the browser's timeline drifts away from the reference.
//
// All three controllers are held to it. The junction owns the phase plan,
// so the plan's shape does not depend on which controller reads it.
//
// The window boundaries are measured on the tick grid, so a green window
// reads 30 s minus one tick (29.98 s at 60 Hz) — the tolerance below
// covers that.

import { describe, it, expect } from 'vitest'
import { tick, type TickContext } from '@application/services/tick'
import { buildCrossIntersectionNetwork } from '@application/services/defaultScene'
import { LightPhase } from '@domain/value-objects/Phase'
import type { TrafficLight } from '@domain/entities/TrafficLight'
import type { SignalController, ControllerKind } from '../signalController'

const DT = 1 / 60
/** Simulated seconds — three full 72 s periods. */
const SECONDS = 216

/**
 * The training sim's numbers (`app/apps/rl/sim_core.py`):
 * `cycle_duration = 30.0` per phase and `CLEARANCE_SECS = 6.0`.
 */
const EXPECTED_GREEN_SECS = 30
const EXPECTED_CLEARANCE_SECS = 6
const EXPECTED_PERIOD_SECS = 72
/** The measurement is taken on the tick grid — one tick of slack. */
const TOLERANCE_SECS = 0.1

const GREEN = new Set<string>([LightPhase.Green, LightPhase.GreenLeft])

interface Timeline {
  /** The green windows of one axis (seconds). */
  greenWindows: number[][]
  /** The spans during which neither axis is green (seconds). */
  gaps: number[][]
  /** The sim times at which the measured axis turned green (seconds). */
  greenStarts: number[]
}

/**
 * Run the cross scene through the real tick with the real controller and
 * record which axis is green, when.
 *
 * The physics-free path is used on purpose: the signal logic runs in the
 * same place in both paths, and the fallback keeps the spec free of the
 * Rapier WASM (which a signal-timing assertion has no business booting).
 */
const recordTimeline = (controllerKind: ControllerKind): Timeline => {
  const net = buildCrossIntersectionNetwork()
  const intersection = net.intersections['i-center']!
  const nsLight = intersection.trafficLights.find((l) => l.axis === 'ns')!
  const ewLight = intersection.trafficLights.find((l) => l.axis === 'ew')!
  const controllers = new Map<string, SignalController>()
  const ctx: TickContext = {
    rapierWorld: null,
    signal: {
      controllers,
      controllerKind,
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
    removeVehicle: () => {},
    policy: null,
    replayTargetId: null,
  }

  const isGreen = (light: TrafficLight): boolean => GREEN.has(light.phase)
  const frames = Math.round(SECONDS / DT)
  const nsFlags: boolean[] = []
  const ewFlags: boolean[] = []
  const neitherFlags: boolean[] = []
  const greenStarts: number[] = []
  let wasGreen = false
  for (let frame = 0; frame < frames; frame += 1) {
    tick(net, DT, (frame + 1) * DT, ctx)
    const green = isGreen(nsLight)
    if (green && !wasGreen) greenStarts.push(frame * DT)
    wasGreen = green
    nsFlags.push(green)
    ewFlags.push(isGreen(ewLight))
    neitherFlags.push(!isGreen(nsLight) && !isGreen(ewLight))
  }

  const windows = (flags: boolean[]): number[][] => {
    const spans: number[][] = []
    let start: number | null = null
    for (let i = 0; i < flags.length; i += 1) {
      if (flags[i] && start === null) start = i * DT
      else if (!flags[i] && start !== null) {
        spans.push([start, i * DT])
        start = null
      }
    }
    // A window that is still open when the run ends was cut off by the
    // clock, not by the signal — it is not a measurement.
    return spans
  }

  return {
    greenWindows: [...windows(nsFlags), ...windows(ewFlags)],
    gaps: windows(neitherFlags),
    greenStarts,
  }
}

const lengths = (spans: number[][]): number[] => spans.map(([a, b]) => b - a)

const CONTROLLERS: ControllerKind[] = ['fixed-cycle', 'rl', 'actuated']

describe('the browser signal timeline has the training sim shape', () => {
  for (const controllerKind of CONTROLLERS) {
    it(`the ${controllerKind} controller serves 30 s greens with a symmetric 6 s clearance`, () => {
      const { greenWindows, gaps } = recordTimeline(controllerKind)

      // Every green window is a full phase — never a slice.
      const greenLengths = lengths(greenWindows)
      expect(greenLengths.length).toBeGreaterThanOrEqual(6)
      for (const length of greenLengths) {
        expect(length).toBeCloseTo(EXPECTED_GREEN_SECS, 1)
        expect(Math.abs(length - EXPECTED_GREEN_SECS)).toBeLessThanOrEqual(TOLERANCE_SECS)
      }

      // Every gap is the training sim's clearance — and they are all equal
      // (the clearance comes before *every* green, not only before the
      // second axis' one).
      const gapLengths = lengths(gaps)
      expect(gapLengths.length).toBeGreaterThanOrEqual(4)
      for (const length of gapLengths) {
        expect(Math.abs(length - EXPECTED_CLEARANCE_SECS)).toBeLessThanOrEqual(TOLERANCE_SECS)
      }
      expect(new Set(gapLengths.map((l) => l.toFixed(2))).size).toBe(1)
    })

    it(`the ${controllerKind} controller repeats every 72 s`, () => {
      const { greenStarts } = recordTimeline(controllerKind)
      expect(greenStarts.length).toBeGreaterThanOrEqual(3)
      for (let i = 1; i < greenStarts.length; i += 1) {
        const period = greenStarts[i]! - greenStarts[i - 1]!
        expect(Math.abs(period - EXPECTED_PERIOD_SECS)).toBeLessThanOrEqual(TOLERANCE_SECS)
      }
    })
  }
})
