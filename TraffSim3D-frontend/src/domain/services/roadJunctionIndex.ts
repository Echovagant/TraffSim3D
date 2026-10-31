// src/domain/services/roadJunctionIndex.ts
//
// Which junctions sit on which road.
//
// The traffic rules need this answer on every tick, and the naive form —
//
//   Object.values(network.intersections)
//     .find((i) => i.connectedRoads.includes(road.id))
//
// — is wrong in two separate ways, and both of them bite on an imported
// OSM map:
//
//   1. **It only ever finds the FIRST junction on the road.** An OSM way
//      has a junction at BOTH ends (the two crossroads it connects), so
//      the second junction was invisible to the intersection-occupancy
//      rule: a car driving through it was never "in the intersection".
//      Measured on the real Shenzhen extract (391 roads / 450 junctions),
//      the occupancy rule missed 4 952 of 43 200 vehicle-frames.
//   2. **It is O(junctions) per lookup.** An imported district carries
//      thousands of junctions, and the rule runs once per vehicle pair
//      per tick — 990 pairs x 8 000 junctions would be 8 million
//      property lookups per frame.
//
// This module indexes the junctions per road once per network. The index
// lives in a WeakMap keyed by the network object, so it is collected with
// the network. It is rebuilt whenever the network gains or loses an
// intersection (the test fixtures build a network first and fill it in
// afterwards, so "built once" is not safe on its own) — and the check
// runs **once per index request**, never per lookup.
//
// The freshness check counts the intersections, so replacing one
// intersection OBJECT with another of the same id (same count) is not
// detected. Nothing does that: the app installs a whole new network
// object on every scene change (`replaceNetwork` -> `createRoadNetworkFrom`),
// and the test fixtures fill the network in before the first tick.
//
// The index preserves the network's junction order, so
// `junctionsOnRoad(net, id)[0]` is exactly the junction the old
// `.find(...)` returned.

import type { Intersection } from '@domain/entities/Intersection'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'

/** The per-road junction index of one network. */
export interface JunctionIndex {
  /** Every junction on `roadId`, in the network's junction order. */
  on(roadId: string): readonly Intersection[]
  /**
   * Do two roads meet at a junction?
   *
   * This is the missing test in the cross-road yield rule: a vehicle may
   * only have to yield to traffic on a road that actually crosses its own
   * at a junction. Without it, any car entering ANY junction froze every
   * other car on every other road — on the imported Shenzhen district that
   * reached 2 073 m, with the yielding car 452 m from its own nearest
   * junction.
   */
  sharedJunction(roadA: string, roadB: string): boolean
  /**
   * The junction the two roads SHARE, or null. Same lookup as
   * `sharedJunction`, with the intersection itself — the drive policy's
   * per-vehicle conflict point is "the junction my route turns at".
   */
  sharedJunctionOf(roadA: string, roadB: string): Intersection | null
}

interface CachedIndex {
  /** How many intersections the index was built from. */
  count: number
  /** roadId → the junctions on that road, in network junction order. */
  byRoad: Map<string, Intersection[]>
}

const cache = new WeakMap<RoadNetwork, CachedIndex>()

/** How many intersections the network currently holds. */
const intersectionCount = (network: RoadNetwork): number => {
  let n = 0
  // A for-in loop instead of Object.keys(...).length: no array
  // allocation on a path that runs every frame.
  for (const _ in network.intersections) n += 1
  return n
}

const buildByRoad = (network: RoadNetwork): Map<string, Intersection[]> => {
  const byRoad = new Map<string, Intersection[]>()
  for (const inter of Object.values(network.intersections)) {
    for (const roadId of inter.connectedRoads) {
      const list = byRoad.get(roadId)
      if (list) list.push(inter)
      else byRoad.set(roadId, [inter])
    }
  }
  return byRoad
}

/**
 * The junction index of `network`.
 *
 * Fetch it **once per tick** and pass it around: the freshness check
 * (the intersection count) is O(junctions), and an imported district has
 * thousands of them.
 */
export const junctionIndex = (network: RoadNetwork): JunctionIndex => {
  const count = intersectionCount(network)
  let cached = cache.get(network)
  if (!cached || cached.count !== count) {
    cached = { count, byRoad: buildByRoad(network) }
    cache.set(network, cached)
  }
  const byRoad = cached.byRoad
  return {
    on: (roadId: string): readonly Intersection[] => byRoad.get(roadId) ?? [],
    sharedJunctionOf: (roadA: string, roadB: string): Intersection | null => {
      const onA = byRoad.get(roadA)
      const onB = byRoad.get(roadB)
      if (!onA || !onB) return null
      for (const inter of onA) {
        if (onB.some((candidate) => candidate.id === inter.id)) return inter
      }
      return null
    },
    sharedJunction: (roadA: string, roadB: string): boolean => {
      if (roadA === roadB) return true
      for (const inter of byRoad.get(roadA) ?? []) {
        if (inter.connectedRoads.includes(roadB)) return true
      }
      return false
    },
  }
}
