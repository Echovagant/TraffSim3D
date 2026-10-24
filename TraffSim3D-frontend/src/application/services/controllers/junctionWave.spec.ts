// src/application/services/controllers/junctionWave.spec.ts
//
// The signal **at the scale a city has**: a grid of junctions.
//
// Two things are pinned here:
//
//   1. **Every junction's clearance is 6 s.** The junction owns the plan,
//      so the two axes of a junction cannot drift apart — and a grid of
//      junctions cannot drift from each other either.
//
//   2. **The green wave is per junction.** A green wave is a relation
//      between junctions, so each junction carries its own offset against
//      the common reference.

import { describe, it, expect } from 'vitest'
import { tick, type TickContext } from '@application/services/tick'
import { LightPhase } from '@domain/value-objects/Phase'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import type { Road } from '@domain/entities/Road'
import type { Intersection } from '@domain/entities/Intersection'
import type { TrafficLight } from '@domain/entities/TrafficLight'
import { createRoadNetwork } from '@domain/entities/RoadNetwork'
import type { SignalController, ControllerKind } from '../signalController'

const DT = 1 / 60
const SECONDS = 150
/** The training sim's numbers (`app/apps/rl/sim_core.py`). */
const EXPECTED_GREEN_SECS = 30
const EXPECTED_CLEARANCE_SECS = 6
const EXPECTED_PERIOD_SECS = 72
/** The measurement is on the tick grid — one tick of slack. */
const TOLERANCE_SECS = 0.1

const GRID_X = 100
const GRID_Z = 100

const makeRoad = (id: string, axis: 'ns' | 'ew', x: number, z: number): Road => ({
  id,
  startNode: axis === 'ns' ? { x, y: 0, z: z - 50 } : { x: x - 50, y: 0, z },
  endNode: axis === 'ns' ? { x, y: 0, z: z + 50 } : { x: x + 50, y: 0, z },
  laneCount: 2,
  speedLimit: 16.67,
  level: 0,
})

const makeLight = (
  id: string,
  axis: 'ns' | 'ew',
  phase: LightPhase,
  remaining: number,
): TrafficLight => ({
  id,
  position: { x: 0, y: 0, z: 0 },
  phase,
  phaseRemaining: remaining,
  cycleSeconds: 72,
  axis,
})

/** A 2 × 2 grid: four junctions, each with one light per axis. */
const buildGrid = (): RoadNetwork => {
  const net = createRoadNetwork()
  net.roads['r-ns-0'] = makeRoad('r-ns-0', 'ns', 0, 0)
  net.roads['r-ns-1'] = makeRoad('r-ns-1', 'ns', GRID_X, 0)
  net.roads['r-ew-0'] = makeRoad('r-ew-0', 'ew', 0, 0)
  net.roads['r-ew-1'] = makeRoad('r-ew-1', 'ew', 0, GRID_Z)
  const junctions: [string, number, number, string, string][] = [
    ['i-00', 0, 0, 'r-ns-0', 'r-ew-0'],
    ['i-10', GRID_X, 0, 'r-ns-1', 'r-ew-0'],
    ['i-01', 0, GRID_Z, 'r-ns-0', 'r-ew-1'],
    ['i-11', GRID_X, GRID_Z, 'r-ns-1', 'r-ew-1'],
  ]
  for (const [id, x, z, nsRoad, ewRoad] of junctions) {
    const intersection: Intersection = {
      id,
      position: { x, y: 0, z },
      connectedRoads: [nsRoad, ewRoad],
      trafficLights: [
        makeLight(`tl-ns-${id}`, 'ns', LightPhase.Green, 30),
        makeLight(`tl-ew-${id}`, 'ew', LightPhase.Red, 36),
      ],
      intersectionRadius: 8,
    }
    net.intersections[id] = intersection
  }
  return net
}

interface JunctionTimeline {
  /** The green windows of the junction's own axis (seconds). */
  greenWindows: number[][]
  /** The spans during which neither axis is green (seconds). */
  gaps: number[][]
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
  return spans
}

const runGrid = (
  controllerKind: ControllerKind,
  offsets: Map<string, number> = new Map(),
): Map<string, JunctionTimeline> => {
  const net = buildGrid()
  const controllers = new Map<string, SignalController>()
  const ctx: TickContext = {
    rapierWorld: null,
    signal: {
      controllers,
      controllerKind,
      getCoordinatedOffsets: () => offsets,
      isCoordinatedEnabled: () => offsets.size > 0,
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

  const flags = new Map<string, { ns: boolean[]; ew: boolean[]; neither: boolean[] }>()
  for (const id of Object.keys(net.intersections)) {
    flags.set(id, { ns: [], ew: [], neither: [] })
  }
  const frames = Math.round(SECONDS / DT)
  for (let frame = 0; frame < frames; frame += 1) {
    tick(net, DT, (frame + 1) * DT, ctx)
    for (const [id, intersection] of Object.entries(net.intersections)) {
      const ns = intersection.trafficLights.find((l) => l.axis === 'ns')!
      const ew = intersection.trafficLights.find((l) => l.axis === 'ew')!
      const nsGreen = ns.phase === LightPhase.Green
      const ewGreen = ew.phase === LightPhase.Green
      const bucket = flags.get(id)!
      bucket.ns.push(nsGreen)
      bucket.ew.push(ewGreen)
      bucket.neither.push(!nsGreen && !ewGreen)
    }
  }

  const out = new Map<string, JunctionTimeline>()
  for (const [id, bucket] of flags) {
    out.set(id, { greenWindows: windows(bucket.ns), gaps: windows(bucket.neither) })
  }
  return out
}

const lengths = (spans: number[][]): number[] => spans.map(([a, b]) => b - a)

describe('a grid of junctions', () => {
  it('gives every junction a 6 s clearance', () => {
    const timelines = runGrid('fixed-cycle')
    expect(timelines.size).toBe(4)
    for (const [id, timeline] of timelines) {
      const gapLengths = lengths(timeline.gaps)
      expect(gapLengths.length, `${id} clearance count`).toBeGreaterThanOrEqual(3)
      for (const length of gapLengths) {
        expect(Math.abs(length - EXPECTED_CLEARANCE_SECS), `${id} clearance`).toBeLessThanOrEqual(
          TOLERANCE_SECS,
        )
      }
      // Symmetric: every clearance is the same.
      expect(new Set(gapLengths.map((l) => l.toFixed(2))).size, `${id} clearance spread`).toBe(1)
    }
  })

  it('gives every junction 30 s greens on a 72 s period', () => {
    const timelines = runGrid('fixed-cycle')
    for (const [id, timeline] of timelines) {
      const greenLengths = lengths(timeline.greenWindows)
      expect(greenLengths.length, `${id} green count`).toBeGreaterThanOrEqual(2)
      for (const length of greenLengths) {
        expect(Math.abs(length - EXPECTED_GREEN_SECS), `${id} green`).toBeLessThanOrEqual(
          TOLERANCE_SECS,
        )
      }
      // The period: the distance between two green starts.
      const starts = timeline.greenWindows.map(([start]) => start)
      for (let i = 1; i < starts.length; i += 1) {
        expect(
          Math.abs(starts[i]! - starts[i - 1]! - EXPECTED_PERIOD_SECS),
          `${id} period`,
        ).toBeLessThanOrEqual(TOLERANCE_SECS)
      }
    }
  })

  it('offsets the junctions’ greens against the common reference', () => {
    // A wave along the corridor: each junction 8 s later than the last.
    const offsets = new Map([
      ['i-00', 0],
      ['i-10', 8],
      ['i-01', 16],
      ['i-11', 24],
    ])
    const timelines = runGrid('coordinated', offsets)
    const startOf = (id: string): number => timelines.get(id)!.greenWindows[0]![0]!
    // The wave: the offsets are the distances between the junctions'
    // green starts.
    expect(startOf('i-10') - startOf('i-00')).toBeCloseTo(8, 1)
    expect(startOf('i-01') - startOf('i-00')).toBeCloseTo(16, 1)
    expect(startOf('i-11') - startOf('i-00')).toBeCloseTo(24, 1)
  })

  it('keeps every junction’s clearance at 6 s when the wave is on', () => {
    const offsets = new Map([
      ['i-00', 0],
      ['i-10', 8],
      ['i-01', 16],
      ['i-11', 24],
    ])
    const timelines = runGrid('coordinated', offsets)
    for (const [id, timeline] of timelines) {
      const gapLengths = lengths(timeline.gaps)
      expect(gapLengths.length, `${id} clearance count`).toBeGreaterThanOrEqual(3)
      for (const length of gapLengths) {
        expect(Math.abs(length - EXPECTED_CLEARANCE_SECS), `${id} clearance`).toBeLessThanOrEqual(
          TOLERANCE_SECS,
        )
      }
    }
  })
})
