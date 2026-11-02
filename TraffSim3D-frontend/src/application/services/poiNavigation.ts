// src/application/services/poiNavigation.ts
//
// Driving to a POINT OF INTEREST.
//
// The route planner addresses places two ways: a **junction**, or the
// **directional end of a road** (how a moving car is addressed — it is
// on a road, heading for one of that road's two ends). A POI is
// neither: it is a place **beside** a road, at the kerb.
//
// So the browser has to answer one question before it can ask the
// backend for a route: **which road is this POI on, and which way
// along it?** That is what this module does — it is pure geometry
// over the scene's roads, and the answer is a route endpoint the
// backend already understands.
//
// Why the direction matters: the backend resolves a road endpoint to
// the node the traveller ARRIVES at — the road's last waypoint when
// the direction is 'forward', its first when it is 'backward'. Picking
// the wrong one ends the route at the far end of the block, which is
// the wrong side of the POI entirely.

import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import type { Vehicle } from '@domain/entities/Vehicle'
import { laneForwardSign } from '@domain/services/laneGeometry'

/** A POI, as far as the navigation cares. */
export interface PoiTarget {
  id: string
  name: string
  category: string
  /** The scene position: metres east of the origin. */
  x: number
  /** The scene position: metres north of the origin (the scene's z). */
  z: number
}

/** A road endpoint, in the shape the route client sends. */
export interface PoiRouteEnd {
  roadId: string
  direction: 'forward' | 'backward'
}

/**
 * How close (m) the driver has to be to the POI to count as arrived.
 *
 * A POI stands at the kerb and the car drives in its lane — about
 * five metres to the side — so the radius has to cover the lateral
 * gap plus the car's own width. It is deliberately larger than the
 * RL task's 10 m: here the driver may stop anywhere on the road,
 * not exactly at the point.
 */
export const POI_ARRIVAL_RADIUS_M = 20.0

/** The distance from a point to a segment, in the XZ plane. */
const distanceToSegment = (
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number => {
  const dx = bx - ax
  const dz = bz - az
  const lengthSquared = dx * dx + dz * dz
  if (lengthSquared < 1e-9) return Math.hypot(px - ax, pz - az)
  let t = ((px - ax) * dx + (pz - az) * dz) / lengthSquared
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz))
}

/**
 * The road's line: its waypoints, or — for a road that carries only
 * its two ends — the straight line between them.
 *
 * The built-in scenes' roads have **no** `waypoints` (they are two
 * nodes and a straight line between them), so a search that only
 * looked at `waypoints` would find no road at all — which is exactly
 * what the first version did ("这个兴趣点附近没有道路" on a scene
 * that is nothing but roads).
 */
const roadLine = (road: RoadNetwork['roads'][string]): { x: number; z: number }[] => {
  if (road.waypoints && road.waypoints.length > 0) {
    return road.waypoints.map((point) => ({ x: point.x, z: point.z }))
  }
  if (road.startNode && road.endNode) {
    return [
      { x: road.startNode.x, z: road.startNode.z },
      { x: road.endNode.x, z: road.endNode.z },
    ]
  }
  return []
}

/**
 * The road a POI sits next to, and the direction that ends nearest it.
 *
 * The road whose **line** passes closest wins; the direction is the
 * one whose END is closer to the POI — because that end is where the
 * route will finish, and finishing at the far end of the block would
 * leave the car a whole block away from where it was asked to go.
 *
 * Returns `null` when the scene has no roads to speak of.
 */
export const nearestRoadToPoi = (
  network: RoadNetwork,
  poi: { x: number; z: number },
): PoiRouteEnd | null => {
  let bestRoadId: string | null = null
  let bestDistance = Infinity
  let bestDirection: 'forward' | 'backward' = 'forward'

  for (const road of Object.values(network.roads)) {
    const line = roadLine(road)
    if (line.length === 0) continue

    let roadDistance = Infinity
    for (let i = 0; i + 1 < line.length; i += 1) {
      const a = line[i]!
      const b = line[i + 1]!
      roadDistance = Math.min(roadDistance, distanceToSegment(poi.x, poi.z, a.x, a.z, b.x, b.z))
    }
    if (roadDistance < bestDistance) {
      const first = line[0]!
      const last = line[line.length - 1]!
      const toFirst = Math.hypot(poi.x - first.x, poi.z - first.z)
      const toLast = Math.hypot(poi.x - last.x, poi.z - last.z)
      bestRoadId = road.id
      bestDistance = roadDistance
      // 'forward' arrives at the road's LAST waypoint.
      bestDirection = toLast <= toFirst ? 'forward' : 'backward'
    }
  }

  if (bestRoadId === null) return null
  return { roadId: bestRoadId, direction: bestDirection }
}

/** How far a vehicle is from a POI, in metres (the XZ plane). */
export const distanceToPoi = (vehicle: Vehicle, poi: { x: number; z: number }): number =>
  Math.hypot(vehicle.position.x - poi.x, vehicle.position.z - poi.z)

/** Whether a vehicle has reached the POI. */
export const hasArrivedAtPoi = (vehicle: Vehicle, poi: { x: number; z: number }): boolean =>
  distanceToPoi(vehicle, poi) <= POI_ARRIVAL_RADIUS_M

/**
 * Is this POI on the DRIVER's own road — and if so, ahead of it or
 * behind it?
 *
 * Behind is the case that needs a U-turn: the driver is committed to
 * the end of their road, and the only way to a destination on that
 * road behind them is to drive to the end and turn around. Ahead needs
 * nothing — the route to the road's end passes the POI on the way, and
 * the arrival is the distance.
 *
 * `laneForwardSign` gives which way the car is actually travelling on
 * its road (`forward` = the road's start→end direction).
 */
export const poiAheadOrBehind = (
  network: RoadNetwork,
  vehicle: Vehicle,
  poi: { x: number; z: number },
): { sameRoad: boolean; behind: boolean } => {
  const snap = nearestRoadToPoi(network, poi)
  if (!snap || snap.roadId !== vehicle.roadId) return { sameRoad: false, behind: false }
  const road = network.roads[vehicle.roadId]
  const laneCount = road?.laneCount ?? vehicle.laneIndex + 1
  const driverDirection: 'forward' | 'backward' =
    laneForwardSign(vehicle.laneIndex, laneCount) === 1 ? 'forward' : 'backward'
  return { sameRoad: true, behind: snap.direction !== driverDirection }
}
