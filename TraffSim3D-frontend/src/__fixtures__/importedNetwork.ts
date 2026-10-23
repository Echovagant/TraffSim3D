// src/__fixtures__/importedNetwork.ts
//
// A network shaped like an **imported OSM map**.
//
// The built-in demo scenes name their roads `r-ns` / `r-ew`, and the
// old queue lookup leaned on exactly that convention (`r-${light.axis}`).
// An imported map names its roads `w-<wayId>` — no id encodes an axis —
// so the axis has to be read from the road's geometry and the road has
// to be found through the network's topology.
//
// This fixture reproduces that shape:
//
// - `w-101` — NS main road (runs along Z)
// - `w-102` — EW main road (runs along X)
// - `w-103` — EW branch road (runs along X at an angle)
//
// One intersection connects all three, so the axis of a light has to be
// decided by geometry: the NS light may only see `w-101`, while the EW
// light sees `w-102` **and** `w-103`.

import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import type { TrafficLight } from '@domain/entities/TrafficLight'
import { createRoadNetwork } from '@domain/entities/RoadNetwork'
import { LaneId } from '@domain/value-objects/LaneId'
import { LightPhase } from '@domain/value-objects/Phase'
import { makeTestVehicle } from './testNetwork'

/** NS main road — runs along Z. */
export const IMPORTED_NS_ROAD_ID = 'w-101'
/** EW main road — runs along X. */
export const IMPORTED_EW_ROAD_ID = 'w-102'
/** EW branch road — runs along X at an angle. */
export const IMPORTED_BRANCH_ROAD_ID = 'w-103'

export const IMPORTED_NS_LIGHT_ID = 'tl-osm-ns'
export const IMPORTED_EW_LIGHT_ID = 'tl-osm-ew'
export const IMPORTED_INTERSECTION_ID = 'i-osm-1'

export const makeImportedLight = (overrides: Partial<TrafficLight> = {}): TrafficLight => ({
  id: IMPORTED_NS_LIGHT_ID,
  position: { x: -3, y: 0, z: 0 },
  phase: LightPhase.Green,
  phaseRemaining: 30,
  cycleSeconds: 63,
  axis: 'ns',
  ...overrides,
})

/**
 * An imported-map network with four queued cars:
 *
 * - `v-osm-ns-1` / `v-osm-ns-2` — on the NS road, lanes 0 and 1
 * - `v-osm-ew-1` — on the EW main road
 * - `v-osm-branch-1` — on the EW branch road
 *
 * All four sit before their road's stop line, so every axis has a
 * non-zero queue — the state the old `r-${axis}` lookup could never
 * reach on an imported map.
 */
export const buildImportedNetwork = (): RoadNetwork => {
  const net = createRoadNetwork()

  net.roads[IMPORTED_NS_ROAD_ID] = {
    id: IMPORTED_NS_ROAD_ID,
    startNode: { x: 0, y: 0, z: -60 },
    endNode: { x: 0, y: 0, z: 120 },
    laneCount: 2,
    speedLimit: 13.89,
    level: 0,
  }
  net.roads[IMPORTED_EW_ROAD_ID] = {
    id: IMPORTED_EW_ROAD_ID,
    startNode: { x: -60, y: 0, z: 0 },
    endNode: { x: 60, y: 0, z: 0 },
    laneCount: 2,
    speedLimit: 13.89,
    level: 0,
  }
  net.roads[IMPORTED_BRANCH_ROAD_ID] = {
    id: IMPORTED_BRANCH_ROAD_ID,
    startNode: { x: 0, y: 0, z: 0 },
    endNode: { x: 45, y: 0, z: -25 },
    laneCount: 2,
    speedLimit: 13.89,
    level: 0,
  }

  net.intersections[IMPORTED_INTERSECTION_ID] = {
    id: IMPORTED_INTERSECTION_ID,
    position: { x: 0, y: 0, z: 0 },
    trafficLights: [
      makeImportedLight({ id: IMPORTED_NS_LIGHT_ID, axis: 'ns' }),
      makeImportedLight({
        id: IMPORTED_EW_LIGHT_ID,
        axis: 'ew',
        phase: LightPhase.Red,
        position: { x: 0, y: 0, z: -3 },
      }),
    ],
    connectedRoads: [IMPORTED_NS_ROAD_ID, IMPORTED_EW_ROAD_ID, IMPORTED_BRANCH_ROAD_ID],
    intersectionRadius: 8,
  }

  const cars = [
    makeTestVehicle({
      id: 'v-osm-ns-1',
      roadId: IMPORTED_NS_ROAD_ID,
      laneIndex: 0,
      lane: LaneId.make(IMPORTED_NS_ROAD_ID, 0),
      s: 10,
      position: { x: 0, y: 0, z: -50 },
    }),
    makeTestVehicle({
      id: 'v-osm-ns-2',
      roadId: IMPORTED_NS_ROAD_ID,
      laneIndex: 1,
      lane: LaneId.make(IMPORTED_NS_ROAD_ID, 1),
      // Lane 1 of a two-lane road is a **backward** lane: it travels from
      // the end of the road towards the start, so it approaches the
      // junction from the far side. Its stop line is therefore at
      // `centerS + radius` = 60 + 8 = 68, and a car queueing for the
      // light sits **beyond** that arc length — at s = 90 here, on a
      // road that now runs from z = -60 to z = 120 (length 180).
      s: 90,
      position: { x: 3, y: 0, z: 30 },
    }),
    makeTestVehicle({
      id: 'v-osm-ew-1',
      roadId: IMPORTED_EW_ROAD_ID,
      laneIndex: 0,
      lane: LaneId.make(IMPORTED_EW_ROAD_ID, 0),
      s: 10,
      position: { x: -50, y: 0, z: 0 },
    }),
    makeTestVehicle({
      id: 'v-osm-branch-1',
      roadId: IMPORTED_BRANCH_ROAD_ID,
      laneIndex: 0,
      lane: LaneId.make(IMPORTED_BRANCH_ROAD_ID, 0),
      s: 10,
      position: { x: 9, y: 0, z: -5 },
    }),
  ]
  for (const car of cars) net.vehicles[car.id] = car

  return net
}

/** The NS light of the imported network. */
export const importedNsLight = (network: RoadNetwork): TrafficLight =>
  network.intersections[IMPORTED_INTERSECTION_ID]!.trafficLights[0]!

/** The EW light of the imported network. */
export const importedEwLight = (network: RoadNetwork): TrafficLight =>
  network.intersections[IMPORTED_INTERSECTION_ID]!.trafficLights[1]!
