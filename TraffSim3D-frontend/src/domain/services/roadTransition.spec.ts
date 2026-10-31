// The junction turn — which road a vehicle takes when it runs past the
// end of its lane, and the one-way rule that decides whether the road it
// is offered may be driven on at all.
//
// The network under test is a **corner**: road A ends at the junction,
// road B starts there. The vehicle drives A's forward lane 0 and runs
// past its end, so the turn candidate is B.
//
// The one-way case that matters is the orientation of B:
//   - B runs *away* from the junction (its far end is at the junction):
//     entering it means driving BACKWARD along it. A one-way road's
//     traffic runs the other way, so it is not a continuation at all.
//   - B runs *towards* the junction (its near end is at the junction):
//     entering it means driving FORWARD along it, which is the direction
//     a one-way road's traffic runs, so it is legal.
import { describe, it, expect } from 'vitest'
import { roadContinuation } from './roadTransition'
import { laneForwardSign } from './laneGeometry'
import { createRoadNetwork } from '@domain/entities/RoadNetwork'
import type { Road } from '@domain/entities/Road'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'

interface CornerOptions {
  /** B's lane count. */
  laneCount?: number
  /** B is one-way. */
  oneway?: boolean
  /** B runs towards the junction (its near end is there) — the default. */
  towardsJunction?: boolean
}

const corner = (options: CornerOptions = {}): { net: RoadNetwork; roadA: Road } => {
  const laneCount = options.laneCount ?? 2
  const towardsJunction = options.towardsJunction ?? true
  const net = createRoadNetwork()

  const roadA: Road = {
    id: 'r-a',
    startNode: { x: -60, y: 0, z: 0 },
    endNode: { x: 0, y: 0, z: 0 },
    laneCount: 4,
    speedLimit: 20,
    level: 0,
  }
  const roadB: Road = {
    id: 'r-b',
    startNode: towardsJunction ? { x: 0, y: 0, z: 0 } : { x: 0, y: 0, z: 60 },
    endNode: towardsJunction ? { x: 0, y: 0, z: 60 } : { x: 0, y: 0, z: 0 },
    laneCount,
    speedLimit: 20,
    level: 0,
    ...(options.oneway === undefined ? {} : { oneway: options.oneway }),
  }
  net.roads[roadA.id] = roadA
  net.roads[roadB.id] = roadB
  net.intersections['i-1'] = {
    id: 'i-1',
    position: { x: 0, y: 0, z: 0 },
    trafficLights: [],
    connectedRoads: ['r-a', 'r-b'],
    intersectionRadius: 11.5,
  }
  return { net, roadA }
}

/** The vehicle drives A's forward lane 0, heading +x. */
const HEADING_EAST = 0

describe('roadContinuation', () => {
  it('turns onto the road that starts at the junction', () => {
    const { net, roadA } = corner()
    const turn = roadContinuation(net, roadA, 0, HEADING_EAST)
    expect(turn).not.toBeNull()
    expect(turn?.roadId).toBe('r-b')
    // Entered at B's near end, on its keep-right forward lane.
    expect(turn?.laneIndex).toBe(0)
    expect(turn?.s).toBe(0)
  })

  it('turns onto a two-way road that runs away from the junction, on its backward lane', () => {
    const { net, roadA } = corner({ towardsJunction: false })
    const turn = roadContinuation(net, roadA, 0, HEADING_EAST)
    expect(turn).not.toBeNull()
    expect(turn?.roadId).toBe('r-b')
    expect(turn?.s).toBe(60)
    // The keep-right lane of the backward travel direction.
    expect(turn?.laneIndex).toBe(1)
  })

  it('refuses a one-way road that runs away from the junction', () => {
    // The traffic on a one-way road runs start → end, and B's start is
    // far from the junction: entering it would drive against the flow.
    const { net, roadA } = corner({ towardsJunction: false, oneway: true })
    expect(roadContinuation(net, roadA, 0, HEADING_EAST)).toBeNull()
  })

  it('refuses a one-way road with a single lane that runs away from the junction', () => {
    // One lane = no backward lane at all, so there is nothing to enter.
    const { net, roadA } = corner({ towardsJunction: false, oneway: true, laneCount: 1 })
    expect(roadContinuation(net, roadA, 0, HEADING_EAST)).toBeNull()
  })

  it('refuses a single-lane road that runs away from the junction', () => {
    // A one-lane road has no backward lane: entering it at its far end
    // would put the vehicle on the FORWARD lane at the far end of the
    // road, and it would drive straight off the end of it.
    const { net, roadA } = corner({ towardsJunction: false, laneCount: 1 })
    expect(roadContinuation(net, roadA, 0, HEADING_EAST)).toBeNull()
  })

  it('accepts a one-way road that runs towards the junction', () => {
    // Entering at the near end means driving forward, which is the
    // direction a one-way road's traffic runs.
    const { net, roadA } = corner({ towardsJunction: true, oneway: true })
    const turn = roadContinuation(net, roadA, 0, HEADING_EAST)
    expect(turn).not.toBeNull()
    expect(turn?.roadId).toBe('r-b')
    expect(turn?.laneIndex).toBe(0)
    expect(turn?.s).toBe(0)
  })

  it('never lands on the wrong-way side of a one-way road', () => {
    for (const oneway of [true, false]) {
      for (const laneCount of [1, 2, 3, 4]) {
        for (const towardsJunction of [true, false]) {
          const { net, roadA } = corner({ oneway, laneCount, towardsJunction })
          const turn = roadContinuation(net, roadA, 0, HEADING_EAST)
          if (!turn) continue
          const roadB = net.roads[turn.roadId]!
          if (roadB.oneway !== true) continue
          expect(laneForwardSign(turn.laneIndex, roadB.laneCount)).toBe(1)
        }
      }
    }
  })

  it('returns null when the road has no junction at its travel end', () => {
    // A junction in the middle of the road is not an exit — the road
    // keeps its historical wrap instead of turning.
    const { net, roadA } = corner()
    net.intersections['i-1']!.position = { x: -30, y: 0, z: 0 }
    expect(roadContinuation(net, roadA, 0, HEADING_EAST)).toBeNull()
  })
})

// A crossroads: the vehicle may go straight on (r-straight), turn right
// (r-right) or turn left (r-left). The planned route names one of them.
const crossroads = (): { net: RoadNetwork; roadA: Road } => {
  const net = createRoadNetwork()
  const roadA: Road = {
    id: 'r-a',
    startNode: { x: -60, y: 0, z: 0 },
    endNode: { x: 0, y: 0, z: 0 },
    laneCount: 4,
    speedLimit: 20,
    level: 0,
  }
  const straight: Road = {
    id: 'r-straight',
    startNode: { x: 0, y: 0, z: 0 },
    endNode: { x: 60, y: 0, z: 0 },
    laneCount: 4,
    speedLimit: 20,
    level: 0,
  }
  const right: Road = {
    id: 'r-right',
    startNode: { x: 0, y: 0, z: 0 },
    endNode: { x: 0, y: 0, z: 60 },
    laneCount: 4,
    speedLimit: 20,
    level: 0,
  }
  const left: Road = {
    id: 'r-left',
    startNode: { x: 0, y: 0, z: 60 },
    endNode: { x: 0, y: 0, z: 0 },
    laneCount: 4,
    speedLimit: 20,
    level: 0,
  }
  net.roads[roadA.id] = roadA
  net.roads[straight.id] = straight
  net.roads[right.id] = right
  net.roads[left.id] = left
  net.intersections['i-1'] = {
    id: 'i-1',
    position: { x: 0, y: 0, z: 0 },
    trafficLights: [],
    connectedRoads: ['r-a', 'r-straight', 'r-right', 'r-left'],
    intersectionRadius: 11.5,
  }
  return { net, roadA }
}

describe('roadContinuation — a planned route wins over the hash', () => {
  it('takes the road the route names', () => {
    const { net, roadA } = crossroads()
    // The seed would otherwise decide; the route overrides it.
    const turn = roadContinuation(net, roadA, 0, HEADING_EAST, 'v-1', 'r-right')
    expect(turn?.roadId).toBe('r-right')
  })

  it('takes the route’s road whatever the seed would have chosen', () => {
    const { net, roadA } = crossroads()
    for (const seed of ['v-1', 'v-2', 'v-3', 'v-4', 'v-5']) {
      const turn = roadContinuation(net, roadA, 0, HEADING_EAST, seed, 'r-left')
      expect(turn?.roadId).toBe('r-left')
    }
  })

  it('falls back to the ordinary rule when the route names a road that cannot be entered here', () => {
    const { net, roadA } = crossroads()
    // 'r-nowhere' is not one of the junction's roads — the vehicle is
    // off its route, so it turns the way it always would.
    const turn = roadContinuation(net, roadA, 0, HEADING_EAST, 'v-1', 'r-nowhere')
    expect(turn).not.toBeNull()
    expect(turn?.roadId).not.toBe('r-nowhere')
  })

  it('falls back to the ordinary rule when there is no route at all', () => {
    const { net, roadA } = crossroads()
    const withSeed = roadContinuation(net, roadA, 0, HEADING_EAST, 'v-1')
    const withoutRoute = roadContinuation(net, roadA, 0, HEADING_EAST, 'v-1', null)
    expect(withoutRoute?.roadId).toBe(withSeed?.roadId)
  })
})
