// The one-way rule — the single home of "may a vehicle drive on this lane?".
//
// A road's `oneway` flag says the traffic on it runs in the road's own
// forward direction only. The lane model splits the lanes in two halves
// (forward / backward), so a one-way road's backward half is the phantom
// half of a two-way road: there is no oncoming carriageway there.
import { describe, it, expect } from 'vitest'
import { allowsTravelSign, isDrivableLane } from './oneway'
import type { Road } from '@domain/entities/Road'

const road = (overrides: Partial<Road>): Road => ({
  id: 'r-1',
  startNode: { x: 0, y: 0, z: 0 },
  endNode: { x: 100, y: 0, z: 0 },
  laneCount: 4,
  speedLimit: 20,
  level: 0,
  ...overrides,
})

describe('allowsTravelSign', () => {
  it('a two-way road allows both directions', () => {
    expect(allowsTravelSign(road({ oneway: false }), 1)).toBe(true)
    expect(allowsTravelSign(road({ oneway: false }), -1)).toBe(true)
  })

  it('a road that does not state the flag reads as two-way', () => {
    // Every built-in scene and every scene saved before the field
    // existed has no flag — the default behaviour must not change.
    expect(allowsTravelSign(road({}), 1)).toBe(true)
    expect(allowsTravelSign(road({}), -1)).toBe(true)
  })

  it('a one-way road allows the forward direction only', () => {
    expect(allowsTravelSign(road({ oneway: true }), 1)).toBe(true)
    expect(allowsTravelSign(road({ oneway: true }), -1)).toBe(false)
  })
})

describe('isDrivableLane', () => {
  it('a two-way road: every lane is drivable', () => {
    const r = road({ oneway: false })
    for (let lane = 0; lane < r.laneCount; lane++) {
      expect(isDrivableLane(r, lane)).toBe(true)
    }
  })

  it('a one-way road: only the forward lanes are drivable', () => {
    // 4 lanes → lanes 0 and 1 travel start→end, lanes 2 and 3 travel
    // end→start. The backward half is the phantom one.
    const r = road({ oneway: true })
    expect(isDrivableLane(r, 0)).toBe(true)
    expect(isDrivableLane(r, 1)).toBe(true)
    expect(isDrivableLane(r, 2)).toBe(false)
    expect(isDrivableLane(r, 3)).toBe(false)
  })

  it('a one-way road with two lanes: lane 1 is the phantom half', () => {
    // The shape an imported OSM one-way street has: the backend halves
    // the lane count of a one-way way (`lanes = max(1, lanes // 2)`).
    const r = road({ oneway: true, laneCount: 2 })
    expect(isDrivableLane(r, 0)).toBe(true)
    expect(isDrivableLane(r, 1)).toBe(false)
  })

  it('a one-way road with a single lane: that lane is drivable', () => {
    const r = road({ oneway: true, laneCount: 1 })
    expect(isDrivableLane(r, 0)).toBe(true)
  })
})
