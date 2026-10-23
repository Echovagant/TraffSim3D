// src/infrastructure/api/osmNetworkAdapter.spec.ts
//
// Regression tests for the OSM import adapter.
//
// The bug these lock down: the backend answers with ARRAYS, the
// frontend network is record-shaped. The old import path assigned the
// payload verbatim (`loadNetwork(payload as never)`), so `network.roads`
// was keyed by array index ("0", "1", …) and every id lookup missed —
// `network.roads['w-201']` was `undefined` and `spawnVehicle` died with
// `TypeError: Cannot read properties of undefined (reading 'waypoints')`.

import { describe, it, expect } from 'vitest'
import { spawnVehicle } from '@application/services/spawnVehicle'
import { tick, type TickContext } from '@application/services/tick'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import { deriveSpawnPoints, normalizeOsmPayload, spawnImportedVehicles } from './osmNetworkAdapter'

/** Minimal tick context — no physics, no controllers: the hand-rolled
 *  signal cycle still runs, which is what the imported lights feed. */
const makeTickContext = (): TickContext => ({
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

/** A payload shaped exactly like the backend's `parse-osm` answer. */
const BACKEND_PAYLOAD = {
  roads: [
    {
      id: 'w-201',
      startNode: { x: 0, y: 0, z: 0 },
      endNode: { x: 200, y: 0, z: 0 },
      waypoints: [
        { x: 0, y: 0, z: 0 },
        { x: 100, y: 0, z: 0 },
        { x: 200, y: 0, z: 0 },
      ],
      laneCount: 4,
      speedLimit: 16.67,
      level: 0,
    },
    {
      id: 'w-202',
      startNode: { x: 200, y: 0, z: 0 },
      endNode: { x: 200, y: 0, z: 150 },
      waypoints: [
        { x: 200, y: 0, z: 0 },
        { x: 200, y: 0, z: 150 },
      ],
      laneCount: 2,
      speedLimit: 13.89,
      level: 0,
    },
  ],
  intersections: [
    {
      id: 'i-osm-0',
      position: { x: 200, y: 0, z: 0 },
      trafficLights: [
        {
          id: 'tl-0',
          position: { x: 197, y: 0, z: 0 },
          phase: 'green',
          phaseRemaining: 30,
          cycleSeconds: 63,
          axis: 'ns',
        },
      ],
      connectedRoads: ['w-201', 'w-202'],
      intersectionRadius: 8,
    },
  ],
  vehicles: [],
  spawnPoints: [{ id: 'sp-0', roadId: 'w-201', laneIndex: 0, s: 0, occupiedBy: null }],
  originLat: 39.9055,
  originLon: 116.3976,
}

describe('normalizeOsmPayload — record keys come from the entity ids', () => {
  it('keys the roads by their id, not by the array index', () => {
    const { network } = normalizeOsmPayload(BACKEND_PAYLOAD)
    const keys = Object.keys(network.roads)
    expect(keys).toEqual(['w-201', 'w-202'])
    // The old bug: the keys were "0", "1", …
    expect(keys).not.toContain('0')
    expect(keys.some((key) => /^\d+$/.test(key))).toBe(false)
  })

  it('resolves a road by id (the lookup that used to miss)', () => {
    const { network } = normalizeOsmPayload(BACKEND_PAYLOAD)
    expect(network.road('w-201')).toBeDefined()
    expect(network.road('w-201')?.id).toBe('w-201')
    expect(network.road('w-201')).toBe(network.roads['w-201'])
    expect(network.road('does-not-exist')).toBeUndefined()
  })

  it('keys the intersections, vehicles and spawn points by their ids', () => {
    const { network } = normalizeOsmPayload(BACKEND_PAYLOAD)
    expect(Object.keys(network.intersections)).toEqual(['i-osm-0'])
    expect(network.intersection('i-osm-0')?.trafficLights[0]?.id).toBe('tl-0')
    expect(Object.keys(network.spawnPoints)).toEqual(['sp-0'])
    expect(network.spawnPoint('sp-0')?.roadId).toBe('w-201')
  })

  it('keeps the traffic light fields the tick needs', () => {
    const { network } = normalizeOsmPayload(BACKEND_PAYLOAD)
    const light = network.intersection('i-osm-0')?.trafficLights[0]
    expect(light?.phase).toBe('green')
    expect(light?.phaseRemaining).toBe(30)
    expect(light?.cycleSeconds).toBe(63)
    expect(light?.axis).toBe('ns')
  })

  it('reports the import counters the UI shows', () => {
    const { stats } = normalizeOsmPayload(BACKEND_PAYLOAD)
    expect(stats.roads).toBe(2)
    expect(stats.intersections).toBe(1)
    expect(stats.lights).toBe(1)
    expect(stats.spawnPoints).toBe(1)
    expect(stats.dropped).toBe(0)
  })
})

describe('normalizeOsmPayload — tolerance for a partially filled payload', () => {
  it('does not throw when the payload has no spawnPoints', () => {
    const { spawnPoints: _omitted, ...withoutSpawnPoints } = BACKEND_PAYLOAD
    expect(() => normalizeOsmPayload(withoutSpawnPoints)).not.toThrow()
    const { network, stats } = normalizeOsmPayload(withoutSpawnPoints)
    // Fallback: spawn points are derived from the roads.
    expect(stats.derivedSpawnPoints).toBe(2)
    expect(Object.keys(network.spawnPoints)).toHaveLength(2)
    expect(network.spawnPoint('sp-w-201-0')?.roadId).toBe('w-201')
  })

  it('does not throw when the payload has no originLat / originLon', () => {
    const { originLat: _lat, originLon: _lon, ...withoutOrigin } = BACKEND_PAYLOAD
    expect(() => normalizeOsmPayload(withoutOrigin)).not.toThrow()
    const { network, origin } = normalizeOsmPayload(withoutOrigin)
    expect(origin).toBeNull()
    expect(network.origin).toBeUndefined()
  })

  it('does not throw on an empty / garbage payload', () => {
    expect(() => normalizeOsmPayload({})).not.toThrow()
    expect(() => normalizeOsmPayload(null)).not.toThrow()
    expect(() => normalizeOsmPayload({ roads: 'nope', intersections: 42 })).not.toThrow()
    const { network } = normalizeOsmPayload({})
    expect(Object.keys(network.roads)).toHaveLength(0)
  })

  it('drops a spawn point that points at a road that does not exist', () => {
    const { network, stats } = normalizeOsmPayload({
      ...BACKEND_PAYLOAD,
      spawnPoints: [{ id: 'sp-bad', roadId: 'w-nope', laneIndex: 0, s: 0, occupiedBy: null }],
    })
    // The dangling spawn point is gone (it would have crashed the spawner).
    expect(network.spawnPoint('sp-bad')).toBeUndefined()
    expect(stats.dropped).toBe(1)
    // …and the fallback derivation filled the gap from the roads.
    expect(stats.derivedSpawnPoints).toBe(2)
  })

  it('keeps the geographic origin when the payload carries one', () => {
    const { origin, network } = normalizeOsmPayload(BACKEND_PAYLOAD)
    expect(origin).toEqual({ lat: 39.9055, lon: 116.3976 })
    expect(network.origin).toEqual({ lat: 39.9055, lon: 116.3976 })
  })
})

describe('normalizeOsmPayload — coordinate frame', () => {
  it('converts the backend frame (north-positive Z) into the app frame (north = -Z)', () => {
    const { network } = normalizeOsmPayload(BACKEND_PAYLOAD)
    // The payload's w-201 runs east (+X) — unchanged.
    expect(network.road('w-201')?.waypoints?.[1]?.x).toBe(100)
    // w-202 runs north in the payload (+Z) → -Z in the app frame.
    expect(network.road('w-202')?.waypoints?.[1]?.z).toBe(-150)
    expect(network.road('w-202')?.endNode.z).toBe(-150)
  })
})

describe('import → normalize → spawn (the end-to-end chain)', () => {
  it('the old shape still throws — the exact pre-fix failure', () => {
    // What the import path used to hand to `worldStore.loadNetwork`.
    const broken = BACKEND_PAYLOAD as unknown as RoadNetwork
    expect(() => spawnVehicle(broken, 'v-1')).toThrow(/waypoints/)
  })

  it('spawns a vehicle on a road that actually exists', () => {
    const { network } = normalizeOsmPayload({
      ...BACKEND_PAYLOAD,
      spawnPoints: [{ id: 'sp-0', roadId: 'w-201', laneIndex: 0, s: 0, occupiedBy: null }],
    })
    const spawned = spawnImportedVehicles(network, 1)
    expect(spawned).toBe(1)
    expect(Object.keys(network.vehicles)).toHaveLength(1)
    const vehicle = network.vehicles['v-1']!
    expect(vehicle).toBeDefined()
    expect(vehicle.roadId).toBe('w-201')
    expect(network.roads[vehicle.roadId]).toBeDefined()
    expect(network.road(vehicle.roadId)?.id).toBe(vehicle.roadId)
    // The spawn point is now taken.
    expect(network.spawnPoint('sp-0')?.occupiedBy).toBe('v-1')
  })

  it('spawns vehicles even when the payload carries no spawn points', () => {
    const { spawnPoints: _omitted, ...withoutSpawnPoints } = BACKEND_PAYLOAD
    const { network } = normalizeOsmPayload(withoutSpawnPoints)
    const spawned = spawnImportedVehicles(network, 2)
    expect(spawned).toBe(2)
    expect(Object.keys(network.vehicles)).toHaveLength(2)
    for (const vehicle of Object.values(network.vehicles)) {
      expect(network.roads[vehicle.roadId]).toBeDefined()
    }
  })

  it('derives one spawn point per road, on the rightmost forward lane', () => {
    const { network, stats } = normalizeOsmPayload({
      ...BACKEND_PAYLOAD,
      spawnPoints: [],
    })
    // The payload had none → the adapter derived one per road.
    expect(stats.derivedSpawnPoints).toBe(2)
    const spawnPoint = network.spawnPoint('sp-w-201-0')!
    expect(spawnPoint.roadId).toBe('w-201')
    expect(spawnPoint.laneIndex).toBe(0)
    expect(spawnPoint.s).toBe(0)
    expect(spawnPoint.occupiedBy).toBeNull()
  })

  it('deriveSpawnPoints is idempotent on an already-derived network', () => {
    const { network } = normalizeOsmPayload({ ...BACKEND_PAYLOAD, spawnPoints: [] })
    const added = deriveSpawnPoints(network)
    expect(added).toBe(0)
    expect(Object.keys(network.spawnPoints)).toHaveLength(2)
  })
})

describe('the imported map is a simulation input (not only a rendering)', () => {
  it('the imported traffic lights advance in the tick', () => {
    const { network } = normalizeOsmPayload(BACKEND_PAYLOAD)
    const light = network.intersection('i-osm-0')!.trafficLights[0]!
    expect(light.phase).toBe('green')

    tick(network, 1, 1, makeTickContext())
    expect(light.phaseRemaining).toBe(29)

    // The remaining green time runs out → the light turns yellow.
    tick(network, 29, 30, makeTickContext())
    expect(light.phase).toBe('yellow')
    expect(light.phaseRemaining).toBe(3)
  })

  it('the imported intersections are found by the road ids the tick looks up', () => {
    const { network } = normalizeOsmPayload(BACKEND_PAYLOAD)
    // tick.ts resolves the intersection of a road via connectedRoads —
    // that lookup only works when the records are keyed by id.
    const road = network.road('w-201')!
    const inter = Object.values(network.intersections).find((i) =>
      i.connectedRoads.includes(road.id),
    )
    expect(inter).toBeDefined()
    expect(inter!.intersectionRadius).toBe(8)
  })
})
