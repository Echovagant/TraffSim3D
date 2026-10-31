// src/application/services/routePlanner.ts
//
// Turning a backend route plan into something the simulation can drive.
//
// The backend answers "which roads, in which order"; the browser has to
// answer three more questions:
//
//   1. **Where does the route start?** The backend's legs begin at the
//      node the traveller reaches *next* — the end of the road it is on.
//      The road the traveller is on right now is the route's first
//      entry, so the browser prepends it.
//   2. **What does the route look like?** The legs carry their two
//      nodes' positions; the browser turns them into one polyline,
//      starting at the vehicle itself.
//   3. **Which road comes next?** A car asks for the next road only
//      when it reaches the end of the one it is on. The route's road
//      list answers that, as long as the progress along it is tracked.
//
// Everything here is pure: the network in, the plan out. The store
// owns the state (which vehicle follows, how far along the route it is).

import type { Position } from '@domain/value-objects/Position'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import type { Vehicle } from '@domain/entities/Vehicle'
import { laneForwardSign, laneOffset } from '@domain/services/laneGeometry'
import type {
  RouteEndpoint,
  RouteLeg,
  RoutePlanResponse,
  RouteNetworkPayload,
} from '@infrastructure/api/routeClient'

/**
 * A route the browser can drive and draw.
 *
 * `roads` is the ordered list of roads to take, starting with the road
 * the follower is on when the route was planned.
 */
export interface PlannedRoute {
  /** The roads to take, in order. */
  roads: string[]
  /** The route's polyline, in world coordinates. */
  points: Position[]
  /** The route's length in metres. */
  lengthM: number
  /** The legs, as the backend returned them. */
  legs: RouteLeg[]
  /** The junction the route was planned to. */
  destinationJunctionId: string
}

/**
 * The scene network in the shape the backend reads.
 *
 * The backend's graph builder consumes the same `serializeNetwork`
 * output the browser writes to disk, so the scene goes over the wire
 * exactly as it is stored.
 */
export const routeNetworkPayload = (network: RoadNetwork): RouteNetworkPayload => ({
  roads: Object.values(network.roads),
  intersections: Object.values(network.intersections),
  vehicles: Object.values(network.vehicles),
  spawnPoints: Object.values(network.spawnPoints),
})

/**
 * The start of a route planned from a moving vehicle.
 *
 * A car is not at a junction: it is on a road, heading for one of that
 * road's two ends. The direction matters — a car on a backward lane
 * arrives at the road's *first* waypoint, not its last.
 */
export const routeStartFor = (network: RoadNetwork, vehicle: Vehicle): RouteEndpoint => {
  const road = network.roads[vehicle.roadId]
  // A vehicle whose road has vanished (a scene swap under it) falls back
  // to a lane count that makes its own lane index a forward lane — the
  // direction is then wrong, and the backend's route will simply not be
  // drivable, which is the honest outcome.
  const laneCount = road?.laneCount ?? vehicle.laneIndex + 1
  return {
    roadId: vehicle.roadId,
    direction: laneForwardSign(vehicle.laneIndex, laneCount) === 1 ? 'forward' : 'backward',
  }
}

/**
 * The planned route for a vehicle and a destination junction.
 *
 * Returns `null` when the backend found no path — the caller shows that
 * to the user rather than pretending the vehicle is on a route.
 *
 * The polyline is drawn **on the lane the car drives**, not on the road's
 * centre line. The backend's legs are road-level (a junction to a
 * junction), so their nodes sit on the centre line — five metres from
 * where the car actually is. A ribbon there reads as "another lane",
 * which is exactly the wrong message.
 *
 * The keep-right rule makes the offset uniform: whichever direction a
 * road is travelled in, the car sits `laneOffset(0, laneCount)` to the
 * **right of its direction of travel** (`laneOffset` in `laneGeometry`).
 * So every leg's nodes are pushed to the right of that leg's direction,
 * and the junction between two legs gets one point per side — the
 * diagonal across the junction is the turn, and it is the same sweep the
 * car's own pivot makes.
 */
export const plannedRouteFrom = (
  network: RoadNetwork,
  response: RoutePlanResponse,
  vehicle: Vehicle,
  destinationJunctionId: string,
): PlannedRoute | null => {
  if (!response.found || response.legs.length === 0) return null

  const roads = [vehicle.roadId, ...response.roads.filter((id) => id !== vehicle.roadId)]

  const points: Position[] = [
    { x: vehicle.position.x, y: vehicle.position.y, z: vehicle.position.z },
  ]
  for (let i = 0; i < response.legs.length; i += 1) {
    const leg = response.legs[i]!
    const roadId = roads[i + 1] ?? leg.road_id
    const road = network.roads[roadId]
    const laneCount = road?.laneCount ?? 2

    // The junction this leg starts at is reached on the PREVIOUS road's
    // lane — the car is still on that road when it gets there.
    const previousRoad = network.roads[roads[i] ?? roadId]
    const previousLaneCount = previousRoad?.laneCount ?? laneCount
    const previousDirection =
      i === 0
        ? { x: Math.cos(vehicle.heading), z: Math.sin(vehicle.heading) }
        : directionOf(response.legs[i - 1]!)
    points.push(offsetToLane(leg.from, previousDirection, laneOffset(0, previousLaneCount)))

    // The junction this leg ends at is left on THIS road's lane.
    const direction = directionOf(leg)
    points.push(offsetToLane(leg.to, direction, laneOffset(0, laneCount)))
  }

  return {
    roads,
    points,
    lengthM: response.cost_m,
    legs: response.legs,
    destinationJunctionId,
  }
}

/** A leg's direction of travel, in the XZ plane. */
const directionOf = (leg: RouteLeg): { x: number; z: number } => {
  const dx = leg.to.x - leg.from.x
  const dz = leg.to.z - leg.from.z
  const len = Math.hypot(dx, dz)
  if (len < 1e-6) return { x: 0, z: 0 }
  return { x: dx / len, z: dz / len }
}

/**
 * A point moved onto the keep-right lane of a direction of travel.
 *
 * "Right" is the same perpendicular the lane model uses: rotate the
 * direction by -90° (`(uz, -ux)` — see `roadRight` in `laneGeometry`).
 */
const offsetToLane = (
  point: { x: number; y: number; z: number },
  direction: { x: number; z: number },
  offset: number,
): Position => ({
  x: point.x + direction.z * offset,
  y: point.y,
  z: point.z - direction.x * offset,
})

/**
 * The road to take next, given the road the vehicle is on.
 *
 * `hint` is where the search starts — the vehicle usually moves
 * forward along the route, so the last known index is nearly always
 * the right place to look. It is returned so the caller can keep it.
 *
 * Returns `null` when the vehicle is not on the route (it took a
 * detour) or when the route ends here — in both cases the caller
 * falls back to the ordinary traffic rules.
 */
export const nextRouteRoad = (
  route: PlannedRoute,
  currentRoadId: string,
  hint: number,
): { roadId: string | null; index: number } => {
  const roads = route.roads
  let index = -1
  for (let i = Math.max(0, Math.min(hint, roads.length - 1)); i < roads.length; i += 1) {
    if (roads[i] === currentRoadId) {
      index = i
      break
    }
  }
  if (index < 0) {
    // The hint was stale — look from the start.
    for (let i = 0; i < roads.length; i += 1) {
      if (roads[i] === currentRoadId) {
        index = i
        break
      }
    }
  }
  if (index < 0) return { roadId: null, index: hint }
  return { roadId: roads[index + 1] ?? null, index }
}

/**
 * How far along the route the follower is, as a fraction in [0, 1].
 *
 * Counts the roads already taken, not the distance driven — it is a
 * progress indicator for the HUD, not a navigation instrument.
 */
export const routeProgress = (route: PlannedRoute, currentRoadId: string, hint: number): number => {
  const { index } = nextRouteRoad(route, currentRoadId, hint)
  if (route.roads.length <= 1) return index >= 0 ? 1 : 0
  return Math.min(1, Math.max(0, index / (route.roads.length - 1)))
}
