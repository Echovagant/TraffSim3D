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
import { cornerRadius, junctionRadius } from '@domain/services/junctionRadius'
import { DEFAULT_CYCLE_SECONDS } from '@shared/constants/simulation'

const NS_GREEN = DEFAULT_CYCLE_SECONDS * (30 / 63) // ~30s
const EW_GREEN = NS_GREEN

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
 */
const defaultSpawnPoint = (road: Road, occupiedBy: string | null = null): SpawnPoint => ({
  id: `sp-${road.id}-0`,
  roadId: road.id,
  laneIndex: 0,
  s: 0,
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
    phaseRemaining: EW_GREEN + 3, // yellow + red
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
    intersectionRadius: junctionRadius(6, true),
  }
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
    phaseRemaining: EW_GREEN + 3,
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
    intersectionRadius: junctionRadius(4, true),
  }
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
 * intersections (no traffic lights — corner is a smooth turn). Each
 * road is 2 lanes (1 forward, 1 backward). 8 default vehicles spread
 * around the loop so the user sees a circulating traffic pattern.
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
      // 2 lanes x 3.5 m = 7 m wide -> half-width 3.5 m. The corner has no
      // traffic light, so no queue can form and no nose can overhang: the
      // box only has to hold the carriageway and the car **in the turn**
      // (see `cornerRadius` -> `CORNER_TURN_ENVELOPE_M`): 3.5 + 0.5 = 4 m.
      intersectionRadius: cornerRadius(2),
    }
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
        phaseRemaining: 30,
        cycleSeconds: DEFAULT_CYCLE_SECONDS,
        axis: 'ns',
      },
      {
        id: 'tl-ew',
        position: { x: 0, y: 0, z: -3 },
        phase: LightPhase.Red,
        phaseRemaining: 30,
        cycleSeconds: DEFAULT_CYCLE_SECONDS,
        axis: 'ew',
      },
    ],
    connectedRoads: ['r-ns', 'r-ew-low'],
    // 4 lanes x 3.5 m = 14 m wide -> half-width 7 m, plus the 4.5 m
    // clearance: 11.5 m (the box used to be 6 m — narrower than the
    // crossing carriageway).
    intersectionRadius: junctionRadius(4, true),
  }
  net.intersections[intersectionLow.id] = intersectionLow

  // 高架 T 接 (r-ew-low+r-ramp 端点 + r-ew-high+r-ramp 端点 在 r-ramp 起点/终点处)
  // 这里不放红绿灯 — ramp 端点是直通点, 不算正式路口.
  // 但为了 net.roads 完整, 我们仍注册一个无灯的 intersection 作为连接点.
  const intersectionHighStart: Intersection = {
    id: 'i-high-start',
    position: { x: RAMP_END_X, y: LEVEL_HEIGHT, z: 0 },
    trafficLights: [],
    connectedRoads: ['r-ramp', 'r-ew-high'],
    // The ramp's end is a **through** point, not a junction: no traffic
    // light, so no queue can form and no nose can overhang. The box only
    // has to hold the carriageway: 4 lanes x 3.5 m = 14 m -> half-width
    // 7 m (the box used to be 4 m, narrower than the road).
    intersectionRadius: junctionRadius(4, false),
  }
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
        phaseRemaining: 30,
        cycleSeconds: DEFAULT_CYCLE_SECONDS,
        axis: 'ns',
      },
      {
        id: 'tl-ew-n',
        position: { x: 0, y: 0, z: -NS_HALF + 3 },
        phase: LightPhase.Red,
        phaseRemaining: 30,
        cycleSeconds: DEFAULT_CYCLE_SECONDS,
        axis: 'ew',
      },
    ],
    connectedRoads: ['r-ns-corridor', 'r-ew-north'],
    // 4 lanes x 3.5 m = 14 m wide -> half-width 7 m, plus the 4.5 m
    // clearance: 11.5 m (the box used to be 6 m — narrower than the
    // crossing carriageway, so the outer lanes were never inside it).
    intersectionRadius: junctionRadius(4, true),
  }
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
        phaseRemaining: 30,
        cycleSeconds: DEFAULT_CYCLE_SECONDS,
        axis: 'ns',
      },
      {
        id: 'tl-ew-s',
        position: { x: 0, y: 0, z: NS_HALF - 3 },
        phase: LightPhase.Green,
        phaseRemaining: 30,
        cycleSeconds: DEFAULT_CYCLE_SECONDS,
        axis: 'ew',
      },
    ],
    connectedRoads: ['r-ns-corridor', 'r-ew-south'],
    intersectionRadius: junctionRadius(4, true),
  }
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
