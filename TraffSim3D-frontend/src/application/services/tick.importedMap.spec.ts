// src/application/services/tick.importedMap.spec.ts
//
// The traffic rules on a network shaped like an **imported OSM city**.
//
// An OSM way has a junction at BOTH ends (the two crossroads it
// connects), and a district holds thousands of roads that never touch
// each other. Two rules have to hold on such a network:
//
//   1. **The intersection-occupancy rule sees EVERY junction on the
//      road**, not just the first one. A way with a crossroads at each
//      end has two boxes; the old code only ever looked at the first, so
//      a car driving through the second crossroads was never "in the
//      intersection".
//   2. **The cross-road yield rule only fires between roads that
//      actually meet at a junction.** Without that test, a car entering
//      any junction in the district froze every other car in the
//      district.
//
// Both were measured on the real Shenzhen extract (391 roads / 450
// junctions, 8 cars, 90 s) and both failed:
//
//   - the occupancy rule missed 4 952 of 43 200 vehicle-frames;
//   - the yield rule fired 8 159 times, EVERY one of them between two
//     roads with no junction in common, at distances up to 2 073 m — and
//     the car that had to wait was 452 m from its own nearest junction.
//
// The specs below pin the fixed behaviour, and the geometry they use is
// the OSM shape (a junction at a way ENDPOINT), not the built-in
// midpoint shape.

import { describe, it, expect } from 'vitest'
import { tick } from './tick'
import type { TickContext } from './tick'
import { createRoadNetwork } from '@domain/entities/RoadNetwork'
import { LaneId } from '@domain/value-objects/LaneId'
import { LightPhase } from '@domain/value-objects/Phase'
import { junctionRadius } from '@domain/services/junctionRadius'
import { lanePoint } from '@domain/services/laneGeometry'
import { VEHICLE_BODY_SPEC } from '@shared/constants/simulation'
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

/**
 * The OSM shape:
 *
 *   w-ns  : (0,0,0) ───────────────▶ (0,0,200)     4 lanes
 *            │                          │
 *        i-south (0,0,0)          i-north (0,0,200)
 *            │
 *   w-ew  : (-100,0,0) ─────────▶ (0,0,0)        2 lanes
 *
 *   w-far : (500,0,0) ──────────▶ (500,0,200)     2 lanes, NO junction
 *
 * `i-south` is where w-ns and w-ew meet; `i-north` is the other end of
 * the OSM way; `w-far` is a road in the same district that never touches
 * anything the other two touch.
 */
const buildNetwork = (): RoadNetwork => {
  const net = createRoadNetwork()
  net.roads['w-ns'] = {
    id: 'w-ns',
    startNode: { x: 0, y: 0, z: 0 },
    endNode: { x: 0, y: 0, z: 200 },
    laneCount: 4,
    speedLimit: 16.67,
    level: 0,
  }
  net.roads['w-ew'] = {
    id: 'w-ew',
    startNode: { x: -100, y: 0, z: 0 },
    endNode: { x: 0, y: 0, z: 0 },
    laneCount: 2,
    speedLimit: 16.67,
    level: 0,
  }
  net.roads['w-far'] = {
    id: 'w-far',
    startNode: { x: 500, y: 0, z: 0 },
    endNode: { x: 500, y: 0, z: 200 },
    laneCount: 2,
    speedLimit: 16.67,
    level: 0,
  }
  net.intersections['i-south'] = {
    id: 'i-south',
    position: { x: 0, y: 0, z: 0 },
    connectedRoads: ['w-ns', 'w-ew'],
    trafficLights: [
      {
        id: 'tl-south',
        position: { x: 0, y: 0, z: 0 },
        phase: LightPhase.Red,
        phaseRemaining: 300,
        cycleSeconds: 63,
        axis: 'ns',
      },
    ],
    // The widest connected road is w-ns (4 lanes → half-width 7 m), so
    // the box is 7 + 4.5 = 11.5 m.
    intersectionRadius: junctionRadius(4),
  }
  net.intersections['i-north'] = {
    id: 'i-north',
    position: { x: 0, y: 0, z: 200 },
    connectedRoads: ['w-ns'],
    trafficLights: [],
    intersectionRadius: junctionRadius(4),
  }
  return net
}

const addVehicle = (
  net: RoadNetwork,
  id: string,
  roadId: string,
  s: number,
  laneIndex: number,
  speed = 0,
): Vehicle => {
  const road = net.roads[roadId]!
  const lp = lanePoint(road, laneIndex, s)
  const v: Vehicle = {
    id,
    type: 'car',
    color: '#3a86ff',
    position: { ...lp.position },
    heading: lp.heading,
    speed,
    targetSpeed: road.speedLimit,
    roadId,
    laneIndex,
    s,
    lane: LaneId.make(roadId, laneIndex),
    status: 'driving',
    desiredStatus: 'driving',
    enteredIntersectionAt: null,
    desiredLaneIndex: null,
    laneChangeStartedAt: null,
    spawnedAt: 0,
  }
  net.vehicles[id] = v
  return v
}

const run = (net: RoadNetwork, ticks: number, ctx: TickContext = makeCtx()): void => {
  for (let i = 0; i < ticks; i++) tick(net, DT, (i + 1) * DT, ctx)
}

// ---------------------------------------------------------------------------
// 1. The occupancy rule sees every junction on the road
// ---------------------------------------------------------------------------

describe('the intersection-occupancy rule sees every junction on the road', () => {
  it('marks a vehicle in the SECOND junction box of the road', () => {
    const net = buildNetwork()
    // The far end of the OSM way: 200 m along, i.e. inside i-north's box
    // (200 ± 11.5 m).
    const v = addVehicle(net, 'v-1', 'w-ns', 200, 0)
    tick(net, DT, DT, makeCtx())
    expect(v.enteredIntersectionAt).not.toBeNull()
  })

  it('still marks a vehicle in the FIRST junction box', () => {
    const net = buildNetwork()
    const v = addVehicle(net, 'v-1', 'w-ns', 0, 0)
    tick(net, DT, DT, makeCtx())
    expect(v.enteredIntersectionAt).not.toBeNull()
  })

  it('leaves a vehicle between the two junctions outside every box', () => {
    const net = buildNetwork()
    const v = addVehicle(net, 'v-1', 'w-ns', 100, 0)
    tick(net, DT, DT, makeCtx())
    expect(v.enteredIntersectionAt).toBeNull()
  })

  it('gives a road with no junction no box at all', () => {
    const net = buildNetwork()
    // The old fallback put a phantom 10 m box at the road's midpoint, so
    // a car halfway along a street with no crossroads counted as "in the
    // intersection" — and the cross-road yield rule then treated it as
    // traffic that had already entered.
    const v = addVehicle(net, 'v-1', 'w-far', 100, 0)
    tick(net, DT, DT, makeCtx())
    expect(v.enteredIntersectionAt).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 2. The cross-road yield rule needs the two roads to meet
// ---------------------------------------------------------------------------

describe('the cross-road yield rule needs the two roads to meet', () => {
  it('stops a car on a road that crosses the one with the car in the box', () => {
    const net = buildNetwork()
    // The car on w-ns sits in i-south's box …
    addVehicle(net, 'v-in', 'w-ns', 0, 0)
    // … and the car on w-ew has to give way: the two roads meet there.
    const crossing = addVehicle(net, 'v-cross', 'w-ew', 50, 0)
    tick(net, DT, DT, makeCtx())
    expect(crossing.targetSpeed).toBe(0)
  })

  it('does NOT stop a car on a road that never meets the one in the box', () => {
    const net = buildNetwork()
    addVehicle(net, 'v-in', 'w-ns', 0, 0)
    // w-far is 500 m away and shares no junction with w-ns.
    const far = addVehicle(net, 'v-far', 'w-far', 50, 0)
    tick(net, DT, DT, makeCtx())
    expect(far.targetSpeed).toBeGreaterThan(0)
  })

  it('does not let a car stop a car that is already inside the box', () => {
    const net = buildNetwork()
    // Both cars are INSIDE i-south's box: the one on w-ns sits at the
    // junction (s = 0 is the way's start, and the junction is there), the
    // one on w-ew at the way's end (s = 100).
    const inBox = addVehicle(net, 'v-in', 'w-ns', 0, 0)
    const crossing = addVehicle(net, 'v-cross', 'w-ew', 100, 0)
    tick(net, DT, DT, makeCtx())
    // Both are committed → neither yields.
    expect(crossing.targetSpeed).toBeGreaterThan(0)
    expect(inBox.targetSpeed).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 3. The nose of a queued vehicle stays out of the crossing carriageway
// ---------------------------------------------------------------------------

describe('a queued vehicle at an imported junction keeps its nose clear', () => {
  it('stops with the nose outside the crossing road', () => {
    const net = buildNetwork()
    // The backward lanes of w-ns approach i-south (at s = 0) and stop at
    // `centerS + radius` = 11.5 m.
    const v = addVehicle(net, 'v-1', 'w-ns', 60, 2, 12)
    run(net, 300)
    expect(v.speed).toBe(0)
    const halfLen = VEHICLE_BODY_SPEC.car.length / 2
    // The nose is at `s - halfLen` (a backward lane travels towards a
    // smaller s). The crossing road w-ew is 2 lanes wide, so its
    // carriageway reaches 3.5 m from its centreline.
    const crossingHalfWidth = (2 * 3.5) / 2
    expect(v.s - halfLen).toBeGreaterThan(crossingHalfWidth)
  })

  it('never lets the centre of a stopped vehicle sit past the stop line', () => {
    const net = buildNetwork()
    const v = addVehicle(net, 'v-1', 'w-ns', 60, 2, 12)
    run(net, 300)
    // The stop line is at centerS + radius = 0 + 11.5.
    expect(v.s).toBeGreaterThan(11.5)
  })
})
