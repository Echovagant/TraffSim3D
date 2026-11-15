// src/interfaces/stores/worldStore.crash.spec.ts
//
// The incident staging lever (the NTE-style "wreck the traffic" demo
// tool). Pinned here:
//
//   - `crashVehicle` flips a vehicle to the sticky `crashed` status with
//     zero speed/target — the wreck STANDS in its lane,
//   - `reviveVehicle` restores it to driving at the road's legal pace,
//   - an unknown id (or a already-wrecked / non-wrecked id) is a no-op
//     that reports false — the button can toggle without state surprises.
//
// The CONSEQUENCE (followers queueing behind the wreck) is the car-
// following model's own behaviour — the constraint treats a crashed
// vehicle as a stopped leader; that is pinned by the existing following
// tests and by the driving-behavior e2e.

import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorldStore } from './worldStore'
import { buildRectangularLoopNetwork } from '@application/services/defaultScene'

describe('worldStore incident staging (crash / revive)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  const firstVehicleId = (world: ReturnType<typeof useWorldStore>): string =>
    Object.keys(world.getNetwork().vehicles)[0]!

  it('crashVehicle flips the vehicle to a sticky wreck with zero speed', () => {
    const world = useWorldStore()
    world.loadNetwork(buildRectangularLoopNetwork(), 'test')
    const id = firstVehicleId(world)
    world.crashVehicle(id)

    const v = world.getNetwork().vehicles[id]!
    expect(v.status).toBe('crashed')
    expect(v.desiredStatus).toBe('crashed')
    expect(v.speed).toBe(0)
    expect(v.targetSpeed).toBe(0)
  })

  it('crashing an already-crashed vehicle is a no-op reporting false', () => {
    const world = useWorldStore()
    world.loadNetwork(buildRectangularLoopNetwork(), 'test')
    const id = firstVehicleId(world)
    expect(world.crashVehicle(id)).toBe(true)
    expect(world.crashVehicle(id)).toBe(false)
    // The state is untouched by the second call.
    expect(world.getNetwork().vehicles[id]!.status).toBe('crashed')
  })

  it('crashing an unknown id reports false without throwing', () => {
    const world = useWorldStore()
    world.loadNetwork(buildRectangularLoopNetwork(), 'test')
    expect(world.crashVehicle('ghost')).toBe(false)
  })

  it('reviveVehicle restores driving at the road speed limit', () => {
    const world = useWorldStore()
    world.loadNetwork(buildRectangularLoopNetwork(), 'test')
    const id = firstVehicleId(world)
    const limit = world.getNetwork().roads[world.getNetwork().vehicles[id]!.roadId]!.speedLimit
    world.crashVehicle(id)
    expect(world.reviveVehicle(id)).toBe(true)

    const v = world.getNetwork().vehicles[id]!
    expect(v.status).toBe('driving')
    expect(v.desiredStatus).toBe('driving')
    expect(v.targetSpeed).toBe(limit)
  })

  it('reviving a driving vehicle is a no-op reporting false', () => {
    const world = useWorldStore()
    world.loadNetwork(buildRectangularLoopNetwork(), 'test')
    const id = firstVehicleId(world)
    expect(world.reviveVehicle(id)).toBe(false)
  })

  it('a wreck survives network mutations it is not part of (state persists)', () => {
    const world = useWorldStore()
    world.loadNetwork(buildRectangularLoopNetwork(), 'test')
    const id = firstVehicleId(world)
    world.crashVehicle(id)
    // An unrelated tick-cycle event (bumpTick via crash) must not clear it.
    expect(world.getNetwork().vehicles[id]!.status).toBe('crashed')
  })
})
