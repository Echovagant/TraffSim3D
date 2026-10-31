import { createRoadNetwork, type RoadNetwork } from '@domain/entities/RoadNetwork'
import type { Vehicle } from '@domain/entities/Vehicle'
import type { SpawnPoint } from '@domain/entities/SpawnPoint'
import type { TrafficLight } from '@domain/entities/TrafficLight'
import type { Intersection } from '@domain/entities/Intersection'
import type { Road } from '@domain/entities/Road'
import { LightPhase } from '@domain/value-objects/Phase'
import { LaneId } from '@domain/value-objects/LaneId'
import {
  lanePoint,
  laneForwardSign,
  roadLength,
  stopLineSOnRoad,
} from '@domain/services/laneGeometry'
import { approachAxis, approachAxisGroups, type RoadAxis } from '@domain/services/approachAxis'
import { cornerRadius, junctionRadius } from '@domain/services/junctionRadius'
import {
  ALL_RED_CLEARANCE_SECS,
  DEFAULT_CYCLE_SECONDS,
  GREEN_PHASE_SECS,
  ROAD_LANE_WIDTH,
  YELLOW_CLEAR_SECS,
} from '@shared/constants/simulation'

/** The green the axis group that is served first runs (s). */
const NS_GREEN = GREEN_PHASE_SECS

/**
 * How long the **second** axis group waits before it is served (s): the
 * first group's green, its clearance-yellow and the junction's all-red.
 *
 * 30 + 3 + 3 = **36 s**, so the "neither axis is green" gap is 6 s and the
 * repeat period is 72 s — the same shape the Python training sim's
 * timeline has (a 30 s phase separated by `CLEARANCE_SECS = 6.0` in
 * `app/apps/rl/sim_core.py`).
 */
const SECOND_AXIS_DELAY = GREEN_PHASE_SECS + YELLOW_CLEAR_SECS + ALL_RED_CLEARANCE_SECS

// The junction-box radius rule lives in `@domain/services/junctionRadius`
// — the ONE place that defines it. The imported maps go through the same
// rule (`infrastructure/api/osmNetworkAdapter.ts`), so a built-in scene
// and an imported junction are sized by the same geometry.

/**
 * The arc length a default vehicle starts at: `margin` metres upstream of
 * the stop line of its lane, so that it can still stop on the red instead
 * of running it.
 *
 * The default vehicles used to sit at fixed fractions of the road, which
 * silently coupled the scene to the junction's radius: with a wider box the
 * stop line moves back, and a vehicle that started a metre in front of the
 * new line could no longer stop on the red — it ran the light and drove
 * into the junction. Anchoring the start to the stop line keeps the scene
 * self-consistent for any radius.
 *
 * `null` means the approach has no stop line on this road (the junction is
 * not on it) — the caller keeps its own placement in that case.
 */
const startUpstreamOfStopLine = (
  road: Road,
  intersection: Intersection,
  laneIndex: number,
  margin: number,
): number | null => {
  const stopS = stopLineSOnRoad(road, intersection, laneIndex)
  if (stopS === null) return null
  const sign = laneForwardSign(laneIndex, road.laneCount)
  return sign === 1 ? stopS - margin : stopS + margin
}

/**
 * Register a spawn point for `road` on its outer forward
 * lane (lane 0). The returned spawn point is open (`occupiedBy = null`)
 * unless `occupiedBy` is supplied.
 *
 * `s` is the arc length along the lane the vehicle appears at. It is `0`
 * for the scenes whose roads start away from any junction; a road that
 * **starts at a junction** (the grid's segments all do) has to place it
 * past that junction's box, or the new vehicle would be born inside the
 * junction it is supposed to approach.
 */
const defaultSpawnPoint = (road: Road, occupiedBy: string | null = null, s = 0): SpawnPoint => ({
  id: `sp-${road.id}-0`,
  roadId: road.id,
  laneIndex: 0,
  s,
  occupiedBy,
})

/**
 * Place a vehicle on (road, laneIndex) at distance `s` along the lane.
 * Pulls position + heading from the lane geometry so the rest of the
 * code can stay in world-space.
 */
const at = (
  road: Road,
  laneIndex: number,
  s: number,
  speed: number,
  v: Omit<
    Vehicle,
    | 'position'
    | 'heading'
    | 'lane'
    | 's'
    | 'speed'
    | 'targetSpeed'
    | 'roadId'
    | 'laneIndex'
    | 'enteredIntersectionAt'
    | 'desiredLaneIndex'
    | 'laneChangeStartedAt'
    | 'spawnedAt'
    | 'desiredStatus'
  >,
): Vehicle => {
  const lp = lanePoint(road, laneIndex, s)
  return {
    ...v,
    roadId: road.id,
    laneIndex,
    s,
    speed,
    targetSpeed: road.speedLimit,
    position: lp.position,
    heading: lp.heading,
    lane: LaneId.make(road.id, laneIndex),
    enteredIntersectionAt: null,
    desiredLaneIndex: null,
    laneChangeStartedAt: null,
    spawnedAt: 0,
    desiredStatus: 'driving', // intent-based state
  }
}

/**
 * Helper for the common case of a straight 2-point road. Saves
 * typing `startNode`, `endNode`, `laneCount`, `speedLimit` separately
 * when the road is just a single segment. The `level` parameter
 * defaults to 0 (ground). High-level roads pass `level: 1` etc.
 */
const roadStraight = (
  id: string,
  start: { x: number; y?: number; z: number },
  end: { x: number; y?: number; z: number },
  laneCount: number,
  speedLimit: number,
  level: number = 0,
): Road => ({
  id,
  startNode: { x: start.x, y: start.y ?? 0, z: start.z },
  endNode: { x: end.x, y: end.y ?? 0, z: end.z },
  laneCount,
  speedLimit,
  level,
})

// ---------------------------------------------------------------------------
// The lights of a junction
// ---------------------------------------------------------------------------
//
// A junction's approaches are grouped by the **axis they approach on**
// (`approachAxisGroups`): the north and south arms of a crossroads are one
// group, the east and west arms the other. Each group gets its **own**
// light, and the two groups are driven in opposition — the perpendicular
// approaches are what the signal-conflict resolution arbitrates.
//
// The axis is **derived from the geometry**, never guessed: `approachAxis`
// reads the road's local tangent where it meets the junction (see
// `@domain/services/approachAxis`).

/**
 * How far (m) outside the carriageway a light pole stands.
 */
const LIGHT_STANDOFF_M = 1.5

/**
 * The light of one **axis group** of a junction.
 *
 * The pole stands just outside the carriageway of the widest road of the
 * group, on the side the group approaches from: an `ns` light stands west
 * of the junction, an `ew` light north of it.
 */
const lightForAxis = (
  intersection: Intersection,
  axis: RoadAxis,
  roads: Readonly<Record<string, Road>>,
): TrafficLight => {
  let halfWidth = 0
  for (const roadId of intersection.connectedRoads) {
    const road = roads[roadId]
    if (!road) continue
    if (approachAxis(road, intersection) !== axis) continue
    halfWidth = Math.max(halfWidth, (road.laneCount * ROAD_LANE_WIDTH) / 2)
  }
  const offset = halfWidth + LIGHT_STANDOFF_M
  // `i-corner-0` -> `corner-0`, so the id reads `tl-ns-corner-0`.
  const suffix = intersection.id.startsWith('i-') ? intersection.id.slice(2) : intersection.id
  return {
    id: `tl-${axis}-${suffix}`,
    position: {
      x: axis === 'ns' ? intersection.position.x - offset : intersection.position.x,
      y: intersection.position.y,
      z: axis === 'ew' ? intersection.position.z - offset : intersection.position.z,
    },
    // The two axis groups start in opposition: `ns` green, `ew` red.
    // The second one starts 36 s later — 30 s green + 3 s yellow + 3 s
    // all-red — so the junction's clearance is 6 s, symmetric.
    phase: axis === 'ns' ? LightPhase.Green : LightPhase.Red,
    phaseRemaining: axis === 'ns' ? NS_GREEN : SECOND_AXIS_DELAY,
    cycleSeconds: DEFAULT_CYCLE_SECONDS,
    axis,
  }
}

/**
 * The lights of a junction: **one per axis group** among its connected
 * roads.
 *
 * `existing` carries the lights the scene already declares — their ids and
 * positions are stable (the ids are referenced by the tests and by the RL
 * observation), so they are kept exactly as they are. Any axis group
 * without a light gets one built here, and the **geometry** decides which
 * group that is.
 *
 * A junction whose roads are all on one axis therefore carries exactly one
 * light, and a junction without roads carries none.
 */
const lightsForIntersection = (
  intersection: Intersection,
  roads: Readonly<Record<string, Road>>,
  existing: readonly TrafficLight[] = [],
): TrafficLight[] => {
  const lights: TrafficLight[] = [...existing]
  for (const axis of approachAxisGroups(intersection, roads)) {
    if (lights.some((light) => light.axis === axis)) continue
    lights.push(lightForAxis(intersection, axis, roads))
  }
  return lights
}

/**
 * Build the default cross-intersection scene (renamed from
 * `buildDefaultNetwork`). One NS + one EW road, both 60u
 * long, 6 lanes, 6 default vehicles spread across all 4 directions.
 */
export const buildCrossIntersectionNetwork = (): RoadNetwork => {
  const net = createRoadNetwork()

  // Roads: one NS, one EW, both 60u long, 6 lanes (3 each direction).
  // Closer to a Chinese city arterial: 3 lanes forward
  // (right-turn, straight, left-turn from the curb) and 3 lanes
  // backward (left-turn, straight, right-turn from the median). The
  // 6-lane layout also stresses the spawn / collision code paths
  // (more lanes = more chances for two cars to be on perpendicular
  // inner lanes at the intersection — the case that was clipping in
  // the 4-lane version).
  const roadNS: Road = roadStraight('r-ns', { x: 0, z: -30 }, { x: 0, z: 30 }, 6, 16.67)
  const roadEW: Road = roadStraight('r-ew', { x: -30, z: 0 }, { x: 30, z: 0 }, 6, 16.67)
  net.roads[roadNS.id] = roadNS
  net.roads[roadEW.id] = roadEW

  // Traffic lights at the intersection. tl-ns governs the NS lanes
  // (forward = lane 0..2) and tl-ew governs the EW lanes.
  const lightNS: TrafficLight = {
    id: 'tl-ns',
    position: { x: -4, y: 0, z: 0 },
    phase: LightPhase.Green,
    phaseRemaining: NS_GREEN,
    cycleSeconds: DEFAULT_CYCLE_SECONDS,
    axis: 'ns',
  }
  const lightEW: TrafficLight = {
    id: 'tl-ew',
    position: { x: 0, y: 0, z: -4 },
    phase: LightPhase.Red,
    // The second axis starts 36 s later: 30 s green + 3 s yellow + 3 s
    // all-red — a symmetric 6 s clearance between the two greens.
    phaseRemaining: SECOND_AXIS_DELAY,
    cycleSeconds: DEFAULT_CYCLE_SECONDS,
    axis: 'ew',
  }
  const intersection: Intersection = {
    id: 'i-center',
    position: { x: 0, y: 0, z: 0 },
    trafficLights: [lightNS, lightEW],
    connectedRoads: ['r-ns', 'r-ew'],
    // 6 lanes x 3.5 m = 21 m wide -> half-width 10.5 m, plus the
    // 4.5 m clearance (see `INTERSECTION_CLEARANCE_M`): 15 m.
    //
    // The box used to be 8 m, which was narrower than the crossing
    // carriageway: the outer lanes were never inside the box, and a
    // vehicle queued at the stop line stopped with its NOSE 0.7 m inside
    // the crossing road's outermost lane — where the crossing traffic
    // drove into it.
    intersectionRadius: junctionRadius(6),
  }
  // The NS road and the EW road are two axis groups, so the junction
  // carries one light per group — the two declared above.
  intersection.trafficLights = lightsForIntersection(intersection, net.roads, [lightNS, lightEW])
  net.intersections[intersection.id] = intersection

  // 6 default vehicles: one per OUTER lane of each direction.
  //
  // They start `margin` metres upstream of their stop line, so that they
  // can still stop on the red instead of running it (the stop line moved
  // back with the wider box).
  const nsLen = roadLength(roadNS)
  const ewLen = roadLength(roadEW)
  const CAR_MARGIN_M = 7
  const HEAVY_MARGIN_M = 6
  const defaults: Vehicle[] = [
    at(
      roadNS,
      0,
      startUpstreamOfStopLine(roadNS, intersection, 0, CAR_MARGIN_M) ?? nsLen * 0.25,
      8,
      {
        id: 'v-1',
        type: 'car',
        color: '#3a86ff',
        status: 'driving',
      },
    ),
    at(
      roadNS,
      5,
      startUpstreamOfStopLine(roadNS, intersection, 5, CAR_MARGIN_M) ?? nsLen * 0.75,
      8,
      {
        id: 'v-2',
        type: 'car',
        color: '#ef4444',
        status: 'driving',
      },
    ),
    at(
      roadEW,
      0,
      startUpstreamOfStopLine(roadEW, intersection, 0, CAR_MARGIN_M) ?? ewLen * 0.25,
      8,
      {
        id: 'v-3',
        type: 'car',
        color: '#22c55e',
        status: 'driving',
      },
    ),
    at(
      roadEW,
      5,
      startUpstreamOfStopLine(roadEW, intersection, 5, CAR_MARGIN_M) ?? ewLen * 0.75,
      8,
      {
        id: 'v-4',
        type: 'car',
        color: '#fbbf24',
        status: 'driving',
      },
    ),
    at(
      roadNS,
      1,
      startUpstreamOfStopLine(roadNS, intersection, 1, HEAVY_MARGIN_M) ?? nsLen * 0.15,
      6,
      {
        id: 'v-5',
        type: 'truck',
        color: '#f5f5f4',
        status: 'driving',
      },
    ),
    at(
      roadEW,
      1,
      startUpstreamOfStopLine(roadEW, intersection, 1, HEAVY_MARGIN_M) ?? ewLen * 0.15,
      6,
      {
        id: 'v-6',
        type: 'bus',
        color: '#22c55e',
        status: 'driving',
      },
    ),
  ]
  for (const v of defaults) net.vehicles[v.id] = v
  // Register one open spawn point per road. Default vehicles
  // sit at s=15–25 (not s=0), so they don't conflict with spawn traffic.
  for (const road of [roadNS, roadEW]) {
    const sp = defaultSpawnPoint(road)
    net.spawnPoints[sp.id] = sp
  }
  return net
}

/**
 * Back-compat alias: `buildDefaultNetwork` is the original name and is
 * still imported by tests / persistence restore paths. The rename just
 * renames the implementation; the alias keeps the legacy callers
 * compiling until they migrate.
 */
export const buildDefaultNetwork = buildCrossIntersectionNetwork

/**
 * T-junction demo scene.
 *
 * Layout: EW road (full length) with one NS road attached at its midpoint,
 * and a separate S arm continuing south. Net effect: 3 roads meeting at
 * one intersection (the "T" shape) — 3-way, not 4-way. Two traffic lights
 * control NS vs EW independently. Radius = 6 (smaller than 4-way default
 * because 3-way box is naturally smaller).
 */
export const buildTJunctionNetwork = (): RoadNetwork => {
  const net = createRoadNetwork()
  const half = 50

  const roadEW: Road = roadStraight('r-ew', { x: -half, z: 0 }, { x: half, z: 0 }, 4, 16.67)
  const roadN: Road = roadStraight('r-n', { x: 0, z: 0 }, { x: 0, z: -half }, 4, 16.67)
  const roadS: Road = roadStraight('r-s', { x: 0, z: 0 }, { x: 0, z: half }, 4, 16.67)
  net.roads[roadEW.id] = roadEW
  net.roads[roadN.id] = roadN
  net.roads[roadS.id] = roadS

  const lightNS: TrafficLight = {
    id: 'tl-ns',
    position: { x: -3, y: 0, z: 0 },
    phase: LightPhase.Green,
    phaseRemaining: NS_GREEN,
    cycleSeconds: DEFAULT_CYCLE_SECONDS,
    axis: 'ns',
  }
  const lightEW: TrafficLight = {
    id: 'tl-ew',
    position: { x: 0, y: 0, z: 3 },
    phase: LightPhase.Red,
    // The second axis starts 36 s later (green + yellow + all-red).
    phaseRemaining: SECOND_AXIS_DELAY,
    cycleSeconds: DEFAULT_CYCLE_SECONDS,
    axis: 'ew',
  }
  const intersectionT: Intersection = {
    id: 'i-t',
    position: { x: 0, y: 0, z: 0 },
    trafficLights: [lightNS, lightEW],
    connectedRoads: ['r-ew', 'r-n', 'r-s'], // 3-way
    // 4 lanes x 3.5 m = 14 m wide -> half-width 7 m, plus the 4.5 m
    // clearance: 11.5 m. The box used to be 6 m — narrower than the
    // crossing carriageway, so the outer lanes were never inside it.
    intersectionRadius: junctionRadius(4),
  }
  // The N and S legs are ONE axis group (`ns`), the E–W road the other
  // (`ew`) — two lights, one per group.
  intersectionT.trafficLights = lightsForIntersection(intersectionT, net.roads, [lightNS, lightEW])
  net.intersections[intersectionT.id] = intersectionT

  const ewLen = roadLength(roadEW)
  const nsLen = roadLength(roadN)
  const defaults: Vehicle[] = [
    at(roadEW, 0, ewLen * 0.2, 8, { id: 'v-t1', type: 'car', color: '#3a86ff', status: 'driving' }),
    at(roadN, 0, nsLen * 0.7, 7, { id: 'v-t2', type: 'car', color: '#22c55e', status: 'driving' }),
    at(roadS, 1, nsLen * 0.3, 6, {
      id: 'v-t3',
      type: 'truck',
      color: '#f5f5f4',
      status: 'driving',
    }),
    at(roadEW, 1, ewLen * 0.7, 8, { id: 'v-t4', type: 'bus', color: '#fbbf24', status: 'driving' }),
  ]
  for (const v of defaults) net.vehicles[v.id] = v
  // Spawn points on each of the 3 roads. EW gets the entry
  // from each side; NS arms each get one.
  for (const road of [roadEW, roadN, roadS]) {
    const sp = defaultSpawnPoint(road)
    net.spawnPoints[sp.id] = sp
  }
  return net
}

/**
 * Rectangular-loop demo scene.
 *
 * 4 straight roads forming a 60×60 square loop, joined at 4 corner
 * intersections. Each road is 2 lanes (1 forward, 1 backward). 8 default
 * vehicles spread around the loop so the user sees a circulating traffic
 * pattern.
 *
 * ## The corners are signalised
 *
 * A corner is a crossing of an east–west and a north–south leg, so it
 * carries **one light per axis group** (`lightsForIntersection`) — the
 * same rule every other junction follows. The corners used to be unlit,
 * which meant the traffic circulating the loop met nothing that could
 * arbitrate a conflict with the perpendicular leg: the lights were
 * decorative.
 *
 * Trade-off note: vehicles do NOT decelerate on
 * approach to corners. Rapier will let them take the chord at full
 * speed; if Rapier physics pushes them outside their lane, the OOB
 * cleanup catches and respawns them. Later work will add proper
 * cornering via lookahead steering.
 */
export const buildRectangularLoopNetwork = (): RoadNetwork => {
  const net = createRoadNetwork()
  const half = 60

  const corners: ReadonlyArray<{ x: number; y: number; z: number }> = [
    { x: -half, y: 0, z: -half }, // SW
    { x: half, y: 0, z: -half }, // SE
    { x: half, y: 0, z: half }, // NE
    { x: -half, y: 0, z: half }, // NW
  ]

  for (let i = 0; i < 4; i++) {
    const a = corners[i]!
    const b = corners[(i + 1) % 4]!
    const id = `r-loop-${i}`
    const road: Road = roadStraight(id, a, b, 2, 13.89)
    net.roads[id] = road
  }

  for (let i = 0; i < 4; i++) {
    const a = corners[i]!
    const id = `i-corner-${i}`
    const inter: Intersection = {
      id,
      position: a,
      trafficLights: [],
      connectedRoads: [`r-loop-${i}`, `r-loop-${(i + 3) % 4}`],
      // 2 lanes x 3.5 m = 7 m wide -> half-width 3.5 m, plus the 4.5 m
      // clearance, plus the extra room a vehicle **in the turn** needs
      // (see `cornerRadius` -> `CORNER_TURN_ENVELOPE_M`):
      // 3.5 + 4.5 + 0.5 = 8.5 m.
      intersectionRadius: cornerRadius(2),
    }
    // The two legs of the corner are two axis groups (the leg that runs
    // along Z is `ns`, the one along X is `ew`), so the corner carries
    // one light per group.
    inter.trafficLights = lightsForIntersection(inter, net.roads)
    net.intersections[id] = inter
  }

  // 8 vehicles, 2 per road, spread out.
  const defaults: Vehicle[] = []
  for (let i = 0; i < 4; i++) {
    const road = net.roads[`r-loop-${i}`]!
    const len = roadLength(road)
    defaults.push(
      at(road, 0, len * 0.2, 7, {
        id: `v-l1-${i}`,
        type: 'car',
        color: '#3a86ff',
        status: 'driving',
      }),
      at(road, 1, len * 0.65, 7, {
        id: `v-l2-${i}`,
        type: 'car',
        color: '#22c55e',
        status: 'driving',
      }),
    )
  }
  for (const v of defaults) net.vehicles[v.id] = v
  // 1 spawn point per road (4 total).
  for (let i = 0; i < 4; i++) {
    const road = net.roads[`r-loop-${i}`]!
    const sp = defaultSpawnPoint(road)
    net.spawnPoints[sp.id] = sp
  }
  return net
}

/**
 * 高架桥 demo scene.
 *
 * 布局 (俯视):
 *          N (level=0)
 *           |
 *           |
 *  W-low ───X──── ramp ──────X──── E-high (level=1)
 *           |      (↑ Y 渐变)         (level=1)
 *           |
 *          S (level=0)
 *
 * - r-ns: NS 60u, level=0 (接 r-ew-low)
 * - r-ew-low: EW 西段 -30..0, level=0 (接 r-ns 在地面十字路口)
 * - r-ramp: EW 段 0..20, level 0→1, polyline waypoints 让 Y 平滑上升
 * - r-ew-high: EW 东段 20..50, level=1 (高架直行)
 *
 * ramp 的 Y 用 5 段折线均匀爬升 (避免瞬间跳变导致穿模). Pure Pursuit
 * 已通过 037c 验证能在 polyline 上正常转向 — ramp 自然被走完.
 */
export const buildElevatedScene = (): RoadNetwork => {
  const net = createRoadNetwork()
  const LEVEL_HEIGHT = 4 // 每个 level 抬 4 米
  const EW_LEN_HALF = 30 // 地面层 EW 半段长度
  const RAMP_END_X = 20 // ramp 在 x=20 处到达 level=1
  const HIGH_END_X = 50 // 高架 EW 在 x=50 处结束
  const NS_HALF = 30 // NS 道路半长度

  // 地面层 NS (level=0, Y=0)
  const roadNS: Road = roadStraight('r-ns', { x: 0, z: -NS_HALF }, { x: 0, z: NS_HALF }, 4, 16.67)
  net.roads[roadNS.id] = roadNS

  // 地面层 EW 西段 (level=0, Y=0) — 从 x=-EW_LEN_HALF 到 x=0
  const roadEWLow: Road = roadStraight(
    'r-ew-low',
    { x: -EW_LEN_HALF, z: 0 },
    { x: 0, z: 0 },
    4,
    16.67,
  )
  net.roads[roadEWLow.id] = roadEWLow

  // Ramp: x=0..RAMP_END_X, Y 从 0 渐变到 LEVEL_HEIGHT. 5 段 polyline.
  const RAMP_SEGMENTS = 5
  const rampWps: { x: number; y: number; z: number }[] = []
  for (let i = 0; i <= RAMP_SEGMENTS; i++) {
    const t = i / RAMP_SEGMENTS
    rampWps.push({
      x: RAMP_END_X * t,
      y: LEVEL_HEIGHT * t, // 均匀爬升
      z: 0,
    })
  }
  const roadRamp: Road = {
    id: 'r-ramp',
    startNode: { x: rampWps[0]!.x, y: rampWps[0]!.y, z: rampWps[0]!.z },
    endNode: {
      x: rampWps[rampWps.length - 1]!.x,
      y: rampWps[rampWps.length - 1]!.y,
      z: rampWps[rampWps.length - 1]!.z,
    },
    waypoints: rampWps,
    laneCount: 4,
    speedLimit: 13.89, // 高架慢一点 (50 km/h)
    level: 1,
  }
  net.roads[roadRamp.id] = roadRamp

  // 高架 EW 东段 (level=1, Y=LEVEL_HEIGHT)
  const roadEWHigh: Road = roadStraight(
    'r-ew-high',
    { x: RAMP_END_X, y: LEVEL_HEIGHT, z: 0 },
    { x: HIGH_END_X, y: LEVEL_HEIGHT, z: 0 },
    4,
    13.89,
    1, // level=1
  )
  net.roads[roadEWHigh.id] = roadEWHigh

  // 地面十字路口 (r-ns × r-ew-low) — 跟 cross scene 同样的样式
  const intersectionLow: Intersection = {
    id: 'i-low',
    position: { x: 0, y: 0, z: 0 },
    trafficLights: [
      {
        id: 'tl-ns',
        position: { x: -3, y: 0, z: 0 },
        phase: LightPhase.Green,
        phaseRemaining: GREEN_PHASE_SECS,
        cycleSeconds: DEFAULT_CYCLE_SECONDS,
        axis: 'ns',
      },
      {
        id: 'tl-ew',
        position: { x: 0, y: 0, z: -3 },
        phase: LightPhase.Red,
        // The second axis starts 36 s later (green + yellow + all-red).
        phaseRemaining: SECOND_AXIS_DELAY,
        cycleSeconds: DEFAULT_CYCLE_SECONDS,
        axis: 'ew',
      },
    ],
    connectedRoads: ['r-ns', 'r-ew-low'],
    // 4 lanes x 3.5 m = 14 m wide -> half-width 7 m, plus the 4.5 m
    // clearance: 11.5 m (the box used to be 6 m — narrower than the
    // crossing carriageway).
    intersectionRadius: junctionRadius(4),
  }
  net.intersections[intersectionLow.id] = intersectionLow

  // 高架 T 接 (r-ew-low+r-ramp 端点 + r-ew-high+r-ramp 端点 在 r-ramp 起点/终点处)
  // ramp 端点是直通点 —— 两条腿 (r-ramp 与 r-ew-high) 都沿 X 方向, 所以它们
  // 属于**同一个** axis group, 这个路口只有**一盏**灯 (`ew`).
  // (以前这里一盏灯都没有: 匝道上的车与高架上的车互相不受约束.)
  const intersectionHighStart: Intersection = {
    id: 'i-high-start',
    position: { x: RAMP_END_X, y: LEVEL_HEIGHT, z: 0 },
    trafficLights: [],
    connectedRoads: ['r-ramp', 'r-ew-high'],
    // The ramp's end is a **through** point: it is not a crossroads, so
    // the box still carries the clearance (the front-end paints a stop
    // line on every junction's box edge and the cross-road yield rule
    // can stop a vehicle in front of any of them, lit or not).
    // 4 lanes x 3.5 m = 14 m -> half-width 7 m + 4.5 m clearance: 11.5 m
    // (the box used to be 7 m — the half-width alone, without the
    // clearance).
    intersectionRadius: junctionRadius(4),
  }
  intersectionHighStart.trafficLights = lightsForIntersection(intersectionHighStart, net.roads)
  net.intersections[intersectionHighStart.id] = intersectionHighStart

  // 4 辆默认车: 1 在 NS 南半, 1 在 EW 西段, 1 在 ramp 中, 1 在高架东段
  //
  // The two ground-level vehicles start upstream of the (now further back)
  // stop line, so that they can still stop on the red.
  const nsLen = roadLength(roadNS)
  const ewLowLen = roadLength(roadEWLow)
  const rampLen = roadLength(roadRamp)
  const ewHighLen = roadLength(roadEWHigh)
  const defaults: Vehicle[] = [
    at(roadNS, 0, startUpstreamOfStopLine(roadNS, intersectionLow, 0, 7) ?? nsLen * 0.25, 8, {
      id: 'v-e1',
      type: 'car',
      color: '#3a86ff',
      status: 'driving',
    }),
    at(
      roadEWLow,
      0,
      startUpstreamOfStopLine(roadEWLow, intersectionLow, 0, 7) ?? ewLowLen * 0.6,
      7,
      {
        id: 'v-e2',
        type: 'car',
        color: '#22c55e',
        status: 'driving',
      },
    ),
    at(roadRamp, 0, rampLen * 0.5, 6, {
      id: 'v-e3',
      type: 'truck',
      color: '#fbbf24',
      status: 'driving',
    }),
    at(roadEWHigh, 0, ewHighLen * 0.5, 8, {
      id: 'v-e4',
      type: 'car',
      color: '#ef4444',
      status: 'driving',
    }),
  ]
  for (const v of defaults) net.vehicles[v.id] = v

  // 每条 road 一个 spawn point
  for (const road of [roadNS, roadEWLow, roadRamp, roadEWHigh]) {
    const sp = defaultSpawnPoint(road)
    net.spawnPoints[sp.id] = sp
  }

  return net
}
/**
 * 多路口走廊 demo scene.
 *
 * 布局 (俯视):
 *          (z=-30, NS 路北端)
 *               │
 *   ┌───────────┴───────────┐
 *   │       i-north         │ ← 4-way 路口 #1 (z=-30)
 *   │  (NS corridor x=0,   │
 *   │   EW road z=-30)      │
 *   └───────────┬───────────┘
 *               │ ← NS corridor 中间段 (60u)
 *   ┌───────────┴───────────┐
 *   │       i-south         │ ← 4-way 路口 #2 (z=+30)
 *   │  (NS corridor x=0,   │
 *   │   EW road z=+30)      │
 *   └───────────┬───────────┘
 *               │
 *          (z=+30, NS 路南端)
 *
 * - r-ns-corridor: NS 60u 长路 (z=-30..+30, x=0), level=0
 * - r-ew-north:     EW 60u 长路 (x=-30..+30, z=-30), level=0
 * - r-ew-south:     EW 60u 长路 (x=-30..+30, z=+30), level=0
 * - 2 intersections, 6 vehicles spread across 4 road segments
 * - Coordinated offsets for both intersection pairs (绿波带扩展)
 */
export const buildCorridorScene = (): RoadNetwork => {
  const net = createRoadNetwork()
  const NS_HALF = 30
  const EW_HALF = 30

  // NS corridor (the long road connecting the two intersections)
  const roadNS: Road = roadStraight(
    'r-ns-corridor',
    { x: 0, z: -NS_HALF },
    { x: 0, z: NS_HALF },
    4,
    16.67,
  )
  net.roads[roadNS.id] = roadNS

  // EW at north intersection
  const roadEWNorth: Road = roadStraight(
    'r-ew-north',
    { x: -EW_HALF, z: -NS_HALF },
    { x: EW_HALF, z: -NS_HALF },
    4,
    16.67,
  )
  net.roads[roadEWNorth.id] = roadEWNorth

  // EW at south intersection
  const roadEWSouth: Road = roadStraight(
    'r-ew-south',
    { x: -EW_HALF, z: NS_HALF },
    { x: EW_HALF, z: NS_HALF },
    4,
    16.67,
  )
  net.roads[roadEWSouth.id] = roadEWSouth

  // North intersection (4-way: NS corridor + EW road)
  const intersectionNorth: Intersection = {
    id: 'i-north',
    position: { x: 0, y: 0, z: -NS_HALF },
    trafficLights: [
      {
        id: 'tl-ns-n',
        position: { x: -3, y: 0, z: -NS_HALF },
        phase: LightPhase.Green,
        phaseRemaining: GREEN_PHASE_SECS,
        cycleSeconds: DEFAULT_CYCLE_SECONDS,
        axis: 'ns',
      },
      {
        id: 'tl-ew-n',
        position: { x: 0, y: 0, z: -NS_HALF + 3 },
        phase: LightPhase.Red,
        // The second axis starts 36 s later (green + yellow + all-red).
        phaseRemaining: SECOND_AXIS_DELAY,
        cycleSeconds: DEFAULT_CYCLE_SECONDS,
        axis: 'ew',
      },
    ],
    connectedRoads: ['r-ns-corridor', 'r-ew-north'],
    // 4 lanes x 3.5 m = 14 m wide -> half-width 7 m, plus the 4.5 m
    // clearance: 11.5 m (the box used to be 6 m — narrower than the
    // crossing carriageway, so the outer lanes were never inside it).
    intersectionRadius: junctionRadius(4),
  }
  // The corridor (ns) and the north road (ew) are two axis groups — one
  // light per group.
  intersectionNorth.trafficLights = lightsForIntersection(intersectionNorth, net.roads, [
    intersectionNorth.trafficLights[0]!,
    intersectionNorth.trafficLights[1]!,
  ])
  net.intersections[intersectionNorth.id] = intersectionNorth

  // South intersection (4-way: NS corridor + EW road)
  const intersectionSouth: Intersection = {
    id: 'i-south',
    position: { x: 0, y: 0, z: NS_HALF },
    trafficLights: [
      {
        id: 'tl-ns-s',
        position: { x: 3, y: 0, z: NS_HALF },
        phase: LightPhase.Red,
        // The second axis starts 36 s later (green + yellow + all-red).
        phaseRemaining: SECOND_AXIS_DELAY,
        cycleSeconds: DEFAULT_CYCLE_SECONDS,
        axis: 'ns',
      },
      {
        id: 'tl-ew-s',
        position: { x: 0, y: 0, z: NS_HALF - 3 },
        phase: LightPhase.Green,
        phaseRemaining: GREEN_PHASE_SECS,
        cycleSeconds: DEFAULT_CYCLE_SECONDS,
        axis: 'ew',
      },
    ],
    connectedRoads: ['r-ns-corridor', 'r-ew-south'],
    intersectionRadius: junctionRadius(4),
  }
  // Same two axis groups as the north junction: `ns` (the corridor) and
  // `ew` (the south road).
  intersectionSouth.trafficLights = lightsForIntersection(intersectionSouth, net.roads, [
    intersectionSouth.trafficLights[0]!,
    intersectionSouth.trafficLights[1]!,
  ])
  net.intersections[intersectionSouth.id] = intersectionSouth

  // 6 default vehicles spread across 4 road segments (OOB 教训: 拉开距离)
  //
  // `v-c3` starts upstream of the south junction's stop line — the wider
  // junction box moved that line back, and a vehicle that started past it
  // would have been inside the junction from the first frame.
  const nsLen = roadLength(roadNS)
  const ewLen = roadLength(roadEWNorth)
  const defaults: Vehicle[] = [
    at(roadNS, 0, nsLen * 0.15, 7, {
      id: 'v-c1',
      type: 'car',
      color: '#3a86ff',
      status: 'driving',
    }),
    at(roadNS, 0, nsLen * 0.5, 5, {
      id: 'v-c2',
      type: 'truck',
      color: '#fbbf24',
      status: 'driving',
    }),
    at(roadNS, 0, startUpstreamOfStopLine(roadNS, intersectionSouth, 0, 7) ?? nsLen * 0.85, 7, {
      id: 'v-c3',
      type: 'bus',
      color: '#22c55e',
      status: 'driving',
    }),
    at(roadEWNorth, 0, ewLen * 0.7, 8, {
      id: 'v-c4',
      type: 'car',
      color: '#ef4444',
      status: 'driving',
    }),
    at(
      roadEWSouth,
      0,
      startUpstreamOfStopLine(roadEWSouth, intersectionSouth, 0, 7) ?? ewLen * 0.3,
      8,
      {
        id: 'v-c5',
        type: 'car',
        color: '#a78bfa',
        status: 'driving',
      },
    ),
    at(
      roadEWNorth,
      0,
      startUpstreamOfStopLine(roadEWNorth, intersectionNorth, 0, 7) ?? ewLen * 0.4,
      6,
      {
        id: 'v-c6',
        type: 'truck',
        color: '#f5f5f4',
        status: 'driving',
      },
    ),
  ]
  for (const v of defaults) net.vehicles[v.id] = v

  // 3 spawn points (one per road)
  for (const road of [roadNS, roadEWNorth, roadEWSouth]) {
    const sp = defaultSpawnPoint(road)
    net.spawnPoints[sp.id] = sp
  }

  return net
}

// ---------------------------------------------------------------------------
// The 5 x 5 grid
// ---------------------------------------------------------------------------

/** Junctions per side of the grid — 5 x 5 = 25 junctions. */
export const GRID_SIZE = 5
/** Distance between two neighbouring junctions (m). */
export const GRID_SPACING_M = 120
/** Lanes per grid segment: 2 forward + 2 backward. */
export const GRID_LANE_COUNT = 4
/** The grid's speed limit (m/s) — the arterial value the other scenes use. */
export const GRID_SPEED_LIMIT = 16.67
/**
 * How far the green of row `i` has already been running when the scene
 * opens (s).
 *
 * Every junction runs its **own** plan (`junctionPlan.ts` — one plan,
 * one clock per junction), but a grid whose 25 junctions all open on
 * the same phase is one plan seen 25 times: the whole map pulses in
 * lockstep, which is the "global gridlock" wave every signal engineer
 * designs against. The rows are therefore offset from each other, so
 * the map shows traffic released from one corridor at a time.
 *
 * The offset shifts the junction **along its own 72 s cycle** — it
 * changes *when* the junction starts, never *how long* its phases are:
 * the 30 s green, the 6 s clearance and the 72 s period stay exactly
 * what every other scene has.
 */
export const GRID_ROW_PHASE_SECS = 6

/**
 * Where a grid segment's spawn point sits (m from its start node).
 *
 * Every grid segment starts **at** a junction, so the spawn point has
 * to be past that junction's box (`junctionRadius(4)` = 11.5 m) or the
 * new vehicle would be born in the middle of the junction it is about
 * to approach.
 */
export const GRID_SPAWN_S = 20

/** The id of the junction at row `i`, column `j`. */
export const gridJunctionId = (i: number, j: number): string => `i-${i}-${j}`

/** The id of the east–west segment of row `i` between the columns `j` and `j + 1`. */
export const gridEastWestRoadId = (i: number, j: number): string => `r-ew-${i}-${j}`

/** The id of the north–south segment of column `j` between the rows `i` and `i + 1`. */
export const gridNorthSouthRoadId = (j: number, i: number): string => `r-ns-${j}-${i}`

/**
 * The world position of the junction at row `i`, column `j`.
 *
 * The grid is centred on the origin, so the middle junction (2, 2) sits
 * at (0, 0) and the map spans 480 x 480 m.
 */
export const gridJunctionPosition = (
  i: number,
  j: number,
): { x: number; y: number; z: number } => ({
  x: (j - (GRID_SIZE - 1) / 2) * GRID_SPACING_M,
  y: 0,
  z: (i - (GRID_SIZE - 1) / 2) * GRID_SPACING_M,
})

/**
 * Shift a junction's plan along its cycle by `seconds`.
 *
 * The junction's plan is **adopted** from its lights the first time a
 * controller decides for it (`junctionPlan.ts` → `adoptJunctionState`),
 * so the lights' declared countdowns ARE the junction's starting state.
 *
 * Both axes shift by the same amount, so the junction keeps its shape
 * (30 s green, 3 s yellow, 3 s all-red, 72 s period) and only starts
 * later.
 */
const shiftJunctionBy = (inter: Intersection, seconds: number): void => {
  for (const light of inter.trafficLights) {
    light.phaseRemaining = Math.max(0, light.phaseRemaining - seconds)
  }
}

/**
 * The 5 x 5 grid — 25 signalised junctions, 40 segments, 13 vehicles.
 *
 * ## The layout
 *
 * ```
 *   j=0     j=1     j=2     j=3     j=4
 * i=0  o-----o-----o-----o-----o
 *      |     |     |     |     |
 * i=1  o-----o-----o-----o-----o
 *      |     |     |     |     |
 * i=2  o-----o-----o-----o-----o
 *      |     |     |     |     |
 * i=3  o-----o-----o-----o-----o
 *      |     |     |     |     |
 * i=4  o-----o-----o-----o-----o
 * ```
 *
 * The junctions sit `GRID_SPACING_M` (120 m) apart, the middle one at
 * the origin, so the map spans 480 x 480 m. Every segment is a
 * straight two-way road with 4 lanes (2 forward + 2 backward) and the
 * arterial speed limit the other scenes use (16.67 m/s = 60 km/h).
 *
 * ## Every junction is signalised, on its own clock
 *
 * Each junction carries **one light per axis group** (`ns` + `ew`) —
 * the rule every scene follows, derived from the geometry by
 * `approachAxis`, never guessed. The junction's box is the one the
 * rule gives (`junctionRadius(4)` = 11.5 m: the crossing carriageway's
 * half-width + the nose-overhang clearance).
 *
 * The rows are phase-shifted by `GRID_ROW_PHASE_SECS` (6 s) against
 * each other, so the 25 junctions are 25 independent plans rather than
 * one plan seen 25 times (see `GRID_ROW_PHASE_SECS`).
 *
 * ## One vehicle on every second junction
 *
 * The 13 junctions of one parity each get the vehicle that approaches
 * them, and the approach **alternates between the two axes**, so the map
 * opens with traffic on both of them. Where the approach would leave the
 * map (the west edge of an east–west approach, the north edge of a
 * north–south one) the vehicle comes from the other side instead — which
 * also puts vehicles on the **backward** lanes, the half of the
 * carriageway the others never use.
 *
 * The density is a measured one, not a taste call: see the block below
 * the vehicle loop.
 */
export const buildGridNetwork = (queueLengthPerJunction = 3): RoadNetwork => {
  const net = createRoadNetwork()

  // --- the 40 segments ---------------------------------------------------
  //
  // Row `i` holds 4 east–west segments, column `j` holds 4 north–south
  // ones: 5 x 4 + 5 x 4 = 40. Each segment runs from one junction to
  // the next, so **every** segment has a junction at both of its ends —
  // which is what lets a vehicle turn at the junction it arrives at
  // (`roadTransition.ts` only turns where the junction sits at the
  // road's travel end).
  for (let i = 0; i < GRID_SIZE; i++) {
    for (let j = 0; j < GRID_SIZE - 1; j++) {
      const id = gridEastWestRoadId(i, j)
      net.roads[id] = roadStraight(
        id,
        gridJunctionPosition(i, j),
        gridJunctionPosition(i, j + 1),
        GRID_LANE_COUNT,
        GRID_SPEED_LIMIT,
      )
    }
  }
  for (let j = 0; j < GRID_SIZE; j++) {
    for (let i = 0; i < GRID_SIZE - 1; i++) {
      const id = gridNorthSouthRoadId(j, i)
      net.roads[id] = roadStraight(
        id,
        gridJunctionPosition(i, j),
        gridJunctionPosition(i + 1, j),
        GRID_LANE_COUNT,
        GRID_SPEED_LIMIT,
      )
    }
  }

  // --- the 25 junctions, each with its own pair of lights ----------------
  for (let i = 0; i < GRID_SIZE; i++) {
    for (let j = 0; j < GRID_SIZE; j++) {
      const id = gridJunctionId(i, j)
      // The four arms that meet here: west, east, north, south. A
      // junction on the edge of the map has fewer — the corner ones
      // have two.
      const connectedRoads: string[] = []
      if (j > 0) connectedRoads.push(gridEastWestRoadId(i, j - 1))
      if (j < GRID_SIZE - 1) connectedRoads.push(gridEastWestRoadId(i, j))
      if (i > 0) connectedRoads.push(gridNorthSouthRoadId(j, i - 1))
      if (i < GRID_SIZE - 1) connectedRoads.push(gridNorthSouthRoadId(j, i))
      const inter: Intersection = {
        id,
        position: gridJunctionPosition(i, j),
        trafficLights: [],
        connectedRoads,
        // 4 lanes x 3.5 m = 14 m wide -> half-width 7 m, plus the 4.5 m
        // nose-overhang clearance: 11.5 m. The ONE rule, the same
        // number every other scene gets for a 4-lane junction.
        intersectionRadius: junctionRadius(GRID_LANE_COUNT),
      }
      // One light per axis group — the geometry decides which groups
      // those are (`approachAxisGroups`), so a junction with only an
      // east–west arm would carry one light and a crossroads two.
      inter.trafficLights = lightsForIntersection(inter, net.roads)
      // The rows start apart, so the map is not one phase seen 25
      // times (see `GRID_ROW_PHASE_SECS`).
      shiftJunctionBy(inter, i * GRID_ROW_PHASE_SECS)
      net.intersections[id] = inter
    }
  }

  // --- one vehicle on every second junction ------------------------------
  //
  // The grid starts with a vehicle on every **second** junction — the 13
  // junctions of one parity — so the map opens with traffic on both
  // axes without two vehicles sharing an approach.
  //
  // ## Why not one per junction (25 vehicles)?
  //
  // Measured over 90 s (real Rapier, real tick): 25 vehicles → **89–158
  // frames of two bodies overlapping** and 2 red lights run; 13 vehicles
  // → **0** of each. The cause is in the model, not in the scene: the
  // car-following rule assumes its leader brakes at
  // `MAX_DECEL_COMFY` (2.5 m/s²) — `safeGapGipps`'s default — while a
  // vehicle stopping at a red light brakes at `MAX_DECEL` (10 m/s²). A
  // follower therefore closes in at 7.5 m/s² and rear-ends the leader,
  // and the impact shoves the leader over the stop line (that is what
  // turns a queued approach into a red-light run). The denser the grid,
  // the more queues, and the more often that happens.
  //
  // `domain/services/vehicleDynamics.ts` is not this scene's to change,
  // so the grid ships the density the model can carry without a crash —
  // and the defect is reported with its numbers.
  const defaults: Vehicle[] = []
  /**
   * How far upstream of its stop line a vehicle starts (m).
   *
   * It has to be the **braking distance from the road's speed limit**,
   * not a token margin: the tick brakes a vehicle when the distance to
   * the stop line falls below `v²/(2·MAX_DECEL) + STOP_LINE_BUFFER`, and
   * the vehicle is still ACCELERATING towards that point. A vehicle that
   * starts closer than the limit's braking distance (16.67 m/s →
   * 17.9 m) accelerates into the braking zone and cannot stop in time —
   * it runs the red. Measured on the grid with an 8 m margin: 2 red
   * lights run in 90 s. With 24 m the vehicle can always stop.
   *
   * The heavy vehicles get the same margin: they accelerate more slowly
   * (a bus's accel ceiling is 1.2 m/s²), so they need less of it.
   */
  const START_MARGIN_M = 24
  /**
   * The gap between two vehicles waiting on the same approach (m).
   *
   * A queue is vehicles **on the same approach**, not vehicles spread
   * over the map: the signal agent reads the queue length, and a queue
   * is what forms when cars arrive on one lane faster than the light
   * lets them go. The spacing has to clear the longest body (a bus) so
   * the scene does not open with two vehicles inside each other.
   */
  const QUEUE_SPACING_M = 12
  let vehicleIndex = 0
  let junctionIndex = 0
  for (let i = 0; i < GRID_SIZE; i++) {
    for (let j = 0; j < GRID_SIZE; j++) {
      const inter = net.intersections[gridJunctionId(i, j)]!
      // The approach **alternates between the two axes**, so the map
      // opens with traffic on both of them. (Measured: with every
      // approach on the east–west road, the 12 north–south segments of
      // the three inner columns were never driven in 90 s — a third of
      // the map stood empty.)
      const eastWest = junctionIndex % 2 === 1
      junctionIndex += 1
      // Where the vehicle comes from. On the west / north edge of the
      // map there is no road behind the junction, so the vehicle comes
      // from the other side — on the backward lane.
      const roadId = eastWest
        ? j > 0
          ? gridEastWestRoadId(i, j - 1)
          : gridEastWestRoadId(i, 0)
        : i > 0
          ? gridNorthSouthRoadId(j, i - 1)
          : gridNorthSouthRoadId(j, 0)
      const laneIndex = eastWest
        ? j > 0
          ? 0
          : GRID_LANE_COUNT - 1
        : i > 0
          ? 0
          : GRID_LANE_COUNT - 1
      const road = net.roads[roadId]!
      // The **queue** on that approach.
      //
      // The density is set so that the queue the signal agent reads is
      // the interesting one. The observation's `MAX_QUEUE` is 10, and at
      // one vehicle per junction the grid's queues peaked at **6** — the
      // ruler was never reached, so the signal problem was trivial,
      // while the training environment (whose queues reached 21) was
      // training the agent for a world the browser never shows.
      //
      // A corner has two approaches and every other junction three or
      // four, so the corners carry about half the traffic: one vehicle
      // there, two everywhere else.
      const queueLength = inter.connectedRoads.length <= 2 ? 1 : queueLengthPerJunction
      for (let position = 0; position < queueLength; position++) {
        vehicleIndex += 1
        // A quarter of the traffic is heavy: the rest are cars.
        const heavy = vehicleIndex % 5 === 0
        const isBus = vehicleIndex % 7 === 0
        const type = isBus ? 'bus' : heavy ? 'truck' : 'car'
        const speed = type === 'car' ? 8 : type === 'bus' ? 7 : 6
        const color = type === 'car' ? '#3a86ff' : type === 'bus' ? '#22c55e' : '#f5f5f4'
        // Anchored **upstream** of the stop line of the junction it
        // approaches, with room to brake — a vehicle that starts on the
        // line cannot stop on the red — and the queue spaced out behind
        // the first one.
        const s =
          startUpstreamOfStopLine(
            road,
            inter,
            laneIndex,
            START_MARGIN_M + position * QUEUE_SPACING_M,
          ) ?? roadLength(road) * 0.5
        defaults.push(
          at(road, laneIndex, s, speed, {
            id: `v-g${vehicleIndex}`,
            type,
            color,
            status: 'driving',
          }),
        )
      }
    }
  }
  for (const v of defaults) net.vehicles[v.id] = v

  // --- one spawn point per segment ----------------------------------------
  //
  // The spawn point sits `GRID_SPAWN_S` metres along the segment — past
  // the junction the segment starts at (the junction's box reaches
  // `junctionRadius(4)` = 11.5 m into the segment), so a vehicle that
  // spawns there is not born inside a junction.
  for (const road of Object.values(net.roads)) {
    const sp = defaultSpawnPoint(road, null, GRID_SPAWN_S)
    net.spawnPoints[sp.id] = sp
  }

  return net
}

// ---------------------------------------------------------------------------
// The unsignalised junction (Scene 4's scenario)
// ---------------------------------------------------------------------------

/** The arm length of the unsignalised junction (m) — the training env's. */
export const JUNCTION_ARM_LENGTH_M = 60

/** The junction the negotiation happens at (the network's origin). */
export const JUNCTION_CONFLICT_POINT = { x: 0, z: 0 } as const

/**
 * The route each authored vehicle drives: in on one arm, out on another.
 *
 * The pairing is the training env's rule — **different arms**, so nobody
 * makes a U-turn, and the four vehicles cover all four approaches. The
 * RL-driven cars follow these routes at the junction
 * (`roadContinuation` honours the route's next road); the scripted one
 * follows its route too, at the ordinary speed control.
 */
export const JUNCTION_DRIVE_ROUTES: Record<string, string[]> = {
  'v-1': ['in-e', 'out-n'],
  'v-2': ['in-n', 'out-s'],
  'v-3': ['in-s', 'out-w'],
  'v-4': ['in-w', 'out-n'],
}

/**
 * The four-arm junction **without traffic lights** — Scene 4's scenario.
 *
 * Three of the vehicles are the negotiation: they approach on different
 * arms, staggered the way the training env staggers them (45–80 % along
 * the arm), and — when RL driving is enabled — are driven by the
 * cooperative policy. The fourth is scripted background traffic.
 *
 * The roads carry **no lights**: the right of way here is not given by
 * a phase, it is negotiated. That is the whole point of the scenario
 * (see ADR-011) — and the reason the junction has no `trafficLights`
 * entries at all.
 */
export const buildUnsignalisedJunctionScene = (): RoadNetwork => {
  const net = createRoadNetwork()
  const L = JUNCTION_ARM_LENGTH_M

  // --- the eight road halves (an in and an out per arm) ------------------
  const arms: { name: string; outer: { x: number; z: number } }[] = [
    { name: 'n', outer: { x: 0, z: -L } },
    { name: 'e', outer: { x: L, z: 0 } },
    { name: 's', outer: { x: 0, z: L } },
    { name: 'w', outer: { x: -L, z: 0 } },
  ]
  for (const arm of arms) {
    net.roads[`in-${arm.name}`] = roadStraight(
      `in-${arm.name}`,
      arm.outer,
      { x: 0, z: 0 },
      4,
      16.67,
    )
    net.roads[`out-${arm.name}`] = roadStraight(
      `out-${arm.name}`,
      { x: 0, z: 0 },
      arm.outer,
      4,
      16.67,
    )
  }

  // --- the one junction, with no lights ----------------------------------
  net.intersections['j-0'] = {
    id: 'j-0',
    position: { x: 0, y: 0, z: 0 },
    trafficLights: [],
    connectedRoads: arms.flatMap((arm) => [`in-${arm.name}`, `out-${arm.name}`]),
    intersectionRadius: junctionRadius(4),
  }

  // --- the four vehicles, staggered along their arms ---------------------
  //
  // The start distances mirror the training env's spawn fractions
  // (45–80 % of the arm) and the keep-right lane 0 — the poses the
  // policy met in training. Note the arms point INWARD: in-n's forward
  // direction runs from the outer end (z = -60) to the junction, so a
  // vehicle at s = 27 m sits at z = -33.
  const starts: { id: string; type: Vehicle['type']; color: string; arm: string; s: number }[] = [
    { id: 'v-1', type: 'car', color: '#3a86ff', arm: 'in-e', s: 27 },
    { id: 'v-2', type: 'car', color: '#fbbf24', arm: 'in-n', s: 34 },
    { id: 'v-3', type: 'car', color: '#22c55e', arm: 'in-s', s: 41 },
    { id: 'v-4', type: 'car', color: '#f5f5f4', arm: 'in-w', s: 34 },
  ]
  for (const start of starts) {
    const road = net.roads[start.arm]!
    net.vehicles[start.id] = at(road, 0, start.s, 0, {
      id: start.id,
      type: start.type,
      color: start.color,
      status: 'driving',
    })
  }

  return net
}

// ---------------------------------------------------------------------------
// The unsignalised GRID (Scene 4 v2)
// ---------------------------------------------------------------------------

/** The junction spacing of the unsignalised grid (m) — the training env's. */
export const GRID_DRIVE_SPACING_M = 120

/** The boundary stub length (m) — where the drivers come from. */
export const GRID_DRIVE_STUB_M = 60

/** The conflict points of the 2 x 2 grid, keyed by junction id. */
export const GRID_DRIVE_JUNCTIONS: Record<string, { x: number; z: number }> = {
  'g-0-0': { x: 0, z: 0 },
  'g-0-1': { x: GRID_DRIVE_SPACING_M, z: 0 },
  'g-1-0': { x: 0, z: GRID_DRIVE_SPACING_M },
  'g-1-1': { x: GRID_DRIVE_SPACING_M, z: GRID_DRIVE_SPACING_M },
}

/**
 * The eight vehicles' routes: in on one boundary stub, across the grid,
 * out on the far-side stub — the same pairing the training env uses
 * (each in-stub with the out-stub half a ring away), so a route crosses
 * one to two junctions.
 */
export const GRID_DRIVE_ROUTES: Record<string, string[]> = {
  'v-1': ['stub-in-0-0-n', 'link-v-0-0-f', 'stub-out-1-0-s'],
  'v-2': ['stub-in-0-0-w', 'link-v-0-0-f', 'stub-out-1-0-w'],
  'v-3': ['stub-in-0-1-e', 'link-v-0-1-f', 'stub-out-1-1-e'],
  'v-4': ['stub-in-0-1-n', 'link-v-0-1-f', 'stub-out-1-1-s'],
  'v-5': ['stub-in-1-0-s', 'link-v-0-0-r', 'stub-out-0-0-n'],
  'v-6': ['stub-in-1-0-w', 'link-v-0-0-r', 'stub-out-0-0-w'],
  'v-7': ['stub-in-1-1-e', 'link-v-0-1-r', 'stub-out-0-1-e'],
  'v-8': ['stub-in-1-1-s', 'link-v-0-1-r', 'stub-out-0-1-n'],
}

/**
 * The 2 x 2 grid of unsignalised junctions — Scene 4 v2's scenario
 * (the training env's `build_unsignalised_grid_network`, browser side).
 *
 * Four junctions, NO lights anywhere, eight vehicles whose routes cross
 * the grid: the negotiations repeat, and the traffic persists.
 */
export const buildUnsignalisedGridScene = (): RoadNetwork => {
  const net = createRoadNetwork()
  const S = GRID_DRIVE_SPACING_M
  const stub = GRID_DRIVE_STUB_M

  const roads: Road[] = []
  const connected: Record<string, string[]> = {
    'g-0-0': [],
    'g-0-1': [],
    'g-1-0': [],
    'g-1-1': [],
  }

  const road = (id: string, ax: number, az: number, bx: number, bz: number): void => {
    const r: Road = {
      id,
      startNode: { x: ax, y: 0, z: az },
      endNode: { x: bx, y: 0, z: bz },
      laneCount: 4,
      speedLimit: 16.67,
      level: 0,
    }
    roads.push(r)
    net.roads[id] = r
  }

  // The connecting roads: one per direction between adjacent junctions.
  for (const [id, ax, az, bx, bz] of [
    ['link-h-0-0-f', 0, 0, S, 0],
    ['link-h-0-0-r', S, 0, 0, 0],
    ['link-h-1-0-f', 0, S, S, S],
    ['link-h-1-0-r', S, S, 0, S],
    ['link-v-0-0-f', 0, 0, 0, S],
    ['link-v-0-0-r', 0, S, 0, 0],
    ['link-v-0-1-f', S, 0, S, S],
    ['link-v-0-1-r', S, S, S, 0],
  ] as [string, number, number, number, number][]) {
    road(id, ax, az, bx, bz)
  }

  // The boundary stubs: in/out pairs per outward direction.
  const stubs: [string, number, number, number, number][] = [
    ['stub-in-0-0-n', 0, -stub, 0, 0],
    ['stub-out-0-0-n', 0, 0, 0, -stub],
    ['stub-in-0-0-w', -stub, 0, 0, 0],
    ['stub-out-0-0-w', 0, 0, -stub, 0],
    ['stub-in-0-1-e', S + stub, 0, S, 0],
    ['stub-out-0-1-e', S, 0, S + stub, 0],
    ['stub-in-0-1-n', S, -stub, S, 0],
    ['stub-out-0-1-n', S, 0, S, -stub],
    ['stub-in-1-0-s', 0, S + stub, 0, S],
    ['stub-out-1-0-s', 0, S, 0, S + stub],
    ['stub-in-1-0-w', -stub, S, 0, S],
    ['stub-out-1-0-w', 0, S, -stub, S],
    ['stub-in-1-1-s', S, S + stub, S, S],
    ['stub-out-1-1-s', S, S, S, S + stub],
    ['stub-in-1-1-e', S + stub, S, S, S],
    ['stub-out-1-1-e', S, S, S + stub, S],
  ]
  // The pairing the routes use is the training env's (each in-stub with
  // the out-stub half a ring away), and it uses only these 16 roads.
  for (const [id, ax, az, bx, bz] of stubs) {
    road(id, ax, az, bx, bz)
  }

  // The four junctions, no lights, connected to every road that touches
  // them.
  for (const [id, cx, cz] of [
    ['g-0-0', 0, 0],
    ['g-0-1', S, 0],
    ['g-1-0', 0, S],
    ['g-1-1', S, S],
  ] as [string, number, number][]) {
    const inter: Intersection = {
      id,
      position: { x: cx, y: 0, z: cz },
      trafficLights: [],
      connectedRoads: roads
        .filter((r) => near(r.startNode, cx, cz) || near(r.endNode, cx, cz))
        .map((r) => r.id),
      intersectionRadius: junctionRadius(4),
    }
    net.intersections[id] = inter
  }

  // The eight vehicles, staggered along their stubs — the training
  // env's spawn fractions (30-70 %).
  const starts: { id: string; type: Vehicle['type']; color: string; arm: string; s: number }[] = [
    { id: 'v-1', type: 'car', color: '#3a86ff', arm: 'stub-in-0-0-n', s: 24 },
    { id: 'v-2', type: 'car', color: '#fbbf24', arm: 'stub-in-0-0-w', s: 30 },
    { id: 'v-3', type: 'car', color: '#22c55e', arm: 'stub-in-0-1-e', s: 36 },
    { id: 'v-4', type: 'car', color: '#f5f5f4', arm: 'stub-in-0-1-n', s: 42 },
    { id: 'v-5', type: 'car', color: '#a78bfa', arm: 'stub-in-1-0-s', s: 24 },
    { id: 'v-6', type: 'car', color: '#fb7185', arm: 'stub-in-1-0-w', s: 30 },
    { id: 'v-7', type: 'car', color: '#34d399', arm: 'stub-in-1-1-e', s: 36 },
    { id: 'v-8', type: 'car', color: '#60a5fa', arm: 'stub-in-1-1-s', s: 42 },
  ]
  for (const start of starts) {
    const road = net.roads[start.arm]!
    net.vehicles[start.id] = at(road, 0, start.s, 0, {
      id: start.id,
      type: start.type,
      color: start.color,
      status: 'driving',
    })
  }

  return net
}

/** Whether a node sits at a position (for the junction adjacency). */
const near = (node: { x: number; z: number }, x: number, z: number): boolean =>
  Math.abs(node.x - x) < 1e-6 && Math.abs(node.z - z) < 1e-6
