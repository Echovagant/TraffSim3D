// spawnVehicle prefers SpawnPoints over random free-lane scan.
//
// New behaviour:
//   1. If `network.spawnPoints` has any free entry, take the first
//      one (`occupiedBy === null`), compute the world position from
//      (roadId, laneIndex, s), and place the vehicle there.
//   2. If all spawn points are occupied, return `{ ok: false,
//      reason: 'no free spawn point' }` so the toolbar can flash
//      "no entry available".
//   3. **Back-compat**: when `network.spawnPoints` is empty (a legacy
//      scene that hasn't been migrated), fall back to the old
//      `findFreeLanes` random scan. This keeps old saved scenes
//      working without forcing a re-save.
//
// The mark-and-release cycle is handled in tick.ts: spawnVehicle sets
// `sp.occupiedBy = nextId`; tick clears it once the vehicle has
// driven past SPAWN_POINT_RELEASE_DISTANCE along the lane.
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import type { Intersection } from '@domain/entities/Intersection'
import type { Road } from '@domain/entities/Road'
import type { Vehicle, VehicleType } from '@domain/entities/Vehicle'
import { LaneId } from '@domain/value-objects/LaneId'
import { intersectionSRange, lanePoint, roadLength } from '@domain/services/laneGeometry'
import { isDrivableLane } from '@domain/services/oneway'

const DEFAULT_COLORS: Record<VehicleType, string> = {
  car: '#3a86ff',
  truck: '#f5f5f4',
  bus: '#22c55e',
}

const TYPE_PROBABILITIES: ReadonlyArray<readonly [VehicleType, number]> = [
  ['car', 0.7],
  ['truck', 0.18],
  ['bus', 0.12],
]

const rollType = (): VehicleType => {
  const r = Math.random()
  let acc = 0
  for (const [t, p] of TYPE_PROBABILITIES) {
    acc += p
    if (r < acc) return t
  }
  return 'car'
}

/**
 * Bumper-to-bumper minimum spacing when scanning for a free spot.
 * Roughly one car length + a small safety margin.
 */
const MIN_FREE_GAP = 6

/**
 * Per-type vehicle "footprint" used when computing the free-space scan.
 * Approximate: half the body length (longest dimension) + half the
 * body width. For collision-avoidance the tick uses slightly larger
 * radii; for the spawn scan we only need "no two vehicles sitting on
 * top of each other", so these are conservative.
 */
const vehicleFootprintRadius = (type: VehicleType): number => {
  if (type === 'bus') return 5.0
  if (type === 'truck') return 3.5
  return 2.5 // car
}

interface SpawnCandidate {
  roadId: string
  laneIndex: number
  s: number
}

/**
 * True if no existing vehicle on (roadId, laneIndex) is within
 * `requiredGap` of the candidate's world position. We compare
 * in **world space** (2D distance) rather than the lane-frame `s`
 * coordinate, because Rapier lets vehicles drift physically and the
 * `s` value (re-derived by `findNearestLane` each tick) can lag or
 * snap to a different lane than the body is actually on. World-space
 * distance is the truthful "are these two cars about to overlap".
 *
 * Candidate position is computed via `lanePoint(road, laneIndex, s)`
 * because `s` is the only lane-frame handle we have at spawn time —
 * the new body doesn't exist in Rapier yet, so `readPose()` would
 * return `null`.
 *
 * It also answers "may a car start HERE at all": a spawn point on a
 * lane that may not be driven on is not free.
 */
const isSpotFree = (
  network: RoadNetwork,
  candidate: SpawnCandidate,
  requiredGap: number,
): boolean => {
  const road = network.roads[candidate.roadId]!
  const cp = lanePoint(road, candidate.laneIndex, candidate.s)
  const cx = cp.position.x
  const cz = cp.position.z
  // A one-way road's backward lanes are the phantom half of a two-way
  // road: there is no oncoming carriageway behind the centre line, so
  // a car must never start there. The rule lives in `oneway.ts` — the
  // single home of the one-way rule.
  //
  // The check sits after the lane point is resolved on purpose: a spawn
  // point whose road does not exist is a malformed scene, and resolving
  // the lane point is what fails loudly on it — the import path refuses
  // to quietly spawn a car onto nothing.
  if (!isDrivableLane(road, candidate.laneIndex)) return false
  for (const other of Object.values(network.vehicles)) {
    const dx = other.position.x - cx
    const dz = other.position.z - cz
    const distSq = dx * dx + dz * dz
    if (distSq < requiredGap * requiredGap) return false
  }
  return true
}

/**
 * The arc-length ranges of every junction box on `road` — the stretches a
 * spawn position has to stay out of.
 *
 * A box is centred on the junction's projection onto the road and reaches
 * `intersectionRadius` in both directions (`laneGeometry.ts` →
 * `intersectionSRange`), so the range is exactly the interval the traffic
 * logic calls "inside the intersection" (`inIntersectionBox`).
 *
 * A junction that does not list this road in `connectedRoads` is not on
 * it, so it contributes no range — the same filter the traffic logic uses.
 */
const junctionBoxesOnRoad = (
  road: Road,
  intersections: readonly Intersection[],
): ReadonlyArray<readonly [number, number]> => {
  const boxes: Array<readonly [number, number]> = []
  for (const inter of intersections) {
    if (!inter.connectedRoads.includes(road.id)) continue
    boxes.push(intersectionSRange(road, inter.intersectionRadius, inter))
  }
  return boxes
}

/**
 * Enumerate all (road, lane) pairs on the network and return the ones
 * that have a free window of at least `minGap` along the lane. A lane
 * is "full" if every position is within `minGap` of an existing
 * vehicle.
 *
 * To avoid an O(N × M) scan per spawn call (N = existing vehicles,
 * M = candidate positions), we do a coarse scan: sample a handful
 * of candidate positions per lane and check if at least one is free.
 * For the demo scale (<30 vehicles, <8 lanes) this is plenty.
 *
 * **Deprecated**: only used as a back-compat fallback when
 * `network.spawnPoints` is empty (legacy saved scenes).
 */
const findFreeLanes = (network: RoadNetwork, minGap: number): SpawnCandidate[] => {
  const candidates: SpawnCandidate[] = []
  const intersections = Object.values(network.intersections)
  for (const road of Object.values(network.roads)) {
    if (road.laneCount === 0) continue
    for (let laneIndex = 0; laneIndex < road.laneCount; laneIndex++) {
      // A one-way road's backward lanes are the phantom half of a
      // two-way road — a car started there drives against the flow. The
      // rule lives in `oneway.ts`, the single home of the one-way rule.
      if (!isDrivableLane(road, laneIndex)) continue
      const len = roadLength(road)
      if (len < minGap * 2) continue // road too short for the gap
      // Sample positions: avoid the junction boxes.
      //
      // The junction is **not** at the road's midpoint — on an imported
      // OSM map it sits at a way endpoint, and the box follows the
      // projection of that junction onto the road. The same source the
      // tick uses to place the stop line is used here, so a vehicle is
      // never spawned inside the area the light governs.
      //
      // The box is excluded **as a whole**, not as a zone around the
      // stop line: the stop line sits on the box's edge, so the box
      // reaches `radius` past it. The old hard-coded 5 m zone around the
      // line therefore did NOT keep a car out of the junction — a car
      // 5 m past the line was still inside the box, and the occupancy
      // rule would treat it as traffic that had already entered the
      // junction. With the lane-model radii (11.5 m and 15 m) the box is
      // deeper still, so the zone has to be the box itself.
      const junctionBoxes = junctionBoxesOnRoad(road, intersections)
      const margin = 1
      const minS = margin
      const maxS = len - margin
      // Try a few random positions in the lane; if ANY is free, the
      // lane is a candidate.
      const trials = 6
      let foundInLane: SpawnCandidate | null = null
      for (let t = 0; t < trials; t++) {
        const s = minS + Math.random() * (maxS - minS)
        // Avoid the junction area (the whole box).
        if (junctionBoxes.some(([lo, hi]) => s >= lo && s <= hi)) continue
        const c: SpawnCandidate = { roadId: road.id, laneIndex, s }
        if (isSpotFree(network, c, minGap)) {
          foundInLane = c
          break
        }
      }
      if (foundInLane) candidates.push(foundInLane)
    }
  }
  return candidates
}

/**
 * Pick the first free spawn point. If `s` itself is blocked
 * by an existing vehicle (e.g. a still-spawning one), reject this
 * spawn point and try the next one. Returns `null` if every spawn
 * point is either occupied or blocked.
 *
 * A spawn point on a lane that may not be driven on — the phantom
 * backward half of a one-way road — is not free either: a car must
 * never start against the flow. `isSpotFree` is what decides that.
 */
const pickFreeSpawnPoint = (network: RoadNetwork, minGap: number): SpawnCandidate | null => {
  for (const sp of Object.values(network.spawnPoints)) {
    if (sp.occupiedBy !== null) continue
    const candidate: SpawnCandidate = {
      roadId: sp.roadId,
      laneIndex: sp.laneIndex,
      s: sp.s,
    }
    if (isSpotFree(network, candidate, minGap)) return candidate
  }
  return null
}

export type SpawnResult =
  | { ok: true; vehicle: Vehicle }
  | { ok: false; reason: 'traffic density full' | 'no free spawn point' }

export interface SpawnOptions {
  type?: VehicleType
  color?: string
  speed?: number
}

/**
 * Build a new Vehicle ready to be added to `network.vehicles`.
 *
 * Behaviour:
 *   1. **Spawn-point path** (default): pick the first free spawn
 *      point; if no spawn point is free AND clear of nearby
 *      vehicles, fall through to step 2.
 *   2. **Back-compat fallback**: if `network.spawnPoints` is empty,
 *      use the old random `findFreeLanes` scan (this preserves
 *      behaviour for scenes saved before the spawn-point migration).
 *   3. **Speed / status**: spawn speed is `road.speedLimit * 0.7`
 *      (vehicles start with intent to drive, not
 *      at 0 with status='waiting'). `desiredStatus` is set to
 *      `'driving'` so the hysteresis in tick.ts immediately considers
 *      the vehicle active.
 *   4. On success, mark the chosen spawn point's `occupiedBy` to the
 *      new vehicle id. tick.ts will release it once the vehicle has
 *      driven past SPAWN_POINT_RELEASE_DISTANCE metres.
 *   5. If both paths fail, return `{ ok: false, reason: ... }`. The
 *      caller surfaces this to the user via a flash message.
 */
export const spawnVehicle = (
  network: RoadNetwork,
  nextId: string,
  options: SpawnOptions = {},
): SpawnResult => {
  const type = options.type ?? rollType()
  const color = options.color ?? DEFAULT_COLORS[type]
  const speed = options.speed ?? 0
  const minGap = MIN_FREE_GAP + vehicleFootprintRadius(type)

  // Prefer the first free spawn point that is also clear of
  // nearby vehicles. Empty spawnPoints → fall through to back-compat.
  let spot: SpawnCandidate | null = null
  if (Object.keys(network.spawnPoints).length > 0) {
    spot = pickFreeSpawnPoint(network, minGap)
    if (!spot) {
      return { ok: false, reason: 'no free spawn point' }
    }
  } else {
    // Back-compat: legacy saved scenes with no spawn points.
    const candidates = findFreeLanes(network, minGap)
    if (candidates.length === 0) {
      return { ok: false, reason: 'traffic density full' }
    }
    spot = candidates[Math.floor(Math.random() * candidates.length)]!
  }

  const road = network.roads[spot.roadId]!
  const lp = lanePoint(road, spot.laneIndex, spot.s)
  // Spawn speed default is 70% of road limit, but
  // callers can override (e.g. `+ Vehicle` with explicit `speed: 0`
  // yields a parked car). `status` mirrors the speed — a freshly
  // spawned car at rest is `waiting` until the controller commands
  // it to drive.
  const spawnSpeed = options.speed ?? Math.min(road.speedLimit * 0.7, road.speedLimit)
  const initialStatus = spawnSpeed < 0.5 ? 'waiting' : 'driving'
  const vehicle: Vehicle = {
    id: nextId,
    type,
    color,
    position: lp.position,
    heading: lp.heading,
    speed: spawnSpeed,
    targetSpeed: road.speedLimit,
    roadId: spot.roadId,
    laneIndex: spot.laneIndex,
    s: spot.s,
    lane: LaneId.make(spot.roadId, spot.laneIndex),
    status: initialStatus,
    desiredStatus: initialStatus,
    enteredIntersectionAt: null,
    desiredLaneIndex: null,
    laneChangeStartedAt: null,
    spawnedAt: 0, // stamped by worldStore.addVehicle() at spawn time
  }

  // Mark the spawn point as taken (no-op in back-compat path).
  for (const sp of Object.values(network.spawnPoints)) {
    if (
      sp.roadId === spot.roadId &&
      sp.laneIndex === spot.laneIndex &&
      sp.s === spot.s &&
      sp.occupiedBy === null
    ) {
      sp.occupiedBy = nextId
      break
    }
  }

  return { ok: true, vehicle }
}
