// The turn's **movement**: straight on, or a right / left turn.
//
// The rule this pins: a vehicle turns with a probability, because a
// street network's movements are not all through movements. Before this
// rule the choice was "take the road that best continues the heading",
// which is the same as saying a vehicle never turns where it could go
// straight — measured on the 5 x 5 grid, every ninety-degree turn
// happened at the edge of the map and none at an interior junction.
//
// The network under test is a **four-way junction**: the vehicle comes
// from the west heading east, so the junction offers it a straight
// continuation (east), a right turn (south) and a left turn (north).
import { describe, it, expect } from 'vitest'
import { roadContinuation } from './roadTransition'
import { createRoadNetwork } from '@domain/entities/RoadNetwork'
import { RIGHT_TURN_SHARE, TURN_PROBABILITY } from '@shared/constants/simulation'
import type { Road } from '@domain/entities/Road'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'

/** The vehicle drives A's forward lane 0, heading +x (east). */
const HEADING_EAST = 0

const straightRoad: Road = {
  id: 'r-east',
  startNode: { x: 0, y: 0, z: 0 },
  endNode: { x: 60, y: 0, z: 0 },
  laneCount: 4,
  speedLimit: 20,
  level: 0,
}

/**
 * The right turn: the road runs from the south **towards** the junction,
 * so entering it means driving backward along it, i.e. heading -z.
 *
 * (An eastbound vehicle's right hand points at -z — `roadRight` is the
 * forward direction rotated by -90° — so the right turn leaves the
 * junction towards the south.)
 */
const rightRoad: Road = {
  id: 'r-south',
  startNode: { x: 0, y: 0, z: -60 },
  endNode: { x: 0, y: 0, z: 0 },
  laneCount: 4,
  speedLimit: 20,
  level: 0,
}

/**
 * The left turn: the road runs from the junction towards the north, so
 * entering it means driving forward along it, i.e. heading +z.
 */
const leftRoad: Road = {
  id: 'r-north',
  startNode: { x: 0, y: 0, z: 0 },
  endNode: { x: 0, y: 0, z: 60 },
  laneCount: 4,
  speedLimit: 20,
  level: 0,
}

const incomingRoad: Road = {
  id: 'r-in',
  startNode: { x: -60, y: 0, z: 0 },
  endNode: { x: 0, y: 0, z: 0 },
  laneCount: 4,
  speedLimit: 20,
  level: 0,
}

/** The four-way junction, with the three candidate roads. */
const cross = (): { net: RoadNetwork; road: Road } => {
  const net = createRoadNetwork()
  for (const road of [incomingRoad, straightRoad, rightRoad, leftRoad]) {
    net.roads[road.id] = road
  }
  net.intersections['i-1'] = {
    id: 'i-1',
    position: { x: 0, y: 0, z: 0 },
    trafficLights: [],
    connectedRoads: ['r-in', 'r-east', 'r-south', 'r-north'],
    intersectionRadius: 11.5,
  }
  return { net, road: incomingRoad }
}

/**
 * A **corner**: the junction offers a right turn and a left turn, and no
 * straight continuation — the vehicle has no choice to make.
 */
const corner = (): { net: RoadNetwork; road: Road } => {
  const net = createRoadNetwork()
  for (const road of [incomingRoad, rightRoad, leftRoad]) {
    net.roads[road.id] = road
  }
  net.intersections['i-1'] = {
    id: 'i-1',
    position: { x: 0, y: 0, z: 0 },
    trafficLights: [],
    connectedRoads: ['r-in', 'r-south', 'r-north'],
    intersectionRadius: 11.5,
  }
  return { net, road: incomingRoad }
}

/** The road the vehicle takes for a given vehicle identity. */
const roadFor = (
  net: RoadNetwork,
  road: Road,
  seed: string,
): string | null => roadContinuation(net, road, 0, HEADING_EAST, seed)?.roadId ?? null

describe('the movement at a junction', () => {
  it('turns a quarter of the time, not never', () => {
    // The whole point: a vehicle DOES turn where it could go straight.
    const { net, road } = cross()
    const samples = 1000
    let turns = 0
    for (let i = 0; i < samples; i += 1) {
      const taken = roadFor(net, road, `v-${i}`)
      if (taken === 'r-east') continue
      turns += 1
    }
    const share = turns / samples
    expect(share).toBeGreaterThan(TURN_PROBABILITY - 0.05)
    expect(share).toBeLessThan(TURN_PROBABILITY + 0.05)
  })

  it('turns right more often than left', () => {
    const { net, road } = cross()
    const samples = 1000
    let right = 0
    let left = 0
    for (let i = 0; i < samples; i += 1) {
      const taken = roadFor(net, road, `v-${i}`)
      if (taken === 'r-south') right += 1
      if (taken === 'r-north') left += 1
    }
    const turnShare = (right + left) / samples
    const rightShare = right / (right + left)
    expect(turnShare).toBeGreaterThan(0)
    expect(rightShare).toBeGreaterThan(RIGHT_TURN_SHARE - 0.08)
    expect(rightShare).toBeLessThan(RIGHT_TURN_SHARE + 0.08)
  })

  it('is reproducible: the same vehicle always makes the same movement', () => {
    const { net, road } = cross()
    for (let i = 0; i < 50; i += 1) {
      const seed = `vehicle-${i}`
      expect(roadFor(net, road, seed)).toBe(roadFor(net, road, seed))
    }
  })

  it('does not turn when the junction has no straight continuation', () => {
    // A corner or a T-junction: there is no through movement to take, so
    // the vehicle turns whatever the probability says.
    const { net, road } = corner()
    for (let i = 0; i < 50; i += 1) {
      const taken = roadFor(net, road, `v-${i}`)
      expect(taken === 'r-south' || taken === 'r-north').toBe(true)
    }
  })

  it('goes straight on when there is no vehicle identity to decide with', () => {
    // The historical rule, still available for the topology tests: with
    // no seed the vehicle takes the road that continues its heading.
    const { net, road } = cross()
    expect(roadContinuation(net, road, 0, HEADING_EAST)?.roadId).toBe('r-east')
  })
})
