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
import { buildCrossIntersectionNetwork } from '@application/services/defaultScene'
import { tick, type TickContext } from '@application/services/tick'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'
import { INTERSECTION_CLEARANCE_M, ROAD_LANE_WIDTH } from '@shared/constants/simulation'
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
    // The payload's radius (8) disagrees with the derived one (11.5).
    expect(stats.radiusMismatches).toBe(1)
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

describe('normalizeOsmPayload — the one-way flag survives the import', () => {
  it('keeps `oneway: true` on a one-way road', () => {
    // The OSM parser emits `oneway` for every road. It used to be dropped
    // here, so a one-way street in an imported map came back as a two-way
    // one and traffic could drive against it.
    const { network } = normalizeOsmPayload({
      ...BACKEND_PAYLOAD,
      roads: [{ ...BACKEND_PAYLOAD.roads[0], oneway: true }, BACKEND_PAYLOAD.roads[1]],
    })
    expect(network.road('w-201')?.oneway).toBe(true)
  })

  it('keeps `oneway: false` on a two-way road', () => {
    const { network } = normalizeOsmPayload({
      ...BACKEND_PAYLOAD,
      roads: [{ ...BACKEND_PAYLOAD.roads[0], oneway: false }, BACKEND_PAYLOAD.roads[1]],
    })
    expect(network.road('w-201')?.oneway).toBe(false)
  })

  it('leaves the flag undefined when the payload does not state it', () => {
    // The built-in scenes and every scene saved before the field existed
    // carry no flag; the simulation reads that as two-way, so the default
    // behaviour is unchanged.
    const { network } = normalizeOsmPayload(BACKEND_PAYLOAD)
    expect(network.road('w-201')?.oneway).toBeUndefined()
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

describe('normalizeOsmPayload — the spawn point arc length', () => {
  // The backend computes `s` itself: an OSM junction is a node *shared*
  // by two ways, so it sits at a way endpoint, and `s = 0` (the road's
  // start) is therefore usually right inside the junction. The backend
  // projects the junction onto the road and puts the spawn point at the
  // end that is furthest from every junction on it.
  //
  // The adapter must keep that value. It used to derive its own spawn
  // points at `s = 0`, which put every imported car into a junction.

  const BACKEND_SPAWN = {
    id: 'sp-w-201-0',
    roadId: 'w-201',
    laneIndex: 0,
    s: 137.5,
    occupiedBy: null,
  }

  it('keeps the arc length the backend computed', () => {
    const { network } = normalizeOsmPayload({
      ...BACKEND_PAYLOAD,
      spawnPoints: [BACKEND_SPAWN],
    })
    expect(network.spawnPoint('sp-w-201-0')?.s).toBe(137.5)
  })

  it('does not derive spawn points when the payload carries them', () => {
    const { network, stats } = normalizeOsmPayload({
      ...BACKEND_PAYLOAD,
      spawnPoints: [BACKEND_SPAWN],
    })
    expect(stats.derivedSpawnPoints).toBe(0)
    // Only the backend's spawn point exists — nothing was added.
    expect(Object.keys(network.spawnPoints)).toEqual(['sp-w-201-0'])
  })

  it('derives spawn points only when the payload carries none', () => {
    const { spawnPoints: _omitted, ...withoutSpawnPoints } = BACKEND_PAYLOAD
    const { network, stats } = normalizeOsmPayload(withoutSpawnPoints)
    expect(stats.derivedSpawnPoints).toBe(2)
    // The fallback keeps the historical shape: one per road, lane 0, s = 0.
    expect(network.spawnPoint('sp-w-201-0')?.s).toBe(0)
    expect(network.spawnPoint('sp-w-202-0')?.s).toBe(0)
  })

  it('spawns the vehicle at the arc length the backend asked for', () => {
    const { network } = normalizeOsmPayload({
      ...BACKEND_PAYLOAD,
      spawnPoints: [BACKEND_SPAWN],
    })
    expect(spawnImportedVehicles(network, 1)).toBe(1)
    const vehicle = network.vehicles['v-1']!
    expect(vehicle.roadId).toBe('w-201')
    // The car enters at the backend's arc length, not at the road's start.
    expect(vehicle.s).toBe(137.5)
  })

  it('spawns the vehicle at the road start when the payload had no spawn points', () => {
    const { spawnPoints: _omitted, ...withoutSpawnPoints } = BACKEND_PAYLOAD
    const { network } = normalizeOsmPayload(withoutSpawnPoints)
    expect(spawnImportedVehicles(network, 1)).toBe(1)
    expect(network.vehicles['v-1']!.s).toBe(0)
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
    // The radius is **derived** from the lane model, not read from the
    // payload: the widest connected road (w-201, 4 lanes) has a 7 m
    // half-width, plus the 4.5 m nose-overhang clearance -> 11.5 m.
    // The payload still says 8 (the old hard-coded value) — the payload
    // is a cross-check, not the source of truth.
    expect(inter!.intersectionRadius).toBe(11.5)
  })
})

describe('normalizeOsmPayload — the junction radius is derived, not taken from the payload', () => {
  it("sizes the box from the widest connected road's half-width plus the clearance", () => {
    const { network } = normalizeOsmPayload(BACKEND_PAYLOAD)
    const inter = network.intersection('i-osm-0')!
    // w-201 has 4 lanes (half-width 7 m), w-202 has 2 (3.5 m) -> the
    // widest decides.
    expect(inter.intersectionRadius).toBe((4 * ROAD_LANE_WIDTH) / 2 + INTERSECTION_CLEARANCE_M)
  })

  it('ignores a stale radius in the payload', () => {
    // The payload claims 8 m (what the old parser hard-coded). The
    // frontend derives 11.5 m and reports the disagreement.
    const { network, stats } = normalizeOsmPayload(BACKEND_PAYLOAD)
    expect(network.intersection('i-osm-0')!.intersectionRadius).toBe(11.5)
    expect(stats.radiusMismatches).toBe(1)
  })

  it('reports no mismatch when the payload agrees with the derived radius', () => {
    const { stats } = normalizeOsmPayload({
      ...BACKEND_PAYLOAD,
      intersections: [{ ...BACKEND_PAYLOAD.intersections[0]!, intersectionRadius: 11.5 }],
    })
    expect(stats.radiusMismatches).toBe(0)
  })

  it('derives the radius even when the payload carries none', () => {
    const { intersectionRadius: _omitted, ...withoutRadius } = BACKEND_PAYLOAD.intersections[0]!
    const { network, stats } = normalizeOsmPayload({
      ...BACKEND_PAYLOAD,
      intersections: [withoutRadius],
    })
    expect(network.intersection('i-osm-0')!.intersectionRadius).toBe(11.5)
    // No radius in the payload is not a disagreement — there was nothing
    // to disagree with.
    expect(stats.radiusMismatches).toBe(0)
  })

  it('falls back to the default lane count for a junction with no known road', () => {
    const { network } = normalizeOsmPayload({
      ...BACKEND_PAYLOAD,
      intersections: [
        {
          ...BACKEND_PAYLOAD.intersections[0]!,
          connectedRoads: ['w-does-not-exist'],
        },
      ],
    })
    // The 2-lane default road (the same lane count the adapter assumes
    // for a road without one) -> 3.5 m half-width + 4.5 m clearance.
    expect(network.intersection('i-osm-0')!.intersectionRadius).toBe(
      (2 * ROAD_LANE_WIDTH) / 2 + INTERSECTION_CLEARANCE_M,
    )
  })

  it('gives an imported junction the same radius the built-in scenes give it', () => {
    // The whole point of the derivation: an imported junction and a
    // built-in one are sized by the SAME rule, so the imported map's
    // stop lines and the built-in scenes' cannot drift apart.
    const sixLanes = normalizeOsmPayload({
      ...BACKEND_PAYLOAD,
      roads: [{ ...BACKEND_PAYLOAD.roads[0]!, laneCount: 6 }, BACKEND_PAYLOAD.roads[1]!],
    }).network.intersection('i-osm-0')!
    const cross = buildCrossIntersectionNetwork()
    const builtIn = Object.values(cross.intersections)[0]!
    expect(sixLanes.intersectionRadius).toBe(builtIn.intersectionRadius)
    expect(sixLanes.intersectionRadius).toBe(15)
  })
})
