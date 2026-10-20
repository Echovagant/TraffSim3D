import { describe, it, expect } from 'vitest'
import {
  cloneScene,
  hydrateNetwork,
  sceneToNetwork,
  serializeNetwork,
  SCENE_SCHEMA_VERSION,
} from '@infrastructure/persistence'
import { buildTestNetwork } from '@__fixtures__/testNetwork'

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
    expect(scene.schemaVersion).toBe(6) // plan 037 bumped to v6 (was v5 in 035)
    expect(typeof scene.savedAtMs).toBe('number')
  })

  it('preserves desiredLaneIndex + laneChangeStartedAt across round-trip (plan 029)', () => {
    const net = buildTestNetwork(1)
    net.vehicles['v-1']!.desiredLaneIndex = 1
    net.vehicles['v-1']!.laneChangeStartedAt = 12.5
    const scene = serializeNetwork(net)
    const restored = sceneToNetwork(scene)
    expect(restored.vehicles['v-1']!.desiredLaneIndex).toBe(1)
    expect(restored.vehicles['v-1']!.laneChangeStartedAt).toBe(12.5)
  })

  it('round-trips polyline waypoints (plan 035)', () => {
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
})
