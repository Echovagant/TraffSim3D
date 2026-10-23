// scripts/measure-queue.ts
//
// The **before/after** measurement of the signal-queue lookup.
//
// The queue used to be found by an id convention (`r-${axis}`), which
// only the built-in demo scene satisfies — an imported OSM map names
// its roads `w-<wayId>`, so its queue was structurally 0 and the
// actuated controller and the RL observation were both blind.
//
// This script prints, for every built-in scene and for an imported
// map, the queue length under the old convention and under the current
// topology lookup, plus the per-tick cost of both on a 600-light /
// 600-vehicle map.
//
// Run it with:
//   npx vite-node --config vite.contract.config.ts scripts/measure-queue.ts
//
// It is a **measurement tool, not a test** — it lives in `scripts/`
// (like `measure-fps.mjs`), so vitest never collects it.

import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import type { TrafficLight } from '@domain/entities/TrafficLight'
import { createRoadNetwork } from '@domain/entities/RoadNetwork'
import { roadLength } from '@domain/services/laneGeometry'
import { STOP_LINE_DISTANCE } from '@shared/constants/simulation'
import { LightPhase } from '@domain/value-objects/Phase'
import { getAxisQueueLength, getQueueLength } from '@application/services/signalController'
import {
  buildCrossIntersectionNetwork,
  buildTJunctionNetwork,
  buildElevatedScene,
  buildCorridorScene,
} from '@application/services/defaultScene'
import { buildImportedNetwork } from '@__fixtures__/importedNetwork'

/**
 * The pre-fix lookup, verbatim (commit 1f72158): the road is found by
 * the `r-${axis}` id convention.
 */
const legacyAxisQueueLength = (light: TrafficLight, network: RoadNetwork): number => {
  const roadId = `r-${light.axis}`
  const road = network.roads[roadId]
  if (!road) return 0
  const stopLineS = roadLength(road) / 2 - STOP_LINE_DISTANCE
  let count = 0
  for (const v of Object.values(network.vehicles)) {
    if (v.roadId !== road.id) continue
    if (v.status === 'crashed') continue
    if (v.enteredIntersectionAt !== null) continue
    if (v.s >= stopLineS) continue
    if (v.s < 0) continue
    count += 1
  }
  return count
}

const legacyQueueLength = (light: TrafficLight, network: RoadNetwork): number => {
  const roadId = `r-${light.axis}`
  const road = network.roads[roadId]
  if (!road) return 0
  const stopLineS = roadLength(road) / 2 - STOP_LINE_DISTANCE
  let count = 0
  for (const v of Object.values(network.vehicles)) {
    if (v.roadId !== road.id) continue
    if (v.status === 'crashed') continue
    if (light.controlledLane !== undefined && v.laneIndex !== light.controlledLane) continue
    if (v.enteredIntersectionAt !== null) continue
    if (v.s >= stopLineS) continue
    if (v.s < 0) continue
    count += 1
  }
  return count
}

const report = (name: string, net: RoadNetwork): void => {
  for (const inter of Object.values(net.intersections)) {
    for (const light of inter.trafficLights) {
      console.log(
        `${name.padEnd(9)} | ${light.id.padEnd(10)} (${light.axis}) | ` +
          `legacy axis=${legacyAxisQueueLength(light, net)} new axis=${getAxisQueueLength(light, net)} | ` +
          `legacy lane=${legacyQueueLength(light, net)} new lane=${getQueueLength(light, net)}`,
      )
    }
  }
}

/** A network shaped like the imported Shenzhen map: 600 intersections. */
const buildBigNetwork = (n: number): RoadNetwork => {
  const net = createRoadNetwork()
  for (let i = 0; i < n; i++) {
    const x = (i % 25) * 120
    const z = Math.floor(i / 25) * 120
    const nsId = `w-ns-${i}`
    const ewId = `w-ew-${i}`
    net.roads[nsId] = {
      id: nsId,
      startNode: { x, y: 0, z: z - 60 },
      endNode: { x, y: 0, z: z + 60 },
      laneCount: 2,
      speedLimit: 13.89,
      level: 0,
    }
    net.roads[ewId] = {
      id: ewId,
      startNode: { x: x - 60, y: 0, z },
      endNode: { x: x + 60, y: 0, z },
      laneCount: 2,
      speedLimit: 13.89,
      level: 0,
    }
    const nsLight: TrafficLight = {
      id: `tl-ns-${i}`,
      position: { x: x - 3, y: 0, z },
      phase: LightPhase.Green,
      phaseRemaining: 30,
      cycleSeconds: 63,
      axis: 'ns',
    }
    net.intersections[`i-${i}`] = {
      id: `i-${i}`,
      position: { x, y: 0, z },
      trafficLights: [nsLight],
      connectedRoads: [nsId, ewId],
      intersectionRadius: 8,
    }
    net.vehicles[`v-${i}`] = {
      id: `v-${i}`,
      type: 'car',
      color: '#3a86ff',
      position: { x, y: 0, z: z - 50 },
      heading: 0,
      speed: 5,
      targetSpeed: 20,
      roadId: nsId,
      laneIndex: 0,
      s: 10,
      lane: `${nsId}:0` as never,
      status: 'driving',
      desiredStatus: 'driving',
      enteredIntersectionAt: null,
      desiredLaneIndex: null,
      laneChangeStartedAt: null,
      spawnedAt: 0,
    }
  }
  return net
}

console.log('=== queue length: legacy convention vs topology lookup ===')
report('cross', buildCrossIntersectionNetwork())
report('t', buildTJunctionNetwork())
report('elevated', buildElevatedScene())
report('corridor', buildCorridorScene())
report('imported', buildImportedNetwork())

console.log('')
console.log('=== per-tick cost on a 600-light / 600-vehicle map ===')
{
  const net = buildBigNetwork(600)
  const lights = Object.values(net.intersections).flatMap((i) => i.trafficLights)
  const runs = 30

  // warm-up (also fills the per-tick index)
  for (const l of lights) getQueueLength(l, net, 0)

  let t0 = performance.now()
  for (let r = 0; r < runs; r++) for (const l of lights) getQueueLength(l, net, r)
  const indexedMs = (performance.now() - t0) / runs

  t0 = performance.now()
  for (let r = 0; r < runs; r++) for (const l of lights) getQueueLength(l, net)
  const scannedMs = (performance.now() - t0) / runs

  t0 = performance.now()
  for (let r = 0; r < runs; r++) for (const l of lights) legacyQueueLength(l, net)
  const legacyMs = (performance.now() - t0) / runs

  console.log(`lights=${lights.length}`)
  console.log(`  topology lookup, per-tick index : ${indexedMs.toFixed(3)} ms/tick`)
  console.log(`  topology lookup, direct scan    : ${scannedMs.toFixed(3)} ms/tick`)
  console.log(
    `  legacy convention lookup        : ${legacyMs.toFixed(3)} ms/tick (always 0 on a w-… map)`,
  )
}
