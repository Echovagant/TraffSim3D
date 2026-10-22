// Out-of-bounds cleanup tests.
import { describe, it, expect, beforeEach } from 'vitest'
import { lanePoint } from '@domain/services/laneGeometry'
import { buildTestNetwork, makeTestVehicle } from '@__fixtures__/testNetwork'
import { OUT_OF_BOUNDS_M } from '@shared/constants/simulation'
import { tickOobCleanup, type TickOobDeps } from './oobCleanup'
import type { RoadNetwork } from '@domain/entities/RoadNetwork'

describe('tickOobCleanup', () => {
  let net: RoadNetwork
  let respawned: string[]
  let removed: string[]
  let snapped: Array<{ id: string; x: number; y: number; z: number; heading: number }>

  beforeEach(() => {
    net = buildTestNetwork(0)
    respawned = []
    removed = []
    snapped = []
  })

  const makeDeps = (): TickOobDeps => ({
    getRoad: (id) => net.roads[id],
    removeVehicle: (id) => {
      removed.push(id)
      delete net.vehicles[id]
    },
    snapVehicle: (id, pos, heading) => {
      respawned.push(id)
      snapped.push({ id, x: pos.x, y: pos.y, z: pos.z, heading })
      const v = net.vehicles[id]
      if (v) {
        v.position = { x: pos.x, y: v.position.y, z: pos.z }
        v.heading = heading
        v.s = 0
        v.speed = 0
      }
    },
  })

  it('respawns vehicle drifted > 50m', () => {
    const v = makeTestVehicle({ id: 'v-far', roadId: 'r-ns', laneIndex: 0, s: 10, spawnedAt: -10 })
    net.vehicles['v-far'] = v
    v.position = { x: 1000, y: 0, z: 1000 }
    tickOobCleanup(makeDeps(), Object.values(net.vehicles), 5.0)
    expect(respawned).toContain('v-far')
    const expected = lanePoint(net.roads['r-ns']!, 0, 0)
    const s = snapped.find((x) => x.id === 'v-far')!
    expect(s.x).toBeCloseTo(expected.position.x, 1)
    expect(s.z).toBeCloseTo(expected.position.z, 1)
  })

  it('does not respawn vehicles within 50m', () => {
    const v = makeTestVehicle({ id: 'v-ok', roadId: 'r-ns', laneIndex: 0, s: 10, spawnedAt: -10 })
    net.vehicles['v-ok'] = v
    tickOobCleanup(makeDeps(), Object.values(net.vehicles), 5.0)
    expect(respawned).not.toContain('v-ok')
  })

  it('hard-deletes vehicles whose road is missing', () => {
    const v = makeTestVehicle({
      id: 'v-orphan',
      roadId: 'r-deleted',
      laneIndex: 0,
      s: 5,
      spawnedAt: -10,
    })
    net.vehicles['v-orphan'] = v
    tickOobCleanup(makeDeps(), Object.values(net.vehicles), 5.0)
    expect(removed).toContain('v-orphan')
    expect(respawned).not.toContain('v-orphan')
  })

  it('skips vehicles mid lane-change', () => {
    const v = makeTestVehicle({
      id: 'v-changing',
      roadId: 'r-ns',
      laneIndex: 0,
      s: 10,
      spawnedAt: -10,
      desiredLaneIndex: 1,
      laneChangeStartedAt: 0,
    })
    net.vehicles['v-changing'] = v
    v.position = { x: 1000, y: 0, z: 1000 }
    tickOobCleanup(makeDeps(), Object.values(net.vehicles), 5.0)
    expect(respawned).not.toContain('v-changing')
    expect(removed).not.toContain('v-changing')
  })

  it('skips vehicles spawned < 1s ago', () => {
    const v = makeTestVehicle({ id: 'v-new', roadId: 'r-ns', laneIndex: 0, s: 10, spawnedAt: 4.5 })
    net.vehicles['v-new'] = v
    v.position = { x: 1000, y: 0, z: 1000 }
    tickOobCleanup(makeDeps(), Object.values(net.vehicles), 5.0)
    expect(respawned).not.toContain('v-new')
  })
})
