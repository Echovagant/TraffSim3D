// src/interfaces/stores/worldStore.inspectorOverride.spec.ts
//
// The Inspector's speed field used to be a single-frame lie.
//
// `setVehicleSpeed()` wrote `v.speed` once; the next `tick()` re-derived
// the speed from the road's speed limit, so the number the user typed
// was gone within one frame (set 90 km/h → the next tick read back
// 59.4 km/h). The control looked editable and did nothing.
//
// The fix makes the user's value a persistent *pin* that the store
// re-applies after every tick. The pin is suspended while a policy
// replay is running — the replay target's speed belongs to the policy
// and the Python-side contract compares that state bit-for-bit.

import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorldStore } from './worldStore'

const KMH_90 = 90 / 3.6

describe('worldStore — the Inspector speed is a persistent pin', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('keeps 90 km/h after 30 ticks (the tick would otherwise re-derive the road limit)', () => {
    const world = useWorldStore()
    const id = 'v-1'

    world.setVehicleSpeed(id, 90)
    expect(world.network.vehicles[id].speed).toBeCloseTo(KMH_90, 9)
    expect(world.getVehicleSpeedOverride(id)).toBeCloseTo(KMH_90, 9)

    for (let i = 0; i < 30; i++) world.step(1 / 30)

    expect(world.network.vehicles[id]).toBeDefined()
    expect(world.network.vehicles[id].speed).toBeCloseTo(KMH_90, 9)
    expect(world.network.vehicles[id].targetSpeed).toBeCloseTo(KMH_90, 9)
  })

  it('leaves the other vehicles on their road limit (the pin is per vehicle)', () => {
    const world = useWorldStore()

    world.setVehicleSpeed('v-1', 90)
    for (let i = 0; i < 30; i++) world.step(1 / 30)

    const other = world.network.vehicles['v-2']
    expect(other).toBeDefined()
    expect(other.speed).not.toBeCloseTo(KMH_90, 3)
  })

  it('releases the pin and hands the vehicle back to the controller', () => {
    const world = useWorldStore()
    const id = 'v-1'

    world.setVehicleSpeed(id, 90)
    expect(world.getVehicleSpeedOverride(id)).not.toBeNull()

    world.clearVehicleSpeedOverride(id)
    expect(world.getVehicleSpeedOverride(id)).toBeNull()

    for (let i = 0; i < 30; i++) world.step(1 / 30)
    expect(world.network.vehicles[id].speed).not.toBeCloseTo(KMH_90, 3)
  })

  it('does not apply the pin while a policy replay is running', () => {
    const world = useWorldStore()
    const id = 'v-1'

    world.setVehicleSpeed(id, 90)
    world.replayActive = true

    for (let i = 0; i < 30; i++) world.step(1 / 30)

    // The replay owns the speed — the pin must not fight it.
    expect(world.network.vehicles[id].speed).not.toBeCloseTo(KMH_90, 3)
    // …and the pin is still remembered, so it comes back after the replay.
    expect(world.getVehicleSpeedOverride(id)).toBeCloseTo(KMH_90, 9)
  })
})
