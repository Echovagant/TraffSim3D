// src/domain/services/approachSignal.ts
//
// The signal the driver is about to meet.
//
// A driver does not care about the phase of a light three junctions
// away — they care about the one at the end of the block they are
// driving, and how long it will stay red. This answers exactly that,
// from the same junction the traffic rules use (the one at the travel
// end of the vehicle's lane) and the same light (the one governing the
// axis the vehicle approaches on).
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
import { laneForwardSign, roadLength } from './laneGeometry'
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

/** The junction at the travel end of the vehicle's lane, or null. */
const junctionAhead = (
  network: RoadNetwork,
  road: Road,
  laneIndex: number,
): Intersection | null => {
  const len = roadLength(road)
  if (len < 1e-6) return null
  const sign = laneForwardSign(laneIndex, road.laneCount)
  let best: Intersection | null = null
  let bestDist = Infinity
  for (const inter of Object.values(network.intersections)) {
    if (!inter.connectedRoads.includes(road.id)) continue
    // The junction's distance from the travel end decides which one
    // the driver meets FIRST — a junction in the middle of the block
    // is passed before the end is reached.
    const dist = Math.abs(
      Math.hypot(inter.position.x - road.endNode.x, inter.position.z - road.endNode.z),
    )
    // The junction must be AT the travel end (or within a car's
    // length of it): a junction half a block away is not the one the
    // driver stops at.
    const endPoint =
      sign === 1
        ? { x: road.endNode.x, z: road.endNode.z }
        : { x: road.startNode.x, z: road.startNode.z }
    const atEnd = Math.hypot(inter.position.x - endPoint.x, inter.position.z - endPoint.z)
    if (atEnd > Math.max(12, len * 0.25)) continue
    if (dist < bestDist) {
      bestDist = dist
      best = inter
    }
  }
  return best
}

/**
 * The signal the vehicle is driving towards, or null when there is
 * none within the lookahead.
 *
 * The search walks the road the way the car will actually drive it —
 * the travel end of the current lane, then the continuation the
 * traffic rules would pick — and returns the FIRST lit junction it
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
  let laneIndex = vehicle.laneIndex
  let heading = vehicle.heading
  const origin = { x: vehicle.position.x, z: vehicle.position.z }

  for (let step = 0; step <= maxJunctions && road; step++) {
    const junction = junctionAhead(network, road, laneIndex)
    if (!junction) return null
    const axis = approachAxis(road, junction)
    const light = junction.trafficLights.find((l) => l.axis === axis)
    const distanceM = Math.hypot(junction.position.x - origin.x, junction.position.z - origin.z)
    if (light) {
      // A light beyond the lookahead is not worth showing yet.
      if (distanceM > maxLookaheadM) return null
      return {
        light,
        junction,
        distanceM,
        phase: light.phase,
        remainingS: light.phaseRemaining,
      }
    }
    // No light here — follow the road on, the way the car will.
    const next = roadContinuation(network, road, laneIndex, heading, vehicle.id)
    if (!next) return null
    const nextRoad = network.roads[next.roadId]
    if (!nextRoad) return null
    road = nextRoad
    laneIndex = next.laneIndex
    heading = next.heading
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
