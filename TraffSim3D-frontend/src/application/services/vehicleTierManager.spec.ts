// src/application/services/vehicleTierManager.spec.ts
//
// The NTE-style tier decision. The manager ONLY decides — the store
// applies the returned lists to the Rapier bodies. Pinned here:
//
//   - distance layering with hysteresis (boundary sitters do not flip),
//   - the per-frame upgrade BUDGET (nearest first, the NTE rule) and the
//     force-near exemption (the ride always has physics the same frame),
//   - the near CAP (dense scenes cannot pull the whole fleet near),
//   - the bookkeeping lifecycle (forget/clear/unknown ids).

import { describe, it, expect } from 'vitest'
import { createVehicleTierManager, type TierEntry } from './vehicleTierManager'

const entry = (id: string, distance: number | null, forceNear = false): TierEntry => ({
  id,
  distance,
  forceNear,
})

describe('createVehicleTierManager — distance layering', () => {
  it('keeps near vehicles inside the radius and far vehicles beyond it + slack', () => {
    const m = createVehicleTierManager({ nearRadiusM: 300, hysteresisM: 20 })
    // First frame: 250 m → near (promoted); 330 m → far (330 > 300+20,
    // no promotion — there is nothing to promote a far vehicle TO).
    const { upgrades, downgrades } = m.update([entry('a', 250), entry('b', 330)])
    expect(m.tierOf('a')).toBe('near')
    expect(m.tierOf('b')).toBe('far')
    expect(upgrades).toEqual(['a'])
    expect(downgrades).toEqual([])
  })

  it('hysteresis: a near vehicle inside radius+slack does NOT demote', () => {
    const m = createVehicleTierManager({ nearRadiusM: 300, hysteresisM: 20 })
    m.update([entry('a', 250)]) // near
    m.update([entry('a', 315)]) // 300 < 315 ≤ 320: inside the slack — keep
    expect(m.tierOf('a')).toBe('near')
    m.update([entry('a', 321)]) // past the slack — demote now
    expect(m.tierOf('a')).toBe('far')
  })

  it('a far vehicle promotes as soon as it re-enters the radius', () => {
    const m = createVehicleTierManager({ nearRadiusM: 300, hysteresisM: 20 })
    m.update([entry('a', 400)])
    expect(m.tierOf('a')).toBe('far')
    m.update([entry('a', 200)])
    expect(m.tierOf('a')).toBe('near')
  })
})

describe('createVehicleTierManager — the per-frame upgrade budget', () => {
  it('promotes at most `upgradesPerFrame` far vehicles per frame, nearest first', () => {
    const m = createVehicleTierManager({ upgradesPerFrame: 2 })
    // Three far vehicles at different distances, all re-entering at once.
    m.update([entry('a', 900), entry('b', 800), entry('c', 700)])
    // Frame 2: the nearest two (a, b) take the budget; c stays far.
    m.update([entry('a', 100), entry('b', 150), entry('c', 200)])
    expect(m.tierOf('a')).toBe('near')
    expect(m.tierOf('b')).toBe('near')
    expect(m.tierOf('c')).toBe('far')
    // Frame 3: c is the only far→near candidate left.
    const r = m.update([entry('a', 100), entry('b', 150), entry('c', 200)])
    expect(r.upgrades).toEqual(['c'])
  })

  it('the budget queue is nearest-first and carries over frame to frame', () => {
    const m = createVehicleTierManager({ upgradesPerFrame: 1 })
    m.update([entry('a', 500), entry('b', 400)]) // both far
    // All three want near; only the nearest (c) promotes this frame.
    const r1 = m.update([entry('c', 100), entry('a', 200), entry('b', 300)])
    expect(r1.upgrades).toEqual(['c'])
    expect(m.tierOf('c')).toBe('near')
    expect(m.tierOf('a')).toBe('far')
    // Next frame the queue continues: the next nearest promotes.
    const r2 = m.update([entry('c', 100), entry('a', 200), entry('b', 300)])
    expect(r2.upgrades).toHaveLength(1)
    expect(m.tierOf('a')).toBe('near')
    // Third frame: the last one.
    const r3 = m.update([entry('c', 100), entry('a', 200), entry('b', 300)])
    expect(r3.upgrades).toEqual(['b'])
    expect(m.tierOf('b')).toBe('near')
  })
})

describe('createVehicleTierManager — force-near overrides', () => {
  it('promotes a force-near vehicle UNCONDITIONALLY, same frame, no budget', () => {
    const m = createVehicleTierManager({ upgradesPerFrame: 1 })
    m.update([entry('far-1', 400), entry('far-2', 500)]) // both far
    // The ride (force-near) appears at 900 m — past the radius entirely —
    // while far-1 re-enters the radius (200 m, budgeted).
    const r = m.update([entry('far-1', 200), entry('far-2', 500), entry('ride', 900, true)])
    // The ride promotes despite the budget being 1 and the distance huge…
    expect(r.upgrades).toContain('ride')
    expect(m.tierOf('ride')).toBe('near')
    // …and the budgeted re-entry took its own slot in the same frame.
    expect(r.upgrades).toContain('far-1')
    expect(m.tierOf('far-1')).toBe('near')
    expect(m.tierOf('far-2')).toBe('far')
  })

  it('force-near vehicles do not count against the near cap', () => {
    const m = createVehicleTierManager({ nearCap: 1, upgradesPerFrame: 10 })
    // Two distance-based vehicles: the cap is 1, so the farther demotes.
    const r1 = m.update([entry('a', 100), entry('b', 200)])
    expect(m.tierOf('a')).toBe('near')
    expect(m.tierOf('b')).toBe('far')
    // A force-near vehicle joins: the cap stays respected for distance
    // entries, the force-near one is exempt from it.
    const r2 = m.update([entry('a', 100), entry('b', 200), entry('ride', 150, true)])
    expect(m.tierOf('ride')).toBe('near')
    expect(m.tierOf('a')).toBe('near')
    expect(m.tierOf('b')).toBe('far')
  })
})

describe('createVehicleTierManager — lifecycle', () => {
  it('forgets removed vehicles and clears on scene loads', () => {
    const m = createVehicleTierManager()
    m.update([entry('a', 100), entry('b', 500)])
    m.forget('a')
    expect(m.tierOf('a')).toBeNull()
    m.clear()
    expect(m.tierOf('b')).toBeNull()
    expect(m.nearCount()).toBe(0)
  })

  it('treats a null camera distance as force-near (the safe default)', () => {
    const m = createVehicleTierManager()
    m.update([entry('a', null)])
    expect(m.tierOf('a')).toBe('near')
  })

  it('downgrades promote demote bookkeeping: nearCount tracks the near set', () => {
    const m = createVehicleTierManager({ upgradesPerFrame: 10 })
    m.update([entry('a', 100), entry('b', 100)])
    expect(m.nearCount()).toBe(2)
    m.update([entry('a', 400), entry('b', 100)]) // a demotes past the slack
    expect(m.nearCount()).toBe(1)
  })
})
