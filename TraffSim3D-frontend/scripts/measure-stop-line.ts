// scripts/measure-stop-line.ts
//
// Measurement harness for the "stop line at the real intersection" change.
//
// Runs three scenarios and dumps the per-tick vehicle state to JSON so
// the before/after numbers can be diffed:
//
//   A. the built-in cross scene as-is (6 vehicles, both travel directions)
//   B. one vehicle on a FORWARD lane approaching a red light
//   C. one vehicle on a BACKWARD lane approaching a red light
//
// Usage:
//   npx vite-node scripts/measure-stop-line.ts <out.json>
//
// The script is measurement-only: it writes nothing into the repo.

import fs from 'node:fs'
import { tick } from '@application/services/tick'
import type { TickContext } from '@application/services/tick'
import { buildCrossIntersectionNetwork } from '@application/services/defaultScene'
import { createRoadNetwork } from '@domain/entities/RoadNetwork'
import { LaneId } from '@domain/value-objects/LaneId'
import { LightPhase } from '@domain/value-objects/Phase'
import { lanePoint, roadLength } from '@domain/services/laneGeometry'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import type { Vehicle } from '@domain/entities/Vehicle'

const DT = 1 / 60

const makeCtx = (): TickContext => ({
  rapierWorld: null,
  signal: null,
  trajectoryExporter: null,
  sensorRegistry: null,
  lidarEnabled: false,
  getHostPose: () => null,
  fixedStepScheduler: null,
  draggingId: null,
  removeVehicle: () => {},
  policy: null,
  replayTargetId: null,
})

interface Sample {
  tick: number
  id: string
  laneIndex: number
  s: number
  speed: number
  targetSpeed: number
  status: string
}

const runScenario = (net: RoadNetwork, ticks: number): Sample[] => {
  const ctx = makeCtx()
  const samples: Sample[] = []
  for (let i = 0; i < ticks; i++) {
    const simTime = (i + 1) * DT
    tick(net, DT, simTime, ctx)
    for (const v of Object.values(net.vehicles)) {
      samples.push({
        tick: i,
        id: v.id,
        laneIndex: v.laneIndex,
        s: v.s,
        speed: v.speed,
        targetSpeed: v.targetSpeed,
        status: v.status,
      })
    }
  }
  return samples
}

/** A straight NS road with a red light in the middle (the built-in shape). */
const buildRedLightRoad = (laneIndex: number, startS: number, speed: number): RoadNetwork => {
  const net = createRoadNetwork()
  const len = 60
  net.roads['r-ns'] = {
    id: 'r-ns',
    startNode: { x: 0, y: 0, z: -30 },
    endNode: { x: 0, y: 0, z: 30 },
    laneCount: 6,
    speedLimit: 16.67,
    level: 0,
  }
  net.intersections['i-center'] = {
    id: 'i-center',
    position: { x: 0, y: 0, z: 0 },
    connectedRoads: ['r-ns'],
    trafficLights: [
      {
        id: 'tl-ns',
        position: { x: -4, y: 0, z: 0 },
        phase: LightPhase.Red,
        phaseRemaining: 30,
        cycleSeconds: 63,
        axis: 'ns',
      },
    ],
    intersectionRadius: 8,
  }
  const road = net.roads['r-ns']!
  const lp = lanePoint(road, laneIndex, startS)
  const v: Vehicle = {
    id: 'v-1',
    type: 'car',
    color: '#3a86ff',
    position: { ...lp.position },
    heading: lp.heading,
    speed,
    targetSpeed: road.speedLimit,
    roadId: 'r-ns',
    laneIndex,
    s: startS,
    lane: LaneId.make('r-ns', laneIndex),
    status: 'driving',
    desiredStatus: 'driving',
    enteredIntersectionAt: null,
    desiredLaneIndex: null,
    laneChangeStartedAt: null,
    spawnedAt: 0,
  }
  net.vehicles['v-1'] = v
  return net
}

const out = process.argv[2] ?? 'measure-stop-line.json'

const cross = buildCrossIntersectionNetwork()
const crossSamples = runScenario(cross, 300)

const forward = runScenario(buildRedLightRoad(0, 5, 12), 300)
const backward = runScenario(buildRedLightRoad(5, 55, 12), 300)

const result = {
  generatedAt: new Date().toISOString(),
  roadLength: roadLength(cross.roads['r-ns']!),
  cross: crossSamples,
  forward: forward,
  backward: backward,
}

fs.writeFileSync(out, JSON.stringify(result, null, 2))
console.log(`wrote ${out}`)
console.log(
  `cross vehicles: ${Object.keys(cross.vehicles).length}, ` +
    `forward final s = ${forward[forward.length - 1]?.s}, ` +
    `backward final s = ${backward[backward.length - 1]?.s}`,
)
