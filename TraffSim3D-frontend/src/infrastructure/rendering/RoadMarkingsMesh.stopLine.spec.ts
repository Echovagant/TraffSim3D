// src/infrastructure/rendering/RoadMarkingsMesh.stopLine.spec.ts
//
// The painted stop line and the enforced stop line must be the SAME
// line. The renderer reads the intersection projection through
// `roadStopLines` (domain/services/laneGeometry.ts), the traffic logic
// reads it through `stopLineSOnRoad` — one source, two consumers.
//
// This spec checks that the painted geometry lands on the projected
// arc length, and (the important one) that a vehicle standing exactly
// on a painted line is held by the traffic light while a vehicle 1 m
// past it is committed — i.e. the line you can see is the line that
// stops the car.

import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { createRoadMarkings } from './RoadMarkingsMesh'
import { tick } from '@application/services/tick'
import type { TickContext } from '@application/services/tick'
import { createRoadNetwork } from '@domain/entities/RoadNetwork'
import { LaneId } from '@domain/value-objects/LaneId'
import { LightPhase } from '@domain/value-objects/Phase'
import {
  lanePoint,
  roadLength,
  roadStopLines,
  stopLineSOnRoad,
  worldToCenterlineS,
} from '@domain/services/laneGeometry'
import type { Intersection } from '@domain/entities/Intersection'
import type { Road } from '@domain/entities/Road'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import type { Vehicle } from '@domain/entities/Vehicle'

const DT = 1 / 60

const makeCtx = (): TickContext => ({
  rapierWorld: null,
  signal: null,
  trajectoryExporter: null,
  sensorRegistry: null,
  lidarEnabled: false,
  getHostPose: () => null,
  fixedStepScheduler: null,
  draggingId: null,
  removeVehicle: () => {},
  policy: null,
  replayTargetId: null,
})

/** A straight NS road, 100 m long, 4 lanes (2 per direction). */
const makeRoad = (id = 'r-1'): Road => ({
  id,
  startNode: { x: 0, y: 0, z: -50 },
  endNode: { x: 0, y: 0, z: 50 },
  laneCount: 4,
  speedLimit: 16.67,
  level: 0,
})

/** A junction that sits 20 m along the road — NOT at the midpoint. */
const makeIntersection = (id: string, s: number, radius = 8): Intersection => ({
  id,
  position: { x: 0, y: 0, z: -50 + s },
  trafficLights: [],
  connectedRoads: ['r-1'],
  intersectionRadius: radius,
})

/** The arc lengths of the painted (white) stop lines. */
const paintedStopLines = (road: Road, intersections: readonly Intersection[]): number[] => {
  const group = createRoadMarkings([road], { intersections })
  const lines: number[] = []
  for (const child of group.children) {
    if (!(child instanceof THREE.LineSegments)) continue
    const p = child.geometry.attributes.position!.array as Float32Array
    // The stop lines are the paint at 0.03u above the road; the arrows
    // sit at 0.025u and the dashes and the centre line at 0.02u.
    for (let i = 0; i < p.length; i += 6) {
      if (Math.abs(p[i + 1]! - 0.03) > 1e-6) continue
      const midX = (p[i]! + p[i + 3]!) / 2
      const midZ = (p[i + 2]! + p[i + 5]!) / 2
      lines.push(worldToCenterlineS(road, midX, midZ).s)
    }
  }
  return lines.sort((a, b) => a - b)
}

/** A network with one red light at `junctionS` along the road. */
const buildNetwork = (junctionS: number): RoadNetwork => {
  const net = createRoadNetwork()
  net.roads['r-1'] = makeRoad()
  net.intersections['i-1'] = {
    id: 'i-1',
    position: { x: 0, y: 0, z: -50 + junctionS },
    connectedRoads: ['r-1'],
    trafficLights: [
      {
        id: 'tl-1',
        position: { x: 0, y: 0, z: -50 + junctionS },
        phase: LightPhase.Red,
        phaseRemaining: 300,
        cycleSeconds: 63,
        axis: 'ns',
      },
    ],
    intersectionRadius: 8,
  }
  return net
}

const addVehicle = (net: RoadNetwork, s: number, laneIndex: number): Vehicle => {
  const road = net.roads['r-1']!
  const lp = lanePoint(road, laneIndex, s)
  const v: Vehicle = {
    id: 'v-1',
    type: 'car',
    color: '#3a86ff',
    position: { ...lp.position },
    heading: lp.heading,
    speed: 0,
    targetSpeed: road.speedLimit,
    roadId: 'r-1',
    laneIndex,
    s,
    lane: LaneId.make('r-1', laneIndex),
    status: 'driving',
    desiredStatus: 'driving',
    enteredIntersectionAt: null,
    desiredLaneIndex: null,
    laneChangeStartedAt: null,
    spawnedAt: 0,
  }
  net.vehicles['v-1'] = v
  return v
}

describe('the painted stop line', () => {
  const road = makeRoad()
  const inter = makeIntersection('i-1', 20)

  it('lands on the projected junction, not on the road midpoint', () => {
    const painted = paintedStopLines(road, [inter])
    expect(painted).toHaveLength(2)
    // Forward approach: 20 - 8 = 12. Backward approach: 20 + 8 = 28.
    expect(painted[0]).toBeCloseTo(12, 6)
    expect(painted[1]).toBeCloseTo(28, 6)
    // The old assumption painted the lines at 5 / 95 (the road ends).
    expect(painted[0]).not.toBeCloseTo(5, 3)
    expect(painted[1]).not.toBeCloseTo(95, 3)
  })

  it('is computed from the same source as the traffic logic', () => {
    const painted = paintedStopLines(road, [inter])
    const logic = roadStopLines(road, [inter])
    expect(painted).toHaveLength(logic.length)
    for (const [i, s] of logic.entries()) {
      expect(painted[i]).toBeCloseTo(s, 9)
    }
    // …and `stopLineSOnRoad` — the function tick.ts brakes on — agrees.
    expect(logic[0]).toBeCloseTo(stopLineSOnRoad(road, inter, 0) as number, 9)
    expect(logic[1]).toBeCloseTo(stopLineSOnRoad(road, inter, road.laneCount - 1) as number, 9)
  })

  it('is where the traffic light actually stops the vehicle', () => {
    const painted = paintedStopLines(road, [inter])

    // Forward approach: lane 0 travels towards a larger s.
    const netF = buildNetwork(20)
    const vf = addVehicle(netF, painted[0]!, 0)
    tick(netF, DT, DT, makeCtx())
    expect(vf.targetSpeed).toBe(0) // held ON the painted line
    vf.s = painted[0]! + 1
    tick(netF, DT, 2 * DT, makeCtx())
    expect(vf.targetSpeed).toBeGreaterThan(0) // committed past it

    // Backward approach: lane 3 travels towards a smaller s.
    const netB = buildNetwork(20)
    const vb = addVehicle(netB, painted[1]!, 3)
    tick(netB, DT, DT, makeCtx())
    expect(vb.targetSpeed).toBe(0)
    vb.s = painted[1]! - 1
    tick(netB, DT, 2 * DT, makeCtx())
    expect(vb.targetSpeed).toBeGreaterThan(0)
  })

  it('paints nothing on a road without a junction', () => {
    expect(paintedStopLines(road, [])).toHaveLength(0)
  })

  it('paints the cross scene at the junction edges', () => {
    // The cross scene: the junction is at the road midpoint (s = 30 of
    // 60) with radius 8 → the lines sit at 22 and 38.
    const cross = makeRoad('r-cross')
    const junction: Intersection = {
      id: 'i-center',
      position: { x: 0, y: 0, z: 0 },
      trafficLights: [],
      connectedRoads: ['r-cross'],
      intersectionRadius: 8,
    }
    // The cross road runs -30..+30, so build a matching road.
    const crossRoad: Road = {
      id: 'r-cross',
      startNode: { x: 0, y: 0, z: -30 },
      endNode: { x: 0, y: 0, z: 30 },
      laneCount: 6,
      speedLimit: 16.67,
      level: 0,
    }
    const painted = paintedStopLines(crossRoad, [junction])
    expect(painted).toHaveLength(2)
    expect(painted[0]).toBeCloseTo(22, 6)
    expect(painted[1]).toBeCloseTo(38, 6)
    // The old assumption painted them at 5 / 55 — 25 m away from the
    // junction they belong to.
    expect(roadLength(crossRoad)).toBe(60)
  })
})
