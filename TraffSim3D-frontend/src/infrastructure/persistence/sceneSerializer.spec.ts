import { describe, it, expect } from 'vitest'
import {
  cloneScene,
  hydrateNetwork,
  sceneToNetwork,
  serializeNetwork,
  SCENE_SCHEMA_VERSION,
} from '@infrastructure/persistence'
import { buildTestNetwork } from '@__fixtures__/testNetwork'
import { stopLineSOnRoad } from '@domain/services/laneGeometry'

describe('sceneSerializer round-trip', () => {
  it('cloneScene produces a deep-independent copy', () => {
    const net = buildTestNetwork(2)
    const scene = serializeNetwork(net)
    const cloned = cloneScene(scene)
    // Mutate the original; cloned should not see it.
    net.vehicles['v-1']!.color = '#000000'
    expect(cloned.network.vehicles.find((v) => v.id === 'v-1')!.color).not.toBe('#000000')
  })

  it('sceneToNetwork restores a valid network', () => {
    const net = buildTestNetwork(2)
    const scene = serializeNetwork(net)
    const restored = sceneToNetwork(scene)
    expect(restored.roads['r-ns']).toBeDefined()
    expect(Object.keys(restored.vehicles).length).toBe(2)
  })

  it('serialized scene includes current schemaVersion + savedAtMs', () => {
    const net = buildTestNetwork(0)
    const scene = serializeNetwork(net)
    expect(scene.schemaVersion).toBe(SCENE_SCHEMA_VERSION)
    expect(scene.schemaVersion).toBe(6) // bumped to v6 (was v5)
    expect(typeof scene.savedAtMs).toBe('number')
  })

  it('preserves desiredLaneIndex + laneChangeStartedAt across round-trip', () => {
    const net = buildTestNetwork(1)
    net.vehicles['v-1']!.desiredLaneIndex = 1
    net.vehicles['v-1']!.laneChangeStartedAt = 12.5
    const scene = serializeNetwork(net)
    const restored = sceneToNetwork(scene)
    expect(restored.vehicles['v-1']!.desiredLaneIndex).toBe(1)
    expect(restored.vehicles['v-1']!.laneChangeStartedAt).toBe(12.5)
  })

  it('round-trips polyline waypoints', () => {
    const net = buildTestNetwork(0)
    const polyRoad = {
      id: 'r-poly',
      startNode: { x: 0, y: 0, z: 0 },
      endNode: { x: 30, y: 0, z: 30 },
      waypoints: [
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 15 },
        { x: 30, y: 0, z: 30 },
      ],
      laneCount: 2,
      speedLimit: 20,
      level: 0,
    }
    net.roads['r-poly'] = polyRoad
    const scene = serializeNetwork(net)
    const restored = sceneToNetwork(scene)
    expect(restored.roads['r-poly']!.waypoints).toBeDefined()
    expect(restored.roads['r-poly']!.waypoints!.length).toBe(3)
    expect(restored.roads['r-poly']!.waypoints![1]).toEqual({ x: 0, y: 0, z: 15 })
  })

  it('migrates v4 scenes (no waypoints) to v5 transparently', () => {
    // Hand-rolled v4 payload (pre-035). No `waypoints`, no
    // `intersectionRadius` on intersections. After migration, the
    // schemaVersion is bumped to 5 and the round-trip yields a
    // working network.
    const v4Scene = {
      schemaVersion: 4,
      savedAtMs: 1700000000000,
      network: {
        roads: [
          {
            id: 'r-old',
            startNode: { x: -30, y: 0, z: 0 },
            endNode: { x: 30, y: 0, z: 0 },
            laneCount: 2,
            speedLimit: 20,
          },
        ],
        intersections: [
          {
            id: 'i-old',
            position: { x: 0, y: 0, z: 0 },
            connectedRoads: ['r-old'],
            trafficLights: [],
          },
        ],
        vehicles: [],
      },
    }
    const result = hydrateNetwork(v4Scene)
    expect(result.ok).toBe(true)
    if (result.ok && result.network) {
      expect(result.network.roads['r-old']).toBeDefined()
      // No waypoints in v4 → undefined after load (geometry helpers
      // fall back to 2-point straight).
      expect(result.network.roads['r-old']!.waypoints).toBeUndefined()
      // Intersection has no `intersectionRadius` in v4; the field is
      // added as required at the type level, so code sites that
      // construct Intersection must always set it (the testNetwork
      // fixture / defaultScene factories do).
    }
  })

  it('derives the missing junction radius of a v4 scene instead of leaving it undefined', () => {
    // A v4 scene carries no `intersectionRadius`. It used to load as
    // `undefined`, and the stop line is computed from that value
    // (`Math.max(0, undefined)` → NaN) — so the traffic-light constraint
    // compared against NaN and **never fired**: cars in an old scene ran
    // red lights. The radius is now derived from the lane model of the
    // roads the junction connects.
    const v4Scene = {
      schemaVersion: 4,
      savedAtMs: 1700000000000,
      network: {
        roads: [
          {
            id: 'r-old',
            startNode: { x: -30, y: 0, z: 0 },
            endNode: { x: 30, y: 0, z: 0 },
            laneCount: 2,
            speedLimit: 20,
          },
        ],
        intersections: [
          {
            id: 'i-old',
            position: { x: 0, y: 0, z: 0 },
            connectedRoads: ['r-old'],
            trafficLights: [],
          },
        ],
        vehicles: [],
      },
    }
    const result = hydrateNetwork(v4Scene)
    expect(result.ok).toBe(true)
    if (result.ok && result.network) {
      const intersection = result.network.intersections['i-old']!
      // 2 lanes → half-width 3.5 m, plus the 4.5 m nose-overhang
      // clearance → 8 m.
      expect(intersection.intersectionRadius).toBe(8)
      // The symptom the missing radius caused: the stop line has to be
      // a real number, or the traffic light never stops anyone.
      const stopS = stopLineSOnRoad(result.network.roads['r-old']!, intersection, 0)
      expect(Number.isFinite(stopS)).toBe(true)
    }
  })
})

describe('the geographic origin round-trip', () => {
  const ORIGIN = { lat: 22.543099, lon: 114.057868 }

  it('serializes the origin of an imported map', () => {
    const net = buildTestNetwork(0)
    net.origin = { ...ORIGIN }
    const scene = serializeNetwork(net)
    expect(scene.network.origin).toBeDefined()
    expect(scene.network.origin!.lat).toBe(ORIGIN.lat)
    expect(scene.network.origin!.lon).toBe(ORIGIN.lon)
  })

  it('round-trips the origin field by field', () => {
    const net = buildTestNetwork(2)
    net.origin = { ...ORIGIN }
    const scene = serializeNetwork(net)
    const result = hydrateNetwork(JSON.stringify(scene))
    expect(result.ok).toBe(true)
    if (result.ok && result.network) {
      expect(result.network.origin).toBeDefined()
      expect(result.network.origin!.lat).toBe(ORIGIN.lat)
      expect(result.network.origin!.lon).toBe(ORIGIN.lon)
    }
  })

  it('a scene without an origin loads with origin === undefined', () => {
    // Every scene saved before the field existed — and every synthetic
    // (built-in) scene, which has no geographic meaning.
    const net = buildTestNetwork(1)
    expect(net.origin).toBeUndefined()
    const scene = serializeNetwork(net)
    expect(scene.network.origin).toBeUndefined()
    expect('origin' in scene.network).toBe(false)

    const result = hydrateNetwork(JSON.stringify(scene))
    expect(result.ok).toBe(true)
    if (result.ok && result.network) {
      expect(result.network.origin).toBeUndefined()
    }
  })

  it('round-trips the spawn points', () => {
    // The spawn points are the places a vehicle can be spawned from. If
    // the serializer drops them, a reloaded scene silently loses that
    // ability (`tick` reads an empty map as "no spawn limits"), and the
    // scene comes back looking intact while behaving differently.
    const net = buildTestNetwork(1)
    const scene = serializeNetwork(net)
    expect(scene.network.spawnPoints).toBeDefined()
    expect(scene.network.spawnPoints!.length).toBe(Object.keys(net.spawnPoints).length)

    const result = hydrateNetwork(JSON.stringify(scene))
    expect(result.ok).toBe(true)
    if (result.ok && result.network) {
      expect(Object.keys(result.network.spawnPoints).sort()).toEqual(
        Object.keys(net.spawnPoints).sort(),
      )
      for (const sp of Object.values(net.spawnPoints)) {
        const back = result.network.spawnPoints[sp.id]
        expect(back).toBeDefined()
        expect(back!.roadId).toBe(sp.roadId)
        expect(back!.laneIndex).toBe(sp.laneIndex)
        expect(back!.s).toBe(sp.s)
        expect(back!.occupiedBy).toBe(sp.occupiedBy)
      }
    }
  })

  it('a hand-written legacy payload (no origin field) still loads', () => {
    const legacyScene = {
      schemaVersion: 6,
      savedAtMs: 1700000000000,
      network: {
        roads: [
          {
            id: 'r-old',
            startNode: { x: -30, y: 0, z: 0 },
            endNode: { x: 30, y: 0, z: 0 },
            laneCount: 2,
            speedLimit: 20,
            level: 0,
          },
        ],
        intersections: [
          {
            id: 'i-old',
            position: { x: 0, y: 0, z: 0 },
            connectedRoads: ['r-old'],
            trafficLights: [],
            intersectionRadius: 8,
          },
        ],
        vehicles: [],
      },
    }
    const result = hydrateNetwork(legacyScene)
    expect(result.ok).toBe(true)
    if (result.ok && result.network) {
      expect(result.network.origin).toBeUndefined()
      expect(result.network.roads['r-old']).toBeDefined()
    }
  })

  it('rejects a malformed origin instead of silently dropping it', () => {
    const net = buildTestNetwork(0)
    net.origin = { ...ORIGIN }
    const scene = serializeNetwork(net)
    ;(scene.network.origin as unknown as Record<string, unknown>).lat = 'north'
    const result = hydrateNetwork(scene)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('invalid network origin')
  })

  it('keeps the schema version — the LocalStorage key embeds it', () => {
    // `LocalStorageAdapter` stores under `traffsim3d:scene:v${version}`,
    // so a version bump would orphan every saved scene of every user.
    expect(SCENE_SCHEMA_VERSION).toBe(6)
  })
})
