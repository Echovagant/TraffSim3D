// src/domain/services/approachSignal.ts
//
// The signal the driver is about to meet.
//
// A driver does not care about the phase of a light three junctions
// away — they care about the first one AHEAD of them, and how long it
// will stay red. This answers exactly that, from the same junction the
// traffic rules stop for and the same light (the one governing the
// axis the vehicle approaches on).
//
// "Ahead" is an ARC-LENGTH question, not an end-of-road question. The
// red-light rule in tick.ts walks every junction ON the vehicle's road
// and stops at `stopLineSOnRoad` — the junction's projection onto the
// road's polyline, wherever along it that lands. An imported OSM way is
// a long polyline that crosses many junctions in its MIDDLE: the old
// test here ("the junction must sit at the travel end of the road")
// rejected all of them, and the cluster showed 无信号 to a car that
// was 46 m from a red light. The gauge now reads the same projection
// the stop line is drawn from: the nearest junction whose centre is
// ahead of the vehicle along the direction of travel.
//
// The phase and the countdown are read from the LIVE network — the
// tick writes `light.phase` and `light.phaseRemaining` every frame —
// so the cluster shows the real signal, not a forecast of it.

import type { Intersection } from '@domain/entities/Intersection'
import type { Road } from '@domain/entities/Road'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import type { TrafficLight } from '@domain/entities/TrafficLight'
import type { Vehicle } from '@domain/entities/Vehicle'
import { LightPhase } from '@domain/value-objects/Phase'
import { intersectionCenterS, laneForwardSign, roadLength } from './laneGeometry'
import { approachAxis } from './approachAxis'
import { roadContinuation } from './roadTransition'

/** What the driver sees of the signal ahead. */
export interface ApproachSignal {
  /** The light that governs this approach. */
  light: TrafficLight
  /** The junction it stands at. */
  junction: Intersection
  /** Metres from the vehicle's lane point to the junction. */
  distanceM: number
  /** The phase, as the domain names it. */
  phase: LightPhase
  /** Seconds left in this phase. */
  remainingS: number
}

/**
 * Every junction whose stop line is at or beyond `fromStartS` on `road`,
 * travelling in `laneIndex`'s direction — nearest first.
 *
 * `fromStartS` is the vehicle's position measured from the road's
 * START node (not the lane's): a forward lane travels towards larger
 * `s`, a backward lane towards smaller `s`.
 *
 * "Ahead" means the junction's STOP LINE is at or beyond the vehicle —
 * the same line `stopLineSOnRoad` draws and the tick's red-light rule
 * enforces (`centerS ∓ radius`, flipped by travel direction). A junction
 * whose line is behind the driver does not govern them any more: the
 * tick's commitment rule lets a vehicle past the line clear the box,
 * and a driver inside the box watches the road, not the countdown.
 * A vehicle standing exactly ON the line (ahead = 0) still sees it —
 * the tick holds a vehicle on the line too.
 *
 * The LIST is the point: an imported OSM way crosses several junctions
 * in its middle, and the nearest one ahead often carries no light —
 * the driver's light is the NEXT one, on the same road. Returning only
 * the nearest made the gauge drop a lit junction 130 m ahead because a
 * bare junction stood 15 m ahead of it.
 */
const junctionsAhead = (
  network: RoadNetwork,
  road: Road,
  laneIndex: number,
  fromStartS: number,
): Array<{ inter: Intersection; ahead: number }> => {
  const sign = laneForwardSign(laneIndex, road.laneCount)
  const list: Array<{ inter: Intersection; ahead: number }> = []
  for (const inter of Object.values(network.intersections)) {
    if (!inter.connectedRoads.includes(road.id)) continue
    const centerS = intersectionCenterS(road, inter)
    const radius = Math.max(0, inter.intersectionRadius)
    const stopS = sign === 1 ? centerS - radius : centerS + radius
    const ahead = sign === 1 ? stopS - fromStartS : fromStartS - stopS
    // The line is behind the driver: the box is crossed or being
    // crossed — the NEXT junction is the one that matters.
    if (ahead < 0) continue
    list.push({ inter, ahead })
  }
  list.sort((a, b) => a.ahead - b.ahead)
  return list
}

/**
 * The signal the vehicle is driving towards, or null when there is
 * none within the lookahead.
 *
 * The search walks the road the way the car will actually drive it —
 * the nearest junction ahead on the current road, then the next road
 * the continuation would take — and returns the FIRST lit junction it
 * meets. A driver does not care about the light at the end of this
 * block when that block has none and the next one has: "红灯还有 140 m"
 * is the useful sentence.
 *
 * The lookahead is bounded in metres AND in junctions: a light 400 m
 * away is not a thing the driver is reacting to yet.
 */
export const approachSignalFor = (
  vehicle: Vehicle,
  network: RoadNetwork,
  maxLookaheadM = 250,
  maxJunctions = 2,
): ApproachSignal | null => {
  let road: Road | undefined = network.roads[vehicle.roadId]
  if (!road) return null
  let laneIndex = vehicle.laneIndex
  let heading = vehicle.heading
  const origin = { x: vehicle.position.x, z: vehicle.position.z }
  // The vehicle's position on the FIRST road, measured from the road's
  // start. Later roads in the walk are entered at their near end.
  const sign = laneForwardSign(laneIndex, road.laneCount)
  let fromStartS = sign === 1 ? vehicle.s : roadLength(road) - vehicle.s

  for (let step = 0; step <= maxJunctions && road; step++) {
    // Walk the junctions ahead on THIS road, nearest first: the nearest
    // one often carries no light, and the driver's light is the next.
    let found: ApproachSignal | null = null
    for (const { inter: junction } of junctionsAhead(network, road, laneIndex, fromStartS)) {
      const axis = approachAxis(road, junction)
      const light = junction.trafficLights.find((l) => l.axis === axis)
      if (!light) continue
      const distanceM = Math.hypot(junction.position.x - origin.x, junction.position.z - origin.z)
      // A light beyond the lookahead is not worth showing yet — and
      // every later junction on this road is farther, so stop looking.
      if (distanceM > maxLookaheadM) return null
      found = {
        light,
        junction,
        distanceM,
        phase: light.phase,
        remainingS: light.phaseRemaining,
      }
      break
    }
    if (found) return found
    // No lit junction ahead on this road — follow the road on, the way
    // the car will.
    const next = roadContinuation(network, road, laneIndex, heading, vehicle.id)
    if (!next) return null
    const nextRoad = network.roads[next.roadId]
    if (!nextRoad) return null
    road = nextRoad
    laneIndex = next.laneIndex
    heading = next.heading
    const nextSign = laneForwardSign(laneIndex, road.laneCount)
    fromStartS = nextSign === 1 ? 0 : roadLength(road)
  }
  return null
}

/** The phase names the cluster shows — the arrow phases and the
 *  flashing ones are the same colour with a different meaning. */
export const signalPhaseLabel = (phase: LightPhase): string => {
  switch (phase) {
    case LightPhase.Green:
    case LightPhase.GreenLeft:
      return '绿灯'
    case LightPhase.Yellow:
    case LightPhase.YellowLeft:
      return '黄灯'
    case LightPhase.Red:
    case LightPhase.RedLeft:
    case LightPhase.AllRed:
      return '红灯'
    case LightPhase.FlashingYellow:
      return '闪黄'
    case LightPhase.FlashingRed:
      return '闪红'
    case LightPhase.Dark:
      return '熄灭'
    default:
      return '未知'
  }
}
