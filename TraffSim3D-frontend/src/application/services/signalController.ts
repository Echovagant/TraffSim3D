// src/application/services/signalController.ts
//
// Per-light signal controller. One instance per
// traffic light, owned by worldStore. Per-tick, the application
// tick calls `controller.decide(light, network, simTime)` and
// applies the returned decision to the light entity.
//
// See the signal-controller contract for the full details.

import type { TrafficLight } from '@domain/entities/TrafficLight'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import type { Road } from '@domain/entities/Road'
import type { Intersection } from '@domain/entities/Intersection'
import type { LightPhase } from '@domain/value-objects/Phase'
import { laneForwardSign, roadLength, stopLineSOnRoad } from '@domain/services/laneGeometry'
import { STOP_LINE_DISTANCE } from '@shared/constants/simulation'
import type { SignalActionName } from '@shared/constants/simulation'
import {
  FixedCycleController,
  ActuatedController,
  RLController,
  CoordinatedController,
  type CoordinatedControllerDeps,
} from './controllers'

export interface SignalDecision {
  phase: LightPhase
  duration: number
  actions: ReadonlyArray<SignalAction>
  decidedAt: number
}

export interface SignalAction {
  /** The action name — one of the five in `SIGNAL_ACTION_NAMES`. */
  name: SignalActionName
  available: boolean
}

/**
 * Where the RL controller's next action comes from.
 *
 * This is the **seam** between "the signal can be driven" and "the signal
 * is driven by a policy". Sprint 2 ships
 * `createSequenceActionSource` — an injected list of action names, one per
 * poll. Sprint 3 replaces it with a source backed by the trained policy.
 *
 * Both satisfy this one interface, so the swap is a **single line** at the
 * construction site (`createSignalController`'s `rlActionSource` dep) and
 * nothing else in the controller changes.
 */
export interface SignalActionSource {
  /**
   * The next action for `light`, or `null` when there is nothing to apply.
   * Called once per `decide()`.
   */
  nextAction(light: TrafficLight, network: RoadNetwork, simTime: number): SignalActionName | null
}

/**
 * Sprint 2's action source: a fixed sequence of action names.
 *
 * The sequence is consumed one entry per `decide()` call; once it is
 * exhausted the source returns `null` and the controller keeps running its
 * normal cycle. Sprint 3's policy-backed source replaces this — the
 * controller cannot tell the difference.
 */
export const createSequenceActionSource = (
  actions: readonly SignalActionName[],
): SignalActionSource => {
  let index = 0
  return {
    nextAction: () => (index < actions.length ? (actions[index++] ?? null) : null),
  }
}

export interface SignalController {
  decide(light: TrafficLight, network: RoadNetwork, simTime: number): SignalDecision
  /** Synchronous: mutate internal pending-action queue.
   *  Next decide() consumes. */
  applyAction(light: TrafficLight, action: SignalActionName): void
}

export type ControllerKind = 'fixed-cycle' | 'actuated' | 'coordinated' | 'rl'

// ---------------------------------------------------------------------------
// Which roads does a light govern?
// ---------------------------------------------------------------------------
//
// ## Why not `r-${light.axis}`
//
// The queue used to be looked up by an **id convention**: `tl-ns` →
// `r-ns`, `tl-ew` → `r-ew`. That convention only holds for the built-in
// demo scene, whose roads happen to be named that way. An imported OSM
// map names its roads `w-<wayId>`, so `network.roads['r-ns']` was
// `undefined` and the queue length was **structurally 0** — the actuated
// controller (which extends green when a queue exists) and the RL
// policy observation (whose first two indices are the NS/EW queue
// lengths) were both blind on every imported map.
//
// The axis is a **geometric** property of the road, and the roads a
// light governs are a **topological** property of the network. Both are
// read from the data instead of from the ids.
//
// ## The resolution order
//
// 1. **Topology (primary).** Take the intersection that owns the light
//    (`Intersection.trafficLights` holds the light, and
//    `Intersection.connectedRoads` holds the roads) and keep the roads
//    whose geometry matches `light.axis`. A T-junction therefore
//    contributes *both* of its NS arms, and never the EW arm.
// 2. **Network-wide fallback.** When the light is attached to no
//    intersection at all (the Simulation Lab synthesises a light from
//    nothing but an axis — see `SimulationLabView.vue`) or when its
//    intersection has no road on that axis, every road in the network
//    whose geometry matches the axis is used.
//
// The fallback keeps the "whole network" reading that the Simulation Lab
// readout and the RL observation (idx 0 / 1) expect, while the primary
// path keeps the per-intersection reading that a signal actually has.

/**
 * The geometric axis of a road: `ns` when the road runs predominantly
 * along Z (north–south), `ew` when it runs along X (east–west).
 *
 * A polyline road is classified by the distance it actually travels
 * along each axis (the per-segment |dx| / |dz| are summed), so a curved
 * road is judged by its real extent rather than by its end-to-end
 * chord. A 2-point road reduces to `|endNode - startNode|`.
 */
export const roadAxis = (road: Road): TrafficLight['axis'] => {
  const points =
    road.waypoints && road.waypoints.length >= 2 ? road.waypoints : [road.startNode, road.endNode]
  let dx = 0
  let dz = 0
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!
    const cur = points[i]!
    dx += Math.abs(cur.x - prev.x)
    dz += Math.abs(cur.z - prev.z)
  }
  return dz > dx ? 'ns' : 'ew'
}

/**
 * light id → the intersection that owns it.
 *
 * Rebuilt whenever a lookup misses (a light added after the last build,
 * or a light that belongs to no intersection at all — the Simulation
 * Lab's synthesised axis light). Keyed by the `intersections` record, so
 * a new network gets a new index and the old one is collected with it.
 */
const intersectionIndexCache = new WeakMap<object, Map<string, Intersection>>()

const buildIntersectionIndex = (network: RoadNetwork): Map<string, Intersection> => {
  const index = new Map<string, Intersection>()
  for (const id in network.intersections) {
    const intersection = network.intersections[id]
    if (!intersection) continue
    for (const light of intersection.trafficLights) {
      if (!index.has(light.id)) index.set(light.id, intersection)
    }
  }
  intersectionIndexCache.set(network.intersections, index)
  return index
}

/**
 * The intersection that owns `light`, or `null` when the light is not
 * attached to any intersection.
 */
export const findLightIntersection = (
  light: TrafficLight,
  network: RoadNetwork,
): Intersection | null => {
  const cached = intersectionIndexCache.get(network.intersections)
  const candidate = cached?.get(light.id)
  // The cached owner is verified against the live data — an
  // intersection may have been dropped from the record since the index
  // was built.
  if (
    candidate !== undefined &&
    network.intersections[candidate.id] === candidate &&
    candidate.trafficLights.some((l) => l.id === light.id)
  ) {
    return candidate
  }
  return buildIntersectionIndex(network).get(light.id) ?? null
}

/**
 * The roads a light governs on its own axis.
 *
 * See the module section above for the resolution order: the roads
 * connected to the light's own intersection whose geometry matches the
 * axis, falling back to every axis-matching road in the network when
 * the light is not attached to an intersection.
 */
export const axisRoadsForLight = (light: TrafficLight, network: RoadNetwork): Road[] => {
  const intersection = findLightIntersection(light, network)
  const scoped: Road[] = []
  if (intersection) {
    for (const roadId of intersection.connectedRoads) {
      const road = network.roads[roadId]
      if (!road) continue
      if (roadAxis(road) !== light.axis) continue
      scoped.push(road)
    }
  }
  if (scoped.length > 0) return scoped
  return Object.values(network.roads).filter((road) => roadAxis(road) === light.axis)
}

/**
 * The intersection a road forms its queue against: the one **closest to
 * the road's middle** that the road actually passes through.
 *
 * The stop line is the edge of the intersection box on the side the
 * vehicle comes from, so the queue forms against the junction the road
 * approaches — not against every junction on the road. For a road that
 * crosses several junctions (the corridor scene), the middle one is the
 * one the traffic queues at; for a road that passes a junction near its
 * end, that junction is still the relevant one.
 *
 * `null` when the road meets no intersection — the caller then falls
 * back to the road's midpoint, which is what the built-in scenes use
 * exactly.
 */
const nearestIntersectionOnRoad = (road: Road, network: RoadNetwork): Intersection | null => {
  const midX = (road.startNode.x + road.endNode.x) / 2
  const midZ = (road.startNode.z + road.endNode.z) / 2
  let best: Intersection | null = null
  let bestDistance = Infinity
  for (const intersection of Object.values(network.intersections)) {
    if (!intersection.connectedRoads.includes(road.id)) continue
    const distance = Math.hypot(intersection.position.x - midX, intersection.position.z - midZ)
    if (distance < bestDistance) {
      bestDistance = distance
      best = intersection
    }
  }
  return best
}

/**
 * The queued vehicles of a whole tick, counted in **one** pass.
 *
 * Every light of a tick is decided before any vehicle moves (the signal
 * phase runs first — see `tick.ts`), so the queue of a road is the same
 * for every light of that tick. Counting it once turns the per-light
 * cost from O(lights × vehicles) into O(vehicles) + O(lights).
 *
 * Without this, an imported map (hundreds of lights, hundreds of
 * vehicles) spent ~60 ms per tick re-scanning the vehicle record for
 * every single light — 360 000 record reads per tick.
 *
 * The index is keyed by the network **and** the sim time, so it is
 * rebuilt whenever the tick advances or the scene changes. A caller
 * that does not know the sim time (e.g. the Simulation Lab's readout)
 * simply gets the uncached path.
 */
interface TickQueueIndex {
  simTime: number
  network: RoadNetwork
  /** road id → the queued vehicles of that road, per lane index. */
  byRoadLane: Map<string, number[]>
}

let tickQueueIndex: TickQueueIndex | null = null

const buildTickQueueIndex = (network: RoadNetwork): Map<string, number[]> => {
  const byRoadLane = new Map<string, number[]>()
  // The stop line of each road, resolved from the intersection the road
  // actually passes through. A road can pass through several junctions,
  // so the *nearest* one along the road is the one the queue forms
  // against. `stopLineSOnRoad` returns `null` when the junction is not
  // on this approach (e.g. it sits at the road's start node), in which
  // case the road's midpoint is the fallback — the same assumption the
  // built-in scenes satisfy exactly.
  const stopLineByRoadLane = new Map<string, number>()
  for (const road of Object.values(network.roads)) {
    const intersection = nearestIntersectionOnRoad(road, network)
    for (let laneIndex = 0; laneIndex < road.laneCount; laneIndex++) {
      const stopS = intersection ? stopLineSOnRoad(road, intersection, laneIndex) : null
      stopLineByRoadLane.set(
        `${road.id}#${laneIndex}`,
        stopS ?? roadLength(road) / 2 - STOP_LINE_DISTANCE,
      )
    }
  }
  for (const v of Object.values(network.vehicles)) {
    if (v.status === 'crashed') continue
    if (v.enteredIntersectionAt !== null) continue // 在 box 内不算
    if (v.s < 0) continue
    const road = network.roads[v.roadId]
    if (!road) continue
    // The queue forms against the stop line of **this lane's** travel
    // direction: a forward lane stops at `centerS - radius`, a backward
    // lane at `centerS + radius`. Using the road's midpoint instead
    // would put the queue window on the wrong side of the junction for
    // half the lanes.
    const stopLineS = stopLineByRoadLane.get(`${road.id}#${v.laneIndex}`)
    if (stopLineS === undefined) continue
    const sign = laneForwardSign(v.laneIndex, road.laneCount)
    // `distToStopLine` is positive while the vehicle is still approaching
    // the line, negative once it has crossed it.
    const distToStopLine = sign === 1 ? stopLineS - v.s : v.s - stopLineS
    if (distToStopLine < 0) continue // 过了 stop line
    let lanes = byRoadLane.get(v.roadId)
    if (lanes === undefined) {
      lanes = []
      byRoadLane.set(v.roadId, lanes)
    }
    lanes[v.laneIndex] = (lanes[v.laneIndex] ?? 0) + 1
  }
  return byRoadLane
}

const queueIndexFor = (
  network: RoadNetwork,
  simTime: number | undefined,
): Map<string, number[]> | null => {
  if (simTime === undefined) return null
  if (
    tickQueueIndex !== null &&
    tickQueueIndex.network === network &&
    tickQueueIndex.simTime === simTime
  ) {
    return tickQueueIndex.byRoadLane
  }
  const byRoadLane = buildTickQueueIndex(network)
  tickQueueIndex = { simTime, network, byRoadLane }
  return byRoadLane
}

/**
 * Count the vehicles that are queued on the roads `light` governs.
 *
 * `laneScoped` decides whether the light's `controlledLane` narrows the
 * count to a single lane (`getQueueLength`) or whether every lane of
 * the axis counts (`getAxisQueueLength`).
 *
 * Crashed cars are excluded;
 * cars inside the intersection box are excluded; cars past the
 * stop line are excluded. Only "queued" cars (in lane, in
 * stop-line approach, not crashed, not in box) count.
 *
 * `simTime` enables the per-tick index (see `TickQueueIndex`); without
 * it the vehicles are scanned directly.
 */
const countQueuedVehicles = (
  light: TrafficLight,
  network: RoadNetwork,
  laneScoped: boolean,
  simTime?: number,
): number => {
  const roads = axisRoadsForLight(light, network)
  if (roads.length === 0) return 0

  const index = queueIndexFor(network, simTime)
  if (index !== null) {
    let count = 0
    for (const road of roads) {
      const lanes = index.get(road.id)
      if (lanes === undefined) continue
      if (laneScoped && light.controlledLane !== undefined) {
        count += lanes[light.controlledLane] ?? 0
      } else {
        // `lanes` is sparse — a lane nobody queued on is a hole, and
        // `for...of` yields `undefined` for it.
        for (const n of lanes) count += n ?? 0
      }
    }
    return count
  }

  // The stop line of each road **and lane** on this axis — the same
  // projection the tick uses to enforce it, so the queue the controller
  // reasons about is the queue that actually forms.
  const stopLineByRoadLane = new Map<string, number>()
  for (const road of roads) {
    const intersection = nearestIntersectionOnRoad(road, network)
    for (let laneIndex = 0; laneIndex < road.laneCount; laneIndex++) {
      const stopS = intersection ? stopLineSOnRoad(road, intersection, laneIndex) : null
      stopLineByRoadLane.set(
        `${road.id}#${laneIndex}`,
        stopS ?? roadLength(road) / 2 - STOP_LINE_DISTANCE,
      )
    }
  }
  let count = 0
  for (const v of Object.values(network.vehicles)) {
    const stopLineS = stopLineByRoadLane.get(`${v.roadId}#${v.laneIndex}`)
    if (stopLineS === undefined) continue // not on a road this light governs
    if (v.status === 'crashed') continue
    if (laneScoped && light.controlledLane !== undefined && v.laneIndex !== light.controlledLane) {
      continue
    }
    if (v.enteredIntersectionAt !== null) continue // 在 box 内不算
    const road = network.roads[v.roadId]
    if (!road) continue
    const sign = laneForwardSign(v.laneIndex, road.laneCount)
    const distToStopLine = sign === 1 ? stopLineS - v.s : v.s - stopLineS
    if (distToStopLine < 0) continue // 过了 stop line
    if (v.s < 0) continue
    count += 1
  }
  return count
}

/**
 * Queue length on `light.controlledLane` (or "any lane on this
 * axis" if undefined) of `light.axis` direction.
 *
 * `queue_length >= 1` means "there IS queue".
 *
 * `simTime` is optional: pass the tick's sim time to use the per-tick
 * queue index (the tick decides every light with the same sim time, so
 * the vehicles are counted once per tick instead of once per light).
 */
export const getQueueLength = (
  light: TrafficLight,
  network: RoadNetwork,
  simTime?: number,
): number => countQueuedVehicles(light, network, true, simTime)

/**
 * Total queue across all controlled lanes of this axis.
 * Used by some controllers to check "any queue on this axis".
 *
 * `simTime` is optional — see `getQueueLength`.
 */
export const getAxisQueueLength = (
  light: TrafficLight,
  network: RoadNetwork,
  simTime?: number,
): number => countQueuedVehicles(light, network, false, simTime)

/**
 * Factory: returns a SignalController instance for the requested kind.
 * `coordinated` was added for the green-wave; its deps
 * (offset map + enabled flag) are passed by worldStore so the
 * controller stays a pure decision function.
 */
export interface CreateSignalControllerDeps {
  getCoordinatedOffsets: () => ReadonlyMap<string, number>
  isCoordinatedEnabled: () => boolean
  /**
   * The RL controller's action source.
   *
   * Optional: with no source the controller still accepts actions through
   * `applyAction` (the injected-sequence path). A later change passes the
   * trained policy's source here — a one-line swap, because the source is
   * the only thing that decides *where* the actions come from.
   */
  rlActionSource?: SignalActionSource
}

export const createSignalController = (
  kind: ControllerKind,
  deps: CreateSignalControllerDeps,
): SignalController => {
  switch (kind) {
    case 'fixed-cycle':
      return new FixedCycleController()
    case 'actuated':
      return new ActuatedController()
    case 'coordinated':
      return new CoordinatedController({
        getOffsets: deps.getCoordinatedOffsets,
        isEnabled: deps.isCoordinatedEnabled,
      })
    case 'rl':
      return new RLController({ actionSource: deps.rlActionSource })
    default:
      return new ActuatedController()
  }
}
