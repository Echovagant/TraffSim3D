// gridScene.spec.ts — the properties of the 5 x 5 grid scene.
//
// The grid is the scene the signal-coordination work is built on: 25
// signalised junctions, 40 segments, and **one vehicle per junction** so
// that every junction is seen queueing on the red and released on the
// green.
//
// What this file pins:
//
//   - the topology (25 junctions, 40 segments, the exact geometry);
//   - every junction carries **one light per axis group**, and the
//     geometry decides the groups (never a guess);
//   - every junction's box is the **one rule's** number
//     (`junctionRadius(4)` = 11.5 m);
//   - every vehicle starts **upstream** of the stop line of the junction
//     it approaches, with braking room, and **outside** every junction
//     box — a vehicle that starts inside a box is already "in the
//     junction" on frame one;
//   - the rows are phase-shifted against each other, so the 25 junctions
//     are 25 independent plans rather than one plan seen 25 times;
//   - every segment has a junction at **both** ends, which is what lets a
//     vehicle turn at the junction it arrives at.

import { describe, it, expect } from 'vitest'
import {
  buildGridNetwork,
  GRID_SIZE,
  GRID_SPACING_M,
  GRID_LANE_COUNT,
  GRID_SPEED_LIMIT,
  GRID_ROW_PHASE_SECS,
  GRID_SPAWN_S,
  gridJunctionId,
  gridEastWestRoadId,
  gridNorthSouthRoadId,
  gridJunctionPosition,
} from './defaultScene'
import { junctionRadius } from '@domain/services/junctionRadius'
import { approachAxisGroups } from '@domain/services/approachAxis'
import { laneForwardSign, stopLineSOnRoad, roadLength } from '@domain/services/laneGeometry'
import { inIntersectionBox } from '@domain/services/laneGeometry'
import { LightPhase } from '@domain/value-objects/Phase'
import { GREEN_PHASE_SECS } from '@shared/constants/simulation'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import type { Vehicle } from '@domain/entities/Vehicle'

describe('the 5 x 5 grid scene', () => {
  const net: RoadNetwork = buildGridNetwork()

  it('has 25 junctions and 40 segments', () => {
    expect(Object.keys(net.intersections).length).toBe(GRID_SIZE * GRID_SIZE)
    expect(Object.keys(net.roads).length).toBe(GRID_SIZE * (GRID_SIZE - 1) * 2)
  })

  it('places the junctions on a 120 m grid, centred on the origin', () => {
    for (let i = 0; i < GRID_SIZE; i++) {
      for (let j = 0; j < GRID_SIZE; j++) {
        const inter = net.intersections[gridJunctionId(i, j)]!
        expect(inter.position.x).toBe((j - (GRID_SIZE - 1) / 2) * GRID_SPACING_M)
        expect(inter.position.z).toBe((i - (GRID_SIZE - 1) / 2) * GRID_SPACING_M)
        expect(inter.position.y).toBe(0)
      }
    }
    // The map is 480 x 480 m.
    const xs = Object.values(net.intersections).map((i) => i.position.x)
    const zs = Object.values(net.intersections).map((i) => i.position.z)
    expect(Math.max(...xs) - Math.min(...xs)).toBe(GRID_SPACING_M * (GRID_SIZE - 1))
    expect(Math.max(...zs) - Math.min(...zs)).toBe(GRID_SPACING_M * (GRID_SIZE - 1))
  })

  it('builds every segment as a straight 4-lane road between two junctions', () => {
    for (const road of Object.values(net.roads)) {
      expect(road.laneCount).toBe(GRID_LANE_COUNT)
      expect(road.speedLimit).toBe(GRID_SPEED_LIMIT)
      // Two waypoints -> a straight segment.
      expect(road.waypoints ?? [road.startNode, road.endNode]).toHaveLength(2)
      expect(roadLength(road)).toBe(GRID_SPACING_M)
    }
  })

  it('gives every segment a junction at BOTH of its ends', () => {
    // This is what lets a vehicle turn at the junction it arrives at:
    // the turn only happens where the junction sits at the road's travel
    // end (`roadTransition.ts`).
    for (const road of Object.values(net.roads)) {
      const ends = Object.values(net.intersections).filter((inter) =>
        inter.connectedRoads.includes(road.id),
      )
      expect(ends.length, road.id).toBe(2)
    }
  })

  it('gives every junction one light per axis group, and the geometry decides', () => {
    for (const inter of Object.values(net.intersections)) {
      const axes = approachAxisGroups(inter, net.roads)
      const lightAxes = inter.trafficLights.map((l) => l.axis).sort()
      expect(lightAxes, inter.id).toEqual([...axes].sort())
      // A crossroads carries two lights; the map's corner junctions
      // carry two as well (they have an east-west AND a north-south arm).
      expect(inter.trafficLights.length, inter.id).toBe(2)
      expect(lightAxes, inter.id).toEqual(['ew', 'ns'])
    }
  })

  it('gives every light a unique id', () => {
    const ids = Object.values(net.intersections).flatMap((i) => i.trafficLights.map((l) => l.id))
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBe(GRID_SIZE * GRID_SIZE * 2)
  })

  it('sizes every junction box with the one rule', () => {
    for (const inter of Object.values(net.intersections)) {
      expect(inter.intersectionRadius, inter.id).toBe(junctionRadius(GRID_LANE_COUNT))
      // 4 lanes x 3.5 m = 14 m -> half-width 7 m, plus the 4.5 m
      // nose-overhang clearance.
      expect(inter.intersectionRadius).toBe(11.5)
    }
  })

  it('starts the two axis groups in opposition', () => {
    for (const inter of Object.values(net.intersections)) {
      const phases = inter.trafficLights.map((l) => l.phase).sort()
      expect(phases, inter.id).toEqual([LightPhase.Green, LightPhase.Red].sort())
    }
  })

  it('offsets the rows against each other, so the map is not one plan seen 25 times', () => {
    // Row i's ns green has already been running for `i * 6 s` when the
    // scene opens — the countdowns say so, and the SHAPE of every
    // junction (green + the other axis' countdown) is untouched.
    for (let i = 0; i < GRID_SIZE; i++) {
      for (let j = 0; j < GRID_SIZE; j++) {
        const inter = net.intersections[gridJunctionId(i, j)]!
        const ns = inter.trafficLights.find((l) => l.axis === 'ns')!
        const ew = inter.trafficLights.find((l) => l.axis === 'ew')!
        const shift = i * GRID_ROW_PHASE_SECS
        expect(ns.phaseRemaining, gridJunctionId(i, j)).toBeCloseTo(GREEN_PHASE_SECS - shift, 6)
        // The other axis waits for the whole rest of the cycle: the
        // green that is running + its yellow + the all-red clearance.
        expect(ew.phaseRemaining, gridJunctionId(i, j)).toBeCloseTo(
          GREEN_PHASE_SECS + 3 + 3 - shift,
          6,
        )
      }
    }
  })

  it('places one vehicle on every junction (25 of the 25)', () => {
    // The density is measured, not chosen: 25 vehicles (one per junction)
    // over 90 s hold 0 crash frames, 0 red-light runs, 0 stuck vehicles and
    // 0 lane-guard events, with 81 road changes and all 40 segments driven.
    //
    // A sparser layout (13 vehicles) was measured too; it is clean as well,
    // but it leaves a third of the map without traffic, and the scene is
    // the one the 25-junction signal work is built on.
    expect(Object.keys(net.vehicles).length).toBe(25)
    const approached = new Set(
      Object.values(net.vehicles).map((v) => {
        const road = net.roads[v.roadId]!
        const sign = laneForwardSign(v.laneIndex, road.laneCount)
        for (const inter of Object.values(net.intersections)) {
          if (!inter.connectedRoads.includes(road.id)) continue
          const stopS = stopLineSOnRoad(road, inter, v.laneIndex)
          if (stopS === null) continue
          const upstream = sign === 1 ? stopS - v.s : v.s - stopS
          if (upstream >= 0) return inter.id
        }
        return ''
      }),
    )
    // 25 distinct junctions, one per vehicle.
    expect(approached.size).toBe(25)
  })

  it('opens with traffic on BOTH axes', () => {
    // Measured: with every approach on the east–west road, the 12
    // north–south segments of the three inner columns were never driven
    // in 90 s — a third of the map stood empty. The approach therefore
    // alternates between the two axes.
    const vehicles = Object.values(net.vehicles)
    const eastWest = vehicles.filter((v) => v.roadId.startsWith('r-ew-')).length
    const northSouth = vehicles.filter((v) => v.roadId.startsWith('r-ns-')).length
    expect(eastWest).toBeGreaterThan(0)
    expect(northSouth).toBeGreaterThan(0)
    expect(eastWest + northSouth).toBe(vehicles.length)
  })

  it('starts every vehicle upstream of its stop line, with braking room', () => {
    for (const v of Object.values(net.vehicles)) {
      const road = net.roads[v.roadId]!
      const sign = laneForwardSign(v.laneIndex, road.laneCount)
      let closest: number | null = null
      for (const inter of Object.values(net.intersections)) {
        if (!inter.connectedRoads.includes(road.id)) continue
        const stopS = stopLineSOnRoad(road, inter, v.laneIndex)
        if (stopS === null) continue
        const upstream = sign === 1 ? stopS - v.s : v.s - stopS
        if (upstream < 0) continue
        if (closest === null || upstream < closest) closest = upstream
      }
      expect(closest, v.id).not.toBeNull()
      // 5 m is the braking distance of an 8 m/s car at MAX_DECEL.
      expect(closest!, v.id).toBeGreaterThanOrEqual(5)
    }
  })

  it('starts every vehicle OUTSIDE every junction box', () => {
    for (const v of Object.values(net.vehicles)) {
      const road = net.roads[v.roadId]!
      for (const inter of Object.values(net.intersections)) {
        if (!inter.connectedRoads.includes(road.id)) continue
        expect(
          inIntersectionBox(road, v.s, inter.intersectionRadius, inter),
          `${v.id} is inside ${inter.id} on frame one`,
        ).toBe(false)
      }
    }
  })

  it('puts every spawn point past the junction its segment starts at', () => {
    for (const sp of Object.values(net.spawnPoints)) {
      const road = net.roads[sp.roadId]!
      expect(sp.laneIndex).toBe(0)
      expect(sp.s).toBe(GRID_SPAWN_S)
      // The segment starts AT a junction, whose box reaches
      // `junctionRadius(4)` = 11.5 m into it.
      expect(sp.s).toBeGreaterThan(junctionRadius(GRID_LANE_COUNT))
      for (const inter of Object.values(net.intersections)) {
        if (!inter.connectedRoads.includes(road.id)) continue
        expect(inIntersectionBox(road, sp.s, inter.intersectionRadius, inter), sp.id).toBe(false)
      }
    }
  })

  it('names the segments so that the junction graph is walkable', () => {
    // The east–west segment of row i between the columns j and j + 1.
    expect(net.roads[gridEastWestRoadId(0, 0)]!.startNode).toEqual(
      expect.objectContaining({ x: -240, z: -240 }),
    )
    expect(net.roads[gridEastWestRoadId(0, 0)]!.endNode).toEqual(
      expect.objectContaining({ x: -120, z: -240 }),
    )
    // The north–south segment of column j between the rows i and i + 1.
    expect(net.roads[gridNorthSouthRoadId(0, 0)]!.startNode).toEqual(
      expect.objectContaining({ x: -240, z: -240 }),
    )
    expect(net.roads[gridNorthSouthRoadId(0, 0)]!.endNode).toEqual(
      expect.objectContaining({ x: -240, z: -120 }),
    )
  })

  it('gives the middle junction the centre of the map', () => {
    expect(gridJunctionPosition(2, 2)).toEqual({ x: 0, y: 0, z: 0 })
  })
})
